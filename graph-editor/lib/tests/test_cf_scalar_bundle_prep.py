"""73q Phase 5e Step B atom 2 — scalar-only bundle prep with mc_draws override.

The CF endpoint (``_handle_conditioned_forecast_impl``) becomes a scalar-only
callsite over its own bundle so it can independently pick the draw count
S. The cohort_maturity tau reducer continues to use the request-wide
default; only the CF endpoint reads through the smaller-S path.

This suite pins the two contracts the new helper adds:

  - the ``mc_draws_override`` parameter, when set, propagates into the
    runtime construction so the composed subject span is sized at the
    override (not the default 1000);
  - the override is request-scoped — outside the helper call, the global
    ``current_settings().mc_draws`` is unchanged.

The end-to-end behavioural validation that the CF endpoint's per-edge
scalars are unchanged under the lower draw count is the outside-in
parity suite (``test_cohort_factorised_outside_in.py``) — exercised
when Step B atom 3 wires the helper into ``_handle_conditioned_forecast_impl``.
"""

import dataclasses
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import build_cf_projection_bundle  # noqa: E402
from runner.forecasting_settings import (  # noqa: E402
    current_settings,
    use_request_settings,
)

from test_cf_projection_bundle import (  # noqa: E402
    _LAT,
    _COMPUTE_EXTENT,
    _candidates_for,
    _ADMITTED_ANCHORS,
)
from test_cohort_maturity_v3_contract import (  # noqa: E402
    _build_single_edge_graph,
    _build_synth_frames,
)
from datetime import date


def _build_inline_bundle():
    """Direct ``build_cf_projection_bundle`` call (same fixture as
    ``test_cf_projection_bundle._build_bundle``) for low-overhead
    coverage of the runtime draw-count mechanism without the
    ``prepare_forecast_subject_group`` perimeter."""
    graph = _build_single_edge_graph(latency_parameter=True, **_LAT)
    frames, anchor_from, sweep_to = _build_synth_frames(
        anchor_to=date(2026, 3, 10), sweep_days=36, n_cohorts=4,
    )
    return build_cf_projection_bundle(
        frames=frames,
        graph=graph,
        target_edge_id='e1',
        query_from_node='node-a',
        query_to_node='node-b',
        anchor_from='2026-03-01',
        anchor_to=anchor_from,
        sweep_to=sweep_to,
        is_window=True,
        compute_extent=_COMPUTE_EXTENT,
        evidence_candidates=_candidates_for(_ADMITTED_ANCHORS),
        scenario_id='scalar-bundle-prep-test',
    )


class TestMcDrawsOverrideMechanism:
    """The override mechanism — ``dataclasses.replace`` on the settings
    + ``use_request_settings`` — propagates into the runtime construction
    so the composed subject span's per-draw arrays carry the override
    count, not the request-wide default."""

    def test_runtime_draws_default_to_request_wide_setting(self):
        bundle = _build_inline_bundle()
        composed = bundle.runtime.composed_subject
        assert composed is not None, "fixture must produce a composed subject"
        # The default `mc_draws` from ForecastingSettings drives runtime shape.
        assert composed.span_p_draws.shape == (int(current_settings().mc_draws),)

    def test_runtime_draws_follow_use_request_settings_override(self):
        overridden = dataclasses.replace(current_settings(), mc_draws=128.0)
        with use_request_settings(overridden):
            bundle = _build_inline_bundle()
        composed = bundle.runtime.composed_subject
        assert composed is not None
        # The override propagates: the composed span carries 128 draws,
        # not the request-wide default. This is the load-bearing assertion — if it fails,
        # the helper's mc_draws_override is functionally inert.
        assert composed.span_p_draws.shape == (128,)

    def test_override_is_request_scoped_and_does_not_leak(self):
        """After the ``with`` block exits, the global default returns —
        the next bundle built without an override sees the default S again."""
        baseline = float(current_settings().mc_draws)
        with use_request_settings(
            dataclasses.replace(current_settings(), mc_draws=64.0)
        ):
            inside = float(current_settings().mc_draws)
        outside = float(current_settings().mc_draws)
        assert inside == 64.0
        assert outside == baseline


class TestScalarBundleHelperShape:
    """The ``prepare_cf_scalar_bundle`` helper is a thin wrapper —
    when ``mc_draws_override`` is None it must behave exactly as
    ``prepare_cf_projection_bundle`` with the scalar-irrelevant flags
    pinned (``use_prepared_resolved=False``, ``show_model_curve=False``)
    and ``include_epistemic_overlay`` exposed as the gauge callsite
    needs the unconditioned dial surface (73q Phase 5a). When set it
    routes through ``use_request_settings``. The signature contract is
    the only thing this suite checks at the unit-test layer; the
    end-to-end mc_draws behaviour is exercised through the outside-in
    parity suite once Step B atom 3 wires it in."""

    def test_helper_signature_carries_optional_override(self):
        import inspect

        from runner.cf_analysis import prepare_cf_scalar_bundle

        sig = inspect.signature(prepare_cf_scalar_bundle)
        assert 'mc_draws_override' in sig.parameters
        param = sig.parameters['mc_draws_override']
        # Defaulting to None means "use whatever the caller's request
        # settings already supply" — the helper must not silently
        # impose a draw count.
        assert param.default is None
        # Must be keyword-only (matches the sibling
        # `prepare_cf_projection_bundle` discipline).
        assert param.kind == inspect.Parameter.KEYWORD_ONLY

    def test_helper_exposes_epistemic_overlay_flag_defaulting_false(self):
        """73q Phase 5a opens the helper to the surprise-gauge callsite,
        which needs the unconditioned epistemic overlay as the dial side
        of its two-distribution z-score. The flag defaults False (the
        CF endpoint / param-pack callsite leaves it off) so existing
        callers' bundle build cost is unchanged unless they opt in."""
        import inspect

        from runner.cf_analysis import prepare_cf_scalar_bundle

        sig = inspect.signature(prepare_cf_scalar_bundle)
        assert 'include_epistemic_overlay' in sig.parameters
        param = sig.parameters['include_epistemic_overlay']
        assert param.default is False
        assert param.kind == inspect.Parameter.KEYWORD_ONLY

    def test_helper_hardcodes_scalar_irrelevant_flags(self):
        """The CF endpoint never needs the prepared-resolved cohort_maturity
        reuse path or the optional model curve. The helper must pin these
        so callsites can't accidentally turn them on and rebuild a
        cohort_maturity-shaped bundle by mistake."""
        import inspect

        from runner.cf_analysis import prepare_cf_scalar_bundle

        sig = inspect.signature(prepare_cf_scalar_bundle)
        for forbidden in (
            'use_prepared_resolved',
            'show_model_curve',
        ):
            assert forbidden not in sig.parameters, (
                f"prepare_cf_scalar_bundle must not expose `{forbidden}` —"
                f" it's hardcoded to False for the scalar-only callsite"
            )
