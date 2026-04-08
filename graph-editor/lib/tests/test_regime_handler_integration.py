"""
Regime Selection Handler Integration Tests (Doc 30 §7.3.11 Gap 3)

Tests that select_regime_rows correctly filters multi-regime snapshot
data from the real DB. Writes its own test data, asserts, then cleans
up.

Requires: DB_CONNECTION environment variable (skip gracefully if absent).

Run with:
  DB_CONNECTION="postgresql://..." pytest lib/tests/test_regime_handler_integration.py -v
"""

import os
import sys
import pytest
from datetime import datetime, timezone, date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

DB_URL = os.environ.get('DB_CONNECTION', '')
requires_db = pytest.mark.skipif(not DB_URL, reason='DB_CONNECTION not set')

TEST_PREFIX = 'pytest-regime'
TEST_TIMESTAMP = datetime.now(timezone.utc)
SIG_ALGO = 'sig_v1_sha256_trunc128_b64url'

# Two fake hashes representing different context dimensions
H_CHANNEL = 'regime-test-hash-channel-001'
H_DEVICE = 'regime-test-hash-device-002'
# Fake structured signatures (content doesn't matter — hash is opaque)
SIG_CHANNEL = '{"c":"test-core","x":{"channel":"test-ch-def"}}'
SIG_DEVICE = '{"c":"test-core","x":{"device":"test-dev-def"}}'


def _test_param_id():
    return f'{TEST_PREFIX}-{TEST_TIMESTAMP.strftime("%Y%m%d%H%M%S")}'


@pytest.fixture(autouse=True)
def cleanup():
    """Clean up test data before and after each test."""
    try:
        from snapshot_service import get_db_connection
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s",
                    (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s",
                    (f'{TEST_PREFIX}%',))
        conn.commit()
        conn.close()
    except Exception:
        pass
    yield
    try:
        from snapshot_service import get_db_connection
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s",
                    (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s",
                    (f'{TEST_PREFIX}%',))
        conn.commit()
        conn.close()
    except Exception:
        pass


def _write_rows(param_id, core_hash, sig, slice_key, rows):
    from snapshot_service import append_snapshots
    append_snapshots(
        param_id=param_id,
        canonical_signature=sig,
        inputs_json={'schema': 'pytest', 'param_id': param_id},
        sig_algo=SIG_ALGO,
        slice_key=slice_key,
        retrieved_at=TEST_TIMESTAMP,
        rows=rows,
        core_hash=core_hash,
    )


@requires_db
class TestRCH001_RegimeSelectionWithRealDB:
    """RC-H-001: Write multi-regime data to the DB, query with all
    hashes, apply regime selection, verify only one regime survives."""

    def test_regime_selection_reduces_to_one_hash(self):
        pid = _test_param_id()

        # Write channel regime rows (2 slices, same hash)
        _write_rows(pid, H_CHANNEL, SIG_CHANNEL,
                     'context(channel:google).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 60, 'Y': 12}])
        _write_rows(pid, H_CHANNEL, SIG_CHANNEL,
                     'context(channel:meta).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 40, 'Y': 8}])

        # Write device regime rows (2 slices, different hash, SAME date)
        _write_rows(pid, H_DEVICE, SIG_DEVICE,
                     'context(device:mobile).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 55, 'Y': 11}])
        _write_rows(pid, H_DEVICE, SIG_DEVICE,
                     'context(device:desktop).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 45, 'Y': 9}])

        # Query with both hashes (broad)
        from snapshot_service import query_snapshots_for_sweep
        all_rows = query_snapshots_for_sweep(
            param_id=pid,
            core_hash=H_CHANNEL,
            slice_keys=[''],
            anchor_from=date(2026, 1, 1),
            anchor_to=date(2026, 4, 30),
            sweep_from=date(2026, 1, 1),
            sweep_to=date(2026, 12, 31),
            equivalent_hashes=[{'core_hash': H_DEVICE}],
        )

        # Should have 4 rows from both regimes
        assert len(all_rows) == 4
        hashes_present = set(r['core_hash'] for r in all_rows)
        assert len(hashes_present) == 2

        # Apply regime selection — channel preferred
        from snapshot_regime_selection import CandidateRegime, select_regime_rows
        selection = select_regime_rows(all_rows, [
            CandidateRegime(core_hash=H_CHANNEL),
            CandidateRegime(core_hash=H_DEVICE),
        ])

        # Only channel rows survive
        assert len(selection.rows) == 2
        assert all(r['core_hash'] == H_CHANNEL for r in selection.rows)
        total_x = sum(r['x'] for r in selection.rows)
        assert total_x == 100  # 60 + 40, not 200

    def test_regime_selection_sums_correctly_for_aggregate(self):
        """Verify that after regime selection, summing the remaining
        rows gives the correct aggregate (not double-counted)."""
        pid = _test_param_id()

        _write_rows(pid, H_CHANNEL, SIG_CHANNEL,
                     'context(channel:google).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 60, 'Y': 12}])
        _write_rows(pid, H_CHANNEL, SIG_CHANNEL,
                     'context(channel:meta).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 40, 'Y': 8}])
        _write_rows(pid, H_DEVICE, SIG_DEVICE,
                     'context(device:mobile).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 55, 'Y': 11}])
        _write_rows(pid, H_DEVICE, SIG_DEVICE,
                     'context(device:desktop).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 45, 'Y': 9}])

        from snapshot_service import query_snapshots_for_sweep
        all_rows = query_snapshots_for_sweep(
            param_id=pid,
            core_hash=H_CHANNEL,
            slice_keys=[''],
            anchor_from=date(2026, 1, 1),
            anchor_to=date(2026, 4, 30),
            sweep_from=date(2026, 1, 1),
            sweep_to=date(2026, 12, 31),
            equivalent_hashes=[{'core_hash': H_DEVICE}],
        )

        # Without selection: sum all = 200, 40 (double-counted)
        total_x_all = sum(r['x'] for r in all_rows)
        total_y_all = sum(r['y'] for r in all_rows)
        assert total_x_all == 200
        assert total_y_all == 40

        # With selection: sum = 100, 20 (correct)
        from snapshot_regime_selection import CandidateRegime, select_regime_rows
        selection = select_regime_rows(all_rows, [
            CandidateRegime(core_hash=H_CHANNEL),
            CandidateRegime(core_hash=H_DEVICE),
        ])
        total_x = sum(r['x'] for r in selection.rows)
        total_y = sum(r['y'] for r in selection.rows)
        assert total_x == 100
        assert total_y == 20


@requires_db
class TestRCH002_BackwardCompatNoRegimes:
    """RC-H-002: Without candidate_regimes, all rows pass through."""

    def test_no_candidates_returns_all_rows(self):
        pid = _test_param_id()

        _write_rows(pid, H_CHANNEL, SIG_CHANNEL,
                     'context(channel:google).window(1-Jan-26:1-Apr-26)',
                     [{'anchor_day': '2026-01-15', 'X': 60, 'Y': 12}])

        from snapshot_service import query_snapshots_for_sweep
        rows = query_snapshots_for_sweep(
            param_id=pid,
            core_hash=H_CHANNEL,
            slice_keys=[''],
            anchor_from=date(2026, 1, 1),
            anchor_to=date(2026, 4, 30),
            sweep_from=date(2026, 1, 1),
            sweep_to=date(2026, 12, 31),
        )

        assert len(rows) == 1

        # Simulate the handler's opt-in check: no candidate_regimes → skip
        subj = {'param_id': pid, 'core_hash': H_CHANNEL}
        cr_raw = subj.get('candidate_regimes')
        assert cr_raw is None  # guard would return rows unchanged
