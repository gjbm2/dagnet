"""
asat() contract — blind integration tests (doc 42).

Tests the asat evidence filtering contract end-to-end through the
snapshot DB layer. Written from doc 42 specification, not from
implementation code.

Invariant IDs match doc 42 §12.

Setup: writes snapshot rows at multiple retrieval dates, then queries
with different as_at values to verify epistemic filtering.

Requires: DB_CONNECTION in environment (skipped otherwise).
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, datetime, timedelta
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))
from snapshot_service import (
    query_virtual_snapshot,
    append_snapshots,
    get_db_connection,
    short_core_hash_from_canonical_signature,
)

pytestmark = pytest.mark.skipif(
    not os.environ.get('DB_CONNECTION'),
    reason="DB_CONNECTION not configured"
)

TEST_PREFIX = 'pytest-asat-'
SIG_ALGO = "sig_v1_sha256_trunc128_b64url"


def _append(*, param_id, canonical_signature, slice_key, retrieved_at, rows):
    return append_snapshots(
        param_id=param_id,
        canonical_signature=canonical_signature,
        inputs_json={
            "schema": "pytest_asat_v1",
            "param_id": param_id,
            "canonical_signature": canonical_signature,
        },
        sig_algo=SIG_ALGO,
        slice_key=slice_key,
        retrieved_at=retrieved_at,
        rows=rows,
    )


def _cleanup():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s",
                    (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s",
                    (f'{TEST_PREFIX}%',))
        conn.commit()
        conn.close()
    except Exception:
        pass


@pytest.fixture(scope='module', autouse=True)
def setup_and_cleanup():
    _cleanup()
    yield
    _cleanup()


# ══════════════════════════════════════════════════════════════════════════════
# A. Evidence filtering (doc 42 §12.A)
#
# Core asat contract: "no evidence with retrieved_at > evidence_cutoff_date
# may contribute to the query result."
# ══════════════════════════════════════════════════════════════════════════════

class TestAsatEvidenceFiltering:
    """
    Scenario: snapshots for the same param/edge retrieved at three different
    dates. The data CHANGES between retrievals (counts increase as cohorts
    mature). asat queries at different points should see different data.

    Timeline:
      t1 = 10-Oct-25: first retrieval (immature data)
      t2 = 20-Oct-25: second retrieval (more mature data)
      t3 = 1-Nov-25:  third retrieval (fully mature data)

    Anchor days: 1-Oct through 5-Oct (same cohorts observed at different
    maturity points).
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        self.param_id = f'{TEST_PREFIX}evidence-filter'
        self.sig = '{"c":"pytest-asat-evidence","x":{}}'
        self.core_hash = short_core_hash_from_canonical_signature(self.sig)

        # t1: immature observation
        _append(
            param_id=self.param_id,
            canonical_signature=self.sig,
            slice_key='window()',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 100, 'Y': 5},
                {'anchor_day': '2025-10-02', 'X': 110, 'Y': 6},
                {'anchor_day': '2025-10-03', 'X': 120, 'Y': 7},
            ],
        )

        # t2: more mature — same anchor days, higher Y
        _append(
            param_id=self.param_id,
            canonical_signature=self.sig,
            slice_key='window()',
            retrieved_at=datetime(2025, 10, 20, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 100, 'Y': 15},
                {'anchor_day': '2025-10-02', 'X': 110, 'Y': 18},
                {'anchor_day': '2025-10-03', 'X': 120, 'Y': 20},
            ],
        )

        # t3: fully mature — same anchor days, highest Y
        _append(
            param_id=self.param_id,
            canonical_signature=self.sig,
            slice_key='window()',
            retrieved_at=datetime(2025, 11, 1, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 100, 'Y': 25},
                {'anchor_day': '2025-10-02', 'X': 110, 'Y': 30},
                {'anchor_day': '2025-10-03', 'X': 120, 'Y': 35},
            ],
        )

        yield

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("DELETE FROM signature_registry WHERE param_id = %s",
                        (self.param_id,))
            cur.execute("DELETE FROM snapshots WHERE param_id = %s",
                        (self.param_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def test_A1_only_rows_before_cutoff_returned(self):
        """
        A1: asat at t1+5 days should return only t1 data.
        No row from t2 or t3 should appear.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 15, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 3),
            core_hash=self.core_hash,
        )

        assert result['success'], f"query failed: {result.get('error')}"
        rows = result['rows']
        assert len(rows) == 3

        # Y values should be the t1 (immature) values, not t2 or t3
        y_by_day = {str(r['anchor_day']): r['y'] for r in rows}
        assert y_by_day['2025-10-01'] == 5, f"expected t1 Y=5, got {y_by_day['2025-10-01']}"
        assert y_by_day['2025-10-02'] == 6
        assert y_by_day['2025-10-03'] == 7

    def test_A2_latest_per_anchor_day_as_of_cutoff(self):
        """
        A2: asat at t2+5 days should return t2 data (latest on or before
        cutoff), not t1 and not t3.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 25, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 3),
            core_hash=self.core_hash,
        )

        assert result['success']
        rows = result['rows']
        assert len(rows) == 3

        y_by_day = {str(r['anchor_day']): r['y'] for r in rows}
        assert y_by_day['2025-10-01'] == 15, f"expected t2 Y=15, got {y_by_day['2025-10-01']}"
        assert y_by_day['2025-10-02'] == 18
        assert y_by_day['2025-10-03'] == 20

    def test_A1_no_future_data_leaks(self):
        """
        A1 (strengthened): with asat before t1, no data should be returned.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 9, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 3),
            core_hash=self.core_hash,
        )

        assert result['success']
        assert len(result['rows']) == 0

    def test_A2_all_data_visible_after_last_retrieval(self):
        """
        A2 (completeness): with asat after t3, should see t3 data
        (latest available).
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 12, 1, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 3),
            core_hash=self.core_hash,
        )

        assert result['success']
        rows = result['rows']
        y_by_day = {str(r['anchor_day']): r['y'] for r in rows}
        assert y_by_day['2025-10-01'] == 25, f"expected t3 Y=25, got {y_by_day['2025-10-01']}"

    def test_A2_one_row_per_anchor_day(self):
        """
        A2: virtual snapshot returns at most one row per (anchor_day,
        slice_key) — the latest as-of the cutoff. No duplicates.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 12, 1, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 3),
            core_hash=self.core_hash,
        )

        assert result['success']
        anchor_days = [str(r['anchor_day']) for r in result['rows']]
        assert len(anchor_days) == len(set(anchor_days)), \
            f"duplicate anchor_days in virtual snapshot: {anchor_days}"


# ══════════════════════════════════════════════════════════════════════════════
# F. Signature exclusion (doc 42 §12.F)
#
# asat must NOT affect query identity. Same core_hash regardless of asat.
# ══════════════════════════════════════════════════════════════════════════════

class TestAsatSignatureExclusion:
    """
    Scenario: data stored under one core_hash. Querying with asat should
    find it using the same hash — asat doesn't change the hash.
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        self.param_id = f'{TEST_PREFIX}sig-exclusion'
        self.sig = '{"c":"pytest-asat-sig","x":{}}'
        self.core_hash = short_core_hash_from_canonical_signature(self.sig)

        _append(
            param_id=self.param_id,
            canonical_signature=self.sig,
            slice_key='window()',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )

        yield

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("DELETE FROM signature_registry WHERE param_id = %s",
                        (self.param_id,))
            cur.execute("DELETE FROM snapshots WHERE param_id = %s",
                        (self.param_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def test_F1_same_hash_retrieves_data(self):
        """
        F1: data stored under core_hash X is retrievable via the same
        hash when queried with asat. The hash is computed from the query
        WITHOUT asat — so the same hash works for live and asat queries.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 15, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            core_hash=self.core_hash,
        )

        assert result['success']
        assert len(result['rows']) == 1
        assert result['rows'][0]['y'] == 10


# ══════════════════════════════════════════════════════════════════════════════
# K. Metadata for warnings (doc 42 §12.K)
#
# Virtual snapshot response must include metadata that enables the
# warning policy.
# ══════════════════════════════════════════════════════════════════════════════

class TestAsatWarningMetadata:
    """
    Test that virtual snapshot response includes the metadata fields
    needed for warning policy (doc 42 §12.K).
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        self.param_id = f'{TEST_PREFIX}warn-meta'
        self.sig = '{"c":"pytest-asat-warn","x":{}}'
        self.core_hash = short_core_hash_from_canonical_signature(self.sig)

        _append(
            param_id=self.param_id,
            canonical_signature=self.sig,
            slice_key='window()',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 100, 'Y': 10},
                {'anchor_day': '2025-10-02', 'X': 110, 'Y': 12},
            ],
        )

        yield

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("DELETE FROM signature_registry WHERE param_id = %s",
                        (self.param_id,))
            cur.execute("DELETE FROM snapshots WHERE param_id = %s",
                        (self.param_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def test_K1_latest_retrieved_at_used_present(self):
        """
        K1: response includes latest_retrieved_at_used so the FE can
        compute freshness warnings.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 15, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=self.core_hash,
        )

        assert result['success']
        assert 'latest_retrieved_at_used' in result
        assert result['latest_retrieved_at_used'] is not None

    def test_K2_has_anchor_to_true_when_covered(self):
        """
        K2: has_anchor_to is true when anchor_to day is in the result.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 15, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=self.core_hash,
        )

        assert result['success']
        assert 'has_anchor_to' in result
        assert result['has_anchor_to'] is True

    def test_K2_has_anchor_to_false_when_not_covered(self):
        """
        K2: has_anchor_to is false when anchor_to day is NOT in the result.
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 15, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 5),  # no data for 5-Oct
            core_hash=self.core_hash,
        )

        assert result['success']
        assert result['has_anchor_to'] is False

    def test_K_no_data_before_first_retrieval(self):
        """
        K: when asat is before any retrieval, response indicates no data
        (not an error — absence is the true answer).
        """
        result = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 9, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=self.core_hash,
        )

        assert result['success']
        assert len(result['rows']) == 0
        assert result['latest_retrieved_at_used'] is None


# ══════════════════════════════════════════════════════════════════════════════
# G. Read-only (doc 42 §12.G)
#
# asat queries must not write to the snapshot DB. query_virtual_snapshot
# is a read path — but we verify it doesn't create side effects.
# ══════════════════════════════════════════════════════════════════════════════

class TestAsatReadOnly:
    """
    Verify that querying with asat doesn't modify DB state.
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        self.param_id = f'{TEST_PREFIX}read-only'
        self.sig = '{"c":"pytest-asat-ro","x":{}}'
        self.core_hash = short_core_hash_from_canonical_signature(self.sig)

        _append(
            param_id=self.param_id,
            canonical_signature=self.sig,
            slice_key='window()',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )

        yield

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("DELETE FROM signature_registry WHERE param_id = %s",
                        (self.param_id,))
            cur.execute("DELETE FROM snapshots WHERE param_id = %s",
                        (self.param_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def test_G_query_does_not_add_rows(self):
        """
        G: counting rows before and after a virtual snapshot query —
        the count must not change.
        """
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM snapshots WHERE param_id = %s",
                    (self.param_id,))
        count_before = cur.fetchone()[0]
        conn.close()

        # Run virtual snapshot query
        query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 15, 23, 59, 59),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            core_hash=self.core_hash,
        )

        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM snapshots WHERE param_id = %s",
                    (self.param_id,))
        count_after = cur.fetchone()[0]
        conn.close()

        assert count_before == count_after, \
            f"virtual snapshot query changed row count: {count_before} → {count_after}"
