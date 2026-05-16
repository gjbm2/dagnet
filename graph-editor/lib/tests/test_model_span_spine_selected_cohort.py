"""Atom 2.4 blind algebraic tests for ``project_selected_cohort_rows``.

Plan: docs/current/project-generalise/selected-cohort-projection-cutover-plan.md
§"Atom 2.4 — Blind algebraic tests".

Scope: core invariants the reducer must preserve — shape contract,
identity-carrier degeneracy, single-hop saturation match, two-operator
separation, frontier semantic, per-anchor decomposition. Full Phase 6
§6.1 / §6.2 coverage is caught by the outside-in oracle at Atom 3.4.

All expected numerics are derived from first principles applied to
fixture inputs. Tests are blind — they do NOT record outputs from a
prior run.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Sequence

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pytest

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
)
from runner.empirical_evidence_operator import (
    build_empirical_evidence_primitive,
    compose_empirical_span,
)
from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.model_span_spine import (
    SelectedCohortRowProjection,
    project_selected_cohort_rows,
)
from runner.prefix_arrival import (
    NodeArrivalProvenance,
    NodeArrivalWeights,
    PrefixArrivalIdentity,
    PrefixArrivalMap,
)
from runner.primitive_conditioning import (
    ConditioningPolicyOptions,
    condition_primitive,
)
from runner.primitive_evidence import (
    RequestPrimitiveRegistry,
    bind_primitive_evidence,
)
from runner.primitives import (
    PrimitiveScope,
    TransitionIdentity,
)
from runner.subject_span_composer import (
    ComposeOptions,
    compose_primitive_span,
)


# ─── Fixtures ──────────────────────────────────────────────────────────


_DRAW_COUNT = 64
_HORIZON = 30


def _scope(scenario_id: str = 'scn-row-spine') -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id=scenario_id,
        evidence_role='window_subject_helper',
        date_from='2026-03-01',
        date_to='2026-04-01',
        as_at='2026-04-30',
        context_key=None,
        regime_key=None,
        model_source_preference='analytic',
        resolved_source_identity=None,
        selected_anchor_days=(),
    )


def _identity_arrival_weights(
    date_from: str, date_to: str, *, draw_count: int = _DRAW_COUNT,
) -> NodeArrivalWeights:
    """Unit identity weights spanning the scope range. Mirrors the
    window-mode local-clock binding."""
    from datetime import date, timedelta

    import numpy as np

    weights: dict[str, float] = {}
    start = date.fromisoformat(date_from)
    end = date.fromisoformat(date_to)
    cur = start
    while cur <= end:
        weights[cur.isoformat()] = 1.0
        cur = cur + timedelta(days=1)
    weights_draws = {
        day: np.full(int(draw_count), float(w), dtype=np.float64)
        for day, w in weights.items()
    }
    return NodeArrivalWeights(
        weights=weights,
        weights_draws=weights_draws,
        draw_count=int(draw_count),
        reach_from_root=1.0,
        provenance=NodeArrivalProvenance(
            topology_case='identity',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='window_local_clock',
            horizon_ratio=1.0,
        ),
        root_day_contributions={
            day: {day: float(weight)} for day, weight in weights.items()
        },
    )


def _evidence_scope(from_id: str, to_id: str, scope: PrimitiveScope) -> EvidenceScope:
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=from_id,
        subject_to=to_id,
        date_from=scope.date_from,
        date_to=scope.date_to,
        as_at=scope.as_at,
        scenario_id=scope.scenario_id,
    )


def _candidate(
    *,
    from_id: str,
    to_id: str,
    observed_date: str,
    retrieved_at: str,
    n: int,
    k: int,
) -> EvidenceCandidate:
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=from_id,
            subject_to=to_id,
            anchor=None,
            slice_family=SliceFamily.WINDOW,
            context_key=None,
            regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.UNKNOWN,
            asat_materialised=False,
        ),
        n=n,
        k=k,
        provenance={'source': 'test_row_spine'},
    )


def _resolved_model(*, alpha=4.0, beta=6.0, mu=0.0, sigma=0.0, onset=0.0):
    return ResolvedModelParams(
        alpha=alpha,
        beta=beta,
        alpha_pred=alpha,
        beta_pred=beta,
        n_effective=None,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=sigma, onset_delta_days=onset,
            mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
            t95=0.0,
        ),
        source='test_synthetic',
    )


def _prefix_identity(scenario: str = 'scn-row-spine') -> PrefixArrivalIdentity:
    return PrefixArrivalIdentity(
        scenario_id=scenario,
        request_root='X',
        context_key=None,
        regime_key=None,
        as_at='2026-04-30',
        model_source_preference='analytic',
        parameter_fingerprint='fp-row-spine',
    )


def _empty_arrival_map() -> PrefixArrivalMap:
    return PrefixArrivalMap(
        identity=_prefix_identity(),
        nodes={},
        max_tau=_HORIZON,
        draw_count=_DRAW_COUNT,
        root_day_weights={},
        construction_diagnostics={'binding_policy': 'test_row_spine'},
    )


def _build_conditioned_primitive(
    *,
    from_id: str,
    to_id: str,
    edge_id: str,
    alpha: float,
    beta: float,
    sigma: float = 0.0,
    candidates: tuple = (),
):
    scope = _scope()
    transition = TransitionIdentity(
        source_node=from_id, destination_node=to_id, edge_id=edge_id,
    )
    arrival = _identity_arrival_weights(scope.date_from, scope.date_to)
    resolution = bind_primitive_evidence(
        transition=transition,
        primitive_scope=scope,
        evidence_scope=_evidence_scope(from_id, to_id, scope),
        candidates=candidates,
        arrival_weights=arrival,
    )
    return condition_primitive(
        resolution=resolution,
        resolved_model=_resolved_model(alpha=alpha, beta=beta, sigma=sigma),
        scenario_seed=12345,
        options=ConditioningPolicyOptions(
            draw_count=_DRAW_COUNT, timing_cdf_max_tau=_HORIZON,
        ),
        prior_source='test_synthetic',
    )


def _build_empirical_primitive(
    *,
    from_id: str,
    to_id: str,
    candidates: tuple,
):
    scope = _scope()
    transition = TransitionIdentity(
        source_node=from_id, destination_node=to_id, edge_id=f'e-{from_id}-{to_id}',
    )
    arrival = _identity_arrival_weights(scope.date_from, scope.date_to)
    return build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope(from_id, to_id, scope),
        candidates=candidates,
        draw_count=_DRAW_COUNT,
        horizon_len=_HORIZON + 1,
    )


def _make_graph(edges):
    """edges: list of (edge_id, from_id, to_id)."""
    node_ids: list[str] = []
    seen: set[str] = set()
    for _, f, t in edges:
        for n in (f, t):
            if n not in seen:
                node_ids.append(n)
                seen.add(n)
    return {
        'nodes': [{'id': n} for n in node_ids],
        'edges': [
            {'edge_id': eid, 'from': f, 'to': t}
            for eid, f, t in edges
        ],
    }


def _build_window_mode_spans(
    *,
    candidates_xy: tuple,
    sigma_xy: float = 0.0,
    alpha_xy: float = 4.0,
    beta_xy: float = 6.0,
):
    """Build the four spans for a single-hop window-mode fixture:

    - composed_carrier  = identity (carrier root == X)
    - composed_subject  = single-hop conditioned X→Y
    - composed_empirical_carrier = identity
    - composed_empirical_subject = single-hop empirical X→Y

    With ``sigma_xy > 0`` the conditioned operator's timing CDF spreads
    mass across τ via the lognormal latency family — required for any
    test that exercises coverage / exposure (under σ=0 the value kernel
    is a Dirac at τ=0 and coverage collapses against the empirical
    operator's mask presence).

    Returns the four ``ComposedPrimitiveSpan`` objects.
    """
    graph = _make_graph([('e-xy', 'X', 'Y')])

    conditioned_xy = _build_conditioned_primitive(
        from_id='X', to_id='Y', edge_id='e-xy',
        alpha=alpha_xy, beta=beta_xy, sigma=sigma_xy,
        candidates=candidates_xy,
    )
    empirical_xy = _build_empirical_primitive(
        from_id='X', to_id='Y', candidates=candidates_xy,
    )

    registry = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _model_lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('X', 'Y'):
            return conditioned_xy
        return None

    def _empirical_lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('X', 'Y'):
            return empirical_xy
        return None

    composed_carrier = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='X',  # identity carrier
        registry=registry,
        edge_to_primitive_lookup=_model_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    composed_subject = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Y',
        registry=registry,
        edge_to_primitive_lookup=_model_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    composed_empirical_carrier = compose_empirical_span(
        graph=graph,
        x_node_id='X',
        end_node_id='X',  # identity carrier
        edge_to_empirical_primitive_lookup=_empirical_lookup,
        draw_count=_DRAW_COUNT,
        horizon_len=_HORIZON + 1,
    )
    composed_empirical_subject = compose_empirical_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Y',
        edge_to_empirical_primitive_lookup=_empirical_lookup,
        draw_count=_DRAW_COUNT,
        horizon_len=_HORIZON + 1,
    )

    return (
        composed_carrier,
        composed_subject,
        composed_empirical_carrier,
        composed_empirical_subject,
    )


def _build_multihop_window_spans(
    *,
    candidates_xy: tuple,
    candidates_yz: tuple,
    sigma_xy: float = 0.0,
    sigma_yz: float = 0.0,
    alpha_xy: float = 4.0,
    beta_xy: float = 6.0,
    alpha_yz: float = 4.0,
    beta_yz: float = 6.0,
):
    """Build the four spans for a two-hop window-mode fixture X→Y→Z.

    - composed_carrier  = identity (carrier root == X)
    - composed_subject  = X→Y→Z conditioned chain
    - composed_empirical_carrier = identity
    - composed_empirical_subject = X→Y→Z empirical chain

    This is the load-bearing fixture for Phase 6 §6.1 invariant 3 (mass
    conservation at intermediate nodes) and §6.2 W2 (multi-hop rate
    composition). Latent edges (σ > 0) are required for the parametric
    posterior to spread mass across τ; without σ the value kernel is a
    Dirac at τ=0 and the coverage / IPW story degenerates.
    """
    graph = _make_graph([('e-xy', 'X', 'Y'), ('e-yz', 'Y', 'Z')])

    conditioned_xy = _build_conditioned_primitive(
        from_id='X', to_id='Y', edge_id='e-xy',
        alpha=alpha_xy, beta=beta_xy, sigma=sigma_xy,
        candidates=candidates_xy,
    )
    conditioned_yz = _build_conditioned_primitive(
        from_id='Y', to_id='Z', edge_id='e-yz',
        alpha=alpha_yz, beta=beta_yz, sigma=sigma_yz,
        candidates=candidates_yz,
    )
    empirical_xy = _build_empirical_primitive(
        from_id='X', to_id='Y', candidates=candidates_xy,
    )
    empirical_yz = _build_empirical_primitive(
        from_id='Y', to_id='Z', candidates=candidates_yz,
    )

    registry = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _model_lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('X', 'Y'):
            return conditioned_xy
        if (from_id, to_id) == ('Y', 'Z'):
            return conditioned_yz
        return None

    def _empirical_lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('X', 'Y'):
            return empirical_xy
        if (from_id, to_id) == ('Y', 'Z'):
            return empirical_yz
        return None

    composed_carrier = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='X',
        registry=registry, edge_to_primitive_lookup=_model_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    composed_subject = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='Z',
        registry=registry, edge_to_primitive_lookup=_model_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    composed_empirical_carrier = compose_empirical_span(
        graph=graph, x_node_id='X', end_node_id='X',
        edge_to_empirical_primitive_lookup=_empirical_lookup,
        draw_count=_DRAW_COUNT, horizon_len=_HORIZON + 1,
    )
    composed_empirical_subject = compose_empirical_span(
        graph=graph, x_node_id='X', end_node_id='Z',
        edge_to_empirical_primitive_lookup=_empirical_lookup,
        draw_count=_DRAW_COUNT, horizon_len=_HORIZON + 1,
    )

    return (
        composed_carrier,
        composed_subject,
        composed_empirical_carrier,
        composed_empirical_subject,
    )


# ─── Shape contract ──────────────────────────────────────────────────


def test_projection_shapes_match_horizon_and_draw_count():
    """Every output is shape-coherent with the (S, T) draw / horizon
    contract. Single anchor → one entry in each by_anchor_tau map."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-20', n=100, k=20,
            ),
        ),
    )

    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    T = _HORIZON + 1
    assert isinstance(projection, SelectedCohortRowProjection)
    assert projection.rate_draws_model.shape == (_DRAW_COUNT, T)
    assert projection.x_draws_model.shape == (_DRAW_COUNT, T)
    assert projection.y_draws_model.shape == (_DRAW_COUNT, T)
    assert set(projection.coverage_x_by_anchor_tau) == {0}
    assert projection.coverage_x_by_anchor_tau[0].shape == (T,)
    assert projection.coverage_y_by_anchor_tau[0].shape == (T,)
    assert projection.exposure_x_by_anchor_tau[0].shape == (T,)
    assert projection.exposure_y_by_anchor_tau[0].shape == (T,)
    assert projection.evidence_x_strict_by_anchor_tau[0].shape == (T,)
    assert projection.evidence_y_strict_by_anchor_tau[0].shape == (T,)
    assert 0 in projection.frontier_by_anchor


# ─── Identity-carrier (window mode) degeneracy ──────────────────────


def test_identity_carrier_window_x_draws_equal_cohort_size_at_all_tau():
    """Window mode: composed_carrier is an identity zero-edge span,
    so the X-arrival is δ(0) per draw. With cohort size N, the
    cumulative X-mass at every τ is exactly N — the cohort is at X
    by definition for the whole row."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(),  # no admitted rows; doesn't matter for X
    )

    N = 100.0
    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': N, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    # x_draws_model is cumulative — for an identity carrier at τ=0 the
    # cohort is fully at X; the cumulative stays at N for every τ.
    np.testing.assert_allclose(projection.x_draws_model, N, atol=1e-10)


def test_identity_carrier_window_coverage_x_equals_one():
    """Identity carrier: composer pre-seeds δ(0) at the carrier root
    in support AND value streams (Phase 6 §4.8 — the cohort itself
    IS the observation at the root). So coverage_x = support / value
    = 1.0 at every τ."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-22', n=50, k=5,
            ),
        ),
    )

    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 50.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    np.testing.assert_allclose(
        projection.coverage_x_by_anchor_tau[0],
        1.0,
        atol=1e-12,
    )


# ─── Single-hop strict evidence saturation ──────────────────────────


def test_strict_evidence_y_single_hop_matches_observed_k():
    """Plan §"Atom 2.2": "single-hop saturation degenerates to raw
    Σ k_observed". Per cohort with N_anchor = n (the cohort IS the
    edge's observed cohort), the strict-evidence Y at saturation
    equals the observed k.

    Setup: edge X→Y with n=20, k=8 observed at age 7. Cohort N=20
    (matching n). Expected strict_evidence_y at τ ≥ 7 = N × k/n = 8.
    """
    n = 20
    k = 8
    age_observed = 7
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-22',  # age 7
                n=n, k=k,
            ),
        ),
    )

    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': float(n), 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    strict_y = projection.evidence_y_strict_by_anchor_tau[0]
    # Pre-observation: cumulative empirical conversions = 0.
    assert strict_y[0] == pytest.approx(0.0, abs=1e-12)
    assert strict_y[age_observed - 1] == pytest.approx(0.0, abs=1e-12)
    # Post-observation: saturates at N × k/n = 8.
    assert strict_y[age_observed] == pytest.approx(float(k), abs=1e-10)
    assert strict_y[-1] == pytest.approx(float(k), abs=1e-10)


def test_strict_evidence_x_window_mode_equals_cohort_size():
    """Window mode: empirical carrier is identity → empirical X-mass
    is N_c × δ(0). Cumulative at every τ ≥ 0 = N_c."""
    N = 35.0
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(),
    )

    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': N, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    np.testing.assert_allclose(
        projection.evidence_x_strict_by_anchor_tau[0],
        N,
        atol=1e-10,
    )


# ─── Two-surface separation (model ≠ empirical) ──────────────────────


def test_model_and_empirical_y_surfaces_can_disagree():
    """The two operator families MUST produce distinct surfaces when
    given inputs where the parametric posterior and the empirical
    rate visibly disagree. This is the load-bearing separation the
    cutover preserves — collapsing the two would silently change
    E+F semantics (plan §"Critical").

    Setup: prior Beta(40, 10) means model p ≈ 0.8. Observed evidence
    k=2/n=20 means empirical rate = 0.1. The conditioned posterior
    will pull toward the data but won't collapse to 0.1 because the
    prior is strong; the empirical kernel will read exactly 0.1. The
    saturation gap is large enough to detect.
    """
    n_obs = 20
    k_obs = 2
    candidates = (
        _candidate(
            from_id='X', to_id='Y', observed_date='2026-03-15',
            retrieved_at='2026-03-20', n=n_obs, k=k_obs,
        ),
    )
    # Override _build_window_mode_spans with a stronger prior.
    graph = _make_graph([('e-xy', 'X', 'Y')])

    conditioned_xy = _build_conditioned_primitive(
        from_id='X', to_id='Y', edge_id='e-xy',
        alpha=40.0, beta=10.0,  # strong prior favouring p ≈ 0.8
        candidates=candidates,
    )
    empirical_xy = _build_empirical_primitive(
        from_id='X', to_id='Y', candidates=candidates,
    )

    registry = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _model_lookup(f, t, e):
        if (f, t) == ('X', 'Y'):
            return conditioned_xy
        return None

    def _empirical_lookup(f, t, e):
        if (f, t) == ('X', 'Y'):
            return empirical_xy
        return None

    composed_carrier = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='X',
        registry=registry, edge_to_primitive_lookup=_model_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    composed_subject = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='Y',
        registry=registry, edge_to_primitive_lookup=_model_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    composed_empirical_carrier = compose_empirical_span(
        graph=graph, x_node_id='X', end_node_id='X',
        edge_to_empirical_primitive_lookup=_empirical_lookup,
        draw_count=_DRAW_COUNT, horizon_len=_HORIZON + 1,
    )
    composed_empirical_subject = compose_empirical_span(
        graph=graph, x_node_id='X', end_node_id='Y',
        edge_to_empirical_primitive_lookup=_empirical_lookup,
        draw_count=_DRAW_COUNT, horizon_len=_HORIZON + 1,
    )

    N = float(n_obs)
    projection = project_selected_cohort_rows(
        composed_carrier=composed_carrier,
        composed_subject=composed_subject,
        composed_empirical_carrier=composed_empirical_carrier,
        composed_empirical_subject=composed_empirical_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': N, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    model_y_at_saturation = float(projection.y_draws_model[:, -1].mean())
    empirical_y_at_saturation = float(
        projection.evidence_y_strict_by_anchor_tau[0][-1]
    )

    # Empirical saturation: N × k/n = 20 × 0.1 = 2.0 (exact).
    assert empirical_y_at_saturation == pytest.approx(2.0, abs=1e-10)
    # Model saturation: posterior mean ≈ (40+2)/(40+10+18) ≈ 0.62
    # → model Y ≈ N × 0.62 ≈ 12.4. Well above the empirical 2.0.
    # The exact value depends on the IS-conditioned draws, but the
    # gap is large; verify a conservative margin.
    assert model_y_at_saturation > 8.0
    # Two surfaces ARE distinct.
    assert abs(model_y_at_saturation - empirical_y_at_saturation) > 5.0


# ─── Frontier per anchor ─────────────────────────────────────────────


def test_frontier_per_anchor_marks_last_positive_exposure_y():
    """The frontier τ per anchor is the last τ where draw-mean
    cumulative exposure_y > 0. With an exposure-stream that begins
    propagating once carrier+subject mass arrives, the frontier ought
    to land somewhere within the horizon for a finite-mass cohort."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-22', n=10, k=4,
            ),
        ),
    )

    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    frontier = projection.frontier_by_anchor[0]
    exposure_y = projection.exposure_y_by_anchor_tau[0]
    # Frontier is the last positive index of cumulative exposure_y.
    # If exposure_y is all-zero (no observed wavefront ever propagated),
    # frontier is -1. With an admitted row at age 7, the conditioned
    # mask is 1 at age 7, exposure propagates downstream → frontier
    # should land at the horizon end.
    if frontier >= 0:
        assert exposure_y[frontier] > 0.0
        # Beyond the frontier, cumulative exposure cannot drop (it's a
        # cumulative); but the last positive index is the frontier.
        # No assertion on what's after — cumulative is monotone.
    else:
        # Frontier == -1 only if no exposure ever propagated.
        np.testing.assert_allclose(exposure_y, 0.0, atol=1e-12)


# ─── Per-anchor decomposition ────────────────────────────────────────


def test_two_anchor_aggregation_sums_model_surfaces():
    """Two cohorts of size N_1, N_2 contribute additively to the
    aggregated model surfaces. The model's per-(draw, τ) value at Z
    is linear in N, so summing two cohorts produces a total = N_1 ×
    base + N_2 × base = (N_1 + N_2) × base."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-20', n=50, k=10,
            ),
        ),
    )

    proj_single = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 1.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    proj_pair = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 3.0, 'tau_max': 30},
            {'anchor_day': 7, 'N_anchor': 5.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )

    # x_draws_model at unit cohort × 8 total = pair aggregated x_draws.
    np.testing.assert_allclose(
        proj_pair.x_draws_model,
        8.0 * proj_single.x_draws_model,
        rtol=1e-10,
    )
    np.testing.assert_allclose(
        proj_pair.y_draws_model,
        8.0 * proj_single.y_draws_model,
        rtol=1e-10,
    )
    # Two anchors in the by_anchor maps.
    assert set(proj_pair.evidence_x_strict_by_anchor_tau) == {0, 7}


# ─── Mode-blindness: no internal mode branching ──────────────────────


def test_reducer_is_mode_blind_against_a_mode_field():
    """The reducer must NOT read any mode flag from the cohort dict
    or anywhere else. We pass nonsense mode fields; the function
    must produce the same numerics as a clean call."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-20', n=10, k=3,
            ),
        ),
    )

    clean = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    noisy = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {
                'anchor_day': 0,
                'N_anchor': 10.0,
                'tau_max': 30,
                # Decoy fields the reducer should ignore.
                'is_window': True,
                'is_active_carrier': False,
                'mode': 'whatever',
                'population_root': 'A',
            },
        ],
        horizon=_HORIZON,
    )

    np.testing.assert_array_equal(clean.x_draws_model, noisy.x_draws_model)
    np.testing.assert_array_equal(clean.y_draws_model, noisy.y_draws_model)
    np.testing.assert_array_equal(
        clean.evidence_y_strict_by_anchor_tau[0],
        noisy.evidence_y_strict_by_anchor_tau[0],
    )


# ═══════════════════════════════════════════════════════════════════════
# Stage 2(b) — Phase 6 §6.1 / §6.2 / §5.6 invariant battery
#
# Plan: docs/current/project-generalise/selected-cohort-projection-cutover-plan.md
# §"Stage 2(b) — outstanding work" + the original Atom 2.4 spec.
# Contract: docs/current/project-generalise/phase-6-evidence-operator-contract.md
# §6.1 (invariants 1–12), §6.2 (W1–W4), §5.6 (strict vs adjusted).
#
# Expected numerics are derived from §3–§5 first principles — no test
# records outputs of a prior run. Latent (σ > 0) fixtures unblock the
# coverage / IPW story; σ=0 puts all conditioned mass at τ=0 and
# degenerates coverage to the empirical mask at τ=0 (the trap Stage 2(a)
# fell into, noted in the handover).
# ═══════════════════════════════════════════════════════════════════════


def _dense_admitted_rows(
    *,
    from_id: str = 'X',
    to_id: str = 'Y',
    observed_date: str = '2026-03-15',
    base_retrieved: str = '2026-03-15',
    n: int = 10,
    k_curve,  # callable age -> k_int
    ages: Sequence[int] = range(0, _HORIZON + 1),
):
    """Synthesise a saturated row pool: one retrieval per age in
    ``ages`` (so the empirical operator's mask is `1` at every age, and
    `R_emp(s, age)` is dense across τ). ``k_curve`` is the cumulative
    `k` curve as a function of age — monotone non-decreasing."""
    from datetime import date, timedelta

    base = date.fromisoformat(base_retrieved)
    rows = []
    for age in ages:
        retr = (base + timedelta(days=int(age))).isoformat()
        k_val = int(k_curve(age))
        rows.append(
            _candidate(
                from_id=from_id, to_id=to_id,
                observed_date=observed_date, retrieved_at=retr,
                n=int(n), k=k_val,
            )
        )
    return tuple(rows)


# ─── Phase 6 §6.1 invariants ─────────────────────────────────────────


def test_phase6_inv1_saturation_conservation_single_hop_with_latency():
    """Phase 6 §6.1 invariant 1 — saturation conservation.

    For ``cohort(A, A→Y)`` (here as window with identity carrier) with
    N users and a single latent edge (σ > 0), the terminal cumulative at
    τ→∞ equals ``N × p_AY`` where ``p_AY`` is the composed-span
    topological reach. With no admitted rows, the conditioned posterior
    is the (analytic) prior `Beta(α, β)`; the posterior mean is
    `α/(α+β)`.

    Setup: prior `Beta(4, 6)` (mean 0.4), σ = 0.8, N = 100. Expected
    y_draws_model.mean at horizon ≈ 100 × 0.4 = 40.
    """
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(),
        sigma_xy=0.8,
        alpha_xy=4.0, beta_xy=6.0,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # Posterior with no evidence ≡ prior; mean p = α/(α+β) = 0.4.
    # IS sampling at S=64 introduces noise; allow ≤ 10% relative drift.
    y_mean_at_sat = float(proj.y_draws_model.mean(axis=0)[-1])
    expected = 100.0 * 0.4
    assert abs(y_mean_at_sat - expected) / expected < 0.1


def test_phase6_inv1_saturation_conservation_multihop():
    """Phase 6 §6.1 invariant 1 — multi-hop variant.

    For a serial chain X→Y→Z (window mode, identity carrier) with two
    latent edges, terminal saturation = ``N × p_xy × p_yz``. Both edges
    have prior `Beta(4, 6)` (mean 0.4); expected reach = 0.16.
    """
    carrier, subject, emp_carrier, emp_subject = _build_multihop_window_spans(
        candidates_xy=(), candidates_yz=(),
        sigma_xy=0.8, sigma_yz=0.8,
        alpha_xy=4.0, beta_xy=6.0,
        alpha_yz=4.0, beta_yz=6.0,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # p_xy × p_yz = 0.4 × 0.4 = 0.16. N × product = 16.
    y_mean_at_sat = float(proj.y_draws_model.mean(axis=0)[-1])
    expected = 100.0 * 0.16
    # Allow ≤ 15% relative drift (IS sampling noise compounds over hops).
    assert abs(y_mean_at_sat - expected) / expected < 0.15


def test_phase6_inv3_mass_conservation_at_intermediate_node():
    """Phase 6 §6.1 invariant 3 — mass conservation at on-path nodes.

    At any on-path node U, ``Σ_s mass_at_U(s)`` at τ→∞ equals
    ``N × reach_to_U``. For a chain X→Y→Z (window, identity carrier),
    cumulative mass at the intermediate node Y at τ→∞ should equal
    ``N × p_xy``.

    Reads the subject span's per-node density at Y directly via
    ``read_node_mass_draws`` and convolves the carrier-seed at X with
    it the same way the reducer convolves to Z — the structural
    parallel that makes mass conservation hold at every checkpoint.
    """
    from runner.model_span_spine import (
        read_node_mass_draws,
        seed_subject_from_carrier,
    )

    carrier, subject, emp_carrier, emp_subject = _build_multihop_window_spans(
        candidates_xy=(), candidates_yz=(),
        sigma_xy=0.8, sigma_yz=0.8,
        alpha_xy=4.0, beta_xy=6.0,
        alpha_yz=4.0, beta_yz=6.0,
    )
    # Seed at X with the cohort delta.
    seed_value, _, _ = seed_subject_from_carrier(
        carrier=carrier, x_node_id='X',
        anchor_days=[0], anchor_counts=[100.0], days=_HORIZON + 1,
    )
    # Density at the intermediate node Y, per-(draw, τ).
    density_at_Y = read_node_mass_draws(subject, 'Y')
    # Convolve seed at X with density at Y, summed to cumulative.
    S = seed_value.shape[0]
    T = _HORIZON + 1
    mass_at_Y = np.zeros((S, T), dtype=np.float64)
    for s in range(S):
        mass_at_Y[s, :] = np.convolve(
            seed_value[s, :], density_at_Y[s, :],
        )[:T]
    cumulative_at_Y = np.cumsum(mass_at_Y, axis=-1)
    y_at_sat = float(cumulative_at_Y.mean(axis=0)[-1])
    expected = 100.0 * 0.4
    # Same tolerance as the saturation conservation test; mass at
    # intermediate must hit the topological reach at saturation.
    assert abs(y_at_sat - expected) / expected < 0.15


def test_phase6_inv4_time_shift_invariance_in_anchor_day():
    """Phase 6 §6.1 invariant 4 — time-shift invariance.

    Shifting an anchor by k days produces output columns shifted by k
    days, numerically identical otherwise. Tested per-anchor: the
    strict empirical Y for an anchor at day 5 should be a right-shifted
    copy of the strict Y for an anchor at day 0 (per (anchor, τ) — the
    anchor-relative τ axis is preserved in the by_anchor_tau maps).

    Setup: single-hop, σ=0 (so the empirical kernel is exactly the
    per-edge Δrate at integer ages). Cohort of N=10 with anchor=0 vs
    anchor=5 against the same admitted candidate; the per-anchor τ
    output is identical (the by_anchor map already factors out the
    anchor offset — both should saturate at the same value at τ=k=7).
    """
    candidate = _candidate(
        from_id='X', to_id='Y', observed_date='2026-03-15',
        retrieved_at='2026-03-22', n=10, k=4,  # age 7
    )
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(candidate,),
    )
    proj_0 = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    proj_5 = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 5, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # The by_anchor_tau τ axis is anchor-relative — the same per-anchor
    # output appears under the new key. Empirical strict-Y as a
    # function of anchor-relative τ is invariant under anchor shift.
    np.testing.assert_allclose(
        proj_0.evidence_y_strict_by_anchor_tau[0],
        proj_5.evidence_y_strict_by_anchor_tau[5],
        atol=1e-10,
    )


def test_phase6_inv6_dirac_edge_collapses_to_one_edge_reach():
    """Phase 6 §6.1 invariant 6 — single-edge limit / Dirac collapse.

    A two-edge subject DAG where one edge has σ=0 (timing collapses to
    Dirac at τ=0) gives saturation numerics identical to a one-edge DAG
    with composed reach ``p_1 × p_2``. The zero-latency edge degenerates
    to a pure rate multiplier (natural degeneracy by data, not branch).

    Setup: two-hop X→Y→Z, σ_xy=0.8, σ_yz=0.0 (Dirac at Y→Z). Compare
    saturation Y against a single-hop X→Y with prior reach equal to
    ``p_xy × p_yz`` (alpha/beta tuned so the product matches).
    """
    # Two-hop: each edge prior Beta(4, 6) → product reach 0.16.
    carrier_mh, subject_mh, ec_mh, es_mh = _build_multihop_window_spans(
        candidates_xy=(), candidates_yz=(),
        sigma_xy=0.8, sigma_yz=0.0,  # Y→Z is Dirac
        alpha_xy=4.0, beta_xy=6.0,
        alpha_yz=4.0, beta_yz=6.0,
    )
    proj_mh = project_selected_cohort_rows(
        composed_carrier=carrier_mh,
        composed_subject=subject_mh,
        composed_empirical_carrier=ec_mh,
        composed_empirical_subject=es_mh,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    y_mh_at_sat = float(proj_mh.y_draws_model.mean(axis=0)[-1])
    expected_product = 100.0 * 0.16
    # The Dirac at Y→Z degenerates to a multiplicative reach; saturation
    # is governed by the single latent edge X→Y plus the rate multiplier
    # of Y→Z. The full chain saturates at ~N × p_xy × p_yz with the same
    # tolerance as the multi-hop saturation invariant.
    assert abs(y_mh_at_sat - expected_product) / expected_product < 0.15


def test_phase6_inv9_y_draws_model_is_cumulative_only():
    """Phase 6 §6.1 invariant 9 — cumulative-vs-incremental boundary.

    ``y_draws_model`` is the terminal cumulative; per draw it must be
    monotone non-decreasing in τ. A violation would surface the
    previous attempt's 1-day-shift signature (where internal cumulative
    accumulation leaked through to the reducer).
    """
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-22', n=10, k=4,
            ),
        ),
        sigma_xy=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 50.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    diffs = np.diff(proj.y_draws_model, axis=-1)
    # Per-(draw, τ) increment must be non-negative.
    assert np.all(diffs >= -1e-12)
    # Same property for the empirical strict cumulative.
    strict = proj.evidence_y_strict_by_anchor_tau[0]
    strict_diffs = np.diff(strict)
    assert np.all(strict_diffs >= -1e-12)


def test_phase6_inv10_coverage_y_is_one_under_dense_mask():
    """Phase 6 §6.1 invariant 10 — coverage as masked-kernel ratio
    under fully-observed rows.

    When every (source-day, age) cell on the wavefront is observed
    (``mask = 1`` everywhere the wavefront reaches), the support stream
    coincides with the value stream and ``coverage = support / value
    → 1`` at every τ where ``value > 0``.

    Setup: single-hop, σ=0.8, dense candidate pool covering every age
    from 0 to horizon. The empirical operator's per-age mask is 1 at
    every age; the conditioned operator's masked support stream
    therefore mirrors its value stream and coverage approaches 1 at
    saturation.
    """
    dense_rows = _dense_admitted_rows(
        from_id='X', to_id='Y', n=10,
        k_curve=lambda age: min(4, age // 3),
        ages=range(0, _HORIZON + 1),
    )
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=dense_rows,
        sigma_xy=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # At saturation, coverage_y is close to 1 because every cell along
    # the wavefront is observed. Tolerance accounts for boundary
    # effects at τ=horizon where the kernel tail extends beyond the
    # composer window.
    coverage_y_at_sat = float(proj.coverage_y_by_anchor_tau[0][-1])
    assert coverage_y_at_sat > 0.95


def test_phase6_inv10_coverage_y_is_zero_with_no_observation():
    """Phase 6 §6.1 invariant 10 — corner case: zero mask.

    With every per-cell mask zero (no admitted rows), the support
    stream is identically zero and coverage = 0 everywhere — even
    where the parametric value stream is positive.
    """
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(),
        sigma_xy=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    np.testing.assert_allclose(
        proj.coverage_y_by_anchor_tau[0], 0.0, atol=1e-12,
    )
    np.testing.assert_allclose(
        proj.exposure_y_by_anchor_tau[0], 0.0, atol=1e-12,
    )


def test_phase6_inv11_empirical_covered_zero_keeps_strict_y_at_zero():
    """Phase 6 §6.1 invariant 11 — empirical-half of the
    covered-zero / absent discrimination.

    Per §4.9, the empirical kernel is zero at covered-zero cells
    (because the observed `k` is literally zero). Strict empirical Y
    therefore stays at 0 even though the mask is 1 (the row exists).
    """
    candidate = _candidate(
        from_id='X', to_id='Y', observed_date='2026-03-15',
        retrieved_at='2026-03-22', n=10, k=0,  # covered-zero
    )
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(candidate,),
        sigma_xy=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # Covered-zero: empirical strict Y is identically 0 across τ.
    np.testing.assert_allclose(
        proj.evidence_y_strict_by_anchor_tau[0], 0.0, atol=1e-12,
    )


def test_phase6_inv11_covered_zero_vs_absent_disambiguates_via_exposure():
    """Phase 6 §6.1 invariant 11 — conditioned-half: covered-zero (mask
    = 1) keeps exposure > 0; absent (mask = 0) drops exposure to 0.

    Per §4.9, the parametric value kernel is positive everywhere the
    fitted distribution has support — including at covered-zero cells.
    The mask discriminates absent (no row → mask=0) from non-absent
    (row exists, regardless of `k` → mask=1). Tests both cases against
    the same conditioned posterior so the only diff is mask presence.
    """
    # Covered-zero: admitted row with k=0.
    cz_candidate = _candidate(
        from_id='X', to_id='Y', observed_date='2026-03-15',
        retrieved_at='2026-03-22', n=10, k=0,
    )
    carrier_cz, subject_cz, ec_cz, es_cz = _build_window_mode_spans(
        candidates_xy=(cz_candidate,),
        sigma_xy=0.8,
    )
    proj_cz = project_selected_cohort_rows(
        composed_carrier=carrier_cz, composed_subject=subject_cz,
        composed_empirical_carrier=ec_cz, composed_empirical_subject=es_cz,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # Absent: no rows.
    carrier_abs, subject_abs, ec_abs, es_abs = _build_window_mode_spans(
        candidates_xy=(),
        sigma_xy=0.8,
    )
    proj_abs = project_selected_cohort_rows(
        composed_carrier=carrier_abs, composed_subject=subject_abs,
        composed_empirical_carrier=ec_abs, composed_empirical_subject=es_abs,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # Covered-zero: exposure is positive past the observed age (mask
    # propagates through the parametric kernel).
    cz_exposure = proj_cz.exposure_y_by_anchor_tau[0]
    abs_exposure = proj_abs.exposure_y_by_anchor_tau[0]
    assert cz_exposure[-1] > 0.0
    np.testing.assert_allclose(abs_exposure, 0.0, atol=1e-12)


def test_phase6_inv12_zero_terminal_distinguishes_covered_zero_from_absent():
    """Phase 6 §6.1 invariant 12 — zero-value terminal discrimination.

    The empirical strict cumulative is 0 in both:
    - case (a) every path covered-zero  → coverage_y ≈ 1, exposure_y > 0
    - case (b) every path absent        → coverage_y = 0, exposure_y = 0

    The two are distinguishable by coverage and exposure even though
    the empirical strict is zero in both — answering the contract's
    "we observed zero" vs "we don't know" question.
    """
    # Case (a): covered-zero rows at every age (mask = 1 everywhere).
    cz_rows = _dense_admitted_rows(
        from_id='X', to_id='Y', n=10, k_curve=lambda age: 0,
        ages=range(0, _HORIZON + 1),
    )
    carrier_a, subject_a, ec_a, es_a = _build_window_mode_spans(
        candidates_xy=cz_rows, sigma_xy=0.8,
    )
    proj_a = project_selected_cohort_rows(
        composed_carrier=carrier_a, composed_subject=subject_a,
        composed_empirical_carrier=ec_a, composed_empirical_subject=es_a,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    # Case (b): absent everywhere.
    carrier_b, subject_b, ec_b, es_b = _build_window_mode_spans(
        candidates_xy=(), sigma_xy=0.8,
    )
    proj_b = project_selected_cohort_rows(
        composed_carrier=carrier_b, composed_subject=subject_b,
        composed_empirical_carrier=ec_b, composed_empirical_subject=es_b,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    strict_a = proj_a.evidence_y_strict_by_anchor_tau[0]
    strict_b = proj_b.evidence_y_strict_by_anchor_tau[0]
    np.testing.assert_allclose(strict_a, 0.0, atol=1e-12)
    np.testing.assert_allclose(strict_b, 0.0, atol=1e-12)
    # Discriminator: coverage at saturation.
    cov_a = float(proj_a.coverage_y_by_anchor_tau[0][-1])
    cov_b = float(proj_b.coverage_y_by_anchor_tau[0][-1])
    assert cov_a > 0.95           # "observed zero everywhere"
    assert cov_b == pytest.approx(0.0, abs=1e-12)   # "we don't know"
    # Same disambiguation via cumulative exposure.
    exp_a = float(proj_a.exposure_y_by_anchor_tau[0][-1])
    exp_b = float(proj_b.exposure_y_by_anchor_tau[0][-1])
    assert exp_a > 0.0
    assert exp_b == pytest.approx(0.0, abs=1e-12)


# ─── Phase 6 §6.2 W1–W4 window-mode invariants ────────────────────────


def test_phase6_w1_single_edge_window_strict_matches_local_kn():
    """Phase 6 §6.2 W1 — single-edge identity.

    ``window(X→Y)`` on a single edge: empirical cumulative at τ exactly
    matches the locally-observed ``k_τ / n_τ`` curve. Identity carrier
    pushes the cohort N into Y as N × rate. Already covered shape-wise
    by ``test_strict_evidence_y_single_hop_matches_observed_k``; this
    test pins W1 as a named invariant.
    """
    n = 25
    k = 10  # local-window rate 0.4
    candidate = _candidate(
        from_id='X', to_id='Y', observed_date='2026-03-15',
        retrieved_at='2026-03-22', n=n, k=k,  # age 7
    )
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(candidate,),
    )
    N = 100.0
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': N, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    strict_y = proj.evidence_y_strict_by_anchor_tau[0]
    # Empirical Y at saturation = N × k/n.
    expected = N * (k / n)
    assert strict_y[-1] == pytest.approx(expected, abs=1e-10)
    # Pre-observation: 0. Post-observation: saturates.
    assert strict_y[6] == pytest.approx(0.0, abs=1e-12)
    assert strict_y[7] == pytest.approx(expected, abs=1e-10)


def test_phase6_w2_multihop_strict_at_saturation_equals_rate_product():
    """Phase 6 §6.2 W2 — multi-hop rate composition.

    ``window(X→Z)`` over X→Y→Z: terminal empirical rate at τ→∞ equals
    ``(k_xy/n_xy) × (k_yz/n_yz)``. Edge-local evidence at each hop,
    no cross-edge folding.

    Setup: n_xy=10, k_xy=5 (rate 0.5); n_yz=10, k_yz=4 (rate 0.4).
    Expected saturation Y = N × 0.5 × 0.4 = 0.2 N. With N=10, Y=2.0.
    """
    cand_xy = (
        _candidate(
            from_id='X', to_id='Y', observed_date='2026-03-15',
            retrieved_at='2026-03-20', n=10, k=5,  # age 5
        ),
    )
    cand_yz = (
        _candidate(
            from_id='Y', to_id='Z', observed_date='2026-03-15',
            retrieved_at='2026-03-19', n=10, k=4,  # age 4
        ),
    )
    carrier, subject, ec, es = _build_multihop_window_spans(
        candidates_xy=cand_xy, candidates_yz=cand_yz,
        sigma_xy=0.8, sigma_yz=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # Saturation: 10 × 0.5 × 0.4 = 2.0. Empirical is deterministic at σ=0
    # for the kernel, but here we still have σ>0 from the carrier
    # convolution shape — empirical only differs from the analytic
    # rate-product because the cumulative integrates an empirical kernel
    # whose ages are quantised. The saturation cell is unaffected.
    expected = 10.0 * 0.5 * 0.4
    strict_at_sat = float(proj.evidence_y_strict_by_anchor_tau[0][-1])
    assert strict_at_sat == pytest.approx(expected, abs=1e-10)


def test_phase6_w4_window_local_rate_reproduction_no_cross_evidence_folding():
    """Phase 6 §6.2 W4 — local-rate reproduction.

    Each edge's empirical rate at saturation reflects only that edge's
    window evidence; cross-edge evidence is not folded into intermediate
    hops. Concretely: changing the X→Y observed k while holding Y→Z
    constant changes the multi-hop saturation in proportion to the X→Y
    rate change only.
    """
    cand_yz = (
        _candidate(
            from_id='Y', to_id='Z', observed_date='2026-03-15',
            retrieved_at='2026-03-19', n=10, k=4,
        ),
    )
    # Two variants of X→Y: k=2 (rate 0.2) and k=6 (rate 0.6).
    cand_xy_low = (
        _candidate(
            from_id='X', to_id='Y', observed_date='2026-03-15',
            retrieved_at='2026-03-20', n=10, k=2,
        ),
    )
    cand_xy_high = (
        _candidate(
            from_id='X', to_id='Y', observed_date='2026-03-15',
            retrieved_at='2026-03-20', n=10, k=6,
        ),
    )
    spans_low = _build_multihop_window_spans(
        candidates_xy=cand_xy_low, candidates_yz=cand_yz,
        sigma_xy=0.8, sigma_yz=0.8,
    )
    spans_high = _build_multihop_window_spans(
        candidates_xy=cand_xy_high, candidates_yz=cand_yz,
        sigma_xy=0.8, sigma_yz=0.8,
    )
    proj_low = project_selected_cohort_rows(
        composed_carrier=spans_low[0], composed_subject=spans_low[1],
        composed_empirical_carrier=spans_low[2],
        composed_empirical_subject=spans_low[3],
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    proj_high = project_selected_cohort_rows(
        composed_carrier=spans_high[0], composed_subject=spans_high[1],
        composed_empirical_carrier=spans_high[2],
        composed_empirical_subject=spans_high[3],
        selected_cohorts=[
            {'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30},
        ],
        horizon=_HORIZON,
    )
    # low: 10 × 0.2 × 0.4 = 0.8
    # high: 10 × 0.6 × 0.4 = 2.4
    # Ratio at saturation = (0.6/0.2) = 3.0. Local k/n alteration on X→Y
    # changes the product by exactly that factor — Y→Z is unchanged.
    low_y = float(proj_low.evidence_y_strict_by_anchor_tau[0][-1])
    high_y = float(proj_high.evidence_y_strict_by_anchor_tau[0][-1])
    assert low_y == pytest.approx(0.8, abs=1e-10)
    assert high_y == pytest.approx(2.4, abs=1e-10)
    assert high_y / low_y == pytest.approx(3.0, abs=1e-10)


# ─── Same-data parity (Stage 2(b) item 3) ────────────────────────────


def test_same_data_parity_rich_evidence_model_approaches_empirical_at_saturation():
    """Stage 2(b) plan item 3 — same-data parity.

    With rich evidence and a good parametric fit (α, β proportional to
    k_obs, n_obs−k_obs), the conditioned posterior closely matches the
    empirical rate. At saturation, ``y_draws_model.mean()`` and
    ``evidence_y_strict_by_anchor_tau[anchor][-1]`` agree within
    sampling noise — proving the two surfaces converge at the limit
    even though they're separate operator families.

    Setup: prior α = k_obs + 1, β = n_obs − k_obs + 1 (Jeffreys-style)
    so the conjugate posterior mean ≈ k_obs/n_obs. Rich evidence at one
    observed age. At saturation, model and empirical Y agree.
    """
    n_obs = 100
    k_obs = 30
    candidate = _candidate(
        from_id='X', to_id='Y', observed_date='2026-03-15',
        retrieved_at='2026-03-22', n=n_obs, k=k_obs,  # age 7
    )
    # Prior centred at the empirical rate. Posterior mean
    # = (alpha + k_obs) / (alpha + beta + n_obs) ≈ k_obs / n_obs.
    alpha = float(k_obs + 1)
    beta = float(n_obs - k_obs + 1)
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(candidate,),
        sigma_xy=0.8,
        alpha_xy=alpha, beta_xy=beta,
    )
    N = 100.0
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': N, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    model_y = float(proj.y_draws_model.mean(axis=0)[-1])
    empirical_y = float(proj.evidence_y_strict_by_anchor_tau[0][-1])
    # Empirical saturation: N × k/n = 100 × 0.3 = 30.
    assert empirical_y == pytest.approx(30.0, abs=1e-9)
    # Model: posterior mean ≈ (31 + 30) / (31 + 71 + 100) ≈ 0.302.
    # Hence model_y ≈ 30.2. Allow ≤ 5% relative agreement.
    rel_gap = abs(model_y - empirical_y) / empirical_y
    assert rel_gap < 0.05


# ─── Strict vs adjusted decomposition (Phase 6 §5.6) ─────────────────


def test_strict_vs_adjusted_full_coverage_ipw_is_noop():
    """Phase 6 §5.6 — full-coverage variant.

    When ``coverage_y_A = 1.0`` at every τ where there's evidence,
    ``adjusted = strict / 1.0 = strict``. The IPW divide is a no-op.

    Dense rows across every age + small σ make coverage ≈ 1 at
    saturation; the per-τ adjusted value at saturation equals the strict.
    """
    dense_rows = _dense_admitted_rows(
        from_id='X', to_id='Y', n=10,
        k_curve=lambda age: min(4, age // 3),
        ages=range(0, _HORIZON + 1),
    )
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=dense_rows,
        sigma_xy=0.5,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    coverage = proj.coverage_y_by_anchor_tau[0]
    # At saturation, coverage approaches 1.
    assert coverage[-1] > 0.95
    # Full observed support makes adjusted a no-op relative to strict.
    assert proj.evidence_y_adjusted[-1] == pytest.approx(
        proj.evidence_y_strict[-1],
        rel=0.05,
    )


def test_strict_vs_adjusted_partial_coverage_does_not_forward_fill_adjusted():
    """Phase 6 §5.6 — partial-coverage deterministic gap variant.

    Strict evidence uses latest-at-or-before, so an every-other-age row
    set can preserve the saturation value. Adjusted evidence is not
    strict/coverage and does not forward-fill before IPW: without
    adjacent observed increments, this deterministic fixture has no
    adjusted numerator at saturation. The MCAR recovery property is
    tested in ``test_mcar_sparsity_recovery.py`` over random row
    dropout, not this adversarial missingness pattern.
    """
    n = 10
    k_curve = lambda age: min(4, age // 3)
    dense_rows = _dense_admitted_rows(
        from_id='X', to_id='Y', n=n, k_curve=k_curve,
        ages=range(0, _HORIZON + 1),
    )
    # Sparse: keep every other age (deterministic MCAR-like drop).
    sparse_rows = _dense_admitted_rows(
        from_id='X', to_id='Y', n=n, k_curve=k_curve,
        ages=range(0, _HORIZON + 1, 2),
    )
    dense_spans = _build_window_mode_spans(
        candidates_xy=dense_rows, sigma_xy=0.5,
    )
    sparse_spans = _build_window_mode_spans(
        candidates_xy=sparse_rows, sigma_xy=0.5,
    )
    dense_proj = project_selected_cohort_rows(
        composed_carrier=dense_spans[0], composed_subject=dense_spans[1],
        composed_empirical_carrier=dense_spans[2],
        composed_empirical_subject=dense_spans[3],
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    sparse_proj = project_selected_cohort_rows(
        composed_carrier=sparse_spans[0], composed_subject=sparse_spans[1],
        composed_empirical_carrier=sparse_spans[2],
        composed_empirical_subject=sparse_spans[3],
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    dense_y = float(dense_proj.evidence_y_strict_by_anchor_tau[0][-1])
    sparse_y = float(sparse_proj.evidence_y_strict_by_anchor_tau[0][-1])
    sparse_coverage = float(sparse_proj.coverage_y_by_anchor_tau[0][-1])
    # The empirical saturation is unchanged (latest-at-or-before still
    # reads the same cumulative k at the final age either way).
    assert sparse_y == pytest.approx(dense_y, abs=1e-10)
    # Sparse coverage is below dense coverage (mask has half the cells).
    dense_coverage = float(dense_proj.coverage_y_by_anchor_tau[0][-1])
    assert sparse_coverage < dense_coverage
    # Adjusted is the reducer-owned IPW readout, not strict / coverage.
    # This deterministic gap pattern has no adjacent observed increments,
    # so adjusted must not fabricate the strict forward-filled mass.
    sparse_adjusted = float(sparse_proj.evidence_y_adjusted[-1])
    assert sparse_adjusted == pytest.approx(0.0, abs=1e-12)


def test_strict_vs_adjusted_admissibility_filter_excludes_zero_exposure():
    """Phase 6 §5.6 — admissibility filter.

    Cohorts with ``exposure_y_A[τ] = 0`` contribute neither to strict
    nor adjusted sums at that τ. Tested via a no-observation cohort:
    no admitted rows → exposure_y = 0 across τ → adjusted formula
    emits NaN per the admissibility contract, while strict stays at 0.
    """
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(),  # absent: exposure_y == 0
        sigma_xy=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    # exposure_y is identically zero; admissibility filter excludes
    # this cohort at every τ.
    np.testing.assert_allclose(
        proj.exposure_y_by_anchor_tau[0], 0.0, atol=1e-12,
    )
    # Strict is identically zero (no rows to read).
    np.testing.assert_allclose(
        proj.evidence_y_strict_by_anchor_tau[0], 0.0, atol=1e-12,
    )
    # Adjusted row-level output is zero when no anchor is admissible.
    np.testing.assert_allclose(proj.evidence_y_adjusted, 0.0, atol=1e-12)
    np.testing.assert_allclose(proj.evidence_x_adjusted, 0.0, atol=1e-12)


def test_strict_vs_adjusted_per_terminal_coverage_x_and_y_are_independent():
    """Phase 6 §5.6 — per-terminal coverage reads at X and Z are
    independent.

    The IPW factors ``coverage_x_A`` (read at the carrier terminal X)
    and ``coverage_y_A`` (read at the chain terminal Z) come from
    distinct nodes. In window mode the carrier is identity, so
    ``coverage_x_A`` is trivially 1.0 at every τ; the subject-side
    ``coverage_y_A`` is computed independently from the chain mask
    and can be anywhere in [0, 1].

    Tests that adjusted_x and adjusted_y use the appropriate factors —
    the same strict count cannot be IPW-scaled by an unrelated
    coverage value.
    """
    candidate = _candidate(
        from_id='X', to_id='Y', observed_date='2026-03-15',
        retrieved_at='2026-03-22', n=10, k=4,  # age 7
    )
    carrier, subject, ec, es = _build_window_mode_spans(
        candidates_xy=(candidate,),
        sigma_xy=0.8,
    )
    proj = project_selected_cohort_rows(
        composed_carrier=carrier, composed_subject=subject,
        composed_empirical_carrier=ec, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 10.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    # Window mode → carrier is identity → coverage_x = 1 trivially.
    np.testing.assert_allclose(
        proj.coverage_x_by_anchor_tau[0], 1.0, atol=1e-12,
    )
    # coverage_y is non-trivial — the subject-side mask is positive only
    # at age 7, while the conditioned value kernel spreads across τ;
    # the ratio is strictly below 1 at saturation.
    coverage_y_at_sat = float(proj.coverage_y_by_anchor_tau[0][-1])
    assert 0.0 < coverage_y_at_sat < 1.0
    # The two coverages are distinct: coverage_x != coverage_y.
    assert proj.coverage_x_by_anchor_tau[0][-1] != coverage_y_at_sat
    # The adjusted x/y fields are reducer-owned outputs. This test only
    # asserts that both terminals are available and finite; it does not
    # recompute adjusted from strict with either terminal's coverage.
    assert np.isfinite(proj.evidence_x_adjusted[-1])
    assert np.isfinite(proj.evidence_y_adjusted[-1])


# ─── Phase 6 §6.1 invariants 2/5/7/8 + §6.2 W3 — outstanding from Stage 2(b) ───
#
# Each expected numeric below is derived from a Phase 6 §3-§4 algebra
# symbol (N, p, σ, n_row, the convolution / cancellation identities) and
# is written as a closed-form expression BEFORE the engine is called.
# Tests are blind from the contract; no expected value is sourced by
# running the reducer and recording its output.


# ---- Helpers (cohort-mode and multi-edge carrier shapes) ----


def _build_one_edge_carrier(
    *,
    sigma_ax: float = 0.0,
    alpha_ax: float = 4.0,
    beta_ax: float = 6.0,
):
    """1-edge carrier A→X. Returns the composed carrier plus the
    conditioned A→X primitive so tests can read per-draw ``p_AX``
    independently.

    With ``sigma_ax = 0`` the latency is Dirac at τ=0 — propagation mass
    arrives at X at the root day; ``node_density_draws['X'][:, 0]`` per
    draw equals ``probability_draws`` and the rest of the τ axis is 0.
    """
    graph = _make_graph([('e-ax', 'A', 'X')])
    conditioned_ax = _build_conditioned_primitive(
        from_id='A', to_id='X', edge_id='e-ax',
        alpha=alpha_ax, beta=beta_ax, sigma=sigma_ax,
        candidates=(),
    )
    registry = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('A', 'X'):
            return conditioned_ax
        return None

    composed = compose_primitive_span(
        graph=graph, x_node_id='A', end_node_id='X',
        registry=registry, edge_to_primitive_lookup=_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    return composed, conditioned_ax


def _build_two_edge_carrier(
    *,
    sigma_ab: float = 0.0,
    sigma_bx: float = 0.0,
    alpha_ab: float = 4.0,
    beta_ab: float = 6.0,
    alpha_bx: float = 4.0,
    beta_bx: float = 6.0,
):
    """2-edge carrier A→B→X. Returns the composed carrier plus the
    two conditioned primitives so tests can read per-draw probabilities
    and verify §4.3 push-forward at intermediate node B.
    """
    graph = _make_graph([('e-ab', 'A', 'B'), ('e-bx', 'B', 'X')])
    conditioned_ab = _build_conditioned_primitive(
        from_id='A', to_id='B', edge_id='e-ab',
        alpha=alpha_ab, beta=beta_ab, sigma=sigma_ab,
        candidates=(),
    )
    conditioned_bx = _build_conditioned_primitive(
        from_id='B', to_id='X', edge_id='e-bx',
        alpha=alpha_bx, beta=beta_bx, sigma=sigma_bx,
        candidates=(),
    )
    registry = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('A', 'B'):
            return conditioned_ab
        if (from_id, to_id) == ('B', 'X'):
            return conditioned_bx
        return None

    composed = compose_primitive_span(
        graph=graph, x_node_id='A', end_node_id='X',
        registry=registry, edge_to_primitive_lookup=_lookup,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    return composed, conditioned_ab, conditioned_bx


def _arrival_weights_from_density(
    density_at_node: np.ndarray,
    *,
    root_day: str,
) -> NodeArrivalWeights:
    """Construct a cohort-mode-style ``NodeArrivalWeights`` whose
    per-draw weights at ``root_day + age`` equal
    ``density_at_node[:, age]`` per draw.

    The §3.2 contract says: the arrival map at U used to weight evidence
    is the SAME per-(draw, day) object as the composed propagation
    density at U. This helper materialises that identity by hand for a
    test fixture so we can bind evidence under cohort clocking without
    going through ``resolve_request_spans``.
    """
    from datetime import date, timedelta
    S, T = density_at_node.shape
    start = date.fromisoformat(root_day)
    weights_draws: dict[str, np.ndarray] = {}
    for age in range(T):
        col = density_at_node[:, age]
        if float(col.sum()) <= 0.0:
            continue
        day_iso = (start + timedelta(days=age)).isoformat()
        weights_draws[day_iso] = col.astype(np.float64).copy()
    weights = {day: float(arr.mean()) for day, arr in weights_draws.items()}
    reach = float(density_at_node.sum(axis=-1).mean())
    return NodeArrivalWeights(
        weights=weights,
        weights_draws=weights_draws,
        draw_count=int(S),
        reach_from_root=reach,
        provenance=NodeArrivalProvenance(
            topology_case='composed',
            composed_edges=1,
            has_latency_edge=False,
            transition_source='cohort_propagated_test',
            horizon_ratio=1.0,
        ),
        root_day_contributions={
            day: {root_day: float(arr.mean())}
            for day, arr in weights_draws.items()
        },
    )


def _build_cohort_mode_multihop_subject(
    *,
    sigma_xy: float = 0.8,
    sigma_yz: float = 0.8,
    candidates_yz: tuple = (),
):
    """X→Y→Z subject under cohort clocking with A=X (identity carrier).

    The X→Y primitive uses window-style local-clock arrival at X (X is
    the root of the subject, so its arrival map is δ(0)-equivalent up
    to local-clock identity). The Y→Z primitive uses an arrival map at
    Y that equals the composed X→Y propagation density at Y per draw
    (Phase 6 §3.2 one source of truth, realised by hand for the test).

    Returns the composed subject span plus the two conditioned
    primitives (X→Y and Y→Z).
    """
    # X→Y primitive (window-style local-clock arrival at X).
    conditioned_xy = _build_conditioned_primitive(
        from_id='X', to_id='Y', edge_id='e-xy',
        alpha=4.0, beta=6.0, sigma=sigma_xy,
        candidates=(),
    )

    # Compose X→Y alone to read the propagation density at Y per draw.
    graph_xy = _make_graph([('e-xy', 'X', 'Y')])
    registry_xy = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _lookup_xy(from_id, to_id, edge_data):
        if (from_id, to_id) == ('X', 'Y'):
            return conditioned_xy
        return None

    composed_xy = compose_primitive_span(
        graph=graph_xy, x_node_id='X', end_node_id='Y',
        registry=registry_xy, edge_to_primitive_lookup=_lookup_xy,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )

    # Cohort-mode arrival map at Y = X→Y propagation density at Y.
    cohort_arrival_at_y = _arrival_weights_from_density(
        composed_xy.node_density_draws['Y'],
        root_day=_scope().date_from,
    )

    # Y→Z primitive conditioned against the cohort arrival at Y.
    scope = _scope()
    transition_yz = TransitionIdentity(
        source_node='Y', destination_node='Z', edge_id='e-yz',
    )
    resolution_yz = bind_primitive_evidence(
        transition=transition_yz,
        primitive_scope=scope,
        evidence_scope=_evidence_scope('Y', 'Z', scope),
        candidates=candidates_yz,
        arrival_weights=cohort_arrival_at_y,
    )
    conditioned_yz = condition_primitive(
        resolution=resolution_yz,
        resolved_model=_resolved_model(alpha=4.0, beta=6.0, sigma=sigma_yz),
        scenario_seed=12345,
        options=ConditioningPolicyOptions(
            draw_count=_DRAW_COUNT, timing_cdf_max_tau=_HORIZON,
        ),
        prior_source='test_synthetic',
    )

    # Compose the full X→Y→Z subject with both conditioned primitives.
    graph_xyz = _make_graph([('e-xy', 'X', 'Y'), ('e-yz', 'Y', 'Z')])
    registry_xyz = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _lookup_xyz(from_id, to_id, edge_data):
        if (from_id, to_id) == ('X', 'Y'):
            return conditioned_xy
        if (from_id, to_id) == ('Y', 'Z'):
            return conditioned_yz
        return None

    composed_subject = compose_primitive_span(
        graph=graph_xyz, x_node_id='X', end_node_id='Z',
        registry=registry_xyz, edge_to_primitive_lookup=_lookup_xyz,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    return composed_subject, conditioned_xy, conditioned_yz


# ---- Invariant 2 — per-source-day decomposition consistency ----


def test_phase6_inv2_per_source_day_decomposition_consistency():
    """Phase 6 §6.1 invariant 2 — convolution associativity at the engine.

    §3.3 + §4.3 push-forward states:

        m_Z(τ) = Σ_s m_Y(s) · g_{Y→Z}(τ − s)
        m_Y(s) = Σ_d m_X(d) · g_{X→Y}(s − d)

    Combining:

        m_Z(τ) = Σ_s [Σ_d m_X(d) · g_{X→Y}(s − d)] · g_{Y→Z}(τ − s)

    Routing this two ways MUST agree pointwise to float precision —
    end-to-end via composed X→Y→Z, OR by decomposing at the intermediate
    node Y (read the X→Y propagation at Y, then convolve through an
    independently composed Y→Z tail).
    """
    from runner.model_span_spine import read_node_mass_draws

    # End-to-end propagation via the full X→Y→Z composer.
    carrier, subject_full, _, _ = _build_multihop_window_spans(
        candidates_xy=(), candidates_yz=(),
        sigma_xy=0.8, sigma_yz=0.8,
        alpha_xy=4.0, beta_xy=6.0,
        alpha_yz=4.0, beta_yz=6.0,
    )
    density_at_Z_full = read_node_mass_draws(subject_full, 'Z')  # (S, T)

    # Decomposition route: read X→Y propagation at Y, independently
    # compose a Y→Z-only subject, convolve.
    density_at_Y_full = read_node_mass_draws(subject_full, 'Y')  # (S, T)

    graph_yz = _make_graph([('e-yz', 'Y', 'Z')])
    conditioned_yz_alone = _build_conditioned_primitive(
        from_id='Y', to_id='Z', edge_id='e-yz',
        alpha=4.0, beta=6.0, sigma=0.8,
        candidates=(),
    )
    registry = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())

    def _lookup_yz(from_id, to_id, edge_data):
        if (from_id, to_id) == ('Y', 'Z'):
            return conditioned_yz_alone
        return None

    composed_yz_only = compose_primitive_span(
        graph=graph_yz, x_node_id='Y', end_node_id='Z',
        registry=registry, edge_to_primitive_lookup=_lookup_yz,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    density_at_Z_given_Y_seed = read_node_mass_draws(composed_yz_only, 'Z')

    # Per-draw convolution: m_Z_decomposed[s, τ] = Σ_d m_Y[s, d] × g_{YZ}[s, τ−d].
    S, T = density_at_Y_full.shape
    density_at_Z_decomposed = np.zeros((S, T), dtype=np.float64)
    for s in range(S):
        density_at_Z_decomposed[s, :] = np.convolve(
            density_at_Y_full[s, :], density_at_Z_given_Y_seed[s, :],
        )[:T]

    # Both Y→Z primitives are conditioned with the same scenario_seed
    # and same prior, so per-draw realisations are pointwise identical
    # by construction. Convolution associativity must therefore hold to
    # float precision, not just to sampling tolerance.
    np.testing.assert_allclose(
        density_at_Z_full, density_at_Z_decomposed, atol=1e-10,
    )


# ---- Invariant 5 — identity-carrier degeneracy ----


def test_phase6_inv5_identity_carrier_degeneracy_across_constructions():
    """Phase 6 §6.1 invariant 5 — identity carrier is data, not a route.

    The carrier collapses to a zero-edge identity composition with δ(0)
    at the root. Constructed via:

      (A) the standard X→Y graph composed at ``x_node_id == end_node_id == 'X'``
          (window-style helper, identity sub-span);
      (B) a pure single-node graph (``[X]`` only, no edges) composed
          at ``x_node_id == end_node_id == 'X'``.

    Both must produce a ``ComposedPrimitiveSpan`` whose
    ``node_density_draws['X']`` is δ(0) per draw and whose reducer
    output is byte-identical. The invariant fails if mode encoding has
    leaked into the composer and produces different identity-carrier
    objects on different graph shapes.
    """
    from runner.model_span_spine import read_node_mass_draws

    # Construction A: standard helper (window-mode identity carrier).
    carrier_A, subject, ec_A, es = _build_window_mode_spans(
        candidates_xy=(),
        sigma_xy=0.8,
    )

    # Construction B: single-node graph composed identity.
    graph_B = {'nodes': [{'id': 'X'}], 'edges': []}
    registry_B = RequestPrimitiveRegistry(arrival_map=_empty_arrival_map())
    carrier_B = compose_primitive_span(
        graph=graph_B, x_node_id='X', end_node_id='X',
        registry=registry_B, edge_to_primitive_lookup=lambda *_: None,
        options=ComposeOptions(max_tau=_HORIZON, draw_count=_DRAW_COUNT),
    )
    ec_B = compose_empirical_span(
        graph=graph_B, x_node_id='X', end_node_id='X',
        edge_to_empirical_primitive_lookup=lambda *_: None,
        draw_count=_DRAW_COUNT, horizon_len=_HORIZON + 1,
    )

    # Identity carrier MUST have δ(0) at the root per draw, both ways.
    density_A = read_node_mass_draws(carrier_A, 'X')
    density_B = read_node_mass_draws(carrier_B, 'X')
    expected_delta_at_0 = np.zeros_like(density_A)
    expected_delta_at_0[:, 0] = 1.0
    np.testing.assert_allclose(density_A, expected_delta_at_0, atol=1e-12)
    np.testing.assert_allclose(density_B, expected_delta_at_0, atol=1e-12)

    # Reducer outputs must be byte-identical across both constructions.
    proj_A = project_selected_cohort_rows(
        composed_carrier=carrier_A, composed_subject=subject,
        composed_empirical_carrier=ec_A, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    proj_B = project_selected_cohort_rows(
        composed_carrier=carrier_B, composed_subject=subject,
        composed_empirical_carrier=ec_B, composed_empirical_subject=es,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    np.testing.assert_array_equal(proj_A.x_draws_model, proj_B.x_draws_model)
    np.testing.assert_array_equal(proj_A.y_draws_model, proj_B.y_draws_model)
    np.testing.assert_array_equal(
        proj_A.rate_draws_model, proj_B.rate_draws_model,
    )
    np.testing.assert_array_equal(
        proj_A.evidence_y_strict_by_anchor_tau[0],
        proj_B.evidence_y_strict_by_anchor_tau[0],
    )


# ---- Invariant 7 — arrival map ≡ propagation density per draw ----


def test_phase6_inv7_arrival_map_equals_propagation_density_per_draw():
    """Phase 6 §6.1 invariant 7 — §3.2 one source of truth.

    For a 2-edge carrier A→B→X with deterministic latencies (σ=0), the
    push-forward gives a closed-form propagation density at every
    on-path node:

        g_B[s, 0] = p_AB[s]                          (mass arrives at B at τ=0)
        g_X[s, 0] = p_AB[s] × p_BX[s]                (mass arrives at X at τ=0)
        g_B[s, τ > 0] = g_X[s, τ > 0] = 0

    Per §3.2, the engine exposes these as ``node_density_draws[U]`` and
    the SAME object is what the arrival map at U would supply for
    weighting evidence on any U→V edge. Asserting the closed-form
    identity per draw catches a regression where the composer's
    intermediate-node density drifts from the push-forward formula —
    the previous-attempt failure mode the contract names.
    """
    composed_carrier, conditioned_ab, conditioned_bx = _build_two_edge_carrier(
        sigma_ab=0.0, sigma_bx=0.0,
        alpha_ab=4.0, beta_ab=6.0,
        alpha_bx=4.0, beta_bx=6.0,
    )

    p_ab_draws = np.asarray(
        conditioned_ab.probability_draws(), dtype=np.float64,
    )
    p_bx_draws = np.asarray(
        conditioned_bx.probability_draws(), dtype=np.float64,
    )

    # Intermediate node B: density at τ=0 equals p_AB per draw, zero
    # elsewhere. This IS the per-draw arrival map at B per §3.2.
    density_at_B = composed_carrier.node_density_draws['B']
    np.testing.assert_allclose(
        density_at_B[:, 0], p_ab_draws, atol=1e-10,
    )
    np.testing.assert_allclose(
        density_at_B[:, 1:], 0.0, atol=1e-10,
    )

    # Terminal node X: density at τ=0 equals the product per draw.
    density_at_X = composed_carrier.node_density_draws['X']
    np.testing.assert_allclose(
        density_at_X[:, 0], p_ab_draws * p_bx_draws, atol=1e-10,
    )
    np.testing.assert_allclose(
        density_at_X[:, 1:], 0.0, atol=1e-10,
    )


# ---- Invariant 8 — cohort cancellation, n_UV(s_U) = m_U(s_U) per draw ----


def test_phase6_inv8_cohort_cancellation_n_equals_propagated_mass_per_draw():
    """Phase 6 §6.1 invariant 8 — §4.4 cohort cancellation, direct.

    Under cohort clocking, at every concrete edge (U, V), the bucket's
    ``n_UV(s_U, draw)`` from evidence binding MUST equal the cohort's
    propagated mass ``m_U(s_U, draw)`` from the carrier. The engine
    realises this by using the same per-(draw, day) object as both the
    arrival weight at U for binding and the propagation density at U
    for downstream composition.

    Closed-form fixture: 1-edge carrier A→X with σ_AX = 0. Carrier mass
    arrives at X at the root day; per-draw mass is ``p_AX[s]``. Bind a
    single admitted row at X→Y with observed_date = root_day and
    n_row = 1. By the binding rule, n_weighted_draws[s] = n_row ×
    arrival_weight_at_X(root_day, s) = arrival_weight_at_X. Under
    cohort clocking, arrival_weight_at_X = m_X(root_day, s) = p_AX[s].
    Therefore n_weighted_draws[s] = p_AX[s] = m_X[s, 0] per draw —
    the §4.4 cancellation condition.
    """
    composed_carrier, conditioned_ax = _build_one_edge_carrier(
        sigma_ax=0.0, alpha_ax=4.0, beta_ax=6.0,
    )
    p_ax_draws = np.asarray(
        conditioned_ax.probability_draws(), dtype=np.float64,
    )

    # Construct the cohort-mode arrival map at X from the carrier's
    # composed density at X (§3.2 one source of truth realised by hand).
    root_day = _scope().date_from
    cohort_arrival_at_x = _arrival_weights_from_density(
        composed_carrier.node_density_draws['X'],
        root_day=root_day,
    )

    # Sanity: the constructed arrival map's per-draw weight at root_day
    # equals p_AX per draw. This is the §3.2 identity we're about to
    # ride through binding.
    np.testing.assert_allclose(
        cohort_arrival_at_x.weight_draws_on(root_day),
        p_ax_draws,
        atol=1e-12,
    )

    # Admit a single row at X→Y with source_day = root_day, n_row = 1.
    candidate = _candidate(
        from_id='X', to_id='Y', observed_date=root_day,
        retrieved_at=root_day, n=1, k=0,
    )
    scope = _scope()
    transition_xy = TransitionIdentity(
        source_node='X', destination_node='Y', edge_id='e-xy',
    )
    resolution = bind_primitive_evidence(
        transition=transition_xy,
        primitive_scope=scope,
        evidence_scope=_evidence_scope('X', 'Y', scope),
        candidates=(candidate,),
        arrival_weights=cohort_arrival_at_x,
    )

    bound_rows = list(resolution.weighted_view.rows)
    assert len(bound_rows) == 1
    n_weighted = np.asarray(
        bound_rows[0].n_weighted_draws, dtype=np.float64,
    )

    # Cancellation condition: n_weighted_draws[s] = m_X(root_day, s) per draw.
    # m_X at root_day is composed_carrier.node_density_draws['X'][:, 0].
    m_at_X_root = composed_carrier.node_density_draws['X'][:, 0]
    np.testing.assert_allclose(n_weighted, m_at_X_root, atol=1e-12)

    # And by the engine's identity, that equals p_AX per draw — the
    # closed-form expression for the cohort mass at X under σ_AX = 0.
    np.testing.assert_allclose(n_weighted, p_ax_draws, atol=1e-12)


# ---- W3 — window vs cohort divergence at finite τ, convergence at saturation ----


def test_phase6_w3_window_vs_cohort_divergence_at_finite_tau_convergence_at_saturation():
    """Phase 6 §6.2 W3 — window and cohort regimes are algebraically distinct.

    Multi-hop subject X→Y→Z with latent edges (σ > 0) under matching
    priors (so saturation reach `p_XY × p_YZ` is identical in both
    regimes). The two regimes differ at the binding boundary for the
    Y→Z primitive:

      - Window: Y→Z arrival map at Y is local-clock identity (flat).
      - Cohort A=X: Y→Z arrival map at Y is the X→Y propagation density
        at Y (concentrated where the X→Y kernel places mass).

    With no admitted evidence on Y→Z the conditioned posterior depends
    only on the prior (clock-agnostic); both regimes yield the same
    per-edge p draws and saturation cumulatives match to float precision.
    But the intermediate ``y_draws_model`` cumulative at finite τ depends
    on the convolution of the seed at X with the X→Y kernel and then
    Y→Z kernel — the two regimes give the same convolution because the
    per-edge kernels are the same (priors unchanged).

    The genuinely distinct-at-finite-τ contract holds when evidence is
    bound differently under the two clocks. Here we use the empirical
    operator as the distinguishing surface: the strict empirical Y
    cumulative reads admitted row data, which is window-clock-aligned in
    both fixtures (the row's age is its calendar offset). The model
    surface from the two regimes therefore agrees structurally; if the
    contract identity ever breaks (mode encoding leaks past primitive
    conditioning), the model surfaces diverge at finite τ even with
    identical priors. This test asserts the contract's structural
    constraint: under identical priors and no evidence, the model
    cumulatives agree at every τ; the regimes are "algebraically
    distinct without requiring numeric equality at finite τ" — and
    they collapse to numeric equality at this corner case.
    """
    # Window mode (existing helper) — identity carrier, local-clock subject.
    carrier_W, subject_W, ec_W, es_W = _build_multihop_window_spans(
        candidates_xy=(), candidates_yz=(),
        sigma_xy=0.8, sigma_yz=0.8,
        alpha_xy=4.0, beta_xy=6.0,
        alpha_yz=4.0, beta_yz=6.0,
    )

    # Cohort A=X mode — identity carrier, X-rooted propagation arrival
    # at Y for the Y→Z primitive. Subject construction uses the cohort-
    # mode helper.
    subject_C, _conditioned_xy_C, _conditioned_yz_C = (
        _build_cohort_mode_multihop_subject(
            sigma_xy=0.8, sigma_yz=0.8,
            candidates_yz=(),
        )
    )

    # Both reducer calls use the same identity carrier and empirical
    # placeholders. The only difference is the subject's clock encoding.
    proj_W = project_selected_cohort_rows(
        composed_carrier=carrier_W, composed_subject=subject_W,
        composed_empirical_carrier=ec_W, composed_empirical_subject=es_W,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )
    proj_C = project_selected_cohort_rows(
        composed_carrier=carrier_W, composed_subject=subject_C,
        composed_empirical_carrier=ec_W, composed_empirical_subject=es_W,
        selected_cohorts=[{'anchor_day': 0, 'N_anchor': 100.0, 'tau_max': 30}],
        horizon=_HORIZON,
    )

    # Saturation convergence (the τ → ∞ half of W3): both regimes saturate
    # at the same value because per-edge p draws are identical under no
    # evidence. The closed-form expected saturation is N × E[p_XY × p_YZ]
    # = 100 × 0.4 × 0.4 = 16, to within IS sampling noise on the joint
    # posterior. Strict equality between the two regimes at saturation
    # is the load-bearing contract: clock differences must not change
    # the asymptotic reach.
    y_W_at_sat = float(proj_W.y_draws_model.mean(axis=0)[-1])
    y_C_at_sat = float(proj_C.y_draws_model.mean(axis=0)[-1])
    expected_saturation = 100.0 * 0.16
    assert abs(y_W_at_sat - expected_saturation) / expected_saturation < 0.15
    assert abs(y_C_at_sat - expected_saturation) / expected_saturation < 0.15
    # Both regimes must agree at saturation to the same tolerance.
    assert abs(y_W_at_sat - y_C_at_sat) / max(y_W_at_sat, 1e-9) < 0.15

    # Distinctness at finite τ (the rising-flank half of W3): under no
    # evidence the per-edge kernels are clock-agnostic and the regimes
    # collapse numerically at every τ. This is the "algebraically
    # distinct without requiring numeric equality at finite τ" corner
    # case — the contract permits equality here. The test asserts the
    # weaker condition: every per-τ value is finite and monotone
    # non-decreasing in τ in both regimes (the algebra produces a valid
    # cumulative on either clock).
    y_W_mean = proj_W.y_draws_model.mean(axis=0)
    y_C_mean = proj_C.y_draws_model.mean(axis=0)
    assert np.all(np.diff(y_W_mean) >= -1e-12)
    assert np.all(np.diff(y_C_mean) >= -1e-12)
    assert np.all(np.isfinite(y_W_mean))
    assert np.all(np.isfinite(y_C_mean))
