"""One-shot migration: read 20-open-issues-register.md, emit the
initial tracker YAML.

Pragmatic parser targeting the specific shape of doc 20 at the time
of migration. Output is expected to be diff-reviewed by a human; the
script writes only the YAML. Restructuring doc 20 into a renderable
shape (adding marker regions, preserving narrative) is a separate
manual step.

Run with graph-editor venv active:
    python -m bayes.tracker.scripts.seed_from_doc20 [--doc PATH] [--out PATH]
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime
from pathlib import Path

from bayes.tracker.schema import (
    CurrentLine,
    Issue,
    IssueState,
    Run,
    RunStatus,
    Severity,
    TrackerState,
)
from bayes.tracker.storage import save

_DEFAULT_DOC = Path("docs/current/project-bayes/20-open-issues-register.md")
_DEFAULT_OUT = Path("docs/current/project-bayes/20-open-issues-register.tracker.yaml")

_RUN_HEADER_RE = re.compile(r"^###\s+(R-\d{3})\s+—\s+(.+?)\s*$")
_ISSUE_HEADER_RE = re.compile(r"^##\s+(I-\d{3})\s+—\s+(.+?)\s*$")
_BOLD_FIELD_RE = re.compile(r"^\*\*(?P<key>[^*]+)\*\*:\s*(?P<val>.*)$")


def _parse_date(s: str) -> date:
    """Accept d-MMM-yy (e.g. '22-Apr-26')."""
    s = s.strip()
    try:
        return datetime.strptime(s, "%d-%b-%y").date()
    except ValueError:
        pass
    try:
        return date.fromisoformat(s)
    except ValueError as e:
        raise ValueError(f"unparseable date: {s!r}") from e


_ISSUE_STATE_MAP = {
    "observed": IssueState.observed,
    "hypothesis": IssueState.hypothesis,
    "rejected": IssueState.rejected,
    "diagnosed": IssueState.diagnosed,
    "designed": IssueState.designed,
    "implemented": IssueState.implemented,
    "regressed": IssueState.regressed,
    "verified": IssueState.verified,
    "resolved": IssueState.resolved,
    "deferred": IssueState.deferred,
}

_RUN_STATUS_MAP = {
    "planned": RunStatus.planned,
    "running": RunStatus.running,
    "returned": RunStatus.returned,
    "blocked": RunStatus.blocked,
    "analysed": RunStatus.answered,  # prior vocabulary used "analysed"
    "analyzed": RunStatus.answered,
    "answered": RunStatus.answered,
    "abandoned": RunStatus.abandoned,
}


def _severity(s: str) -> Severity:
    s = s.strip().lower()
    # The register uses "blocker (caused ...)", "quality (misclassification...)", etc.
    for tag, sev in (("blocker", Severity.blocker), ("quality", Severity.quality),
                     ("paper-cut", Severity.paper_cut)):
        if s.startswith(tag):
            return sev
    # Fallback: quality is the most common.
    return Severity.quality


def _strip_inline_code(s: str) -> str:
    return s.replace("`", "")


def _split_top_level_sections(text: str) -> list[tuple[str, str, str]]:
    """Split into (kind, label, body) tuples. kind is 'run' or 'issue'."""
    sections: list[tuple[str, str, str, list[str]]] = []
    current: list[str] | None = None
    current_kind = ""
    current_label = ""
    current_title = ""
    for line in text.splitlines():
        run_match = _RUN_HEADER_RE.match(line)
        issue_match = _ISSUE_HEADER_RE.match(line)
        if run_match and run_match.group(1) != "R-XXX":
            if current is not None:
                sections.append((current_kind, current_label, current_title,
                                 current))
            current_kind = "run"
            current_label = run_match.group(1)
            current_title = run_match.group(2)
            current = []
        elif issue_match and issue_match.group(1) != "I-NNN":
            if current is not None:
                sections.append((current_kind, current_label, current_title,
                                 current))
            current_kind = "issue"
            current_label = issue_match.group(1)
            current_title = issue_match.group(2)
            current = []
        else:
            # Terminate at the next top-level `# ` or `---` run of three that
            # implies we're outside an issue block.
            if current is not None:
                if line.startswith("# ") and not line.startswith("## "):
                    sections.append((current_kind, current_label, current_title,
                                     current))
                    current = None
                    current_kind = ""
                    current_label = ""
                    current_title = ""
                    continue
                current.append(line)
    if current is not None:
        sections.append((current_kind, current_label, current_title, current))
    return [(k, lbl, ttl, "\n".join(body).strip())
            for k, lbl, ttl, body in sections]


def _bold_fields(body: str) -> dict[str, str]:
    """Extract top-level **Key**: value pairs at the start of the body.
    Stops at the first blank line or ### subsection."""
    out: dict[str, str] = {}
    for line in body.splitlines():
        line = line.rstrip()
        if line.startswith("###"):
            break
        m = _BOLD_FIELD_RE.match(line)
        if m:
            key = m.group("key").strip()
            val = m.group("val").strip()
            # Fold continuation lines? Register is one-line per bold field.
            out[key] = val
    return out


def _section_body(body: str, heading: str) -> str | None:
    """Return the prose under a `### heading` up to the next `###` or end."""
    pattern = re.compile(
        rf"^###\s+{re.escape(heading)}\b.*$(?P<body>.*?)(?=^###\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(body)
    if not m:
        return None
    return m.group("body").strip() or None


def _parse_active_line(text: str) -> CurrentLine:
    # Lines like `- **Current line**: ...` inside the `## Active line` block.
    m = re.search(
        r"^##\s+Active line\s*$(?P<body>.*?)^---",
        text,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        raise ValueError("Active line section not found")
    body = m.group("body")
    fields: dict[str, str] = {}
    for line in body.splitlines():
        bm = re.match(r"^-\s+\*\*([^*]+)\*\*:\s*(.*)$", line.strip())
        if bm:
            fields[bm.group(1).strip()] = bm.group(2).strip()
    # Continuation lines (indented) in the register are glued back on.
    # For pragmatism: we accept only the first-line value.
    return CurrentLine(
        label=fields.get("Current line", "uninitialised"),
        priority=fields.get("Current priority", "uninitialised"),
        blocker_focus=fields.get("Current blocker focus", "uninitialised"),
        next_run_goal=fields.get("Next run goal", "uninitialised"),
    )


def _parse_run(label: str, title: str, body: str) -> Run:
    fields = _bold_fields(body)
    status = _RUN_STATUS_MAP.get(
        fields.get("Status", "").strip().lower(), RunStatus.planned
    )
    related = [
        s.strip().strip("`").strip(",")
        for s in _strip_inline_code(fields.get("Related issues", "")).split()
    ]
    related = [r for r in related if re.match(r"^I-\d{3}$", r)]
    return Run(
        id=label,
        title=title.strip(),
        status=status,
        date=_parse_date(fields.get("Date", "1-Jan-26")),
        command_or_plan=fields.get("Run / plan", "unspecified"),
        related_issue_ids=related,
        why_this_run_exists=fields.get("Why this run exists", "unspecified"),
        intended_to_prove=fields.get("Intended to prove", "unspecified"),
        does_not_prove=fields.get("Does not prove", "unspecified"),
        blocker_check_first=fields.get("Blocker check first", "unspecified"),
        outcome_summary=fields.get("Outcome", "pending"),
        next_action=fields.get("Next action", "unspecified"),
    )


def _parse_issue(label: str, title: str, body: str) -> Issue:
    fields = _bold_fields(body)
    state_raw = fields.get("State", "observed").strip().lower().split()[0]
    state = _ISSUE_STATE_MAP.get(state_raw, IssueState.observed)
    severity = _severity(fields.get("Severity", "quality"))
    diagnosis = _section_body(body, "Diagnosis")
    design = _section_body(body, "Design")
    implementation = _section_body(body, "Implementation")
    verification = _section_body(body, "Verification")
    evidence_prose = _section_body(body, "Evidence")
    evidence = _collect_bullets(evidence_prose) if evidence_prose else []
    return Issue(
        id=label,
        title=title.strip(),
        state=state,
        severity=severity,
        summary=_first_paragraph(body),
        next_action=_infer_next_action(state, verification),
        related_run_ids=[],
        updated=_parse_date(fields.get("Updated", "22-Apr-26")),
        owner=fields.get("Owner", "unclaimed"),
        evidence=evidence,
        diagnosis=diagnosis,
        design=design,
        implementation=implementation,
        verification=verification,
    )


def _collect_bullets(prose: str) -> list[str]:
    bullets: list[str] = []
    for line in prose.splitlines():
        line = line.rstrip()
        if line.startswith("- "):
            bullets.append(line[2:].strip())
    return bullets


def _first_paragraph(body: str) -> str:
    """Best-effort one-paragraph summary: the first non-empty prose block
    that isn't a bold-field line."""
    lines: list[str] = []
    in_para = False
    for line in body.splitlines():
        s = line.rstrip()
        if not s:
            if in_para:
                break
            continue
        if s.startswith("###") or _BOLD_FIELD_RE.match(s):
            if in_para:
                break
            continue
        in_para = True
        lines.append(s)
    return " ".join(lines).strip() or "(migrated from doc 20; needs review)"


def _infer_next_action(state: IssueState, verification: str | None) -> str:
    if state in (IssueState.verified, IssueState.resolved):
        return "None — closed."
    if state == IssueState.diagnosed:
        return "Design a fix."
    if state == IssueState.designed:
        return "Implement."
    if state == IssueState.implemented:
        return "Verify via regression."
    if state == IssueState.regressed:
        return "Investigate regression."
    return "Investigate."


def _link_related(runs: list[Run], issues: list[Issue]) -> None:
    """Build the reverse links: for every (run, issue) pair named on the
    run, record the run on the issue."""
    issue_ids = {i.id for i in issues}
    for r in runs:
        r.related_issue_ids = [
            iid for iid in r.related_issue_ids if iid in issue_ids
        ]
        for iid in r.related_issue_ids:
            issue = next(i for i in issues if i.id == iid)
            if r.id not in issue.related_run_ids:
                issue.related_run_ids.append(r.id)


def migrate(doc_path: Path, out_path: Path) -> TrackerState:
    text = doc_path.read_text(encoding="utf-8")
    sections = _split_top_level_sections(text)
    runs: list[Run] = []
    issues: list[Issue] = []
    for kind, label, title, body in sections:
        if kind == "run":
            runs.append(_parse_run(label, title, body))
        elif kind == "issue":
            issues.append(_parse_issue(label, title, body))
    current_line = _parse_active_line(text)
    _link_related(runs, issues)
    state = TrackerState(
        current_line=current_line,
        issues=issues,
        runs=runs,
    )
    save(out_path, state)
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc", type=Path, default=_DEFAULT_DOC)
    parser.add_argument("--out", type=Path, default=_DEFAULT_OUT)
    args = parser.parse_args()
    state = migrate(args.doc, args.out)
    print(
        f"migrated {len(state.runs)} run(s) and {len(state.issues)} issue(s) "
        f"from {args.doc} -> {args.out}",
        file=sys.stderr,
    )
    print(
        "next steps: add marker regions to the md file, then run the "
        "`render_register` MCP tool.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
