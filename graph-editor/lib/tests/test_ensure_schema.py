"""
Unit tests for snapshot_service.ensure_schema (no DB required).

ensure_schema is the single source of truth for the snapshot DB schema and
must idempotently create BOTH tables plus every secondary index. Previously
the core ``snapshots`` table was created by no code path at all (and the
former ``_ensure_flexi_sig_tables`` helper, which only covered
``signature_registry``, was never called), so a fresh database could not
accept writes despite the README claiming auto-creation.

A fake cursor captures the SQL emitted so we can assert the full, idempotent
DDL without a live database.

Run with: pytest lib/tests/test_ensure_schema.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import snapshot_service


class _FakeCursor:
    """Records normalised SQL statements; performs no I/O."""

    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(" ".join(sql.split()))


def _emitted():
    cur = _FakeCursor()
    snapshot_service.ensure_schema(cur)
    return cur.statements


def test_creates_both_tables_and_is_idempotent():
    stmts = _emitted()
    assert any("CREATE TABLE IF NOT EXISTS snapshots" in s for s in stmts), \
        "ensure_schema must create the core snapshots table"
    assert any("CREATE TABLE IF NOT EXISTS signature_registry" in s for s in stmts), \
        "ensure_schema must create signature_registry"
    # Every statement must be safe to re-run against a provisioned DB.
    for s in stmts:
        assert "IF NOT EXISTS" in s, f"non-idempotent DDL would alter existing prod table: {s}"


def test_snapshots_columns_and_pk_match_production():
    snap = next(s for s in _emitted() if "CREATE TABLE IF NOT EXISTS snapshots" in s)
    for token in [
        "param_id", "core_hash", "context_def_hashes", "slice_key",
        "anchor_day", "retrieved_at",
        "A INTEGER", "X INTEGER", "Y INTEGER",
        "median_lag_days", "mean_lag_days", "anchor_median_lag_days",
        "anchor_mean_lag_days", "onset_delta_days", "write_inputs_json",
    ]:
        assert token in snap, f"snapshots DDL missing: {token}"
    assert "PRIMARY KEY (param_id, core_hash, slice_key, anchor_day, retrieved_at)" in snap


def test_all_secondary_indexes_present():
    joined = "\n".join(_emitted())
    # The two snapshots lookup indexes a code-derived DDL would have missed,
    # plus the signature_registry index.
    assert "idx_snapshots_lookup" in joined
    assert "idx_snapshots_core_hash_anchor" in joined
    assert "idx_sigreg_param_created" in joined
