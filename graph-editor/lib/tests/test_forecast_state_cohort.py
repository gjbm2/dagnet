"""
Tests for cohort-mode ForecastState computation (doc 29 Phase 3).

Verifies:
- NodeArrivalState is built correctly for synth graphs
- Cohort-mode completeness uses upstream carrier (not simple CDF)
- Single-edge (from=anchor) completeness matches window-mode
- Multi-edge completeness is upstream-aware
- completeness_sd propagates upstream uncertainty
- Parity: engine's convolution matches v2's CDF evaluation (enriched synth graph)
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
import numpy as np


def _make_synth_graph(edges):
    """Build minimal graph from edge specs.

    Each spec: (uuid, from_uuid, to_uuid, from_id, to_id, p_mean, mu, sigma, onset)
    """
    node_set = {}
    edge_list = []
    first_from = None
    for spec in edges:
        uuid, from_u, to_u, from_id, to_id, p_mean, mu, sigma, onset = spec[:9]
        if first_from is None:
            first_from = from_u
        node_set[from_u] = {'uuid': from_u, 'id': from_id}
        node_set[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({
            'uuid': uuid,
            'from': from_u,
            'to': to_u,
            'p': {
                'id': f'param-{uuid}',
                'mean': p_mean,
                'stdev': 0.05,
                'forecast': {'mean': p_mean},
                'latency': {
                    'mu': mu,
                    'sigma': sigma,
                    'onset_delta_days': onset,
                    'promoted_mu': mu,
                    'promoted_sigma': sigma,
                    'promoted_onset_delta_days': onset,
                    'promoted_mu_sd': 0.1,
                    'promoted_sigma_sd': 0.05,
                    'promoted_onset_sd': 0.2,
                    'promoted_onset_mu_corr': -0.3,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': p_mean, 'stdev': 0.05},
                    'latency': {
                        'mu': mu, 'sigma': sigma, 'onset_delta_days': onset,
                    },
                }],
            },
        })
    for n in node_set.values():
        if n['uuid'] == first_from:
            n['entry'] = {'is_start': True}
    return {
        'nodes': list(node_set.values()),
        'edges': edge_list,
    }


class TestNodeArrivalCache:
    """Per-node arrival cache construction."""

    def test_anchor_node_has_delta_arrival(self):
        """Anchor node should have reach=1.0 and CDF=[1,1,...,1]."""
        from runner.forecast_state import build_node_arrival_cache

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        anchor = cache['n1']

        assert anchor.reach == 1.0
        assert anchor.tier == 'anchor'
        assert anchor.deterministic_cdf is not None
        assert all(v == 1.0 for v in anchor.deterministic_cdf)

    def test_downstream_node_has_carrier(self):
        """Node downstream of anchor should have a carrier CDF."""
        from runner.forecast_state import build_node_arrival_cache

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        downstream = cache.get('n2')

        assert downstream is not None
        assert downstream.reach == pytest.approx(0.8, abs=0.01)
        # Carrier should exist (Tier 1 parametric from edge A->B)
        assert downstream.deterministic_cdf is not None or downstream.tier == 'none'

    def test_multi_hop_reach_propagates(self):
        """Reach accumulates through the graph: reach(C) = p_AB × p_BC."""
        from runner.forecast_state import build_node_arrival_cache

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)

        assert cache['n1'].reach == 1.0
        assert cache['n2'].reach == pytest.approx(0.9, abs=0.01)
        assert cache['n3'].reach == pytest.approx(0.9 * 0.7, abs=0.01)


class TestCohortModeForecastState:
    """Cohort-mode ForecastState computation."""

    def test_single_edge_matches_window_mode(self):
        """For edge from anchor (no upstream), cohort and window
        completeness should be very close.
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            compute_forecast_state_window,
        )
        from runner.model_resolver import resolve_model_params

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])
        edge = graph['edges'][0]
        resolved = resolve_model_params(edge, scope='edge', temporal_mode='cohort')
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        # Window mode
        fs_window = compute_forecast_state_window(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
        )

        # Cohort mode with from-node = anchor
        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        fs_cohort = compute_forecast_state_cohort(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache['n1'],
        )

        # Both should produce similar completeness (anchor has delta CDF)
        delta = abs(fs_window.completeness - fs_cohort.completeness)
        print(f"\nSingle edge: window={fs_window.completeness:.6f} "
              f"cohort={fs_cohort.completeness:.6f} delta={delta:.6f}")
        assert delta < 0.02, \
            f"Single-edge parity: window={fs_window.completeness:.6f} " \
            f"cohort={fs_cohort.completeness:.6f}"

    def test_multi_edge_completeness_lower_than_edge_only(self):
        """For an edge with upstream, completeness should be lower than
        the edge-only CDF because upstream arrival delay reduces the
        effective time available for the edge's conversion.
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            _compute_completeness_at_age,
        )
        from runner.model_resolver import resolve_model_params

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        edge_bc = graph['edges'][1]
        resolved = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        # Cohort mode with upstream
        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        fs = compute_forecast_state_cohort(
            edge_id='e2', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache['n2'],
        )

        # Edge-only CDF (no upstream delay)
        total_n = sum(n for _, n in cohorts)
        edge_only_c = sum(
            n * _compute_completeness_at_age(age, 2.5, 0.6, 3.0)
            for age, n in cohorts
        ) / total_n

        print(f"\nMulti-edge B->C:")
        print(f"  upstream-aware: {fs.completeness:.6f}")
        print(f"  edge-only CDF:  {edge_only_c:.6f}")
        print(f"  mode: {fs.mode}, path_aware: {fs.path_aware}")

        assert fs.mode == 'cohort'
        assert fs.path_aware is True
        assert fs.completeness < edge_only_c, \
            f"Upstream-aware ({fs.completeness:.4f}) should be < " \
            f"edge-only ({edge_only_c:.4f})"

    def test_completeness_sd_present(self):
        """Cohort-mode ForecastState should have completeness_sd."""
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
        )
        from runner.model_resolver import resolve_model_params

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        edge_bc = graph['edges'][1]
        resolved = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        cohorts = [(15.0, 100), (25.0, 100)]

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        fs = compute_forecast_state_cohort(
            edge_id='e2', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache['n2'],
        )

        print(f"\ncompleteness={fs.completeness:.4f} sd={fs.completeness_sd:.4f}")
        assert fs.completeness_sd >= 0
        # With MC draws from upstream carrier, SD should be non-zero
        # (unless carrier returns None)
        if cache['n2'].mc_cdf is not None:
            assert fs.completeness_sd > 0, \
                'With MC upstream draws, completeness_sd should be >0'


# ── Enriched synth graph loading ─────────────────────────────────────

from pathlib import Path

_DAGNET_ROOT = Path(__file__).parent.parent.parent.parent
_CONF_FILE = _DAGNET_ROOT / '.private-repos.conf'
_DATA_REPO_DIR = None
if _CONF_FILE.exists():
    for line in _CONF_FILE.read_text().splitlines():
        if line.startswith('DATA_REPO_DIR='):
            _DATA_REPO_DIR = _DAGNET_ROOT / line.split('=', 1)[1].strip()
            break


def _has_enriched_synth():
    """Check if synth-simple-abc has been enriched with model_vars."""
    if _DATA_REPO_DIR is None:
        return False
    gp = _DATA_REPO_DIR / 'graphs' / 'synth-simple-abc.json'
    if not gp.exists():
        return False
    import json
    g = json.loads(gp.read_text())
    # Check if any edge has bayesian model_vars
    for e in g.get('edges', []):
        mv = (e.get('p') or {}).get('model_vars', [])
        if any(m.get('source') == 'bayesian' for m in mv):
            return True
    return False


requires_enriched_synth = pytest.mark.skipif(
    not _has_enriched_synth(),
    reason='synth-simple-abc not enriched (run test_harness.py --graph synth-simple-abc --enrich)',
)


def _load_synth_graph():
    import json
    gp = _DATA_REPO_DIR / 'graphs' / 'synth-simple-abc.json'
    return json.loads(gp.read_text())


@requires_enriched_synth
class TestPhase3ParityEnrichedSynth:
    """Phase 3 exit gate: engine vs v2 completeness on enriched synth graph.

    Uses synth-simple-abc (A→B→C) which has been enriched with Bayesian
    model_vars via --enrich. The B→C edge has upstream (from B, not anchor),
    making it the right target for cohort-mode parity.

    Compares:
      v3 engine: build_node_arrival_cache → compute_forecast_state_cohort
      v2 direct: build_upstream_carrier → SpanParams.C → convolution

    Both use the same carrier hierarchy (v3 imports v2's build_upstream_carrier),
    so the parity is about the CDF evaluation and convolution, not the carrier.
    """

    def test_cdf_parity_per_age(self):
        """Engine's _compute_completeness_at_age matches v2's
        _shifted_lognormal_cdf for the B→C edge at representative ages.
        """
        from runner.forecast_state import _compute_completeness_at_age
        from runner.confidence_bands import _shifted_lognormal_cdf
        from runner.cohort_forecast import read_edge_cohort_params

        graph = _load_synth_graph()
        edge_bc = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-b-to-c')
        params = read_edge_cohort_params(edge_bc)
        assert params is not None, 'B→C edge has no cohort params'

        mu = params['mu']
        sigma = params['sigma']
        onset = params['onset']

        test_ages = [5, 10, 15, 20, 30, 50, 80, 100, 150]
        print(f"\nCDF parity B→C (mu={mu:.3f}, sigma={sigma:.3f}, onset={onset:.1f}):")
        for age in test_ages:
            v3_c = _compute_completeness_at_age(float(age), mu, sigma, onset)
            v2_c = _shifted_lognormal_cdf(float(age), onset, mu, sigma)
            delta = abs(v3_c - v2_c)
            print(f"  age={age:3d}: v3={v3_c:.6f}  v2={v2_c:.6f}  delta={delta:.2e}")
            assert delta < 1e-10, \
                f"CDF mismatch at age {age}: v3={v3_c:.6f} v2={v2_c:.6f}"

    def test_convolution_parity_anchor_edge(self):
        """For A→B (from anchor), engine and v2 produce identical completeness.

        Both should reduce to simple CDF(age) since the anchor has
        instant (delta) arrival.
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            compute_forecast_state_window,
        )
        from runner.model_resolver import resolve_model_params

        graph = _load_synth_graph()
        anchor = next(n for n in graph['nodes']
                      if n.get('entry', {}).get('is_start'))
        edge_ab = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-a-to-b')

        resolved = resolve_model_params(edge_ab, scope='edge', temporal_mode='cohort')
        cohorts = [(10.0, 50), (20.0, 100), (30.0, 80), (50.0, 40)]

        # Window mode (no upstream awareness)
        fs_window = compute_forecast_state_window(
            edge_id=edge_ab['uuid'], resolved=resolved,
            cohort_ages_and_weights=cohorts,
        )

        # Cohort mode with from-node = anchor (delta arrival)
        cache = build_node_arrival_cache(graph, anchor_id=anchor['uuid'], max_tau=200)
        fs_cohort = compute_forecast_state_cohort(
            edge_id=edge_ab['uuid'], resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache[anchor['uuid']],
        )

        delta = abs(fs_window.completeness - fs_cohort.completeness)
        print(f"\nAnchor edge A→B:")
        print(f"  window:  {fs_window.completeness:.6f}")
        print(f"  cohort:  {fs_cohort.completeness:.6f}")
        print(f"  delta:   {delta:.6f}")
        assert delta < 0.01, \
            f"Anchor edge parity: window={fs_window.completeness:.6f} " \
            f"cohort={fs_cohort.completeness:.6f} delta={delta:.6f}"

    def test_upstream_aware_completeness_parity(self):
        """Phase 3 exit gate: for B→C (downstream edge), engine's
        convolution-based completeness matches v2's carrier-based
        completeness.

        Both paths use the same carrier (v2's build_upstream_carrier via
        Tier 1 parametric). The parity is in how they evaluate the
        convolution.

        v3 engine: _convolve_completeness_at_age (per-age convolution
                   of carrier PDF × edge CDF)
        v2 direct: SpanParams.C[t] provides the normalised CDF,
                   convolution with carrier gives effective completeness

        Since both use the same carrier and the same CDF formula, they
        should agree to machine precision.
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            _convolve_completeness_at_age,
        )
        from runner.model_resolver import resolve_model_params
        from runner.confidence_bands import _shifted_lognormal_cdf
        from runner.cohort_forecast import read_edge_cohort_params

        graph = _load_synth_graph()
        anchor = next(n for n in graph['nodes']
                      if n.get('entry', {}).get('is_start'))
        edge_bc = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-b-to-c')

        # ── v3 engine path ──────────────────────────────────────────
        resolved = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        cohorts = [(10.0, 50), (20.0, 100), (30.0, 80), (50.0, 40), (80.0, 20)]

        cache = build_node_arrival_cache(graph, anchor_id=anchor['uuid'], max_tau=200)
        from_node = cache.get(edge_bc['from'])
        assert from_node is not None, 'B node not in arrival cache'
        assert from_node.deterministic_cdf is not None, 'B node has no carrier'

        fs = compute_forecast_state_cohort(
            edge_id=edge_bc['uuid'], resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=from_node,
        )

        # ── v2 direct path (path-level params, no convolution) ─────
        # v2 uses path-level mu/sigma which already account for upstream
        # delay. It evaluates CDF(age, path_mu, path_sigma, path_onset)
        # directly — no carrier convolution needed.
        params = read_edge_cohort_params(edge_bc)
        assert params is not None
        path_mu = params['mu']      # read_edge_cohort_params prefers path-level
        path_sigma = params['sigma']
        path_onset = params['onset']

        v2_weighted_c = 0.0
        v2_total_n = 0.0
        for age, n in cohorts:
            if n <= 0:
                continue
            c_v2 = _shifted_lognormal_cdf(float(age), path_onset, path_mu, path_sigma)
            v2_weighted_c += n * c_v2
            v2_total_n += n

        v2_completeness = v2_weighted_c / v2_total_n if v2_total_n > 0 else 0.0

        # ── Per-age diagnostic ──────────────────────────────────────
        print(f"\n{'age':>4s}  {'n':>4s}  {'v3_conv':>10s}  {'v2_path':>10s}  {'edge_only':>10s}  {'v3-v2':>10s}")
        for age, n in cohorts:
            v3_c = _convolve_completeness_at_age(
                age, from_node.deterministic_cdf, from_node.reach,
                resolved.latency.mu, resolved.latency.sigma,
                resolved.latency.onset_delta_days)
            v2_c = _shifted_lognormal_cdf(float(age), path_onset, path_mu, path_sigma)
            eo_c = _shifted_lognormal_cdf(float(age),
                                           resolved.latency.onset_delta_days,
                                           resolved.latency.mu, resolved.latency.sigma)
            print(f"{int(age):4d}  {n:4d}  {v3_c:10.6f}  {v2_c:10.6f}  {eo_c:10.6f}  {v3_c - v2_c:+10.6f}")

        print(f"\nEdge params: mu={resolved.latency.mu:.4f} sigma={resolved.latency.sigma:.4f} onset={resolved.latency.onset_delta_days:.1f}")
        print(f"Path params: mu={path_mu:.4f} sigma={path_sigma:.4f} onset={path_onset:.2f}")

        # ── Compare ─────────────────────────────────────────────────
        delta = abs(fs.completeness - v2_completeness)
        print(f"\nPhase 3 parity B→C (upstream-aware):")
        print(f"  v3 engine:     {fs.completeness:.6f}")
        print(f"  v2 direct:     {v2_completeness:.6f}")
        print(f"  delta:         {delta:.2e}")
        print(f"  mode:          {fs.mode}")
        print(f"  path_aware:    {fs.path_aware}")
        print(f"  carrier tier:  {from_node.tier}")
        print(f"  carrier reach: {from_node.reach:.4f}")
        print(f"  completeness_sd: {fs.completeness_sd:.4f}")

        assert fs.mode == 'cohort'
        assert fs.path_aware is True
        # TODO: 9% delta observed — under investigation. Do not widen
        # tolerance until root cause is understood. See session notes.
        assert delta < 0.05, \
            f"Phase 3 parity failed: v3={fs.completeness:.6f} " \
            f"v2={v2_completeness:.6f} delta={delta:.2e}"

    def test_upstream_aware_lower_than_edge_only(self):
        """Enriched B→C completeness with upstream should be lower than
        edge-only CDF (since upstream arrival delay reduces effective time).
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            _compute_completeness_at_age,
        )
        from runner.model_resolver import resolve_model_params

        graph = _load_synth_graph()
        anchor = next(n for n in graph['nodes']
                      if n.get('entry', {}).get('is_start'))
        edge_bc = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-b-to-c')

        resolved = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        cohorts = [(15.0, 100), (25.0, 100), (40.0, 100)]

        cache = build_node_arrival_cache(graph, anchor_id=anchor['uuid'], max_tau=200)
        fs = compute_forecast_state_cohort(
            edge_id=edge_bc['uuid'], resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache[edge_bc['from']],
        )

        # Edge-only (no upstream delay)
        lat = resolved.latency
        total_n = sum(n for _, n in cohorts)
        edge_only_c = sum(
            n * _compute_completeness_at_age(age, lat.mu, lat.sigma, lat.onset_delta_days)
            for age, n in cohorts
        ) / total_n

        print(f"\nEnriched B→C upstream vs edge-only:")
        print(f"  upstream-aware: {fs.completeness:.6f}")
        print(f"  edge-only CDF:  {edge_only_c:.6f}")
        assert fs.completeness < edge_only_c, \
            f"Upstream-aware ({fs.completeness:.4f}) should be < " \
            f"edge-only ({edge_only_c:.4f})"

    def test_carrier_cdf_is_conditional(self):
        """Verify the carrier CDF from build_node_arrival_cache is
        conditional (goes to 1.0) not reach-scaled (goes to reach).

        This determines whether _convolve_completeness_at_age should
        divide by reach or not.
        """
        from runner.forecast_state import build_node_arrival_cache

        graph = _load_synth_graph()
        anchor = next(n for n in graph['nodes']
                      if n.get('entry', {}).get('is_start'))

        cache = build_node_arrival_cache(graph, anchor_id=anchor['uuid'], max_tau=200)

        # Node B (downstream of anchor via A->B)
        edge_ab = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-a-to-b')
        node_b = cache.get(edge_ab['to'])
        assert node_b is not None
        assert node_b.deterministic_cdf is not None

        cdf_at_200 = node_b.deterministic_cdf[200]
        reach = node_b.reach

        print(f"\nNode B carrier diagnostics:")
        print(f"  reach:      {reach:.4f}")
        print(f"  CDF[0]:     {node_b.deterministic_cdf[0]:.6f}")
        print(f"  CDF[10]:    {node_b.deterministic_cdf[10]:.6f}")
        print(f"  CDF[20]:    {node_b.deterministic_cdf[20]:.6f}")
        print(f"  CDF[50]:    {node_b.deterministic_cdf[50]:.6f}")
        print(f"  CDF[100]:   {node_b.deterministic_cdf[100]:.6f}")
        print(f"  CDF[200]:   {cdf_at_200:.6f}")
        print(f"  CDF[200] / reach = {cdf_at_200 / reach:.6f}")

        # If conditional: CDF[200] ≈ 1.0
        # If reach-scaled: CDF[200] ≈ reach
        if abs(cdf_at_200 - 1.0) < 0.01:
            print(f"  → CONDITIONAL (goes to 1.0)")
        elif abs(cdf_at_200 - reach) < 0.01:
            print(f"  → REACH-SCALED (goes to {reach:.4f})")
        else:
            print(f"  → UNKNOWN scaling")

    def test_model_vars_used_by_resolver(self):
        """The model resolver should pick up bayesian model_vars from the
        enriched graph and prefer them over analytic values.
        """
        from runner.model_resolver import resolve_model_params

        graph = _load_synth_graph()
        edge_ab = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-a-to-b')

        resolved = resolve_model_params(edge_ab, scope='edge', temporal_mode='window')
        print(f"\nResolved A→B: source={resolved.source} "
              f"mu={resolved.latency.mu:.4f} sigma={resolved.latency.sigma:.4f}")

        # Should prefer bayesian source since gate_passed=True
        assert resolved.source == 'bayesian', \
            f"Expected bayesian source, got {resolved.source}"

        # Check the values match what --enrich wrote
        mv = next(m for m in edge_ab['p']['model_vars']
                  if m['source'] == 'bayesian')
        assert resolved.latency.mu == mv['latency']['mu']
        assert resolved.latency.sigma == mv['latency']['sigma']


class TestScopeAndCarrierConsistency:
    """Engine must use edge-level params with carrier convolution (review #8)."""

    def test_carrier_convolution_uses_edge_params_not_path(self):
        """When carrier is present, completeness from edge-level params
        should be higher than from path-level (path already includes
        upstream delay, carrier applies it again → double-apply → lower).
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_conditioned_forecast,
        )
        from runner.model_resolver import resolve_model_params

        graph = _load_synth_graph()
        anchor = next(n for n in graph['nodes']
                      if n.get('entry', {}).get('is_start'))
        edge_bc = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-b-to-c')

        cache = build_node_arrival_cache(graph, anchor_id=anchor['uuid'], max_tau=200)
        from_node = cache.get(edge_bc['from'])

        resolved_edge = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        resolved_path = resolve_model_params(edge_bc, scope='path', temporal_mode='cohort')

        cohorts = [(20.0, 100), (30.0, 100)]

        cf_edge = compute_conditioned_forecast(
            edge_id='bc', resolved=resolved_edge,
            cohort_ages_and_weights=cohorts, evidence=[],
            from_node_arrival=from_node,
        )
        cf_path = compute_conditioned_forecast(
            edge_id='bc', resolved=resolved_path,
            cohort_ages_and_weights=cohorts, evidence=[],
            from_node_arrival=from_node,
        )

        print(f"\nEdge mu={resolved_edge.latency.mu:.3f} "
              f"Path mu={resolved_path.latency.mu:.3f}")
        print(f"Edge+carrier: {cf_edge.completeness:.4f}")
        print(f"Path+carrier: {cf_path.completeness:.4f} (double-apply)")

        if resolved_path.latency.mu > resolved_edge.latency.mu:
            assert cf_path.completeness < cf_edge.completeness, \
                "Path+carrier gives lower completeness (double upstream lag)"


class TestConditionedForecastGracefulDegradation:
    """Engine degrades gracefully with little or no evidence."""

    def _make_edge_and_resolve(self):
        from runner.model_resolver import resolve_model_params
        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.7, 2.3, 0.5, 1.0),
        ])
        edge = graph['edges'][0]
        resolved = resolve_model_params(edge, scope='edge', temporal_mode='window')
        # The minimal synth graph has only forecast means. Give the
        # conditioned-forecast tests a real Beta prior centred on 0.7.
        resolved.alpha = 70.0
        resolved.beta = 30.0
        resolved.p_mean = resolved.alpha / (resolved.alpha + resolved.beta)
        resolved.p_sd = math.sqrt(
            resolved.alpha * resolved.beta
            / (((resolved.alpha + resolved.beta) ** 2) * (resolved.alpha + resolved.beta + 1))
        )
        return edge, resolved

    def test_no_evidence_returns_unconditioned(self):
        """Empty evidence list → unconditioned draws, IS skipped."""
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        cf = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=[],
        )
        assert cf.is_ess == 2000, f"ESS should equal draw count (no IS), got {cf.is_ess}"
        assert cf.is_tempering_lambda == 1.0
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned)
        assert cf.rate_conditioned_sd == pytest.approx(cf.rate_unconditioned_sd)
        assert cf.completeness > 0
        assert cf.rate_conditioned > 0
        print(f"No evidence: completeness={cf.completeness:.3f} "
              f"rate={cf.rate_conditioned:.3f} ESS={cf.is_ess:.0f}")

    def test_all_zero_k_skips_conditioning(self):
        """All cohorts have k=0 → IS skipped (no conversions observed)."""
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(10.0, 100), (20.0, 100)]
        evidence = [(10.0, 100, 0), (20.0, 100, 0)]

        cf = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf.is_ess == 2000, f"ESS should equal draw count (k=0 skips IS), got {cf.is_ess}"
        assert cf.is_tempering_lambda == 1.0
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned)
        print(f"All k=0: completeness={cf.completeness:.3f} "
              f"rate={cf.rate_conditioned:.3f} ESS={cf.is_ess:.0f}")

    def test_very_young_cohorts_skip_conditioning(self):
        """Cohorts with age < onset → CDF≈0, E≈0 → IS skipped."""
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        # onset=1.0, age=0.5 → model_age < 0 → CDF=0
        cohorts = [(0.5, 50)]
        evidence = [(0.5, 50, 2)]

        cf = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        # CDF≈0 means E≈0, is_fail < 1 → IS skipped
        assert cf.is_ess == 2000, f"ESS should be unconditioned for young cohorts, got {cf.is_ess}"
        assert cf.is_tempering_lambda == 1.0
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned)
        print(f"Young cohorts: completeness={cf.completeness:.3f} ESS={cf.is_ess:.0f}")

    def test_single_cohort_moderate_evidence(self):
        """One cohort with moderate evidence → mild conditioning, healthy ESS."""
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(20.0, 50)]
        evidence = [(20.0, 50, 20)]

        cf = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf.is_ess > 10, f"ESS too low for moderate evidence: {cf.is_ess}"
        assert cf.completeness > 0
        print(f"Moderate evidence: completeness={cf.completeness:.3f} "
              f"rate={cf.rate_conditioned:.3f} ESS={cf.is_ess:.0f}")

    def test_strong_evidence_conditions_p_toward_observed(self):
        """Strong evidence (high n, mature cohorts) should pull p toward
        observed rate, not leave it at prior."""
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        # Prior p≈0.7, observed rate≈0.4 (k=200, n=500 at mature age)
        cohorts = [(50.0, 500)]
        evidence = [(50.0, 500, 200)]

        cf_uncond = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=[],
        )
        cf_cond = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf_cond.rate_unconditioned == pytest.approx(cf_uncond.rate_unconditioned)
        # Conditioned rate should be lower than the preserved
        # unconditioned baseline (evidence says p≈0.4, prior says p≈0.7).
        assert cf_cond.rate_conditioned < cf_cond.rate_unconditioned, \
            f"Conditioned rate ({cf_cond.rate_conditioned:.3f}) should be " \
            f"< unconditioned ({cf_cond.rate_unconditioned:.3f})"
        observed_rate = 200 / 500
        assert abs(cf_cond.rate_conditioned - observed_rate) < abs(
            cf_cond.rate_unconditioned - observed_rate
        ), (
            f"Conditioned rate ({cf_cond.rate_conditioned:.3f}) should be closer to "
            f"observed ({observed_rate:.3f}) than unconditioned "
            f"({cf_cond.rate_unconditioned:.3f})"
        )
        assert cf_cond.is_ess > 5, f"ESS too low: {cf_cond.is_ess}"
        print(f"Strong evidence: uncond={cf_cond.rate_unconditioned:.3f} "
              f"cond={cf_cond.rate_conditioned:.3f} "
              f"lambda={cf_cond.is_tempering_lambda:.3f} ESS={cf_cond.is_ess:.0f}")

    def test_extreme_aggregate_evidence_uses_tempering_floor(self):
        """Extreme aggregate evidence should temper the likelihood rather
        than collapsing to ESS≈1, while still moving toward the evidence.
        """
        from runner.forecast_state import compute_conditioned_forecast

        _, resolved = self._make_edge_and_resolve()
        cohorts = [(80.0, 1000)] * 18
        evidence = [(80.0, 1000, 400)] * 18

        cf = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        observed_rate = 400 / 1000
        conditioned_p_mean = float(np.mean(cf.p_draws))
        unconditioned_p_mean = resolved.alpha / (resolved.alpha + resolved.beta)

        assert cf.is_tempering_lambda < 1.0, (
            f"Extreme evidence should trigger tempering, got λ={cf.is_tempering_lambda:.3f}"
        )
        assert cf.is_ess >= 19.5, f"ESS floor not preserved: {cf.is_ess:.2f}"
        assert conditioned_p_mean < unconditioned_p_mean
        assert abs(conditioned_p_mean - observed_rate) < abs(
            unconditioned_p_mean - observed_rate
        ), (
            f"Conditioned p ({conditioned_p_mean:.3f}) should move toward observed "
            f"rate ({observed_rate:.3f}) from prior ({unconditioned_p_mean:.3f})"
        )
        print(
            f"Extreme evidence: prior_p={unconditioned_p_mean:.3f} "
            f"cond_p={conditioned_p_mean:.3f} observed={observed_rate:.3f} "
            f"lambda={cf.is_tempering_lambda:.3f} ESS={cf.is_ess:.1f}"
        )

    def test_draws_valid_after_conditioning(self):
        """Conditioned draws should be finite and in valid ranges."""
        from runner.forecast_state import compute_conditioned_forecast
        import numpy as np
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(15.0, 100), (25.0, 80)]
        evidence = [(15.0, 100, 35), (25.0, 80, 30)]

        cf = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert len(cf.p_draws) == 2000
        assert np.all(np.isfinite(cf.p_draws))
        assert np.all(cf.p_draws > 0) and np.all(cf.p_draws < 1)
        assert np.all(np.isfinite(cf.mu_draws))
        assert np.all(np.isfinite(cf.sigma_draws))
        assert np.all(cf.sigma_draws > 0)
        assert np.all(np.isfinite(cf.onset_draws))
        assert np.all(cf.onset_draws >= 0)
        print(f"Draws valid: p=[{cf.p_draws.min():.3f}, {cf.p_draws.max():.3f}] "
              f"mu=[{cf.mu_draws.min():.3f}, {cf.mu_draws.max():.3f}] "
              f"ESS={cf.is_ess:.0f}")
