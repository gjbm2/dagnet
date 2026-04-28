"""
Carrier-read via shared resolver — doc 73b §6.5 / Stage 4(d).

Pins the contract that carriers MUST read the promoted-baseline model
probability through `resolve_model_params`, never the L5 current-answer
scalar `p.mean`.

The named sentinel: a graph where `p.mean` and the promoted source
**disagree** — carrier behaviour follows the promoted source, not
`p.mean`. Without this, a stale or query-overtyped `p.mean` would
silently poison every carrier reach computation downstream.

Sibling concerns:
- `_extract_probability` in `graph_builder.py` and the conditional read
  in `path_runner.py` are now routed through `resolve_model_params`
  first (Stage 4(d) §6.5 reroute). They fall back to a logged
  `p.get('mean')` read via `_warn_legacy_pmean_carrier` only via the
  documented §3.8 path. The carrier defect originally identified by
  §6.5 is `_resolve_edge_p`; the same reroute pattern was extended to
  the path-analyzer carriers in Stage 4(d).
- The `_warn_legacy_pmean_carrier` fallback exists as the §3.8
  documented transitional degrade for pre-Stage 4 fixtures with no
  promoted-baseline source. It is itself a sentinel: when it fires,
  the offending edge id is surfaced via a WARNING log so violators are
  visible.
"""

import logging
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.forecast_state import _resolve_edge_p, _LEGACY_PMEAN_CARRIER_WARNED


def _reset_warn_dedup():
    """Tests share module-level dedup state; reset between cases."""
    _LEGACY_PMEAN_CARRIER_WARNED.clear()


class TestCarrierReadViaSharedResolver:
    """Doc 73b §6.5 sentinels for `_resolve_edge_p`."""

    def test_promoted_source_wins_when_p_mean_disagrees(self):
        """The named §6.5 sentinel: `p.mean` and the promoted source
        disagree, the carrier follows the promoted source.
        """
        _reset_warn_dedup()
        edge = {
            'id': 'edge-disagree',
            'p': {
                'mean': 0.50,                  # L5 current answer (would-be poison)
                'forecast': {'mean': 0.40},    # L2 promoted baseline
                'latency': {'mu': 2.0, 'sigma': 0.5},
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': 0.40, 'stdev': 0.05,
                                    'alpha': 40, 'beta': 60, 'n_effective': 100},
                    'latency': {'mu': 2.0, 'sigma': 0.5},
                }],
            },
        }
        # Carrier follows promoted source (0.40), not L5 p.mean (0.50).
        assert abs(_resolve_edge_p(edge) - 0.40) < 1e-9

    def test_promoted_source_wins_when_p_mean_disagrees_via_posterior(self):
        """Posterior-driven promoted source: the resolver computes
        p_mean from posterior alpha/beta; the carrier must follow that,
        not the L5 current-answer scalar.
        """
        _reset_warn_dedup()
        edge = {
            'id': 'edge-posterior-disagree',
            'p': {
                'mean': 0.20,                                # L5 (poisoned by overtype)
                'posterior': {'alpha': 60, 'beta': 40},      # → p_mean=0.6
                'forecast': {'mean': 0.20},
                'latency': {'mu': 2.0, 'sigma': 0.5},
            },
        }
        assert abs(_resolve_edge_p(edge) - 0.60) < 1e-9

    def test_bayesian_gated_wins_under_best_available(self):
        """Selector cascade: bayesian (gated) wins over analytic;
        carrier must reflect the selected source's value.
        """
        _reset_warn_dedup()
        edge = {
            'id': 'edge-bayesian-gated',
            'p': {
                'mean': 0.30,                                # ignored
                'posterior': {'alpha': 70, 'beta': 30},      # p_mean = 0.70
                'forecast': {},
                'latency': {'mu': 2.0, 'sigma': 0.5},
                'model_vars': [
                    {'source': 'analytic',
                     'probability': {'mean': 0.40, 'alpha': 40, 'beta': 60,
                                     'n_effective': 100},
                     'latency': {'mu': 3.0, 'sigma': 0.6}},
                    {'source': 'bayesian',
                     'probability': {'mean': 0.70},
                     'latency': {'mu': 2.4, 'sigma': 0.5},
                     'quality': {'gate_passed': True}},
                ],
            },
        }
        assert abs(_resolve_edge_p(edge) - 0.70) < 1e-9

    def test_legacy_pmean_fallback_fires_with_warning_when_no_promoted_source(
        self, caplog
    ):
        """Doc 73b §3.8 fallback register: when the resolver returns 0
        (no posterior, no model_vars, no forecast.mean) but legacy
        `p.mean` is set, the carrier falls back AND emits a WARNING log
        so the offending edge surfaces.
        """
        _reset_warn_dedup()
        edge = {
            'id': 'edge-legacy-fallback',
            'p': {
                'mean': 0.42,
                # No model_vars, no posterior, no forecast.mean.
            },
        }
        with caplog.at_level(logging.WARNING, logger='runner.forecast_state'):
            result = _resolve_edge_p(edge)
        assert abs(result - 0.42) < 1e-9
        # Sentinel: edge id appears in the warning so violators surface.
        warned = [r for r in caplog.records if 'edge-legacy-fallback' in r.message
                  or "'edge-legacy-fallback'" in r.getMessage()]
        assert warned, (
            'Expected a WARNING naming the offending edge id; got: '
            + repr([r.getMessage() for r in caplog.records])
        )

    def test_zero_p_mean_with_no_promoted_source_returns_zero(self):
        """Empty edge: resolver returns 0, no legacy fallback, no warn.
        """
        _reset_warn_dedup()
        edge = {'id': 'edge-empty', 'p': {}}
        assert _resolve_edge_p(edge) == 0.0

    def test_p_mean_zero_with_promoted_source_uses_promoted(self):
        """`p.mean = 0` (e.g. provisionally cleared) but the promoted
        source has a non-zero value — the carrier follows the source,
        ignoring the zero current-answer scalar.
        """
        _reset_warn_dedup()
        edge = {
            'id': 'edge-pmean-zero',
            'p': {
                'mean': 0.0,
                'forecast': {'mean': 0.45},
                'latency': {'mu': 2.0, 'sigma': 0.5},
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': 0.45, 'alpha': 45, 'beta': 55,
                                    'n_effective': 100},
                    'latency': {'mu': 2.0, 'sigma': 0.5},
                }],
            },
        }
        assert abs(_resolve_edge_p(edge) - 0.45) < 1e-9
