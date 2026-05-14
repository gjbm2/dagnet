"""Tests for the production span runtime adapter."""

from __future__ import annotations

import os
import sys
import types

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_operator_supply import (
    PrimitiveModelSurface,
    draw_model_primitive_operators,
    model_primitive_operator,
)
from runner.span_runtime_adapter import (
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


def root_mass(count, *, root_day=0):
    return RuntimeRootMass(
        cohort_ids=("C0",),
        root_days=np.asarray([root_day], dtype=int),
        root_counts=np.asarray([count], dtype=float),
        root_support=np.asarray([1.0], dtype=float),
    )


def conditioned_primitive(
    edge_id="A-B",
    *,
    p=0.4,
    p_draws=(0.2, 0.5),
    family="latent",
    cdf_mean=(0.0, 1.0),
    cdf_draws=((0.0, 1.0), (0.0, 0.5)),
    shift=0,
    posterior=True,
    timing=True,
):
    """Build a duck-typed ConditionedTransitionPrimitive-shaped namespace."""
    return types.SimpleNamespace(
        transition=types.SimpleNamespace(edge_id=edge_id),
        probability_posterior=(
            types.SimpleNamespace(mean=p, draws=np.asarray(p_draws))
            if posterior else None
        ),
        timing_posterior=(
            types.SimpleNamespace(
                cdf_mean=None if cdf_mean is None else np.asarray(cdf_mean),
                cdf_draws=None if cdf_draws is None else np.asarray(cdf_draws),
                deterministic_shift_days=shift,
            )
            if timing else None
        ),
        timing_draws=lambda: np.asarray(cdf_draws) if cdf_draws is not None else np.empty((0, 0)),
        timing_family=types.SimpleNamespace(value=family),
    )


def test_topology_edge_ids_preserves_supplied_order():
    edges = (RuntimeTopologyEdge("A-B", "A", "B"), RuntimeTopologyEdge("B-C", "B", "C"))
    assert topology_edge_ids(edges) == ("A-B", "B-C")


def test_topology_edges_from_provenance_projects_composer_shape():
    edges = topology_edges_from_provenance(
        (
            {"edge_id": "A-B", "from": "A", "to": "B"},
            {"edge_id": "B-C", "from": "B", "to": "C"},
        )
    )
    assert topology_edge_ids(edges) == ("A-B", "B-C")


def test_days_for_root_tau_sizes_prefix_grid():
    assert days_for_root_tau((3, 5), 10) == 16
    assert days_for_root_tau((3, 5), 10, carrier_horizon=7) == 23


def test_resolved_model_normalises_dict_shape():
    model = resolved_model(
        "A-B",
        {"p": 0.4, "conditional_cdf": (0.0, 0.5, 1.0), "timing_family": "latent"},
    )
    assert model.edge_id == "A-B"
    assert model.p == 0.4
    np.testing.assert_allclose(model.conditional_cdf, [0.0, 0.5, 1.0])
    assert model.timing_family == "latent"


def test_resolved_model_normalises_object_shape():
    obj = types.SimpleNamespace(p=0.25, conditional_cdf=(0.0, 1.0), timing_family="non_latent")
    model = resolved_model("A-B", obj)
    assert model.edge_id == "A-B"
    assert model.p == 0.25
    assert model.timing_family == "non_latent"


def test_conditioned_primitive_mean_ingestion_is_duck_typed():
    model = resolved_model_from_conditioned_primitive(
        conditioned_primitive(p=0.4, family="latent", cdf_mean=(0.0, 1.0))
    )
    assert model.edge_id == "A-B"
    assert model.p == 0.4
    assert model.timing_family == "latent"


def test_conditioned_primitive_mean_refuses_unavailable_probability():
    with pytest.raises(RuntimeModelAdapterError):
        resolved_model_from_conditioned_primitive(conditioned_primitive(posterior=False))


def test_conditioned_primitive_mean_refuses_missing_timing_posterior():
    with pytest.raises(RuntimeModelAdapterError):
        resolved_model_from_conditioned_primitive(conditioned_primitive(timing=False))


def test_nonlatent_mean_ingestion_does_not_require_cdf_mean():
    model = resolved_model_from_conditioned_primitive(
        conditioned_primitive(family="non_latent", cdf_mean=None)
    )
    assert model.timing_family == "non_latent"
    assert model.conditional_cdf.shape == (0,)


def test_conditioned_primitive_draw_ingestion_preserves_draw_arrays():
    model = resolved_model_from_conditioned_primitive(
        conditioned_primitive(p_draws=(0.2, 0.5), cdf_draws=((0.0, 1.0), (0.0, 0.5))),
        draws=True,
    )
    np.testing.assert_allclose(model.p_draws, [0.2, 0.5])
    assert model.timing_family == "latent"


def test_runtime_draw_model_compiles_draw_operators():
    operators = draw_model_primitive_operators(
        resolved_model_from_conditioned_primitive(
            conditioned_primitive(cdf_draws=((0.0, 1.0), (0.0, 0.5))),
            draws=True,
        ),
        days=4,
    )
    assert len(operators) == 2
    np.testing.assert_allclose(operators[0].value[1], 0.2)
    np.testing.assert_allclose(operators[1].value[1], 0.25)


def test_deterministic_runtime_model_end_to_end_lands_at_shift():
    surface = evaluate_window_model_span(
        subject_edges=(RuntimeTopologyEdge("A-B", "A", "B"),),
        model_by_edge_id={
            "A-B": PrimitiveModelSurface("A-B", 0.5, np.asarray([1.0]), "deterministic", 2),
        },
        root_mass=root_mass(100.0),
        days=5,
        max_tau=4,
    )
    np.testing.assert_allclose(surface.value_by_cohort_tau[0], [0.0, 0.0, 50.0, 50.0, 50.0])


def test_evaluate_model_span_from_ordered_runtime_surfaces():
    surface = evaluate_model_span(
        ordered_edges=(RuntimeTopologyEdge("A-B", "A", "B"), RuntimeTopologyEdge("B-C", "B", "C")),
        model_by_edge_id={
            "A-B": PrimitiveModelSurface("A-B", 0.5, np.asarray([0.0, 1.0]), "latent"),
            "B-C": PrimitiveModelSurface("B-C", 0.4, np.asarray([0.0, 0.5, 1.0]), "latent"),
        },
        root_mass=root_mass(100.0),
        days=8,
        max_tau=4,
    )
    np.testing.assert_allclose(surface.mass_at("C0", 1), 0.0)
    np.testing.assert_allclose(surface.mass_at("C0", 2), 10.0)
    np.testing.assert_allclose(surface.mass_at("C0", 3), 20.0)


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
        model_by_edge_id=models,
        root_mass=root_mass(1000.0),
        days=12,
        max_tau=8,
    )
    window = evaluate_window_model_span(
        subject_edges=(RuntimeTopologyEdge("X-M", "X", "M"), RuntimeTopologyEdge("M-Z", "M", "Z")),
        model_by_edge_id=models,
        root_mass=root_mass(1000.0 * 0.25 * 0.40),
        days=12,
        max_tau=8,
    )
    np.testing.assert_allclose(active.value_by_cohort_tau, window.value_by_cohort_tau)


def test_nonlatent_draw_operator_end_to_end():
    operators = draw_model_primitive_operators(
        resolved_model_from_conditioned_primitive(
            conditioned_primitive(
                p_draws=(0.2, 0.5),
                family="non_latent",
                cdf_draws=None,
                cdf_mean=None,
            ),
            draws=True,
        ),
        days=3,
    )
    surfaces = [
        evaluate_with_operators(root_mass=root_mass(100.0), operators=(operator,), days=3, max_tau=2)
        for operator in operators
    ]
    np.testing.assert_allclose(surfaces[0].mass_at("C0", 0), 20.0)
    np.testing.assert_allclose(surfaces[1].mass_at("C0", 0), 50.0)


def test_multi_primitive_draw_chain_preserves_draw_dispersion():
    def nonlatent_ops(edge_id, p_draws):
        return draw_model_primitive_operators(
            resolved_model_from_conditioned_primitive(
                conditioned_primitive(
                    edge_id=edge_id,
                    p_draws=p_draws,
                    family="non_latent",
                    cdf_draws=None,
                    cdf_mean=None,
                ),
                draws=True,
            ),
            days=3,
        )

    first = nonlatent_ops("A-B", (0.2, 0.5))
    second = nonlatent_ops("B-C", (0.5, 0.5))
    draw_surfaces = [
        evaluate_with_operators(root_mass=root_mass(100.0), operators=(first[i], second[i]), days=3, max_tau=0)
        for i in range(2)
    ]
    np.testing.assert_allclose(draw_surfaces[0].mass_at("C0", 0), 10.0)
    np.testing.assert_allclose(draw_surfaces[1].mass_at("C0", 0), 25.0)


def test_deterministic_runtime_model_uses_shift_not_delta_zero():
    operator = model_primitive_operator(
        PrimitiveModelSurface(
            "A-B",
            p=0.5,
            conditional_cdf=np.asarray([1.0]),
            timing_family="deterministic",
            deterministic_shift_days=2,
        ),
        days=5,
    )
    np.testing.assert_array_equal(operator.value, np.array([0.0, 0.0, 0.5]))


def test_strict_span_model_rate_matches_identity_carrier_formula():
    from runner.cohort_forecast_v3 import _strict_span_model_rate_draws

    subject = types.SimpleNamespace(
        span_p_draws=np.asarray([0.4, 0.2], dtype=float),
        cdf_draws=np.asarray([[0.0, 0.5, 1.0], [0.0, 1.0, 1.0]], dtype=float),
    )

    draws = _strict_span_model_rate_draws(subject, None, horizon=2)

    np.testing.assert_allclose(
        draws,
        np.asarray([[0.0, 0.2, 0.4], [0.0, 0.2, 0.2]], dtype=float),
    )


def test_strict_span_model_rate_matches_active_carrier_formula():
    from runner.cohort_forecast_v3 import _strict_span_model_rate_draws

    subject = types.SimpleNamespace(
        span_p_draws=np.asarray([0.4, 0.2], dtype=float),
        cdf_draws=np.asarray([[0.0, 1.0, 1.0], [0.0, 0.5, 1.0]], dtype=float),
    )
    carrier = types.SimpleNamespace(
        is_draw_coherent=True,
        cdf_draws=np.asarray([[0.0, 0.5, 1.0], [0.0, 1.0, 1.0]], dtype=float),
    )

    draws = _strict_span_model_rate_draws(subject, carrier, horizon=2)

    expected = []
    for p_draw, subject_cdf, carrier_cdf in zip(
        subject.span_p_draws,
        subject.cdf_draws,
        carrier.cdf_draws,
    ):
        numerator_cdf = np.cumsum(
            np.convolve(
                np.diff(carrier_cdf, prepend=0.0),
                np.diff(subject_cdf, prepend=0.0),
            )[:3]
        )
        expected.append(
            np.where(
                carrier_cdf > 1e-9,
                (numerator_cdf * p_draw) / np.maximum(carrier_cdf, 1e-9),
                0.0,
            )
        )
    np.testing.assert_allclose(draws, np.asarray(expected, dtype=float))


def test_project_runtime_rows_routes_all_model_overlays_through_strict_span(monkeypatch):
    from runner import cohort_forecast_v3 as cfv3

    calls = []

    def fake_strict_span(subject, carrier, *, horizon):
        calls.append((subject.label, carrier, horizon))
        base = 0.25 if subject.label == "predictive" else 0.75
        return np.asarray([[base, base + 0.1]], dtype=float)

    monkeypatch.setattr(cfv3, "_strict_span_model_rate_draws", fake_strict_span)
    monkeypatch.setattr(cfv3, "_selected_cohort_group_rate_draws", lambda *args, **kwargs: None)
    monkeypatch.setattr(cfv3, "_runtime_completeness", lambda *args, **kwargs: (None, None))

    runtime = types.SimpleNamespace(
        unconditioned_overlays={
            "predictive": types.SimpleNamespace(
                subject=types.SimpleNamespace(label="predictive"),
                carrier=None,
            ),
            "epistemic": types.SimpleNamespace(
                subject=types.SimpleNamespace(label="epistemic"),
                carrier=None,
            ),
        },
        public_moments=None,
        population_root="X",
        denominator_node="X",
        composed_carrier=None,
    )

    rows = cfv3._project_runtime_rows(
        runtime=runtime,
        engine_cohorts=(),
        cohort_eval_ages=(),
        cohort_weights=(),
        max_tau=1,
        tau_solid_max=0,
        tau_future_max=1,
        sweep_to="2026-03-10",
        band_level=0.90,
    )

    assert [call[0] for call in calls] == ["predictive", "epistemic"]
    assert rows[0]["model_midpoint"] == 0.25
    assert rows[0]["model_curve_midpoint"] == 0.75
