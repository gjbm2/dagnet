"""
FE-Supplied Closure Consumption Tests (FC-001 through FC-010)

Tests that the backend correctly uses FE-supplied equivalent_hashes
(closure sets). The signature_equivalence table has been dropped;
equivalence is now entirely FE-owned via hash-mappings.json.

Run with: pytest lib/tests/test_fe_closure_consumption.py -v
"""

import pytest
import sys
import os

# Add lib directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, datetime, timezone
from dotenv import load_dotenv

# Load DB_CONNECTION for integration tests (local dev / CI secrets).
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))
from snapshot_service import (
    append_snapshots,
    query_snapshots,
    query_snapshot_retrievals,
    batch_anchor_coverage,
    get_batch_inventory_v2,
    get_db_connection,
    short_core_hash_from_canonical_signature,
)

# Skip all tests if DB_CONNECTION not available
pytestmark = pytest.mark.skipif(
    not os.environ.get('DB_CONNECTION'),
    reason="DB_CONNECTION not configured"
)

# Test prefix for cleanup
TEST_PREFIX = 'pytest-fc-'

SIG_ALGO = "sig_v1_sha256_trunc128_b64url"
TEST_TIMESTAMP = datetime.now(timezone.utc)


def make_param_id(suffix: str) -> str:
    return f'{TEST_PREFIX}{suffix}'


def append_for_test(*, param_id: str, canonical_signature: str, slice_key: str, rows, retrieved_at=None):
    """Append test snapshot rows."""
    return append_snapshots(
        param_id=param_id,
        canonical_signature=canonical_signature,
        inputs_json={"schema": "pytest_fc_v1", "param_id": param_id},
        sig_algo=SIG_ALGO,
        slice_key=slice_key,
        retrieved_at=retrieved_at or TEST_TIMESTAMP,
        rows=rows,
    )


def make_rows(anchor_days):
    """Create minimal snapshot rows for a list of ISO date strings."""
    return [{'anchor_day': d, 'X': 100, 'Y': 10} for d in anchor_days]


def cleanup_test_data():
    """Delete all test data with our prefix."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        conn.commit()
        conn.close()
    except Exception:
        pass


@pytest.fixture(scope='module', autouse=True)
def setup_and_cleanup():
    """Clean up before and after all tests in this module."""
    cleanup_test_data()
    yield
    cleanup_test_data()


class TestFEClosureConsumption:
    """
    FC-001 through FC-010: FE-supplied closure sets are honoured by the backend.
    The signature_equivalence table has been dropped; equivalence is FE-owned.
    """

    # ── query_snapshots ──────────────────────────────────────────────────

    def test_fc001_query_snapshots_positive_expansion(self):
        """FC-001: query_snapshots with equivalent_hashes returns seed + equivalent rows.

        No DB equivalence links exist — expansion is purely from the FE-supplied list.
        """
        pid = make_param_id('fc001')
        sig_a = '{"c":"fc001-a","x":{}}'
        sig_b = '{"c":"fc001-b","x":{}}'
        sig_c = '{"c":"fc001-c","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)
        ch_c = short_core_hash_from_canonical_signature(sig_c)

        # Insert rows for all three hashes
        append_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:3-Dec-25)',
                        rows=make_rows(['2025-12-01', '2025-12-02', '2025-12-03']))
        append_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(1-Dec-25:3-Dec-25)',
                        rows=make_rows(['2025-12-01', '2025-12-02']))
        append_for_test(param_id=pid, canonical_signature=sig_c, slice_key='window(1-Dec-25:3-Dec-25)',
                        rows=make_rows(['2025-12-03']))

        # NO DB equivalence links created.

        # Query with FE-supplied closure: seed=A, equivalents=[B, C]
        rows = query_snapshots(
            param_id=pid,
            core_hash=ch_a,
            equivalent_hashes=[
                {'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0},
                {'core_hash': ch_c, 'operation': 'equivalent', 'weight': 1.0},
            ],
        )

        returned_hashes = {r['core_hash'] for r in rows}
        assert ch_a in returned_hashes, f"Seed hash {ch_a} missing from results"
        assert ch_b in returned_hashes, f"Equivalent hash {ch_b} missing from results"
        assert ch_c in returned_hashes, f"Equivalent hash {ch_c} missing from results"
        # Total: 3 (A) + 2 (B) + 1 (C) = 6 rows
        assert len(rows) == 6

    def test_fc002_query_snapshots_no_expansion_without_closure(self):
        """FC-002: query_snapshots WITHOUT equivalent_hashes returns only seed hash rows.

        Same data as FC-001, but no closure provided (no equivalent_hashes = seed only).
        """
        pid = make_param_id('fc001')  # Reuse FC-001 data
        sig_a = '{"c":"fc001-a","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)

        rows = query_snapshots(
            param_id=pid,
            core_hash=ch_a,
        )

        returned_hashes = {r['core_hash'] for r in rows}
        assert returned_hashes == {ch_a}, f"Expected only seed hash, got {returned_hashes}"
        assert len(rows) == 3  # Only A's 3 rows

    def test_fc003_query_snapshots_empty_closure_no_expansion(self):
        """FC-003: query_snapshots with empty equivalent_hashes list = no expansion."""
        pid = make_param_id('fc001')  # Reuse FC-001 data
        sig_a = '{"c":"fc001-a","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)

        rows = query_snapshots(
            param_id=pid,
            core_hash=ch_a,
            equivalent_hashes=[],  # Empty list = no expansion
        )

        returned_hashes = {r['core_hash'] for r in rows}
        assert returned_hashes == {ch_a}
        assert len(rows) == 3

    # ── query_snapshot_retrievals ─────────────────────────────────────────

    def test_fc004_retrievals_positive_expansion(self):
        """FC-004: query_snapshot_retrievals with equivalent_hashes returns timestamps for seed + equivalents."""
        pid = make_param_id('fc001')
        sig_a = '{"c":"fc001-a","x":{}}'
        sig_b = '{"c":"fc001-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        result = query_snapshot_retrievals(
            param_id=pid,
            core_hash=ch_a,
            equivalent_hashes=[
                {'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0},
            ],
        )

        assert result['success'] is True
        assert result['count'] >= 1  # At least one retrieval timestamp

    def test_fc005_retrievals_no_expansion_without_closure(self):
        """FC-005: query_snapshot_retrievals without equivalent_hashes = seed only."""
        pid = make_param_id('fc001')
        sig_a = '{"c":"fc001-a","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)

        result = query_snapshot_retrievals(
            param_id=pid,
            core_hash=ch_a,
        )

        assert result['success'] is True
        assert result['count'] >= 1

    # ── batch_anchor_coverage ────────────────────────────────────────────

    def test_fc006_bac_positive_expansion(self):
        """FC-006: batch_anchor_coverage with equivalent_hashes covers days from seed + equivalents."""
        pid = make_param_id('fc006')
        sig_a = '{"c":"fc006-a","x":{}}'
        sig_b = '{"c":"fc006-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        # A covers Dec 1-2, B covers Dec 3-4
        append_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:4-Dec-25)',
                        rows=make_rows(['2025-12-01', '2025-12-02']))
        append_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(1-Dec-25:4-Dec-25)',
                        rows=make_rows(['2025-12-03', '2025-12-04']))

        # Without closure: A alone misses Dec 3-4
        results_no_closure = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 4),
        }])
        assert results_no_closure[0]['coverage_ok'] is False
        assert results_no_closure[0]['present_anchor_day_count'] == 2

        # With FE-supplied closure: A + B covers Dec 1-4
        results_with_closure = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 4),
            'equivalent_hashes': [
                {'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0},
            ],
        }])
        assert results_with_closure[0]['coverage_ok'] is True
        assert results_with_closure[0]['present_anchor_day_count'] == 4

    def test_fc007_bac_no_param_id_scoping(self):
        """FC-007: batch_anchor_coverage with equivalent_hashes uses core_hash-only scoping.

        Data is inserted under different param_ids — the query should still find it
        because the read contract is core_hash-scoped (not param_id-scoped).
        """
        pid_a = make_param_id('fc007-a')
        pid_b = make_param_id('fc007-b')
        sig_a = '{"c":"fc007-a","x":{}}'
        sig_b = '{"c":"fc007-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        # A under pid_a, B under pid_b (different params)
        append_for_test(param_id=pid_a, canonical_signature=sig_a, slice_key='window(1-Dec-25:2-Dec-25)',
                        rows=make_rows(['2025-12-01']))
        append_for_test(param_id=pid_b, canonical_signature=sig_b, slice_key='window(1-Dec-25:2-Dec-25)',
                        rows=make_rows(['2025-12-02']))

        # Query from pid_a with closure including B — should find B's data even though it's under pid_b
        results = batch_anchor_coverage([{
            'param_id': pid_a,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 2),
            'equivalent_hashes': [
                {'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0},
            ],
        }])
        assert results[0]['coverage_ok'] is True
        assert results[0]['present_anchor_day_count'] == 2

    # ── get_batch_inventory_v2 ───────────────────────────────────────────

    def test_fc008_inventory_fe_edges_group_families(self):
        """FC-008: get_batch_inventory_v2 with equivalent_hashes_by_param groups hashes into families."""
        pid = make_param_id('fc008')
        sig_a = '{"c":"fc008-a","x":{}}'
        sig_b = '{"c":"fc008-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        append_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:1-Dec-25)',
                        rows=make_rows(['2025-12-01']))
        append_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(1-Dec-25:1-Dec-25)',
                        rows=make_rows(['2025-12-01']))

        # Without FE edges: A and B are separate families
        inv_no_closure = get_batch_inventory_v2(
            param_ids=[pid],
            current_core_hashes={pid: ch_a},
        )
        families_no = inv_no_closure[pid]['families']
        # Each hash should be its own family (or unlinked)
        family_sizes_no = [f['family_size'] for f in families_no]
        assert all(s == 1 for s in family_sizes_no), f"Without closure, families should be singletons: {family_sizes_no}"

        # With FE edges: A and B should be in the same family
        inv_with_closure = get_batch_inventory_v2(
            param_ids=[pid],
            current_core_hashes={pid: ch_a},
            equivalent_hashes_by_param={
                pid: [{'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0}],
            },
        )
        families_with = inv_with_closure[pid]['families']
        # Should be a single family containing both hashes
        all_members = set()
        for f in families_with:
            all_members.update(f['member_core_hashes'])
        assert ch_a in all_members, f"Seed hash {ch_a} missing from family members"
        assert ch_b in all_members, f"Equivalent hash {ch_b} missing from family members"

    # fc009 removed: tested DB bypass which is moot now that the
    # signature_equivalence table has been dropped.

    def test_fc010_cross_param_expansion_works(self):
        """FC-010: FE-supplied closure works across param_id boundaries.

        Data for hash A is under param_a, data for hash B is under param_b.
        query_snapshots from param_a with equivalent_hashes=[B] should
        return rows for both A and B (because the read contract is core_hash-scoped).
        """
        pid_a = make_param_id('fc010-a')
        pid_b = make_param_id('fc010-b')
        sig_a = '{"c":"fc010-a","x":{}}'
        sig_b = '{"c":"fc010-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        append_for_test(param_id=pid_a, canonical_signature=sig_a, slice_key='window(1-Dec-25:1-Dec-25)',
                        rows=make_rows(['2025-12-01']))
        append_for_test(param_id=pid_b, canonical_signature=sig_b, slice_key='window(1-Dec-25:1-Dec-25)',
                        rows=make_rows(['2025-12-01']))

        rows = query_snapshots(
            param_id=pid_a,
            core_hash=ch_a,
            equivalent_hashes=[
                {'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0},
            ],
        )

        returned_hashes = {r['core_hash'] for r in rows}
        assert ch_a in returned_hashes
        assert ch_b in returned_hashes
        assert len(rows) == 2


class TestRegressionGuards:
    """
    Regression tests to prevent reintroduction of removed patterns.
    """

    def test_rg001_bac_parity_with_query_snapshots(self):
        """RG-001: batch_anchor_coverage cannot return coverage_ok=true when
        query_snapshots would return zero rows for the same subject.

        This guards against reintroducing param_id-based scoping in what should
        be a core_hash-scoped query (the bug that existed before this migration).
        """
        pid_a = make_param_id('rg001-a')
        pid_b = make_param_id('rg001-b')
        sig_a = '{"c":"rg001-a","x":{}}'
        sig_b = '{"c":"rg001-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        # Data for A under pid_a, data for B under pid_b
        append_for_test(param_id=pid_a, canonical_signature=sig_a, slice_key='window(1-Dec-25:2-Dec-25)',
                        rows=make_rows(['2025-12-01']))
        append_for_test(param_id=pid_b, canonical_signature=sig_b, slice_key='window(1-Dec-25:2-Dec-25)',
                        rows=make_rows(['2025-12-02']))

        closure = [{'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0}]

        # query_snapshots with closure should return rows for both hashes
        qs_rows = query_snapshots(
            param_id=pid_a,
            core_hash=ch_a,
            equivalent_hashes=closure,
        )
        qs_hashes = {r['core_hash'] for r in qs_rows}
        assert ch_a in qs_hashes and ch_b in qs_hashes, \
            f"query_snapshots must return both hashes; got {qs_hashes}"

        # batch_anchor_coverage with same closure must agree
        bac_results = batch_anchor_coverage([{
            'param_id': pid_a,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 2),
            'equivalent_hashes': closure,
        }])
        assert bac_results[0]['coverage_ok'] is True, \
            "batch_anchor_coverage must agree with query_snapshots when using same closure"
        assert bac_results[0]['present_anchor_day_count'] == 2

    def test_rg002_no_signature_equivalence_in_production_code(self):
        """RG-002: production Python code must not reference 'signature_equivalence' table.

        The signature_equivalence table has been dropped. Equivalence is now
        entirely FE-owned via hash-mappings.json. This test fails if any
        production .py file in lib/ still references the table.
        """
        import re
        from pathlib import Path

        lib_dir = Path(__file__).parent.parent
        violations = []

        for py_file in lib_dir.rglob('*.py'):
            rel = py_file.relative_to(lib_dir)
            parts = rel.parts
            # Skip test and tool directories — they're not production code.
            if any(p in ('tests', 'tools', '__pycache__') for p in parts):
                continue
            try:
                source = py_file.read_text(encoding='utf-8')
            except Exception:
                continue

            for i, line in enumerate(source.splitlines(), start=1):
                stripped = line.strip()
                if not stripped or stripped.startswith('#'):
                    continue
                if 'signature_equivalence' in stripped:
                    violations.append(f'{rel}:{i}: {stripped}')

        if violations:
            msg = 'Production code still references signature_equivalence table:\n'
            msg += '\n'.join(f'  {v}' for v in violations)
            assert False, msg
