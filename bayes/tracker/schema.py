"""Pydantic models for the investigation tracker.

Enums, field types, and cross-reference invariants. Unknown keys are
rejected on load (`extra='forbid'`) so the YAML does not silently accept
drift.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator


class IssueState(str, Enum):
    observed = "observed"
    hypothesis = "hypothesis"
    rejected = "rejected"
    diagnosed = "diagnosed"
    designed = "designed"
    implemented = "implemented"
    regressed = "regressed"
    verified = "verified"
    resolved = "resolved"
    deferred = "deferred"


class Severity(str, Enum):
    blocker = "blocker"
    quality = "quality"
    paper_cut = "paper-cut"


class RunStatus(str, Enum):
    planned = "planned"
    running = "running"
    returned = "returned"
    blocked = "blocked"
    answered = "answered"
    abandoned = "abandoned"


class BlockerCategory(str, Enum):
    tooling = "tooling"
    evidence_integrity = "evidence_integrity"
    binding = "binding"
    compile_runtime = "compile_runtime"
    sampling_geometry = "sampling_geometry"
    external = "external"
    unknown = "unknown"


IssueID = Annotated[str, StringConstraints(pattern=r"^I-\d{3}$")]
RunID = Annotated[str, StringConstraints(pattern=r"^R-\d{3}$")]
Title = Annotated[str, StringConstraints(min_length=1, max_length=120)]


class Hypothesis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    state: str
    text: str
    falsified_by: str | None = None
    supporting: str | None = None


class Issue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: IssueID
    title: Title
    state: IssueState
    severity: Severity
    summary: str
    next_action: str
    related_run_ids: list[RunID] = Field(default_factory=list)
    updated: date
    owner: str = "unclaimed"
    evidence: list[str] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    diagnosis: str | None = None
    design: str | None = None
    implementation: str | None = None
    verification: str | None = None


class Run(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: RunID
    title: Title
    status: RunStatus
    date: date
    command_or_plan: str
    related_issue_ids: list[IssueID] = Field(default_factory=list)
    why_this_run_exists: str
    intended_to_prove: str
    does_not_prove: str
    blocker_check_first: str
    outcome_summary: str = "pending"
    next_action: str
    result_json_path: str | None = None
    harness_log_paths: list[str] = Field(default_factory=list)
    plan_name: str | None = None
    plan_overrides: dict[str, Any] | None = None
    operator: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    blocker_category: BlockerCategory | None = None


class CurrentLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    priority: str
    blocker_focus: str
    next_run_goal: str
    active_run_id: RunID | None = None


class TrackerState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_line: CurrentLine
    issues: list[Issue] = Field(default_factory=list)
    runs: list[Run] = Field(default_factory=list)

    @field_validator("runs")
    @classmethod
    def _unique_run_ids(cls, v: list[Run]) -> list[Run]:
        ids = [r.id for r in v]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate run ids in tracker")
        return v

    @field_validator("issues")
    @classmethod
    def _unique_issue_ids(cls, v: list[Issue]) -> list[Issue]:
        ids = [i.id for i in v]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate issue ids in tracker")
        return v

    def validate_cross_refs(self) -> None:
        issue_ids = {i.id for i in self.issues}
        run_ids = {r.id for r in self.runs}
        for r in self.runs:
            for iid in r.related_issue_ids:
                if iid not in issue_ids:
                    raise ValueError(
                        f"run {r.id} references missing issue {iid}"
                    )
        for i in self.issues:
            for rid in i.related_run_ids:
                if rid not in run_ids:
                    raise ValueError(
                        f"issue {i.id} references missing run {rid}"
                    )
        if self.current_line.active_run_id is not None:
            if self.current_line.active_run_id not in run_ids:
                raise ValueError(
                    f"current_line.active_run_id "
                    f"{self.current_line.active_run_id} does not resolve"
                )


def _next_serial(prefix: str, existing: list[str]) -> str:
    nums = [int(x.split("-")[1]) for x in existing if x.startswith(prefix)]
    return f"{prefix}{(max(nums) if nums else 0) + 1:03d}"


def next_issue_id(state: TrackerState) -> str:
    return _next_serial("I-", [i.id for i in state.issues])


def next_run_id(state: TrackerState) -> str:
    return _next_serial("R-", [r.id for r in state.runs])
