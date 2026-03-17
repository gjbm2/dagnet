"""
Smoke test: parameter recovery on synthetic Beta-Binomial data.

Generates data from known Beta parameters, runs inference, and checks
that the posterior HDI contains the true values.

Run:  . graph-editor/venv/bin/activate && python -m pytest bayes/test_inference.py -v
"""

import numpy as np
import pytest

from inference import (
    BetaPrior,
    EdgeFit,
    SamplingConfig,
    build_model,
    fit_edges,
    run_inference,
    summarise,
    _fit_beta_to_samples,
)


# --- Helper ---

def make_synthetic_edge(
    edge_id: str,
    true_p: float,
    n_obs: int,
    prior_alpha: float = 1.0,
    prior_beta: float = 1.0,
    seed: int = 42,
) -> EdgeFit:
    """Generate an EdgeFit with synthetic Binomial observations."""
    rng = np.random.default_rng(seed)
    k = int(rng.binomial(n_obs, true_p))
    return EdgeFit(
        edge_id=edge_id,
        param_id=f"param-{edge_id}",
        prior=BetaPrior(alpha=prior_alpha, beta=prior_beta),
        total_n=n_obs,
        total_k=k,
    )


# --- Tests ---

class TestBetaPrior:
    def test_overflow_guard_triggers(self):
        """Prior overflow guard caps informative priors at Beta(2,2)."""
        p = BetaPrior(alpha=300, beta=300)
        assert p.alpha == 2.0
        assert p.beta == 2.0

    def test_normal_prior_preserved(self):
        p = BetaPrior(alpha=10, beta=20)
        assert p.alpha == 10
        assert p.beta == 20


class TestFitBetaToSamples:
    def test_recovers_known_beta(self):
        """Moment-matching should recover Beta params from a large sample."""
        rng = np.random.default_rng(123)
        samples = rng.beta(5, 15, size=10_000)
        alpha, beta = _fit_beta_to_samples(samples)
        # Should be close to (5, 15) — tolerance for sampling noise
        assert abs(alpha - 5) < 1.0
        assert abs(beta - 15) < 2.0

    def test_degenerate_returns_uniform(self):
        """All-zero or all-one samples should return Beta(1,1)."""
        alpha, beta = _fit_beta_to_samples(np.array([0.5, 0.5, 0.5]))
        assert alpha == 1.0  # zero variance → degenerate


class TestBuildModel:
    def test_model_has_correct_variables(self):
        """Model should have p_{edge_id} and obs_{edge_id} for each edge."""
        edges = [
            EdgeFit("e1", "p1", BetaPrior(1, 1), total_n=100, total_k=30),
            EdgeFit("e2", "p2", BetaPrior(2, 2), total_n=50, total_k=10),
        ]
        model = build_model(edges)

        var_names = [v.name for v in model.free_RVs]
        obs_names = [v.name for v in model.observed_RVs]

        assert "p_e1" in var_names
        assert "p_e2" in var_names
        assert "obs_e1" in obs_names
        assert "obs_e2" in obs_names

    def test_prior_only_edge(self):
        """Edge with n=0 should have p variable but no observed."""
        edges = [
            EdgeFit("cold", "p-cold", BetaPrior(1, 1), total_n=0, total_k=0),
        ]
        model = build_model(edges)

        var_names = [v.name for v in model.free_RVs]
        obs_names = [v.name for v in model.observed_RVs]

        assert "p_cold" in var_names
        assert len(obs_names) == 0


class TestParameterRecovery:
    """The core test: generate synthetic data, run inference, check posteriors."""

    @pytest.fixture
    def fast_config(self):
        """Quick sampling for tests — fewer draws, fewer chains."""
        return SamplingConfig(
            draws=1000,
            tune=500,
            chains=2,
            cores=1,
            target_accept=0.9,
            random_seed=42,
        )

    def test_single_edge_recovery(self, fast_config):
        """Posterior HDI should contain the true conversion rate."""
        true_p = 0.35
        edge = make_synthetic_edge("test-edge", true_p=true_p, n_obs=2000, seed=99)

        result = fit_edges([edge], config=fast_config)

        assert len(result.edges) == 1
        post = result.edges[0]

        # The true value should fall within the 90% HDI
        assert post.hdi_lower <= true_p <= post.hdi_upper, (
            f"True p={true_p} outside HDI [{post.hdi_lower:.3f}, {post.hdi_upper:.3f}]"
        )

        # Posterior mean should be close to true value
        assert abs(post.mean - true_p) < 0.05, (
            f"Posterior mean {post.mean:.3f} too far from true p={true_p}"
        )

        # Should be marked bayesian (sufficient data, conjugate model converges easily)
        assert post.provenance == "bayesian"
        assert post.ess > 100
        assert post.rhat < 1.05

    def test_multi_edge_recovery(self, fast_config):
        """Multiple edges with different true rates — all should recover."""
        true_params = {"high": 0.80, "mid": 0.45, "low": 0.10}
        edges = [
            make_synthetic_edge(eid, true_p=tp, n_obs=300, seed=i * 7)
            for i, (eid, tp) in enumerate(true_params.items())
        ]

        result = fit_edges(edges, config=fast_config)

        assert len(result.edges) == len(true_params)

        for post in result.edges:
            true_p = true_params[post.edge_id]
            assert post.hdi_lower <= true_p <= post.hdi_upper, (
                f"{post.edge_id}: true p={true_p} outside HDI "
                f"[{post.hdi_lower:.3f}, {post.hdi_upper:.3f}]"
            )

    def test_weak_evidence_widens_hdi(self, fast_config):
        """With very few observations, the HDI should be much wider."""
        edge_strong = make_synthetic_edge("strong", true_p=0.5, n_obs=500, seed=1)
        edge_weak = make_synthetic_edge("weak", true_p=0.5, n_obs=5, seed=2)

        result = fit_edges([edge_strong, edge_weak], config=fast_config)

        strong = next(e for e in result.edges if e.edge_id == "strong")
        weak = next(e for e in result.edges if e.edge_id == "weak")

        strong_width = strong.hdi_upper - strong.hdi_lower
        weak_width = weak.hdi_upper - weak.hdi_lower

        assert weak_width > strong_width, (
            f"Weak evidence HDI ({weak_width:.3f}) should be wider "
            f"than strong ({strong_width:.3f})"
        )

    def test_result_serialises_to_plain_dict(self, fast_config):
        """InferenceResult.to_dict() should produce JSON-serialisable output."""
        import json

        edge = make_synthetic_edge("ser", true_p=0.5, n_obs=100, seed=77)
        result = fit_edges([edge], config=fast_config)

        d = result.to_dict()

        # Should round-trip through JSON without error
        json_str = json.dumps(d)
        roundtripped = json.loads(json_str)

        assert roundtripped["edges"][0]["edge_id"] == "ser"
        assert isinstance(roundtripped["quality"]["max_rhat"], float)
        assert isinstance(roundtripped["quality"]["converged"], bool)
