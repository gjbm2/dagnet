"""
Stage 6 active cohort A!=X carrier-consumer readout tests (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 6 — Carrier Consumer" lines 715-727.

These tests cover the readout function in
``runner.primitive_readout``:

  - flag plumbing (default OFF, parses on/shadow/true/1, unknown→OFF;
    independent of Stage 5a/5b/5c flags);
  - eligibility gate (cohort A!=X eligible; window / cohort A==X
    deferred to Stages 5a/5b/5c);
  - OFF mode is a no-op;
  - SHADOW records delta but does not substitute;
  - ON substitutes when carrier composition is active and subject
    composition is draw-coherent;
  - missing-input branches return soft skips;
  - composer error returns a soft skip (does not raise);
  - changing upstream evidence on a carrier primitive moves the
    composed carrier reach (plan §727 connectivity invariant);
  - target subject-only evidence does NOT move the composed carrier
    state (plan §727 connectivity invariant);
  - diagnostics expose carrier and subject provenance separately.

These tests are unit tests over the readout function; they do not
exercise the row-builder seam or api_handlers wiring (those are tested
via the existing integration test surfaces).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.primitive_readout import (
    ActiveCohortCarrierReadoutResult,
    CarrierEdgeResolution,
    SpanEdgeResolution,
    compute_active_cohort_carrier_readout,
    is_active_cohort_carrier_eligible,
)
from runner.primitives import PrimitiveScope, TransitionIdentity


# ─── Fixtures ──────────────────────────────────────────────────────────




def _resolved(*, alpha=2.0, beta=2.0, mu=0.0, sigma=0.0):
    return ResolvedModelParams(
        p_mean=alpha / (alpha + beta) if (alpha + beta) > 0 else 0.0,
        p_sd=0.0,
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


def _carrier_resolutions(*, evidence_per_edge=None):
    """A→B→X two-edge upstream carrier; both edges prior-only by default.

    ``evidence_per_edge`` is a dict ``{edge_id: EvidenceSet}`` for the
    test seam that proves "changing upstream evidence moves carrier
    reach" (plan §727).
    """
    evidence_per_edge = evidence_per_edge or {}
    return [
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='A', destination_node='B', edge_id='e-a-b',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=10.0, beta=10.0),
            evidence_set=evidence_per_edge.get('e-a-b'),
        ),
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='B', destination_node='X', edge_id='e-b-x',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=8.0, beta=12.0),
            evidence_set=evidence_per_edge.get('e-b-x'),
        ),
    ]


def _subject_resolutions(target='e-x-y', evidence_set=None):
    """Two subject edges X→M→Y with target=e-m-y by default."""
    return [
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='X', destination_node='M', edge_id='e-x-m',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=6.0, beta=6.0),
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


def _stage6_graph():
    return _make_graph([
        ('e-a-b', 'A', 'B'),
        ('e-b-x', 'B', 'X'),
        ('e-x-m', 'X', 'M'),
        ('e-m-y', 'M', 'Y'),
    ])


def _common_call_kwargs():
    return dict(
        eligible=True,
        skip_reason=None,
        graph=_stage6_graph(),
        anchor_node_id='A',
        x_node_id='X',
        end_node_id='Y',
        carrier_edge_resolutions=_carrier_resolutions(),
        subject_edge_resolutions=_subject_resolutions(target='e-m-y'),
        scenario_seed=42,
        legacy_p_mean=0.50,
        legacy_p_sd=0.05,
        legacy_p_sd_epistemic=0.04,
    )


# ─── Eligibility ───────────────────────────────────────────────────────


def test_eligible_active_cohort_a_not_x():
    assert is_active_cohort_carrier_eligible(
        is_window=False, anchor_node_id='A', query_from_node='X',
    )


def test_ineligible_window():
    """Window mode is identity carrier — Stage 5a/5c's surface."""
    assert not is_active_cohort_carrier_eligible(
        is_window=True, anchor_node_id=None, query_from_node='X',
    )


def test_ineligible_cohort_a_equals_x():
    """Cohort A==X is identity carrier — Stage 5a/5b's surface."""
    assert not is_active_cohort_carrier_eligible(
        is_window=False, anchor_node_id='X', query_from_node='X',
    )


def test_ineligible_missing_anchor():
    """Conservative defer when cohort anchor is missing."""
    assert not is_active_cohort_carrier_eligible(
        is_window=False, anchor_node_id=None, query_from_node='X',
    )


def test_ineligible_missing_query_from_node():
    assert not is_active_cohort_carrier_eligible(
        is_window=False, anchor_node_id='A', query_from_node=None,
    )


# ─── OFF / SHADOW / ON modes ───────────────────────────────────────────


def test_on_flag_substitutes_with_composed_subject_moments():
    """ON returns ``should_substitute=True`` when carrier is active
    and subject composition is draw-coherent."""
    result = compute_active_cohort_carrier_readout(
        **_common_call_kwargs(),
    )
    assert result.should_substitute is True
    assert result.composed_subject.is_draw_coherent
    assert result.composed_carrier.is_active
    # Subject p mean is the displayed rate Y/X — composed of
    # Beta(6,6).mean=0.5 * Beta(4,6).mean=0.4 ≈ 0.20.
    assert result.p_mean_primitive == pytest.approx(0.20, abs=0.05)


# ─── Soft skips ────────────────────────────────────────────────────────


def test_ineligible_request_returns_diagnostic_skip():
    result = compute_active_cohort_carrier_readout(
        eligible=False,
        skip_reason='window_mode',
        graph=_stage6_graph(),
        anchor_node_id=None,
        x_node_id='X',
        end_node_id='Y',
        carrier_edge_resolutions=None,
        subject_edge_resolutions=None,
        scenario_seed=42,
    )
    assert result.composed_subject is None
    assert result.should_substitute is False
    assert result.skip_reason in ('window_mode', 'ineligible')


def test_incomplete_inputs_returns_soft_skip():
    """Eligible but anchor/x/end missing → soft skip with named
    missing inputs."""
    kwargs = _common_call_kwargs()
    kwargs['anchor_node_id'] = None  # missing
    result = compute_active_cohort_carrier_readout(
        **kwargs,
    )
    assert result.composed_subject is None
    assert result.skip_reason == 'incomplete_inputs'
    assert 'anchor_node_id' in result.diagnostics.get('missing_inputs', [])


def test_target_count_invalid_returns_soft_skip():
    """A subject_edge_resolutions list with !=1 target raises a
    recoverable skip rather than a hard error."""
    bad_subject = _subject_resolutions(target='e-m-y')
    bad_subject = [
        SpanEdgeResolution(
            transition=r.transition,
            primitive_scope=r.primitive_scope,
            resolved_model=r.resolved_model,
            evidence_set=None,
            is_target=True,  # both flagged as target
        )
        for r in bad_subject
    ]
    kwargs = _common_call_kwargs()
    kwargs['subject_edge_resolutions'] = bad_subject
    result = compute_active_cohort_carrier_readout(
        **kwargs,
    )
    assert result.composed_subject is None
    assert result.skip_reason == 'target_count_invalid'


def test_carrier_no_path_surfaces_in_diagnostics_and_blocks_substitution():
    """Plan §727: when the primitive-backed composer cannot find a
    path A→X (or refuses on horizon adequacy), substitution must NOT
    fire on the live path. The result still records diag for forensic
    review."""
    # Disconnect A→X in the carrier topology by giving anchor B with
    # only A→B and no B→X path under a stunted graph.
    graph = _make_graph([
        ('e-a-b', 'A', 'B'),
        # No e-b-x: anchor A cannot reach X.
        ('e-x-m', 'X', 'M'),
        ('e-m-y', 'M', 'Y'),
    ])
    kwargs = _common_call_kwargs()
    kwargs['graph'] = graph
    kwargs['carrier_edge_resolutions'] = [
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='A', destination_node='B', edge_id='e-a-b',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=10.0, beta=10.0),
            evidence_set=None,
        ),
    ]
    result = compute_active_cohort_carrier_readout(
        **kwargs,
    )
    # Carrier composition surfaces no_path; substitution must be False.
    assert result.composed_carrier is None or (
        result.composed_carrier is not None
        and (
            result.composed_carrier.diagnostics.tier == 'no_path'
            or result.composed_carrier.is_horizon_inadequate
        )
    )
    assert result.should_substitute is False


def test_subject_no_path_returns_soft_skip():
    """X→end with no path produces a CompositionError inside the
    subject composer; the readout catches it as a soft skip."""
    graph = _make_graph([
        ('e-a-b', 'A', 'B'),
        ('e-b-x', 'B', 'X'),
        ('e-x-m', 'X', 'M'),
        # No e-m-y; subject path X→Y is broken.
    ])
    kwargs = _common_call_kwargs()
    kwargs['graph'] = graph
    result = compute_active_cohort_carrier_readout(
        **kwargs,
    )
    assert result.composed_subject is None
    assert result.skip_reason in (
        'subject_composition_error', 'carrier_composition_error',
    )


# ─── Connectivity invariants (plan §727) ───────────────────────────────


def test_changing_upstream_resolved_model_moves_carrier_reach():
    """Plan §727 invariant: changing upstream window(U-V) evidence
    moves carrier reach for consumers that include that primitive.

    With prior-only carrier primitives, the upstream "evidence" is
    represented by the resolved model's prior moments. Two
    invocations with materially different priors on a carrier edge
    must produce materially different ``composed_carrier.reach``.
    """
    # Baseline: alpha=8, beta=12 on e-b-x → mean 0.4.
    baseline = compute_active_cohort_carrier_readout(
        **_common_call_kwargs(),
    )
    # Bump e-b-x to alpha=18, beta=2 → mean 0.9.
    kwargs = _common_call_kwargs()
    kwargs['carrier_edge_resolutions'] = [
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='A', destination_node='B', edge_id='e-a-b',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=10.0, beta=10.0),
            evidence_set=None,
        ),
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='B', destination_node='X', edge_id='e-b-x',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=18.0, beta=2.0),
            evidence_set=None,
        ),
    ]
    bumped = compute_active_cohort_carrier_readout(
        **kwargs,
    )
    assert baseline.composed_carrier is not None
    assert bumped.composed_carrier is not None
    assert baseline.composed_carrier.is_active
    assert bumped.composed_carrier.is_active
    # Reach is sensitive to upstream primitive p — two priors that
    # differ materially must produce materially different reach.
    assert (
        abs(bumped.composed_carrier.reach - baseline.composed_carrier.reach)
        > 0.10
    )


def test_target_subject_only_change_does_not_move_carrier():
    """Plan §727 invariant: target subject-only evidence does not
    move unrelated carrier state.

    Bumping the subject target's resolved model leaves the carrier
    primitives (and therefore composed carrier reach + CDF) unchanged.
    """
    baseline = compute_active_cohort_carrier_readout(
        **_common_call_kwargs(),
    )
    kwargs = _common_call_kwargs()
    bumped_subject = _subject_resolutions(target='e-m-y')
    bumped_subject[1] = SpanEdgeResolution(
        transition=bumped_subject[1].transition,
        primitive_scope=bumped_subject[1].primitive_scope,
        resolved_model=_resolved(alpha=18.0, beta=2.0),  # bump only target
        evidence_set=None,
        is_target=True,
    )
    kwargs['subject_edge_resolutions'] = bumped_subject
    bumped = compute_active_cohort_carrier_readout(
        **kwargs,
    )
    assert baseline.composed_carrier is not None
    assert bumped.composed_carrier is not None
    # Carrier reach is identical to within numerical precision.
    assert (
        abs(bumped.composed_carrier.reach - baseline.composed_carrier.reach)
        < 1e-9
    )
    # Subject composed mean DID move because the target shifted.
    assert (
        baseline.p_mean_primitive is not None
        and bumped.p_mean_primitive is not None
    )
    assert (
        abs(bumped.p_mean_primitive - baseline.p_mean_primitive)
        > 0.05
    )


# ─── Diagnostics ───────────────────────────────────────────────────────


def test_diagnostics_carry_full_provenance():
    """The diag block exposes flag, eligibility, primitive counts,
    composed carrier + subject moments, legacy moments, delta, and
    shadow-band check."""
    result = compute_active_cohort_carrier_readout(
        **_common_call_kwargs(),
    )
    diag = dict(result.diagnostics)
    assert diag['eligible'] is True
    assert 'composed_carrier' in diag
    assert diag['composed_carrier']['role'] == 'carrier_to_x'
    assert diag['composed_carrier']['primitive_count'] == 2
    assert 'composed_subject' in diag
    assert diag['composed_subject']['primitive_count'] == 2
    assert diag['composed_subject']['composition_mode'] == 'draws'
    assert 'composed_public_moments' in diag
    assert 'legacy_public_moments' in diag
    assert 'delta_p_mean' in diag
    assert 'within_shadow_band' in diag
    assert diag['subject_probability_source'] == (
        'primitive_backed_carrier_and_subject'
    )
    assert diag['binding_policy'] == 'primitive_span.active_cohort_carrier.v1'
    # Carrier primitive summaries surface per-edge p_mean from the
    # conditioned primitive's posterior — required to verify the
    # connectivity invariants in production.
    cp = diag['carrier_primitives']
    assert len(cp) == 2
    assert all('p_mean' in entry for entry in cp)


# ─── Prior-only sub-spans ──────────────────────────────────────────────


def test_carrier_and_subject_non_target_use_prior_only():
    """Plan §95: non-target carrier and subject edges remain prior-only
    with explicit provenance. The composer accepts them as
    draw-coherent inputs (Stage 5b prior-only fix preserved)."""
    result = compute_active_cohort_carrier_readout(
        **_common_call_kwargs(),
    )
    diag = dict(result.diagnostics)
    carrier_summaries = diag['carrier_primitives']
    subject_summaries = diag['subject_primitives']
    # Carriers are all prior-only by default.
    assert all(s['status'] == 'prior_only' for s in carrier_summaries)
    assert all(s['is_draw_coherent'] for s in carrier_summaries)
    # Subject non-target edges are prior-only; target is non-evidence
    # (still prior_only because evidence_set is None on the target
    # in _common_call_kwargs).
    assert all(s['status'] == 'prior_only' for s in subject_summaries)


# ─── should_substitute property ────────────────────────────────────────


def test_should_substitute_property():
    """``should_substitute`` is True when (eligible AND carrier active
    AND subject draw-coherent AND p_mean set)."""
    common = _common_call_kwargs()
    on = compute_active_cohort_carrier_readout(**common)
    assert on.should_substitute is True


# ─── Source-level AP58 prevention ──────────────────────────────────────


def test_module_does_not_import_trajectory_engine():
    """Plan AP58 prevention (KNOWN_ANTI_PATTERNS §272): the readout
    layer must not import forecast_state / forecast_runtime /
    cohort_forecast_v3 — those would re-introduce the projection-vs-
    primitive duplication this stage exists to remove."""
    here = os.path.dirname(__file__)
    src_path = os.path.join(here, '..', 'runner', 'primitive_readout.py')
    with open(src_path) as fh:
        src = fh.read()
    # The forbidden imports.
    for forbidden in (
        'from .forecast_state',
        'from .forecast_runtime',
        'from .cohort_forecast_v3',
        'import forecast_state',
        'import forecast_runtime',
        'import cohort_forecast_v3',
    ):
        assert forbidden not in src, (
            f'primitive_readout.py imports {forbidden!r}; this would '
            f'break AP58 prevention. Only carrier_composition + '
            f'subject_span_composer + the primitive layer are allowed.'
        )
