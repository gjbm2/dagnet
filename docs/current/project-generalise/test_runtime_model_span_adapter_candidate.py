"""Tests for the runtime adapter and shadow diagnostics."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest

from model_span_shadow_candidate import (
    candidate_curve,
    carrier_horizon_from_composed_span,
    compare_candidate_curve,
    expected_curve_from_composed_span_draw,
    expected_curve_from_composed_span_mean,
    grid_edge_mass,
)
from runtime_model_span_adapter_candidate import (
    RuntimeModelAdapterError,
    RuntimeRootMass,
    RuntimeTopologyEdge,
    days_for_root_tau,
    evaluate_active_model_span,
    evaluate_model_span,
    evaluate_window_model_span,
    evaluate_with_operators,
    resolved_model,
    resolved_model_from_conditioned_primitive,
    topology_edge_ids,
    topology_edges_from_provenance,
)
from span_operator_supply_candidate import (
    PrimitiveModelSurface,
    draw_model_primitive_operators,
    model_primitive_operator,
)


def root_mass(count, *, root_day=0):
    return RuntimeRootMass(
        cohort_ids=("C0",),
        root_days=np.asarray([root_day], dtype=int),
        root_counts=np.asarray([count], dtype=float),
        root_support=np.asarray([1.0], dtype=float),
    )


def cp(edge_id="A-B", *, p=0.4, p_draws=(0.2, 0.5), family="latent", cdf_mean=(0.0, 1.0),
       cdf_draws=((0.0, 1.0), (0.0, 0.5)), shift=0, posterior=True, timing=True):
    """Build a duck-typed ConditionedTransitionPrimitive-shaped namespace."""
    return types.SimpleNamespace(
        transition=types.SimpleNamespace(edge_id=edge_id),
        probability_posterior=types.SimpleNamespace(mean=p, draws=np.asarray(p_draws)) if posterior else None,
        timing_posterior=(
            types.SimpleNamespace(
                cdf_mean=None if cdf_mean is None else np.asarray(cdf_mean),
                cdf_draws=None if cdf_draws is None else np.asarray(cdf_draws),
                deterministic_shift_days=shift,
            ) if timing else None
        ),
        timing_draws=lambda: np.asarray(cdf_draws) if cdf_draws is not None else np.empty((0, 0)),
        timing_family=types.SimpleNamespace(value=family),
    )


# -- topology + grid sizing --


def test_topology_edge_ids_preserves_supplied_order():
    edges = (RuntimeTopologyEdge("A-B", "A", "B"), RuntimeTopologyEdge("B-C", "B", "C"))
    assert topology_edge_ids(edges) == ("A-B", "B-C")


def test_topology_edges_from_provenance_projects_composer_shape():
    edges = topology_edges_from_provenance((
        {"edge_id": "A-B", "from": "A", "to": "B"},
        {"edge_id": "B-C", "from": "B", "to": "C"},
    ))
    assert topology_edge_ids(edges) == ("A-B", "B-C")


def test_days_for_root_tau_sizes_prefix_grid():
    assert days_for_root_tau((3, 5), 10) == 16
    assert days_for_root_tau((3, 5), 10, carrier_horizon=7) == 23


def test_carrier_horizon_from_composed_span_uses_max_tau():
    assert carrier_horizon_from_composed_span(types.SimpleNamespace(max_tau=12)) == 12


# -- resolved_model: dict + object shapes through one duck-typed fn --


def test_resolved_model_normalises_dict_shape():
    m = resolved_model("A-B", {"p": 0.4, "conditional_cdf": (0.0, 0.5, 1.0), "timing_family": "latent"})
    assert m.edge_id == "A-B"
    assert m.p == 0.4
    np.testing.assert_allclose(m.conditional_cdf, [0.0, 0.5, 1.0])
    assert m.timing_family == "latent"


def test_resolved_model_normalises_object_shape():
    obj = types.SimpleNamespace(p=0.25, conditional_cdf=(0.0, 1.0), timing_family="non_latent")
    m = resolved_model("A-B", obj)
    assert m.edge_id == "A-B"
    assert m.p == 0.25
    assert m.timing_family == "non_latent"


# -- resolved_model_from_conditioned_primitive (mean + draws + refusals) --


def test_conditioned_primitive_mean_ingestion_is_duck_typed():
    m = resolved_model_from_conditioned_primitive(cp(p=0.4, family="latent", cdf_mean=(0.0, 1.0)))
    assert m.edge_id == "A-B"
    assert m.p == 0.4
    assert m.timing_family == "latent"


def test_conditioned_primitive_mean_refuses_unavailable_probability():
    with pytest.raises(RuntimeModelAdapterError):
        resolved_model_from_conditioned_primitive(cp(posterior=False))


def test_conditioned_primitive_mean_refuses_missing_timing_posterior():
    with pytest.raises(RuntimeModelAdapterError):
        resolved_model_from_conditioned_primitive(cp(timing=False))


def test_nonlatent_mean_ingestion_does_not_require_cdf_mean():
    m = resolved_model_from_conditioned_primitive(cp(family="non_latent", cdf_mean=None))
    assert m.timing_family == "non_latent"
    assert m.conditional_cdf.shape == (0,)


def test_conditioned_primitive_draw_ingestion_preserves_draw_arrays():
    m = resolved_model_from_conditioned_primitive(
        cp(p_draws=(0.2, 0.5), cdf_draws=((0.0, 1.0), (0.0, 0.5))), draws=True,
    )
    np.testing.assert_allclose(m.p_draws, [0.2, 0.5])
    assert m.timing_family == "latent"


def test_conditioned_primitive_draw_ingestion_uses_timing_draw_accessor():
    m = resolved_model_from_conditioned_primitive(cp(cdf_draws=((0.0, 1.0), (0.0, 0.5))), draws=True)
    np.testing.assert_allclose(m.conditional_cdf_draws, [[0.0, 1.0], [0.0, 0.5]])


# -- primitive operator end-to-end --


def test_deterministic_runtime_model_uses_shift_not_delta_zero():
    op = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.5, conditional_cdf=np.asarray([1.0]),
                              timing_family="deterministic", deterministic_shift_days=2),
        days=5,
    )
    assert op.value[0, 0] == 0.0
    assert op.value[0, 2] == 0.5


def test_runtime_draw_model_compiles_draw_operators():
    ops = draw_model_primitive_operators(
        resolved_model_from_conditioned_primitive(cp(cdf_draws=((0.0, 1.0), (0.0, 0.5))), draws=True),
        days=4,
    )
    assert len(ops) == 2
    np.testing.assert_allclose(ops[0].value[0, 1], 0.2)
    np.testing.assert_allclose(ops[1].value[0, 1], 0.25)


def test_deterministic_runtime_model_end_to_end_lands_at_shift():
    s = evaluate_window_model_span(
        subject_edges=(RuntimeTopologyEdge("A-B", "A", "B"),),
        model_by_edge_id={
            "A-B": PrimitiveModelSurface("A-B", 0.5, np.asarray([1.0]), "deterministic", 2),
        },
        root_mass=root_mass(100.0), days=5, max_tau=4,
    )
    np.testing.assert_allclose(s.value_by_cohort_tau[0], [0.0, 0.0, 50.0, 50.0, 50.0])


# -- evaluation entry points --


def test_evaluate_model_span_from_ordered_runtime_surfaces():
    s = evaluate_model_span(
        ordered_edges=(RuntimeTopologyEdge("A-B", "A", "B"), RuntimeTopologyEdge("B-C", "B", "C")),
        model_by_edge_id={
            "A-B": PrimitiveModelSurface("A-B", 0.5, np.asarray([0.0, 1.0]), "latent"),
            "B-C": PrimitiveModelSurface("B-C", 0.4, np.asarray([0.0, 0.5, 1.0]), "latent"),
        },
        root_mass=root_mass(100.0), days=8, max_tau=4,
    )
    np.testing.assert_allclose(s.mass_at("C0", 1), 0.0)
    np.testing.assert_allclose(s.mass_at("C0", 2), 10.0)
    np.testing.assert_allclose(s.mass_at("C0", 3), 20.0)


def test_active_nonlatent_carrier_adapter_collapses_to_window_seed():
    models = {
        "A-U": PrimitiveModelSurface("A-U", 0.25, np.asarray([1.0]), "non_latent"),
        "U-X": PrimitiveModelSurface("U-X", 0.40, np.asarray([1.0]), "non_latent"),
        "X-M": PrimitiveModelSurface("X-M", 0.50, np.asarray([0.0, 0.2, 1.0]), "latent"),
        "M-Z": PrimitiveModelSurface("M-Z", 0.30, np.asarray([0.0, 0.4, 1.0]), "latent"),
    }
    active = evaluate_active_model_span(
        carrier_edges=(RuntimeTopologyEdge("A-U", "A", "U"), RuntimeTopologyEdge("U-X", "U", "X")),
        subject_edges=(RuntimeTopologyEdge("X-M", "X", "M"), RuntimeTopologyEdge("M-Z", "M", "Z")),
        model_by_edge_id=models, root_mass=root_mass(1000.0), days=12, max_tau=8,
    )
    window = evaluate_window_model_span(
        subject_edges=(RuntimeTopologyEdge("X-M", "X", "M"), RuntimeTopologyEdge("M-Z", "M", "Z")),
        model_by_edge_id=models, root_mass=root_mass(1000.0 * 0.25 * 0.40), days=12, max_tau=8,
    )
    np.testing.assert_allclose(active.value_by_cohort_tau, window.value_by_cohort_tau)


def test_nonlatent_draw_operator_end_to_end():
    ops = draw_model_primitive_operators(
        resolved_model_from_conditioned_primitive(
            cp(p_draws=(0.2, 0.5), family="non_latent", cdf_draws=None,
               cdf_mean=None, shift=0), draws=True,
        ),
        days=3,
    )
    # Override timing_draws result via a fresh primitive with known shape for non-latent.
    surfaces = [
        evaluate_with_operators(root_mass=root_mass(100.0), operators=(op,), days=3, max_tau=2)
        for op in ops
    ]
    np.testing.assert_allclose(surfaces[0].mass_at("C0", 0), 20.0)
    np.testing.assert_allclose(surfaces[1].mass_at("C0", 0), 50.0)


def test_multi_primitive_draw_chain_preserves_draw_dispersion():
    def nl_ops(edge_id, p_draws):
        return draw_model_primitive_operators(
            resolved_model_from_conditioned_primitive(
                cp(edge_id=edge_id, p_draws=p_draws, family="non_latent",
                   cdf_draws=None, cdf_mean=None), draws=True,
            ),
            days=3,
        )

    first = nl_ops("A-B", (0.2, 0.5))
    second = nl_ops("B-C", (0.5, 0.5))
    draw_surfaces = [
        evaluate_with_operators(root_mass=root_mass(100.0), operators=(first[i], second[i]),
                                days=3, max_tau=0)
        for i in range(2)
    ]
    np.testing.assert_allclose(draw_surfaces[0].mass_at("C0", 0), 10.0)
    np.testing.assert_allclose(draw_surfaces[1].mass_at("C0", 0), 25.0)


# -- shadow diagnostics --


def test_shadow_curve_comparator_returns_candidate_minus_expected():
    s = evaluate_window_model_span(
        subject_edges=(RuntimeTopologyEdge("A-B", "A", "B"),),
        model_by_edge_id={
            "A-B": PrimitiveModelSurface("A-B", 0.5, np.asarray([0.0, 1.0]), "latent"),
        },
        root_mass=root_mass(100.0), days=4, max_tau=2,
    )
    np.testing.assert_allclose(candidate_curve(s), [0.0, 50.0, 50.0])
    np.testing.assert_allclose(compare_candidate_curve(s, (0.0, 40.0, 50.0)), [0.0, 10.0, 0.0])


def test_expected_curve_from_composed_span_mean():
    composed = types.SimpleNamespace(span_p_mean=0.4, cdf_mean=np.asarray([0.0, 0.5, 1.0, 1.0]))
    np.testing.assert_allclose(expected_curve_from_composed_span_mean(composed, 2), [0.0, 0.2, 0.4])


def test_expected_curve_from_composed_span_mean_pads_short_cdf():
    composed = types.SimpleNamespace(span_p_mean=0.4, cdf_mean=np.asarray([0.0, 0.5]))
    np.testing.assert_allclose(
        expected_curve_from_composed_span_mean(composed, 3), [0.0, 0.2, 0.2, 0.2],
    )


def test_expected_curve_from_composed_span_draw():
    composed = types.SimpleNamespace(
        span_p_draws=np.asarray([0.4, 0.8]),
        cdf_draws=np.asarray([[0.0, 0.5, 1.0], [0.0, 0.25, 1.0]]),
    )
    np.testing.assert_allclose(expected_curve_from_composed_span_draw(composed, 1, 2), [0.0, 0.2, 0.8])


def test_grid_edge_mass_surfaces_tight_grid_diagnostic():
    s = evaluate_window_model_span(
        subject_edges=(RuntimeTopologyEdge("A-B", "A", "B"),),
        model_by_edge_id={
            "A-B": PrimitiveModelSurface("A-B", 0.5, np.asarray([0.0, 0.0, 1.0]), "latent"),
        },
        root_mass=root_mass(100.0), days=3, max_tau=2,
    )
    assert grid_edge_mass(s) == 50.0


# -- production-composer shadow (real runner imports) --


def test_shadow_against_real_production_composer_mean_curve():
    lib_path = Path(__file__).resolve().parents[3] / "graph-editor" / "lib"
    sys.path.insert(0, str(lib_path))

    from runner.primitive_evidence import RequestPrimitiveRegistry
    from runner.prefix_arrival import PrefixArrivalIdentity, PrefixArrivalMap
    from runner.primitives import (
        ConditionedTransitionPrimitive, ConditioningStatus, DrawFamilyMode,
        PrimitiveScope, ProbabilityPosterior, TimingFamily, TimingPosterior, TransitionIdentity,
    )
    from runner.subject_span_composer import ComposeOptions, compose_primitive_span

    graph = {
        "nodes": [{"id": "A"}, {"id": "B"}, {"id": "C"}],
        "edges": [
            {"from": "A", "to": "B", "edge_id": "A-B"},
            {"from": "B", "to": "C", "edge_id": "B-C"},
        ],
    }
    scope = PrimitiveScope(
        scenario_id="test", evidence_role="window_subject_helper",
        date_from="2026-01-01", date_to="2026-01-10",
        as_at=None, context_key=None, regime_key=None,
        model_source_preference="analytic", resolved_source_identity="test",
        selected_anchor_days=("2026-01-01",),
    )

    def primitive(edge_id, src, dst, p, cdf):
        draws = np.asarray([p, p], dtype=float)
        cdf_draws = np.asarray([cdf, cdf], dtype=float)
        return ConditionedTransitionPrimitive(
            transition=TransitionIdentity(src, dst, edge_id), scope=scope, draw_count=2,
            status=ConditioningStatus.CONDITIONED, timing_family=TimingFamily.LATENT,
            raw_evidence_scope_key=None, weighted_evidence=None, effective_evidence_totals=None,
            subset_policy=None, compatibility_blend=None, residual_policy=None,
            probability_posterior=ProbabilityPosterior(mean=p, sd=0.0, draws=draws),
            timing_posterior=TimingPosterior(
                family=TimingFamily.LATENT, cdf_mean=tuple(cdf), cdf_draws=cdf_draws,
                deterministic_shift_days=0,
            ),
            probability_prior=None, timing_prior=None,
            draw_family_mode=DrawFamilyMode.KEYED_PRIOR, draw_family_key=None, prior_source="test",
        )

    primitives = {
        "A-B": primitive("A-B", "A", "B", 0.5, (0.0, 1.0)),
        "B-C": primitive("B-C", "B", "C", 0.4, (0.0, 0.5, 1.0)),
    }
    registry = RequestPrimitiveRegistry(
        arrival_map=PrefixArrivalMap(
            identity=PrefixArrivalIdentity(
                scenario_id="test", request_root="A", context_key=None, regime_key=None,
                as_at=None, model_source_preference="analytic", parameter_fingerprint="test",
            ),
            nodes={}, max_tau=4, root_day_weights={},
        ),
    )
    composed = compose_primitive_span(
        graph=graph, x_node_id="A", end_node_id="C", registry=registry,
        edge_to_primitive_lookup=lambda _s, _d, edge: primitives[edge["edge_id"]],
        options=ComposeOptions(max_tau=4),
    )

    topology = topology_edges_from_provenance(composed.provenance["primitives"])
    models = {
        edge_id: resolved_model_from_conditioned_primitive(prim)
        for edge_id, prim in primitives.items()
    }
    candidate = evaluate_model_span(
        ordered_edges=topology, model_by_edge_id=models,
        root_mass=root_mass(1.0), days=days_for_root_tau((0,), 4), max_tau=4,
    )
    np.testing.assert_allclose(
        compare_candidate_curve(candidate, expected_curve_from_composed_span_mean(composed, 4)),
        np.zeros(5), atol=1e-7,
    )
