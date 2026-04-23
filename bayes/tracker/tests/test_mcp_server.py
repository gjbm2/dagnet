"""Exercises the tracker operations directly via their underlying
functions. Skips MCP transport — the stdio wrapper is thin and the
tool callables carry the semantics we actually care about.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from bayes.tracker import mcp_server as srv
from bayes.tracker.storage import load, save


@pytest.fixture(autouse=True)
def _point_at_tmp(monkeypatch, tmp_path, sample_state):
    yaml = tmp_path / "tracker.yaml"
    md = tmp_path / "register.md"
    md.write_text(
        "# R\n\nTOP\n\n"
        "<!-- tracker:current-line:start -->\n"
        "<!-- tracker:current-line:end -->\n\n"
        "<!-- tracker:run-log:start -->\n"
        "<!-- tracker:run-log:end -->\n\n"
        "<!-- tracker:issues:start -->\n"
        "<!-- tracker:issues:end -->\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(srv.TRACKER_YAML_ENV, str(yaml))
    monkeypatch.setenv(srv.TRACKER_MD_ENV, str(md))
    save(yaml, sample_state)
    return yaml, md


def _call(tool, **kwargs):
    """Invoke a FastMCP-registered tool. The `@mcp.tool()` decorator
    registers the tool and returns the original function unchanged, so
    the module attribute IS callable directly."""
    return tool(**kwargs)


def test_get_overview_returns_current_line_and_next_planned():
    out = _call(srv.get_overview)
    assert out["current_line"]["label"] == "sparse-graph completion"
    assert out["open_blockers"] == []
    assert out["next_planned_run"] is None
    assert out["issue_state_counts"]["verified"] == 1
    assert out["run_state_counts"]["answered"] == 2


def test_get_issue_returns_related_runs():
    out = _call(srv.get_issue, issue_id="I-001")
    assert out["issue"]["id"] == "I-001"
    assert {r["id"] for r in out["related_runs"]} == {"R-001", "R-002"}


def test_get_issue_missing_raises():
    with pytest.raises(ValueError, match="not found"):
        _call(srv.get_issue, issue_id="I-999")


def test_list_blockers_empty_initially():
    out = _call(srv.list_blockers)
    assert out["count"] == 0
    assert out["runs"] == []


def test_get_run_returns_related_issues():
    out = _call(srv.get_run, run_id="R-001")
    assert out["run"]["id"] == "R-001"
    assert {i["id"] for i in out["related_issues"]} == {"I-001", "I-002"}


def test_create_run_assigns_id_and_back_links():
    created = _call(
        srv.create_run,
        title="Blocker retest",
        command_or_plan="targeted rerun",
        related_issue_ids=["I-001"],
        why_this_run_exists="verify fix",
        intended_to_prove="stall detector clean",
        does_not_prove="onset bias",
        blocker_check_first="completion behaviour",
        next_action="rerun if clean",
    )
    assert created["id"] == "R-003"
    assert created["status"] == "planned"
    # The back-link on the related issue is populated without a separate
    # link_run_and_issue call.
    issue_view = _call(srv.get_issue, issue_id="I-001")
    assert "R-003" in issue_view["issue"]["related_run_ids"]


def test_create_then_start_then_complete_answered_flow():
    run = _call(
        srv.create_run,
        title="Flow",
        command_or_plan="cmd",
        related_issue_ids=[],
        why_this_run_exists="w",
        intended_to_prove="i",
        does_not_prove="d",
        blocker_check_first="b",
        next_action="n",
    )
    rid = run["id"]
    started = _call(srv.start_run, run_id=rid, operator="greg")
    assert started["status"] == "running"
    # Current line's active_run_id is stamped.
    ov = _call(srv.get_overview)
    assert ov["current_line"]["active_run_id"] == rid
    completed = _call(
        srv.complete_run,
        run_id=rid,
        status="answered",
        outcome_summary="clean",
        next_action="move on",
    )
    assert completed["status"] == "answered"
    # active_run_id is cleared.
    ov2 = _call(srv.get_overview)
    assert ov2["current_line"]["active_run_id"] is None


def test_complete_blocked_requires_category():
    run = _call(
        srv.create_run,
        title="Flow",
        command_or_plan="cmd",
        related_issue_ids=[],
        why_this_run_exists="w",
        intended_to_prove="i",
        does_not_prove="d",
        blocker_check_first="b",
        next_action="n",
    )
    _call(srv.start_run, run_id=run["id"])
    with pytest.raises(ValueError, match="blocker_category is required"):
        _call(
            srv.complete_run,
            run_id=run["id"],
            status="blocked",
            outcome_summary="stuck",
            next_action="fix",
        )


def test_complete_blocked_succeeds_with_category():
    run = _call(
        srv.create_run,
        title="Flow",
        command_or_plan="cmd",
        related_issue_ids=[],
        why_this_run_exists="w",
        intended_to_prove="i",
        does_not_prove="d",
        blocker_check_first="b",
        next_action="n",
    )
    _call(srv.start_run, run_id=run["id"])
    completed = _call(
        srv.complete_run,
        run_id=run["id"],
        status="blocked",
        outcome_summary="stalled",
        next_action="diagnose",
        blocker_category="tooling",
    )
    assert completed["status"] == "blocked"
    assert completed["blocker_category"] == "tooling"
    out = _call(srv.list_blockers)
    assert out["count"] == 1
    assert out["category_counts"]["tooling"] == 1


def test_start_run_only_from_planned():
    # R-001 is already answered; starting it must fail.
    with pytest.raises(ValueError, match="only planned runs"):
        _call(srv.start_run, run_id="R-001")


def test_upsert_issue_create_and_update():
    created = _call(
        srv.upsert_issue,
        title="New defect",
        state="observed",
        severity="quality",
        summary="s",
        next_action="look into it",
    )
    assert created["id"] == "I-003"
    updated = _call(
        srv.upsert_issue,
        issue_id="I-003",
        state="diagnosed",
        diagnosis="root cause identified",
    )
    assert updated["state"] == "diagnosed"


def test_upsert_issue_create_missing_fields():
    with pytest.raises(ValueError, match="missing required"):
        _call(srv.upsert_issue, title="t", state="observed")


def test_link_run_and_issue_bidirectional():
    _call(srv.link_run_and_issue, run_id="R-002", issue_id="I-002")
    run_view = _call(srv.get_run, run_id="R-002")
    issue_view = _call(srv.get_issue, issue_id="I-002")
    assert "I-002" in run_view["run"]["related_issue_ids"]
    assert "R-002" in issue_view["issue"]["related_run_ids"]


def test_set_current_line_overwrites():
    _call(
        srv.set_current_line,
        label="new line",
        priority="p",
        blocker_focus="b",
        next_run_goal="g",
    )
    ov = _call(srv.get_overview)
    assert ov["current_line"]["label"] == "new line"


def test_render_register_writes_markdown(_point_at_tmp):
    yaml_path, md_path = _point_at_tmp
    out = _call(srv.render_register)
    assert Path(out["rendered"]) == md_path
    text = md_path.read_text(encoding="utf-8")
    assert "sparse-graph completion" in text
    assert "R-001 — Initial sparse regression" in text
    assert "TOP" in text  # preamble preserved
