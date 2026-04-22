"""Investigation tracker MCP server (stdio).

Run: `python -m bayes.tracker.mcp_server`

Seven write operations and five read operations, matching §8 of the
spec. The YAML file and the markdown target are resolved from env
vars (BAYES_TRACKER_YAML, BAYES_TRACKER_MD) with project-relative
defaults.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from .renderer import render_into
from .schema import (
    BlockerCategory,
    CurrentLine,
    Issue,
    IssueState,
    Run,
    RunStatus,
    Severity,
    TrackerState,
    next_issue_id,
    next_run_id,
)
from .storage import load, save

TRACKER_YAML_ENV = "BAYES_TRACKER_YAML"
TRACKER_MD_ENV = "BAYES_TRACKER_MD"

_DEFAULT_YAML = "docs/current/project-bayes/20-open-issues-register.tracker.yaml"
_DEFAULT_MD = "docs/current/project-bayes/20-open-issues-register.md"


def yaml_path() -> Path:
    return Path(os.environ.get(TRACKER_YAML_ENV, _DEFAULT_YAML))


def md_path() -> Path:
    return Path(os.environ.get(TRACKER_MD_ENV, _DEFAULT_MD))


mcp = FastMCP("bayes-investigation-tracker")


def _load() -> TrackerState:
    return load(yaml_path())


def _save(state: TrackerState) -> None:
    save(yaml_path(), state)


def _find_run(state: TrackerState, run_id: str) -> Run:
    run = next((r for r in state.runs if r.id == run_id), None)
    if run is None:
        raise ValueError(f"run not found: {run_id}")
    return run


def _find_issue(state: TrackerState, issue_id: str) -> Issue:
    issue = next((i for i in state.issues if i.id == issue_id), None)
    if issue is None:
        raise ValueError(f"issue not found: {issue_id}")
    return issue


def _issue_summary(i: Issue) -> dict[str, Any]:
    return {
        "id": i.id,
        "title": i.title,
        "state": i.state.value,
        "severity": i.severity.value,
        "summary": i.summary,
        "next_action": i.next_action,
        "related_run_ids": list(i.related_run_ids),
        "updated": i.updated.isoformat(),
    }


def _run_summary(r: Run) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": r.id,
        "title": r.title,
        "status": r.status.value,
        "date": r.date.isoformat(),
        "command_or_plan": r.command_or_plan,
        "related_issue_ids": list(r.related_issue_ids),
        "why_this_run_exists": r.why_this_run_exists,
        "intended_to_prove": r.intended_to_prove,
        "does_not_prove": r.does_not_prove,
        "blocker_check_first": r.blocker_check_first,
        "outcome_summary": r.outcome_summary,
        "next_action": r.next_action,
    }
    if r.blocker_category is not None:
        out["blocker_category"] = r.blocker_category.value
    if r.result_json_path:
        out["result_json_path"] = r.result_json_path
    if r.plan_name:
        out["plan_name"] = r.plan_name
    if r.operator:
        out["operator"] = r.operator
    return out


def _issue_state_counts(s: TrackerState) -> dict[str, int]:
    counts: dict[str, int] = {}
    for i in s.issues:
        counts[i.state.value] = counts.get(i.state.value, 0) + 1
    return counts


def _run_state_counts(s: TrackerState) -> dict[str, int]:
    counts: dict[str, int] = {}
    for r in s.runs:
        counts[r.status.value] = counts.get(r.status.value, 0) + 1
    return counts


def _next_planned(s: TrackerState) -> Run | None:
    planned = [r for r in s.runs if r.status == RunStatus.planned]
    return sorted(planned, key=lambda r: r.id)[0] if planned else None


# ---------------------------------------------------------------- reads


@mcp.tool()
def get_overview() -> dict[str, Any]:
    """Current line, open blockers, next planned run, and state counts."""
    s = _load()
    blockers = [_run_summary(r) for r in s.runs if r.status == RunStatus.blocked]
    nxt = _next_planned(s)
    return {
        "current_line": s.current_line.model_dump(mode="json"),
        "open_blockers": blockers,
        "next_planned_run": _run_summary(nxt) if nxt else None,
        "issue_state_counts": _issue_state_counts(s),
        "run_state_counts": _run_state_counts(s),
    }


@mcp.tool()
def get_issue(issue_id: str) -> dict[str, Any]:
    """Full issue plus related runs."""
    s = _load()
    issue = _find_issue(s, issue_id)
    related = [_run_summary(r) for r in s.runs if r.id in issue.related_run_ids]
    return {
        "issue": issue.model_dump(mode="json"),
        "related_runs": related,
    }


@mcp.tool()
def list_blockers() -> dict[str, Any]:
    """All blocked runs and blocker-category counts."""
    s = _load()
    blocked = [r for r in s.runs if r.status == RunStatus.blocked]
    cats: dict[str, int] = {}
    for r in blocked:
        key = r.blocker_category.value if r.blocker_category else "unknown"
        cats[key] = cats.get(key, 0) + 1
    return {
        "count": len(blocked),
        "category_counts": cats,
        "runs": [_run_summary(r) for r in blocked],
    }


@mcp.tool()
def get_next_run() -> dict[str, Any] | None:
    """The next planned run under the current line, or None."""
    s = _load()
    nxt = _next_planned(s)
    return _run_summary(nxt) if nxt else None


@mcp.tool()
def get_run(run_id: str) -> dict[str, Any]:
    """Full run context and linked issues."""
    s = _load()
    run = _find_run(s, run_id)
    related = [_issue_summary(i) for i in s.issues if i.id in run.related_issue_ids]
    return {
        "run": run.model_dump(mode="json"),
        "related_issues": related,
    }


# ---------------------------------------------------------------- writes


@mcp.tool()
def set_current_line(
    label: str,
    priority: str,
    blocker_focus: str,
    next_run_goal: str,
    active_run_id: str | None = None,
) -> dict[str, Any]:
    """Update the active investigation focus."""
    s = _load()
    s.current_line = CurrentLine(
        label=label,
        priority=priority,
        blocker_focus=blocker_focus,
        next_run_goal=next_run_goal,
        active_run_id=active_run_id,
    )
    _save(s)
    return s.current_line.model_dump(mode="json")


@mcp.tool()
def create_run(
    title: str,
    command_or_plan: str,
    related_issue_ids: list[str],
    why_this_run_exists: str,
    intended_to_prove: str,
    does_not_prove: str,
    blocker_check_first: str,
    next_action: str,
    plan_name: str | None = None,
    operator: str | None = None,
) -> dict[str, Any]:
    """Create a planned run. All reason fields are required (§9.1)."""
    s = _load()
    rid = next_run_id(s)
    run = Run(
        id=rid,
        title=title,
        status=RunStatus.planned,
        date=date.today(),
        command_or_plan=command_or_plan,
        related_issue_ids=list(related_issue_ids),
        why_this_run_exists=why_this_run_exists,
        intended_to_prove=intended_to_prove,
        does_not_prove=does_not_prove,
        blocker_check_first=blocker_check_first,
        outcome_summary="pending",
        next_action=next_action,
        plan_name=plan_name,
        operator=operator,
    )
    s.runs.append(run)
    # Mirror the forward link on the related issues so both sides stay
    # consistent without a separate link_run_and_issue call.
    for iid in run.related_issue_ids:
        issue = _find_issue(s, iid)
        if rid not in issue.related_run_ids:
            issue.related_run_ids.append(rid)
    _save(s)
    return _run_summary(run)


@mcp.tool()
def start_run(run_id: str, operator: str | None = None) -> dict[str, Any]:
    """Transition a planned run to running; stamp started_at."""
    s = _load()
    run = _find_run(s, run_id)
    if run.status != RunStatus.planned:
        raise ValueError(
            f"run {run_id} is {run.status.value}; only planned runs may be started"
        )
    run.status = RunStatus.running
    run.started_at = datetime.now(timezone.utc)
    if operator is not None:
        run.operator = operator
    s.current_line.active_run_id = run.id
    _save(s)
    return _run_summary(run)


@mcp.tool()
def complete_run(
    run_id: str,
    status: str,
    outcome_summary: str,
    next_action: str,
    blocker_category: str | None = None,
    result_json_path: str | None = None,
    harness_log_paths: list[str] | None = None,
) -> dict[str, Any]:
    """Complete a run as blocked, answered, or abandoned (§9.2, §9.3)."""
    s = _load()
    run = _find_run(s, run_id)
    if run.status not in (RunStatus.running, RunStatus.returned, RunStatus.planned):
        raise ValueError(
            f"run {run_id} is {run.status.value}; only "
            "planned/running/returned runs may be completed"
        )
    try:
        new_status = RunStatus(status)
    except ValueError as e:
        raise ValueError(f"invalid completion status: {status}") from e
    if new_status not in (
        RunStatus.blocked,
        RunStatus.answered,
        RunStatus.abandoned,
    ):
        raise ValueError(
            f"completion status must be blocked/answered/abandoned, got {status}"
        )
    if new_status == RunStatus.blocked:
        if not blocker_category:
            raise ValueError(
                "blocker_category is required when completing as blocked"
            )
        run.blocker_category = BlockerCategory(blocker_category)
    run.status = new_status
    run.outcome_summary = outcome_summary
    run.next_action = next_action
    if result_json_path is not None:
        run.result_json_path = result_json_path
    if harness_log_paths is not None:
        run.harness_log_paths = list(harness_log_paths)
    run.finished_at = datetime.now(timezone.utc)
    if s.current_line.active_run_id == run.id:
        s.current_line.active_run_id = None
    _save(s)
    return _run_summary(run)


@mcp.tool()
def upsert_issue(
    issue_id: str | None = None,
    title: str | None = None,
    state: str | None = None,
    severity: str | None = None,
    summary: str | None = None,
    next_action: str | None = None,
    related_run_ids: list[str] | None = None,
    owner: str | None = None,
    evidence: list[str] | None = None,
    diagnosis: str | None = None,
    design: str | None = None,
    implementation: str | None = None,
    verification: str | None = None,
) -> dict[str, Any]:
    """Create (if issue_id is None) or update an existing issue by id.

    On create, title/state/severity/summary/next_action are required.
    On update, only provided fields are overwritten.
    """
    s = _load()
    if issue_id is None:
        required = {
            "title": title,
            "state": state,
            "severity": severity,
            "summary": summary,
            "next_action": next_action,
        }
        missing = [k for k, v in required.items() if v is None]
        if missing:
            raise ValueError(
                f"missing required fields for new issue: {missing}"
            )
        new_id = next_issue_id(s)
        issue = Issue(
            id=new_id,
            title=title,  # type: ignore[arg-type]
            state=IssueState(state),  # type: ignore[arg-type]
            severity=Severity(severity),  # type: ignore[arg-type]
            summary=summary,  # type: ignore[arg-type]
            next_action=next_action,  # type: ignore[arg-type]
            related_run_ids=list(related_run_ids or []),
            updated=date.today(),
            owner=owner or "unclaimed",
            evidence=list(evidence or []),
            diagnosis=diagnosis,
            design=design,
            implementation=implementation,
            verification=verification,
        )
        s.issues.append(issue)
    else:
        issue = _find_issue(s, issue_id)
        if title is not None:
            issue.title = title
        if state is not None:
            issue.state = IssueState(state)
        if severity is not None:
            issue.severity = Severity(severity)
        if summary is not None:
            issue.summary = summary
        if next_action is not None:
            issue.next_action = next_action
        if related_run_ids is not None:
            issue.related_run_ids = list(related_run_ids)
        if owner is not None:
            issue.owner = owner
        if evidence is not None:
            issue.evidence = list(evidence)
        if diagnosis is not None:
            issue.diagnosis = diagnosis
        if design is not None:
            issue.design = design
        if implementation is not None:
            issue.implementation = implementation
        if verification is not None:
            issue.verification = verification
        issue.updated = date.today()
    _save(s)
    return _issue_summary(issue)


@mcp.tool()
def link_run_and_issue(run_id: str, issue_id: str) -> dict[str, Any]:
    """Ensure run↔issue cross-reference in both directions."""
    s = _load()
    run = _find_run(s, run_id)
    issue = _find_issue(s, issue_id)
    if issue_id not in run.related_issue_ids:
        run.related_issue_ids.append(issue_id)
    if run_id not in issue.related_run_ids:
        issue.related_run_ids.append(run_id)
    _save(s)
    return {"run_id": run_id, "issue_id": issue_id}


@mcp.tool()
def render_register() -> dict[str, Any]:
    """Rewrite the markdown register from YAML state."""
    s = _load()
    target = md_path()
    render_into(target, s)
    return {"rendered": str(target)}


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
