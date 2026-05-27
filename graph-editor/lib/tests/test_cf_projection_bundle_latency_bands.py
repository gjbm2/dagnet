"""Phase 2 (73q) — latency-band tau accessor.

The daily-conversions enrichment in ``api_handlers.py`` computes its
latency-band tau set inline from the resolved latency:

    inv_cdf(0.25/0.50/0.75, mu, sigma) + onset_delta_days,
    discretised with max(1, round(raw)) and deduplicated by tau.

73q Phase 2 lifts that exact derivation into one shared accessor so both
reducers and any future consumer share a single definition (73q
§"Latency-band tau accessor"). These tests pin the accessor against a
local oracle that reproduces the inline derivation byte-for-byte, and
assert the contract that a band tau is returned unclamped — the date
reducer, not the accessor, decides a band beyond saturation is
unavailable.
"""

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from runner.cf_projection_bundle import latency_band_taus
from runner.lag_distribution_utils import log_normal_inverse_cdf


def _inline_oracle(mu, sigma, onset):
    """Reproduces the exact inline derivation at api_handlers.py:3546-3551."""
    band_taus = []
    for q in [0.25, 0.50, 0.75]:
        raw = log_normal_inverse_cdf(q, mu, sigma) + onset
        tau_d = max(1, round(raw))
        if tau_d not in [t for t, _ in band_taus]:
            band_taus.append((tau_d, f'{tau_d}d'))
    return band_taus


# (mu, sigma, onset) spanning short/medium/long lags and small-sigma
# (dedup) and large-onset cases.
PARAMS = [
    (math.log(5.0), 0.8, 1.0),
    (math.log(5.0), 0.8, 0.0),
    (math.log(20.0), 1.0, 3.0),
    (math.log(2.0), 0.2, 0.0),    # tight — quantiles may collide → dedup
    (math.log(100.0), 1.2, 7.0),  # long lag → large band taus
]


class TestLatencyBandTausMatchesInlineDerivation:

    @pytest.mark.parametrize('mu,sigma,onset', PARAMS)
    def test_matches_inline_oracle(self, mu, sigma, onset):
        assert latency_band_taus(mu, sigma, onset) == _inline_oracle(
            mu, sigma, onset,
        )


class TestLatencyBandTausShape:

    def test_labels_are_day_suffixed_integers(self):
        bands = latency_band_taus(math.log(20.0), 1.0, 3.0)
        for tau, label in bands:
            assert isinstance(tau, int)
            assert label == f'{tau}d'

    def test_taus_are_floored_at_one(self):
        # Tiny lag → raw < 1 → floored to 1.
        bands = latency_band_taus(math.log(0.3), 0.1, 0.0)
        assert all(tau >= 1 for tau, _ in bands)

    def test_taus_non_decreasing(self):
        # inv_cdf is monotone in q, so insertion order is ascending tau.
        bands = latency_band_taus(math.log(20.0), 1.0, 3.0)
        taus = [tau for tau, _ in bands]
        assert taus == sorted(taus)

    def test_deduplicated_by_tau(self):
        # Small sigma collapses the three quantiles toward one integer.
        bands = latency_band_taus(math.log(2.0), 0.05, 0.0)
        taus = [tau for tau, _ in bands]
        assert len(taus) == len(set(taus))


class TestLatencyBandTausNotClampedToSaturation:
    """The accessor returns the derived tau unconditionally; deciding a
    band is unavailable because it exceeds saturation is the date
    reducer's job, not the accessor's (73q §"Latency-band tau accessor"
    / field contract)."""

    def test_band_tau_above_a_given_saturation_is_still_returned(self):
        # Long-lag distribution whose 0.75 band tau far exceeds a small
        # saturation cap. The accessor takes no saturation argument and
        # must not clamp.
        mu, sigma, onset = math.log(100.0), 1.2, 7.0
        bands = latency_band_taus(mu, sigma, onset)
        max_tau = max(tau for tau, _ in bands)
        small_saturation = 30
        assert max_tau > small_saturation  # non-vacuous
        # Same call, no saturation knob — value is intact.
        assert latency_band_taus(mu, sigma, onset) == bands
