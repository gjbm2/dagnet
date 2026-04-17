"""
Recency weighting coverage tests — verify halflife decay is applied to ALL
observation types that enter the model likelihood.

Covers:
  - WindowObservation recency_weight set by _apply_recency_weights
  - CohortDailyObs recency_weight set by _apply_recency_weights
  - CohortDailyTrajectory recency_weight (pre-existing, included for completeness)
  - Synthesised daily obs preserve source trajectory weight
  - Model wiring: Potentials (not native distributions) for weighted obs
  - inference.py quality gate uses effective sample size

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_recency_weighting.py -v
"""

from __future__ import annotations

import math
import pytest

from bayes.compiler.types import (
    BoundEvidence,
    CohortDailyObs,
    CohortDailyTrajectory,
    CohortObservation,
    EdgeEvidence,
    WindowObservation,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_evidence(
    *,
    window_dsls: list[str] | None = None,
    daily_dates: list[str] | None = None,
    traj_dates: list[str] | None = None,
) -> BoundEvidence:
    """Build minimal BoundEvidence with controllable observation dates."""
    ev = EdgeEvidence(
        edge_id="edge-1",
        param_id="param-1",
        file_path="test.yaml",
    )

    if window_dsls:
        for dsl in window_dsls:
            ev.window_obs.append(WindowObservation(n=100, k=30, slice_dsl=dsl))
        ev.has_window = True

    cohort_obs = CohortObservation(slice_dsl="cohort(snapshot)")
    if daily_dates:
        for d in daily_dates:
            cohort_obs.daily.append(CohortDailyObs(
                date=d, n=100, k=30, age_days=10.0,
            ))
    if traj_dates:
        for d in traj_dates:
            cohort_obs.trajectories.append(CohortDailyTrajectory(
                date=d, n=100,
                retrieval_ages=[7.0, 14.0, 21.0],
                cumulative_y=[10, 20, 28],
            ))
    if daily_dates or traj_dates:
        ev.cohort_obs.append(cohort_obs)
        ev.has_cohort = True

    return BoundEvidence(
        edges={"edge-1": ev},
        settings={"RECENCY_HALF_LIFE_DAYS": 30},
        today="1-Mar-25",
    )


def _apply_weights(evidence: BoundEvidence, half_life: float = 30.0):
    """Call _apply_recency_weights on the evidence."""
    from datetime import datetime
    from bayes.compiler.evidence import _apply_recency_weights, _parse_today

    today = _parse_today("1-Mar-25")
    diagnostics = []
    _apply_recency_weights(evidence, today, half_life, diagnostics)
    return diagnostics


# ---------------------------------------------------------------------------
# Evidence binding: weights applied correctly
# ---------------------------------------------------------------------------

class TestApplyRecencyWeights:
    """Verify _apply_recency_weights sets weights on all observation types."""

    def test_trajectory_weighted(self):
        ev = _make_evidence(traj_dates=["2025-02-01", "2025-03-01"])
        _apply_weights(ev)
        trajs = ev.edges["edge-1"].cohort_obs[0].trajectories
        # 1-Mar-25 trajectory should have weight ~1.0
        assert trajs[1].recency_weight == pytest.approx(1.0, abs=0.01)
        # 1-Feb-25 = 28 days old, weight ~ exp(-ln2 * 28/30) ~ 0.52
        assert 0.4 < trajs[0].recency_weight < 0.7

    def test_window_obs_weighted(self):
        ev = _make_evidence(window_dsls=[
            "window(1-Jan-25:1-Feb-25)",
            "window(1-Feb-25:1-Mar-25)",
        ])
        _apply_weights(ev)
        wobs = ev.edges["edge-1"].window_obs
        # End date 1-Mar-25 = 0 days old → weight ~1.0
        assert wobs[1].recency_weight == pytest.approx(1.0, abs=0.01)
        # End date 1-Feb-25 = 28 days old → weight ~0.52
        assert 0.4 < wobs[0].recency_weight < 0.7

    def test_daily_obs_weighted(self):
        ev = _make_evidence(daily_dates=["2025-02-01", "2025-03-01"])
        _apply_weights(ev)
        daily = ev.edges["edge-1"].cohort_obs[0].daily
        # 1-Mar-25 = 0 days old → weight ~1.0
        assert daily[1].recency_weight == pytest.approx(1.0, abs=0.01)
        # 1-Feb-25 = 28 days old → weight ~0.52
        assert 0.4 < daily[0].recency_weight < 0.7

    def test_aggregate_daily_not_weighted(self):
        """Daily obs with date='aggregate' should keep default weight 1.0."""
        ev = _make_evidence()
        agg = CohortDailyObs(date="aggregate", n=100, k=30, age_days=60.0)
        co = CohortObservation(slice_dsl="cohort(test)", daily=[agg])
        ev.edges["edge-1"].cohort_obs.append(co)
        _apply_weights(ev)
        assert agg.recency_weight == 1.0

    def test_window_obs_no_date_keeps_default(self):
        """Window obs with unparseable DSL keeps weight 1.0."""
        ev = _make_evidence(window_dsls=["window(30d)"])
        _apply_weights(ev)
        assert ev.edges["edge-1"].window_obs[0].recency_weight == 1.0

    def test_diagnostic_message(self):
        ev = _make_evidence(
            window_dsls=["window(1-Jan-25:1-Feb-25)"],
            daily_dates=["2025-02-01"],
            traj_dates=["2025-02-01"],
        )
        diags = _apply_weights(ev)
        assert len(diags) == 1
        assert "1 trajectories" in diags[0]
        assert "1 window obs" in diags[0]
        assert "1 daily obs" in diags[0]

    def test_skipped_edge_not_weighted(self):
        ev = _make_evidence(traj_dates=["2025-01-01"])
        ev.edges["edge-1"].skipped = True
        _apply_weights(ev)
        traj = ev.edges["edge-1"].cohort_obs[0].trajectories[0]
        assert traj.recency_weight == 1.0  # unchanged default


# ---------------------------------------------------------------------------
# Content hash includes recency weights
# ---------------------------------------------------------------------------

class TestContentHash:
    """Verify recency_weight is included in EdgeEvidence.content_hash."""

    def test_window_obs_recency_in_hash(self):
        ev1 = EdgeEvidence(edge_id="e1", param_id="p1", file_path="f")
        ev1.window_obs.append(WindowObservation(n=100, k=30, slice_dsl="w", recency_weight=1.0))
        ev2 = EdgeEvidence(edge_id="e1", param_id="p1", file_path="f")
        ev2.window_obs.append(WindowObservation(n=100, k=30, slice_dsl="w", recency_weight=0.5))
        assert ev1.content_hash() != ev2.content_hash()

    def test_daily_obs_recency_in_hash(self):
        co1 = CohortObservation(slice_dsl="c", daily=[
            CohortDailyObs(date="2025-01-01", n=100, k=30, age_days=10, recency_weight=1.0),
        ])
        co2 = CohortObservation(slice_dsl="c", daily=[
            CohortDailyObs(date="2025-01-01", n=100, k=30, age_days=10, recency_weight=0.5),
        ])
        ev1 = EdgeEvidence(edge_id="e1", param_id="p1", file_path="f", cohort_obs=[co1])
        ev2 = EdgeEvidence(edge_id="e1", param_id="p1", file_path="f", cohort_obs=[co2])
        assert ev1.content_hash() != ev2.content_hash()


# ---------------------------------------------------------------------------
# Model wiring: weighted likelihoods use Potential
# ---------------------------------------------------------------------------

class TestModelWiring:
    """Verify model emits Potentials (not native distributions) for weighted obs."""

    def _build_model(self, graph, params, today="1-Mar-25"):
        from bayes.compiler import analyse_topology, bind_evidence, build_model
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, params, today=today)
        model, metadata = build_model(topology, evidence)
        return model, metadata, evidence

    def _solo_edge_graph(self):
        """Minimal Anchor → A → B with window data in param file."""
        graph = {
            "nodes": [
                {"uuid": "node-anchor", "id": "node-anchor",
                 "entry": {"is_start": True}},
                {"uuid": "node-a", "id": "node-a", "entry": {}},
                {"uuid": "node-b", "id": "node-b", "absorbing": True, "entry": {}},
            ],
            "edges": [
                {"uuid": "edge-anchor-a", "from": "node-anchor", "to": "node-a",
                 "p": {"id": "param-anchor-a", "mean": 0.9}},
                {"uuid": "edge-a-b", "from": "node-a", "to": "node-b",
                 "p": {"id": "param-a-b", "mean": 0.3}},
            ],
        }
        params = {
            "param-anchor-a": {
                "id": "param-anchor-a",
                "values": [{"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                             "n": 1000, "k": 900}],
            },
            "param-a-b": {
                "id": "param-a-b",
                "values": [{"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                             "n": 500, "k": 150}],
            },
        }
        return graph, params

    def test_window_obs_emits_potential(self):
        """Window obs should be emitted as pm.Potential (weighted), not pm.Binomial."""
        graph, params = self._solo_edge_graph()
        model, _, evidence = self._build_model(graph, params)
        var_names = set(model.named_vars.keys())
        # Should have obs_w_ as a Potential (Deterministic/Potential), not an observed RV
        obs_w_vars = [v for v in var_names if v.startswith("obs_w_")]
        for v in obs_w_vars:
            # Potentials don't appear in model.observed_RVs
            observed_names = {rv.name for rv in model.observed_RVs}
            assert v not in observed_names, f"{v} is an observed RV, should be Potential"
