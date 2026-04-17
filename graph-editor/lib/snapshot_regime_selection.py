"""
Snapshot Regime Selection — Doc 30 §6

Selects one observation regime per retrieved_at date from a bag of
snapshot rows that may contain rows from multiple regimes (different
hash families representing the same underlying conversions sliced
differently).

Core invariant: for a given (edge, anchor_day, retrieved_at) triple,
the consumer must see rows from exactly one regime. Summing across
regimes double-counts.

See: docs/current/project-bayes/30-snapshot-regime-selection-contract.md
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CandidateRegime:
    """One candidate hash family for an edge.

    All values within a MECE dimension share one core_hash (the
    signature includes context definition hashes but not context
    values). So a regime = one context dimension level (or
    uncontexted, or cross-product). See doc 30 §3.

    Ordered by preference in the candidate list. The selection
    utility tries them in order and picks the first that has data
    per retrieved_at date.
    """
    core_hash: str
    equivalent_hashes: list[str] = field(default_factory=list)
    temporal_mode: str = ''  # 'window' | 'cohort' | '' (untagged legacy)

    def all_hashes(self) -> set[str]:
        """All hashes that belong to this regime (core + equivalents)."""
        s = {self.core_hash}
        s.update(self.equivalent_hashes)
        return s


@dataclass
class RegimeSelection:
    """Result of per-date regime selection."""
    rows: list[dict[str, Any]]
    regime_per_date: dict[str, CandidateRegime]
    # retrieved_at (date-level ISO string) → winning regime.
    # Consumers can inspect the winning regime's core_hash and
    # cross-reference with the returned rows' slice_keys to
    # determine whether the data is contexted or uncontexted.


def select_regime_rows(
    rows: list[dict[str, Any]],
    candidate_regimes: list[CandidateRegime],
) -> RegimeSelection:
    """Filter rows to one regime per retrieved_at date.

    For each distinct retrieved_at (date-level) in the input rows:
    1. Try each candidate regime in order (closest match first).
    2. A regime "matches" if any row exists with core_hash in
       (regime.core_hash ∪ regime.equivalent_hashes).
    3. Keep only rows from the first matching regime.
    4. Discard rows from all other regimes for that retrieved_at.

    Returns filtered rows AND the regime decision per date, so
    the evidence binder can route observations to the correct
    likelihood terms (parent vs child).
    """
    if not rows or not candidate_regimes:
        return RegimeSelection(rows=[], regime_per_date={})

    # Pre-compute hash sets per regime (once, not per-date).
    regime_hash_sets: list[set[str]] = [r.all_hashes() for r in candidate_regimes]

    # Group rows by retrieved_at date (truncate datetime to date).
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        ret = str(r.get('retrieved_at', ''))
        date_key = ret[:10]  # ISO date prefix
        by_date[date_key].append(r)

    # Per-date regime selection: first matching candidate wins.
    out_rows: list[dict[str, Any]] = []
    regime_per_date: dict[str, CandidateRegime] = {}

    for date_key, date_rows in by_date.items():
        # Collect hashes present in this date's rows.
        hashes_present = {str(r.get('core_hash', '')) for r in date_rows}

        # Try each regime in preference order.
        winner: CandidateRegime | None = None
        winner_hashes: set[str] | None = None
        for regime, hash_set in zip(candidate_regimes, regime_hash_sets):
            if hashes_present & hash_set:  # intersection — any match
                winner = regime
                winner_hashes = hash_set
                break

        if winner is None or winner_hashes is None:
            # No regime matched — discard all rows for this date.
            continue

        # Keep only rows whose core_hash is in the winning regime.
        for r in date_rows:
            if str(r.get('core_hash', '')) in winner_hashes:
                out_rows.append(r)

        regime_per_date[date_key] = winner

    return RegimeSelection(rows=out_rows, regime_per_date=regime_per_date)


def select_regime_rows_multidim(
    rows: list[dict[str, Any]],
    candidate_regimes_raw: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Dimension-aware regime selection for orthogonal context dimensions.

    When candidate regimes span multiple context dimensions (e.g. channel
    AND device), regimes from different dimensions must NOT compete.
    This function groups candidates by their `context_keys`, runs
    `select_regime_rows` independently per dimension group, and unions
    the surviving rows.

    Each dimension group includes bare (uncontexted) regimes as fallback,
    so mixed-epoch dates where only bare data exists are handled.

    Args:
        rows: All snapshot rows for one edge.
        candidate_regimes_raw: List of dicts with keys:
            core_hash: str
            equivalent_hashes: list[str]  (optional)
            context_keys: list[str]       (optional, e.g. ["channel"])

    Returns:
        Filtered rows — union of per-dimension selections.
        If only one dimension group exists, falls back to standard
        single-pass selection.
    """
    if not rows or not candidate_regimes_raw:
        return []

    # Group by dimension key-set
    dim_groups: dict[str, list[dict]] = defaultdict(list)
    for r in candidate_regimes_raw:
        if not isinstance(r, dict) or not r.get('core_hash'):
            continue
        dim_key = '||'.join(sorted(r.get('context_keys') or []))
        dim_groups[dim_key].append(r)

    def _to_candidate(raw: dict) -> CandidateRegime:
        return CandidateRegime(
            core_hash=raw.get('core_hash', ''),
            equivalent_hashes=[
                e.get('core_hash', '') if isinstance(e, dict) else str(e)
                for e in (raw.get('equivalent_hashes') or [])
            ],
        )

    # Single dimension group — standard selection
    if len(dim_groups) <= 1:
        regimes = [_to_candidate(r) for r in candidate_regimes_raw
                    if isinstance(r, dict) and r.get('core_hash')]
        if not regimes:
            return []
        return select_regime_rows(rows, regimes).rows

    # Multi-dimension: run per-dimension, union results.
    bare_raw = dim_groups.pop('', [])
    kept_ids: set[int] = set()
    all_kept: list[dict] = []
    covered_dates: set[str] = set()

    for _dim_key, group_raw in dim_groups.items():
        combined = group_raw + bare_raw
        regimes = [_to_candidate(r) for r in combined]
        selection = select_regime_rows(rows, regimes)
        for row in selection.rows:
            rid = id(row)
            if rid not in kept_ids:
                kept_ids.add(rid)
                all_kept.append(row)
            covered_dates.add(str(row.get('retrieved_at', ''))[:10])

    # Bare-only dates not already covered by any dimension group.
    # Without this, bare rows on context-covered dates would leak through
    # and cause double-counting.
    if bare_raw:
        bare_regimes = [_to_candidate(r) for r in bare_raw]
        bare_sel = select_regime_rows(rows, bare_regimes)
        for row in bare_sel.rows:
            date_key = str(row.get('retrieved_at', ''))[:10]
            if date_key in covered_dates:
                continue
            rid = id(row)
            if rid not in kept_ids:
                kept_ids.add(rid)
                all_kept.append(row)

    return all_kept


def validate_mece_for_aggregation(
    rows: list[dict[str, Any]],
    mece_dimensions: list[str],
) -> list[str]:
    """Check that all context dimensions in the rows are MECE-safe.

    Extracts dimension names from slice_key strings on the rows
    (e.g. 'context(channel:google).window()' → 'channel') and checks
    each against the mece_dimensions list.

    Returns a list of dimension names that are NOT MECE — i.e. not
    safe to sum over. Empty list means all dimensions are safe.

    This is a validation check, not a filter. Callers decide what to
    do with non-MECE dimensions (log warning, skip aggregation, etc.).
    """
    mece_set = set(mece_dimensions)
    dims_found: set[str] = set()

    for r in rows:
        sk = str(r.get('slice_key', ''))
        # Extract dimension keys from context(...) clauses
        for m in re.finditer(r'context\(([^:)]+)', sk):
            dims_found.add(m.group(1))

    non_mece = sorted(dims_found - mece_set)
    return non_mece
