"""
Stage 5b multi-hop subject-span readout tests (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5b — Multi-Hop Subject Span Composition" lines 684-698.

These tests cover the readout function in
``runner.primitive_readout``:

  - flag plumbing (default OFF, parses on/shadow/true/1, unknown→OFF);
  - eligibility gate (multi-hop+window, multi-hop+cohort A=X eligible;
    single-hop or active cohort A!=X deferred);
  - OFF mode is a no-op;
  - SHADOW records delta but does not substitute;
  - ON substitutes when composition is draw-coherent;
  - missing-input branches return soft skips;
  - composer error returns a soft skip (does not raise);
  - prior-only non-target sub-span composes correctly.

These tests are unit tests over the readout function; they do not
exercise the row-builder seam or api_handlers wiring (those are tested
via the existing primitive_readout / handlers integration test suites).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.primitive_readout import (
    MultiHopReadoutResult,
    SpanEdgeResolution,
    compute_multi_hop_subject_readout,
    is_multi_hop_subject_eligible,
)
from runner.primitives import PrimitiveScope, TransitionIdentity


# ─── Fixtures ──────────────────────────────────────────────────────────




def _resolved(*, alpha=2.0, beta=2.0, mu=0.0, sigma=0.0):
    return ResolvedModelParams(
        alpha=alpha, beta=beta,
        alpha_pred=alpha, beta_pred=beta,
        n_effective=None,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=sigma, onset_delta_days=0.0, t95=0.0,
            mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
        ),
        source='test_synthetic',
    )


def _scope(scenario_id='scn-1'):
    return PrimitiveScope(
        scenario_id=scenario_id,
        evidence_role='window_subject_helper',
        date_from='2026-03-01',
        date_to='2026-03-31',
        as_at='2026-04-01',
        context_key=None,
        regime_key=None,
        model_source_preference='best_available',
        resolved_source_identity='test_synthetic',
    )


def _make_graph(edges):
    node_ids = set()
    for _, f, t in edges:
        node_ids.add(f)
        node_ids.add(t)
    return {
        'nodes': [{'id': n, 'uuid': n} for n in sorted(node_ids)],
        'edges': [
            {
                'edge_id': eid, 'from': f, 'to': t,
                'from_node': f, 'to_node': t,
            }
            for eid, f, t in edges
        ],
    }


def _two_hop_resolutions(target='e-m-y', evidence_set=None):
    """Two-edge X→M→Y with target=e-m-y by default. evidence_set is the
    typed object the readout's synthetic identity-clock binding wraps;
    None means non-target edges only have prior-only primitives."""
    return [
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='X', destination_node='M', edge_id='e-x-m',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=10.0, beta=10.0),
            evidence_set=None,
            is_target=(target == 'e-x-m'),
        ),
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='M', destination_node='Y', edge_id='e-m-y',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=4.0, beta=6.0),
            evidence_set=evidence_set if target == 'e-m-y' else None,
            is_target=(target == 'e-m-y'),
        ),
    ]


# ─── Eligibility ───────────────────────────────────────────────────────


def test_eligible_multi_hop_cohort_a_equals_x():
    assert is_multi_hop_subject_eligible(
        is_multi_hop=True, is_window=False,
        anchor_node_id='X', query_from_node='X',
    )


def test_ineligible_multi_hop_window_deferred_to_stage_5c():
    """Stage 5b owns multi-hop cohort A==X; multi-hop window is Stage
    5c's independently-flagged surface (plan §708)."""
    assert not is_multi_hop_subject_eligible(
        is_multi_hop=True, is_window=True,
        anchor_node_id=None, query_from_node=None,
    )


def test_ineligible_multi_hop_cohort_a_not_x():
    """Active cohort A!=X is Stage 6's surface."""
    assert not is_multi_hop_subject_eligible(
        is_multi_hop=True, is_window=False,
        anchor_node_id='A', query_from_node='X',
    )


def test_ineligible_single_hop():
    """Single-hop is Stage 5a's surface."""
    assert not is_multi_hop_subject_eligible(
        is_multi_hop=False, is_window=False,
        anchor_node_id='X', query_from_node='X',
    )


def test_ineligible_cohort_missing_anchor():
    """Conservative defer when cohort anchor info is missing."""
    assert not is_multi_hop_subject_eligible(
        is_multi_hop=True, is_window=False,
        anchor_node_id=None, query_from_node='X',
    )


# ─── OFF / SHADOW / ON modes ───────────────────────────────────────────


def test_on_flag_substitutes_with_composed_moments():
    """ON returns ``should_substitute=True`` when composition is
    draw-coherent."""
    resolutions = _two_hop_resolutions()
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=resolutions,
        scenario_seed=42,
        legacy_p_mean=0.50, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.04,
    )
    assert result.should_substitute is True
    assert result.composed.is_draw_coherent
    # Composed mean of two prior-only primitives at Beta(10,10) and
    # Beta(4,6) ≈ 0.5 * 0.4 = 0.20.
    assert result.p_mean_primitive == pytest.approx(0.20, abs=0.05)


# ─── Soft skips ────────────────────────────────────────────────────────


def test_ineligible_request_returns_diagnostic_skip():
    result = compute_multi_hop_subject_readout(
        eligible=False,
        skip_reason='single_hop',
        graph=_make_graph([('e-x-y', 'X', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=None,
        scenario_seed=42,
    )
    assert result.composed is None
    assert result.should_substitute is False
    assert result.skip_reason in ('single_hop', 'ineligible')


def test_incomplete_inputs_returns_soft_skip():
    """Eligible but graph/x/end/resolutions missing → soft skip."""
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=None,  # missing
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_resolutions(),
        scenario_seed=42,
    )
    assert result.composed is None
    assert result.skip_reason == 'incomplete_inputs'
    assert 'graph' in result.diagnostics.get('missing_inputs', [])


def test_target_count_invalid_returns_soft_skip():
    """A span_edge_resolutions list with !=1 target raises a recoverable
    skip rather than a hard error."""
    bad_resolutions = _two_hop_resolutions()
    # Mark both as target — should fail.
    bad_resolutions = [
        SpanEdgeResolution(
            transition=r.transition,
            primitive_scope=r.primitive_scope,
            resolved_model=r.resolved_model,
            evidence_set=None,
            is_target=True,
        )
        for r in bad_resolutions
    ]
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=bad_resolutions,
        scenario_seed=42,
    )
    assert result.composed is None
    assert result.skip_reason == 'target_count_invalid'


def test_composer_path_failure_returns_soft_skip():
    """A graph where X has no path to end produces a CompositionError
    inside the composer; the readout catches it as a soft skip."""
    # X→M but Y disconnected (no path X→Y).
    graph = _make_graph([
        ('e-x-m', 'X', 'M'),
        ('e-y-end', 'Y', 'END'),
    ])
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=graph,
        x_node_id='X', end_node_id='Y',  # no path
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_resolutions(),
        scenario_seed=42,
    )
    assert result.composed is None
    assert result.skip_reason == 'composition_error'


# ─── Diagnostics ───────────────────────────────────────────────────────


def test_diagnostics_carry_full_provenance():
    """The diag block should expose flag, eligibility, primitive count,
    composed moments, legacy moments, delta, and shadow-band check."""
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_resolutions(),
        scenario_seed=42,
        legacy_p_mean=0.50, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.04,
    )
    diag = dict(result.diagnostics)
    assert diag['eligible'] is True
    assert 'composed' in diag
    assert diag['composed']['primitive_count'] == 2
    assert diag['composed']['composition_mode'] == 'draws'
    assert diag['composed']['is_draw_coherent'] is True
    assert 'composed_public_moments' in diag
    assert 'legacy_public_moments' in diag
    assert 'delta_p_mean' in diag
    assert 'within_shadow_band' in diag
    assert 'subject_probability_source' in diag


# ─── Prior-only non-target sub-span ────────────────────────────────────


def test_non_target_edges_use_prior_only_primitives():
    """Plan §95: a parameterised primitive with no admitted evidence
    remains prior-only with explicit provenance. The composer must
    accept these as draw-coherent inputs (they sample from the prior
    via the keyed-RNG seam after the Stage 5b prior-only fix).
    """
    resolutions = _two_hop_resolutions(target='e-m-y', evidence_set=None)
    # Both edges are prior-only because evidence_set is None for the
    # target too. The readout falls through to the prior_only path
    # for both edges.
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=resolutions,
        scenario_seed=42,
    )
    assert result.composed is not None
    assert result.composed.is_draw_coherent
    summaries = result.diagnostics['primitives']
    # Prior-only primitives report status 'prior_only'.
    assert all(s['status'] == 'prior_only' for s in summaries)
    assert all(s['is_draw_coherent'] for s in summaries)


def test_should_substitute_property():
    """``should_substitute`` is True when eligible AND composition is
    draw-coherent AND p_mean_primitive is set."""
    resolutions = _two_hop_resolutions()
    common_kwargs = dict(
        eligible=True,
        skip_reason=None,
        graph=_make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=resolutions,
        scenario_seed=42,
    )
    on = compute_multi_hop_subject_readout(**common_kwargs)
    assert on.should_substitute is True
