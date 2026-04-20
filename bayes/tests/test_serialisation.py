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
            "mu_mean", "mu_sd", "mu_sd_epist", "sigma_mean", "sigma_sd",
            "onset_delta_days", "hdi_t95_lower", "hdi_t95_upper",
            "hdi_level", "ess", "rhat", "provenance",
            # Phase D.O onset
            "onset_mean", "onset_sd", "onset_hdi_lower",
            "onset_hdi_upper", "onset_mu_corr",
            # Path-level
            "path_onset_delta_days", "path_onset_sd",
            "path_onset_hdi_lower", "path_onset_hdi_upper",
            "path_mu_mean", "path_mu_sd", "path_mu_sd_epist",
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
