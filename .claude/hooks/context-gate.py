#!/usr/bin/env python3
"""PreToolUse gate: validates the briefing receipt before Edit/Write.

Input (stdin): JSON with keys tool_name, tool_input, transcript_path,
session_id, cwd, hook_event_name.

Behaviour:
- Non-Edit/Write tools: exit 0 (allow).
- File paths not matching any manifest glob: exit 0 (allow).
- Most recent user message starts with "briefing-override:": exit 0
  (allow, logged to .claude/context-override.log).
- Otherwise: scan cached receipts plus prior assistant turns in this
  conversation for a <briefing-receipt> block, validate its structure, and
  cross-check the `read:` paths against Read tool calls earlier in the
  transcript. On failure: exit 2 with a stderr message naming the specific
  problem.

Design doc: docs/current/agent-context-enforcement-design.md
Manifest:   .claude/context-manifest.yaml
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from context_gate_shared import (
    OVERRIDE_PREFIX,
    entry_role,
    find_receipts_in_transcript,
    load_cached_receipts,
    most_recent_user_text,
    read_transcript,
)

try:
    import yaml
except ImportError:
    print("context-gate: PyYAML not installed; allowing edit", file=sys.stderr)
    sys.exit(0)


MIN_INVARIANTS = 3


def repo_root() -> Path:
    """Locate the dagnet repo root."""
    explicit = os.environ.get("CLAUDE_PROJECT_DIR")
    if explicit and Path(explicit).is_dir():
        return Path(explicit)
    # Fallback: walk up from this script
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".claude").is_dir() and (parent / "CLAUDE.md").exists():
            return parent
    return Path.cwd()


def load_manifest(root: Path) -> dict:
    path = root / ".claude" / "context-manifest.yaml"
    if not path.exists():
        return {"warm_start": [], "entries": []}
    with path.open() as f:
        return yaml.safe_load(f) or {}


def glob_to_regex(pat: str) -> re.Pattern:
    """Translate a repo-relative glob with ** support into a regex."""
    # Escape regex metacharacters except *, ?, and /
    out = []
    i = 0
    while i < len(pat):
        c = pat[i]
        if c == "*":
            if i + 1 < len(pat) and pat[i + 1] == "*":
                out.append(".*")
                i += 2
                # Consume a following slash so "foo/**/bar" matches "foo/bar"
                if i < len(pat) and pat[i] == "/":
                    i += 1
                    if out and out[-1] == ".*":
                        pass  # keep .* absorbing the slash too
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c in r".^$+{}[]|()\\":
            out.append("\\" + c)
        else:
            out.append(c)
        i += 1
    return re.compile("^" + "".join(out) + "$")


def matches_any(rel_path: str, patterns: list[str]) -> bool:
    return any(glob_to_regex(p).match(rel_path) for p in patterns)


def find_matched_entry(manifest: dict, rel_path: str) -> dict | None:
    for entry in manifest.get("entries", []) or []:
        if matches_any(rel_path, entry.get("paths", []) or []):
            return entry
    return None


def override_active(user_text: str) -> tuple[bool, str]:
    """Check if the user message contains an override line."""
    for line in user_text.splitlines():
        stripped = line.strip()
        if stripped.startswith(OVERRIDE_PREFIX):
            reason = stripped[len(OVERRIDE_PREFIX):].strip()
            return True, reason
    return False, ""


def parse_receipt(body: str) -> dict:
    """Parse the three expected fields out of a receipt block.

    Format is permissive YAML-ish: field name, colon, then bullet lines
    or inline text. We extract `read:`, `invariants:`, `call-sites:`.
    """
    fields: dict[str, list[str]] = {"read": [], "invariants": [], "call-sites": []}
    current: str | None = None
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        low = stripped.lower()
        # Field header?
        for key in fields:
            if low.startswith(key + ":"):
                current = key
                rest = stripped[len(key) + 1:].strip()
                if rest:
                    fields[key].append(rest)
                break
        else:
            if current is None:
                continue
            if stripped.startswith("-"):
                fields[current].append(stripped.lstrip("- ").strip())
            else:
                fields[current].append(stripped)
    return fields


def combine_receipt_candidates(cached: list[str], transcript_receipts: list[str]) -> list[str]:
    """Return unique receipt candidates, newest first."""
    out: list[str] = []
    for receipt in cached + list(reversed(transcript_receipts)):
        receipt = receipt.strip()
        if receipt and receipt not in out:
            out.append(receipt)
    return out


def collect_read_paths(transcript: list[dict]) -> set[str]:
    """All file paths that appear in successful Read tool_use calls."""
    paths: set[str] = set()
    for entry in transcript:
        if entry_role(entry) != "assistant":
            continue
        msg = entry.get("message", {}) or {}
        for item in msg.get("content", []) or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use" and item.get("name") in {"Read", "ReadFile"}:
                tool_input = item.get("input") or {}
                fp = tool_input.get("file_path") or tool_input.get("path")
                if fp:
                    paths.add(fp)
    return paths


def normalise(path_or_glob: str, root: Path) -> str:
    """Return a repo-relative path (or leave a glob untouched)."""
    if path_or_glob.startswith(str(root)):
        return os.path.relpath(path_or_glob, root)
    p = Path(path_or_glob)
    if p.is_absolute():
        try:
            return str(p.resolve().relative_to(root))
        except ValueError:
            return str(p)
    return path_or_glob


def log_override(root: Path, reason: str, file_path: str) -> None:
    log = root / ".claude" / "context-override.log"
    try:
        with log.open("a") as f:
            ts = time.strftime("%Y-%m-%d %H:%M:%S")
            f.write(f"{ts}\t{file_path}\t{reason}\n")
    except OSError:
        pass


def emit_block(title: str, body: str) -> None:
    print(file=sys.stderr)
    print("═" * 72, file=sys.stderr)
    print(title, file=sys.stderr)
    print("═" * 72, file=sys.stderr)
    print(body.rstrip(), file=sys.stderr)
    print("═" * 72, file=sys.stderr)


def validate_receipt(
    *,
    receipt: str,
    rel: str,
    entry: dict,
    required_reads: list[str],
    actual_reads: set[str],
) -> tuple[bool, str, str]:
    """Return (ok, title, body) for a receipt candidate."""
    parsed = parse_receipt(receipt)
    read_paths = parsed["read"]
    invariants = [x for x in parsed["invariants"] if x.strip()]
    call_sites = [x for x in parsed["call-sites"] if x.strip()]

    if not read_paths:
        return (
            False,
            "STOP. Cached briefing receipt incomplete — `read:` field is empty.",
            f"File: {rel}\nList the docs you actually consulted, then re-emit the receipt.",
        )

    if len(invariants) < MIN_INVARIANTS:
        return (
            False,
            "STOP. Cached briefing receipt incomplete — too few invariants.",
            f"""
File: {rel}
Got {len(invariants)} invariant bullet(s); at least {MIN_INVARIANTS} required.
Re-read the required docs and extract the non-obvious rules that govern
this file.
""".strip(),
        )

    if not call_sites:
        return (
            False,
            "STOP. Cached briefing receipt incomplete — `call-sites:` empty.",
            f"""
File: {rel}
List at least one existing call-site the change interacts with, or the
literal word `none` if the edit is genuinely isolated.
""".strip(),
        )

    listed = {p.strip() for p in read_paths}
    missing_required = [r for r in required_reads if r not in listed]
    if missing_required:
        missing_text = "\n".join(f"    - {r}" for r in missing_required)
        return (
            False,
            "STOP. Cached briefing receipt does not cover this scoped file.",
            f"""
File: {rel}
Manifest entry: {entry.get('name', '?')}

The newest receipt in this conversation is missing these required docs:
{missing_text}

Read them with the Read tool, then emit an updated receipt. Receipts are
conversation-scoped; new user messages do not clear a valid earlier receipt.
""".strip(),
        )

    def was_read(cited: str) -> bool:
        for actual in actual_reads:
            if actual.endswith(cited) or cited.endswith(os.path.basename(actual)):
                if os.path.basename(actual) == os.path.basename(cited):
                    return True
        return False

    unread = [p for p in read_paths if not was_read(p)]
    if unread:
        unread_text = "\n".join(f"    - {p}" for p in unread)
        return (
            False,
            "STOP. Briefing receipt cites paths not opened via the Read tool.",
            f"""
File: {rel}

These cited paths have no corresponding Read tool call in this session's
transcript:
{unread_text}

The gate requires evidence of reading, not a claim. Open each path with
the Read tool, then re-emit the receipt.
""".strip(),
        )

    return True, "", ""


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        # Malformed input — fail open rather than block every edit
        return 0

    tool_name = payload.get("tool_name", "")
    if tool_name not in ("Edit", "Write", "NotebookEdit"):
        return 0

    tool_input = payload.get("tool_input", {}) or {}
    file_path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not file_path:
        return 0

    root = repo_root()
    rel = normalise(file_path, root)

    manifest = load_manifest(root)
    warm_start = manifest.get("warm_start", []) or []
    entry = find_matched_entry(manifest, rel)

    if entry is None:
        # Not a scoped path — no gate
        return 0

    transcript = read_transcript(payload.get("transcript_path", ""))

    # Override check: most recent user turn
    user_idx, user_text = most_recent_user_text(transcript)
    overridden, reason = override_active(user_text)
    if overridden:
        log_override(root, reason or "(no reason given)", rel)
        print(
            f"context-gate: briefing-override active for {rel} — reason: {reason}",
            file=sys.stderr,
        )
        return 0

    required_reads = list(warm_start) + list(entry.get("required_reads", []) or [])
    required_reads = sorted({r.strip() for r in required_reads if r and r.strip()})
    actual_reads = collect_read_paths(transcript)
    receipt_candidates = combine_receipt_candidates(
        load_cached_receipts(payload.get("transcript_path", "")),
        find_receipts_in_transcript(transcript),
    )

    required_list_text = "\n".join(f"    - {r}" for r in required_reads)

    if not receipt_candidates:
        emit_block(
            "STOP. Briefing receipt required before editing this file.",
            f"""
File:         {rel}
Manifest:     {entry.get('name', '?')} — {(entry.get('description') or '').strip()}

Read the warm-start docs plus the docs required by this manifest entry,
then emit a standalone assistant message containing only a
<briefing-receipt> block.

Important:
  - Do NOT combine the first receipt for a scope with the edit it is meant
    to unlock. `PreToolUse` cannot see a receipt that appears for the first
    time in the same response as the blocked Edit/Write call.
  - Let the receipt response complete, then continue with the edit.
  - Once a receipt is recorded, it remains reusable for later edits in this
    conversation even if the user sends another message.
  - Do NOT ask the user for a "proceed" message just to preserve the receipt.

Required reads for this edit:
{required_list_text}

If this edit genuinely does not need the briefing, ask the user to type
a line beginning with `briefing-override:` followed by a reason. You
cannot bypass the gate yourself.
""".strip(),
        )
        return 2

    first_error: tuple[str, str] | None = None
    for receipt in receipt_candidates:
        ok, title, body = validate_receipt(
            receipt=receipt,
            rel=rel,
            entry=entry,
            required_reads=required_reads,
            actual_reads=actual_reads,
        )
        if ok:
            return 0
        if first_error is None:
            first_error = (title, body)

    if first_error is not None:
        emit_block(first_error[0], first_error[1])
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
