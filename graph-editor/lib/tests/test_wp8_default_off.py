"""WP8 default-off regression test (doc 73b Stage 0 binding deliverable).

Doc 73b §8 Stage 0 names this file as the binding regression that must be
green before Stage 2 begins. It pins the WP8 (direct-`cohort()` rate
conditioning) admission contract: WP8 is structurally default-off
across the standard fetch pipeline, and remains off after Stage 2 makes
`alpha_beta_query_scoped = False` uniform for analytic edges.

Stage 2's resolver changes remove today's implicit suppression of the
WP8 path (the analytic `alpha_beta_query_scoped == True` discriminator
that currently masks direct-cohort attempts). Without the hardcoded
default-off guard verified here, ordinary post-Stage-2 runs could
silently exercise WP8 and corrupt the acceptance baseline. See doc 60
WP8 (deferred, flagged) and the §8 Stage 0 paragraph in
docs/current/project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md.

Assertions:
- `should_enable_direct_cohort_p_conditioning` returns False for every
  combination of `is_window` × `is_multi_hop`.
- `build_prepared_runtime_bundle`'s `p_conditioning_direct_cohort`
  parameter defaults to False at the API surface.
- A representative analytic-source bundle build (post-Stage-2 forced
  state: source='analytic' with `alpha_beta_query_scoped` patched to
  False) produces a diagnostic in which the WP8 path is not engaged:
  `p_conditioning_evidence.source != 'direct_cohort_exact_subject'`,
  `p_conditioning_evidence.temporal_family != 'cohort'`, and the
  `direct_cohort_enabled` key is absent from the diagnostic.
- The `cohort_forecast_v3` runtime-bundle build site holds
  `_direct_cohort_p_conditioning = False` as a hardcoded literal so
  refactors cannot silently flip it.
"""

import inspect
import os
import re
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_wp8_admission_hook_returns_false_for_all_inputs():
    """The admission hook is hardcoded off; pin it for every input combo."""
    from runner.forecast_runtime import should_enable_direct_cohort_p_conditioning

    for is_window in (True, False):
        for is_multi_hop in (True, False):
            assert should_enable_direct_cohort_p_conditioning(
                is_window=is_window,
                is_multi_hop=is_multi_hop,
            ) is False, (
                f"WP8 admission hook returned True for "
                f"is_window={is_window} is_multi_hop={is_multi_hop}; "
                f"WP8 must remain default-off until explicit admission "
                f"rules land."
            )


def test_wp8_runtime_bundle_parameter_default_is_false():
    """The bundle-build entry point defaults the WP8 flag to False."""
    from runner.forecast_runtime import build_prepared_runtime_bundle

    sig = inspect.signature(build_prepared_runtime_bundle)
    assert 'p_conditioning_direct_cohort' in sig.parameters
    param = sig.parameters['p_conditioning_direct_cohort']
    assert param.default is False, (
        "build_prepared_runtime_bundle's p_conditioning_direct_cohort "
        "default must be False so the standard pipeline cannot accidentally "
        "engage WP8 when callers omit the flag."
    )


def test_wp8_diagnostic_off_under_default_bundle_build():
    """A default-args bundle build produces a non-WP8 diagnostic."""
    from runner.forecast_runtime import (
        build_prepared_runtime_bundle,
        serialise_runtime_bundle,
    )

    bundle = build_prepared_runtime_bundle(
        mode='cohort',
        query_from_node='X',
        query_to_node='Y',
        anchor_node_id='A',
        is_multi_hop=False,
        numerator_representation='factorised',
    )
    diag = serialise_runtime_bundle(bundle)

    assert diag is not None
    pce = diag['p_conditioning_evidence']
    assert pce['temporal_family'] != 'cohort', (
        f"Default bundle build must not select cohort temporal family; "
        f"got {pce['temporal_family']!r}. WP8 admission requires explicit "
        f"opt-in that is currently deferred."
    )
    assert pce['source'] != 'direct_cohort_exact_subject', (
        f"Default bundle build must not declare direct-cohort source; "
        f"got {pce['source']!r}."
    )
    assert 'direct_cohort_enabled' not in pce, (
        "direct_cohort_enabled must remain absent from the runtime-bundle "
        "diagnostic until WP8 lands."
    )


def test_wp8_off_for_post_stage_2_analytic_with_query_scoped_false():
    """Post-Stage-2 analytic edges (alpha_beta_query_scoped=False) still default
    to the non-WP8 path.

    Stage 2 changes ResolvedModelParams.alpha_beta_query_scoped so analytic
    edges no longer mask the WP8 admission decision via that discriminator.
    This test forces the post-Stage-2 state today (analytic source +
    `alpha_beta_query_scoped` patched to False) and asserts the bundle
    build still produces a WP8-off diagnostic.
    """
    from runner.forecast_runtime import (
        build_prepared_runtime_bundle,
        serialise_runtime_bundle,
    )
    from runner.model_resolver import ResolvedModelParams, ResolvedLatency

    resolved = ResolvedModelParams(
        p_mean=0.3, p_sd=0.05,
        alpha=30.0, beta=70.0,
        alpha_pred=30.0, beta_pred=70.0,
        n_effective=100.0,
        edge_latency=ResolvedLatency(
            mu=2.0, sigma=0.5, onset_delta_days=0.0,
            mu_sd=0.1, sigma_sd=0.05,
        ),
        source='analytic',
    )

    with patch.object(
        ResolvedModelParams,
        'alpha_beta_query_scoped',
        new=property(lambda self: False),
    ):
        assert resolved.alpha_beta_query_scoped is False

        bundle = build_prepared_runtime_bundle(
            mode='cohort',
            query_from_node='X',
            query_to_node='Y',
            anchor_node_id='A',
            is_multi_hop=False,
            numerator_representation='factorised',
            resolved_params=resolved,
        )

    diag = serialise_runtime_bundle(bundle)
    assert diag is not None
    pce = diag['p_conditioning_evidence']
    assert pce['temporal_family'] != 'cohort'
    assert pce['source'] != 'direct_cohort_exact_subject'
    assert 'direct_cohort_enabled' not in pce
    assert diag.get('resolved_source') == 'analytic'


def test_wp8_cohort_forecast_v3_call_site_hardcodes_false():
    """The cohort_forecast_v3 bundle-build site holds the WP8 flag at False.

    A literal-source assertion guards against refactors that would
    silently make the flag flow from a runtime input.
    """
    cf3_path = os.path.join(
        os.path.dirname(__file__),
        '..',
        'runner',
        'cohort_forecast_v3.py',
    )
    with open(cf3_path, 'r') as f:
        src = f.read()

    assert re.search(
        r'_direct_cohort_p_conditioning\s*=\s*False',
        src,
    ), (
        "cohort_forecast_v3.py must hold "
        "_direct_cohort_p_conditioning = False as a literal at the "
        "runtime-bundle build site so WP8 cannot be engaged through "
        "this entry point."
    )
    assert not re.search(
        r'_direct_cohort_p_conditioning\s*=\s*True',
        src,
    ), (
        "cohort_forecast_v3.py must not contain a literal "
        "_direct_cohort_p_conditioning = True assignment; WP8 is "
        "structurally deferred until the explicit admission rules land."
    )
