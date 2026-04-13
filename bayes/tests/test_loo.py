"""Tests for LOO-ELPD posterior predictive scoring (doc 32)."""

import math
import numpy as np
import pytest
from scipy.special import gammaln
from scipy.stats import binom as sp_binom, betabinom as sp_betabinom

from compiler.loo import (
    dirichlet_multinomial_logpmf,
    EdgeLooMetrics,
    AnalyticBaseline,
    compute_loo_scores,
    _var_to_edge_ids,
    _build_lookups,
    _safe,
)
from compiler.types import (
    ProbabilityPrior,
    EdgeEvidence,
    WindowObservation,
    CohortDailyObs,
    CohortObservation,
    CohortDailyTrajectory,
    EdgeTopology,
    TopologyAnalysis,
    BoundEvidence,
    BranchGroup,
    PathLatency,
)


# ---------------------------------------------------------------------------
# dirichlet_multinomial_logpmf
# ---------------------------------------------------------------------------

class TestDirichletMultinomialLogpmf:
    """Verify the gammaln-based DirMult logpmf against known values."""

    def test_uniform_alpha_symmetric_counts(self):
        """Uniform Dirichlet + equal counts → known formula."""
        x = np.array([2, 2, 2])
        alpha = np.array([1.0, 1.0, 1.0])
        result = dirichlet_multinomial_logpmf(x, alpha)
        expected = (
            gammaln(7) - 3 * gammaln(3)
            + gammaln(3) - gammaln(9)
            + 3 * (gammaln(3) - gammaln(1))
        )
        assert abs(result - expected) < 1e-10

    def test_reduces_to_multinomial_large_alpha(self):
        """Large α → DirMult ≈ Multinomial."""
        x = np.array([10, 20, 30])
        alpha = np.array([1000.0, 2000.0, 3000.0])
        result = dirichlet_multinomial_logpmf(x, alpha)
        from scipy.stats import multinomial
        p = alpha / alpha.sum()
        expected = multinomial.logpmf(x, n=int(x.sum()), p=p)
        assert abs(result - expected) < 0.5

    def test_single_category(self):
        """K=1: DirMult reduces to a constant."""
        x = np.array([5])
        alpha = np.array([2.0])
        result = dirichlet_multinomial_logpmf(x, alpha)
        expected = (
            gammaln(6) - gammaln(6)
            + gammaln(2) - gammaln(7)
            + gammaln(7) - gammaln(2)
        )
        assert abs(result - expected) < 1e-10

    def test_zero_counts(self):
        """Some categories with 0 counts."""
        x = np.array([5, 0, 0])
        alpha = np.array([1.0, 1.0, 1.0])
        result = dirichlet_multinomial_logpmf(x, alpha)
        assert np.isfinite(result)
        assert result < 0


# ---------------------------------------------------------------------------
# AnalyticBaseline
# ---------------------------------------------------------------------------

class TestAnalyticBaseline:
    def test_kappa_from_p_and_sd(self):
        """Kappa derived from moment-matching p and p_sd."""
        bl = AnalyticBaseline(p=0.5, p_sd=0.05)
        # p=0.5, sd=0.05 → v=0.0025, common=0.5*0.5/0.0025-1=99
        assert bl.kappa is not None
        assert abs(bl.kappa - 99.0) < 1.0

    def test_kappa_none_for_zero_sd(self):
        bl = AnalyticBaseline(p=0.5, p_sd=0.0)
        assert bl.kappa is None

    def test_kappa_none_for_extreme_p(self):
        bl = AnalyticBaseline(p=0.0, p_sd=0.1)
        assert bl.kappa is None


# ---------------------------------------------------------------------------
# _var_to_edge_ids — node name → edge mapping
# ---------------------------------------------------------------------------

class TestVarToEdgeIds:
    """Verify observation node names map to the right edges."""

    def _lookups(self):
        topo = TopologyAnalysis(
            anchor_node_id="n0",
            edges={
                "edge-a-b": EdgeTopology(edge_id="edge-a-b", from_node="a", to_node="b", param_id="p1"),
                "edge-b-c": EdgeTopology(edge_id="edge-b-c", from_node="b", to_node="c", param_id="p2"),
            },
            branch_groups={
                "bg-1": BranchGroup(group_id="bg-1", source_node="a", sibling_edge_ids=["edge-a-b", "edge-b-c"]),
            },
            topo_order=["edge-a-b", "edge-b-c"],
        )
        return _build_lookups(topo)

    def test_obs_w(self):
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("obs_w_edge_a_b", s2e, b2s) == ["edge-a-b"]

    def test_obs_w_with_suffix(self):
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("obs_w_edge_a_b_0", s2e, b2s) == ["edge-a-b"]

    def test_obs_daily(self):
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("obs_daily_edge_b_c", s2e, b2s) == ["edge-b-c"]

    def test_endpoint_bb(self):
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("endpoint_bb_edge_a_b", s2e, b2s) == ["edge-a-b"]

    def test_cohort_endpoint_bb(self):
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("cohort_endpoint_bb_edge_a_b", s2e, b2s) == ["edge-a-b"]

    def test_obs_bg(self):
        s2e, b2s = self._lookups()
        result = _var_to_edge_ids("obs_bg_bg_1", s2e, b2s)
        assert set(result) == {"edge-a-b", "edge-b-c"}

    def test_soft_constraint_not_matched(self):
        """t95_obs_, onset_obs_, path_t95_obs_ should NOT map to edges."""
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("t95_obs_edge_a_b", s2e, b2s) == []
        assert _var_to_edge_ids("onset_obs_edge_a_b", s2e, b2s) == []
        assert _var_to_edge_ids("path_t95_obs_edge_a_b", s2e, b2s) == []

    def test_unknown_var(self):
        s2e, b2s = self._lookups()
        assert _var_to_edge_ids("some_random_thing", s2e, b2s) == []


# ---------------------------------------------------------------------------
# compute_loo_scores — integration test with real PyMC model
# ---------------------------------------------------------------------------

class TestComputeLooScoresIntegration:
    """Build a real PyMC model with multiple named observation nodes,
    run MCMC, and verify compute_loo_scores produces sensible output.

    This catches the az.loo multi-variable bug: when the log_likelihood
    group has multiple arrays, az.loo(trace) fails unless var_name is
    specified. compute_loo_scores must handle this.
    """

    @pytest.fixture
    def two_edge_model_and_evidence(self):
        """Build a minimal 2-edge model mimicking model.py's observation
        node naming patterns, with synthetic data where the true p is known.
        """
        import pymc as pm

        np.random.seed(42)

        # True parameters
        true_p_ab = 0.7
        true_p_bc = 0.4

        # Generate synthetic observations (per-anchor-day counts)
        n_days = 20
        n_per_day = 100
        n_arr_ab = np.full(n_days, n_per_day, dtype=np.int64)
        k_arr_ab = np.random.binomial(n_per_day, true_p_ab, size=n_days).astype(np.int64)
        n_arr_bc = np.full(n_days, n_per_day, dtype=np.int64)
        k_arr_bc = np.random.binomial(n_per_day, true_p_bc, size=n_days).astype(np.int64)

        # Build PyMC model with the same naming convention as model.py
        safe_ab = "edge_a_b"
        safe_bc = "edge_b_c"

        with pm.Model() as model:
            p_ab = pm.Beta(f"p_{safe_ab}", alpha=2, beta=2)
            p_bc = pm.Beta(f"p_{safe_bc}", alpha=2, beta=2)

            # obs_daily_ nodes (vectorised BetaBinomial — multiple data points per node)
            kappa = 50.0
            pm.BetaBinomial(
                f"obs_daily_{safe_ab}",
                n=n_arr_ab,
                alpha=p_ab * kappa,
                beta=(1 - p_ab) * kappa,
                observed=k_arr_ab,
            )
            pm.BetaBinomial(
                f"obs_daily_{safe_bc}",
                n=n_arr_bc,
                alpha=p_bc * kappa,
                beta=(1 - p_bc) * kappa,
                observed=k_arr_bc,
            )

            # A soft-constraint node (like t95_obs_) — should be excluded from LOO
            pm.Normal(
                f"t95_obs_{safe_ab}",
                mu=p_ab * 10,
                sigma=1.0,
                observed=np.float64(7.0),
            )

        # Build topology
        topology = TopologyAnalysis(
            anchor_node_id="a",
            edges={
                "edge-a-b": EdgeTopology(
                    edge_id="edge-a-b", from_node="a", to_node="b", param_id="p1",
                ),
                "edge-b-c": EdgeTopology(
                    edge_id="edge-b-c", from_node="b", to_node="c", param_id="p2",
                ),
            },
            branch_groups={},
            topo_order=["edge-a-b", "edge-b-c"],
        )

        # Build evidence with analytic priors close to but not exactly at truth
        ev_ab = EdgeEvidence(edge_id="edge-a-b", param_id="p1", file_path="f1")
        ev_ab.prob_prior = ProbabilityPrior(alpha=35.0, beta=15.0)  # prior p=0.7, κ=50
        ev_ab.cohort_obs = [
            CohortObservation(
                slice_dsl="window()",
                daily=[
                    CohortDailyObs(date=f"2025-03-{d+1:02d}", n=int(n_arr_ab[d]),
                                   k=int(k_arr_ab[d]), age_days=30.0, completeness=1.0)
                    for d in range(n_days)
                ],
            ),
        ]

        ev_bc = EdgeEvidence(edge_id="edge-b-c", param_id="p2", file_path="f2")
        ev_bc.prob_prior = ProbabilityPrior(alpha=20.0, beta=30.0)  # prior p=0.4, κ=50
        ev_bc.cohort_obs = [
            CohortObservation(
                slice_dsl="window()",
                daily=[
                    CohortDailyObs(date=f"2025-03-{d+1:02d}", n=int(n_arr_bc[d]),
                                   k=int(k_arr_bc[d]), age_days=30.0, completeness=1.0)
                    for d in range(n_days)
                ],
            ),
        ]

        evidence = BoundEvidence(
            edges={"edge-a-b": ev_ab, "edge-b-c": ev_bc},
        )

        # Analytic baselines — slightly off from truth (as the stats pass would be)
        baselines = {
            "edge-a-b": AnalyticBaseline(p=0.65, p_sd=0.03),  # truth is 0.7
            "edge-b-c": AnalyticBaseline(p=0.38, p_sd=0.03),  # truth is 0.4
        }

        return model, topology, evidence, baselines

    def test_compute_loo_scores_with_multiple_ll_variables(self, two_edge_model_and_evidence):
        """The core integration test: run MCMC, compute log-likelihoods,
        then verify compute_loo_scores handles multiple log-likelihood
        arrays without the 'var_name cannot be None' error.
        """
        import pymc as pm

        model, topology, evidence, baselines = two_edge_model_and_evidence

        # Run short MCMC (enough for LOO, not for inference quality)
        with model:
            trace = pm.sample(
                draws=200, tune=100, chains=2, cores=1,
                random_seed=42, progressbar=False,
                idata_kwargs={"log_likelihood": True},
            )

        # Verify log_likelihood group exists and has multiple variables
        assert hasattr(trace, "log_likelihood"), "trace should have log_likelihood group"
        ll_vars = list(trace.log_likelihood.data_vars)
        assert len(ll_vars) >= 2, f"expected ≥2 log-likelihood vars, got {ll_vars}"

        # Verify the soft-constraint node is also present (the bug scenario)
        assert any("t95_obs_" in v for v in ll_vars), (
            f"t95_obs_ should be in log_likelihood to exercise the filter: {ll_vars}"
        )

        # This is the call that previously failed with
        # "Found several log likelihood arrays ... var_name cannot be None"
        diagnostics = []
        scores, slice_scores = compute_loo_scores(trace, evidence, topology,
                                    analytic_baselines=baselines, diagnostics=diagnostics)

        # Should NOT have failed
        assert not any("failed" in d for d in diagnostics), (
            f"compute_loo_scores failed: {diagnostics}"
        )

        # Should have scores for both edges
        assert "edge-a-b" in scores, f"missing edge-a-b, got {list(scores.keys())}"
        assert "edge-b-c" in scores, f"missing edge-b-c, got {list(scores.keys())}"

        # ELPD values should be finite and negative (log-probabilities)
        for eid, m in scores.items():
            assert np.isfinite(m.elpd), f"{eid}: elpd not finite: {m.elpd}"
            assert m.elpd < 0, f"{eid}: elpd should be negative: {m.elpd}"
            assert np.isfinite(m.elpd_null), f"{eid}: elpd_null not finite: {m.elpd_null}"
            assert m.elpd_null < 0, f"{eid}: elpd_null should be negative: {m.elpd_null}"
            assert np.isfinite(m.delta_elpd), f"{eid}: delta_elpd not finite: {m.delta_elpd}"
            assert m.n_loo_obs > 0, f"{eid}: n_loo_obs should be >0: {m.n_loo_obs}"
            assert m.pareto_k_max >= 0, f"{eid}: pareto_k_max should be ≥0"

        # n_loo_obs should be 20 per edge (one per anchor day)
        assert scores["edge-a-b"].n_loo_obs == 20
        assert scores["edge-b-c"].n_loo_obs == 20

        # With good priors close to truth, ΔELPD should be near zero or positive
        # (Bayesian model should be at least as good as the analytic prior)
        # Allow some negative — short MCMC may not converge perfectly
        for eid, m in scores.items():
            assert m.delta_elpd > -50, (
                f"{eid}: ΔELPD suspiciously negative ({m.delta_elpd:.1f}), "
                f"model may not have converged"
            )

    def test_soft_constraints_excluded_from_scores(self, two_edge_model_and_evidence):
        """Verify t95_obs_, onset_obs_, path_t95_obs_ nodes don't appear
        in the per-edge scores — they should be filtered out.
        """
        import pymc as pm

        model, topology, evidence, baselines = two_edge_model_and_evidence

        with model:
            trace = pm.sample(
                draws=100, tune=50, chains=2, cores=1,
                random_seed=42, progressbar=False,
                idata_kwargs={"log_likelihood": True},
            )

        diagnostics = []
        scores, _ = compute_loo_scores(trace, evidence, topology,
                                    analytic_baselines=baselines, diagnostics=diagnostics)

        # The t95_obs_ node should not contribute to any edge's n_loo_obs.
        # Each edge has 20 daily obs, so total should be exactly 20, not 21.
        assert scores["edge-a-b"].n_loo_obs == 20

    def test_diagnostics_logged(self, two_edge_model_and_evidence):
        """Verify the summary diagnostic line is produced."""
        import pymc as pm

        model, topology, evidence, baselines = two_edge_model_and_evidence

        with model:
            trace = pm.sample(
                draws=100, tune=50, chains=2, cores=1,
                random_seed=42, progressbar=False,
                idata_kwargs={"log_likelihood": True},
            )

        diagnostics = []
        _, _ = compute_loo_scores(trace, evidence, topology,
                          analytic_baselines=baselines, diagnostics=diagnostics)

        assert any("edges scored" in d for d in diagnostics), (
            f"expected summary diagnostic, got: {diagnostics}"
        )

    def test_empty_log_likelihood(self):
        """Verify graceful handling when log_likelihood is absent."""
        import pymc as pm
        import arviz as az

        # Create a trace with no log_likelihood group
        with pm.Model():
            pm.Normal("x", mu=0, sigma=1)
            trace = pm.sample(
                draws=50, tune=20, chains=1, cores=1,
                random_seed=42, progressbar=False,
            )

        topology = TopologyAnalysis(
            anchor_node_id="a", edges={}, branch_groups={}, topo_order=[],
        )
        evidence = BoundEvidence(edges={})

        diagnostics = []
        scores, slice_scores = compute_loo_scores(trace, evidence, topology, diagnostics=diagnostics)

        assert scores == {}
        assert slice_scores == {}
        assert any("no log_likelihood" in d or "skipping" in d for d in diagnostics)


# ---------------------------------------------------------------------------
# EdgeLooMetrics
# ---------------------------------------------------------------------------

class TestEdgeLooMetrics:
    def test_defaults(self):
        m = EdgeLooMetrics()
        assert m.elpd == 0.0
        assert m.delta_elpd == 0.0
        assert m.pareto_k_max == 0.0
        assert m.n_loo_obs == 0

    def test_delta_computation(self):
        m = EdgeLooMetrics(elpd=-10.0, elpd_null=-15.0)
        m.delta_elpd = m.elpd - m.elpd_null
        assert abs(m.delta_elpd - 5.0) < 1e-10
