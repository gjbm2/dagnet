"""
Snapshot Regime Selection — Red Tests (Doc 30 §7.3.3)

Tests for select_regime_rows() in isolation. Pure function: rows in,
RegimeSelection out. No DB, no network.

Every test MUST have rows from multiple regimes in the input — a test
with only one regime's rows passes trivially and proves nothing.

Run with: pytest lib/tests/test_snapshot_regime_selection.py -v
"""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from snapshot_regime_selection import (
    CandidateRegime,
    RegimeSelection,
    select_regime_rows,
    validate_mece_for_aggregation,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def row(anchor_day: str, retrieved_at: str, core_hash: str,
        slice_key: str, x: int, y: int, a: int = 0,
        **extra) -> dict:
    """Build a synthetic snapshot row."""
    r = dict(
        anchor_day=anchor_day,
        retrieved_at=retrieved_at,
        core_hash=core_hash,
        slice_key=slice_key,
        x=x, y=y, a=a,
    )
    r.update(extra)
    return r


def _retrieved_at_date(dt: str) -> str:
    """Truncate a retrieved_at datetime to date-level ISO string."""
    return dt[:10]


# ---------------------------------------------------------------------------
# Hash constants
# ---------------------------------------------------------------------------

H_CHANNEL = 'hash-channel-001'
H_DEVICE = 'hash-device-002'
H_BARE = 'hash-bare-003'
H_GEO = 'hash-geo-004'
H_CHANNEL_OLD = 'hash-channel-old-005'
H_CHANNEL_NEW = 'hash-channel-new-006'
H_CROSS = 'hash-channel-x-device-007'


# ---------------------------------------------------------------------------
# Regime fixtures
# ---------------------------------------------------------------------------

def regime_channel() -> CandidateRegime:
    return CandidateRegime(core_hash=H_CHANNEL)


def regime_device() -> CandidateRegime:
    return CandidateRegime(core_hash=H_DEVICE)


def regime_bare() -> CandidateRegime:
    return CandidateRegime(core_hash=H_BARE)


def regime_geo() -> CandidateRegime:
    return CandidateRegime(core_hash=H_GEO)


def regime_channel_with_mapping() -> CandidateRegime:
    """Channel regime where the hash has been renamed (old → new mapping)."""
    return CandidateRegime(
        core_hash=H_CHANNEL_OLD,
        equivalent_hashes=[H_CHANNEL_NEW],
    )


def regime_cross_product() -> CandidateRegime:
    """Cross-product regime: context(channel) × context(device)."""
    return CandidateRegime(core_hash=H_CROSS)


# ===================================================================
# RS-001: Two MECE dimensions, same (anchor_day, retrieved_at)
# ===================================================================

class TestRS001_TwoDimensionsSameDate:
    """Two MECE dimensions both have rows for the same retrieval date.
    The preferred regime (first in list) should win; the other's rows
    should be discarded entirely."""

    def test_preferred_regime_wins(self):
        rows = [
            # Channel regime (preferred — first in list)
            row('2026-01-15', '2026-02-01T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2026-01-15', '2026-02-01T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=40, y=8),
            # Device regime (second in list — should be discarded)
            row('2026-01-15', '2026-02-01T06:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
            row('2026-01-15', '2026-02-01T06:00:00Z', H_DEVICE,
                'context(device:desktop).window()', x=45, y=9),
        ]

        result = select_regime_rows(rows, [regime_channel(), regime_device()])

        # Only channel rows should survive
        assert len(result.rows) == 2
        assert all(r['core_hash'] == H_CHANNEL for r in result.rows)
        total_x = sum(r['x'] for r in result.rows)
        assert total_x == 100  # 60 + 40, not 200

    def test_regime_per_date_populated(self):
        rows = [
            row('2026-01-15', '2026-02-01T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2026-01-15', '2026-02-01T06:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
        ]

        result = select_regime_rows(rows, [regime_channel(), regime_device()])

        assert '2026-02-01' in result.regime_per_date
        assert result.regime_per_date['2026-02-01'].core_hash == H_CHANNEL


# ===================================================================
# RS-002: Regime transition across retrieved_at dates
# ===================================================================

class TestRS002_RegimeTransition:
    """Different retrieved_at dates resolve to different regimes based
    on availability. The preference order is [channel, device, bare]
    but each date picks the first that has data."""

    def test_per_date_selection(self):
        rows = [
            # 1-Jan: only bare has data
            row('2025-12-01', '2026-01-01T06:00:00Z', H_BARE,
                'window()', x=100, y=20),
            # 15-Jan: only channel has data
            row('2025-12-01', '2026-01-15T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-15T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=40, y=8),
            # 1-Feb: both channel and device have data
            row('2025-12-01', '2026-02-01T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=62, y=13),
            row('2025-12-01', '2026-02-01T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=38, y=7),
            row('2025-12-01', '2026-02-01T06:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
            row('2025-12-01', '2026-02-01T06:00:00Z', H_DEVICE,
                'context(device:desktop).window()', x=45, y=9),
        ]

        candidates = [regime_channel(), regime_device(), regime_bare()]
        result = select_regime_rows(rows, candidates)

        # 1-Jan: bare (only option)
        jan_rows = [r for r in result.rows
                    if r['retrieved_at'].startswith('2026-01-01')]
        assert len(jan_rows) == 1
        assert jan_rows[0]['core_hash'] == H_BARE

        # 15-Jan: channel (preferred, and only option)
        jan15_rows = [r for r in result.rows
                      if r['retrieved_at'].startswith('2026-01-15')]
        assert len(jan15_rows) == 2
        assert all(r['core_hash'] == H_CHANNEL for r in jan15_rows)

        # 1-Feb: channel (preferred over device)
        feb_rows = [r for r in result.rows
                    if r['retrieved_at'].startswith('2026-02-01')]
        assert len(feb_rows) == 2
        assert all(r['core_hash'] == H_CHANNEL for r in feb_rows)

    def test_regime_per_date_tracks_transitions(self):
        rows = [
            row('2025-12-01', '2026-01-01T06:00:00Z', H_BARE,
                'window()', x=100, y=20),
            row('2025-12-01', '2026-01-15T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
        ]

        candidates = [regime_channel(), regime_device(), regime_bare()]
        result = select_regime_rows(rows, candidates)

        assert result.regime_per_date['2026-01-01'].core_hash == H_BARE
        assert result.regime_per_date['2026-01-15'].core_hash == H_CHANNEL


# ===================================================================
# RS-003: Uncontexted fallback
# ===================================================================

class TestRS003_UncontextedFallback:
    """Channel is preferred but has no data for a date. Bare does.
    Should fall back to bare for that date."""

    def test_fallback_to_bare(self):
        rows = [
            # Channel has data for date A
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=40, y=8),
            # Only bare has data for date B
            row('2025-12-01', '2026-01-20T06:00:00Z', H_BARE,
                'window()', x=100, y=20),
        ]

        candidates = [regime_channel(), regime_bare()]
        result = select_regime_rows(rows, candidates)

        assert len(result.rows) == 3  # 2 channel + 1 bare
        date_a_rows = [r for r in result.rows
                       if r['retrieved_at'].startswith('2026-01-10')]
        assert all(r['core_hash'] == H_CHANNEL for r in date_a_rows)

        date_b_rows = [r for r in result.rows
                       if r['retrieved_at'].startswith('2026-01-20')]
        assert len(date_b_rows) == 1
        assert date_b_rows[0]['core_hash'] == H_BARE


# ===================================================================
# RS-004: Hash mapping within one regime
# ===================================================================

class TestRS004_HashMappingWithinRegime:
    """Equivalent hashes within one regime cover different date ranges.
    Both should be kept — they are the same regime, not competing
    regimes. A fetch writes under one hash only; mappings just widen
    the read query."""

    def test_equivalent_hashes_both_kept(self):
        rows = [
            # Old hash covers Jan dates
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL_OLD,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL_OLD,
                'context(channel:meta).window()', x=40, y=8),
            # New hash covers Feb dates
            row('2025-12-01', '2026-02-10T06:00:00Z', H_CHANNEL_NEW,
                'context(channel:google).window()', x=65, y=14),
            row('2025-12-01', '2026-02-10T06:00:00Z', H_CHANNEL_NEW,
                'context(channel:meta).window()', x=35, y=6),
            # Device regime also has Feb data (should be discarded)
            row('2025-12-01', '2026-02-10T06:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
        ]

        candidates = [regime_channel_with_mapping(), regime_device()]
        result = select_regime_rows(rows, candidates)

        # All 4 channel rows kept (old + new hash, same regime)
        assert len(result.rows) == 4
        hashes_used = {r['core_hash'] for r in result.rows}
        assert hashes_used == {H_CHANNEL_OLD, H_CHANNEL_NEW}

        # Device row discarded on Feb date (channel regime won via new hash)
        assert not any(r['core_hash'] == H_DEVICE for r in result.rows)


# ===================================================================
# RS-005: Hash mapping across regimes
# ===================================================================

class TestRS005_HashMappingAcrossRegimes:
    """Regime 0 has an equivalent hash that matches. Regime 1 also has
    data. Regime 0 should win via its equivalent hash match."""

    def test_equivalent_hash_wins_for_regime(self):
        rows = [
            # Channel regime's NEW hash has data (old is primary, new is equivalent)
            row('2025-12-01', '2026-02-01T06:00:00Z', H_CHANNEL_NEW,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-02-01T06:00:00Z', H_CHANNEL_NEW,
                'context(channel:meta).window()', x=40, y=8),
            # Device regime also has data
            row('2025-12-01', '2026-02-01T06:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
        ]

        candidates = [regime_channel_with_mapping(), regime_device()]
        result = select_regime_rows(rows, candidates)

        # Channel regime wins via equivalent hash
        assert len(result.rows) == 2
        assert all(r['core_hash'] == H_CHANNEL_NEW for r in result.rows)
        assert result.regime_per_date['2026-02-01'].core_hash == H_CHANNEL_OLD


# ===================================================================
# RS-006: Empty candidates
# ===================================================================

class TestRS006_EmptyCandidates:
    """No regimes match any rows. Output should be empty."""

    def test_no_matches(self):
        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', 'hash-unknown',
                'window()', x=100, y=20),
        ]

        candidates = [regime_channel(), regime_device()]
        result = select_regime_rows(rows, candidates)

        assert len(result.rows) == 0
        assert len(result.regime_per_date) == 0


# ===================================================================
# RS-007: Single regime pass-through
# ===================================================================

class TestRS007_SingleRegime:
    """Only one candidate. All rows match. Pass-through."""

    def test_all_rows_returned(self):
        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=40, y=8),
            row('2025-12-15', '2026-01-20T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=62, y=13),
            row('2025-12-15', '2026-01-20T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=38, y=7),
        ]

        result = select_regime_rows(rows, [regime_channel()])

        assert len(result.rows) == 4
        assert len(result.regime_per_date) == 2


# ===================================================================
# VM-001 to VM-004: validate_mece_for_aggregation
# ===================================================================

class TestVM001_AllDimensionsMECE:
    """All context dimensions in the rows are in mece_dimensions."""

    def test_returns_empty(self):
        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:meta).window()', x=40, y=8),
        ]
        non_mece = validate_mece_for_aggregation(rows, ['channel'])
        assert non_mece == []


class TestVM002_NonMECEDimension:
    """A dimension in the rows is NOT in mece_dimensions."""

    def test_returns_non_mece_dimension(self):
        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).context(experiment:v1).window()', x=30, y=6),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:meta).context(experiment:v1).window()', x=20, y=4),
        ]
        non_mece = validate_mece_for_aggregation(rows, ['channel'])
        assert non_mece == ['experiment']


class TestVM003_NoDimensions:
    """Uncontexted rows have no dimensions — always safe."""

    def test_returns_empty(self):
        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', H_BARE,
                'window()', x=100, y=20),
        ]
        non_mece = validate_mece_for_aggregation(rows, ['channel'])
        assert non_mece == []


class TestVM004_CrossProductMixed:
    """Cross-product with one MECE and one non-MECE dimension."""

    def test_returns_only_non_mece(self):
        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CROSS,
                'context(channel:google).context(experiment:v1).window()', x=30, y=6),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CROSS,
                'context(channel:meta).context(experiment:v2).window()', x=20, y=4),
        ]
        non_mece = validate_mece_for_aggregation(
            rows, ['channel', 'onboarding_variant'])
        assert non_mece == ['experiment']


# ===================================================================
# RS-008: Three dimensions + uncontexted
# ===================================================================

class TestRS008_ThreeDimensionsPlusUncontexted:
    """Channel, device, geo, plus bare. Various availability patterns
    across dates. Preference: [channel, device, geo, bare]."""

    def test_per_date_availability(self):
        rows = [
            # Date A: all four regimes have data → channel wins
            row('2025-12-01', '2026-01-01T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-01T06:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
            row('2025-12-01', '2026-01-01T06:00:00Z', H_GEO,
                'context(geo:UK).window()', x=70, y=14),
            row('2025-12-01', '2026-01-01T06:00:00Z', H_BARE,
                'window()', x=100, y=20),

            # Date B: only geo and bare → geo wins
            row('2025-12-01', '2026-02-01T06:00:00Z', H_GEO,
                'context(geo:UK).window()', x=70, y=14),
            row('2025-12-01', '2026-02-01T06:00:00Z', H_BARE,
                'window()', x=100, y=20),

            # Date C: only bare → bare wins
            row('2025-12-01', '2026-03-01T06:00:00Z', H_BARE,
                'window()', x=100, y=20),
        ]

        candidates = [
            regime_channel(), regime_device(),
            regime_geo(), regime_bare(),
        ]
        result = select_regime_rows(rows, candidates)

        # Date A: channel
        date_a = [r for r in result.rows
                  if r['retrieved_at'].startswith('2026-01-01')]
        assert all(r['core_hash'] == H_CHANNEL for r in date_a)

        # Date B: geo
        date_b = [r for r in result.rows
                  if r['retrieved_at'].startswith('2026-02-01')]
        assert all(r['core_hash'] == H_GEO for r in date_b)

        # Date C: bare
        date_c = [r for r in result.rows
                  if r['retrieved_at'].startswith('2026-03-01')]
        assert all(r['core_hash'] == H_BARE for r in date_c)

    def test_no_rows_for_uncovered_date(self):
        """Date D has no rows from any regime. Should produce nothing."""
        rows = [
            row('2025-12-01', '2026-01-01T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
        ]

        candidates = [regime_channel()]
        result = select_regime_rows(rows, candidates)

        # No rows for dates that aren't in the input
        assert '2026-04-01' not in result.regime_per_date


# ===================================================================
# RS-009: Closest-match ordering (superset preference)
# ===================================================================

class TestRS009_ClosestMatchOrdering:
    """Query for context(channel:google). Exact hash is preferred over
    cross-product hash (which requires summing over device)."""

    def test_exact_preferred_over_superset(self):
        rows = [
            # Exact match (regime 0)
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            # Cross-product (regime 1) — would need summing over device
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CROSS,
                'context(channel:google).context(device:mobile).window()',
                x=35, y=7),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CROSS,
                'context(channel:google).context(device:desktop).window()',
                x=25, y=5),
        ]

        # Exact first, cross-product second
        candidates = [regime_channel(), regime_cross_product()]
        result = select_regime_rows(rows, candidates)

        assert len(result.rows) == 1
        assert result.rows[0]['core_hash'] == H_CHANNEL
        assert result.rows[0]['x'] == 60


# ===================================================================
# RS-010: Superset is only option
# ===================================================================

class TestRS010_SupersetOnly:
    """Exact hash has no data. Cross-product hash does. Falls back to
    cross-product (superset)."""

    def test_superset_fallback(self):
        rows = [
            # Only cross-product has data
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CROSS,
                'context(channel:google).context(device:mobile).window()',
                x=35, y=7),
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CROSS,
                'context(channel:google).context(device:desktop).window()',
                x=25, y=5),
        ]

        candidates = [regime_channel(), regime_cross_product()]
        result = select_regime_rows(rows, candidates)

        assert len(result.rows) == 2
        assert all(r['core_hash'] == H_CROSS for r in result.rows)
        assert sum(r['x'] for r in result.rows) == 60


# ===================================================================
# RS-011: Date-level grouping
# ===================================================================

class TestRS011_DateLevelGrouping:
    """Two retrievals on the same calendar day (different timestamps)
    belong to the same regime decision."""

    def test_same_day_grouped(self):
        rows = [
            # Channel at 06:00
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            # Channel at 18:00 (same day, different time)
            row('2025-12-15', '2026-01-10T18:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=62, y=13),
            # Device at 18:00 (same day — should be discarded)
            row('2025-12-15', '2026-01-10T18:00:00Z', H_DEVICE,
                'context(device:mobile).window()', x=55, y=11),
        ]

        result = select_regime_rows(rows, [regime_channel(), regime_device()])

        # Both channel rows kept (same regime, same day)
        assert len(result.rows) == 2
        assert all(r['core_hash'] == H_CHANNEL for r in result.rows)
        # One date entry
        assert len(result.regime_per_date) == 1
        assert '2026-01-10' in result.regime_per_date


# ===================================================================
# RS-012: regime_per_date correctness
# ===================================================================

class TestRS012_RegimePerDateCorrectness:
    """Verify regime_per_date dict structure: keys are date-level
    strings, values are the actual CandidateRegime objects from the
    input list, coverage matches output rows."""

    def test_structure(self):
        r_channel = regime_channel()
        r_bare = regime_bare()

        rows = [
            row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
                'context(channel:google).window()', x=60, y=12),
            row('2025-12-01', '2026-01-20T06:00:00Z', H_BARE,
                'window()', x=100, y=20),
        ]

        result = select_regime_rows(rows, [r_channel, r_bare])

        # Keys are date-level strings
        assert all(len(k) == 10 for k in result.regime_per_date.keys())

        # Values are the actual objects from the input list
        assert result.regime_per_date['2026-01-10'] is r_channel
        assert result.regime_per_date['2026-01-20'] is r_bare

        # Every date that has rows in the output appears in the dict
        output_dates = {r['retrieved_at'][:10] for r in result.rows}
        assert output_dates == set(result.regime_per_date.keys())

        # No extra dates
        assert len(result.regime_per_date) == 2
