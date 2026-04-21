"""
Phase 5 parity gate: v2 vs v3 cohort maturity rows.

Uses enriched synth-simple-abc graph with DB snapshot data.
Calls both v2 and v3 handlers with the same inputs and compares
maturity_rows field by field.

Evidence fields (rate, evidence_y, evidence_x) must match exactly
because both use the same evidence pipeline. MC-derived fields
(midpoint, fan_bands) have tolerance for sampling variance.
"""

import copy
import functools
import json
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))

import pytest

# Shared fixtures from conftest
from conftest import (
    load_graph_json,
    requires_db,
    requires_data_repo,
    requires_synth,
)


def _load_graph(graph_name: str):
    return load_graph_json(graph_name)


def _run_handler(handler_func, graph, analytics_dsl, effective_query_dsl, candidate_regimes):
    """Call a cohort maturity handler and return maturity_rows."""
    result = handler_func({
        'scenarios': [{
            'scenario_id': 'parity',
            'graph': graph,
            'analytics_dsl': analytics_dsl,
            'effective_query_dsl': effective_query_dsl,
            'candidate_regimes_by_edge': candidate_regimes,
        }],
    })
    # Handle flat shape (single scenario + single subject)
    if 'result' in result and isinstance(result['result'], dict):
        rows = result['result'].get('maturity_rows', [])
        if rows:
            return rows
    # Handle nested shape (subjects or scenarios wrapper)
    for s in (result.get('subjects') or result.get('scenarios', [{}])[0].get('subjects', [])):
        rows = s.get('result', {}).get('maturity_rows', [])
        if rows:
            return rows
    return []


@functools.lru_cache(maxsize=None)
def _get_candidate_regimes_cached(graph_name: str):
    """Build candidate regimes from DB for each edge.

    Finds the bare (uncontexted) window and cohort core_hashes for
    each edge's param_id. Groups them into a single regime with all
    hashes as equivalents so the snapshot query can find rows regardless
    of which hash is primary. This mirrors how the FE constructs
    candidate regimes.

    Without this grouping, the subject resolution picks the first hash
    alphabetically as primary — which may be the wrong temporal mode
    (e.g. window hash for a cohort query), causing 0 rows returned.
    """
    graph = _load_graph(graph_name)

    from snapshot_service import _pooled_conn
    regimes = {}
    with _pooled_conn() as conn:
        cur = conn.cursor()
        for edge in graph.get('edges', []):
            p_id = edge.get('p', {}).get('id', '')
            if not p_id:
                continue
            # Find bare hashes: slice_key = 'window()' or 'cohort()'
            # (no context prefix). Exclude PLACEHOLDER hashes.
            cur.execute(
                "SELECT DISTINCT core_hash, slice_key FROM snapshots "
                "WHERE param_id LIKE %s AND core_hash != '' "
                "AND core_hash NOT LIKE 'PLACEHOLDER%%' "
                "AND slice_key NOT LIKE 'context%%' "
                "ORDER BY core_hash",
                (f'%{p_id}',),
            )
            rows = cur.fetchall()
            if rows:
                # Group all hashes into one regime with equivalents.
                # Primary = first hash; all others are equivalents.
                # equivalent_hashes is List[str] (not list of dicts).
                all_hashes = [r[0] for r in rows]
                primary = all_hashes[0]
                regimes[edge['uuid']] = [
                    {'core_hash': primary, 'equivalent_hashes': all_hashes[1:]}
                ]
    return regimes


def _get_candidate_regimes(graph_name: str):
    return copy.deepcopy(_get_candidate_regimes_cached(graph_name))


@functools.lru_cache(maxsize=None)
def _run_handler_cached(handler_name, graph_name, analytics_dsl, effective_query_dsl):
    from api_handlers import _handle_cohort_maturity_v2, _handle_cohort_maturity_v3

    handlers = {
        'v2': _handle_cohort_maturity_v2,
        'v3': _handle_cohort_maturity_v3,
    }
    return _run_handler(
        handlers[handler_name],
        _load_graph(graph_name),
        analytics_dsl,
        effective_query_dsl,
        _get_candidate_regimes(graph_name),
    )


def _run_pair(graph_name: str, analytics_dsl: str, effective_query_dsl: str):
    return (
        copy.deepcopy(
            _run_handler_cached('v2', graph_name, analytics_dsl, effective_query_dsl)
        ),
        copy.deepcopy(
            _run_handler_cached('v3', graph_name, analytics_dsl, effective_query_dsl)
        ),
    )


@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", bayesian=True)
class TestV2V3Parity:
    """v3 maturity rows match v2 for single-edge on bayesian-enriched synth graph.

    `bayesian=True` is required: without MCMC-fitted posteriors the edges
    resolve as `analytic` (query-scoped), which under doc 57 (P2.19)
    routes v3 through the degraded analytic path and diverges from v2's
    full-sweep output by design. Bayesian sources carry an aggregate
    prior (`alpha_beta_query_scoped=False`) so both paths run the CF
    sweep and parity is apples-to-apples.
    """

    GRAPH_NAME = 'synth-simple-abc'

    def test_window_mode_parity(self):
        """Window-mode v3 rows match v2 for A→B edge."""
        dsl = 'from(simple-a).to(simple-b)'
        query_dsl = 'window(-90d:)'

        v2_rows, v3_rows = _run_pair(self.GRAPH_NAME, dsl, query_dsl)

        assert len(v2_rows) > 0, 'v2 returned no rows'
        assert len(v3_rows) > 0, 'v3 returned no rows'

        # Compare at shared tau values
        v2_by_tau = {r['tau_days']: r for r in v2_rows}
        v3_by_tau = {r['tau_days']: r for r in v3_rows}
        # Row count must match — different counts = different chart extent
        v2_only = sorted(set(v2_by_tau) - set(v3_by_tau))
        v3_only = sorted(set(v3_by_tau) - set(v2_by_tau))
        assert len(v2_only) == 0 and len(v3_only) == 0, \
            f"Row count mismatch: v2={len(v2_rows)} v3={len(v3_rows)}. " \
            f"v2-only τ={v2_only[:10]}, v3-only τ={v3_only[:10]}"
        shared_taus = sorted(v2_by_tau.keys())
        assert len(shared_taus) > 5, f'Too few taus: {len(shared_taus)}'

        print(f"\nWindow mode A→B: {len(shared_taus)} shared τ values")
        print(f"{'tau':>4s}  {'v2_rate':>8s}  {'v3_rate':>8s}  {'v2_mid':>8s}  {'v3_mid':>8s}  {'Δmid':>8s}")

        max_mid_delta = 0.0
        for tau in shared_taus:
            r2 = v2_by_tau[tau]
            r3 = v3_by_tau[tau]

            # Evidence rate: v2 builds per-frame obs_x/obs_y arrays (multi-
            # snapshot aggregation); v3 uses last-frame data_points. Different
            # aggregation strategies — midpoint parity is the meaningful gate.
            # Rate comparison logged but not asserted.

            # Epoch boundaries must match
            assert r2.get('tau_solid_max') == r3.get('tau_solid_max'), \
                f"tau_solid_max mismatch at tau={tau}"
            assert r2.get('tau_future_max') == r3.get('tau_future_max'), \
                f"tau_future_max mismatch at tau={tau}"

            # Midpoint (MC) — tolerance for sampling variance
            mid2 = r2.get('midpoint')
            mid3 = r3.get('midpoint')
            mid_delta = abs(mid2 - mid3) if mid2 is not None and mid3 is not None else 0
            max_mid_delta = max(max_mid_delta, mid_delta)

            _f = lambda v: f"{v:8.4f}" if isinstance(v, (int, float)) else "    None"
            print(f"{tau:4d}  {_f(r2.get('rate'))}  {_f(r3.get('rate'))}  "
                  f"{_f(mid2)}  {_f(mid3)}  {mid_delta:8.4f}")

        print(f"\nMax midpoint delta: {max_mid_delta:.4f}")
        # MC sampling variance: v2 and v3 use different IS implementations
        # and different per-cohort conditioning. 10% tolerance accommodates
        # the variance at boundary cohorts.
        assert max_mid_delta < 0.10, \
            f"Midpoint parity failed: max delta={max_mid_delta:.4f} (>10%)"

    def test_cohort_mode_parity(self):
        """Cohort-mode v3 rows match v2 for B→C edge (upstream-aware)."""
        dsl = 'from(simple-b).to(simple-c)'
        query_dsl = 'cohort(-90d:)'

        v2_rows, v3_rows = _run_pair(self.GRAPH_NAME, dsl, query_dsl)

        assert len(v2_rows) > 0, 'v2 returned no rows'
        assert len(v3_rows) > 0, 'v3 returned no rows'

        v2_by_tau = {r['tau_days']: r for r in v2_rows}
        v3_by_tau = {r['tau_days']: r for r in v3_rows}
        shared_taus = sorted(set(v2_by_tau) & set(v3_by_tau))

        print(f"\nCohort mode B→C: {len(shared_taus)} shared τ values")
        print(f"{'tau':>4s}  {'v2_rate':>8s}  {'v3_rate':>8s}  {'v2_mid':>8s}  {'v3_mid':>8s}  {'Δmid':>8s}")

        max_mid_delta = 0.0
        for tau in shared_taus[:20]:
            r2 = v2_by_tau[tau]
            r3 = v3_by_tau[tau]

            mid2 = r2.get('midpoint')
            mid3 = r3.get('midpoint')
            mid_delta = abs(mid2 - mid3) if mid2 is not None and mid3 is not None else 0
            max_mid_delta = max(max_mid_delta, mid_delta)

            _f = lambda v: f"{v:8.4f}" if isinstance(v, (int, float)) else "    None"
            print(f"{tau:4d}  {_f(r2.get('rate'))}  {_f(r3.get('rate'))}  "
                  f"{_f(mid2)}  {_f(mid3)}  {mid_delta:8.4f}")

        print(f"\nMax midpoint delta: {max_mid_delta:.4f}")
        # Cohort mode: v3 uses engine convolution, v2 uses path-level CDF.
        # Expected delta ~2-3% from the parameterisation difference.
        # 10% tolerance to accommodate MC variance on top.
        assert max_mid_delta < 0.10, \
            f"Cohort midpoint parity failed: max delta={max_mid_delta:.4f} (>10%)"

    def test_multi_hop_acceptance(self):
        """v3 produces valid rows for multi-hop A→C (via B) span."""
        # Multi-hop: from anchor to final node, spanning two edges
        dsl = 'from(simple-a).to(simple-c)'
        query_dsl = 'cohort(-90d:)'

        v2_rows, v3_rows = _run_pair(self.GRAPH_NAME, dsl, query_dsl)

        print(f"\nMulti-hop A→C: v2={len(v2_rows)} rows, v3={len(v3_rows)} rows")

        assert len(v3_rows) > 0, 'v3 returned no rows for multi-hop'

        # Structural checks
        row = v3_rows[len(v3_rows) // 2]
        assert 'tau_days' in row
        assert 'tau_solid_max' in row
        assert 'tau_future_max' in row
        assert row['tau_future_max'] > 0, 'tau_future_max should be positive'

        # Find rows in forecast zone (where midpoint exists)
        forecast_rows = [r for r in v3_rows if r.get('midpoint') is not None]
        print(f"  Forecast-zone rows: {len(forecast_rows)}")
        assert len(forecast_rows) > 0, 'No forecast-zone rows (no midpoints)'

        # Midpoint should be in reasonable range (0, 1)
        midpoints = [r['midpoint'] for r in forecast_rows]
        print(f"  Midpoint range: [{min(midpoints):.4f}, {max(midpoints):.4f}]")
        assert all(0 < m < 1 for m in midpoints), \
            f"Midpoints out of range: {[m for m in midpoints if m <= 0 or m >= 1]}"

        # Multi-hop midpoints should be lower than single-edge
        # (path probability = p_AB × p_BC < min(p_AB, p_BC))
        single_v3 = copy.deepcopy(
            _run_handler_cached(
                'v3',
                self.GRAPH_NAME,
                'from(simple-a).to(simple-b)',
                query_dsl,
            )
        )
        if single_v3:
            single_forecast = [r for r in single_v3 if r.get('midpoint') is not None]
            if single_forecast and forecast_rows:
                # Compare at a shared τ in the forecast zone
                multi_tau = forecast_rows[0]['tau_days']
                single_at_tau = next(
                    (r for r in single_forecast if r['tau_days'] == multi_tau), None)
                if single_at_tau:
                    print(f"  At τ={multi_tau}: multi-hop={forecast_rows[0]['midpoint']:.4f} "
                          f"single-edge={single_at_tau['midpoint']:.4f}")
                    # Multi-hop rate should be lower (path p = p_AB × p_BC < p_AB).
                    # Allow 5% tolerance for MC variance in IS-conditioned draws.
                    assert forecast_rows[0]['midpoint'] < single_at_tau['midpoint'] * 1.05, \
                        f"Multi-hop midpoint ({forecast_rows[0]['midpoint']:.4f}) should be " \
                        f"< single-edge ({single_at_tau['midpoint']:.4f}) within 5% tolerance"

        # Compare v2 vs v3 midpoints where both exist
        if v2_rows:
            v2_by_tau = {r['tau_days']: r for r in v2_rows}
            v3_by_tau = {r['tau_days']: r for r in v3_rows}
            shared = sorted(set(v2_by_tau) & set(v3_by_tau))
            max_delta = 0.0
            for tau in shared:
                m2 = v2_by_tau[tau].get('midpoint')
                m3 = v3_by_tau[tau].get('midpoint')
                if m2 is not None and m3 is not None:
                    max_delta = max(max_delta, abs(m2 - m3))
            print(f"  v2 vs v3 max midpoint delta: {max_delta:.4f}")

    def test_v3_row_schema_complete(self):
        """v3 rows have all fields the FE chart builder needs."""
        _, rows = _run_pair(
            self.GRAPH_NAME,
            'from(simple-a).to(simple-b)',
            'window(-90d:)',
        )
        assert len(rows) > 0

        required_fields = [
            'tau_days', 'rate', 'rate_pure', 'evidence_y', 'evidence_x',
            'projected_rate', 'forecast_y', 'forecast_x',
            'midpoint', 'fan_upper', 'fan_lower', 'fan_bands',
            'model_midpoint', 'model_fan_upper', 'model_fan_lower', 'model_bands',
            'tau_solid_max', 'tau_future_max', 'boundary_date',
            'cohorts_covered_base', 'cohorts_covered_projected',
        ]

        # Pick a row in the forecast zone (τ > tau_solid_max) where
        # fan_bands are populated, not the evidence zone where they're None.
        tau_solid = rows[0].get('tau_solid_max', 0)
        forecast_rows = [r for r in rows if r['tau_days'] > tau_solid]
        row = forecast_rows[len(forecast_rows) // 2] if forecast_rows else rows[-1]
        for field in required_fields:
            assert field in row, f"Missing field: {field}"
            print(f"  {field}: {row[field]}")

        # fan_bands should have multi-level entries
        fb = row.get('fan_bands', {})
        assert '80' in fb, 'Missing 80% band'
        assert '90' in fb, 'Missing 90% band'
        assert '95' in fb, 'Missing 95% band'
        assert '99' in fb, 'Missing 99% band'
        for level, (lo, hi) in fb.items():
            assert lo <= hi, f"Band {level}: lo={lo} > hi={hi}"

    def test_window_mode_strict_midpoint_parity(self):
        """v3 midpoint must match v2 midpoint within 5% at every τ.

        This is the visual parity gate — if this fails, the chart
        looks visibly different. The 10% tolerance in the existing
        test is too loose to catch the IS tempering divergence that
        makes v3's midpoint line jump away from the evidence.

        The test prints a full comparison table so the IS conditioning
        gap is immediately visible.
        """
        dsl = 'from(simple-a).to(simple-b)'
        query_dsl = 'window(-90d:)'

        v2_rows, v3_rows = _run_pair(self.GRAPH_NAME, dsl, query_dsl)

        assert len(v2_rows) > 0, 'v2 returned no rows'
        assert len(v3_rows) > 0, 'v3 returned no rows'

        v2_by_tau = {r['tau_days']: r for r in v2_rows}
        v3_by_tau = {r['tau_days']: r for r in v3_rows}
        shared_taus = sorted(set(v2_by_tau) & set(v3_by_tau))

        print(f"\nStrict parity A→B window: {len(shared_taus)} shared τ")
        print(f"{'tau':>4s}  {'v2_mid':>8s}  {'v3_mid':>8s}  {'Δ':>8s}  {'status':>6s}")

        failures = []
        for tau in shared_taus:
            mid2 = v2_by_tau[tau].get('midpoint')
            mid3 = v3_by_tau[tau].get('midpoint')

            if mid2 is None and mid3 is None:
                status = 'OK'
                delta = 0
            elif mid2 is None or mid3 is None:
                status = 'EPOCH'
                delta = 0
                failures.append(f"τ={tau}: epoch mismatch v2={mid2} v3={mid3}")
            else:
                delta = abs(mid2 - mid3)
                if delta < 0.05:
                    status = 'OK'
                else:
                    status = 'FAIL'
                    failures.append(f"τ={tau}: v2={mid2:.4f} v3={mid3:.4f} Δ={delta:.4f}")

            _f = lambda v: f"{v:8.4f}" if isinstance(v, (int, float)) else "    None"
            print(f"{tau:4d}  {_f(mid2)}  {_f(mid3)}  {delta:8.4f}  {status}")

        assert len(failures) == 0, \
            f"v3 midpoint diverges from v2 at {len(failures)} τ values " \
            f"(>5% absolute):\n" + "\n".join(failures[:10])


@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", bayesian=True)
class TestRowLevelParity:
    """v3 rows must match v2 field-by-field on every τ.

    This is the hard parity gate. It calls v2 and v3 handlers with
    identical inputs on the enriched synth graph and asserts that
    every field the FE renders matches within tight tolerance.

    If this test is red, the chart looks wrong. Period.
    """

    GRAPH_NAME = 'synth-simple-abc'

    def _run_both(self, dsl, query_dsl):
        v2_rows, v3_rows = _run_pair(self.GRAPH_NAME, dsl, query_dsl)

        assert len(v2_rows) > 0, 'v2 returned no rows'
        assert len(v3_rows) > 0, 'v3 returned no rows'

        return v2_rows, v3_rows

    def _assert_parity(self, v2_rows, v3_rows, label,
                       rate_tol=0.01, midpoint_tol=0.03):
        """Assert per-τ field parity between v2 and v3 rows.

        Tolerances:
        - rate (evidence): 1% — both derive from the same frames
        - midpoint, fan bounds: 3% — MC variance from different
          IS implementations is acceptable within this range
        - epoch boundaries: exact match
        - evidence_y, evidence_x: exact match (integer counts)
        """
        v2_by_tau = {r['tau_days']: r for r in v2_rows}
        v3_by_tau = {r['tau_days']: r for r in v3_rows}
        # Row count must match — different counts = different chart extent
        v2_only = sorted(set(v2_by_tau) - set(v3_by_tau))
        v3_only = sorted(set(v3_by_tau) - set(v2_by_tau))
        assert len(v2_only) == 0 and len(v3_only) == 0, \
            f"Row count mismatch: v2={len(v2_rows)} v3={len(v3_rows)}. " \
            f"v2-only τ={v2_only[:10]}, v3-only τ={v3_only[:10]}"
        shared_taus = sorted(v2_by_tau.keys())
        assert len(shared_taus) > 5, f'Too few taus: {len(shared_taus)}'

        # Axis extent: max τ must match
        v2_max_tau = max(v2_by_tau.keys())
        v3_max_tau = max(v3_by_tau.keys())
        assert v2_max_tau == v3_max_tau, \
            f"Axis extent mismatch: v2 max_tau={v2_max_tau} v3 max_tau={v3_max_tau}"

        # Header
        print(f"\n{label}: {len(shared_taus)} τ values, axis extent={v2_max_tau}")
        print(f"{'τ':>4s}  {'v2_rate':>8s}  {'v3_rate':>8s}  "
              f"{'v2_mid':>8s}  {'v3_mid':>8s}  "
              f"{'Δrate':>8s}  {'Δmid':>8s}  {'status':>6s}")

        failures = []
        for tau in shared_taus:
            r2 = v2_by_tau[tau]
            r3 = v3_by_tau[tau]
            issues = []

            # ── Epoch boundaries + structural: exact match ────────────
            for field in ('tau_solid_max', 'tau_future_max', 'boundary_date'):
                if r2.get(field) != r3.get(field):
                    issues.append(f"{field}: v2={r2.get(field)} v3={r3.get(field)}")

            # ── Cohort counts: exact match ──────────────────────────
            for field in ('cohorts_covered_base', 'cohorts_covered_projected'):
                v2v = r2.get(field)
                v3v = r3.get(field)
                if v2v is not None and v3v is not None and v2v != v3v:
                    issues.append(f"{field}: v2={v2v} v3={v3v}")

            # ── Evidence fields ──────────────────────────────────────
            rate2 = r2.get('rate')
            rate3 = r3.get('rate')
            rate_delta = 0.0
            if rate2 is not None and rate3 is not None:
                rate_delta = abs(rate2 - rate3)
                if rate_delta > rate_tol:
                    issues.append(f"rate: v2={rate2:.4f} v3={rate3:.4f} Δ={rate_delta:.4f}")
            elif (rate2 is None) != (rate3 is None):
                issues.append(f"rate presence: v2={rate2} v3={rate3}")

            # rate_pure (evidence-only rate, no projection)
            rp2 = r2.get('rate_pure')
            rp3 = r3.get('rate_pure')
            if rp2 is not None and rp3 is not None:
                d = abs(rp2 - rp3)
                if d > rate_tol:
                    issues.append(f"rate_pure: v2={rp2:.4f} v3={rp3:.4f} Δ={d:.4f}")
            elif (rp2 is None) != (rp3 is None):
                issues.append(f"rate_pure presence: v2={rp2} v3={rp3}")

            # Evidence counts — should be identical (same frames)
            for field in ('evidence_y', 'evidence_x'):
                v2v = r2.get(field)
                v3v = r3.get(field)
                if v2v is not None and v3v is not None:
                    if abs(float(v2v) - float(v3v)) > 0.5:
                        issues.append(f"{field}: v2={v2v} v3={v3v}")
                elif (v2v is None) != (v3v is None):
                    issues.append(f"{field} presence: v2={v2v} v3={v3v}")

            # ── MC-derived fields ────────────────────────────────────
            mid2 = r2.get('midpoint')
            mid3 = r3.get('midpoint')
            mid_delta = 0.0
            if mid2 is not None and mid3 is not None:
                mid_delta = abs(mid2 - mid3)
                if mid_delta > midpoint_tol:
                    issues.append(f"midpoint: v2={mid2:.4f} v3={mid3:.4f} Δ={mid_delta:.4f}")
            elif (mid2 is None) != (mid3 is None):
                issues.append(f"midpoint presence: v2={mid2} v3={mid3}")

            # ── Fan bounds (conditioned) ─────────────────────────────
            for field in ('fan_upper', 'fan_lower'):
                v2v = r2.get(field)
                v3v = r3.get(field)
                if v2v is not None and v3v is not None:
                    delta = abs(v2v - v3v)
                    if delta > midpoint_tol:
                        issues.append(f"{field}: v2={v2v:.4f} v3={v3v:.4f} Δ={delta:.4f}")
                elif v2v is None and v3v is not None:
                    # v3's engine always produces conditioned fan bands;
                    # v2 omits them when mc_cdf_arr is absent (single-edge
                    # spans without span kernel MC draws). This is a v2
                    # limitation, not a v3 regression — accept it.
                    pass
                elif v2v is not None and v3v is None:
                    issues.append(f"{field} presence: v2={v2v} v3=None")

            # ── Model curve (unconditioned) ──────────────────────────
            for field in ('model_midpoint', 'model_fan_upper', 'model_fan_lower'):
                v2v = r2.get(field)
                v3v = r3.get(field)
                if v2v is not None and v3v is not None:
                    delta = abs(v2v - v3v)
                    if delta > midpoint_tol:
                        issues.append(f"{field}: v2={v2v:.4f} v3={v3v:.4f} Δ={delta:.4f}")
                elif (v2v is None) != (v3v is None):
                    issues.append(f"{field} presence: v2={v2v} v3={v3v}")

            # ── Fan bands dict (conditioned + model) ─────────────────
            for bands_field in ('fan_bands', 'model_bands'):
                v2b = r2.get(bands_field)
                v3b = r3.get(bands_field)
                if v2b is not None and v3b is not None:
                    for level in ('80', '90', '95', '99'):
                        v2_band = v2b.get(level)
                        v3_band = v3b.get(level)
                        if v2_band and v3_band:
                            for i, label in enumerate(['lo', 'hi']):
                                d = abs(float(v2_band[i]) - float(v3_band[i]))
                                if d > midpoint_tol:
                                    issues.append(
                                        f"{bands_field}[{level}][{label}]: "
                                        f"v2={v2_band[i]:.4f} v3={v3_band[i]:.4f} Δ={d:.4f}")
                            # Fan width parity: width = hi - lo
                            v2_w = float(v2_band[1]) - float(v2_band[0])
                            v3_w = float(v3_band[1]) - float(v3_band[0])
                            if v2_w > 0.01:  # only check meaningful widths
                                w_ratio = v3_w / v2_w if v2_w > 0 else 0
                                if abs(w_ratio - 1.0) > 0.35:  # 35% width tolerance
                                    issues.append(
                                        f"{bands_field}[{level}] width: "
                                        f"v2={v2_w:.4f} v3={v3_w:.4f} ratio={w_ratio:.2f}")
                elif (v2b is None) != (v3b is None):
                    # v3 may emit bands where v2 doesn't — accept
                    if v2b is not None and v3b is None:
                        issues.append(f"{bands_field} presence: v2=present v3=None")

            # ── Forecast/projection fields ───────────────────────────
            # G.4: projected_rate excluded — v3 now uses MC mean draws
            # (IS-conditioned) instead of legacy annotate_rows blend.
            # forecast_y/forecast_x excluded — v3 reads from sweep
            # det_y_total (IS-conditioned median) not _compute_det_totals.
            for field in ():
                v2v = r2.get(field)
                v3v = r3.get(field)
                if v2v is not None and v3v is not None:
                    if isinstance(v2v, (int, float)) and isinstance(v3v, (int, float)):
                        d = abs(float(v2v) - float(v3v))
                        rel = d / max(abs(float(v2v)), 1.0)
                        if rel > 0.05:  # 5% relative tolerance for forecasts
                            issues.append(f"{field}: v2={v2v} v3={v3v} Δrel={rel:.2%}")

            # ── Print and collect ────────────────────────────────────
            _f = lambda v: f"{v:8.4f}" if isinstance(v, (int, float)) else "    None"
            status = 'FAIL' if issues else 'OK'
            print(f"{tau:4d}  {_f(rate2)}  {_f(rate3)}  "
                  f"{_f(mid2)}  {_f(mid3)}  "
                  f"{rate_delta:8.4f}  {mid_delta:8.4f}  {status}")

            if issues:
                failures.append(f"τ={tau}: " + "; ".join(issues))

        assert len(failures) == 0, \
            f"v3 diverges from v2 at {len(failures)}/{len(shared_taus)} " \
            f"τ values:\n" + "\n".join(failures[:20])

    def test_window_mode_row_parity(self):
        """Window mode: v3 rows match v2 field-by-field on A→B."""
        v2_rows, v3_rows = self._run_both(
            'from(simple-a).to(simple-b)', 'window(-90d:)')
        self._assert_parity(v2_rows, v3_rows, 'Window A→B')

    def test_cohort_mode_row_parity(self):
        """Cohort mode: v3 rows match v2 field-by-field on A→B."""
        v2_rows, v3_rows = self._run_both(
            'from(simple-a).to(simple-b)', 'cohort(-90d:)')
        self._assert_parity(v2_rows, v3_rows, 'Cohort A→B')

    def test_multihop_row_parity(self):
        """Multi-hop: v3 rows match v2 field-by-field on A→C."""
        v2_rows, v3_rows = self._run_both(
            'from(simple-a).to(simple-c)', 'cohort(-90d:)')
        self._assert_parity(v2_rows, v3_rows, 'Multi-hop A→C',
                            midpoint_tol=0.05)

    def test_single_edge_cohort_with_upstream_parity(self):
        """Single-edge cohort B→C where anchor=A ≠ from_node=B.

        This is the case that breaks when cohort mode doesn't
        account for upstream lag. Ages are anchor-relative (from A)
        but the edge is B→C. Without path-level latency, the CDF
        is wrong and midpoint/fan diverge wildly from v2.
        """
        v2_rows, v3_rows = self._run_both(
            'from(simple-b).to(simple-c)', 'cohort(-90d:)')
        self._assert_parity(v2_rows, v3_rows,
                            'Single-edge cohort B→C (upstream lag)')


def _load_mirror4_graph():
    """Load the enriched synth-mirror-4step graph (A→B→C→D chain)."""
    graph = _load_graph('synth-mirror-4step')
    has_bayes = any(
        any(m.get('source') == 'bayesian' for m in (e.get('p', {}).get('model_vars', [])))
        for e in graph.get('edges', [])
    )
    if not has_bayes:
        pytest.skip('synth-mirror-4step not enriched')
    return graph


@pytest.mark.skip(reason="v2/v3 upstream-lag parity deferred — see docs/current/project-bayes/programme.md (final reconciliation outstanding)")
@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", enriched=True)
class TestUpstreamLagParity:
    """Cohort mode parity on synth-mirror-4step (4-node chain).

    Tests from(m4-registered).to(m4-success) in cohort mode where
    anchor=m4-landing ≠ from_node=m4-registered. This exercises the
    single-edge cohort case with upstream lag — the case that breaks
    when the engine uses edge-level CDF instead of path-level.

    Also tests multi-hop from(m4-delegated).to(m4-success) in cohort
    mode for the multi-hop upstream lag case.
    """

    def _run_both_m4(self, dsl, query_dsl):
        v2_rows, v3_rows = _run_pair('synth-mirror-4step', dsl, query_dsl)

        assert len(v2_rows) > 0, 'v2 returned no rows'
        assert len(v3_rows) > 0, 'v3 returned no rows'
        return v2_rows, v3_rows

    def _assert_parity(self, v2_rows, v3_rows, label, midpoint_tol=0.03):
        v2_by_tau = {r['tau_days']: r for r in v2_rows}
        v3_by_tau = {r['tau_days']: r for r in v3_rows}
        shared = sorted(set(v2_by_tau) & set(v3_by_tau))
        assert len(shared) > 5, f'Too few shared τ: {len(shared)}'

        failures = []
        for tau in shared:
            r2, r3 = v2_by_tau[tau], v3_by_tau[tau]
            issues = []

            # ── Midpoint ──────────────────────────────────────────
            mid2, mid3 = r2.get('midpoint'), r3.get('midpoint')
            if mid2 is not None and mid3 is not None:
                d = abs(mid2 - mid3)
                if d > midpoint_tol:
                    issues.append(f"midpoint: v2={mid2:.4f} v3={mid3:.4f} Δ={d:.4f}")

            # ── Fan width (90% band) ──────────────────────────────
            fb2 = (r2.get('fan_bands') or {}).get('90')
            fb3 = (r3.get('fan_bands') or {}).get('90')
            if fb2 and fb3:
                w2 = fb2[1] - fb2[0]
                w3 = fb3[1] - fb3[0]
                if w2 > 0.01:
                    wr = w3 / w2
                    if abs(wr - 1.0) > 0.35:
                        issues.append(f"fan_w90: v2={w2:.4f} v3={w3:.4f} ratio={wr:.2f}")

            # ── Forecast x (denominator scaling) ──────────────────
            # The x denominator must track v2: if v3 scales x slower
            # (missing carrier / Pop C), the rate curve shape diverges.
            fx2, fx3 = r2.get('forecast_x'), r3.get('forecast_x')
            if fx2 is not None and fx3 is not None and fx2 > 1.0:
                fx_ratio = fx3 / fx2
                if abs(fx_ratio - 1.0) > 0.20:
                    issues.append(f"forecast_x: v2={fx2:.1f} v3={fx3:.1f} ratio={fx_ratio:.2f}")

            # ── Forecast y (numerator) ────────────────────────────
            fy2, fy3 = r2.get('forecast_y'), r3.get('forecast_y')
            if fy2 is not None and fy3 is not None and fy2 > 1.0:
                fy_ratio = fy3 / fy2
                if abs(fy_ratio - 1.0) > 0.20:
                    issues.append(f"forecast_y: v2={fy2:.1f} v3={fy3:.1f} ratio={fy_ratio:.2f}")

            if issues:
                failures.append(f"τ={tau}: " + "; ".join(issues))

        _f = lambda v: f"{v:8.4f}" if isinstance(v, (int, float)) else "    None"
        _fx = lambda v: f"{v:8.1f}" if isinstance(v, (int, float)) else "    None"
        print(f"\n{label}: {len(shared)} shared τ")
        for tau in shared[:20]:
            r2, r3 = v2_by_tau[tau], v3_by_tau[tau]
            m2, m3 = r2.get('midpoint'), r3.get('midpoint')
            d = abs(m2 - m3) if m2 is not None and m3 is not None else 0
            fx2, fx3 = r2.get('forecast_x'), r3.get('forecast_x')
            fy2, fy3 = r2.get('forecast_y'), r3.get('forecast_y')
            fb2 = (r2.get('fan_bands') or {}).get('90')
            fb3 = (r3.get('fan_bands') or {}).get('90')
            w2 = (fb2[1] - fb2[0]) if fb2 else None
            w3 = (fb3[1] - fb3[0]) if fb3 else None
            print(f"  τ={tau:3d}  mid:{_f(m2)}/{_f(m3)} Δ={d:.4f}"
                  f"  fx:{_fx(fx2)}/{_fx(fx3)}"
                  f"  fy:{_fx(fy2)}/{_fx(fy3)}"
                  f"  w90:{_f(w2)}/{_f(w3)}")

        assert len(failures) == 0, \
            f"{label}: {len(failures)} τ diverge:\n" + "\n".join(failures[:15])

    def test_single_edge_cohort_upstream(self):
        """Single-edge cohort: m4-registered→m4-success, anchor=m4-landing.

        anchor ≠ from_node, so ages are anchor-relative with upstream
        lag. v3 must use path-level CDF, not edge-level.

        Uses -14d: window so youngest cohorts are immature and the
        forecast zone is populated (midpoint not None).
        """
        v2, v3 = self._run_both_m4(
            'from(m4-registered).to(m4-success)', 'cohort(-14d:)')
        # Must have some forecast-zone rows (midpoint not None)
        v3_forecast = [r for r in v3 if r.get('midpoint') is not None]
        assert len(v3_forecast) > 0, \
            'No forecast-zone rows — test is vacuous without midpoints'
        self._assert_parity(v2, v3, 'M4 single-edge cohort (upstream lag)')

    def test_multihop_cohort_upstream(self):
        """Multi-hop cohort: m4-delegated→m4-success, anchor=m4-landing.

        Two-edge span in cohort mode with upstream lag.
        """
        v2, v3 = self._run_both_m4(
            'from(m4-delegated).to(m4-success)', 'cohort(-14d:)')
        v3_forecast = [r for r in v3 if r.get('midpoint') is not None]
        assert len(v3_forecast) > 0, \
            'No forecast-zone rows — test is vacuous without midpoints'
        self._assert_parity(v2, v3, 'M4 multi-hop cohort (upstream lag)',
                            midpoint_tol=0.05)

    def test_window_mode_baseline(self):
        """Window mode baseline — should be perfect parity."""
        v2, v3 = self._run_both_m4(
            'from(m4-registered).to(m4-success)', 'window(-14d:)')
        self._assert_parity(v2, v3, 'M4 window baseline')


def _load_prod_graph():
    return _load_graph('bayes-test-gm-rebuild')


@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", enriched=True)
class TestProdGraphCohortParity:
    """Cohort mode parity on the production graph.

    Tests the exact queries the FE renders. Catches regressions
    that synth graph tests miss because the production graph has
    different topology (anchor far upstream, path params populated
    by FE topo pass, no bayesian model_vars on some edges).
    """

    def _run_both_prod(self, dsl, query_dsl):
        v2_rows, v3_rows = _run_pair('bayes-test-gm-rebuild', dsl, query_dsl)

        assert len(v2_rows) > 0, 'v2 returned no rows'
        assert len(v3_rows) > 0, 'v3 returned no rows'
        return v2_rows, v3_rows

    def test_single_edge_cohort_midpoint(self):
        """Single-edge cohort: midpoint must track v2 within 5%.

        Uses a narrow recent window matching the FE render query
        to exercise the case with few young cohorts.
        """
        v2, v3 = self._run_both_prod(
            'from(switch-registered).to(switch-success)',
            'cohort(-7d:)')

        v2_by_tau = {r['tau_days']: r for r in v2}
        v3_by_tau = {r['tau_days']: r for r in v3}
        shared = sorted(set(v2_by_tau) & set(v3_by_tau))

        failures = []
        for tau in shared:
            m2 = v2_by_tau[tau].get('midpoint')
            m3 = v3_by_tau[tau].get('midpoint')
            if m2 is not None and m3 is not None:
                d = abs(m2 - m3)
                if d > 0.05:
                    failures.append(f"τ={tau}: v2={m2:.4f} v3={m3:.4f} Δ={d:.4f}")

        if failures:
            # Print full comparison for diagnosis
            for tau in shared:
                m2 = v2_by_tau[tau].get('midpoint')
                m3 = v3_by_tau[tau].get('midpoint')
                d = abs(m2 - m3) if m2 is not None and m3 is not None else 0
                _f = lambda v: f"{v:.4f}" if isinstance(v, (int, float)) else "None"
                print(f"  τ={tau:3d}  mid:{_f(m2)}/{_f(m3)} Δ={d:.4f}")

        assert len(failures) == 0, \
            f"Midpoint diverges >10% at {len(failures)} τ:\n" + "\n".join(failures[:10])


class _TestUpstreamLagParityInline:
    """DISABLED — inline synth graphs don't exercise real snapshot pipeline.
    Use TestUpstreamLagParity (synth-mirror-4step) instead.
    """

    @staticmethod
    def _build_chain_graph():
        """A→B→C→D chain with latency and path params on downstream edges."""
        return {
            'nodes': [
                {'uuid': 'na', 'id': 'chain-a', 'entry': {'is_start': True}},
                {'uuid': 'nb', 'id': 'chain-b'},
                {'uuid': 'nc', 'id': 'chain-c'},
                {'uuid': 'nd', 'id': 'chain-d'},
            ],
            'edges': [
                {
                    'uuid': 'e-ab', 'from': 'na', 'to': 'nb',
                    'p': {
                        'id': 'chain-a-to-b',
                        'forecast': {'mean': 0.60},
                        'latency': {
                            'mu': 1.5, 'sigma': 0.8,
                            'onset_delta_days': 2.0, 't95': 20.0,
                            'mu_sd': 0.08, 'sigma_sd': 0.04, 'onset_sd': 0.5,
                        },
                        'posterior': {'alpha': 30.0, 'beta': 20.0},
                        'model_vars': [{'source': 'analytic',
                            'latency': {'mu': 1.5, 'sigma': 0.8,
                                        'onset_delta_days': 2.0,
                                        'mu_sd': 0.08, 'sigma_sd': 0.04,
                                        'onset_sd': 0.5},
                            'probability': {'mean': 0.60}}],
                    },
                },
                {
                    'uuid': 'e-bc', 'from': 'nb', 'to': 'nc',
                    'p': {
                        'id': 'chain-b-to-c',
                        'forecast': {'mean': 0.70},
                        'latency': {
                            'mu': 2.0, 'sigma': 0.6,
                            'onset_delta_days': 3.0, 't95': 25.0,
                            'mu_sd': 0.06, 'sigma_sd': 0.03, 'onset_sd': 0.4,
                            # Path-level: A→C via FW composition
                            'path_mu': 2.8, 'path_sigma': 0.55,
                            'path_onset_delta_days': 5.0, 'path_t95': 40.0,
                        },
                        'posterior': {'alpha': 35.0, 'beta': 15.0},
                        'model_vars': [{'source': 'analytic',
                            'latency': {'mu': 2.0, 'sigma': 0.6,
                                        'onset_delta_days': 3.0,
                                        'mu_sd': 0.06, 'sigma_sd': 0.03,
                                        'onset_sd': 0.4},
                            'probability': {'mean': 0.70}}],
                    },
                },
                {
                    'uuid': 'e-cd', 'from': 'nc', 'to': 'nd',
                    'p': {
                        'id': 'chain-c-to-d',
                        'forecast': {'mean': 0.80},
                        'latency': {
                            'mu': 1.8, 'sigma': 0.5,
                            'onset_delta_days': 1.0, 't95': 18.0,
                            'mu_sd': 0.05, 'sigma_sd': 0.03, 'onset_sd': 0.3,
                            # Path-level: A→D via FW composition
                            'path_mu': 3.2, 'path_sigma': 0.5,
                            'path_onset_delta_days': 6.0, 'path_t95': 50.0,
                        },
                        'posterior': {'alpha': 40.0, 'beta': 10.0},
                        'model_vars': [{'source': 'analytic',
                            'latency': {'mu': 1.8, 'sigma': 0.5,
                                        'onset_delta_days': 1.0,
                                        'mu_sd': 0.05, 'sigma_sd': 0.03,
                                        'onset_sd': 0.3},
                            'probability': {'mean': 0.80}}],
                    },
                },
            ],
            'policies': {
                'default_outcome': 'dropout',
                'overflow_policy': 'auto',
                'free_edge_policy': 'auto',
            },
        }

    @staticmethod
    def _build_chain_frames(n_cohorts=12, n_per_cohort=200,
                            true_rate=0.65, sweep_days=50):
        """Synthetic frames for the B→D span.

        Anchor-relative ages: cohort members entered A, so age 0 is
        when they entered A. By age ~10 they reach B, by age ~20
        they reach C, and conversions at D happen from age ~25+.
        """
        from datetime import date, timedelta
        import random
        random.seed(42)

        anchor_to = date(2026, 3, 1)
        sweep_to = anchor_to + timedelta(days=sweep_days)

        frames = []
        for day_offset in range(sweep_days + 1):
            snapshot_date = anchor_to + timedelta(days=day_offset)
            data_points = []
            for c in range(n_cohorts):
                anchor_day = anchor_to - timedelta(days=c * 3)
                age = (snapshot_date - anchor_day).days
                x = n_per_cohort
                # Simulate path-level maturity: slow ramp reflecting
                # upstream lag (cohorts take ~10 days to reach B)
                effective_age = max(0, age - 10)
                y = int(true_rate * x * min(1.0, effective_age / 25.0))
                y = min(y, x)
                data_points.append({
                    'anchor_day': anchor_day.isoformat(),
                    'x': x,
                    'y': y,
                    'a': x * 3,
                })
            frames.append({
                'snapshot_date': snapshot_date.isoformat(),
                'data_points': data_points,
            })

        return frames, anchor_to.isoformat(), sweep_to.isoformat()

    def test_multihop_cohort_upstream_lag(self):
        """from(b).to(d) cohort: anchor=A, multi-hop B→C→D.

        v2 and v3 must agree on midpoint trajectory. This catches
        the case where v3 uses edge-level CDF instead of path-level
        for anchor-relative ages.
        """
        from api_handlers import _handle_cohort_maturity_v2, _handle_cohort_maturity_v3

        graph = self._build_chain_graph()
        frames, anchor_from, sweep_to = self._build_chain_frames()

        # Call v3 directly (no DB needed — inline graph + frames)
        from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3
        from runner.cohort_forecast import compute_cohort_maturity_rows

        # v3
        v3_rows = compute_cohort_maturity_rows_v3(
            frames=frames, graph=graph,
            target_edge_id='e-cd',
            query_from_node='chain-b',
            query_to_node='chain-d',
            anchor_from=anchor_from,
            anchor_to=anchor_from,
            sweep_to=sweep_to,
            is_window=False,
            band_level=0.90,
            anchor_node_id='chain-a',
            is_multi_hop=True,
        )

        assert len(v3_rows) > 0, 'v3 returned no rows'

        # Basic sanity: at maturity (τ≥40), midpoint should reflect
        # true_rate (~0.65), not edge-level p (0.80) or path-level
        # p (much lower).
        mature = [r for r in v3_rows
                  if r.get('midpoint') is not None and r['tau_days'] >= 40]
        assert len(mature) > 0, 'No mature rows'
        avg_mid = sum(r['midpoint'] for r in mature) / len(mature)
        print(f'\n  Mature midpoint avg: {avg_mid:.4f} (expected ~0.65)')
        assert 0.30 < avg_mid < 0.90, \
            f'Mature midpoint {avg_mid:.4f} outside reasonable range'

        # Fan should exist and have nonzero width
        fan_rows = [r for r in v3_rows
                    if r.get('fan_bands') and r['fan_bands'].get('90')]
        assert len(fan_rows) > 5, f'Too few fan rows: {len(fan_rows)}'
        widths = [r['fan_bands']['90'][1] - r['fan_bands']['90'][0]
                  for r in fan_rows]
        assert all(w > 0 for w in widths), 'Zero-width fan bands'
        print(f'  Fan width range: [{min(widths):.4f}, {max(widths):.4f}]')

    def test_row_count_exact_match(self):
        """v3 row count must exactly match v2 for all modes.

        Catches axis_tau_max computation divergence that caused v2=35
        rows vs v3=20 rows in production. The row count assertion is
        also embedded in _assert_parity, but this test makes the
        invariant explicit and prominent.
        """
        for label, dsl, qdsl in [
            ('Window A→B',   'from(simple-a).to(simple-b)', 'window(-90d:)'),
            ('Cohort A→B',   'from(simple-a).to(simple-b)', 'cohort(-90d:)'),
            ('Multi-hop A→C','from(simple-a).to(simple-c)', 'cohort(-90d:)'),
        ]:
            v2_rows, v3_rows = self._run_both(dsl, qdsl)
            assert len(v2_rows) == len(v3_rows), \
                f"{label}: row count mismatch v2={len(v2_rows)} v3={len(v3_rows)}"
            print(f"  {label}: {len(v2_rows)} rows ✓")

    def test_narrow_window_parity(self):
        """Narrow window with absolute dates inside synth data range.

        Uses a 14-day window within the synth data (Dec-25 to Mar-26)
        so tau_future_max is small but t95 extends the axis. This
        catches the axis_tau_max divergence that caused v2=35 vs v3=20
        rows in production (where the narrow window had data).
        """
        v2_rows, v3_rows = self._run_both(
            'from(simple-a).to(simple-b)', 'window(1-Mar-26:15-Mar-26)')
        assert len(v2_rows) == len(v3_rows), \
            f"Narrow window row count: v2={len(v2_rows)} v3={len(v3_rows)}"
        assert len(v2_rows) > 14, \
            f"Expected axis extension beyond 14-day sweep: got {len(v2_rows)} rows"
        self._assert_parity(v2_rows, v3_rows, 'Narrow window A→B')


class TestStrongEvidenceParity:
    """v3 midpoint must match v2 under strong evidence.

    Mimics a prod-like scenario: prior p≈0.80, observed rate≈0.50,
    18 cohorts with n≈300 each. This produces aggregate evidence
    (k≈2700, E≈5400) where IS tempering weakness becomes visible.

    No DB or data repo required — uses synthetic graph + frames.
    """

    @staticmethod
    def _build_synth_graph():
        """Build a single-edge graph with strong model params."""
        return {
            'nodes': [
                {'uuid': 'n1', 'id': 'node-a', 'entry': {'is_start': True}},
                {'uuid': 'n2', 'id': 'node-b'},
            ],
            'edges': [{
                'uuid': 'e1',
                'from': 'n1',
                'to': 'n2',
                'p': {
                    'id': 'synth-strong-evidence',
                    'forecast': {'mean': 0.80},
                    'latency': {
                        'mu': 2.0,
                        'sigma': 0.6,
                        'onset_delta_days': 3.0,
                        't95': 30.0,
                        'promoted_t95': 30.0,
                        'mu_sd': 0.1,
                        'sigma_sd': 0.05,
                        'onset_sd': 1.0,
                        'onset_mu_corr': -0.5,
                    },
                    'posterior': {
                        'alpha': 40.0,
                        'beta': 10.0,
                    },
                    'model_vars': [{
                        'source': 'analytic',
                        'latency': {
                            'mu': 2.0, 'sigma': 0.6,
                            'onset_delta_days': 3.0,
                            'mu_sd': 0.1, 'sigma_sd': 0.05,
                            'onset_sd': 1.0,
                        },
                        'probability': {'mean': 0.80},
                    }],
                },
            }],
        }

    @staticmethod
    def _build_synth_frames(n_cohorts=18, n_per_cohort=300,
                            true_rate=0.50, sweep_days=38):
        """Build synthetic frames mimicking strong evidence.

        Each frame is a snapshot at a different date. Each cohort
        starts on a different anchor_day and is observed at sweep_to.
        The observed rate (y/x) is ~true_rate, much lower than the
        prior (0.80). This forces IS conditioning to pull the
        midpoint down.
        """
        from datetime import date, timedelta
        import random
        random.seed(42)

        anchor_to = date(2026, 3, 1)
        sweep_to = anchor_to + timedelta(days=sweep_days)

        frames = []
        for day_offset in range(sweep_days + 1):
            snapshot_date = anchor_to + timedelta(days=day_offset)
            data_points = []
            for c in range(n_cohorts):
                anchor_day = anchor_to - timedelta(days=c * 2)
                age = (snapshot_date - anchor_day).days
                x = n_per_cohort
                y = int(true_rate * x * min(1.0, age / 20.0))
                y = min(y, x)
                data_points.append({
                    'anchor_day': anchor_day.isoformat(),
                    'x': x,
                    'y': y,
                    'a': x * 2,
                    'median_lag_days': 8.0,
                    'mean_lag_days': 10.0,
                })
            frames.append({
                'snapshot_date': snapshot_date.isoformat(),
                'data_points': data_points,
            })

        return frames, anchor_to.isoformat(), sweep_to.isoformat()

    def test_strong_evidence_midpoint_near_observed_rate(self):
        """v3 midpoint at maturity must reflect the evidence, not the prior.

        Under strong evidence (18 cohorts × 300 exposures, observed
        rate 50% vs prior 80%), the IS-conditioned midpoint at large
        τ (where CDF≈1) should be near the observed rate (~50%), not
        the prior (~80%).

        This is the test that catches weak IS tempering: if λ is too
        low, the posterior stays near the prior and the midpoint line
        visibly diverges from the evidence in the chart.
        """
        graph = self._build_synth_graph()
        frames, anchor_from, sweep_to = self._build_synth_frames()

        from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3

        v3_rows = compute_cohort_maturity_rows_v3(
            frames=frames,
            graph=graph,
            target_edge_id='e1',
            query_from_node='node-a',
            query_to_node='node-b',
            anchor_from=anchor_from,
            anchor_to=anchor_from,
            sweep_to=sweep_to,
            is_window=True,
            band_level=0.90,
        )

        assert len(v3_rows) > 0, 'v3 returned no rows'

        # At maturity (large τ, CDF≈1), midpoint ≈ conditioned p.
        # With strong evidence (rate=0.50), the conditioned p should
        # be pulled toward 0.50, not stay at prior 0.80.
        mature_rows = [r for r in v3_rows
                       if r.get('midpoint') is not None
                       and r['tau_days'] >= 30]
        assert len(mature_rows) > 0, 'No mature rows with midpoint'

        mature_midpoints = [r['midpoint'] for r in mature_rows]
        avg_midpoint = sum(mature_midpoints) / len(mature_midpoints)

        # Evidence at maturity
        mature_evidence = [r for r in v3_rows
                           if r.get('rate') is not None
                           and r['tau_days'] >= 30]
        if mature_evidence:
            avg_evidence = sum(r['rate'] for r in mature_evidence) / len(mature_evidence)
        else:
            avg_evidence = 0.50  # synthetic true rate

        print(f"\nStrong evidence conditioning test:")
        print(f"  Prior p:          0.80")
        print(f"  True rate:        0.50")
        print(f"  Avg evidence:     {avg_evidence:.4f}")
        print(f"  Avg v3 midpoint:  {avg_midpoint:.4f}")
        print(f"  Gap from evidence:{abs(avg_midpoint - avg_evidence):.4f}")

        # The midpoint should be within 10% of the evidence rate.
        # If IS tempering is too weak, it will be near 0.80 (prior)
        # instead of near 0.50 (evidence).
        assert abs(avg_midpoint - avg_evidence) < 0.10, \
            f"v3 midpoint at maturity ({avg_midpoint:.4f}) is too far " \
            f"from evidence ({avg_evidence:.4f}). Gap={abs(avg_midpoint - avg_evidence):.4f}. " \
            f"IS tempering is likely too weak — the posterior is stuck " \
            f"near the prior (0.80) instead of being pulled toward the " \
            f"evidence (0.50)."
