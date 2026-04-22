"""
Serialisation contract tests for posterior IR → webhook JSON.

Verifies that:
  - to_webhook_dict() on internal types (LatencyPosteriorSummary,
    PosteriorSummary) produces correct rounding (regression tests).
  - _build_unified_slices() (doc 21) produces the unified slice shape
    the FE patch service expects.

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_serialisation.py -v
"""

from __future__ import annotations

import pytest

from bayes.compiler.types import (
    LatencyPosteriorSummary,
    PosteriorSummary,
    HDI_PROB,
)
from bayes.worker import _build_unified_slices


# ---------------------------------------------------------------------------
# LatencyPosteriorSummary.to_webhook_dict
# ---------------------------------------------------------------------------

class TestLatencyWebhookDict:
    """Contract: LatencyPosteriorSummary → webhook JSON shape."""

    def _base_summary(self, **overrides) -> LatencyPosteriorSummary:
        defaults = dict(
            mu_mean=2.3456,
            mu_sd=0.1234,
            sigma_mean=0.5678,
            sigma_sd=0.0456,
            onset_delta_days=3.456,
            hdi_t95_lower=12.34,
            hdi_t95_upper=45.67,
            hdi_level=HDI_PROB,
            ess=850.3,
            rhat=1.0012,
            provenance="bayesian",
        )
        defaults.update(overrides)
        return LatencyPosteriorSummary(**defaults)

    def test_base_fields_always_present(self):
        """Edge-level mu/sigma/onset/t95 keys always emitted."""
        d = self._base_summary().to_webhook_dict()
        required = {
            "mu_mean", "mu_sd", "sigma_mean", "sigma_sd",
            "onset_delta_days", "hdi_t95_lower", "hdi_t95_upper",
            "hdi_level", "ess", "rhat", "provenance",
        }
        assert required.issubset(d.keys()), f"missing: {required - d.keys()}"

    def test_base_field_rounding(self):
        """Rounding matches FE expectations: mu/sigma 4dp, onset 2dp, t95 1dp."""
        d = self._base_summary().to_webhook_dict()
        assert d["mu_mean"] == 2.3456       # 4dp
        assert d["mu_sd"] == 0.1234         # 4dp
        assert d["sigma_mean"] == 0.5678    # 4dp
        assert d["sigma_sd"] == 0.0456      # 4dp
        assert d["onset_delta_days"] == 3.46  # 2dp
        assert d["hdi_t95_lower"] == 12.3   # 1dp
        assert d["hdi_t95_upper"] == 45.7   # 1dp
        assert d["ess"] == 850.3            # 1dp
        assert d["rhat"] == 1.0012          # 4dp

    def test_rhat_zero_serialises_as_none(self):
        """rhat=0 (uninitialised) → None in payload."""
        d = self._base_summary(rhat=0.0).to_webhook_dict()
        assert d["rhat"] is None

    # -- Phase D.O: onset posterior fields --

    def test_onset_posterior_present_when_populated(self):
        """When onset_mean is set, all onset posterior keys emitted."""
        s = self._base_summary(
            onset_mean=3.21,
            onset_sd=0.87,
            onset_hdi_lower=1.56,
            onset_hdi_upper=5.12,
            onset_mu_corr=-0.423,
        )
        d = s.to_webhook_dict()
        assert d["onset_mean"] == 3.21       # 2dp
        assert d["onset_sd"] == 0.87         # 2dp
        assert d["onset_hdi_lower"] == 1.56  # 2dp
        assert d["onset_hdi_upper"] == 5.12  # 2dp
        assert d["onset_mu_corr"] == -0.423  # 3dp

    def test_onset_posterior_absent_when_none(self):
        """When onset_mean is None, no onset posterior keys emitted."""
        d = self._base_summary(onset_mean=None).to_webhook_dict()
        for key in ("onset_mean", "onset_sd", "onset_hdi_lower",
                     "onset_hdi_upper", "onset_mu_corr"):
            assert key not in d, f"{key} should not be in payload"

    def test_onset_mu_corr_absent_when_none(self):
        """onset_mu_corr omitted if None even when other onset fields present."""
        s = self._base_summary(
            onset_mean=3.0,
            onset_sd=0.5,
            onset_hdi_lower=2.0,
            onset_hdi_upper=4.0,
            onset_mu_corr=None,
        )
        d = s.to_webhook_dict()
        assert "onset_mean" in d
        assert "onset_mu_corr" not in d

    def test_onset_delta_days_reflects_posterior_mean(self):
        """When onset is latent, onset_delta_days should be the posterior mean."""
        s = self._base_summary(
            onset_delta_days=3.21,  # posterior mean (set by inference.py)
            onset_mean=3.21,
        )
        d = s.to_webhook_dict()
        assert d["onset_delta_days"] == d["onset_mean"]

    # -- Path-level (cohort) latency fields --

    def test_path_fields_present_when_populated(self):
        """When path_mu_mean is set, all path-level keys emitted."""
        s = self._base_summary(
            path_onset_delta_days=5.678,
            path_onset_sd=1.234,
            path_onset_hdi_lower=3.21,
            path_onset_hdi_upper=8.45,
            path_mu_mean=2.8765,
            path_mu_sd=0.2345,
            path_sigma_mean=0.6789,
            path_sigma_sd=0.0567,
            path_provenance="bayesian",
        )
        d = s.to_webhook_dict()
        assert d["path_onset_delta_days"] == 5.68  # 2dp
        assert d["path_onset_sd"] == 1.23           # 2dp
        assert d["path_onset_hdi_lower"] == 3.21    # 2dp
        assert d["path_onset_hdi_upper"] == 8.45    # 2dp
        assert d["path_mu_mean"] == 2.8765          # 4dp
        assert d["path_mu_sd"] == 0.2345            # 4dp
        assert d["path_sigma_mean"] == 0.6789       # 4dp
        assert d["path_sigma_sd"] == 0.0567         # 4dp
        assert d["path_provenance"] == "bayesian"

    def test_path_fields_absent_when_none(self):
        """When path_mu_mean is None, no path-level keys emitted."""
        d = self._base_summary(path_mu_mean=None).to_webhook_dict()
        for key in ("path_onset_delta_days", "path_onset_sd",
                     "path_onset_hdi_lower", "path_onset_hdi_upper",
                     "path_mu_mean", "path_mu_sd",
                     "path_sigma_mean", "path_sigma_sd",
                     "path_provenance"):
            assert key not in d, f"{key} should not be in payload"

    def test_path_provenance_falls_back_to_edge_provenance(self):
        """path_provenance defaults to edge provenance when not set."""
        s = self._base_summary(
            provenance="pooled-fallback",
            path_mu_mean=2.0,
            path_provenance=None,
        )
        d = s.to_webhook_dict()
        assert d["path_provenance"] == "pooled-fallback"

    def test_full_payload_key_count(self):
        """Fully populated summary produces exact expected key set."""
        s = self._base_summary(
            onset_mean=3.0, onset_sd=0.5,
            onset_hdi_lower=2.0, onset_hdi_upper=4.0,
            onset_mu_corr=-0.3,
            path_onset_delta_days=5.0, path_onset_sd=1.0,
            path_onset_hdi_lower=3.0, path_onset_hdi_upper=7.0,
            path_mu_mean=2.5, path_mu_sd=0.2,
            path_sigma_mean=0.6, path_sigma_sd=0.05,
            path_provenance="bayesian",
        )
        d = s.to_webhook_dict()
        expected_keys = {
            # Base
            "mu_mean", "mu_sd", "mu_sd_pred", "sigma_mean", "sigma_sd",
            "onset_delta_days", "hdi_t95_lower", "hdi_t95_upper",
            "hdi_level", "ess", "rhat", "provenance",
            # Phase D.O onset
            "onset_mean", "onset_sd", "onset_hdi_lower",
            "onset_hdi_upper", "onset_mu_corr",
            # Path-level (doc 61: bare = epistemic, _pred = predictive)
            "path_onset_delta_days", "path_onset_sd",
            "path_onset_hdi_lower", "path_onset_hdi_upper",
            "path_mu_mean", "path_mu_sd", "path_mu_sd_pred",
            "path_sigma_mean", "path_sigma_sd",
            "path_hdi_t95_lower", "path_hdi_t95_upper",
            "path_provenance",
        }
        assert d.keys() == expected_keys


# ---------------------------------------------------------------------------
# PosteriorSummary.to_webhook_dict (baseline — no Phase D.O changes)
# ---------------------------------------------------------------------------

class TestProbabilityWebhookDict:
    """Contract: PosteriorSummary → webhook JSON shape (regression)."""

    def test_probability_keys(self):
        s = PosteriorSummary(
            edge_id="e-1", param_id="p-1",
            alpha=12.34, beta=45.67,
            mean=0.2134, stdev=0.0456,
            hdi_lower=0.1234, hdi_upper=0.3456,
            ess=900.7, rhat=1.001,
        )
        d = s.to_webhook_dict()
        expected = {
            "alpha", "beta", "mean", "stdev",
            "hdi_lower", "hdi_upper", "hdi_level",
            "ess", "rhat", "provenance",
        }
        assert d.keys() == expected

    def test_probability_rounding(self):
        s = PosteriorSummary(
            edge_id="e-1", param_id="p-1",
            alpha=12.34567, beta=45.67891,
            mean=0.213456, stdev=0.045678,
            hdi_lower=0.123456, hdi_upper=0.345678,
            ess=900.78, rhat=1.00123,
        )
        d = s.to_webhook_dict()
        assert d["alpha"] == 12.3457     # 4dp
        assert d["beta"] == 45.6789      # 4dp
        assert d["mean"] == 0.213456     # 6dp
        assert d["stdev"] == 0.045678    # 6dp
        assert d["hdi_lower"] == 0.123456  # 6dp
        assert d["hdi_upper"] == 0.345678  # 6dp
        assert d["ess"] == 900.8         # 1dp
        assert d["rhat"] == 1.0012       # 4dp


# ---------------------------------------------------------------------------
# _build_unified_slices (doc 21: unified posterior schema)
# ---------------------------------------------------------------------------

class TestBuildUnifiedSlices:
    """Contract: PosteriorSummary + LatencyPosteriorSummary → unified slices dict."""

    def _base_prob(self, **overrides) -> PosteriorSummary:
        defaults = dict(
            edge_id="e-1", param_id="p-1",
            alpha=43.0, beta=119.5,
            mean=0.265, stdev=0.034,
            hdi_lower=0.22, hdi_upper=0.33,
            ess=1100, rhat=1.002,
            divergences=0, provenance="bayesian",
            prior_tier="direct_history",
        )
        defaults.update(overrides)
        return PosteriorSummary(**defaults)

    def _base_lat(self, **overrides) -> LatencyPosteriorSummary:
        defaults = dict(
            mu_mean=2.35, mu_sd=0.08,
            sigma_mean=0.72, sigma_sd=0.04,
            onset_delta_days=1.5,
            hdi_t95_lower=18.5, hdi_t95_upper=32.1,
            ess=950, rhat=1.006,
            provenance="bayesian",
        )
        defaults.update(overrides)
        return LatencyPosteriorSummary(**defaults)

    def test_window_slice_always_present(self):
        """window() slice is always emitted."""
        slices = _build_unified_slices(self._base_prob(), None)
        assert "window()" in slices
        assert "cohort()" not in slices

    def test_window_slice_has_probability_fields(self):
        """window() slice carries alpha/beta/p_hdi from PosteriorSummary."""
        slices = _build_unified_slices(self._base_prob(), None)
        w = slices["window()"]
        assert w["alpha"] == 43.0
        assert w["beta"] == 119.5
        assert w["p_hdi_lower"] == 0.22
        assert w["p_hdi_upper"] == 0.33
        assert w["provenance"] == "bayesian"

    def test_window_slice_has_latency_fields(self):
        """window() slice carries latency fields from LatencyPosteriorSummary."""
        slices = _build_unified_slices(self._base_prob(), self._base_lat())
        w = slices["window()"]
        assert w["mu_mean"] == 2.35
        assert w["mu_sd"] == 0.08
        assert w["sigma_mean"] == 0.72
        assert w["onset_mean"] == 1.5
        assert w["hdi_t95_lower"] == 18.5

    def test_window_slice_combined_quality(self):
        """ess = min(prob, lat), rhat = max(prob, lat)."""
        slices = _build_unified_slices(
            self._base_prob(ess=1100, rhat=1.002),
            self._base_lat(ess=950, rhat=1.006),
        )
        w = slices["window()"]
        assert w["ess"] == 950.0    # min
        assert w["rhat"] == 1.006   # max

    def test_cohort_slice_from_path_fields(self):
        """cohort() slice emitted when path-level latency fields present."""
        lat = self._base_lat(
            path_mu_mean=2.81, path_mu_sd=0.12,
            path_sigma_mean=0.58, path_sigma_sd=0.06,
            path_onset_delta_days=3.2,
            path_provenance="bayesian",
        )
        slices = _build_unified_slices(self._base_prob(), lat)
        assert "cohort()" in slices
        c = slices["cohort()"]
        assert c["alpha"] == 43.0           # same probability as window
        assert c["mu_mean"] == 2.81         # path-level
        assert c["onset_mean"] == 3.2
        assert c["provenance"] == "bayesian"

    def test_no_cohort_without_path_fields(self):
        """cohort() slice not emitted when no path-level latency."""
        slices = _build_unified_slices(self._base_prob(), self._base_lat())
        assert "cohort()" not in slices

    def test_onset_mu_corr_in_window(self):
        """onset_mu_corr present in window() when available."""
        lat = self._base_lat(onset_mu_corr=-0.423)
        slices = _build_unified_slices(self._base_prob(), lat)
        assert slices["window()"]["onset_mu_corr"] == -0.423

    def test_no_latency_fields_without_lat_post(self):
        """window() slice has no mu_mean etc. when no latency posterior."""
        slices = _build_unified_slices(self._base_prob(), None)
        w = slices["window()"]
        assert "mu_mean" not in w
        assert "sigma_mean" not in w

    def _lat_with_cohort(self, **overrides) -> LatencyPosteriorSummary:
        """Latency posterior with path-level fields so cohort() is emitted."""
        return self._base_lat(
            path_mu_mean=2.81, path_mu_sd=0.12,
            path_sigma_mean=0.58, path_sigma_sd=0.06,
            path_onset_delta_days=3.2,
            path_provenance="bayesian",
            **overrides,
        )

    def test_per_slice_cohort_uses_cohort_hdi_not_window(self):
        """Per-slice context(...).cohort() must use cohort posterior HDI, not window's.

        Regression: worker previously copied entry["p_hdi_lower/upper"] from the
        window slice even when a per-slice cohort posterior existed. Result was
        α/β from cohort but interval from window — silently wrong."""
        prob = self._base_prob()
        prob.slice_posteriors = {
            "channel:direct": {
                "alpha": 40.0, "beta": 120.0,
                "hdi_lower": 0.22, "hdi_upper": 0.33,
            },
        }
        prob.cohort_slice_posteriors = {
            "channel:direct": {
                "alpha": 55.0, "beta": 105.0,
                "p_mean": 0.344, "p_sd": 0.037,
                "hdi_lower": 0.275, "hdi_upper": 0.415,
            },
        }
        slices = _build_unified_slices(prob, self._lat_with_cohort())
        c = slices["context(channel:direct).cohort()"]
        assert c["provenance"] == "bayesian"
        assert c["alpha"] == 55.0
        assert c["beta"] == 105.0
        assert c["p_hdi_lower"] == 0.275
        assert c["p_hdi_upper"] == 0.415
        w = slices["context(channel:direct).window()"]
        assert w["p_hdi_lower"] == 0.22
        assert w["p_hdi_upper"] == 0.33

    def test_per_slice_cohort_window_copy_fallback(self):
        """When no per-slice cohort posterior exists, fall back to window-copy."""
        prob = self._base_prob()
        prob.slice_posteriors = {
            "channel:direct": {
                "alpha": 40.0, "beta": 120.0,
                "hdi_lower": 0.22, "hdi_upper": 0.33,
            },
        }
        # cohort_slice_posteriors left empty
        slices = _build_unified_slices(prob, self._lat_with_cohort())
        c = slices["context(channel:direct).cohort()"]
        assert c["provenance"] == "window-copy"
        assert c["alpha"] == 40.0
        assert c["beta"] == 120.0
        assert c["p_hdi_lower"] == 0.22
        assert c["p_hdi_upper"] == 0.33


# ---------------------------------------------------------------------------
# Dispersion completeness — predictive + epistemic fields on the unified
# slices dict. These tests lock in the contract that every dispersion the
# Bayes model computes is actually emitted in the payload the FE consumes.
# See doc 49 §A.6 (predictive vs epistemic split) and doc 52 §14.
# ---------------------------------------------------------------------------

# Fields that MUST appear on the window() slice when the corresponding
# source fields on the dataclasses are populated. Frozen as a contract —
# adding a dispersion to PosteriorSummary/LatencyPosteriorSummary without
# plumbing it here will fail `test_window_full_dispersion_surface`.
WINDOW_PREDICTIVE_PROB_FIELDS = {
    "alpha_pred", "beta_pred", "hdi_lower_pred", "hdi_upper_pred",
}
WINDOW_EPISTEMIC_PROB_FIELDS = {"alpha", "beta", "p_hdi_lower", "p_hdi_upper"}
WINDOW_LATENCY_DISPERSION_FIELDS = {
    "mu_sd", "mu_sd_pred", "sigma_sd", "onset_sd",
}
WINDOW_LATENCY_OVERDISPERSION_FIELDS = {"kappa_lat_mean", "kappa_lat_sd"}
WINDOW_SUBSET_MASS_FIELDS = {"n_effective"}

COHORT_PREDICTIVE_PROB_FIELDS = WINDOW_PREDICTIVE_PROB_FIELDS
# Doc 61: current model has no path-level predictive mechanism, so the
# cohort() slice carries only the bare (epistemic) mu_sd — no mu_sd_pred.
COHORT_LATENCY_DISPERSION_FIELDS = {
    "mu_sd", "sigma_sd", "onset_sd",
}
COHORT_LATENCY_OVERDISPERSION_FIELDS = WINDOW_LATENCY_OVERDISPERSION_FIELDS
COHORT_SUBSET_MASS_FIELDS = WINDOW_SUBSET_MASS_FIELDS


class TestUnifiedSlicesDispersionCompleteness:
    """Contract: every dispersion/predictive field that the Bayes model
    computes must flow through `_build_unified_slices` into the payload.

    These tests exist because silent drops at this boundary (model emits X,
    payload omits X) broke predictive/epistemic propagation into the graph
    upsert, and no prior test asserted surface completeness.
    """

    def _fully_populated_prob(self) -> PosteriorSummary:
        """PosteriorSummary with every optional predictive/mass field set."""
        return PosteriorSummary(
            edge_id="e-1", param_id="p-1",
            alpha=43.0, beta=119.5,
            mean=0.265, stdev=0.034,
            hdi_lower=0.22, hdi_upper=0.33,
            ess=1100, rhat=1.002,
            divergences=0, provenance="bayesian",
            prior_tier="direct_history",
            # Epistemic per-mode (doc 49 §A.6.1)
            window_alpha=44.0, window_beta=118.0,
            window_hdi_lower=0.225, window_hdi_upper=0.335,
            cohort_alpha=40.0, cohort_beta=115.0,
            cohort_hdi_lower=0.21, cohort_hdi_upper=0.34,
            # Predictive (kappa-inflated)
            window_alpha_pred=30.0, window_beta_pred=80.0,
            window_hdi_lower_pred=0.18, window_hdi_upper_pred=0.38,
            cohort_alpha_pred=25.0, cohort_beta_pred=70.0,
            cohort_hdi_lower_pred=0.16, cohort_hdi_upper_pred=0.42,
            # Subset-conditioning mass (doc 52 §14.2)
            window_n_effective=4500.0, cohort_n_effective=3200.0,
        )

    def _fully_populated_lat(self) -> LatencyPosteriorSummary:
        """LatencyPosteriorSummary with every optional dispersion field set."""
        return LatencyPosteriorSummary(
            # Edge-level (doc 61: bare mu_sd is epistemic, mu_sd_pred is predictive)
            mu_mean=2.35, mu_sd=0.08,           # epistemic anchor
            sigma_mean=0.72, sigma_sd=0.04,
            onset_delta_days=1.5,
            hdi_t95_lower=18.5, hdi_t95_upper=32.1,
            ess=950, rhat=1.006,
            provenance="bayesian",
            mu_sd_pred=0.12,                    # predictive (kappa_lat-inflated)
            onset_mean=1.5, onset_sd=0.3,
            onset_hdi_lower=0.9, onset_hdi_upper=2.1,
            onset_mu_corr=-0.423,
            # Path-level (cohort) — no predictive mechanism today
            path_onset_delta_days=3.2, path_onset_sd=0.5,
            path_onset_hdi_lower=2.4, path_onset_hdi_upper=4.0,
            path_mu_mean=2.81, path_mu_sd=0.12,  # epistemic
            path_sigma_mean=0.58, path_sigma_sd=0.06,
            path_hdi_t95_lower=28.4, path_hdi_t95_upper=58.7,
            path_provenance="bayesian",
            # Latency overdispersion (doc 34)
            kappa_lat_mean=25.3, kappa_lat_sd=4.7,
        )

    # -- Window predictive probability (doc 49 §A.6.1) --

    def test_window_predictive_probability_fields_present(self):
        """alpha_pred/beta_pred/hdi_*_pred appear on window() when kappa present.

        Without these the FE's funnel runner and cohort_forecast_v3 default
        alpha_pred = alpha and predictive dispersion collapses to epistemic
        — the bug this test class exists to prevent.
        """
        slices = _build_unified_slices(self._fully_populated_prob(), None)
        w = slices["window()"]
        assert w["alpha_pred"] == 30.0
        assert w["beta_pred"] == 80.0
        assert w["hdi_lower_pred"] == 0.18
        assert w["hdi_upper_pred"] == 0.38
        assert WINDOW_PREDICTIVE_PROB_FIELDS.issubset(w.keys()), (
            f"window() missing predictive probability fields: "
            f"{WINDOW_PREDICTIVE_PROB_FIELDS - w.keys()}"
        )

    def test_window_predictive_fields_omitted_when_kappa_absent(self):
        """alpha_pred keys NOT emitted when PosteriorSummary has no
        predictive fields — omission, not alpha_pred=alpha duplication."""
        prob = PosteriorSummary(
            edge_id="e-1", param_id="p-1",
            alpha=43.0, beta=119.5,
            mean=0.265, stdev=0.034,
            hdi_lower=0.22, hdi_upper=0.33,
            ess=1100, rhat=1.002,
            divergences=0, provenance="bayesian",
        )
        slices = _build_unified_slices(prob, None)
        w = slices["window()"]
        for k in WINDOW_PREDICTIVE_PROB_FIELDS:
            assert k not in w, f"{k} should not be emitted when kappa absent"

    # -- Window n_effective (doc 52 §14.3) --

    def test_window_n_effective_present(self):
        """window.n_effective emitted when PosteriorSummary.window_n_effective set.

        Consumer: resolve_model_params → ResolvedModelParams.n_effective
        for the subset-conditioning blend ratio. Silent drop means the
        engine falls back to treating the window posterior as unconditional.
        """
        slices = _build_unified_slices(self._fully_populated_prob(), None)
        w = slices["window()"]
        assert w["n_effective"] == 4500.0

    def test_window_n_effective_omitted_when_none(self):
        prob = self._fully_populated_prob()
        prob.window_n_effective = None
        slices = _build_unified_slices(prob, None)
        assert "n_effective" not in slices["window()"]

    # -- Window latency dispersions (epistemic + predictive + overdisp) --

    def test_window_latency_dispersions_complete(self):
        """All latency dispersion fields present when lat fully populated."""
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        w = slices["window()"]
        expected = (
            WINDOW_LATENCY_DISPERSION_FIELDS
            | WINDOW_LATENCY_OVERDISPERSION_FIELDS
        )
        missing = expected - w.keys()
        assert not missing, f"window() missing latency dispersions: {missing}"
        assert w["mu_sd"] == 0.08           # epistemic (doc 61)
        assert w["mu_sd_pred"] == 0.12      # predictive (kappa_lat-inflated)
        assert w["sigma_sd"] == 0.04        # always epistemic
        assert w["onset_sd"] == 0.3
        assert w["kappa_lat_mean"] == 25.3
        assert w["kappa_lat_sd"] == 4.7

    def test_window_mu_sd_pred_omitted_when_none(self):
        """mu_sd_pred omitted when None (no kappa_lat fitted — doc 61)."""
        lat = self._fully_populated_lat()
        lat.mu_sd_pred = None
        slices = _build_unified_slices(self._fully_populated_prob(), lat)
        assert "mu_sd_pred" not in slices["window()"]

    def test_window_kappa_lat_omitted_when_absent(self):
        """kappa_lat_mean/sd omitted when latency dispersion disabled."""
        lat = self._fully_populated_lat()
        lat.kappa_lat_mean = None
        lat.kappa_lat_sd = None
        slices = _build_unified_slices(self._fully_populated_prob(), lat)
        w = slices["window()"]
        assert "kappa_lat_mean" not in w
        assert "kappa_lat_sd" not in w

    # -- Cohort predictive probability + mass --

    def test_cohort_predictive_probability_fields_present(self):
        """alpha_pred/beta_pred/hdi_*_pred appear on cohort() when populated."""
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        c = slices["cohort()"]
        assert c["alpha_pred"] == 25.0
        assert c["beta_pred"] == 70.0
        assert c["hdi_lower_pred"] == 0.16
        assert c["hdi_upper_pred"] == 0.42
        assert COHORT_PREDICTIVE_PROB_FIELDS.issubset(c.keys()), (
            f"cohort() missing predictive: "
            f"{COHORT_PREDICTIVE_PROB_FIELDS - c.keys()}"
        )

    def test_cohort_n_effective_present(self):
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        assert slices["cohort()"]["n_effective"] == 3200.0

    # -- Cohort latency dispersions (path_* stripped to bare names) --

    def test_cohort_latency_dispersions_complete(self):
        """Path-level latency dispersions flow to cohort() under stripped names."""
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        c = slices["cohort()"]
        assert c["mu_sd"] == 0.12            # from path_mu_sd (epistemic — doc 61)
        assert c["sigma_sd"] == 0.06         # from path_sigma_sd
        assert c["onset_sd"] == 0.5          # from path_onset_sd
        assert c["kappa_lat_mean"] == 25.3   # shared with window
        assert c["kappa_lat_sd"] == 4.7
        # No path-level predictive mechanism in current model (doc 61) —
        # path cohort slice carries only bare mu_sd.
        assert "mu_sd_pred" not in c

    # -- Meta-tests: frozen contract --

    def test_window_full_dispersion_surface(self):
        """Meta-contract: fully-populated input emits every expected field.

        This test enumerates the complete predictive+epistemic surface on
        the window() slice. If a new dispersion is added to
        PosteriorSummary or LatencyPosteriorSummary, update this set AND
        `_build_unified_slices` — failing here is the assurance that the
        serialiser isn't silently dropping new fields.
        """
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        w = slices["window()"]
        required = (
            WINDOW_EPISTEMIC_PROB_FIELDS
            | WINDOW_PREDICTIVE_PROB_FIELDS
            | WINDOW_LATENCY_DISPERSION_FIELDS
            | WINDOW_LATENCY_OVERDISPERSION_FIELDS
            | WINDOW_SUBSET_MASS_FIELDS
        )
        missing = required - w.keys()
        assert not missing, (
            f"window() slice missing required dispersion/predictive "
            f"fields: {missing}. Either _build_unified_slices stopped "
            f"emitting them, or this contract drifted from the dataclass."
        )

    def test_cohort_full_dispersion_surface(self):
        """Meta-contract: cohort() slice must carry the same dispersion
        surface as window(), sourced from path_* dataclass fields.
        """
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        c = slices["cohort()"]
        required = (
            WINDOW_EPISTEMIC_PROB_FIELDS
            | COHORT_PREDICTIVE_PROB_FIELDS
            | COHORT_LATENCY_DISPERSION_FIELDS
            | COHORT_LATENCY_OVERDISPERSION_FIELDS
            | COHORT_SUBSET_MASS_FIELDS
        )
        missing = required - c.keys()
        assert not missing, (
            f"cohort() slice missing required dispersion/predictive "
            f"fields: {missing}"
        )


# ---------------------------------------------------------------------------
# Dataclass introspection meta-tests — auto-detect new fields
#
# These tests walk `dataclasses.fields()` and verify that every data-bearing
# field on PosteriorSummary / LatencyPosteriorSummary either flows into the
# unified slices output or is explicitly listed as intentionally excluded.
#
# Purpose: if a future change adds a new field to either dataclass and
# forgets to plumb it through `_build_unified_slices`, this test fails
# automatically — without anyone having to remember to update an enumerated
# list. The cost of the safety net is the exclusion registry below: every
# non-data-bearing field must be explicitly listed with a reason.
# ---------------------------------------------------------------------------

import dataclasses

# LatencyPosteriorSummary: edge-level fields flow verbatim to window();
# path_* fields flow to cohort() under stripped names (path_mu_sd → mu_sd).
# Exceptions:
#   - Metadata / provenance / quality fields: written but not "data".
#   - Internal fields: not in payload by design.
#
# Format: field_name → expected_key_in_window OR expected_key_in_cohort
# Use None to mark "intentionally not serialised" (with a reason in comment).

_LAT_EXCLUDED_REASON = {
    # Quality / metadata — present as ess/rhat on slices but not as
    # data-flow dispersion fields (combined across prob + lat).
    "hdi_level": "constant metadata, not slice-level",
    "ess": "combined min across prob+lat, tested separately",
    "rhat": "combined max across prob+lat, tested separately",
    "provenance": "metadata, tested separately",
    "path_provenance": "metadata, tested separately",
    # LOO-ELPD internals — raw `elpd`, `elpd_se`, `elpd_null` stay inside
    # the dataclass; only `delta_elpd` is emitted.
    "elpd": "internal; only delta_elpd is serialised",
    "elpd_se": "internal; only delta_elpd is serialised",
    "elpd_null": "internal; only delta_elpd is serialised",
    # LOO emitted-fields are owned by PosteriorSummary (worker.py emits
    # prob.delta_elpd etc. into window/cohort slices). LatencyPosteriorSummary
    # has these too for dataclass symmetry but they are not emitted from the
    # latency side — the prob side is authoritative.
    "delta_elpd": "emitted from prob, not from lat (single-source)",
    "pareto_k_max": "emitted from prob, not from lat (single-source)",
    "n_loo_obs": "emitted from prob, not from lat (single-source)",
    # onset_delta_days is the POINT value (becomes onset_mean in slices
    # when onset is latent; otherwise conveyed via `onset_mean`).
    "onset_delta_days": "becomes slice onset_mean; tested via onset_mean",
    "path_onset_delta_days": "becomes cohort onset_mean; tested separately",
    # onset_hdi bounds — currently not emitted in slices (HDI is on t95).
    # If that changes, add to RENAMES_TO_WINDOW/COHORT.
    "onset_hdi_lower": "not in slice payload; only onset_sd is used",
    "onset_hdi_upper": "not in slice payload; only onset_sd is used",
    "path_onset_hdi_lower": "not in slice payload",
    "path_onset_hdi_upper": "not in slice payload",
    # path_provenance / ppc_traj — conditional, tested by dedicated cases.
    "ppc_traj_coverage_90": "conditional field, tested separately",
    "ppc_traj_n_obs": "conditional field, tested separately",
    # mu_mean is edge-level primary; handled as window[mu_mean].
    # Doc 61: path-level has no predictive mechanism in the current
    # model, so path_mu_sd_pred is never populated and is intentionally
    # not plumbed onto the cohort() slice.
    "path_mu_sd_pred": "no path-level predictive mechanism today (doc 61)",
}

# Fields that rename when projecting path_ fields onto cohort() slice
_LAT_PATH_TO_COHORT_RENAME = {
    "path_mu_mean": "mu_mean",
    "path_mu_sd": "mu_sd",
    "path_sigma_mean": "sigma_mean",
    "path_sigma_sd": "sigma_sd",
    "path_onset_sd": "onset_sd",
    "path_hdi_t95_lower": "hdi_t95_lower",
    "path_hdi_t95_upper": "hdi_t95_upper",
}


class TestDataclassIntrospectionCoverage:
    """Auto-detect new dispersion fields on dataclasses.

    These meta-tests use `dataclasses.fields()` to ensure that a future
    change adding a new field to LatencyPosteriorSummary or PosteriorSummary
    is either (a) plumbed through `_build_unified_slices`, or (b) explicitly
    added to the excluded-reason registry above with a documented reason.
    Silent omission is not possible.
    """

    def _fully_populated_prob(self) -> PosteriorSummary:
        # Re-use fixture from the enumerated test class
        return TestUnifiedSlicesDispersionCompleteness()._fully_populated_prob()

    def _fully_populated_lat(self) -> LatencyPosteriorSummary:
        return TestUnifiedSlicesDispersionCompleteness()._fully_populated_lat()

    def test_every_latency_field_flows_through_or_is_excluded(self):
        """Every field on LatencyPosteriorSummary must either appear in
        the unified slices output or be listed in _LAT_EXCLUDED_REASON.
        """
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        window = slices["window()"]
        cohort = slices.get("cohort()", {})

        unaccounted: list[str] = []
        for f in dataclasses.fields(LatencyPosteriorSummary):
            name = f.name

            if name in _LAT_EXCLUDED_REASON:
                continue

            if name.startswith("path_"):
                # Path-level → cohort() slice. Apply rename if any.
                expected_key = _LAT_PATH_TO_COHORT_RENAME.get(name, name)
                if expected_key not in cohort:
                    unaccounted.append(f"{name} (expected cohort.{expected_key})")
            else:
                # Edge-level → window() slice, verbatim name.
                if name not in window:
                    unaccounted.append(f"{name} (expected window.{name})")

        assert not unaccounted, (
            "New LatencyPosteriorSummary fields not plumbed through to "
            "`_build_unified_slices`. Either wire them into the slices "
            "output OR add to `_LAT_EXCLUDED_REASON` with a documented "
            f"reason.\n\nUnaccounted: {unaccounted}"
        )

    def test_every_probability_predictive_field_flows_through(self):
        """Every predictive / subset-mass field on PosteriorSummary must
        appear in window() or cohort() output. Scoped to the fields this
        test class is designed to protect (predictive + mass); epistemic
        base fields are covered by enumerated tests above.
        """
        slices = _build_unified_slices(
            self._fully_populated_prob(), self._fully_populated_lat(),
        )
        window = slices["window()"]
        cohort = slices["cohort()"]

        prob_field_to_slice = {
            # Window predictive
            "window_alpha_pred": ("window", "alpha_pred"),
            "window_beta_pred": ("window", "beta_pred"),
            "window_hdi_lower_pred": ("window", "hdi_lower_pred"),
            "window_hdi_upper_pred": ("window", "hdi_upper_pred"),
            # Cohort predictive
            "cohort_alpha_pred": ("cohort", "alpha_pred"),
            "cohort_beta_pred": ("cohort", "beta_pred"),
            "cohort_hdi_lower_pred": ("cohort", "hdi_lower_pred"),
            "cohort_hdi_upper_pred": ("cohort", "hdi_upper_pred"),
            # Subset-conditioning mass (doc 52 §14.3)
            "window_n_effective": ("window", "n_effective"),
            "cohort_n_effective": ("cohort", "n_effective"),
        }
        target = {"window": window, "cohort": cohort}
        unaccounted: list[str] = []
        for source_field, (slice_name, out_key) in prob_field_to_slice.items():
            # Verify the source field actually exists on the dataclass —
            # catches typos / removals at test authoring time.
            assert any(
                f.name == source_field
                for f in dataclasses.fields(PosteriorSummary)
            ), f"stale test reference: {source_field} not on PosteriorSummary"
            if out_key not in target[slice_name]:
                unaccounted.append(
                    f"{source_field} → {slice_name}().{out_key}"
                )
        assert not unaccounted, (
            f"PosteriorSummary predictive/mass fields missing from "
            f"unified slices: {unaccounted}"
        )
