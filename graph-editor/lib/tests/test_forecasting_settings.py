"""
Tests for forecasting_settings module.

Validates:
- Construction from dict (merges over defaults)
- Default values match TypeScript constants
- Settings signature is deterministic and sensitive to changes
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from runner.forecasting_settings import (
    ForecastingSettings,
    settings_from_dict,
    compute_settings_signature,
)


class TestForecastingSettingsDefaults:
    """Python defaults must match graph-editor/src/constants/latency.ts."""

    def test_min_fit_converters(self):
        assert ForecastingSettings().min_fit_converters == 30

    def test_min_mean_median_ratio(self):
        assert ForecastingSettings().min_mean_median_ratio == 0.9

    def test_max_mean_median_ratio(self):
        assert ForecastingSettings().max_mean_median_ratio == 999999

    def test_default_sigma(self):
        assert ForecastingSettings().default_sigma == 0.5

    def test_recency_half_life_days(self):
        assert ForecastingSettings().recency_half_life_days == 30

    def test_onset_mass_fraction_alpha(self):
        assert ForecastingSettings().onset_mass_fraction_alpha == 0.01

    def test_onset_aggregation_beta(self):
        assert ForecastingSettings().onset_aggregation_beta == 0.5

    def test_t95_percentile(self):
        assert ForecastingSettings().t95_percentile == 0.95

    def test_forecast_blend_lambda(self):
        assert ForecastingSettings().forecast_blend_lambda == 0.15

    def test_blend_completeness_power(self):
        assert ForecastingSettings().blend_completeness_power == 2.25

    def test_bayes_fit_history_interval_days(self):
        assert ForecastingSettings().bayes_fit_history_interval_days == 0

    def test_bayes_fit_history_max_days(self):
        assert ForecastingSettings().bayes_fit_history_max_days == 100

    # ── Bayesian model priors ──
    def test_bayes_log_kappa_mu(self):
        assert abs(ForecastingSettings().bayes_log_kappa_mu - 3.4012) < 0.001

    def test_bayes_log_kappa_sigma(self):
        assert ForecastingSettings().bayes_log_kappa_sigma == 1.5

    def test_bayes_fallback_prior_ess(self):
        assert ForecastingSettings().bayes_fallback_prior_ess == 20.0

    def test_bayes_dirichlet_conc_floor(self):
        assert ForecastingSettings().bayes_dirichlet_conc_floor == 0.5

    def test_bayes_sigma_floor(self):
        assert ForecastingSettings().bayes_sigma_floor == 0.01

    def test_bayes_mu_prior_sigma_floor(self):
        assert ForecastingSettings().bayes_mu_prior_sigma_floor == 0.5

    def test_bayes_maturity_floor(self):
        assert ForecastingSettings().bayes_maturity_floor == 0.9

    def test_bayes_softplus_sharpness(self):
        assert ForecastingSettings().bayes_softplus_sharpness == 8.0

    # ── Bayesian convergence thresholds ──
    def test_bayes_rhat_threshold(self):
        assert ForecastingSettings().bayes_rhat_threshold == 1.05

    def test_bayes_ess_threshold(self):
        assert ForecastingSettings().bayes_ess_threshold == 400.0

    def test_bayes_warm_start_rhat_max(self):
        assert ForecastingSettings().bayes_warm_start_rhat_max == 1.10

    def test_bayes_warm_start_ess_min(self):
        assert ForecastingSettings().bayes_warm_start_ess_min == 100.0

    def test_bayes_hdi_prob(self):
        assert ForecastingSettings().bayes_hdi_prob == 0.90

    # ── Bayesian sampling ──
    def test_bayes_draws(self):
        assert ForecastingSettings().bayes_draws == 2000.0

    def test_bayes_tune(self):
        assert ForecastingSettings().bayes_tune == 1000.0

    def test_bayes_chains(self):
        assert ForecastingSettings().bayes_chains == 4.0

    def test_bayes_target_accept(self):
        assert ForecastingSettings().bayes_target_accept == 0.90


class TestSettingsFromDict:

    def test_empty_dict_returns_defaults(self):
        s = settings_from_dict({})
        assert s == ForecastingSettings()

    def test_none_returns_defaults(self):
        s = settings_from_dict(None)
        assert s == ForecastingSettings()

    def test_partial_override(self):
        s = settings_from_dict({'forecast_blend_lambda': 0.3})
        assert s.forecast_blend_lambda == 0.3
        # Other fields remain at defaults.
        assert s.min_fit_converters == 30
        assert s.default_sigma == 0.5

    def test_full_override(self):
        d = {
            'min_fit_converters': 50,
            'min_mean_median_ratio': 0.8,
            'max_mean_median_ratio': 10,
            'default_sigma': 0.7,
            'recency_half_life_days': 14,
            'onset_mass_fraction_alpha': 0.02,
            'onset_aggregation_beta': 0.3,
            't95_percentile': 0.99,
            'forecast_blend_lambda': 0.25,
            'blend_completeness_power': 1.5,
        }
        s = settings_from_dict(d)
        assert s.min_fit_converters == 50
        assert s.min_mean_median_ratio == 0.8
        assert s.max_mean_median_ratio == 10
        assert s.default_sigma == 0.7
        assert s.recency_half_life_days == 14
        assert s.onset_mass_fraction_alpha == 0.02
        assert s.onset_aggregation_beta == 0.3
        assert s.t95_percentile == 0.99
        assert s.forecast_blend_lambda == 0.25
        assert s.blend_completeness_power == 1.5

    def test_extra_fields_ignored(self):
        s = settings_from_dict({'not_a_real_field': 999, 'forecast_blend_lambda': 0.1})
        assert s.forecast_blend_lambda == 0.1
        assert not hasattr(s, 'not_a_real_field')

    def test_non_finite_values_ignored(self):
        s = settings_from_dict({'forecast_blend_lambda': float('nan')})
        # NaN is ignored, default used.
        assert s.forecast_blend_lambda == 0.15

    def test_inf_values_ignored(self):
        s = settings_from_dict({'forecast_blend_lambda': float('inf')})
        assert s.forecast_blend_lambda == 0.15


class TestSettingsSignature:

    def test_deterministic(self):
        s = ForecastingSettings()
        sig1 = compute_settings_signature(s)
        sig2 = compute_settings_signature(s)
        assert sig1 == sig2

    def test_is_hex_string(self):
        sig = compute_settings_signature(ForecastingSettings())
        assert len(sig) == 16
        int(sig, 16)  # Raises if not valid hex.

    def test_changes_when_field_changes(self):
        base = compute_settings_signature(ForecastingSettings())
        modified = compute_settings_signature(ForecastingSettings(forecast_blend_lambda=0.99))
        assert base != modified

    def test_changes_for_every_field(self):
        """Every field must contribute to the signature."""
        base_sig = compute_settings_signature(ForecastingSettings())
        for field_name in ForecastingSettings.__dataclass_fields__:
            default_val = getattr(ForecastingSettings(), field_name)
            modified_val = default_val + 1.0 if default_val != 0 else 1.0
            modified = ForecastingSettings(**{field_name: modified_val})
            sig = compute_settings_signature(modified)
            assert sig != base_sig, f"Changing '{field_name}' did not change signature"

    def test_same_values_different_construction_same_signature(self):
        s1 = ForecastingSettings(forecast_blend_lambda=0.3)
        s2 = settings_from_dict({'forecast_blend_lambda': 0.3})
        assert compute_settings_signature(s1) == compute_settings_signature(s2)
