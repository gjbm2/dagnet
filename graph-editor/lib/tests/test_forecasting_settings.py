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
    current_settings,
    settings_from_dict,
    compute_settings_signature,
    use_request_settings,
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

    def test_snapshot_observation_t95_multiplier(self):
        assert ForecastingSettings().snapshot_observation_t95_multiplier == 2.0

    def test_snapshot_observation_path_t95_multiplier(self):
        assert ForecastingSettings().snapshot_observation_path_t95_multiplier == 1.5

    def test_saturation_percentile(self):
        assert ForecastingSettings().saturation_percentile == 0.99

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

    # ── Forecast Monte Carlo sampling ──
    def test_mc_draws(self):
        assert ForecastingSettings().mc_draws == 1000.0


class TestRequestSettingsContext:
    """The contextvar binding threads request settings into engine call sites."""

    def test_default_when_unbound(self):
        # Outside any use_request_settings block the reader returns defaults.
        s = current_settings()
        assert s.mc_draws == 1000.0

    def test_bound_value_visible(self):
        with use_request_settings(ForecastingSettings(mc_draws=500.0)):
            assert current_settings().mc_draws == 500.0

    def test_unbinds_on_exit(self):
        with use_request_settings(ForecastingSettings(mc_draws=4242.0)):
            assert current_settings().mc_draws == 4242.0
        assert current_settings().mc_draws == 1000.0

    def test_round_trip_from_dict(self):
        # The API handler path: dict → settings → context → engine read.
        s = settings_from_dict({'mc_draws': 750.0})
        with use_request_settings(s):
            assert current_settings().mc_draws == 750.0

    def test_primitive_current_mc_draws_honours_context(self):
        # The engine seam: primitives.current_mc_draws reads the bound value.
        from runner.primitives import current_mc_draws
        with use_request_settings(ForecastingSettings(mc_draws=333.0)):
            assert current_mc_draws() == 333

    def test_conditioning_options_default_factory_honours_context(self):
        # The dataclass default factory reads the bound value at construct time.
        from runner.primitive_conditioning import ConditioningPolicyOptions
        with use_request_settings(ForecastingSettings(mc_draws=128.0)):
            opts = ConditioningPolicyOptions()
            assert opts.draw_count == 128


class TestCFKernelHonoursMcDraws:
    """Seam test: the CF math must honour ``mc_draws`` bound via
    ``use_request_settings`` when the caller does not pass ``num_draws``.

    The production call style — ``handle_conditioned_forecast`` binding
    settings then invoking the CF kernel without threading ``num_draws``
    through every signature — relies on every consumer defaulting
    ``num_draws`` to ``current_mc_draws()``. The primitive-level test
    above only proves the reader returns the bound value; this proves
    the kernel actually consumes it (i.e. the bound value shapes the
    arrays the engine produces).

    ``compute_forecast_trajectory`` is the chosen probe: same seam
    pattern as the other live CF consumers (forecast_runtime,
    funnel_engine, build_node_arrival_cache, confidence_bands) and
    directly testable with synthetic resolved-params / cohort fixtures
    (no graph, no DB, no daemon). A regression in any of those sites
    would be caught by an equivalent test; this one stands in for the
    family.
    """

    def _make_resolved(self):
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency

        lat = ResolvedLatency(
            mu=3.0, sigma=0.6, onset_delta_days=0.0, t95=12.0,
            mu_sd=0.0, sigma_sd=0.0,
            onset_sd=0.0, onset_mu_corr=0.0,
        )
        return ResolvedModelParams(
            p_mean=0.4, p_sd=0.05,
            alpha=12, beta=18,
            edge_latency=lat,
            path_latency=None,
            source='analytic',
        )

    def _make_cohorts(self, max_tau=20):
        from runner.forecast_state import CohortEvidence

        return [CohortEvidence(
            obs_x=[100.0] * (max_tau + 1),
            obs_y=[0.0] * (max_tau + 1),
            x_frozen=100.0, y_frozen=0.0,
            frontier_age=0, a_pop=100.0,
        )]

    def test_trajectory_draws_count_follows_bound_setting(self):
        from runner.forecast_state import compute_forecast_trajectory

        resolved = self._make_resolved()
        cohorts = self._make_cohorts(max_tau=20)

        with use_request_settings(ForecastingSettings(mc_draws=250.0)):
            result = compute_forecast_trajectory(
                resolved=resolved, cohorts=cohorts, max_tau=20,
            )

        assert result.rate_draws.shape == (250, 21)
        assert result.model_rate_draws.shape == (250, 21)

    def test_trajectory_draws_count_varies_with_bound_setting(self):
        # A second distinct value distinguishes "the setting is honoured"
        # from "the kernel coincidentally hit the dataclass default".
        from runner.forecast_state import compute_forecast_trajectory

        resolved = self._make_resolved()
        cohorts = self._make_cohorts(max_tau=20)

        with use_request_settings(ForecastingSettings(mc_draws=750.0)):
            result = compute_forecast_trajectory(
                resolved=resolved, cohorts=cohorts, max_tau=20,
            )

        assert result.rate_draws.shape == (750, 21)
        assert result.model_rate_draws.shape == (750, 21)

    def test_explicit_num_draws_overrides_bound_setting(self):
        # Locally-passed num_draws wins — preserves the override seam
        # used by tests and any caller that genuinely needs a non-request
        # count. Documents the contract: the bound setting is the default,
        # not a forced override.
        from runner.forecast_state import compute_forecast_trajectory

        resolved = self._make_resolved()
        cohorts = self._make_cohorts(max_tau=20)

        with use_request_settings(ForecastingSettings(mc_draws=750.0)):
            result = compute_forecast_trajectory(
                resolved=resolved, cohorts=cohorts, max_tau=20,
                num_draws=100,
            )

        assert result.rate_draws.shape == (100, 21)


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
            'snapshot_observation_t95_multiplier': 2.5,
            'snapshot_observation_path_t95_multiplier': 1.25,
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
        assert s.snapshot_observation_t95_multiplier == 2.5
        assert s.snapshot_observation_path_t95_multiplier == 1.25

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
