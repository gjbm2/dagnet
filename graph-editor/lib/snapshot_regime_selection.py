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
    from collections import defaultdict
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
