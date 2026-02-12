"""
Batch Anchor Coverage Integration Tests (BC-001 through BC-012)

Tests for the batch_anchor_coverage function used by Retrieve All DB preflight.
Verifies missing anchor-day range detection, equivalence closure, slice-key
scoping, and mode separation against the real snapshot database.

Run with: pytest lib/tests/test_batch_anchor_coverage.py -v
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
    batch_anchor_coverage,
    query_snapshots,
    get_db_connection,
    short_core_hash_from_canonical_signature,
)

# Test-only DB helper (production function removed in hash-mappings migration).
def create_equivalence_link(*, param_id, core_hash, equivalent_to, created_by, reason,
                            operation='equivalent', weight=1.0, source_param_id=None):
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO signature_equivalence
               (param_id, core_hash, equivalent_to, created_by, reason, active, operation, weight, source_param_id)
               VALUES (%s,%s,%s,%s,%s,true,%s,%s,%s)
               ON CONFLICT (param_id, core_hash, equivalent_to)
               DO UPDATE SET active=true, reason=EXCLUDED.reason, created_by=EXCLUDED.created_by,
                             operation=EXCLUDED.operation, weight=EXCLUDED.weight, source_param_id=EXCLUDED.source_param_id""",
            (param_id, core_hash, equivalent_to, created_by, reason, operation, weight, source_param_id))
        conn.commit()
        return {"success": True}
    except Exception as e:
        conn.rollback()
        return {"success": False, "error": str(e)}
    finally:
        conn.close()

# Skip all tests if DB_CONNECTION not available
pytestmark = pytest.mark.skipif(
    not os.environ.get('DB_CONNECTION'),
    reason="DB_CONNECTION not configured"
)

# Test prefix for cleanup
TEST_PREFIX = 'pytest-bac-'

SIG_ALGO = "sig_v1_sha256_trunc128_b64url"
TEST_TIMESTAMP = datetime.now(timezone.utc)


def append_snapshots_for_test(*, param_id: str, canonical_signature: str, slice_key: str, rows, retrieved_at=None):
    """Test helper: append snapshots using the flexi-sigs write contract."""
    return append_snapshots(
        param_id=param_id,
        canonical_signature=canonical_signature,
        inputs_json={
            "schema": "pytest_bac_v1",
            "param_id": param_id,
            "canonical_signature": canonical_signature,
        },
        sig_algo=SIG_ALGO,
        slice_key=slice_key,
        retrieved_at=retrieved_at or TEST_TIMESTAMP,
        rows=rows,
    )


def make_rows(anchor_days):
    """Create minimal snapshot rows for a list of ISO date strings."""
    return [{'anchor_day': d, 'X': 100, 'Y': 10} for d in anchor_days]


def present_anchor_days_via_query_snapshots(*, param_id: str, core_hash: str, slice_keys, anchor_from: date, anchor_to: date, include_equivalents: bool = False, equivalent_hashes=None) -> set:
    """
    Parity oracle: query snapshot rows using the canonical read helper and return
    the set of anchor_day values present.
    """
    rows = query_snapshots(
        param_id=param_id,
        core_hash=core_hash,
        slice_keys=slice_keys,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        equivalent_hashes=equivalent_hashes,
        limit=100000,
    )
    out = set()
    for r in rows:
        d = r.get('anchor_day')
        if d:
            out.add(str(d))
    return out


def make_param_id(name):
    return f'{TEST_PREFIX}{name}'


def cleanup_test_data():
    """Delete all test data with our prefix."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_equivalence WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
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


class TestBatchAnchorCoverage:
    """BC-001 through BC-012: Batch anchor coverage tests."""

    @pytest.fixture(autouse=True)
    def per_test_cleanup(self):
        """Clean up test data before each test."""
        cleanup_test_data()
        yield
        cleanup_test_data()

    def test_bc001_complete_contiguous_window(self):
        """BC-001: All anchor days present → coverage_ok, no missing ranges."""
        pid = make_param_id('bc001')
        sig = '{"c":"bc001","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        days = ['2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04', '2025-12-05']
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(1-Dec-25:5-Dec-25)', rows=make_rows(days))

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])

        assert len(results) == 1
        r = results[0]
        assert r['coverage_ok'] is True
        assert r['missing_anchor_ranges'] == []
        assert r['present_anchor_day_count'] == 5
        assert r['expected_anchor_day_count'] == 5

    def test_bc002_missing_prefix(self):
        """BC-002: Missing days at start → one missing range at prefix."""
        pid = make_param_id('bc002')
        sig = '{"c":"bc002","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        days = ['2025-12-03', '2025-12-04', '2025-12-05']
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(3-Dec-25:5-Dec-25)', rows=make_rows(days))

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])

        r = results[0]
        assert r['coverage_ok'] is False
        assert len(r['missing_anchor_ranges']) == 1
        assert r['missing_anchor_ranges'][0] == {'start': '2025-12-01', 'end': '2025-12-02'}

    def test_bc003_missing_suffix(self):
        """BC-003: Missing days at end → one missing range at suffix."""
        pid = make_param_id('bc003')
        sig = '{"c":"bc003","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        days = ['2025-12-01', '2025-12-02', '2025-12-03']
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(1-Dec-25:3-Dec-25)', rows=make_rows(days))

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])

        r = results[0]
        assert r['coverage_ok'] is False
        assert len(r['missing_anchor_ranges']) == 1
        assert r['missing_anchor_ranges'][0] == {'start': '2025-12-04', 'end': '2025-12-05'}

    def test_bc004_internal_gaps(self):
        """BC-004: Two internal gaps → two missing ranges."""
        pid = make_param_id('bc004')
        sig = '{"c":"bc004","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        # Present: 1, 2, 5, 8, 9, 10. Missing: 3-4, 6-7
        days = ['2025-12-01', '2025-12-02', '2025-12-05', '2025-12-08', '2025-12-09', '2025-12-10']
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(1-Dec-25:10-Dec-25)', rows=make_rows(days))

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 10),

        }])

        r = results[0]
        assert r['coverage_ok'] is False
        assert len(r['missing_anchor_ranges']) == 2
        assert r['missing_anchor_ranges'][0] == {'start': '2025-12-03', 'end': '2025-12-04'}
        assert r['missing_anchor_ranges'][1] == {'start': '2025-12-06', 'end': '2025-12-07'}

    def test_bc005_slice_key_scoping(self):
        """BC-005: Gaps in one slice key but not another; selector respects slice_keys."""
        pid = make_param_id('bc005')
        sig = '{"c":"bc005","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        all_days = ['2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04', '2025-12-05']
        partial_days = ['2025-12-01', '2025-12-02', '2025-12-03']

        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='context(channel:google).window(1-Dec-25:5-Dec-25)', rows=make_rows(all_days))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='context(channel:facebook).window(1-Dec-25:5-Dec-25)', rows=make_rows(partial_days))

        # Google: full coverage
        r_google = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['context(channel:google).window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])[0]
        assert r_google['coverage_ok'] is True

        # Facebook: missing 4-5
        r_fb = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['context(channel:facebook).window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])[0]
        assert r_fb['coverage_ok'] is False
        assert r_fb['missing_anchor_ranges'] == [{'start': '2025-12-04', 'end': '2025-12-05'}]

    def test_bc006_equivalence_closure_covers_gaps(self):
        """BC-006: Current hash missing days, but equivalent hash fills them → coverage_ok."""
        pid = make_param_id('bc006')
        sig_a = '{"c":"bc006-a","x":{}}'
        sig_b = '{"c":"bc006-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        # Hash A: days 1-3
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:5-Dec-25)', rows=make_rows(['2025-12-01', '2025-12-02', '2025-12-03']))
        # Hash B: days 4-5
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(4-Dec-25:5-Dec-25)', rows=make_rows(['2025-12-04', '2025-12-05']))

        # Create equivalence link A ≡ B
        create_equivalence_link(param_id=pid, core_hash=ch_a, equivalent_to=ch_b, created_by='pytest', reason='bc006 test')

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),
            'equivalent_hashes': [{'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0}],
        }])

        r = results[0]
        assert r['coverage_ok'] is True
        assert r['present_anchor_day_count'] == 5
        # Verify closure includes both hashes
        assert ch_a in r['equivalence_resolution']['core_hashes']
        assert ch_b in r['equivalence_resolution']['core_hashes']

    def test_bc007_equivalence_closure_partial_gaps(self):
        """BC-007: Equivalence closure partially covers; remaining gaps reported."""
        pid = make_param_id('bc007')
        sig_a = '{"c":"bc007-a","x":{}}'
        sig_b = '{"c":"bc007-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        # Hash A: days 1-3
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:5-Dec-25)', rows=make_rows(['2025-12-01', '2025-12-02', '2025-12-03']))
        # Hash B: day 5 only (day 4 missing across closure)
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(5-Dec-25:5-Dec-25)', rows=make_rows(['2025-12-05']))

        create_equivalence_link(param_id=pid, core_hash=ch_a, equivalent_to=ch_b, created_by='pytest', reason='bc007 test')

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),
            'equivalent_hashes': [{'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0}],
        }])

        r = results[0]
        assert r['coverage_ok'] is False
        assert r['missing_anchor_ranges'] == [{'start': '2025-12-04', 'end': '2025-12-04'}]

    def test_bc008_multi_hop_closure(self):
        """BC-008: Three hashes A↔B, B↔C — transitive closure covers full window."""
        pid = make_param_id('bc008')
        sig_a = '{"c":"bc008-a","x":{}}'
        sig_b = '{"c":"bc008-b","x":{}}'
        sig_c = '{"c":"bc008-c","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)
        ch_c = short_core_hash_from_canonical_signature(sig_c)

        # A: days 1-2, B: day 3, C: days 4-5
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:5-Dec-25)', rows=make_rows(['2025-12-01', '2025-12-02']))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(3-Dec-25:3-Dec-25)', rows=make_rows(['2025-12-03']))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_c, slice_key='window(4-Dec-25:5-Dec-25)', rows=make_rows(['2025-12-04', '2025-12-05']))

        # A↔B, B↔C
        create_equivalence_link(param_id=pid, core_hash=ch_a, equivalent_to=ch_b, created_by='pytest', reason='bc008 A-B')
        create_equivalence_link(param_id=pid, core_hash=ch_b, equivalent_to=ch_c, created_by='pytest', reason='bc008 B-C')

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),
            'equivalent_hashes': [
                {'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0},
                {'core_hash': ch_c, 'operation': 'equivalent', 'weight': 1.0},
            ],
        }])

        r = results[0]
        assert r['coverage_ok'] is True
        assert r['present_anchor_day_count'] == 5

    def test_bc009_window_vs_cohort_mode_separation(self):
        """BC-009: window() and cohort() slices have separate coverage."""
        pid = make_param_id('bc009')
        sig = '{"c":"bc009","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        all_days = ['2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04', '2025-12-05']
        partial_days = ['2025-12-01', '2025-12-02', '2025-12-03']

        # window() has all 5 days; cohort() has only 3
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(1-Dec-25:5-Dec-25)', rows=make_rows(all_days))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='cohort(1-Dec-25:5-Dec-25)', rows=make_rows(partial_days))

        # window() → full coverage
        r_win = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])[0]
        assert r_win['coverage_ok'] is True

        # cohort() → missing 4-5
        r_coh = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['cohort()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])[0]
        assert r_coh['coverage_ok'] is False
        assert r_coh['missing_anchor_ranges'] == [{'start': '2025-12-04', 'end': '2025-12-05'}]

    def test_bc010_equivalence_diagnostics(self):
        """BC-010: equivalence_resolution field contains correct hashes and param_ids."""
        pid = make_param_id('bc010')
        sig_a = '{"c":"bc010-a","x":{}}'
        sig_b = '{"c":"bc010-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(param_id=pid, canonical_signature=sig_a, slice_key='window(1-Dec-25:1-Dec-25)', rows=make_rows(['2025-12-01']))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(2-Dec-25:2-Dec-25)', rows=make_rows(['2025-12-02']))
        create_equivalence_link(param_id=pid, core_hash=ch_a, equivalent_to=ch_b, created_by='pytest', reason='bc010 test')

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 2),
            'equivalent_hashes': [{'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0}],
        }])

        r = results[0]
        eq_res = r['equivalence_resolution']
        assert ch_a in eq_res['core_hashes']
        assert ch_b in eq_res['core_hashes']
        assert pid in eq_res['param_ids']

    def test_bc011_empty_db_all_missing(self):
        """BC-011: No data at all → all days missing."""
        pid = make_param_id('bc011')
        # Don't insert anything

        results = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': 'nonexistent-hash',
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])

        r = results[0]
        assert r['coverage_ok'] is False
        assert r['present_anchor_day_count'] == 0
        assert r['expected_anchor_day_count'] == 5
        assert len(r['missing_anchor_ranges']) == 1
        assert r['missing_anchor_ranges'][0] == {'start': '2025-12-01', 'end': '2025-12-05'}

    def test_bc012_batch_multiple_subjects(self):
        """BC-012: Two subjects in one batch, each with different coverage."""
        pid1 = make_param_id('bc012-s1')
        pid2 = make_param_id('bc012-s2')
        sig1 = '{"c":"bc012-s1","x":{}}'
        sig2 = '{"c":"bc012-s2","x":{}}'
        ch1 = short_core_hash_from_canonical_signature(sig1)
        ch2 = short_core_hash_from_canonical_signature(sig2)

        # Subject 1: full coverage
        append_snapshots_for_test(param_id=pid1, canonical_signature=sig1, slice_key='window(1-Dec-25:3-Dec-25)',
                                  rows=make_rows(['2025-12-01', '2025-12-02', '2025-12-03']))
        # Subject 2: missing day 2
        append_snapshots_for_test(param_id=pid2, canonical_signature=sig2, slice_key='window(1-Dec-25:3-Dec-25)',
                                  rows=make_rows(['2025-12-01', '2025-12-03']))

        results = batch_anchor_coverage([
            {
                'param_id': pid1,
                'core_hash': ch1,
                'slice_keys': ['window()'],
                'anchor_from': date(2025, 12, 1),
                'anchor_to': date(2025, 12, 3),
    
            },
            {
                'param_id': pid2,
                'core_hash': ch2,
                'slice_keys': ['window()'],
                'anchor_from': date(2025, 12, 1),
                'anchor_to': date(2025, 12, 3),
    
            },
        ])

        assert len(results) == 2

        r1 = results[0]
        assert r1['subject_index'] == 0
        assert r1['coverage_ok'] is True

        r2 = results[1]
        assert r2['subject_index'] == 1
        assert r2['coverage_ok'] is False
        assert r2['missing_anchor_ranges'] == [{'start': '2025-12-02', 'end': '2025-12-02'}]

    # ======================================================================
    # False-negative comfort tests (FN-001+)
    # These aim to catch cases where coverage returns "missing" but the DB
    # actually has the data (slice-key normalisation, equivalence closure, etc.)
    # ======================================================================

    def test_fn001_slice_key_args_variants_same_family_union(self):
        """
        FN-001: Slice-key args vary across writes (window(…)) but family is the same.
        Coverage query using window() must see ALL anchor days across variants.
        """
        pid = make_param_id('fn001')
        sig = '{"c":"fn001","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        # Same logical family, two different argument strings.
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(1-Dec-25:3-Dec-25)',
                                  rows=make_rows(['2025-12-01', '2025-12-02']))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='window(2-Dec-25:5-Dec-25)',
                                  rows=make_rows(['2025-12-03', '2025-12-04', '2025-12-05']))

        res = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])[0]

        assert res['coverage_ok'] is True
        assert res['missing_anchor_ranges'] == []

        # Parity check with canonical read helper
        present = present_anchor_days_via_query_snapshots(
            param_id=pid, core_hash=ch, slice_keys=['window()'],
            anchor_from=date(2025, 12, 1), anchor_to=date(2025, 12, 5),

        )
        assert present == {'2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04', '2025-12-05'}

    def test_fn002_contexted_slice_key_args_variants_same_family_union(self):
        """
        FN-002: Contexted slice-key args vary across writes but family is the same.
        Coverage query using context(...).window() must see ALL anchor days across variants.
        """
        pid = make_param_id('fn002')
        sig = '{"c":"fn002","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='context(channel:google).window(1-Dec-25:3-Dec-25)',
                                  rows=make_rows(['2025-12-01', '2025-12-02']))
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='context(channel:google).window(2-Dec-25:5-Dec-25)',
                                  rows=make_rows(['2025-12-03', '2025-12-04', '2025-12-05']))

        res = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': ['context(channel:google).window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 5),

        }])[0]

        assert res['coverage_ok'] is True
        assert res['missing_anchor_ranges'] == []

        present = present_anchor_days_via_query_snapshots(
            param_id=pid, core_hash=ch, slice_keys=['context(channel:google).window()'],
            anchor_from=date(2025, 12, 1), anchor_to=date(2025, 12, 5),

        )
        assert present == {'2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04', '2025-12-05'}

    def test_fn003_include_equivalents_toggle_matches_read_path(self):
        """
        FN-003: Data exists only under an equivalent hash.
        - Without equivalent_hashes: should report missing (no false positive)
        - With equivalent_hashes: should report covered (no false negative)
        Also asserts parity with query_snapshots() behaviour.
        """
        pid = make_param_id('fn003')
        sig_a = '{"c":"fn003-a","x":{}}'
        sig_b = '{"c":"fn003-b","x":{}}'
        ch_a = short_core_hash_from_canonical_signature(sig_a)
        ch_b = short_core_hash_from_canonical_signature(sig_b)

        # Only hash B has the data.
        append_snapshots_for_test(param_id=pid, canonical_signature=sig_b, slice_key='window(1-Dec-25:3-Dec-25)',
                                  rows=make_rows(['2025-12-01', '2025-12-02', '2025-12-03']))
        create_equivalence_link(param_id=pid, core_hash=ch_a, equivalent_to=ch_b, created_by='pytest', reason='fn003 test')

        eq_hashes = [{'core_hash': ch_b, 'operation': 'equivalent', 'weight': 1.0}]

        # No equivalent_hashes → missing
        r_no = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 3),
        }])[0]
        assert r_no['coverage_ok'] is False
        assert r_no['missing_anchor_ranges'] == [{'start': '2025-12-01', 'end': '2025-12-03'}]

        present_no = present_anchor_days_via_query_snapshots(
            param_id=pid, core_hash=ch_a, slice_keys=['window()'],
            anchor_from=date(2025, 12, 1), anchor_to=date(2025, 12, 3),
        )
        assert present_no == set()

        # With equivalent_hashes → covered
        r_yes = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch_a,
            'slice_keys': ['window()'],
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 3),
            'equivalent_hashes': eq_hashes,
        }])[0]
        assert r_yes['coverage_ok'] is True
        assert r_yes['missing_anchor_ranges'] == []

        present_yes = present_anchor_days_via_query_snapshots(
            param_id=pid, core_hash=ch_a, slice_keys=['window()'],
            anchor_from=date(2025, 12, 1), anchor_to=date(2025, 12, 3),
            equivalent_hashes=eq_hashes,
        )
        assert present_yes == {'2025-12-01', '2025-12-02', '2025-12-03'}

    def test_fn004_broad_slice_selector_empty_string_matches_all_slices(self):
        """
        FN-004: Back-compat broad selector [''] should not filter slices.
        If the DB has data under ANY slice family, coverage should see it.
        """
        pid = make_param_id('fn004')
        sig = '{"c":"fn004","x":{}}'
        ch = short_core_hash_from_canonical_signature(sig)

        # Insert only a contexted slice.
        append_snapshots_for_test(param_id=pid, canonical_signature=sig, slice_key='context(channel:google).window(1-Dec-25:2-Dec-25)',
                                  rows=make_rows(['2025-12-01', '2025-12-02']))

        res = batch_anchor_coverage([{
            'param_id': pid,
            'core_hash': ch,
            'slice_keys': [''],  # broad
            'anchor_from': date(2025, 12, 1),
            'anchor_to': date(2025, 12, 2),

        }])[0]

        assert res['coverage_ok'] is True
        assert res['missing_anchor_ranges'] == []

        present = present_anchor_days_via_query_snapshots(
            param_id=pid, core_hash=ch, slice_keys=[''],
            anchor_from=date(2025, 12, 1), anchor_to=date(2025, 12, 2),

        )
        assert present == {'2025-12-01', '2025-12-02'}
