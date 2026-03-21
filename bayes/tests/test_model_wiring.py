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
    """Graph-level onset hyperprior wiring (Phase D.O, doc 18)."""

    def test_latent_onset_creates_hyperprior(self):
        """latent_onset=True → onset_hyper_mu and tau_onset in model."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})
        names = _model_var_names(model)

        assert "onset_hyper_mu" in names
        assert "tau_onset" in names

    def test_latent_onset_disabled_no_hyperprior(self):
        """latent_onset=False → no onset hyperprior variables."""
        graph, params = _solo_edge_with_latency()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": False})
        names = _model_var_names(model)

        assert "onset_hyper_mu" not in names
        assert "tau_onset" not in names

    def test_single_hyperprior_shared_across_edges(self):
        """Two latency edges share one onset_hyper_mu and one tau_onset."""
        graph, params = _two_latency_edges()
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})
        names = _model_var_names(model)

        # Exactly one hyperprior pair
        assert "onset_hyper_mu" in names
        assert "tau_onset" in names
        # Both edges have per-edge onset
        assert f"onset_{_safe('edge-a-b')}" in names
        assert f"onset_{_safe('edge-b-c')}" in names


class TestPerEdgeOnset:
    """Per-edge latent onset variable wiring."""

    def test_latency_edge_gets_onset_variables(self):
        """Latency edge → eps_onset, onset (Deterministic) in model."""
        graph, params = _solo_edge_with_latency(onset=3.0)
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})
        names = _model_var_names(model)
        safe = _safe("edge-a-b")

        assert f"eps_onset_{safe}" in names, "non-centred eps missing"
        assert f"onset_{safe}" in names, "onset Deterministic missing"

    def test_positive_onset_gets_soft_observation(self):
        """onset_delta_days > 0 → onset_obs_{id} observed variable."""
        graph, params = _solo_edge_with_latency(onset=5.0)
        model, metadata, _, _ = _build(graph, params, features={"latent_onset": True})
        names = _model_var_names(model)
        safe = _safe("edge-a-b")

        assert f"onset_obs_{safe}" in names, "histogram soft observation missing"

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
        assert len(diag) > 0
        first = diag[0]
        assert "latent_onset=True" in first
        assert "latent_latency=True" in first
