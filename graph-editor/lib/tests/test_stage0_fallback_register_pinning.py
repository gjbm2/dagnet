"""Stage 0 fallback-register pinning tests (doc 73b §3.8, §8).

§8: "The fallback register in §3.8 is also pinned here: every
fallback/degraded path is either registered with provenance and tests
or removed."

§3.8 register entries (4 is withdrawn):

1. ``model_resolver.py`` D20 evidence-count prior synthesis — invalid.
   Pinned by the layer-isolation test in
   ``test_stage0_be_contract_pinning.py`` (xfail until Stage 2).

2. ``model_resolver.py`` fixed point-estimate prior strength
   (``_KAPPA_FALLBACK = 200.0``) — provisional. Pinned here as a
   literal-source assertion so Stage 2 has a one-line target when
   renaming/diagnosing the fallback.

3. ``analytic_degraded`` / query-scoped-posterior CF mode — migration
   guard only. The projection guard at
   ``conditionedForecastService.ts:243-262`` (``isQueryScopedPosteriorFallback``)
   suppresses horizon-row evidence_n/k writeback. Pinned here so the
   guard cannot silently disappear before Stage 2/4 retire the mode.

5. Scenario param-only analysis transport — invalid for analysis
   execution. Stage 4(a) delivers the lossless per-scenario
   request-graph build. Pinned via plan reference (the analysis-prep
   code path acknowledges the deficit pending Stage 4(a)).

6. Carrier weak-prior / empirical fallback paths in
   ``forecast_state.py`` — audit at Stage 4(d). Pinned by the
   consumer-rule grep test in ``test_stage0_be_contract_pinning.py``.

This file collects the entries 2, 3, 5 pinning tests.
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

GRAPH_EDITOR_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', '..')
)
LIB_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'lib')
SRC_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'src')
DOCS_ROOT = os.path.normpath(
    os.path.join(GRAPH_EDITOR_ROOT, '..', 'docs')
)
PLAN_PATH = os.path.join(
    DOCS_ROOT, 'current', 'project-bayes',
    '73b-be-topo-removal-and-forecast-state-separation-plan.md',
)


def test_register_entry_2_kappa_fallback_literal_present():
    """Register entry 2 (provisional): the renamed kappa point-estimate
    prior-strength literal must remain in ``model_resolver.py``. Stage 2
    renamed `_KAPPA_FALLBACK` to `_KAPPA_POINT_ESTIMATE_DEGRADED` and
    attaches the provenance label below.
    """
    resolver_path = os.path.join(LIB_ROOT, 'runner', 'model_resolver.py')
    with open(resolver_path, 'r', encoding='utf-8') as f:
        src = f.read()

    assert re.search(r'_KAPPA_POINT_ESTIMATE_DEGRADED\s*=\s*200\.0', src), (
        "Register entry 2 expected the literal "
        "`_KAPPA_POINT_ESTIMATE_DEGRADED = 200.0` in model_resolver.py."
    )


def test_register_entry_2_kappa_fallback_carries_provenance_label():
    """The kappa fallback records ``analytic_point_estimate_degraded``
    on the resolver source so callers can detect the degraded path via
    diagnostics. Pinned via grep on the resolver source.
    """
    resolver_path = os.path.join(LIB_ROOT, 'runner', 'model_resolver.py')
    with open(resolver_path, 'r', encoding='utf-8') as f:
        src = f.read()

    assert re.search(r'analytic_point_estimate_degraded', src), (
        "Register entry 2: the kappa fallback must record "
        "`analytic_point_estimate_degraded` (or named successor) on the "
        "resolver source so callers can detect it via diagnostics."
    )


def test_register_entry_3_analytic_degraded_projection_guard_present():
    """Register entry 3: the CF apply path's projection guard
    suppresses horizon-row ``evidence_n/k`` writeback when
    ``cf_mode == 'analytic_degraded'`` AND
    ``cf_reason == 'query_scoped_posterior'`` OR
    ``conditioning.skip_reason == 'source_query_scoped'``. Pinned so
    the guard cannot disappear before Stage 2/4 retire the mode.
    """
    cf_path = os.path.join(
        SRC_ROOT, 'services', 'conditionedForecastService.ts',
    )
    with open(cf_path, 'r', encoding='utf-8') as f:
        src = f.read()

    assert re.search(
        r'isQueryScopedPosteriorFallback', src,
    ), (
        "Register entry 3: the `isQueryScopedPosteriorFallback` guard "
        "must remain in conditionedForecastService.ts until Stage 2/4 "
        "retire the analytic_degraded mode."
    )
    assert re.search(
        r"cf_mode\s*===\s*['\"]analytic_degraded['\"]", src,
    ), (
        "Register entry 3: cf_mode === 'analytic_degraded' check must "
        "remain in the projection guard."
    )
    assert re.search(
        r"['\"]source_query_scoped['\"]", src,
    ), (
        "Register entry 3: the conditioning skip_reason "
        "'source_query_scoped' must remain referenced in the guard."
    )


def test_register_entry_3_emitter_present_in_runtime():
    """Register entry 3 (emit side): ``forecast_runtime.py`` must still
    classify some resolved edges as ``('analytic_degraded',
    'query_scoped_posterior')`` until Stage 2/4 remove the mode.
    Pinned via grep — Stage 2/4 retire both the emitter and the
    consumer-side guard in lockstep.
    """
    rt_path = os.path.join(LIB_ROOT, 'runner', 'forecast_runtime.py')
    with open(rt_path, 'r', encoding='utf-8') as f:
        src = f.read()

    assert re.search(
        r"return\s*\(\s*['\"]analytic_degraded['\"]\s*,\s*['\"]query_scoped_posterior['\"]\s*\)",
        src,
    ), (
        "Register entry 3 emitter: forecast_runtime.py must still "
        "produce `('analytic_degraded', 'query_scoped_posterior')` "
        "until Stage 2/4 retire the mode."
    )


def test_register_entry_5_param_only_analysis_transport_documented():
    """Register entry 5: scenario param-only transport is invalid for
    analysis execution. Stage 4(a) delivers the per-scenario
    request-graph build; doc 73a Stage 6 owns the CLI/FE parity gate.

    Pinned by checking that the §3.8 register entry text in the plan
    explicitly assigns Stage 4(a) ownership and references doc 73a
    Stage 6 as the parity-verification gate. This ensures the
    ownership boundary cannot drift silently in plan revisions.
    """
    with open(PLAN_PATH, 'r', encoding='utf-8') as f:
        plan = f.read()

    fallback_section = plan
    assert '5. Scenario param-only analysis transport' in fallback_section, (
        'Register entry 5 missing from §3.8 ledger.'
    )
    # The entry text must name Stage 4(a) as the deliverer and doc 73a
    # Stage 6 as the parity-verification owner (see §11.2 + §3.8).
    assert re.search(
        r'5\.\s*Scenario param-only analysis transport.*?Stage 4\(a\)',
        fallback_section,
        re.DOTALL,
    ), (
        'Register entry 5 must assign Stage 4(a) as the deliverer of '
        'the lossless per-scenario request-graph build.'
    )
    assert re.search(
        r'5\.\s*Scenario param-only analysis transport.*?[Dd]oc\s*73a\s*Stage\s*6',
        fallback_section,
        re.DOTALL,
    ), (
        'Register entry 5 must reference doc 73a Stage 6 as the '
        'CLI/FE parity-verification owner.'
    )


def test_register_entry_4_remains_withdrawn():
    """Register entry 4 (context-stripping posterior-slice fallback) is
    explicitly withdrawn. Pin the withdrawal so a future revision
    cannot accidentally re-introduce relegislation of the existing
    slice-resolution stack.
    """
    with open(PLAN_PATH, 'r', encoding='utf-8') as f:
        plan = f.read()

    assert re.search(
        r'4\.\s*~~Context-stripping posterior-slice fallback\.~~\s*\*\*Withdrawn\.\*\*',
        plan,
    ), (
        'Register entry 4 must remain marked withdrawn so the '
        'existing slice-resolution stack '
        '(`resolvePosteriorSlice` / `meceSliceService` / '
        '`dimensionalReductionService`) is not re-legislated.'
    )
