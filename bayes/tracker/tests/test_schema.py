from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from bayes.tracker.schema import (
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


def _min_run(rid: str = "R-001", related: list[str] | None = None) -> Run:
    return Run(
        id=rid,
        title="t",
        status=RunStatus.planned,
        date=date(2026, 4, 22),
        command_or_plan="cmd",
        related_issue_ids=related or [],
        why_this_run_exists="w",
        intended_to_prove="i",
        does_not_prove="d",
        blocker_check_first="b",
        outcome_summary="pending",
        next_action="n",
    )


def _min_issue(iid: str = "I-001", related: list[str] | None = None) -> Issue:
    return Issue(
        id=iid,
        title="t",
        state=IssueState.observed,
        severity=Severity.quality,
        summary="s",
        next_action="n",
        related_run_ids=related or [],
        updated=date(2026, 4, 22),
    )


def test_issue_id_pattern_enforced():
    with pytest.raises(ValidationError):
        _min_issue(iid="bad-id")


def test_run_id_pattern_enforced():
    with pytest.raises(ValidationError):
        _min_run(rid="bad-id")


def test_extra_keys_rejected():
    with pytest.raises(ValidationError):
        Run(
            id="R-001",
            title="t",
            status=RunStatus.planned,
            date=date(2026, 4, 22),
            command_or_plan="cmd",
            related_issue_ids=[],
            why_this_run_exists="w",
            intended_to_prove="i",
            does_not_prove="d",
            blocker_check_first="b",
            outcome_summary="pending",
            next_action="n",
            surprise_field="nope",  # type: ignore[arg-type]
        )


def test_tracker_state_duplicate_ids_rejected():
    cl = CurrentLine(
        label="l", priority="p", blocker_focus="b", next_run_goal="n"
    )
    with pytest.raises(ValidationError):
        TrackerState(
            current_line=cl,
            issues=[_min_issue("I-001"), _min_issue("I-001")],
            runs=[],
        )


def test_cross_reference_missing_issue_rejected():
    cl = CurrentLine(
        label="l", priority="p", blocker_focus="b", next_run_goal="n"
    )
    s = TrackerState(
        current_line=cl,
        issues=[],
        runs=[_min_run(related=["I-999"])],
    )
    with pytest.raises(ValueError, match="missing issue"):
        s.validate_cross_refs()


def test_cross_reference_missing_run_rejected():
    cl = CurrentLine(
        label="l", priority="p", blocker_focus="b", next_run_goal="n"
    )
    s = TrackerState(
        current_line=cl,
        issues=[_min_issue(related=["R-999"])],
        runs=[],
    )
    with pytest.raises(ValueError, match="missing run"):
        s.validate_cross_refs()


def test_current_line_active_run_id_must_resolve():
    cl = CurrentLine(
        label="l",
        priority="p",
        blocker_focus="b",
        next_run_goal="n",
        active_run_id="R-042",
    )
    s = TrackerState(current_line=cl, issues=[], runs=[])
    with pytest.raises(ValueError, match="active_run_id"):
        s.validate_cross_refs()


def test_id_assignment_serial():
    cl = CurrentLine(
        label="l", priority="p", blocker_focus="b", next_run_goal="n"
    )
    s = TrackerState(
        current_line=cl,
        issues=[_min_issue("I-001"), _min_issue("I-003")],
        runs=[_min_run("R-002")],
    )
    assert next_issue_id(s) == "I-004"
    assert next_run_id(s) == "R-003"


def test_id_assignment_from_empty():
    cl = CurrentLine(
        label="l", priority="p", blocker_focus="b", next_run_goal="n"
    )
    s = TrackerState(current_line=cl, issues=[], runs=[])
    assert next_issue_id(s) == "I-001"
    assert next_run_id(s) == "R-001"
