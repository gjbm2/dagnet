from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from bayes.tracker.schema import (
    CurrentLine,
    Issue,
    IssueState,
    Run,
    RunStatus,
    Severity,
    TrackerState,
)


@pytest.fixture
def sample_state() -> TrackerState:
    issues = [
        Issue(
            id="I-001",
            title="Parser artefact",
            state=IssueState.verified,
            severity=Severity.quality,
            summary="Regex lacked start-of-line anchor.",
            next_action="None.",
            related_run_ids=["R-001", "R-002"],
            updated=date(2026, 4, 22),
        ),
        Issue(
            id="I-002",
            title="Onset bias",
            state=IssueState.observed,
            severity=Severity.quality,
            summary="+0.65d bias across edges.",
            next_action="Investigate after blockers clear.",
            related_run_ids=["R-001"],
            updated=date(2026, 4, 22),
        ),
    ]
    runs = [
        Run(
            id="R-001",
            title="Initial sparse regression",
            status=RunStatus.answered,
            date=date(2026, 4, 22),
            command_or_plan="sparse regression across 41 graphs",
            related_issue_ids=["I-001", "I-002"],
            why_this_run_exists="First broad pass.",
            intended_to_prove="Which defect families exist.",
            does_not_prove="Any specific root cause.",
            blocker_check_first="Parser integrity and completion.",
            outcome_summary="Surfaced parser artefact and several biases.",
            next_action="Fix blockers, rerun.",
        ),
        Run(
            id="R-002",
            title="Post-parser rerun",
            status=RunStatus.answered,
            date=date(2026, 4, 22),
            command_or_plan="same sparse scope after fixes",
            related_issue_ids=["I-001"],
            why_this_run_exists="Separate model defects from artefacts.",
            intended_to_prove="Which serious defects survive.",
            does_not_prove="Completion stability of diamond-2dim set.",
            blocker_check_first="Completion and stall behaviour.",
            outcome_summary="I-001 verified fixed.",
            next_action="Rerun blocked diamond-2dim set.",
        ),
    ]
    current_line = CurrentLine(
        label="sparse-graph completion",
        priority="blockers first",
        blocker_focus="diamond-2dim under contention",
        next_run_goal="verify stall-detector fix",
    )
    return TrackerState(current_line=current_line, issues=issues, runs=runs)


@pytest.fixture
def tmp_yaml(tmp_path: Path) -> Path:
    return tmp_path / "tracker.yaml"


@pytest.fixture
def tmp_md(tmp_path: Path) -> Path:
    md = tmp_path / "register.md"
    md.write_text(
        "# Register\n\nPreamble text preserved.\n\n"
        "<!-- tracker:current-line:start -->\n<!-- tracker:current-line:end -->\n\n"
        "Middle narrative.\n\n"
        "<!-- tracker:run-log:start -->\n<!-- tracker:run-log:end -->\n\n"
        "More narrative.\n\n"
        "<!-- tracker:issues:start -->\n<!-- tracker:issues:end -->\n\n"
        "Tail.\n",
        encoding="utf-8",
    )
    return md
