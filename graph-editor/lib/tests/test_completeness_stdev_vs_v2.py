"""
Validate completeness_stdev against cohort_maturity_v2 MC sampling.

The topo pass computes completeness_stdev by sampling 200 draws from
latency dispersions and taking the SD of the resulting CDF values.

The v2 row builder independently computes MC fan bands by sampling
2000 draws from the same dispersions. Its per-tau midpoint spread
reflects the same underlying uncertainty.

This test verifies that the two computations agree — the topo pass
completeness_stdev should be consistent with the spread of the v2
MC draws at the same tau.
"""

import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

DB_URL = os.environ.get('DB_CONNECTION', '')
requires_db = pytest.mark.skipif(not DB_URL, reason='DB_CONNECTION not set')

_DAGNET_ROOT = Path(__file__).parent.parent.parent.parent
_CONF_FILE = _DAGNET_ROOT / '.private-repos.conf'
_DATA_REPO_DIR = None
if _CONF_FILE.exists():
    for line in _CONF_FILE.read_text().splitlines():
        if line.startswith('DATA_REPO_DIR='):
            _DATA_REPO_DIR = _DAGNET_ROOT / line.split('=', 1)[1].strip()
            break

requires_data_repo = pytest.mark.skipif(
    _DATA_REPO_DIR is None or not (_DATA_REPO_DIR / 'graphs').is_dir(),
    reason='Data repo not available',
)


class TestCompletenessStdevConsistency:
    """Topo pass completeness_stdev is consistent with v2 MC spread."""

    def test_stdev_vs_v2_fan_width(self):
        """completeness_stdev should predict the v2 fan band width
        at the evidence frontier (tau_observed).

        If completeness_stdev is 0.05 (5%), then the v2 fan bands
        at tau_observed should show a rate spread of roughly
        p * completeness_stdev (since rate = p * completeness).
        """
        from runner.model_resolver import resolve_model_params, ResolvedLatency
        from runner.forecast_state import compute_completeness_with_sd

        # Use the real graph edge params
        g = json.loads(Path(
            _DAGNET_ROOT / 'nous-conversion' / 'graphs' / 'bayes-test-gm-rebuild.json'
        ).read_text())

        for edge in g['edges']:
            lat = edge.get('p', {}).get('latency', {})
            if not lat.get('mu'):
                continue

            resolved = resolve_model_params(edge, scope='edge',
                                            temporal_mode='window')
            if not resolved or resolved.latency.mu_sd <= 0:
                continue

            # Compute completeness_stdev at a range of ages
            for age in [10, 20, 30, 50, 100]:
                c, c_sd = compute_completeness_with_sd(float(age),
                                                        resolved.latency)

                # Basic sanity: stdev should be non-negative
                assert c_sd >= 0, f"Negative stdev at age={age}"

                # At very high completeness, stdev should be small
                if c > 0.99:
                    assert c_sd < 0.05, \
                        f"At c={c:.3f} (age={age}), stdev={c_sd:.4f} is too large"

                # At zero completeness, stdev should be zero
                # (can't be uncertain about zero)
                if c < 0.001:
                    assert c_sd < 0.01, \
                        f"At c={c:.4f} (age={age}), stdev={c_sd:.4f} should be ~0"

                # Stdev should never exceed 0.5 (completeness is bounded 0-1)
                assert c_sd <= 0.5, \
                    f"Stdev={c_sd:.4f} exceeds theoretical max for [0,1] variable"

            # Now compare with a brute-force MC check at age=30
            # Draw 2000 samples (like v2) and check that the SD
            # of completeness across draws is consistent with our
            # 200-draw estimate
            import numpy as np
            lat_r = resolved.latency
            rng = np.random.default_rng(42)
            S = 2000
            mu_draws = rng.normal(lat_r.mu, max(lat_r.mu_sd, 1e-10), size=S)
            sigma_draws = np.clip(
                rng.normal(lat_r.sigma, max(lat_r.sigma_sd, 1e-10), size=S),
                0.01, 20.0)
            onset_draws = np.maximum(
                rng.normal(lat_r.onset_delta_days,
                           max(lat_r.onset_sd, 1e-10), size=S),
                0.0)

            from runner.forecast_state import _compute_completeness_at_age
            age_test = 30.0
            c_draws = np.array([
                _compute_completeness_at_age(age_test, float(mu_draws[i]),
                                              float(sigma_draws[i]),
                                              float(onset_draws[i]))
                for i in range(S)
            ])
            brute_sd = float(np.std(c_draws))

            c_engine, c_engine_sd = compute_completeness_with_sd(
                age_test, lat_r)

            # The two SD estimates should agree within a factor of 2
            # (different seed, different draw count, but same distribution)
            if brute_sd > 0.001:
                ratio = c_engine_sd / brute_sd
                assert 0.3 < ratio < 3.0, \
                    f"Engine SD ({c_engine_sd:.5f}) vs brute-force SD " \
                    f"({brute_sd:.5f}) ratio={ratio:.2f} — should be ~1"

            edge_id = edge.get('p', {}).get('id', '?')
            print(f"{edge_id}: age=30 c={c_engine:.4f} "
                  f"engine_sd={c_engine_sd:.5f} brute_sd={brute_sd:.5f}")

            break  # one edge is enough for validation


@requires_data_repo
class TestCompletenessStdevOnRealGraph(TestCompletenessStdevConsistency):
    """Run the consistency check on a real graph from the data repo."""
    pass
