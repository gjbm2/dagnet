"""Phase 2 (73q) — layer-helper extraction.

The completeness → layer rule and its thresholds are lifted out of the
legacy ``forecast_application.annotate_data_point`` surface (deleted in
73q Phase 7) into a non-legacy projection-bundle helper that both
reducers and any future consumer share.

These tests pin the contract (73q §"Layer"):

    c >= 0.95           -> 'mature'
    1e-9 < c < 0.95     -> 'forecast'
    c <= 1e-9           -> 'evidence'

and prove the extracted helper classifies identically to the legacy
``annotate_data_point`` it replaces, so no threshold drift enters at the
extraction.
"""

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from runner.cf_projection_bundle import (
    completeness_to_layer,
    COMPLETENESS_EPSILON,
    MATURITY_THRESHOLD,
)
from runner.forecast_application import annotate_data_point
from runner.forecast_application import (
    COMPLETENESS_EPSILON as FA_COMPLETENESS_EPSILON,
)


class TestLayerHelperConstants:

    def test_completeness_epsilon_value(self):
        assert COMPLETENESS_EPSILON == 1e-9

    def test_maturity_threshold_value(self):
        assert MATURITY_THRESHOLD == 0.95

    def test_forecast_application_reexports_same_epsilon(self):
        # The legacy module must keep exporting the constant (the
        # existing test_forecast_application suite imports it) and it
        # must be the one canonical value, not a second copy that can
        # drift.
        assert FA_COMPLETENESS_EPSILON == COMPLETENESS_EPSILON


class TestLayerHelperRule:

    def test_mature_at_and_above_threshold(self):
        assert completeness_to_layer(0.95) == 'mature'
        assert completeness_to_layer(0.951) == 'mature'
        assert completeness_to_layer(1.0) == 'mature'

    def test_forecast_strictly_between_epsilon_and_threshold(self):
        assert completeness_to_layer(0.5) == 'forecast'
        assert completeness_to_layer(0.95 - 1e-6) == 'forecast'
        assert completeness_to_layer(COMPLETENESS_EPSILON * 10) == 'forecast'

    def test_evidence_at_and_below_epsilon(self):
        # Rule is strict `c > EPSILON`, so EPSILON itself is 'evidence'.
        assert completeness_to_layer(COMPLETENESS_EPSILON) == 'evidence'
        assert completeness_to_layer(0.0) == 'evidence'

    def test_just_above_epsilon_is_forecast(self):
        assert completeness_to_layer(COMPLETENESS_EPSILON * 1.0001) == 'forecast'

    def test_custom_maturity_threshold_honoured(self):
        # The existing annotate_data_point caller passes a maturity
        # threshold; the helper must honour it rather than hardcode 0.95.
        assert completeness_to_layer(0.9, maturity_threshold=0.8) == 'mature'
        assert completeness_to_layer(0.9, maturity_threshold=0.95) == 'forecast'


class TestEquivalenceWithLegacyAnnotateDataPoint:
    """The extracted helper must classify identically to the legacy
    ``annotate_data_point`` for the completeness value that function
    derives. This is the anti-drift guard the extraction owes."""

    # mu = ln(5), sigma = 0.8, onset = 1 — a typical edge (mirrors the
    # existing test_forecast_application fixture).
    MU = math.log(5.0)
    SIGMA = 0.8
    ONSET = 1.0

    @pytest.mark.parametrize('age', [0, 1, 3, 8, 20, 60, 200])
    def test_layer_matches_annotate_data_point(self, age):
        ann = annotate_data_point(
            anchor_day='2025-12-01',
            retrieved_at_date=(
                '2025-12-01'
                if age == 0
                else f'2025-12-{1 + age:02d}'
                if 1 + age <= 31
                else '2026-03-01'
            ),
            y=10.0,
            x=100.0,
            mu=self.MU,
            sigma=self.SIGMA,
            onset_delta_days=self.ONSET,
            forecast_mean=0.2,
        )
        assert ann.layer == completeness_to_layer(ann.completeness)

    def test_all_three_layers_are_reachable_via_annotate(self):
        # Make sure the equivalence test above is non-vacuous: drive
        # annotate_data_point into each of the three regimes directly by
        # choosing completeness via age.
        layers = set()
        for age in [0, 5, 365]:
            ann = annotate_data_point(
                anchor_day='2025-12-01',
                retrieved_at_date='2025-12-01' if age == 0 else (
                    '2025-12-06' if age == 5 else '2026-12-01'
                ),
                y=10.0,
                x=100.0,
                mu=self.MU,
                sigma=self.SIGMA,
                onset_delta_days=self.ONSET,
                forecast_mean=0.2,
            )
            layers.add(ann.layer)
        assert layers == {'evidence', 'forecast', 'mature'}
