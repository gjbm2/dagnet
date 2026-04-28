"""
Shared uncovered-day file-evidence helpers.

This module lives in `graph-editor/lib` because it is imported by both:
  - the Vercel/dev Python backend (`api_handlers.py`)
  - the Modal/local Bayes compiler (`bayes/compiler/evidence.py`)

See deployment notes in:
  - docs/current/codebase/PYTHON_BACKEND_ARCHITECTURE.md
  - docs/current/project-bayes/archive/3-compute-and-deployment-architecture.md
"""

from __future__ import annotations

from dataclasses import dataclass, field
from collections.abc import Iterable, Iterator, Mapping
from datetime import date as _date, datetime
from typing import Any

WINDOW_SUBJECT_HELPER = "window_subject_helper"
DIRECT_COHORT_EXACT_SUBJECT = "direct_cohort_exact_subject"
BAYES_PHASE1_WINDOW = "bayes_phase1_window"
BAYES_PHASE2_COHORT = "bayes_phase2_cohort"


@dataclass(frozen=True)
class FileEvidencePoint:
    entry: Mapping[str, Any]
    date: str
    n: int
    k: int
    age_days: float
    slice_dsl: str


@dataclass(frozen=True)
class SkippedFileEvidence:
    date: str | None
    slice_dsl: str
    reason: str


@dataclass
class FileEvidenceMerge:
    role: str
    points: list[FileEvidencePoint] = field(default_factory=list)
    skipped: list[SkippedFileEvidence] = field(default_factory=list)

    @property
    def n(self) -> int:
        return sum(p.n for p in self.points)

    @property
    def k(self) -> int:
        return sum(p.k for p in self.points)

    @property
    def days(self) -> set[str]:
        return {p.date for p in self.points}

    def as_counts(self) -> dict[str, int]:
        return {"n": self.n, "k": self.k, "supplemented_days": len(self.points)}


def normalise_supported_date(raw: Any) -> str | None:
    """Normalise supported date strings to ISO yyyy-mm-dd."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    head = text[:10]
    try:
        return _date.fromisoformat(head).isoformat()
    except ValueError:
        pass
    for fmt in ("%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _entry_retrieved_at(entry: Mapping[str, Any]) -> str | None:
    direct = normalise_supported_date(entry.get("retrieved_at"))
    if direct:
        return direct
    ds = entry.get("data_source")
    if isinstance(ds, Mapping):
        return normalise_supported_date(ds.get("retrieved_at"))
    return None


def _age_days(date_iso: str, retrieved_iso: str | None) -> float:
    if not retrieved_iso:
        return 0.0
    try:
        return float((_date.fromisoformat(retrieved_iso) - _date.fromisoformat(date_iso)).days)
    except ValueError:
        return 0.0


def _slice_matches_role(
    slice_dsl: str,
    role: str,
    *,
    exact_cohort_anchor: str | None = None,
) -> tuple[bool, str | None]:
    is_context = "context(" in slice_dsl
    is_window = "window(" in slice_dsl
    is_cohort = "cohort(" in slice_dsl

    if is_context:
        return False, "unsupported_context"

    if role in {WINDOW_SUBJECT_HELPER, BAYES_PHASE1_WINDOW}:
        return (True, None) if is_window else (False, "wrong_role")

    if role == DIRECT_COHORT_EXACT_SUBJECT:
        if not is_cohort:
            return False, "wrong_role"
        if exact_cohort_anchor and f"cohort({exact_cohort_anchor}" not in slice_dsl:
            return False, "wrong_cohort_anchor"
        return True, None

    if role == BAYES_PHASE2_COHORT:
        return (True, None) if is_cohort else (False, "wrong_role")

    return False, "unknown_role"


def merge_file_evidence_for_role(
    entries: Iterable[Mapping[str, Any] | Any],
    snapshot_covered_days: set[str] | None,
    *,
    role: str,
    anchor_from: str | None = None,
    anchor_to: str | None = None,
    exact_cohort_anchor: str | None = None,
) -> FileEvidenceMerge:
    """Return role-compatible uncovered file evidence with provenance.

    This is the shared file-side half of the snapshot+file evidence merge.
    Snapshot evidence wins for covered days; file rows are admitted only
    when their slice family matches the explicit evidence role.
    """
    result = FileEvidenceMerge(role=role)
    covered_iso = {
        iso
        for iso in (
            normalise_supported_date(day)
            for day in (snapshot_covered_days or set())
        )
        if iso
    }
    anchor_from_iso = normalise_supported_date(anchor_from) if anchor_from else None
    anchor_to_iso = normalise_supported_date(anchor_to) if anchor_to else None

    for raw_entry in entries:
        if not isinstance(raw_entry, Mapping):
            continue
        entry = raw_entry
        slice_dsl = str(entry.get("sliceDSL") or "")
        matches, reason = _slice_matches_role(
            slice_dsl,
            role,
            exact_cohort_anchor=exact_cohort_anchor,
        )

        n_daily = entry.get("n_daily") or []
        k_daily = entry.get("k_daily") or []
        dates = entry.get("dates") or []
        if not (
            isinstance(n_daily, list)
            and isinstance(k_daily, list)
            and isinstance(dates, list)
            and len(n_daily) == len(k_daily) == len(dates)
        ):
            if matches:
                result.skipped.append(SkippedFileEvidence(None, slice_dsl, "missing_daily_arrays"))
            continue

        for idx, raw_date in enumerate(dates):
            date_iso = normalise_supported_date(raw_date)
            if not date_iso:
                result.skipped.append(SkippedFileEvidence(None, slice_dsl, "invalid_date"))
                continue
            if anchor_from_iso and date_iso < anchor_from_iso:
                continue
            if anchor_to_iso and date_iso > anchor_to_iso:
                continue
            if not matches:
                result.skipped.append(SkippedFileEvidence(date_iso, slice_dsl, reason or "wrong_role"))
                continue
            if date_iso in covered_iso:
                result.skipped.append(SkippedFileEvidence(date_iso, slice_dsl, "covered_by_snapshot"))
                continue
            retrieved_iso = _entry_retrieved_at(entry)
            if retrieved_iso and date_iso > retrieved_iso:
                result.skipped.append(SkippedFileEvidence(date_iso, slice_dsl, "after_retrieved_at"))
                continue
            try:
                n_val = int(n_daily[idx] or 0)
                k_val = int(k_daily[idx] or 0)
            except (TypeError, ValueError):
                result.skipped.append(SkippedFileEvidence(date_iso, slice_dsl, "invalid_counts"))
                continue
            if n_val <= 0:
                result.skipped.append(SkippedFileEvidence(date_iso, slice_dsl, "non_positive_n"))
                continue
            result.points.append(FileEvidencePoint(
                entry=entry,
                date=date_iso,
                n=n_val,
                k=max(k_val, 0),
                age_days=_age_days(date_iso, retrieved_iso),
                slice_dsl=slice_dsl,
            ))

    return result


def iter_uncovered_bare_cohort_daily_points(
    entries: Iterable[Mapping[str, Any] | Any],
    snapshot_covered_days: set[str] | None,
    *,
    anchor_from: str | None = None,
    anchor_to: str | None = None,
) -> Iterator[tuple[Mapping[str, Any], str, int, int]]:
    """Yield uncovered bare cohort daily observations from file-backed data.

    Shared rule used by both Bayes evidence binding and BE conditioned
    forecast evidence counts:
      - only bare `cohort(...)` daily arrays are eligible
      - context-qualified entries are skipped
      - anchor days already covered by snapshot rows are skipped
    """
    merged = merge_file_evidence_for_role(
        entries,
        snapshot_covered_days,
        role=BAYES_PHASE2_COHORT,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
    )
    for point in merged.points:
        yield point.entry, point.date, point.n, point.k
