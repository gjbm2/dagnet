"""
Cohort Maturity Derivation from Snapshot Data

For a given anchor range, reconstructs the virtual snapshot at each distinct
retrieval date within the sweep window.  Each frame shows "what we knew about
these cohorts as of that retrieval date."

Output shape:
    {
        "analysis_type": "cohort_maturity",
        "frames": [
            {
                "as_at_date": "2025-11-01",
                "data_points": [
                    {"anchor_day": "2025-10-01", "y": 42, ...},
                    ...
                ],
                "total_y": int,
            },
            ...
        ],
        "anchor_range": {"from": str, "to": str},
        "sweep_range": {"from": str, "to": str},
        "cohorts_analysed": int,
    }

Design reference: docs/current/project-db/1-reads.md §5.1, §10.2
"""

from collections import defaultdict
from typing import List, Dict, Any, Optional, Tuple
from datetime import date, datetime, timezone


def derive_cohort_maturity(
    rows: List[Dict[str, Any]],
    sweep_from: Optional[str] = None,
    sweep_to: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Derive cohort maturity frames from sweep rows.

    Algorithm:
    1. Parse all rows; group by (anchor_day, slice_key) — one "series" per group.
    2. Identify distinct retrieval dates across all rows → these become frames.
    3. For each retrieval date (in chronological order), compute the virtual
       snapshot: latest Y per (anchor_day, slice_key) as-of that date.
    4. Emit one frame per retrieval date containing data_points for each
       anchor_day (Y aggregated across slices).

    Args:
        rows: Raw snapshot rows (from query_snapshots_for_sweep) with
              anchor_day, retrieved_at, y, slice_key, etc.
        sweep_from: Optional ISO date for labelling.
        sweep_to:   Optional ISO date for labelling.

    Returns:
        Result dict with frames array (see module docstring).
    """
    if not rows:
        return {
            "analysis_type": "cohort_maturity",
            "frames": [],
            "anchor_range": {"from": None, "to": None},
            "sweep_range": {"from": sweep_from, "to": sweep_to},
            "cohorts_analysed": 0,
        }

    # ------------------------------------------------------------------
    # 1. Parse rows into typed structures
    # ------------------------------------------------------------------
    parsed_rows: List[_ParsedRow] = []
    for row in rows:
        parsed_rows.append(_parse_row(row))

    # ------------------------------------------------------------------
    # 2. Identify distinct retrieval dates (date-level granularity)
    # ------------------------------------------------------------------
    retrieval_dates = sorted({r.retrieved_date for r in parsed_rows})

    # ------------------------------------------------------------------
    # 3. Group rows by series key (anchor_day, slice_key)
    # ------------------------------------------------------------------
    by_series: Dict[Tuple[date, str], List[_ParsedRow]] = defaultdict(list)
    for r in parsed_rows:
        by_series[(r.anchor_day, r.slice_key)].append(r)

    # Pre-sort each series by retrieved_at
    for series_rows in by_series.values():
        series_rows.sort(key=lambda r: r.retrieved_at)

    anchor_days = sorted({r.anchor_day for r in parsed_rows})

    # ------------------------------------------------------------------
    # 4. For each retrieval date, compute virtual snapshot
    # ------------------------------------------------------------------
    frames: List[Dict[str, Any]] = []

    for ret_date in retrieval_dates:
        # Use timezone-aware cutoff (end of day UTC) to handle both
        # aware and naive retrieved_at timestamps consistently.
        ret_cutoff = datetime.combine(
            ret_date, datetime.max.time(), tzinfo=timezone.utc
        )

        # Compute latest Y per anchor_day (aggregating across slices)
        anchor_totals: Dict[date, Dict[str, Any]] = {}

        for (anchor_day, slice_key), series_rows in by_series.items():
            # Find latest row as-of ret_cutoff
            latest = None
            for r in series_rows:
                if r.retrieved_at <= ret_cutoff:
                    latest = r
                else:
                    break  # sorted, all subsequent are later

            if latest is None:
                continue

            if anchor_day not in anchor_totals:
                anchor_totals[anchor_day] = {
                    "y": 0,
                    "x": 0,
                    "a": 0,
                    "median_lag_days": None,
                    "mean_lag_days": None,
                    "onset_delta_days": None,
                }
            entry = anchor_totals[anchor_day]
            entry["y"] += latest.y
            entry["x"] += latest.x
            entry["a"] += latest.a
            # For lag metadata, keep most-recent non-null (across slices)
            if latest.median_lag_days is not None:
                entry["median_lag_days"] = latest.median_lag_days
            if latest.mean_lag_days is not None:
                entry["mean_lag_days"] = latest.mean_lag_days
            if latest.onset_delta_days is not None:
                entry["onset_delta_days"] = latest.onset_delta_days

        # Build data_points for this frame
        data_points = []
        total_y = 0
        for ad in anchor_days:
            if ad in anchor_totals:
                entry = anchor_totals[ad]
                rate = entry["y"] / entry["x"] if entry["x"] > 0 else 0.0
                data_points.append({
                    "anchor_day": ad.isoformat(),
                    "y": entry["y"],
                    "x": entry["x"],
                    "a": entry["a"],
                    "rate": round(rate, 6),
                    "median_lag_days": entry["median_lag_days"],
                    "mean_lag_days": entry["mean_lag_days"],
                    "onset_delta_days": entry["onset_delta_days"],
                })
                total_y += entry["y"]

        frames.append({
            "as_at_date": ret_date.isoformat(),
            "data_points": data_points,
            "total_y": total_y,
        })

    return {
        "analysis_type": "cohort_maturity",
        "frames": frames,
        "anchor_range": {
            "from": anchor_days[0].isoformat() if anchor_days else None,
            "to": anchor_days[-1].isoformat() if anchor_days else None,
        },
        "sweep_range": {
            "from": sweep_from or (retrieval_dates[0].isoformat() if retrieval_dates else None),
            "to": sweep_to or (retrieval_dates[-1].isoformat() if retrieval_dates else None),
        },
        "cohorts_analysed": len(anchor_days),
    }


# =====================================================================
# Internal helpers
# =====================================================================

class _ParsedRow:
    """Typed representation of a snapshot row for internal use."""
    __slots__ = (
        "anchor_day", "slice_key", "retrieved_at", "retrieved_date",
        "a", "x", "y",
        "median_lag_days", "mean_lag_days", "onset_delta_days",
    )

    def __init__(
        self,
        anchor_day: date,
        slice_key: str,
        retrieved_at: datetime,
        a: int,
        x: int,
        y: int,
        median_lag_days: Optional[float],
        mean_lag_days: Optional[float],
        onset_delta_days: Optional[float],
    ):
        self.anchor_day = anchor_day
        self.slice_key = slice_key
        self.retrieved_at = retrieved_at
        self.retrieved_date = retrieved_at.date()
        self.a = a
        self.x = x
        self.y = y
        self.median_lag_days = median_lag_days
        self.mean_lag_days = mean_lag_days
        self.onset_delta_days = onset_delta_days


def _parse_row(row: Dict[str, Any]) -> _ParsedRow:
    anchor = row["anchor_day"]
    if isinstance(anchor, str):
        anchor = date.fromisoformat(anchor)

    retrieved = row["retrieved_at"]
    if isinstance(retrieved, str):
        retrieved = datetime.fromisoformat(retrieved.replace("Z", "+00:00"))
    # Ensure timezone-aware (UTC) for consistent comparisons
    if retrieved.tzinfo is None:
        retrieved = retrieved.replace(tzinfo=timezone.utc)

    return _ParsedRow(
        anchor_day=anchor,
        slice_key=row.get("slice_key") or "",
        retrieved_at=retrieved,
        a=_int_or_zero(row.get("a") or row.get("A")),
        x=_int_or_zero(row.get("x") or row.get("X")),
        y=_int_or_zero(row.get("y") or row.get("Y")),
        median_lag_days=_float_or_none(row.get("median_lag_days")),
        mean_lag_days=_float_or_none(row.get("mean_lag_days")),
        onset_delta_days=_float_or_none(row.get("onset_delta_days")),
    )


def _int_or_zero(val: Any) -> int:
    if val is None:
        return 0
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def _float_or_none(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None
