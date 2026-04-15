"""
Model wiring integration tests — verify PyMC variable structure without MCMC.

Runs topology → evidence → build_model, then inspects the PyMC model's
named variables and metadata dict. No sampling, so each test runs in ~1s.

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_model_wiring.py -v
"""

from __future__ import annotations

import pytest

from bayes.compiler import (
    analyse_topology,
    bind_evidence,
    build_model,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _model_var_names(model) -> set[str]:
    """Extract all named variable names from a PyMC model."""
    return set(model.named_vars.keys())


def _build(graph, params, features=None, today="1-Mar-25"):
    """Topology → evidence → model build. Returns (model, metadata, topology, evidence)."""
    topology = analyse_topology(graph)
    evidence = bind_evidence(topology, params, today=today)
    model, metadata = build_model(topology, evidence, features=features)
    return model, metadata, topology, evidence


def _safe(edge_id: str) -> str:
    return edge_id.replace("-", "_")


# ---------------------------------------------------------------------------
# Synthetic graph builders (minimal, latency-focused)
# ---------------------------------------------------------------------------

def _solo_edge_with_latency(
    *,
    onset: float = 3.0,
    mu: float = 2.0,
    sigma: float = 0.5,
    n: int = 5000,
    p_true: float = 0.3,
):
    """Anchor → A → B with latency on A→B. Window + cohort data."""
    import numpy as np
    from bayes.tests.synthetic import _generate_cohort_daily

    rng = np.random.default_rng(99)
    window_k = rng.binomial(n, p_true)

    n_daily, k_daily, dates = _generate_cohort_daily(
        rng, p_true, 100, 60,
        onset=onset, mu=mu, sigma=sigma,
    )

    latency_block = {
        "latency_parameter": True,
        "onset_delta_days": onset,
        "mu": mu,
        "sigma": sigma,
        "median_lag_days": onset + float(np.exp(mu)),
        "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
    }

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
             "p": {"id": "param-a-b", "mean": p_true,
                   "latency": latency_block}},
        ],
    }

    param_files = {
        "param-anchor-a": {
            "id": "param-anchor-a",
            "values": [{"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                         "n": n * 2, "k": int(n * 2 * 0.9),
                         "mean": 0.9, "stdev": 0.01}],
        },
        "param-a-b": {
            "id": "param-a-b",
            "values": [
                {"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                 "n": n, "k": window_k,
                 "mean": window_k / n, "stdev": 0.01},
                {"sliceDSL": "cohort(node-anchor,1-Oct-24:1-Jan-25)",
                 "n": sum(n_daily), "k": sum(k_daily),
                 "n_daily": n_daily, "k_daily": k_daily,
                 "dates": dates,
                 "mean": sum(k_daily) / sum(n_daily), "stdev": 0.01},
            ],
        },
    }

    return graph, param_files


def _two_latency_edges(
    *,
    onset_1: float = 3.0,
    onset_2: float = 7.0,
):
    """Anchor → A → B → C, both A→B and B→C have latency."""
    import numpy as np
    from bayes.tests.synthetic import _generate_cohort_daily

    rng = np.random.default_rng(77)

    def _lat_block(onset, mu=2.0, sigma=0.5):
        return {
            "latency_parameter": True,
            "onset_delta_days": onset,
            "mu": mu, "sigma": sigma,
            "median_lag_days": onset + float(np.exp(mu)),
            "mean_lag_days": onset + float(np.exp(mu + sigma**2 / 2)),
        }

    n = 3000
    k_ab = rng.binomial(n, 0.4)
    k_bc = rng.binomial(max(k_ab, 1), 0.5)

    n_daily_ab, k_daily_ab, dates_ab = _generate_cohort_daily(
        rng, 0.4, 80, 60, onset=onset_1, mu=2.0, sigma=0.5,
    )
    n_daily_bc, k_daily_bc, dates_bc = _generate_cohort_daily(
        rng, 0.5, 80, 60, onset=onset_2, mu=2.0, sigma=0.5,
    )

    graph = {
        "nodes": [
            {"uuid": "node-anchor", "id": "node-anchor",
             "entry": {"is_start": True}},
            {"uuid": "node-a", "id": "node-a", "entry": {}},
            {"uuid": "node-b", "id": "node-b", "entry": {}},
            {"uuid": "node-c", "id": "node-c", "absorbing": True, "entry": {}},
        ],
        "edges": [
            {"uuid": "edge-anchor-a", "from": "node-anchor", "to": "node-a",
             "p": {"id": "param-anchor-a", "mean": 0.9}},
            {"uuid": "edge-a-b", "from": "node-a", "to": "node-b",
             "p": {"id": "param-a-b", "mean": 0.4,
                   "latency": _lat_block(onset_1)}},
            {"uuid": "edge-b-c", "from": "node-b", "to": "node-c",
             "p": {"id": "param-b-c", "mean": 0.5,
                   "latency": _lat_block(onset_2)}},
        ],
    }

    param_files = {
        "param-anchor-a": {
            "id": "param-anchor-a",
            "values": [{"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                         "n": n * 2, "k": int(n * 2 * 0.9),
                         "mean": 0.9, "stdev": 0.01}],
        },
        "param-a-b": {
            "id": "param-a-b",
            "values": [
                {"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                 "n": n, "k": k_ab,
                 "mean": k_ab / n, "stdev": 0.01},
                {"sliceDSL": "cohort(node-anchor,1-Oct-24:1-Jan-25)",
                 "n": sum(n_daily_ab), "k": sum(k_daily_ab),
                 "n_daily": n_daily_ab, "k_daily": k_daily_ab,
                 "dates": dates_ab,
                 "mean": sum(k_daily_ab) / max(sum(n_daily_ab), 1),
                 "stdev": 0.01},
            ],
        },
        "param-b-c": {
            "id": "param-b-c",
            "values": [
                {"sliceDSL": "window(1-Jan-25:1-Mar-25)",
                 "n": max(k_ab, 1), "k": k_bc,
                 "mean": k_bc / max(k_ab, 1), "stdev": 0.01},
                {"sliceDSL": "cohort(node-anchor,1-Oct-24:1-Jan-25)",
                 "n": sum(n_daily_bc), "k": sum(k_daily_bc),
                 "n_daily": n_daily_bc, "k_daily": k_daily_bc,
                 "dates": dates_bc,
                 "mean": sum(k_daily_bc) / max(sum(n_daily_bc), 1),
                 "stdev": 0.01},
            ],
        },
    }

    return graph, param_files


# ===========================================================================
# Test cases
# ===========================================================================

class TestOnsetHyperprior:
    """Graph-level onset hyperprior wiring (Phase D.O, doc 18).

    NOTE: The graph-level hierarchy (onset_hyper_mu, tau_onset) was removed
    during implementation — independent per-edge onset only (programme.md,
    journal 23-Mar-26). Tests for the removed hierarchy have been deleted.
    """

    def test_latent_onset_disabled_no_hyperprior(self):
        """latent_onset=False → no onset hyperprior variables."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": False})
        names = _model_var_names(model)

        assert "onset_hyper_mu" not in names
        assert "tau_onset" not in names


class TestPerEdgeOnset:
    """Per-edge latent onset variable wiring."""

    def test_latency_edge_gets_onset_variables(self):
        """Latency edge → onset Deterministic in model.

        With latency_reparam=True (default), onset is derived from
        (m, a, r) coordinates: onset = exp(m) * sigmoid(a).  The old
        eps_onset non-centred variable no longer exists.
        """
        graph, params = _solo_edge_with_latency(onset=3.0)
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})
        names = _model_var_names(model)
        safe = _safe("edge-a-b")

        # (m, a, r) reparam: onset is a Deterministic derived from m and a
        assert f"onset_{safe}" in names, "onset Deterministic missing"
        assert f"m_lat_{safe}" in names, "m latent missing"
        assert f"a_lat_{safe}" in names, "a latent missing"

    # NOTE: test_positive_onset_gets_soft_observation deleted — onset_obs_
    # (histogram soft observation) was removed with the graph-level hierarchy.

    def test_zero_onset_no_soft_observation(self):
        """onset_delta_days == 0 → no onset_obs (nothing to observe)."""
        graph, params = _solo_edge_with_latency(onset=0.0)
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})
        names = _model_var_names(model)
        safe = _safe("edge-a-b")

        assert f"onset_{safe}" in names, "onset variable should still exist"
        assert f"onset_obs_{safe}" not in names, "should not observe zero onset"

    def test_disabled_no_per_edge_onset(self):
        """latent_onset=False → no per-edge onset variables at all."""
        graph, params = _solo_edge_with_latency(onset=5.0)
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": False})
        names = _model_var_names(model)
        safe = _safe("edge-a-b")

        assert f"onset_{safe}" not in names
        assert f"eps_onset_{safe}" not in names
        assert f"onset_obs_{safe}" not in names


class TestMetadataDict:
    """Metadata dict completeness — consumed by summarise_posteriors."""

    def test_latent_onset_edges_in_metadata(self):
        """Metadata contains latent_onset_edges keyed to correct edge IDs."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})

        assert "latent_onset_edges" in metadata
        assert "edge-a-b" in metadata["latent_onset_edges"]

    def test_disabled_onset_edges_empty(self):
        """latent_onset=False → latent_onset_edges is empty."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": False})

        assert "latent_onset_edges" in metadata
        assert len(metadata["latent_onset_edges"]) == 0

    def test_two_edges_both_in_metadata(self):
        """Two latency edges → both in latent_onset_edges."""
        graph, params = _two_latency_edges()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})

        onset_edges = metadata["latent_onset_edges"]
        assert "edge-a-b" in onset_edges
        assert "edge-b-c" in onset_edges

    def test_metadata_has_all_required_keys(self):
        """Metadata dict has edge_var_names, latent_latency_edges,
        latent_onset_edges, cohort_latency_edges, diagnostics."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params)

        required = {
            "edge_var_names", "latent_latency_edges",
            "latent_onset_edges", "cohort_latency_edges",
            "diagnostics",
        }
        assert required.issubset(metadata.keys()), (
            f"missing: {required - metadata.keys()}"
        )


class TestEvidenceOnsetUncertainty:
    """Evidence binding computes onset_uncertainty for latency priors."""

    def test_onset_uncertainty_computed(self):
        """Edges with onset > 0 get onset_uncertainty = max(1.0, onset * 0.3)."""
        graph, params = _solo_edge_with_latency(onset=5.0)
        _, _, topology, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.latency_prior is not None
        # onset=5.0 → max(1.0, 5.0 * 0.3) = 1.5
        assert ev.latency_prior.onset_uncertainty == pytest.approx(1.5, abs=0.01)

    def test_onset_uncertainty_floor_at_one(self):
        """Small onset → uncertainty floored at 1.0."""
        graph, params = _solo_edge_with_latency(onset=2.0)
        _, _, topology, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.latency_prior is not None
        # onset=2.0 → max(1.0, 2.0 * 0.3) = max(1.0, 0.6) = 1.0
        assert ev.latency_prior.onset_uncertainty == pytest.approx(1.0, abs=0.01)


class TestCohortOnsetWiring:
    """Cohort-level onset variables use learned tau_onset.

    Cohort latency vars are only created when the path has 2+ latency
    edges (single-latency paths reuse the edge's own latent vars).
    So we need the two-edge graph to exercise this.
    """

    def test_cohort_onset_uses_noncentred_param(self):
        """Two-latency-edge path → eps_onset_path_{id}, onset_cohort_{id}."""
        graph, params = _two_latency_edges(onset_1=3.0, onset_2=7.0)
        model, metadata, _, _ = _build(graph, params, features={
            "latent_onset": True,
            "cohort_latency": True,
        })
        names = _model_var_names(model)
        # B→C has path A→B→C (2 latency edges), so cohort latency fires
        safe_bc = _safe("edge-b-c")

        assert f"onset_cohort_{safe_bc}" in names, "cohort onset Deterministic missing"
        assert f"eps_onset_path_{safe_bc}" in names, "cohort onset non-centred eps missing"

    def test_cohort_onset_absent_when_latent_onset_disabled(self):
        """latent_onset=False → cohort onset falls back to legacy HalfNormal."""
        graph, params = _two_latency_edges(onset_1=3.0, onset_2=7.0)
        model, metadata, _, _ = _build(graph, params, features={
            "latent_onset": False,
            "cohort_latency": True,
        })
        names = _model_var_names(model)
        safe_bc = _safe("edge-b-c")

        # Legacy path: onset_cohort still exists (as HalfNormal) but no eps_onset_path
        assert f"eps_onset_path_{safe_bc}" not in names, (
            "eps_onset_path should not exist when latent_onset disabled"
        )

    def test_single_latency_path_no_cohort_onset(self):
        """Solo latency edge → no cohort onset vars (reuses edge latent)."""
        graph, params = _solo_edge_with_latency(onset=3.0)
        model, metadata, _, _ = _build(graph, params, features={
            "latent_onset": True,
            "cohort_latency": True,
        })
        names = _model_var_names(model)
        safe = _safe("edge-a-b")

        # Single latency path → no separate cohort onset
        assert f"onset_cohort_{safe}" not in names
        assert f"eps_onset_path_{safe}" not in names


class TestFeatureFlagDiagnostics:
    """Feature flags are logged to diagnostics."""

    def test_diagnostics_log_feature_flags(self):
        """Diagnostics first line contains all feature flag states."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params, features={
            "latent_onset": True,
            "latent_latency": True,
        })

        diag = metadata.get("diagnostics", [])
        assert len(diag) > 1
        features_line = diag[1]
        assert "latent_onset=True" in features_line
        assert "latent_latency=True" in features_line


# ===========================================================================
# Warm-start from unified posterior schema (doc 21 §6)
# ===========================================================================

class TestWarmStartLatencyFromUnifiedSlices:
    """Latency prior warm-start reads from posterior.slices['window()'] (doc 21 §6.2)."""

    def test_latency_warm_start_uses_slice_mu_sigma(self):
        """posterior.slices['window()'].mu_mean/sigma_mean → latency prior warm_start."""
        graph, params = _solo_edge_with_latency(mu=2.0, sigma=0.5)
        # Inject a previous unified posterior into the param file
        params["param-a-b"]["posterior"] = {
            "fitted_at": "1-Feb-25",
            "fingerprint": "prev-fp",
            "hdi_level": 0.9,
            "prior_tier": "direct_history",
            "slices": {
                "window()": {
                    "alpha": 80, "beta": 200,
                    "mu_mean": 2.5, "mu_sd": 0.06,
                    "sigma_mean": 0.35, "sigma_sd": 0.03,
                    "ess": 1000, "rhat": 1.002,
                },
            },
        }

        _, _, _, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.latency_prior is not None
        assert ev.latency_prior.source == "warm_start"
        # Should use posterior values, not topology defaults
        assert ev.latency_prior.mu == pytest.approx(2.5, abs=0.01)
        assert ev.latency_prior.sigma == pytest.approx(0.35, abs=0.01)

    def test_latency_warm_start_rejected_on_poor_convergence(self):
        """rhat > 1.10 in window() slice → warm-start rejected, falls back to topology."""
        graph, params = _solo_edge_with_latency(mu=2.0, sigma=0.5)
        params["param-a-b"]["posterior"] = {
            "fitted_at": "1-Feb-25",
            "fingerprint": "prev-fp",
            "hdi_level": 0.9,
            "prior_tier": "direct_history",
            "slices": {
                "window()": {
                    "alpha": 80, "beta": 200,
                    "mu_mean": 2.5, "sigma_mean": 0.35,
                    "ess": 50, "rhat": 1.20,   # poor convergence
                },
            },
        }

        _, _, _, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.latency_prior is not None
        assert ev.latency_prior.source == "topology"
        # Should use topology defaults, not posterior values
        assert ev.latency_prior.mu == pytest.approx(2.0, abs=0.01)


class TestWarmStartProbabilityFromUnifiedSlices:
    """Probability prior warm-start reads from posterior.slices['window()'] (doc 21 §6.2)."""

    def test_probability_warm_start_uses_slice_alpha_beta(self):
        """posterior.slices['window()'].alpha/beta → probability prior warm_start."""
        graph, params = _solo_edge_with_latency(p_true=0.3)
        params["param-a-b"]["posterior"] = {
            "fitted_at": "1-Feb-25",
            "fingerprint": "prev-fp",
            "hdi_level": 0.9,
            "prior_tier": "direct_history",
            "slices": {
                "window()": {
                    "alpha": 80, "beta": 200,
                    "mu_mean": 2.0, "sigma_mean": 0.4,
                    "ess": 1000, "rhat": 1.002,
                },
            },
        }

        _, _, _, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.prob_prior is not None
        assert ev.prob_prior.source == "warm_start"
        # Warm-start alpha/beta may be ESS-capped, but mean should approximate
        # the posterior mean (80 / (80+200) ≈ 0.286)
        warm_mean = ev.prob_prior.alpha / (ev.prob_prior.alpha + ev.prob_prior.beta)
        assert warm_mean == pytest.approx(80 / 280, abs=0.02)

    def test_probability_warm_start_rejected_on_poor_convergence(self):
        """rhat > 1.10 → warm-start rejected, falls back to moment-matched."""
        graph, params = _solo_edge_with_latency(p_true=0.3)
        params["param-a-b"]["posterior"] = {
            "fitted_at": "1-Feb-25",
            "fingerprint": "prev-fp",
            "hdi_level": 0.9,
            "prior_tier": "direct_history",
            "slices": {
                "window()": {
                    "alpha": 80, "beta": 200,
                    "ess": 50, "rhat": 1.20,  # poor
                },
            },
        }

        _, _, _, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.prob_prior is not None
        assert ev.prob_prior.source != "warm_start"


class TestWarmStartKappaFromModelState:
    """Kappa warm-start reads from posterior._model_state (doc 21 §6.1)."""

    def test_kappa_warm_start_from_model_state(self):
        """posterior._model_state.kappa_{edge_id} → warm-start kappa on evidence."""
        graph, params = _solo_edge_with_latency()
        safe_id = "edge_a_b"
        params["param-a-b"]["posterior"] = {
            "fitted_at": "1-Feb-25",
            "fingerprint": "prev-fp",
            "hdi_level": 0.9,
            "prior_tier": "direct_history",
            "slices": {
                "window()": {
                    "alpha": 80, "beta": 200,
                    "mu_mean": 2.0, "sigma_mean": 0.4,
                    "ess": 1000, "rhat": 1.002,
                },
            },
            "_model_state": {
                f"kappa_{safe_id}": 23.7,
            },
        }

        _, _, _, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.kappa_warm == pytest.approx(23.7, abs=0.01)

    def test_kappa_warm_start_absent_without_model_state(self):
        """No _model_state → kappa_warmstart is None."""
        graph, params = _solo_edge_with_latency()
        # No posterior at all
        _, _, _, evidence = _build(graph, params)

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.kappa_warm is None


class TestWarmStartCohortLatencyFromCohortSlice:
    """Cohort (path) latency warm-start reads from posterior.slices['cohort()'] (doc 21 §6.2)."""

    def test_cohort_latency_warm_start_from_cohort_slice(self):
        """posterior.slices['cohort()'].mu_mean → cohort latency warm-start."""
        graph, params = _two_latency_edges(onset_1=3.0, onset_2=7.0)
        # B→C has 2-edge path, so cohort latency is active
        params["param-b-c"]["posterior"] = {
            "fitted_at": "1-Feb-25",
            "fingerprint": "prev-fp",
            "hdi_level": 0.9,
            "prior_tier": "direct_history",
            "slices": {
                "window()": {
                    "alpha": 80, "beta": 200,
                    "mu_mean": 2.0, "sigma_mean": 0.5,
                    "ess": 1000, "rhat": 1.002,
                },
                "cohort()": {
                    "alpha": 70, "beta": 180,
                    "mu_mean": 2.8, "sigma_mean": 0.6,
                    "onset_mean": 12.0,
                    "ess": 800, "rhat": 1.005,
                },
            },
        }

        _, _, _, evidence = _build(graph, params, features={
            "latent_onset": True,
            "cohort_latency": True,
        })

        ev = evidence.edges.get("edge-b-c")
        assert ev is not None
        # Cohort warm-start should be populated
        assert ev.cohort_latency_warm is not None
        assert ev.cohort_latency_warm["mu"] == pytest.approx(2.8, abs=0.01)
        assert ev.cohort_latency_warm["sigma"] == pytest.approx(0.6, abs=0.01)
