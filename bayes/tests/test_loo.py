"""Tests for LOO-ELPD posterior predictive scoring (doc 32)."""

import math
import numpy as np
import pytest
from scipy.special import gammaln
from scipy.stats import binom as sp_binom, betabinom as sp_betabinom

from compiler.loo import (
    dirichlet_multinomial_logpmf,
    EdgeLooMetrics,
    _analytic_p_and_kappa,
    _safe,
)
from compiler.types import (
    ProbabilityPrior,
    EdgeEvidence,
    WindowObservation,
    CohortDailyObs,
    CohortObservation,
    EdgeTopology,
    TopologyAnalysis,
    BoundEvidence,
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
        # Manual: log(6!/2!2!2!) + log(Γ(3)/Γ(9)) + Σlog(Γ(3)/Γ(1))
        expected = (
            gammaln(7) - 3 * gammaln(3)
            + gammaln(3) - gammaln(9)
            + 3 * (gammaln(3) - gammaln(1))
        )
        assert abs(result - expected) < 1e-10

    def test_reduces_to_multinomial_large_alpha(self):
        """Large α → DirMult ≈ Multinomial."""
        x = np.array([10, 20, 30])
        # Large alpha → concentration → fixed p
        alpha = np.array([1000.0, 2000.0, 3000.0])
        result = dirichlet_multinomial_logpmf(x, alpha)
        # Compare to multinomial with p = alpha/sum(alpha)
        from scipy.stats import multinomial
        p = alpha / alpha.sum()
        expected = multinomial.logpmf(x, n=int(x.sum()), p=p)
        # Should be close but not identical (finite α)
        assert abs(result - expected) < 0.5

    def test_single_category(self):
        """K=1: DirMult reduces to a constant (all n go to one bin)."""
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
        assert result < 0  # log-probability must be negative


# ---------------------------------------------------------------------------
# _analytic_p_and_kappa
# ---------------------------------------------------------------------------

class TestAnalyticPAndKappa:
    def test_basic(self):
        ev = EdgeEvidence(edge_id="e1", param_id="p1", file_path="f1")
        ev.prob_prior = ProbabilityPrior(alpha=10.0, beta=90.0)
        p, kappa = _analytic_p_and_kappa(ev)
        assert abs(p - 0.1) < 1e-10
        assert abs(kappa - 100.0) < 1e-10

    def test_weak_prior_no_kappa(self):
        ev = EdgeEvidence(edge_id="e1", param_id="p1", file_path="f1")
        ev.prob_prior = ProbabilityPrior(alpha=1.0, beta=1.0)
        p, kappa = _analytic_p_and_kappa(ev)
        assert abs(p - 0.5) < 1e-10
        assert kappa is None  # alpha+beta = 2, not > 2


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
