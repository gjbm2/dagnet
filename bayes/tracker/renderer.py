"""One-way markdown renderer.

Rewrites marker-fenced regions of the target markdown file. Content
outside the marker regions is preserved byte-for-byte. Round-trip
edits inside a rendered region are not supported — they are overwritten
on the next render.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from .schema import Issue, Run, RunStatus, TrackerState
from .storage import atomic_write

MARKER_SECTIONS = ("current-line", "run-log", "issues")


class RendererError(RuntimeError):
    """Missing or malformed marker regions in the target file."""


def _marker_re(section: str) -> re.Pattern[str]:
    return re.compile(
        rf"(<!-- tracker:{re.escape(section)}:start -->)"
        rf"(.*?)"
        rf"(<!-- tracker:{re.escape(section)}:end -->)",
        re.DOTALL,
    )


def _fmt_date(d: date) -> str:
    return f"{d.day}-{d.strftime('%b')}-{d.strftime('%y')}"


def _render_current_line(state: TrackerState) -> str:
    cl = state.current_line
    lines = [
        "## Active line",
        "",
        f"- **Current line**: {cl.label}",
        f"- **Current priority**: {cl.priority}",
        f"- **Current blocker focus**: {cl.blocker_focus}",
        f"- **Next run goal**: {cl.next_run_goal}",
    ]
    if cl.active_run_id:
        lines.append(f"- **Active run**: {cl.active_run_id}")
    return "\n".join(lines)


def _render_run(run: Run) -> str:
    parts = [
        f"### {run.id} — {run.title}",
        f"**Status**: {run.status.value}",
        f"**Date**: {_fmt_date(run.date)}",
        f"**Run / plan**: {run.command_or_plan}",
        f"**Related issues**: {', '.join(run.related_issue_ids) or '—'}",
        "",
        f"**Why this run exists**: {run.why_this_run_exists}",
        f"**Intended to prove**: {run.intended_to_prove}",
        f"**Does not prove**: {run.does_not_prove}",
        f"**Blocker check first**: {run.blocker_check_first}",
        "",
        f"**Outcome**: {run.outcome_summary}",
        f"**Next action**: {run.next_action}",
    ]
    if run.status == RunStatus.blocked and run.blocker_category is not None:
        parts.append(f"**Blocker category**: {run.blocker_category.value}")
    if run.result_json_path:
        parts.append(f"**Result JSON**: `{run.result_json_path}`")
    return "\n".join(parts)


def _render_run_log(state: TrackerState) -> str:
    # Reverse chronological by id (ids are serial, so this is also
    # reverse-creation order).
    runs_sorted = sorted(state.runs, key=lambda r: r.id, reverse=True)
    parts = ["## Run log", ""]
    for r in runs_sorted:
        parts.append(_render_run(r))
        parts.append("")
    return ("\n".join(parts)).rstrip() + "\n"


def _render_issue(issue: Issue) -> str:
    parts = [
        f"### {issue.id} — {issue.title}",
        f"**State**: {issue.state.value}",
        f"**Updated**: {_fmt_date(issue.updated)}",
        f"**Owner**: {issue.owner}",
        f"**Severity**: {issue.severity.value}",
        "",
        f"**Summary**: {issue.summary}",
        f"**Next action**: {issue.next_action}",
        f"**Related runs**: {', '.join(issue.related_run_ids) or '—'}",
    ]
    if issue.evidence:
        parts.extend(["", "**Evidence**:"])
        for e in issue.evidence:
            parts.append(f"- {e}")
    if issue.hypotheses:
        parts.extend(["", "**Hypotheses**:"])
        for h in issue.hypotheses:
            tag = f" ({h.state})" if h.state else ""
            parts.append(f"- **{h.label}**{tag}: {h.text}")
            if h.falsified_by:
                parts.append(f"  - Falsified by: {h.falsified_by}")
            if h.supporting:
                parts.append(f"  - Supporting: {h.supporting}")
    for label, field in (
        ("Diagnosis", issue.diagnosis),
        ("Design", issue.design),
        ("Implementation", issue.implementation),
        ("Verification", issue.verification),
    ):
        if field:
            parts.extend(["", f"**{label}**: {field}"])
    return "\n".join(parts)


_STATE_ORDER = [
    "observed",
    "hypothesis",
    "diagnosed",
    "designed",
    "implemented",
    "regressed",
    "verified",
    "resolved",
    "rejected",
    "deferred",
]


def _render_issues(state: TrackerState) -> str:
    parts = ["## Issues", ""]
    by_state: dict[str, list[Issue]] = {}
    for i in state.issues:
        by_state.setdefault(i.state.value, []).append(i)
    for s in _STATE_ORDER:
        group = by_state.get(s, [])
        if not group:
            continue
        parts.append(f"### {s.capitalize()}")
        parts.append("")
        for issue in sorted(group, key=lambda x: x.id):
            parts.append(_render_issue(issue))
            parts.append("")
    return ("\n".join(parts)).rstrip() + "\n"


_RENDERERS = {
    "current-line": _render_current_line,
    "run-log": _render_run_log,
    "issues": _render_issues,
}


def render_into(markdown_path: Path, state: TrackerState) -> None:
    """Rewrite marker-fenced regions. Missing markers raise RendererError
    so the human has to explicitly opt-in to rendering."""
    if not markdown_path.exists():
        raise RendererError(f"markdown target not found: {markdown_path}")
    text = markdown_path.read_text(encoding="utf-8")
    missing = [s for s in MARKER_SECTIONS if not _marker_re(s).search(text)]
    if missing:
        raise RendererError(
            f"marker regions missing in {markdown_path}: {', '.join(missing)}. "
            "Add `<!-- tracker:<section>:start -->` / `:end -->` pairs first."
        )
    for section in MARKER_SECTIONS:
        pattern = _marker_re(section)
        body = _RENDERERS[section](state)
        # Avoid late-binding lambda gotcha with default arg.
        text = pattern.sub(
            lambda m, body=body: f"{m.group(1)}\n{body}\n{m.group(3)}",
            text,
            count=1,
        )
    atomic_write(markdown_path, text)
