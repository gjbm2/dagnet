"""Selected-Cohort Pop D projection tests.

These tests pin Phase 2 of
``docs/current/cohort-maturity-selected-cohort-projection-pattern.md``:
active-carrier Pop D must read the carrier arrival distribution, not a
scalar lag summary of that distribution.
"""

import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _span(*, cdf_draws, p_draws):
    cdf_arr = np.asarray(cdf_draws, dtype=np.float64)
    return SimpleNamespace(
        cdf_draws=cdf_arr,
        cdf_mean=cdf_arr.mean(axis=0),
        span_p_draws=np.asarray(p_draws, dtype=np.float64),
    )


def _runtime(*, subject_cdf, carrier_cdf):
    return SimpleNamespace(
        population_root='node-a',
        denominator_node='node-x',
        composed_subject=_span(
            cdf_draws=[subject_cdf],
            p_draws=[0.8],
        ),
        composed_carrier=_span(
            cdf_draws=[carrier_cdf],
            p_draws=[1.0],
        ),
    )


def _select_source_day_mass_at_x(
    *, denominator_node, n_cohort_by_anchor, carrier_cdf,
):
    """Construct M_select(X, ·, ·) directly from N_cohort and a carrier CDF.

    Used by cell-builder tests that need a populated runtime mock without
    depending on the unified composer construction's full graph/
    transitions setup. Mirrors what the runtime builds at U = X.
    """
    from datetime import date as _d, timedelta as _td

    from runner.cohort_forecast_v3 import _SelectedSourceDayMass

    cdf = [float(v) for v in carrier_cdf]
    pmf = [max(cdf[0], 0.0)] + [
        max(cdf[i] - cdf[i - 1], 0.0) for i in range(1, len(cdf))
    ]
    by_node = {str(denominator_node): {}}
    for anchor, n_cohort in n_cohort_by_anchor.items():
        n_c = float(n_cohort or 0.0)
        if n_c <= 0:
            continue
        anchor_d = _d.fromisoformat(str(anchor)[:10])
        per_day = {}
        for tau, w in enumerate(pmf):
            if w <= 0:
                continue
            per_day[(anchor_d + _td(days=tau)).isoformat()] = n_c * w
        if per_day:
            by_node[str(denominator_node)][str(anchor)[:10]] = per_day
    return _SelectedSourceDayMass(
        by_node=by_node,
        endpoint_cdf_by_node={str(denominator_node): tuple(cdf)},
        n_cohort_by_anchor=dict(n_cohort_by_anchor),
        anchor_days=tuple(str(a)[:10] for a in n_cohort_by_anchor.keys()),
        provenance={'source': 'test_fixture_at_x'},
    )


def _identity_runtime(*, subject_cdf):
    return SimpleNamespace(
        population_root='node-x',
        denominator_node='node-x',
        composed_subject=_span(
            cdf_draws=[subject_cdf],
            p_draws=[0.8],
        ),
        composed_carrier=None,
    )


def _active_rows_runtime(*, subject_cdf, carrier_cdf):
    return SimpleNamespace(
        population_root='node-a',
        denominator_node='node-x',
        public_moments=SimpleNamespace(
            p_mean=0.4,
            p_sd=0.05,
            p_sd_epistemic=0.03,
        ),
        unconditioned_overlays={},
        composed_subject=_span(
            cdf_draws=[subject_cdf],
            p_draws=[0.8],
        ),
        composed_carrier=_span(
            cdf_draws=[carrier_cdf],
            p_draws=[1.0],
        ),
    )


def _single_active_cohort(*, frontier_age=4):
    from runner.forecast_state import CohortEvidence

    return CohortEvidence(
        obs_x=[100.0] * (frontier_age + 1),
        obs_y=[20.0] * (frontier_age + 1),
        x_frozen=100.0,
        y_frozen=20.0,
        frontier_age=frontier_age,
        a_pop=100.0,
    )


def test_observed_span_evidence_surface_composes_parallel_topology():
    """Observed span evidence composes through topology, not all-edge min."""
    from runner.cohort_forecast_v3 import (
        _build_observed_span_evidence_surface,
    )

    left_a_b = _weighted_primitive(
        edge_id="a-to-b",
        source="node-a",
        dest="node-b",
        rows=[{
            "observed_date": "2026-03-01",
            "retrieved_at": "2026-03-03",
            "n": 100,
            "k": 10,
            "n_weighted": 100.0,
            "k_weighted": 10.0,
            "root_day_shares": {"2026-03-01": 1.0},
        }],
    )
    left_b_x = _weighted_primitive(
        edge_id="b-to-x",
        source="node-b",
        dest="node-x",
        rows=[{
            "observed_date": "2026-03-02",
            "retrieved_at": "2026-03-03",
            "n": 10,
            "k": 10,
            "n_weighted": 10.0,
            "k_weighted": 10.0,
            "root_day_shares": {"2026-03-01": 1.0},
        }],
    )
    right_a_c = _weighted_primitive(
        edge_id="a-to-c",
        source="node-a",
        dest="node-c",
        rows=[{
            "observed_date": "2026-03-01",
            "retrieved_at": "2026-03-03",
            "n": 100,
            "k": 20,
            "n_weighted": 100.0,
            "k_weighted": 20.0,
            "root_day_shares": {"2026-03-01": 1.0},
        }],
    )
    right_c_x = _weighted_primitive(
        edge_id="c-to-x",
        source="node-c",
        dest="node-x",
        rows=[{
            "observed_date": "2026-03-02",
            "retrieved_at": "2026-03-03",
            "n": 20,
            "k": 20,
            "n_weighted": 20.0,
            "k_weighted": 20.0,
            "root_day_shares": {"2026-03-01": 1.0},
        }],
    )
    graph = {
        "nodes": [
            {"id": "node-a"},
            {"id": "node-b"},
            {"id": "node-c"},
            {"id": "node-x"},
        ],
        "edges": [
            {"from": "node-a", "to": "node-b", "id": "a-to-b"},
            {"from": "node-b", "to": "node-x", "id": "b-to-x"},
            {"from": "node-a", "to": "node-c", "id": "a-to-c"},
            {"from": "node-c", "to": "node-x", "id": "c-to-x"},
        ],
    }
    runtime = SimpleNamespace(graph=graph)

    # Per docs A.6 phase 2: surface builder returns the public
    # ObservedSpanEvidenceSurface and a private buckets companion.
    surface, _buckets = _build_observed_span_evidence_surface(
        runtime=runtime,
        role="carrier_a_to_x",
        root_node="node-a",
        end_node="node-x",
        primitives=[left_a_b, left_b_x, right_a_c, right_c_x],
        anchor_days=["2026-03-01"],
        max_tau=4,
    )

    assert surface is not None
    cell = surface.cells_by_anchor_day["2026-03-01"][2]
    assert cell.observed_count == pytest.approx(30.0)
    assert surface.provenance["composition"] == "observed_span_topology_max_flow.v1"


def _weighted_primitive(*, edge_id, source, dest, rows):
    from runner.primitives import (
        ConditionedTransitionPrimitive,
        ConditioningStatus,
        PrimitiveScope,
        TimingFamily,
        TransitionIdentity,
        WeightedEvidenceRow,
        WeightedPrimitiveEvidenceView,
    )

    import numpy as np

    weighted_rows = tuple(
        WeightedEvidenceRow(
            observed_date=str(row["observed_date"]),
            retrieved_at=row.get("retrieved_at"),
            n=int(row.get("n", 0)),
            k=int(row.get("k", 0)),
            arrival_weight=float(row.get("arrival_weight", 1.0)),
            n_weighted=float(row.get("n_weighted", row.get("n", 0))),
            k_weighted=float(row.get("k_weighted", row.get("k", 0))),
            arrival_weight_draws=np.array(
                [float(row.get("arrival_weight", 1.0))], dtype=np.float64,
            ),
            n_weighted_draws=np.array(
                [float(row.get("n_weighted", row.get("n", 0)))],
                dtype=np.float64,
            ),
            k_weighted_draws=np.array(
                [float(row.get("k_weighted", row.get("k", 0)))],
                dtype=np.float64,
            ),
            root_day_shares=dict(row.get("root_day_shares", {})),
        )
        for row in rows
    )
    n_total = float(sum(r.n_weighted for r in weighted_rows))
    k_total = float(sum(r.k_weighted for r in weighted_rows))
    weighted = WeightedPrimitiveEvidenceView(
        n_weighted_total=n_total,
        k_weighted_total=k_total,
        n_weighted_total_draws=np.array([n_total], dtype=np.float64),
        k_weighted_total_draws=np.array([k_total], dtype=np.float64),
        draw_count=1,
        rows=weighted_rows,
        arrival_weight_summary={"topology_case": "test"},
        binding_policy="test_binding",
        evidence_scope_key=f"scope:{edge_id}",
    )
    return ConditionedTransitionPrimitive(
        transition=TransitionIdentity(
            source_node=source,
            destination_node=dest,
            edge_id=edge_id,
        ),
        scope=PrimitiveScope(
            scenario_id="test",
            evidence_role="window_subject_helper",
            date_from="2026-03-01",
            date_to="2026-03-05",
            as_at=None,
            context_key=None,
            regime_key=None,
            model_source_preference="best_available",
            resolved_source_identity="test",
        ),
        draw_count=1,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=f"scope:{edge_id}",
        weighted_evidence=weighted,
        effective_evidence_totals=(weighted.n_weighted_total, weighted.k_weighted_total),
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=None,
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_key=None,
        prior_source="test",
    )


def test_active_pop_d_reads_carrier_distribution_not_scalar_lag():
    """Same truncated-mean lag, different pre-frontier carrier shape.

    Both carrier CDFs have mean arrival age 2.0 conditional on arrival by
    the frontier, so the former scalar-lag reducer projects identical
    Pop D continuation. Distributional Pop D must differ because early
    and late arrivals have different subject-clock exposure and different
    survival weight at the frontier.
    """
    from runner.cohort_forecast_v3 import _selected_cohort_group_rate_draws

    subject_cdf = [0.0, 0.10, 0.30, 0.60, 0.85, 0.95, 1.0, 1.0]
    # CDF A: arrival mass split between u=1 and u=3.
    split_carrier_cdf = [0.0, 0.50, 0.50, 1.0, 1.0, 1.0, 1.0, 1.0]
    # CDF B: all arrival mass at u=2. Same truncated mean at frontier=4.
    point_carrier_cdf = [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]

    cohort = _single_active_cohort(frontier_age=4)
    split = _selected_cohort_group_rate_draws(
        _runtime(subject_cdf=subject_cdf, carrier_cdf=split_carrier_cdf),
        [cohort],
        horizon=7,
    )
    point = _selected_cohort_group_rate_draws(
        _runtime(subject_cdf=subject_cdf, carrier_cdf=point_carrier_cdf),
        [cohort],
        horizon=7,
    )

    assert split is not None
    assert point is not None
    assert split.shape == point.shape == (1, 8)

    # First future age after the frontier. The two carrier distributions
    # have the same scalar lag but different survivor-weighted residuals.
    assert split[0, 5] != point[0, 5]
    assert split[0, 5] < point[0, 5]


def test_runtime_built_selected_a_clock_evidence_feeds_existing_consumers():
    """Runtime primitive-bound rows should produce the selected evidence object."""
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    carrier = _weighted_primitive(
        edge_id="a-to-x",
        source="node-a",
        dest="node-x",
        rows=[
            {
                "observed_date": "2026-03-02",
                "retrieved_at": "2026-03-03",
                "n": 100,
                "k": 30,
                "n_weighted": 100.0,
                "k_weighted": 30.0,
                "root_day_shares": {"2026-03-01": 1.0},
            },
        ],
    )
    subject = _weighted_primitive(
        edge_id="x-to-y",
        source="node-x",
        dest="node-y",
        rows=[
            {
                "observed_date": "2026-03-02",
                "retrieved_at": "2026-03-03",
                "n": 30,
                "k": 6,
                "n_weighted": 30.0,
                "k_weighted": 6.0,
                "root_day_shares": {"2026-03-02": 1.0},
            },
        ],
    )
    runtime = SimpleNamespace(
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-y",
        composed_carrier=_span(cdf_draws=[[0.0, 1.0, 1.0, 1.0, 1.0]], p_draws=[1.0]),
        composed_subject=_span(cdf_draws=[[0.0, 1.0, 1.0, 1.0, 1.0]], p_draws=[1.0]),
        conditioned_primitive_map={
            "carrier": carrier,
            "subject": subject,
        },
        runtime_provenance={
            "primitives": {
                "carrier": [{"edge_id": "a-to-x"}],
                "subject": [{"edge_id": "x-to-y"}],
            },
        },
    )

    # Per docs/current/cohort-1apr-falling-k-problem-statement.md A.6
    # phase 1: M_select(U, C, u) and X_prefix(C, τ) are runtime-
    # resolved objects. Tests must populate them on the runtime mock
    # before calling the display builder. With N_cohort=30 and the
    # test's carrier CDF=[0, 1, 1, 1, 1] (full reach at offset 1)
    # and subject row k/n = 6/30 at u = anchor + 1, expected:
    #   X_prefix(C, τ=2) = N_cohort × G_carrier(C, 2) = 30 × 1.0 = 30.
    #   Y_prefix(C, τ=2) = N_cohort × pmf[1] × (k/n) = 30 × 0.2 = 6.
    from runner.cohort_forecast_v3 import (
        _build_carrier_only_denominator_prefix,
    )
    runtime.selected_source_day_mass = _select_source_day_mass_at_x(
        denominator_node="node-x",
        n_cohort_by_anchor={"2026-03-01": 30.0},
        carrier_cdf=[0.0, 1.0, 1.0, 1.0, 1.0],
    )
    runtime.selected_x_prefix = _build_carrier_only_denominator_prefix(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": 30.0},
        max_tau=4,
    )
    runtime.selected_y_prefix = None
    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{"anchor_day": "2026-03-01"}],
        anchor_from="2026-03-01",
        anchor_to="2026-03-01",
        max_tau=4,
    )

    assert selected is not None
    aggregate = selected.aggregate_by_tau()
    assert aggregate[2]["sum_x"] == pytest.approx(30.0)
    assert aggregate[2]["sum_y"] == pytest.approx(6.0)

    prefix = selected.prefix_for_anchor_day("2026-03-01", horizon=4)
    assert prefix is not None
    assert prefix.obs_x == pytest.approx([0.0, 0.0, 30.0, 30.0, 30.0])
    assert prefix.obs_y == pytest.approx([0.0, 0.0, 6.0, 6.0, 6.0])


def test_runtime_built_selected_a_clock_evidence_requires_denominator_basis():
    """A subject observation alone must not render active selected evidence."""
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    subject = _weighted_primitive(
        edge_id="x-to-y",
        source="node-x",
        dest="node-y",
        rows=[
            {
                "observed_date": "2026-03-02",
                "retrieved_at": "2026-03-03",
                "n": 30,
                "k": 6,
                "n_weighted": 30.0,
                "k_weighted": 6.0,
            },
        ],
    )
    runtime = SimpleNamespace(
        graph={},
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-y",
        composed_carrier=SimpleNamespace(primitive_count=1),
        composed_subject=SimpleNamespace(primitive_count=1),
        conditioned_primitive_map={"subject": subject},
        runtime_provenance={
            "primitives": {
                "carrier": [],
                "subject": [{"edge_id": "x-to-y"}],
            },
        },
    )

    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{"anchor_day": "2026-03-01"}],
        anchor_from="2026-03-01",
        anchor_to="2026-03-01",
        max_tau=4,
    )

    assert selected is None


def test_runtime_built_selected_a_clock_evidence_never_pairs_y_above_x():
    """Selected A-clock evidence is paired count-flow evidence, so Y <= X."""
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    carrier_first = _weighted_primitive(
        edge_id="a-to-b",
        source="node-a",
        dest="node-b",
        rows=[
            {
                "observed_date": "2026-04-12",
                "retrieved_at": "2026-04-13",
                "n": 1000,
                "k": 500,
                "n_weighted": 1000.0,
                "k_weighted": 500.0,
                "root_day_shares": {"2026-04-12": 1.0},
            },
        ],
    )
    carrier_terminal = _weighted_primitive(
        edge_id="b-to-x",
        source="node-b",
        dest="node-x",
        rows=[
            {
                "observed_date": "2026-04-12",
                "retrieved_at": "2026-04-27",
                "n": 416,
                "k": 34,
                "n_weighted": 59.42857142857142,
                "k_weighted": 4.857142857142857,
                "root_day_shares": {"2026-04-12": 1.0},
            },
            {
                "observed_date": "2026-04-15",
                "retrieved_at": "2026-04-30",
                "n": 1995,
                "k": 172,
                "n_weighted": 285.0,
                "k_weighted": 24.57142857142857,
                "root_day_shares": {"2026-04-15": 1.0},
            },
            {
                "observed_date": "2026-04-18",
                "retrieved_at": "2026-05-02",
                "n": 675,
                "k": 65,
                "n_weighted": 96.42857142857142,
                "k_weighted": 9.285714285714285,
                "root_day_shares": {"2026-04-18": 1.0},
            },
        ],
    )
    subject = _weighted_primitive(
        edge_id="x-to-y",
        source="node-x",
        dest="node-y",
        rows=[
            {
                "observed_date": "2026-04-12",
                "retrieved_at": "2026-04-30",
                "n": 43,
                "k": 31,
                "n_weighted": 43.0,
                "k_weighted": 31.0,
                "root_day_shares": {"2026-04-12": 1.0},
            },
            {
                "observed_date": "2026-04-13",
                "retrieved_at": "2026-05-01",
                "n": 50,
                "k": 33,
                "n_weighted": 50.0,
                "k_weighted": 33.0,
                "root_day_shares": {"2026-04-13": 1.0},
            },
        ],
    )
    runtime = SimpleNamespace(
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-y",
        composed_carrier=_span(cdf_draws=[[0.0] + [1.0] * 24], p_draws=[1.0]),
        composed_subject=_span(cdf_draws=[[0.0] + [1.0] * 24], p_draws=[1.0]),
        conditioned_primitive_map={
            "a-to-b": carrier_first,
            "b-to-x": carrier_terminal,
            "x-to-y": subject,
        },
        runtime_provenance={
            "primitives": {
                "carrier": [{"edge_id": "a-to-b"}, {"edge_id": "b-to-x"}],
                "subject": [{"edge_id": "x-to-y"}],
            },
        },
    )

    # Per docs/current/cohort-1apr-falling-k-problem-statement.md A.6
    # phase 1: populate M_select and X_prefix on the runtime so the
    # display builder reads them rather than rebuilding.
    n_cohort = {
        "2026-04-12": 1000.0,
        "2026-04-13": 1000.0,
        "2026-04-14": 1000.0,
        "2026-04-15": 1000.0,
        "2026-04-16": 1000.0,
        "2026-04-17": 1000.0,
        "2026-04-18": 1000.0,
    }
    cohort_list = [
        {"anchor_day": ad} for ad in n_cohort.keys()
    ]
    anchor_keys = list(n_cohort.keys())
    from runner.cohort_forecast_v3 import (
        _build_carrier_only_denominator_prefix,
    )
    runtime.selected_source_day_mass = _select_source_day_mass_at_x(
        denominator_node="node-x",
        n_cohort_by_anchor=n_cohort,
        carrier_cdf=[0.0] + [1.0] * 24,
    )
    runtime.selected_x_prefix = _build_carrier_only_denominator_prefix(
        runtime=runtime,
        anchor_days=anchor_keys,
        n_cohort_by_anchor=n_cohort,
        max_tau=24,
    )
    runtime.selected_y_prefix = None
    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=cohort_list,
        anchor_from="2026-04-12",
        anchor_to="2026-04-18",
        max_tau=24,
    )

    assert selected is not None
    aggregate = selected.aggregate_by_tau(max_tau=24)
    assert any(bucket["sum_x"] > 0 for bucket in aggregate.values())
    for tau, bucket in aggregate.items():
        assert bucket["sum_y"] <= bucket["sum_x"], (
            f"tau={tau}: selected evidence must preserve Y_A(tau) <= "
            f"X_A(tau), got Y={bucket['sum_y']} X={bucket['sum_x']}"
        )

    for anchor_day in ("2026-04-12", "2026-04-13", "2026-04-18"):
        prefix = selected.prefix_for_anchor_day(anchor_day, horizon=24)
        if prefix is None:
            continue
        assert any(x > 0 for x in prefix.obs_x)
        for tau, (obs_x, obs_y) in enumerate(zip(prefix.obs_x, prefix.obs_y)):
            assert obs_y <= obs_x, (
                f"anchor={anchor_day} tau={tau}: selected prefix must "
                f"preserve Y_A(tau) <= X_A(tau), got Y={obs_y} X={obs_x}"
            )


def test_runtime_built_selected_a_clock_evidence_composes_role_spans():
    """Multi-edge roles cannot use only the terminal primitive's rows."""
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    carrier_first = _weighted_primitive(
        edge_id="a-to-b",
        source="node-a",
        dest="node-b",
        rows=[{
            "observed_date": "2026-03-02",
            "retrieved_at": "2026-03-03",
            "n": 100,
            "k": 12,
            "n_weighted": 100.0,
            "k_weighted": 12.0,
            "root_day_shares": {"2026-03-01": 1.0},
        }],
    )
    carrier_terminal = _weighted_primitive(
        edge_id="b-to-x",
        source="node-b",
        dest="node-x",
        rows=[{
            "observed_date": "2026-03-02",
            "retrieved_at": "2026-03-03",
            "n": 100,
            "k": 30,
            "n_weighted": 100.0,
            "k_weighted": 30.0,
            "root_day_shares": {"2026-03-01": 1.0},
        }],
    )
    subject_first = _weighted_primitive(
        edge_id="x-to-c",
        source="node-x",
        dest="node-c",
        rows=[{
            "observed_date": "2026-03-02",
            "retrieved_at": "2026-03-03",
            "n": 30,
            "k": 7,
            "n_weighted": 30.0,
            "k_weighted": 7.0,
            "root_day_shares": {"2026-03-02": 1.0},
        }],
    )
    subject_terminal = _weighted_primitive(
        edge_id="c-to-y",
        source="node-c",
        dest="node-y",
        rows=[{
            "observed_date": "2026-03-02",
            "retrieved_at": "2026-03-03",
            "n": 30,
            "k": 20,
            "n_weighted": 30.0,
            "k_weighted": 20.0,
            "root_day_shares": {"2026-03-02": 1.0},
        }],
    )
    runtime = SimpleNamespace(
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-y",
        composed_carrier=_span(cdf_draws=[[0.0, 1.0, 1.0, 1.0, 1.0]], p_draws=[1.0]),
        composed_subject=_span(cdf_draws=[[0.0, 1.0, 1.0, 1.0, 1.0]], p_draws=[1.0]),
        conditioned_primitive_map={
            "a-to-b": carrier_first,
            "b-to-x": carrier_terminal,
            "x-to-c": subject_first,
            "c-to-y": subject_terminal,
        },
        runtime_provenance={
            "primitives": {
                "carrier": [{"edge_id": "a-to-b"}, {"edge_id": "b-to-x"}],
                "subject": [{"edge_id": "x-to-c"}, {"edge_id": "c-to-y"}],
            },
        },
    )

    # Per docs/current/cohort-1apr-falling-k-problem-statement.md A.6
    # phase 1: M_select and X_prefix are runtime-resolved; multi-edge
    # roles no longer drive X amplitude through carrier max-flow on
    # the observed surface — X_prefix is N_cohort × G_carrier (carrier-
    # only). The carrier observed surface still gates whether the cell
    # EXISTS at this τ via chain coverage, so multi-edge carrier
    # presence is exercised. Set N_cohort=12 so the X assertion at τ=2
    # retains its numeric expectation.
    from runner.cohort_forecast_v3 import (
        _build_carrier_only_denominator_prefix,
    )
    runtime.selected_source_day_mass = _select_source_day_mass_at_x(
        denominator_node="node-x",
        n_cohort_by_anchor={"2026-03-01": 12.0},
        carrier_cdf=[0.0, 1.0, 1.0, 1.0, 1.0],
    )
    runtime.selected_x_prefix = _build_carrier_only_denominator_prefix(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": 12.0},
        max_tau=4,
    )
    runtime.selected_y_prefix = None
    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{"anchor_day": "2026-03-01"}],
        anchor_from="2026-03-01",
        anchor_to="2026-03-01",
        max_tau=4,
    )

    assert selected is not None
    aggregate = selected.aggregate_by_tau()
    # X_prefix(C, τ=2) = N_cohort × G_carrier(C, 2) = 12 × 1.0 = 12.
    # The carrier observed surface still gates cell visibility via
    # chain coverage (multi-edge presence at-or-before τ), so the
    # multi-edge carrier composition is exercised by this fixture
    # even though X amplitude flows through the carrier-only formula.
    assert aggregate[2]["sum_x"] == pytest.approx(12.0)

    # Y_prefix at τ=2 now composes through the full subject role span.
    # The downstream C→Y row supplies a local age-kernel; it is not
    # discarded merely because this hand-built fixture's generated C-day
    # does not exactly equal the row's observed calendar day.
    assert aggregate[2]["sum_y"] == pytest.approx(1.4)
    assert 0.0 < aggregate[2]["sum_y"] < aggregate[2]["sum_x"]

    cell = selected.cells_by_anchor_day["2026-03-01"][2]
    assert cell.provenance["denominator_edge_ids"] == ["a-to-b", "b-to-x"]
    assert cell.provenance["numerator_edge_ids"] == ["x-to-c", "c-to-y"]


def test_runtime_built_selected_a_clock_evidence_requires_carrier_support_for_subject_rows():
    """X-clock subject rows cannot be copied onto the A-clock without carrier support."""
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    carrier = _weighted_primitive(
        edge_id="a-to-x",
        source="node-a",
        dest="node-x",
        rows=[
            {
                "observed_date": "2026-04-18",
                "retrieved_at": "2026-05-05",
                "n": 700,
                "k": 70,
                "n_weighted": 100.0,
                "k_weighted": 10.0,
            },
        ],
    )
    subject = _weighted_primitive(
        edge_id="x-to-y",
        source="node-x",
        dest="node-y",
        rows=[
            {
                "observed_date": "2026-04-18",
                "retrieved_at": "2026-05-05",
                "n": 70,
                "k": 63,
                "n_weighted": 70.0,
                "k_weighted": 63.0,
            },
        ],
    )
    runtime = SimpleNamespace(
        graph={},
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-y",
        composed_carrier=_span(
            cdf_draws=[[0.0] * 30],
            p_draws=[1.0],
        ),
        composed_subject=_span(
            cdf_draws=[[0.0] * 30],
            p_draws=[0.9],
        ),
        conditioned_primitive_map={
            "carrier": carrier,
            "subject": subject,
        },
        runtime_provenance={
            "primitives": {
                "carrier": [{"edge_id": "a-to-x"}],
                "subject": [{"edge_id": "x-to-y"}],
            },
        },
    )

    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[
            {"anchor_day": "2026-04-12"},
            {"anchor_day": "2026-04-13"},
            {"anchor_day": "2026-04-14"},
            {"anchor_day": "2026-04-15"},
            {"anchor_day": "2026-04-16"},
            {"anchor_day": "2026-04-17"},
            {"anchor_day": "2026-04-18"},
        ],
        anchor_from="2026-04-12",
        anchor_to="2026-04-18",
        max_tau=24,
    )

    assert selected is None or all(
        bucket["sum_y"] == pytest.approx(0.0)
        for bucket in selected.aggregate_by_tau(max_tau=24).values()
    )


# Retired: `test_identity_carrier_keeps_frontier_anchored_subject_residual`
# fed prefix data via the engine_cohort fields directly, relying on the
# reducer's branch-3 rescue (deleted in atom-3 stage 4 per
# `docs/current/cohort-maturity-atom-3-plan.md`). Its semantic intent —
# verify the identity-carrier Pop D residual produces a monotone forecast
# midpoint that stays above the empirical rate — is covered by
# `test_identity_carrier_residual_monotone_under_window` in
# `test_cf_pipeline_input_conditions.py`, which exercises the unified
# pipeline through the public entry with structural assertions derived
# from the spec rather than a hand-computed numeric against the
# legacy-rescue input shape.


def test_selected_a_clock_prefix_feeds_reducer_without_mutating_cohort():
    """The reducer consumes selected A-clock evidence as an explicit object."""
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _selected_cohort_group_rate_draws,
    )

    cohort = _single_active_cohort(frontier_age=0)
    cohort.obs_x = [0.0]
    cohort.obs_y = [0.0]
    cohort.x_frozen = 0.0
    cohort.y_frozen = 0.0
    cohort.a_pop = 100.0
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-02',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 30.0, 'y': 3.0},
                ],
            },
            {
                'snapshot_date': '2026-03-03',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 60.0, 'y': 12.0},
                ],
            },
        ],
    )

    draws = _selected_cohort_group_rate_draws(
        _runtime(
            subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95],
            carrier_cdf=[0.0, 0.20, 0.50, 0.80, 1.00, 1.00],
        ),
        [cohort],
        horizon=5,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        selected_a_clock_evidence=selected,
    )

    assert draws is not None
    assert draws[0, 2] == pytest.approx(12.0 / 60.0)
    assert cohort.frontier_age == 0
    assert cohort.x_frozen == pytest.approx(0.0)
    assert cohort.y_frozen == pytest.approx(0.0)


def test_frame_evidence_keeps_paired_x_y_when_x_provider_is_present():
    """Frame evidence must not replace selected X with carrier observations."""
    from runner.cohort_forecast_v3 import build_cohort_evidence_from_frames

    resolved = SimpleNamespace(
        latency=SimpleNamespace(
            sigma=0.0,
            mu=0.0,
            onset_delta_days=0.0,
        ),
    )
    frames = [
        {
            "snapshot_date": "2026-03-01",
            "data_points": [
                {
                    "anchor_day": "2026-03-01",
                    "x": 0.0,
                    "y": 0.0,
                    "a": 100.0,
                    "data_retrieved_at": "2026-03-01",
                },
            ],
        },
        {
            "snapshot_date": "2026-03-02",
            "data_points": [
                {
                    "anchor_day": "2026-03-01",
                    "x": 7.0,
                    "y": 1.0,
                    "a": 100.0,
                    "data_retrieved_at": "2026-03-02",
                },
            ],
        },
        {
            "snapshot_date": "2026-03-03",
            "data_points": [
                {
                    "anchor_day": "2026-03-01",
                    "x": 10.0,
                    "y": 2.0,
                    "a": 100.0,
                    "data_retrieved_at": "2026-03-03",
                },
            ],
        },
    ]

    evidence = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge={},
        anchor_from="2026-03-01",
        anchor_to="2026-03-01",
        sweep_to="2026-03-03",
        is_window=False,
        resolved=resolved,
        axis_tau_max=2,
    )

    assert evidence is not None
    assert len(evidence.engine_cohorts) == 1
    cohort = evidence.engine_cohorts[0]
    assert cohort.obs_x[2] == pytest.approx(10.0)
    assert cohort.obs_y[2] == pytest.approx(2.0)


def test_active_rows_report_selected_a_clock_evidence_as_forensic_only():
    """Row evidence is owned by the empirical spine, not SelectedAClockEvidence."""
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _project_runtime_rows,
    )
    tests_dir = os.path.dirname(__file__)
    if tests_dir not in sys.path:
        sys.path.insert(0, tests_dir)
    from test_model_span_spine_selected_cohort import (  # noqa: PLC0415
        _build_window_mode_spans,
        _candidate,
    )

    carrier, subject, empirical_carrier, empirical_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id="X",
                to_id="Y",
                observed_date="2026-03-01",
                retrieved_at="2026-03-03",
                n=50,
                k=5,
            ),
        ),
    )
    runtime = SimpleNamespace(
        population_root="X",
        denominator_node="X",
        subject_end="Y",
        public_moments=SimpleNamespace(
            p_mean=0.4,
            p_sd=0.05,
            p_sd_epistemic=0.03,
        ),
        unconditioned_overlays={},
        composed_carrier=carrier,
        composed_subject=subject,
        composed_carrier_predictive=carrier,
        composed_subject_predictive=subject,
        composed_empirical_carrier=empirical_carrier,
        composed_empirical_subject=empirical_subject,
    )
    cohort = _single_active_cohort(frontier_age=2)
    cohort.a_pop = 50.0
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-02',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 20.0, 'y': 0.0},
                ],
            },
            {
                'snapshot_date': '2026-03-03',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 50.0, 'y': 5.0},
                ],
            },
        ],
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': 0}],
        cohort_eval_ages=[2],
        cohort_weights=[50.0],
        max_tau=5,
        tau_solid_max=0,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        n_by_anchor={'0': 50.0},
        selected_a_clock_evidence=selected,
        emit_diagnostics=True,
    )

    by_tau = {int(r['tau_days']): r for r in rows}
    assert by_tau[2]['evidence_x'] == pytest.approx(50.0)
    assert by_tau[2]['evidence_y'] == pytest.approx(0.0)
    assert by_tau[2]['rate'] == pytest.approx(0.0)
    assert by_tau[2]['projected_rate'] is not None
    assert rows[0]['_row_evidence_source']['note'] == (
        'Production row evidence fields are emitted from the empirical '
        'spine selected_projection, not from SelectedAClockEvidence.'
    )
    forensic = rows[0]['_forensic_selected_a_clock_evidence']
    assert forensic['forensic_only'] is True
    assert forensic['row_evidence_owner'] is False
    assert any(
        cell['x_at_query_x'] == pytest.approx(50.0)
        and cell['y_at_subject_end'] == pytest.approx(5.0)
        for cell in forensic['cells']
    )


def test_active_a_clock_evidence_reads_only_coherent_selected_frames():
    """Evidence display reads paired X/Y selected rows, not mixed sources."""
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
    )

    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-02',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 30.0, 'y': 0.0},
                ],
            },
            {
                'snapshot_date': '2026-03-03',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 60.0, 'y': 6.0},
                ],
            },
            {
                'snapshot_date': '2026-03-03',
                'data_points': [
                    {'anchor_day': '2026-03-04', 'x': 900.0, 'y': 900.0},
                ],
            },
        ],
    )

    aggregate = selected.aggregate_by_tau()
    assert aggregate[1]['sum_x'] == pytest.approx(30.0)
    assert aggregate[2]['sum_x'] == pytest.approx(60.0)
    assert aggregate[2]['sum_y'] == pytest.approx(6.0)

    selected_family = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-02',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-02',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 30.0, 'y': 0.0},
                ],
            },
            {
                'snapshot_date': '2026-03-03',
                'data_points': [
                    {'anchor_day': '2026-03-01', 'x': 60.0, 'y': 6.0},
                    {'anchor_day': '2026-03-02', 'x': 20.0, 'y': 2.0},
                ],
            },
        ],
    )
    epoch_b = selected_family.aggregate_by_tau(tau_solid_max=1, max_tau=3)
    assert epoch_b[1]['sum_x'] == pytest.approx(50.0)
    assert epoch_b[1]['denominator_pure'] == pytest.approx(50.0)
    # τ=2 carries anchor 2026-03-02 forward once; it does not sum that
    # anchor's τ=1 cell again. This is CDF/as-of semantics, not PDF deltas.
    assert epoch_b[2]['sum_x'] == pytest.approx(80.0)
    assert epoch_b[2]['sum_y'] == pytest.approx(8.0)
    assert epoch_b[2]['denominator_pure'] == pytest.approx(50.0)
    assert epoch_b[2]['denominator_fe'] == pytest.approx(80.0)
    assert epoch_b[3]['sum_x'] == pytest.approx(80.0)
    assert epoch_b[3]['sum_y'] == pytest.approx(8.0)
    assert epoch_b[3]['denominator_pure'] == pytest.approx(50.0)
    assert epoch_b[3]['denominator_fe'] == pytest.approx(80.0)

    prefix = selected.prefix_for_anchor_day('2026-03-01', horizon=3)
    assert prefix is not None
    assert prefix.obs_x == pytest.approx([0.0, 30.0, 60.0, 60.0])
    assert prefix.obs_y == pytest.approx([0.0, 0.0, 6.0, 6.0])
    assert prefix.frontier_age == 2
    assert prefix.x_frozen == pytest.approx(60.0)
    assert prefix.y_frozen == pytest.approx(6.0)


def test_tau_observed_derives_from_data_retrieved_at_not_forward_fill_horizon():
    """tau_observed comes from per-cell data_retrieved_at, never from
    the forward-fill horizon. Canonical contract:
    DATE_MODEL_COHORT_MATURITY.md §2.3 and proposal at
    docs/current/cohort-maturity-frontier-from-data-retrieved-at.md.

    Fixture: three anchors 19/20/21-Mar; the only real retrieval is
    22-Mar, carried forward through daily grid frames up to sweep_to
    = 30-Apr. Without the fix, tau_observed would be (last_frame_date
    − anchor_day) — i.e. up to 42 — and tau_solid_max would be 40.
    With the fix, each cohort's tau_observed is (22-Mar − anchor_day),
    and tau_solid_max collapses to 1 (the youngest cohort's frontier).
    """
    from datetime import date, timedelta

    from runner.cohort_forecast_v3 import build_cohort_evidence_from_frames

    resolved = SimpleNamespace(
        latency=SimpleNamespace(
            sigma=0.0,
            mu=0.0,
            onset_delta_days=0.0,
        ),
    )

    anchors = ["2026-03-19", "2026-03-20", "2026-03-21"]
    frames = []
    grid_d = date(2026, 3, 22)
    last_grid = date(2026, 4, 30)
    while grid_d <= last_grid:
        data_points = [
            {
                "anchor_day": anchor,
                "x": 50.0,
                "y": 5.0,
                "a": 100.0,
                "data_retrieved_at": "2026-03-22",
            }
            for anchor in anchors
        ]
        frames.append({
            "snapshot_date": grid_d.isoformat(),
            "data_points": data_points,
        })
        grid_d += timedelta(days=1)

    evidence = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge={},
        anchor_from="2026-03-19",
        anchor_to="2026-03-21",
        sweep_to="2026-04-30",
        is_window=True,
        resolved=resolved,
    )

    assert evidence is not None
    cohorts_by_anchor = {
        c['anchor_day'].isoformat(): c for c in evidence.cohort_list
    }
    assert cohorts_by_anchor["2026-03-19"]['tau_observed'] == 3
    assert cohorts_by_anchor["2026-03-20"]['tau_observed'] == 2
    assert cohorts_by_anchor["2026-03-21"]['tau_observed'] == 1
    assert evidence.tau_solid_max == 1


def test_tau_observed_fallback_understates_flat_zero_y_cohorts():
    """Documented LOSSY failure mode for the no-provenance fallback:
    cohorts with all-zero y return tau_observed = 0 because 'last τ
    where y strictly increased' never fires. Pinning the limitation
    in test form (cohort-maturity-frontier-from-data-retrieved-at.md
    §6). Production paths preserve data_retrieved_at and don't engage
    this branch.
    """
    from datetime import date, timedelta

    from runner.cohort_forecast_v3 import build_cohort_evidence_from_frames

    resolved = SimpleNamespace(
        latency=SimpleNamespace(
            sigma=0.0,
            mu=0.0,
            onset_delta_days=0.0,
        ),
    )

    frames = []
    grid_d = date(2026, 3, 22)
    last_grid = date(2026, 3, 26)
    while grid_d <= last_grid:
        frames.append({
            "snapshot_date": grid_d.isoformat(),
            "data_points": [{
                "anchor_day": "2026-03-19",
                "x": 50.0,
                "y": 0.0,  # never converts
                "a": 100.0,
                # no data_retrieved_at -> fallback path
            }],
        })
        grid_d += timedelta(days=1)

    evidence = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge={},
        anchor_from="2026-03-19",
        anchor_to="2026-03-19",
        sweep_to="2026-03-26",
        is_window=True,
        resolved=resolved,
    )

    assert evidence is not None
    assert len(evidence.cohort_list) == 1
    cohort = evidence.cohort_list[0]
    # Documented under-statement: y is monotone-flat-at-zero, the
    # fallback returns 0 even though x > 0 means real observations
    # exist at every grid day.
    assert cohort['tau_observed'] == 0


def test_tau_observed_fallback_returns_last_strict_y_increase_under_plateau():
    """Documented LOSSY failure mode for the no-provenance fallback:
    when y rises and then plateaus, the fallback returns τ of the last
    strict increase, NOT τ of the last retrieval. Cohorts in post-
    conversion plateau have their frontier under-stated. Pinning the
    contract (cohort-maturity-frontier-from-data-retrieved-at.md §6).
    """
    from datetime import date, timedelta

    from runner.cohort_forecast_v3 import build_cohort_evidence_from_frames

    resolved = SimpleNamespace(
        latency=SimpleNamespace(
            sigma=0.0,
            mu=0.0,
            onset_delta_days=0.0,
        ),
    )

    # τ=0 → y=0; τ=1 → y=1; τ=2 → y=2 (last strict increase); τ=3..5 plateau.
    y_by_tau = {0: 0.0, 1: 1.0, 2: 2.0, 3: 2.0, 4: 2.0, 5: 2.0}
    frames = []
    base = date(2026, 3, 19)
    for tau in range(6):
        sd = (base + timedelta(days=tau)).isoformat()
        frames.append({
            "snapshot_date": sd,
            "data_points": [{
                "anchor_day": "2026-03-19",
                "x": 50.0,
                "y": y_by_tau[tau],
                "a": 100.0,
                # no data_retrieved_at -> fallback path
            }],
        })

    evidence = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge={},
        anchor_from="2026-03-19",
        anchor_to="2026-03-19",
        sweep_to="2026-03-24",
        is_window=True,
        resolved=resolved,
    )

    assert evidence is not None
    cohort = evidence.cohort_list[0]
    # τ=2 is the last strict increase (1 → 2). The plateau at τ=3..5
    # does not advance the fallback; the true retrieval-frontier (τ=5)
    # is unrecoverable without provenance. Documented limitation.
    assert cohort['tau_observed'] == 2


# ─── Focused tests for the rate-attribution fix ────────────────────────
# Per docs/current/cohort-1apr-falling-k-problem-statement.md A.5.

@pytest.mark.xfail(
    reason=(
        "73q Phases 2-3 refactor per-Cohort projection arrays and shared "
        "M_select substrate accessors. Revisit/rewrite this low-level "
        "Y-prefix canary when 73q is complete; 73q graph projections are "
        "acknowledged unreliable until then."
    ),
    strict=True,
)
def test_per_source_day_forward_fill_preserves_monotonicity_under_sparse():
    """Per docs A.5: per-source-day carry-forward then superaddition is
    monotone for non-negative selected masses and monotone local row
    rates, even when retrieval is sparse across source days.

    Scenario: two source days u=1 and u=2 contribute. u=1 has a row at
    τ=2 (k=4, n=10). u=2 has a row at τ=3 (k=6, n=10) but no row at
    τ=2. Under the old k-sum semantics, k(τ=2) = 4 and k(τ=3) = 6 —
    monotone but only because the example is small. Add a third source
    day u=3 with row at τ=2 only (k=8, n=10): the old semantics give
    k(τ=2) = 4 + 8 = 12 and k(τ=3) = 6 (drops!) because u=3 has no τ=3
    row. This is the falling-k mechanism.

    Under per-source-day rate-attribution: at τ=2, contributions are
    M(u=1) × (4/10) and M(u=3) × (8/10) (u=2 has no row at-or-before
    τ=2). At τ=3: M(u=1) × (4/10) (forward-filled), M(u=2) × (6/10),
    M(u=3) × (8/10) (forward-filled). Y(τ=3) ≥ Y(τ=2) by construction.
    """
    from runner.cohort_forecast_v3 import (
        _RateAttributedSubjectPrefix,
        _SelectedSourceDayMass,
        _SubjectChainEvidenceBuckets,
        _build_evidence_local_rate_attributed_subject_prefix,
    )

    # Mass at X for the cohort: equal mass per source day.
    # endpoint_cdf_by_node = cumulative of the per-day mass /n_cohort, per node.
    mass = _SelectedSourceDayMass(
        by_node={
            "node-x": {
                "2026-03-01": {
                    "2026-03-02": 1.0,  # u=1 (anchor + 1)
                    "2026-03-03": 1.0,  # u=2
                    "2026-03-04": 1.0,  # u=3
                },
            },
        },
        endpoint_cdf_by_node={"node-x": (0.0, 1/3, 2/3, 1.0)},
        n_cohort_by_anchor={"2026-03-01": 3.0},
        anchor_days=("2026-03-01",),
    )

    # Subject chain: single edge X -> end.
    buckets = _SubjectChainEvidenceBuckets(
        edge_nk_by_source_day={
            "x-to-end": {
                "2026-03-01": {
                    # u=1 (2026-03-02): observed at retr=2026-03-03 (τ=2).
                    "2026-03-02": {2: (10.0, 4.0)},
                    # u=2 (2026-03-03): observed at retr=2026-03-04 (τ=3).
                    "2026-03-03": {3: (10.0, 6.0)},
                    # u=3 (2026-03-04): observed at retr=2026-03-03 (τ=2).
                    "2026-03-04": {2: (10.0, 8.0)},
                },
            },
        },
        topology_edges=(("node-x", "node-end", "x-to-end"),),
    )

    prefix = _build_evidence_local_rate_attributed_subject_prefix(
        buckets=buckets,
        selected_source_day_mass=mass,
        anchor_days=["2026-03-01"],
        max_tau=5,
        denominator_node="node-x",
        end_node="node-end",
    )
    assert prefix is not None
    y_at_2 = prefix.value_at("2026-03-01", 2)
    y_at_3 = prefix.value_at("2026-03-01", 3)
    # τ=2: u=1 contributes 1.0 × 0.4 = 0.4; u=3 contributes 1.0 × 0.8
    # = 0.8; u=2 has no row at-or-before τ=2 → 0. Total = 1.2.
    assert y_at_2 == pytest.approx(1.2)
    # τ=3: u=1 forward-fills 0.4, u=2 contributes 0.6, u=3 forward-
    # fills 0.8. Total = 1.8. Strictly ≥ y_at_2.
    assert y_at_3 == pytest.approx(1.8)
    assert y_at_3 >= y_at_2


def test_y_prefix_value_at_forward_fills_not_exact_tau_only():
    """Per docs A.5 (review fix): _RateAttributedSubjectPrefix.value_at
    must forward-fill at-or-before tau, not return 0 for non-exact taus.

    When a carrier-only X cell exists at a τ where Y has no exact entry,
    Y_prefix.value_at(τ) must return the latest Y value at-or-before τ —
    otherwise carrier cells reset Y to 0 and reintroduce falling-k.
    """
    from runner.cohort_forecast_v3 import _RateAttributedSubjectPrefix

    prefix = _RateAttributedSubjectPrefix(
        cumulative_by_anchor={
            "2026-03-01": {2: 5.0, 5: 9.0},
        },
        landing_coverage_by_anchor={"2026-03-01": {2: 1.0, 5: 1.0}},
    )
    assert prefix.value_at("2026-03-01", 1) == 0.0  # before any cell
    assert prefix.value_at("2026-03-01", 2) == 5.0  # exact
    assert prefix.value_at("2026-03-01", 3) == 5.0  # forward-fill
    assert prefix.value_at("2026-03-01", 4) == 5.0  # forward-fill
    assert prefix.value_at("2026-03-01", 5) == 9.0  # exact
    assert prefix.value_at("2026-03-01", 10) == 9.0  # forward-fill past last


def test_x_prefix_is_carrier_only_n_cohort_times_g_carrier():
    """Per docs A.5 / A.1 §157 / A.3: X_prefix(C, tau) = N_cohort(C) ×
    G_carrier(C, tau), where G_carrier is the **prior** carrier-only
    A→X conditional CDF — the same primitive-evidence-clock
    composition that produces M_select(X). Sourced by integrating
    M_select(X, C, ·) per anchor day so X_prefix and Y_prefix share
    one carrier reach reference. Not posterior. Not from observed
    surface. Not from A_pop fallback.
    """
    from runner.cohort_forecast_v3 import (
        _build_carrier_only_denominator_prefix,
        _SelectedSourceDayMass,
    )

    # Synthetic M_select(X) on the anchor's clock with arrival pmf
    # [0, 0.20, 0.30, 0.30, 0.20]; integrating gives the
    # 100 × [0, 0.20, 0.50, 0.80, 1.00] cumulative we expect at X_prefix.
    runtime = SimpleNamespace(
        denominator_node="node-x",
        selected_source_day_mass=_SelectedSourceDayMass(
            by_node={
                "node-x": {
                    "2026-03-01": {
                        "2026-03-02": 20.0,
                        "2026-03-03": 30.0,
                        "2026-03-04": 30.0,
                        "2026-03-05": 20.0,
                    },
                },
            },
            endpoint_cdf_by_node={"node-x": (0.0, 0.20, 0.50, 0.80, 1.00)},
            n_cohort_by_anchor={"2026-03-01": 100.0},
            anchor_days=("2026-03-01",),
            provenance={'source': 'test_fixture'},
        ),
    )
    x_prefix = _build_carrier_only_denominator_prefix(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": 100.0},
        max_tau=4,
    )
    assert x_prefix is not None
    # X_prefix(C, tau) = N_cohort × cumulative_pmf[tau].
    assert x_prefix.value_at("2026-03-01", 0) == pytest.approx(0.0)
    assert x_prefix.value_at("2026-03-01", 1) == pytest.approx(20.0)
    assert x_prefix.value_at("2026-03-01", 2) == pytest.approx(50.0)
    assert x_prefix.value_at("2026-03-01", 3) == pytest.approx(80.0)
    assert x_prefix.value_at("2026-03-01", 4) == pytest.approx(100.0)
    # Past horizon: forward-fill clamps to last value.
    assert x_prefix.value_at("2026-03-01", 99) == pytest.approx(100.0)
    # X_prefix provenance: integrated M_select at denominator node,
    # NOT joint-conditioned composed_carrier (per docs §A.3).
    assert x_prefix.provenance.get('source') == (
        'integrated_m_select_at_denominator_node.v1'
    )


def _make_test_subject_primitive(*, edge_id, source, dest):
    """Minimal ConditionedTransitionPrimitive whose only role in
    `_build_selected_source_day_mass` is to expose
    `transition.source_node` for the U-set iteration.
    """
    from runner.primitives import (
        ConditionedTransitionPrimitive,
        ConditioningStatus,
        PrimitiveScope,
        TimingFamily,
        TransitionIdentity,
        WeightedPrimitiveEvidenceView,
    )
    return ConditionedTransitionPrimitive(
        transition=TransitionIdentity(
            source_node=source, destination_node=dest, edge_id=edge_id,
        ),
        scope=PrimitiveScope(
            scenario_id="t", evidence_role="window_subject_helper",
            date_from="2026-03-01", date_to="2026-03-10",
            as_at=None, context_key=None, regime_key=None,
            model_source_preference="best_available",
            resolved_source_identity="t",
        ),
        draw_count=1,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=f"s:{edge_id}",
        weighted_evidence=WeightedPrimitiveEvidenceView(
            n_weighted_total=0.0, k_weighted_total=0.0,
            n_weighted_total_draws=np.zeros(1, dtype=np.float64),
            k_weighted_total_draws=np.zeros(1, dtype=np.float64),
            draw_count=1,
            rows=(),
            arrival_weight_summary={"topology_case": "test"},
            binding_policy="t", evidence_scope_key=f"s:{edge_id}",
        ),
        effective_evidence_totals=(0.0, 0.0),
        subset_policy=None, compatibility_blend=None, residual_policy=None,
        probability_posterior=None, timing_posterior=None,
        probability_prior=None, timing_prior=None,
        draw_family_key=None, prior_source="t",
    )


def _delta_zero_transition():
    """TimingTransitionPrimitive that contributes a δ(0) latency:
    no delay, p=1.0. Used to compose chains where extra edges should
    fall out as no-ops (the multi-hop degeneracy of single-hop)."""
    from runner.timing_span import TimingTransitionPrimitive
    return TimingTransitionPrimitive(
        p=1.0, mu=0.0, sigma=0.0, onset=0.0, source="prior_test",
    )


def _delta_at_offset_transition(offset):
    """TimingTransitionPrimitive whose density places a delta at the
    given non-negative integer offset (sigma small but >0 so the
    'near-degenerate' branch in `_edge_sub_probability_density`
    fires; idx = round(onset + exp(mu)) = offset for mu=0 and
    onset=offset-1)."""
    from runner.timing_span import TimingTransitionPrimitive
    return TimingTransitionPrimitive(
        p=1.0, mu=0.0, sigma=0.05,
        onset=float(max(0, int(offset) - 1)),
        source="prior_test",
    )


def _partial_reach_transition(p, offset):
    """TimingTransitionPrimitive with edge reach `p < 1.0`. Used to
    exercise reach-preserving M_select scaling: the contribution to
    the convolved density carries `p` as mass, not 1.0."""
    from runner.timing_span import TimingTransitionPrimitive
    return TimingTransitionPrimitive(
        p=float(p), mu=0.0, sigma=0.05,
        onset=float(max(0, int(offset) - 1)),
        source="prior_test",
    )


def test_m_select_construction_at_x_uses_unified_a_rooted_composer():
    """Per docs A.1 §148-153 / A.6 phase 1: M_select(X, C, u) is the
    V = X iteration of the same A-rooted composer call that produces
    M_select at every other subject primitive source node. With a
    delta-at-0 carrier (mass entirely at the anchor day), all cohort
    mass is at U = X on day = anchor — no pre-conditioning timing
    posterior involved."""
    from runner.cohort_forecast_v3 import _build_selected_source_day_mass

    runtime = SimpleNamespace(
        graph={
            "nodes": [
                {"id": "node-a"}, {"id": "node-x"}, {"id": "node-end"},
            ],
            "edges": [
                {"from": "node-a", "to": "node-x", "id": "a-to-x"},
                {"from": "node-x", "to": "node-end", "id": "x-to-end"},
            ],
        },
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-end",
        source_layer_transitions={
            ("node-a", "node-x"): _delta_zero_transition(),
            ("node-x", "node-end"): _delta_at_offset_transition(2),
        },
    )
    primitives = [
        _make_test_subject_primitive(
            edge_id="x-to-end", source="node-x", dest="node-end",
        ),
    ]
    mass = _build_selected_source_day_mass(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": 100.0},
        subject_primitives=primitives,
        max_tau=8,
    )
    assert mass is not None
    assert mass.has_node("node-x")
    # Carrier is δ(0): all 100 cohort units arrive at X on the anchor day.
    assert mass.mass_at("node-x", "2026-03-01", "2026-03-01") == pytest.approx(100.0)
    # No spurious mass on other days.
    assert mass.mass_at("node-x", "2026-03-01", "2026-03-02") == pytest.approx(0.0)
    # The construction provenance must record the unified composer
    # path (A.6 phase 1) — there is no separate "first layer" tag.
    assert mass.provenance.get("composition") == (
        "compose_timing_span_from_transition_primitives"
    )
    assert mass.provenance.get("no_hop_branch") is True


@pytest.mark.xfail(
    reason=(
        "73q Phases 2-3 refactor per-Cohort projection arrays and shared "
        "M_select substrate accessors. Revisit/rewrite this multi-hop "
        "M_select canary when 73q is complete; 73q graph projections are "
        "acknowledged unreliable until then."
    ),
    strict=True,
)
def test_m_select_construction_for_multi_hop_downstream_node():
    """A multi-hop subject's downstream source node U sees M_select
    composed end-to-end by the same composer call: A → X → mid is
    walked once, returning the joint conditional CDF at mid. Single-
    hop and multi-hop are not separate code paths."""
    from runner.cohort_forecast_v3 import _build_selected_source_day_mass

    runtime = SimpleNamespace(
        graph={
            "nodes": [
                {"id": "node-a"}, {"id": "node-x"},
                {"id": "node-mid"}, {"id": "node-end"},
            ],
            "edges": [
                {"from": "node-a", "to": "node-x", "id": "a-to-x"},
                {"from": "node-x", "to": "node-mid", "id": "x-to-mid"},
                {"from": "node-mid", "to": "node-end", "id": "mid-to-end"},
            ],
        },
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-end",
        source_layer_transitions={
            # Carrier delta at 0: cohort at X on the anchor day.
            ("node-a", "node-x"): _delta_zero_transition(),
            # First subject edge: deterministic +2 day delay.
            ("node-x", "node-mid"): _delta_at_offset_transition(2),
            # Second subject edge: deterministic +1 day delay.
            ("node-mid", "node-end"): _delta_at_offset_transition(1),
        },
    )
    primitives = [
        _make_test_subject_primitive(
            edge_id="x-to-mid", source="node-x", dest="node-mid",
        ),
        _make_test_subject_primitive(
            edge_id="mid-to-end", source="node-mid", dest="node-end",
        ),
    ]
    mass = _build_selected_source_day_mass(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": 100.0},
        subject_primitives=primitives,
        max_tau=12,
    )
    assert mass is not None
    # X comes from carrier composition (A → X with δ(0)): 100 at anchor.
    assert mass.mass_at("node-x", "2026-03-01", "2026-03-01") == pytest.approx(100.0)
    # mid comes from joint A → X → mid composition: δ(0) ⊛ δ(2) = δ(2).
    # 100 cohort units at mid on anchor + 2 days = 2026-03-03.
    assert mass.has_node("node-mid")
    assert mass.mass_at("node-mid", "2026-03-01", "2026-03-03") == pytest.approx(100.0)
    # Both nodes share one provenance string — single composition path.
    assert mass.provenance.get("no_hop_branch") is True


def test_m_select_no_hop_branch_single_and_multi_hop_share_construction():
    """§A.5 invariant: single-hop and multi-hop must enter the same
    construction; single-hop is the chain-of-length-1 degeneracy of
    the same composer call. Demonstrated via provenance equality."""
    from runner.cohort_forecast_v3 import _build_selected_source_day_mass

    def build(graph, transitions, primitives):
        runtime = SimpleNamespace(
            graph=graph,
            population_root="node-a",
            denominator_node="node-x",
            subject_end="node-end",
            source_layer_transitions=transitions,
        )
        return _build_selected_source_day_mass(
            runtime=runtime,
            anchor_days=["2026-03-01"],
            n_cohort_by_anchor={"2026-03-01": 50.0},
            subject_primitives=primitives,
            max_tau=8,
        )

    single_hop = build(
        graph={
            "nodes": [
                {"id": "node-a"}, {"id": "node-x"}, {"id": "node-end"},
            ],
            "edges": [
                {"from": "node-a", "to": "node-x", "id": "a-to-x"},
                {"from": "node-x", "to": "node-end", "id": "x-to-end"},
            ],
        },
        transitions={
            ("node-a", "node-x"): _delta_zero_transition(),
            ("node-x", "node-end"): _delta_at_offset_transition(1),
        },
        primitives=[
            _make_test_subject_primitive(
                edge_id="x-to-end", source="node-x", dest="node-end",
            ),
        ],
    )
    multi_hop = build(
        graph={
            "nodes": [
                {"id": "node-a"}, {"id": "node-x"},
                {"id": "node-mid"}, {"id": "node-end"},
            ],
            "edges": [
                {"from": "node-a", "to": "node-x", "id": "a-to-x"},
                {"from": "node-x", "to": "node-mid", "id": "x-to-mid"},
                {"from": "node-mid", "to": "node-end", "id": "mid-to-end"},
            ],
        },
        transitions={
            ("node-a", "node-x"): _delta_zero_transition(),
            ("node-x", "node-mid"): _delta_at_offset_transition(1),
            ("node-mid", "node-end"): _delta_zero_transition(),
        },
        primitives=[
            _make_test_subject_primitive(
                edge_id="x-to-mid", source="node-x", dest="node-mid",
            ),
            _make_test_subject_primitive(
                edge_id="mid-to-end", source="node-mid", dest="node-end",
            ),
        ],
    )

    assert single_hop is not None and multi_hop is not None
    # Provenance proves both paths went through the same construction.
    assert (
        single_hop.provenance.get("composition")
        == multi_hop.provenance.get("composition")
        == "compose_timing_span_from_transition_primitives"
    )
    assert single_hop.provenance.get("no_hop_branch") is True
    assert multi_hop.provenance.get("no_hop_branch") is True
    # Single-hop populated only U = X (its only subject primitive's
    # source). Multi-hop populated both U = X and U = mid.
    assert set(single_hop.by_node.keys()) == {"node-x"}
    assert set(multi_hop.by_node.keys()) == {"node-x", "node-mid"}


def test_m_select_degenerate_equivalence_delta_zero_extra_edge():
    """Multi-hop with a δ(0) extra edge produces M_select at the
    further source node identical to M_select at the original source.
    This is the degenerate-equivalence form of "single-hop is the
    chain-of-length-N degeneracy of the same composer" (§A.5).
    """
    from runner.cohort_forecast_v3 import _build_selected_source_day_mass

    runtime = SimpleNamespace(
        graph={
            "nodes": [
                {"id": "node-a"}, {"id": "node-x"},
                {"id": "node-mid"}, {"id": "node-end"},
            ],
            "edges": [
                {"from": "node-a", "to": "node-x", "id": "a-to-x"},
                {"from": "node-x", "to": "node-mid", "id": "x-to-mid"},
                {"from": "node-mid", "to": "node-end", "id": "mid-to-end"},
            ],
        },
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-end",
        source_layer_transitions={
            # Carrier with non-trivial latency so M_select(X, ·, ·)
            # has spread across multiple days (interesting comparison).
            ("node-a", "node-x"): _delta_at_offset_transition(2),
            # X → mid is δ(0): no delay. So M_select(mid) MUST equal
            # M_select(X) at every day.
            ("node-x", "node-mid"): _delta_zero_transition(),
            ("node-mid", "node-end"): _delta_at_offset_transition(1),
        },
    )
    primitives = [
        _make_test_subject_primitive(
            edge_id="x-to-mid", source="node-x", dest="node-mid",
        ),
        _make_test_subject_primitive(
            edge_id="mid-to-end", source="node-mid", dest="node-end",
        ),
    ]
    mass = _build_selected_source_day_mass(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": 75.0},
        subject_primitives=primitives,
        max_tau=12,
    )
    assert mass is not None
    # The δ(0) X→mid edge convolved with A→X yields A→mid with the
    # same density as A→X. Per-day mass at mid must equal per-day
    # mass at X.
    x_per_anchor = mass.by_node["node-x"]["2026-03-01"]
    mid_per_anchor = mass.by_node["node-mid"]["2026-03-01"]
    assert set(x_per_anchor.keys()) == set(mid_per_anchor.keys())
    for day, x_mass in x_per_anchor.items():
        assert mid_per_anchor[day] == pytest.approx(x_mass), (
            f"day={day}: M_select at mid ({mid_per_anchor[day]}) must "
            f"equal M_select at X ({x_mass}) when X→mid is δ(0)"
        )


def test_m_select_preserves_reach_across_hops_under_partial_edge_p():
    """Per docs §A.3 line 153: M_select(U, C, u) = N_cohort(C) ×
    g_{A→U}[u−C], where g_{A→U} is the per-day reach-preserving
    arrival increment, NOT the within-arrival (conditional) PMF.

    Therefore Σ_τ M_select(U, C, τ) = N_cohort × reach_A→U.

    With p<1.0 transitions this assertion distinguishes density-form
    from conditional-form M_select: under conditional form (the
    earlier bug) the sum would be N_cohort regardless of reach, and
    multi-hop downstream evidence would be over-attributed by
    1/reach_X→U. The p=1.0 fixtures elsewhere in this file cannot
    catch this because reach=1 collapses the two forms.
    """
    from runner.cohort_forecast_v3 import _build_selected_source_day_mass

    p_carrier = 0.5     # reach_A→X = 0.5
    p_subject_mid = 0.6  # reach_X→mid = 0.6 → reach_A→mid = 0.30
    n_cohort = 100.0

    runtime = SimpleNamespace(
        graph={
            "nodes": [
                {"id": "node-a"}, {"id": "node-x"},
                {"id": "node-mid"}, {"id": "node-end"},
            ],
            "edges": [
                {"from": "node-a", "to": "node-x", "id": "a-to-x"},
                {"from": "node-x", "to": "node-mid", "id": "x-to-mid"},
                {"from": "node-mid", "to": "node-end", "id": "mid-to-end"},
            ],
        },
        population_root="node-a",
        denominator_node="node-x",
        subject_end="node-end",
        source_layer_transitions={
            ("node-a", "node-x"): _partial_reach_transition(p_carrier, 1),
            ("node-x", "node-mid"): _partial_reach_transition(p_subject_mid, 2),
            ("node-mid", "node-end"): _delta_at_offset_transition(1),
        },
    )
    primitives = [
        _make_test_subject_primitive(
            edge_id="x-to-mid", source="node-x", dest="node-mid",
        ),
        _make_test_subject_primitive(
            edge_id="mid-to-end", source="node-mid", dest="node-end",
        ),
    ]
    mass = _build_selected_source_day_mass(
        runtime=runtime,
        anchor_days=["2026-03-01"],
        n_cohort_by_anchor={"2026-03-01": n_cohort},
        subject_primitives=primitives,
        max_tau=12,
    )
    assert mass is not None

    # M_select(X, anchor, ·) sums to N_cohort × reach_A→X,
    # i.e. 100 × 0.5 = 50 — NOT 100. The conditional-CDF form would
    # have summed to 100 here.
    x_total = sum(mass.by_node["node-x"]["2026-03-01"].values())
    expected_x = n_cohort * p_carrier
    assert x_total == pytest.approx(expected_x, rel=1e-3), (
        f"M_select(X) sum {x_total} != N_cohort × reach_A→X "
        f"{expected_x}; under-attribution would be the conditional-"
        f"CDF bug returning N_cohort={n_cohort}."
    )
    assert x_total < n_cohort, (
        "Reach-preserving M_select(X) must be strictly less than "
        "N_cohort when reach_A→X < 1; equality indicates the "
        "conditional-CDF bug has been reintroduced."
    )

    # M_select(mid, anchor, ·) sums to N_cohort × reach_A→mid,
    # i.e. 100 × 0.5 × 0.6 = 30. Multi-hop reach attenuation
    # propagates correctly.
    mid_total = sum(mass.by_node["node-mid"]["2026-03-01"].values())
    expected_mid = n_cohort * p_carrier * p_subject_mid
    assert mid_total == pytest.approx(expected_mid, rel=1e-3), (
        f"M_select(mid) sum {mid_total} != N_cohort × reach_A→mid "
        f"{expected_mid}."
    )

    # Provenance must record density-form basis to make the semantics
    # auditable — a future refactor that silently switched back to
    # conditional_cdf should be caught here.
    assert mass.provenance.get("cdf_basis") == "density_cdf"
    assert (
        mass.provenance.get("mass_semantics")
        == "physical_reach_preserving"
    )
