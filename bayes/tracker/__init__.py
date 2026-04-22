"""Investigation tracker.

Structured source of truth for the Bayes defect-isolation workflow.
See docs/current/project-bayes/63-investigation-tracker-mcp-spec.md.
"""

from .schema import (
    BlockerCategory,
    CurrentLine,
    Hypothesis,
    Issue,
    IssueState,
    Run,
    RunStatus,
    Severity,
    TrackerState,
    next_issue_id,
    next_run_id,
)
from .storage import TrackerStorageError, atomic_write, load, save

__all__ = [
    "BlockerCategory",
    "CurrentLine",
    "Hypothesis",
    "Issue",
    "IssueState",
    "Run",
    "RunStatus",
    "Severity",
    "TrackerState",
    "TrackerStorageError",
    "atomic_write",
    "load",
    "next_issue_id",
    "next_run_id",
    "save",
]
