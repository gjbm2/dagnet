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

from collections.abc import Iterable, Iterator, Mapping
from datetime import date as _date, datetime
from typing import Any


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
        if "cohort(" not in slice_dsl or "context(" in slice_dsl:
            continue

        n_daily = entry.get("n_daily") or []
        k_daily = entry.get("k_daily") or []
        dates = entry.get("dates") or []
        if not (
            isinstance(n_daily, list)
            and isinstance(k_daily, list)
            and isinstance(dates, list)
            and len(n_daily) == len(k_daily) == len(dates)
        ):
            continue

        for idx, raw_date in enumerate(dates):
            date_iso = normalise_supported_date(raw_date)
            if not date_iso:
                continue
            if anchor_from_iso and date_iso < anchor_from_iso:
                continue
            if anchor_to_iso and date_iso > anchor_to_iso:
                continue
            if date_iso in covered_iso:
                continue

            try:
                n_val = int(n_daily[idx] or 0)
                k_val = int(k_daily[idx] or 0)
            except (TypeError, ValueError):
                continue
            if n_val <= 0:
                continue

            yield entry, date_iso, n_val, max(k_val, 0)
