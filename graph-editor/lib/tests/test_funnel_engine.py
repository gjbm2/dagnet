"""Unit tests for funnel_engine pure helpers and per-regime computation.

Tests follow doc 52 §9 contract invariants. Fixture graphs are built
inline to keep tests self-contained and fast.
"""

import math

import numpy as np
import pytest

from runner.funnel_engine import (
    FunnelStageBars,
    compute_bars_e,
    compute_bars_ef,
    compute_bars_f,
    moment_match_beta,
    wilson_ci,
)


# ── Closed-form stats helpers ─────────────────────────────────────────


class TestWilsonCI:
    def test_known_value_50_of_100(self):
        """Reference: 90% Wilson CI for 50/100 ≈ (0.418, 0.582)."""
        lo, hi = wilson_ci(50, 100, alpha=0.10)
        assert lo == pytest.approx(0.418, abs=0.003)
        assert hi == pytest.approx(0.582, abs=0.003)

    def test_known_value_95_of_100(self):
        """Reference: 90% Wilson CI for 95/100 ≈ (0.901, 0.975).

        Characterisation test: values computed by hand from the Wilson
        score formula with z_{0.95} = 1.6449.
        """
        lo, hi = wilson_ci(95, 100, alpha=0.10)
        assert lo == pytest.approx(0.9008, abs=0.001)
        assert hi == pytest.approx(0.9754, abs=0.001)

    def test_zero_successes(self):
        lo, hi = wilson_ci(0, 10, alpha=0.10)
        assert lo == 0.0
        assert hi > 0.0
        assert hi < 1.0

    def test_all_successes(self):
        lo, hi = wilson_ci(10, 10, alpha=0.10)
        assert lo > 0.0
        assert hi == pytest.approx(1.0, abs=1e-9)

    def test_zero_trials(self):
        assert wilson_ci(0, 0, alpha=0.10) == (0.0, 0.0)

    def test_95_percent_ci_uses_196_z(self):
        """alpha=0.05 → z≈1.96. Width for 50/100 ≈ 0.195 half-width."""
        lo, hi = wilson_ci(50, 100, alpha=0.05)
        centre = (lo + hi) / 2
        halfwidth = hi - centre
        # Approximate Wilson half-width at p=0.5, n=100, z=1.96: ~0.098
        assert halfwidth == pytest.approx(0.098, abs=0.005)


class TestMomentMatchBeta:
    def test_p_half_sd_0_1(self):
        """p=0.5, sd=0.1 → kappa = 0.25/0.01 − 1 = 24; α=β=12."""
        ab = moment_match_beta(0.5, 0.1)
        assert ab is not None
        alpha, beta = ab
        assert alpha == pytest.approx(12.0, abs=1e-9)
        assert beta == pytest.approx(12.0, abs=1e-9)

    def test_p_0_7_sd_0_05(self):
        """Verify the inverse: given moment-matched α, β, recompute mean and sd."""
        p_mean, p_sd = 0.7, 0.05
        ab = moment_match_beta(p_mean, p_sd)
        assert ab is not None
        alpha, beta = ab
        recomputed_mean = alpha / (alpha + beta)
        recomputed_var = alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1))
        assert recomputed_mean == pytest.approx(p_mean, abs=1e-9)
        assert math.sqrt(recomputed_var) == pytest.approx(p_sd, abs=1e-9)

    def test_infeasible_sd_too_large(self):
        """sd² >= p(1−p) → moments cannot match a Beta."""
        # p=0.5 → max sd = 0.5; sd=0.6 is infeasible
        assert moment_match_beta(0.5, 0.6) is None

    def test_infeasible_p_zero(self):
        assert moment_match_beta(0.0, 0.1) is None

    def test_infeasible_p_one(self):
        assert moment_match_beta(1.0, 0.1) is None

    def test_infeasible_sd_zero(self):
        assert moment_match_beta(0.5, 0.0) is None


# ── Per-regime bar computation ────────────────────────────────────────


def _make_edge(n: int | None = None, k: int | None = None,
               alpha: float | None = None, beta: float | None = None,
               alpha_pred: float | None = None, beta_pred: float | None = None) -> dict:
    """Build a minimal raw edge dict with evidence and optional posterior.

    Populates both edge.p.posterior (what resolve_model_params reads) and
    edge.p.model_vars[source='bayesian'] (what the promotion cascade sees)
    so the fixture mirrors a post-promotion graph state.
    """
    edge: dict = {'p': {}}
    if n is not None or k is not None:
        ev = {}
        if n is not None:
            ev['n'] = n
        if k is not None:
            ev['k'] = k
            if n is not None and n > 0:
                ev['mean'] = k / n
        edge['p']['evidence'] = ev
    if alpha is not None and beta is not None:
        posterior = {'alpha': alpha, 'beta': beta}
        if alpha_pred is not None:
            posterior['alpha_pred'] = alpha_pred
        if beta_pred is not None:
            posterior['beta_pred'] = beta_pred
        edge['p']['posterior'] = posterior
        mv_prob = {'alpha': alpha, 'beta': beta, 'mean': alpha / (alpha + beta)}
        if alpha_pred is not None:
            mv_prob['alpha_pred'] = alpha_pred
        if beta_pred is not None:
            mv_prob['beta_pred'] = beta_pred
        edge['p']['model_vars'] = [{
            'source': 'bayesian',
            'probability': mv_prob,
            'latency': {'mu': 2.0, 'sigma': 0.5},
            'quality': {'gate_passed': True},
        }]
    return edge


class TestComputeBarsE:
    def test_stage_0_is_one(self):
        edges = [_make_edge(n=100, k=60), _make_edge(n=60, k=30)]
        bars = compute_bars_e(edges)
        assert bars.bar[0] == 1.0
        assert bars.lo[0] is None
        assert bars.hi[0] is None

    def test_cumulative_ratios(self):
        edges = [_make_edge(n=100, k=60), _make_edge(n=60, k=30)]
        bars = compute_bars_e(edges)
        assert bars.bar[1] == pytest.approx(0.60, abs=1e-9)
        assert bars.bar[2] == pytest.approx(0.30, abs=1e-9)

    def test_wilson_ci_matches_closed_form(self):
        edges = [_make_edge(n=100, k=50)]
        bars = compute_bars_e(edges, alpha_ci=0.10)
        lo_expected, hi_expected = wilson_ci(50, 100, alpha=0.10)
        assert bars.lo[1] == pytest.approx(lo_expected, abs=1e-12)
        assert bars.hi[1] == pytest.approx(hi_expected, abs=1e-12)

    def test_missing_evidence_returns_zero_bars(self):
        edges = [_make_edge(), _make_edge()]
        bars = compute_bars_e(edges)
        assert bars.bar[0] == 1.0
        assert bars.bar[1] == 0.0
        assert bars.bar[2] == 0.0

    def test_monotonicity(self):
        """bar[i+1] <= bar[i] when k_{i+1} <= k_i (strict linear funnel)."""
        edges = [_make_edge(n=1000, k=500), _make_edge(n=500, k=200)]
        bars = compute_bars_e(edges)
        assert bars.bar[0] >= bars.bar[1] >= bars.bar[2]


class TestComputeBarsF:
    def test_stage_0_is_one(self):
        edges = [_make_edge(alpha=50, beta=50)]
        bars = compute_bars_f(edges, num_draws=500)
        assert bars.bar[0] == 1.0
        assert bars.lo[0] is None
        assert bars.hi[0] is None

    def test_median_matches_path_product_of_means(self):
        """f bar ≈ Π (α_j / (α_j + β_j)) within MC tolerance."""
        edges = [
            _make_edge(alpha=80, beta=20),   # mean 0.8
            _make_edge(alpha=60, beta=40),   # mean 0.6
            _make_edge(alpha=90, beta=10),   # mean 0.9
        ]
        expected_stage_3 = 0.8 * 0.6 * 0.9  # = 0.432
        bars = compute_bars_f(edges, num_draws=5000)
        # For high-κ Betas, median ≈ mean; tolerance ~1 % for 5 k draws
        assert bars.bar[3] == pytest.approx(expected_stage_3, rel=0.02)

    def test_monotonicity_for_every_draw(self):
        """reach[i+1] = reach[i] · p_{i+1} with p ∈ (0,1], so monotone non-increasing."""
        edges = [_make_edge(alpha=50, beta=50) for _ in range(3)]
        bars = compute_bars_f(edges, num_draws=500)
        assert bars.bar[0] >= bars.bar[1] >= bars.bar[2] >= bars.bar[3]

    def test_lo_hi_bracket_bar(self):
        edges = [_make_edge(alpha=50, beta=50), _make_edge(alpha=50, beta=50)]
        bars = compute_bars_f(edges, num_draws=2000)
        for i in range(1, 3):
            assert bars.lo[i] <= bars.bar[i] <= bars.hi[i]

    def test_uses_alpha_pred_when_present(self):
        """Predictive α/β should be preferred over epistemic (doc 49)."""
        # Epistemic sharp (α=100, β=0) would give bar≈1.0; predictive wide (α=5, β=5)
        # gives ≈0.5. If predictive is preferred, median should be near 0.5.
        edges = [_make_edge(alpha=100, beta=0.01, alpha_pred=5, beta_pred=5)]
        bars = compute_bars_f(edges, num_draws=5000)
        assert bars.bar[1] == pytest.approx(0.5, abs=0.05)


class TestComputeBarsEF:
    def test_bars_are_deterministic_path_product_of_cf_means(self):
        """e+f bar heights equal cumprod of CF p_means exactly."""
        cf_per_edge = [
            {'p_mean': 0.8, 'p_sd': 0.02},
            {'p_mean': 0.6, 'p_sd': 0.03},
            {'p_mean': 0.9, 'p_sd': 0.01},
        ]
        bar_e = [1.0, 0.7, 0.35, 0.30]
        bars = compute_bars_ef(cf_per_edge, bar_e, num_draws=500)
        assert bars.bar[0] == pytest.approx(1.0, abs=1e-12)
        assert bars.bar[1] == pytest.approx(0.8, abs=1e-12)
        assert bars.bar[2] == pytest.approx(0.8 * 0.6, abs=1e-12)
        assert bars.bar[3] == pytest.approx(0.8 * 0.6 * 0.9, abs=1e-12)

    def test_striation_residual_non_negative(self):
        cf_per_edge = [{'p_mean': 0.8, 'p_sd': 0.02}, {'p_mean': 0.6, 'p_sd': 0.03}]
        bar_e = [1.0, 0.7, 0.35]  # e always ≤ e+f for mature
        bars = compute_bars_ef(cf_per_edge, bar_e, num_draws=500)
        assert bars.bar_e is not None
        assert bars.bar_f_residual is not None
        for i in range(len(bars.bar)):
            assert bars.bar_f_residual[i] >= 0.0
            assert bars.bar_e[i] + bars.bar_f_residual[i] <= bars.bar[i] + 1e-9

    def test_striation_residual_clipped_when_e_exceeds_ef(self):
        """If e > e+f (should not happen in practice, but defensive), residual is 0."""
        cf_per_edge = [{'p_mean': 0.5, 'p_sd': 0.05}]
        bar_e = [1.0, 0.8]  # e > e+f bar
        bars = compute_bars_ef(cf_per_edge, bar_e, num_draws=200)
        # bar_ef[1] = 0.5, bar_e[1] = 0.8 → residual = max(0, 0.5 - 0.8) = 0
        assert bars.bar_f_residual[1] == 0.0

    def test_lo_hi_bracket_bar(self):
        cf_per_edge = [{'p_mean': 0.5, 'p_sd': 0.05}, {'p_mean': 0.5, 'p_sd': 0.05}]
        bar_e = [1.0, 0.4, 0.1]
        bars = compute_bars_ef(cf_per_edge, bar_e, num_draws=2000)
        for i in range(1, 3):
            assert bars.lo[i] <= bars.bar[i] + 0.01  # allow MC noise around deterministic bar
            assert bars.bar[i] <= bars.hi[i] + 0.01

    def test_degenerate_sd_zero(self):
        """sd=0 → moment_match_beta returns None → p_draws at p_mean (deterministic)."""
        cf_per_edge = [{'p_mean': 0.8, 'p_sd': 0.0}]
        bar_e = [1.0, 0.5]
        bars = compute_bars_ef(cf_per_edge, bar_e, num_draws=500)
        assert bars.bar[1] == pytest.approx(0.8, abs=1e-12)
        assert bars.lo[1] == pytest.approx(0.8, abs=1e-12)
        assert bars.hi[1] == pytest.approx(0.8, abs=1e-12)

    def test_reach_is_cumprod_per_draw(self):
        """Each per-draw reach[i] = Π_{j≤i} p_j^(s) — structural invariant."""
        cf_per_edge = [{'p_mean': 0.9, 'p_sd': 0.05}, {'p_mean': 0.8, 'p_sd': 0.05}]
        bar_e = [1.0, 0.85, 0.65]
        bars = compute_bars_ef(cf_per_edge, bar_e, num_draws=1000)
        # Deterministic bar = 0.9 * 0.8 = 0.72 at stage 2
        assert bars.bar[2] == pytest.approx(0.72, abs=1e-12)
        # Quantiles should be bounded above by max possible (both edges at p=1.0)
        # and below by 0; width ≥ 0
        assert bars.hi[2] >= bars.lo[2]


# ── Cross-regime invariants (doc 52 §9.1) ─────────────────────────────


class TestCrossRegimeInvariants:
    def test_e_le_ef_for_mature_data(self):
        """With CF means matching raw ratios, e ≈ e+f (f_residual ≈ 0)."""
        edges = [_make_edge(n=100, k=80), _make_edge(n=80, k=60)]
        bars_e = compute_bars_e(edges)
        # Simulate CF returning the same asymptotic rates as observed
        cf_per_edge = [
            {'p_mean': 0.80, 'p_sd': 0.04},
            {'p_mean': 0.75, 'p_sd': 0.05},
        ]
        bars_ef = compute_bars_ef(cf_per_edge, bars_e.bar, num_draws=1000)
        # e+f bars should be ≥ e bars
        for i in range(len(bars_e.bar)):
            assert bars_ef.bar[i] >= bars_e.bar[i] - 1e-9
