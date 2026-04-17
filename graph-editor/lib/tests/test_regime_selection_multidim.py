"""
Regime Selection — Orthogonal Dimension Tests (Doc 30 §5.1, Doc 44 Defect 2)

Blind tests for select_regime_rows_multidim: verifies that orthogonal
context dimensions (e.g. channel + device) are NOT treated as competing
regimes. Each dimension's rows must survive independently.

These tests exist because the original single-pass regime selection
dropped the second dimension's rows entirely — channel won every date,
device rows were silently discarded.

Run with: pytest lib/tests/test_regime_selection_multidim.py -v
"""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from snapshot_regime_selection import select_regime_rows_multidim


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

H_CHANNEL = 'hash-channel'
H_DEVICE = 'hash-device'
H_BARE = 'hash-bare'
H_CROSS = 'hash-cross-product'


def row(day: str, retrieved: str, core_hash: str, slice_key: str = '',
        x: int = 100, y: int = 10) -> dict:
    return dict(anchor_day=day, retrieved_at=retrieved,
                core_hash=core_hash, slice_key=slice_key, x=x, y=y)


def hashes_in(rows: list[dict]) -> set[str]:
    return {r['core_hash'] for r in rows}


def regime(core_hash: str, context_keys: list[str],
           equivalent_hashes: list[str] | None = None) -> dict:
    return {
        'core_hash': core_hash,
        'context_keys': context_keys,
        'equivalent_hashes': equivalent_hashes or [],
    }


# ---------------------------------------------------------------------------
# RB-MD-001: Two orthogonal dimensions — both survive
# ---------------------------------------------------------------------------

class TestOrthogonalDimensionsSurvive:
    """Core defect regression: channel and device rows must both survive
    when they represent orthogonal MECE dimensions."""

    def test_both_dimensions_preserved(self):
        """Channel and device rows on the same dates — neither dropped."""
        rows = [
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:direct)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:mobile)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:desktop)'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_DEVICE, ['device']),
        ]

        result = select_regime_rows_multidim(rows, candidates)

        assert len(result) == 4
        assert hashes_in(result) == {H_CHANNEL, H_DEVICE}

    def test_row_counts_exact(self):
        """No duplication — union is deduplicated by identity."""
        rows = [
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-02', '2026-01-16', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:mobile)'),
            row('2026-01-02', '2026-01-16', H_DEVICE,  'context(device:mobile)'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_DEVICE, ['device']),
        ]

        result = select_regime_rows_multidim(rows, candidates)

        assert len(result) == 4  # no duplication

    def test_three_dimensions(self):
        """Extends to three orthogonal dimensions."""
        H_GEO = 'hash-geo'
        rows = [
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:mobile)'),
            row('2026-01-01', '2026-01-15', H_GEO,     'context(geo:uk)'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_DEVICE, ['device']),
            regime(H_GEO, ['geo']),
        ]

        result = select_regime_rows_multidim(rows, candidates)

        assert len(result) == 3
        assert hashes_in(result) == {H_CHANNEL, H_DEVICE, H_GEO}


# ---------------------------------------------------------------------------
# RB-MD-002: Mixed-epoch — bare fallback within each dimension
# ---------------------------------------------------------------------------

class TestMixedEpochBarePerDimension:
    """Each dimension should fall back to bare on dates where only bare
    data exists, without bare stealing dates from other dimensions."""

    def test_bare_fallback_per_dimension(self):
        """Days 1-2 bare only, days 3-4 channel+device.
        Bare rows should appear (from fallback), plus all context rows."""
        rows = [
            # Bare-only dates
            row('2026-01-01', '2026-01-15', H_BARE, 'window()'),
            row('2026-01-02', '2026-01-16', H_BARE, 'window()'),
            # Context dates — both dimensions
            row('2026-01-03', '2026-01-17', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-03', '2026-01-17', H_DEVICE,  'context(device:mobile)'),
            row('2026-01-04', '2026-01-18', H_CHANNEL, 'context(channel:direct)'),
            row('2026-01-04', '2026-01-18', H_DEVICE,  'context(device:desktop)'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_DEVICE, ['device']),
            regime(H_BARE, []),
        ]

        result = select_regime_rows_multidim(rows, candidates)

        assert len(result) == 6
        assert hashes_in(result) == {H_BARE, H_CHANNEL, H_DEVICE}

    def test_bare_not_preferred_over_context_on_same_date(self):
        """When both bare and context exist on a date, context wins
        (within each dimension group, bare is lower preference)."""
        rows = [
            row('2026-01-01', '2026-01-15', H_BARE,    'window()'),
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:mobile)'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_DEVICE, ['device']),
            regime(H_BARE, []),
        ]

        result = select_regime_rows_multidim(rows, candidates)

        # Channel wins over bare in channel group, device wins in device group.
        # Bare row should NOT appear (context is preferred).
        assert hashes_in(result) == {H_CHANNEL, H_DEVICE}
        assert len(result) == 2


# ---------------------------------------------------------------------------
# RB-MD-003: Single dimension — falls back to standard selection
# ---------------------------------------------------------------------------

class TestSingleDimensionFallback:
    """When there's only one dimension (or no context_keys), the function
    should behave identically to standard select_regime_rows."""

    def test_single_dimension_no_regression(self):
        """Standard single-dim case: channel + bare, channel preferred."""
        rows = [
            row('2026-01-01', '2026-01-15', H_BARE,    'window()'),
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-02', '2026-01-16', H_BARE,    'window()'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_BARE, []),
        ]

        result = select_regime_rows_multidim(rows, candidates)

        # Day 1: channel wins. Day 2: only bare available.
        assert len(result) == 2
        day1 = [r for r in result if r['anchor_day'] == '2026-01-01']
        day2 = [r for r in result if r['anchor_day'] == '2026-01-02']
        assert day1[0]['core_hash'] == H_CHANNEL
        assert day2[0]['core_hash'] == H_BARE

    def test_no_context_keys_at_all(self):
        """Regimes without context_keys — original behaviour preserved."""
        rows = [
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'window()'),
            row('2026-01-01', '2026-01-15', H_BARE,    'window()'),
        ]
        # No context_keys field — all go to dim_key=""
        candidates = [
            {'core_hash': H_CHANNEL, 'equivalent_hashes': []},
            {'core_hash': H_BARE, 'equivalent_hashes': []},
        ]

        result = select_regime_rows_multidim(rows, candidates)

        # H_CHANNEL is first → wins
        assert len(result) == 1
        assert result[0]['core_hash'] == H_CHANNEL


# ---------------------------------------------------------------------------
# RB-MD-004: Edge cases
# ---------------------------------------------------------------------------

class TestMultidimEdgeCases:
    def test_empty_rows(self):
        candidates = [regime(H_CHANNEL, ['channel'])]
        assert select_regime_rows_multidim([], candidates) == []

    def test_empty_candidates(self):
        rows = [row('2026-01-01', '2026-01-15', H_CHANNEL)]
        assert select_regime_rows_multidim(rows, []) == []

    def test_invalid_candidate_skipped(self):
        """Candidates with no core_hash are silently skipped."""
        rows = [
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
        ]
        candidates = [
            {'core_hash': '', 'context_keys': ['channel']},  # invalid
            regime(H_CHANNEL, ['channel']),
        ]

        result = select_regime_rows_multidim(rows, candidates)
        assert len(result) == 1

    def test_no_matching_hash_drops_rows(self):
        """Rows whose hash matches no candidate are dropped."""
        rows = [
            row('2026-01-01', '2026-01-15', 'unknown-hash', 'window()'),
        ]
        candidates = [regime(H_CHANNEL, ['channel'])]

        result = select_regime_rows_multidim(rows, candidates)
        assert len(result) == 0


# ---------------------------------------------------------------------------
# RB-MD-005: Volume conservation — no double-counting
# ---------------------------------------------------------------------------

class TestVolumeConservation:
    """Rows must not be duplicated when dimensions share dates."""

    def test_shared_dates_no_duplication(self):
        """Same anchor_day/retrieved_at across dimensions — each row
        appears exactly once in the output."""
        shared_rows = [
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:google)'),
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:direct)'),
            row('2026-01-01', '2026-01-15', H_CHANNEL, 'context(channel:email)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:mobile)'),
            row('2026-01-01', '2026-01-15', H_DEVICE,  'context(device:desktop)'),
        ]
        candidates = [
            regime(H_CHANNEL, ['channel']),
            regime(H_DEVICE, ['device']),
        ]

        result = select_regime_rows_multidim(shared_rows, candidates)

        assert len(result) == 5  # exactly the input, no duplication
        # Verify by identity — each input row appears once
        result_ids = {id(r) for r in result}
        assert len(result_ids) == 5
