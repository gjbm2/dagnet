"""
Golden parity tests for lag distribution maths (Python implementation).

Consumes lib/tests/fixtures/lag-distribution-golden.json — the same numerical
expectations are asserted by the TypeScript golden test suite
(src/services/__tests__/lagDistribution.golden.test.ts).

If any test fails here, either:
  - The Python port has a bug (fix it), or
  - The golden fixture is wrong (fix it and update both test suites).

Do NOT adjust tolerances to make a failing test pass without understanding why.
"""

import json
import math
from pathlib import Path

import pytest

# Module under test
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from runner.lag_distribution_utils import (
    erf,
    standard_normal_cdf,
    standard_normal_inverse_cdf,
    log_normal_cdf,
    log_normal_survival,
    log_normal_inverse_cdf,
    fit_lag_distribution,
    to_model_space,
    to_model_space_lag_days,
    to_model_space_age_days,
    LATENCY_DEFAULT_SIGMA,
    LATENCY_MIN_FIT_CONVERTERS,
    LATENCY_MIN_MEAN_MEDIAN_RATIO,
    LATENCY_MAX_MEAN_MEDIAN_RATIO,
)

# ─────────────────────────────────────────────────────────────
# Load golden fixture
# ─────────────────────────────────────────────────────────────

FIXTURE_PATH = Path(__file__).parent / 'fixtures' / 'lag-distribution-golden.json'
with open(FIXTURE_PATH, 'r') as f:
    GOLDEN = json.load(f)


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _parse_expected(val):
    """Parse expected value from fixture (handles 'inf', '-inf' strings)."""
    if val == 'inf':
        return float('inf')
    if val == '-inf':
        return float('-inf')
    return float(val)


# ─────────────────────────────────────────────────────────────
# Constants parity (Python defaults must match TS constants)
# ─────────────────────────────────────────────────────────────

class TestConstantsParity:
    """Assert Python default constants match the TypeScript constants."""

    def test_default_sigma(self):
        assert LATENCY_DEFAULT_SIGMA == 0.5

    def test_min_fit_converters(self):
        assert LATENCY_MIN_FIT_CONVERTERS == 30

    def test_min_mean_median_ratio(self):
        assert LATENCY_MIN_MEAN_MEDIAN_RATIO == 0.9

    def test_max_mean_median_ratio(self):
        assert LATENCY_MAX_MEAN_MEDIAN_RATIO == 999999


# ─────────────────────────────────────────────────────────────
# erf smoke tests
# ─────────────────────────────────────────────────────────────

class TestErf:
    def test_erf_zero(self):
        # A&S approximation returns ~1e-9 at x=0 (not exactly 0); same as TS.
        assert abs(erf(0.0)) < 1e-7

    def test_erf_positive(self):
        # erf(1) ≈ 0.8427
        assert abs(erf(1.0) - 0.8427007929) < 1e-6

    def test_erf_symmetry(self):
        assert abs(erf(-1.0) + erf(1.0)) < 1e-12

    def test_erf_large(self):
        assert abs(erf(5.0) - 1.0) < 1e-6


# ─────────────────────────────────────────────────────────────
# standard_normal_inverse_cdf (golden fixture)
# ─────────────────────────────────────────────────────────────

class TestStandardNormalInverseCDF:
    @pytest.mark.parametrize("case", GOLDEN['standard_normal_inverse_cdf'],
                             ids=[f"p={c['p']}" for c in GOLDEN['standard_normal_inverse_cdf']])
    def test_golden(self, case):
        expected = _parse_expected(case['expected'])
        result = standard_normal_inverse_cdf(case['p'])
        if math.isinf(expected):
            assert math.isinf(result) and (result > 0) == (expected > 0), \
                f"Expected {expected}, got {result}"
        else:
            assert abs(result - expected) < case['tol'], \
                f"p={case['p']}: expected {expected}, got {result}, delta={abs(result - expected)}"


# ─────────────────────────────────────────────────────────────
# log_normal_cdf (golden fixture)
# ─────────────────────────────────────────────────────────────

class TestLogNormalCDF:
    @pytest.mark.parametrize("case", GOLDEN['log_normal_cdf'],
                             ids=[f"t={c['t']}" for c in GOLDEN['log_normal_cdf']])
    def test_golden(self, case):
        result = log_normal_cdf(case['t'], case['mu'], case['sigma'])
        assert abs(result - case['expected']) <= case['tol'], \
            f"t={case['t']}: expected {case['expected']}, got {result}, delta={abs(result - case['expected'])}"

    def test_survival_complement(self):
        mu = math.log(3)
        sigma = 0.8
        for t in [1.0, 3.0, 5.0, 10.0]:
            cdf = log_normal_cdf(t, mu, sigma)
            surv = log_normal_survival(t, mu, sigma)
            assert abs(cdf + surv - 1.0) < 1e-12, f"CDF + survival != 1 at t={t}"


# ─────────────────────────────────────────────────────────────
# log_normal_inverse_cdf (golden fixture)
# ─────────────────────────────────────────────────────────────

class TestLogNormalInverseCDF:
    @pytest.mark.parametrize("case", GOLDEN['log_normal_inverse_cdf'],
                             ids=[f"p={c['p']}" for c in GOLDEN['log_normal_inverse_cdf']])
    def test_golden(self, case):
        expected = _parse_expected(case['expected'])
        result = log_normal_inverse_cdf(case['p'], case['mu'], case['sigma'])
        if math.isinf(expected):
            assert math.isinf(result), f"Expected inf, got {result}"
        else:
            assert abs(result - expected) <= case['tol'], \
                f"p={case['p']}: expected {expected}, got {result}, delta={abs(result - expected)}"

    def test_cdf_inverse_roundtrip(self):
        """CDF(inverseCDF(p)) ≈ p for various p values."""
        mu = math.log(3)
        sigma = 0.8
        for p in [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]:
            t = log_normal_inverse_cdf(p, mu, sigma)
            p_roundtrip = log_normal_cdf(t, mu, sigma)
            assert abs(p_roundtrip - p) < 1e-6, \
                f"Roundtrip failed at p={p}: got {p_roundtrip}"


# ─────────────────────────────────────────────────────────────
# fit_lag_distribution (golden fixture)
# ─────────────────────────────────────────────────────────────

class TestFitLagDistribution:
    @pytest.mark.parametrize("case", GOLDEN['fit_lag_distribution'],
                             ids=[f"median={c['median_lag']},mean={c['mean_lag']},k={c['total_k']}"
                                  for c in GOLDEN['fit_lag_distribution']])
    def test_golden(self, case):
        fit = fit_lag_distribution(
            median_lag=case['median_lag'],
            mean_lag=case['mean_lag'],
            total_k=case['total_k'],
        )
        assert abs(fit.mu - case['expected_mu']) <= case['tol_mu'], \
            f"mu: expected {case['expected_mu']}, got {fit.mu}"
        assert abs(fit.sigma - case['expected_sigma']) <= case['tol_sigma'], \
            f"sigma: expected {case['expected_sigma']}, got {fit.sigma}"
        assert fit.empirical_quality_ok == case['expected_quality_ok'], \
            f"quality_ok: expected {case['expected_quality_ok']}, got {fit.empirical_quality_ok}"

    def test_nan_median(self):
        fit = fit_lag_distribution(float('nan'), 4.0, 200)
        assert not fit.empirical_quality_ok
        assert math.isfinite(fit.mu)
        assert math.isfinite(fit.sigma)

    def test_inf_median(self):
        fit = fit_lag_distribution(float('inf'), 4.0, 200)
        assert not fit.empirical_quality_ok


# ─────────────────────────────────────────────────────────────
# to_model_space (golden fixture)
# ─────────────────────────────────────────────────────────────

class TestToModelSpace:
    @pytest.mark.parametrize("case", GOLDEN['to_model_space'],
                             ids=[f"onset={c['onset_delta_days']}" for c in GOLDEN['to_model_space']])
    def test_golden(self, case):
        result = to_model_space(
            onset_delta_days=case['onset_delta_days'],
            median_t_days=case['median_t'],
            mean_t_days=case.get('mean_t'),
            t95_t_days=case.get('t95_t'),
            age_t_days=case.get('age_t'),
        )
        assert result.onset_delta_days == case['expected_onset']

        tol = case['tol']

        # Some cases use "expected_x_gt" (greater-than check) instead of exact values.
        if 'expected_median_x' in case:
            assert abs(result.median_x_days - case['expected_median_x']) <= tol
        if 'expected_median_x_gt' in case:
            assert result.median_x_days > case['expected_median_x_gt']
            assert math.isfinite(result.median_x_days)

        if 'expected_mean_x' in case and result.mean_x_days is not None:
            assert abs(result.mean_x_days - case['expected_mean_x']) <= tol
        if 'expected_mean_x_gt' in case and result.mean_x_days is not None:
            assert result.mean_x_days > case['expected_mean_x_gt']

        if 'expected_t95_x' in case and result.t95_x_days is not None:
            assert abs(result.t95_x_days - case['expected_t95_x']) <= tol
        if 'expected_t95_x_gt' in case and result.t95_x_days is not None:
            assert result.t95_x_days > case['expected_t95_x_gt']

        if 'expected_age_x' in case and result.age_x_days is not None:
            assert abs(result.age_x_days - case['expected_age_x']) <= tol

    def test_none_onset_treated_as_zero(self):
        result = to_model_space(None, 10.0)
        assert result.onset_delta_days == 0
        assert abs(result.median_x_days - 10.0) < 1e-12

    def test_negative_onset_clamped_to_zero(self):
        result = to_model_space(-5.0, 10.0)
        assert result.onset_delta_days == 0
