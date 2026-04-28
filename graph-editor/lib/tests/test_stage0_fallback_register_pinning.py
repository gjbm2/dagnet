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

5. Scenario param-only analysis transport — invalid for analysis
   execution. Stage 4(a) delivers the lossless per-scenario
   request-graph build. Pinned via plan reference (the analysis-prep
   code path acknowledges the deficit pending Stage 4(a)).

6. Carrier weak-prior / empirical fallback paths in
   ``forecast_state.py`` — audit at Stage 4(d). Pinned by the
   consumer-rule grep test in ``test_stage0_be_contract_pinning.py``.

This file collects the entries 2 and 5 pinning tests. Register entry 3
(``analytic_degraded`` / query-scoped-posterior CF mode) has been retired:
the forecast stack now has one sweep path and no degraded latency-row branch.
"""

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

GRAPH_EDITOR_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', '..')
)
LIB_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'lib')
DOCS_ROOT = os.path.normpath(
    os.path.join(GRAPH_EDITOR_ROOT, '..', 'docs')
)
PLAN_PATH = os.path.join(
    DOCS_ROOT, 'current', 'project-bayes',
    '73b-be-topo-removal-and-forecast-state-separation-plan.md',
)


# Doc 73f F15 (28-Apr-26): the old `_KAPPA_POINT_ESTIMATE_DEGRADED = 200.0`
# silent fallback was removed. The two pinning tests that asserted on
# its presence and provenance label are gone with it. The replacement
# behaviour — weak Jeffreys-style kappa=2 prior for the no-evidence
# case, and a `ValueError` on the binding-broken case — is pinned by
# the resolver's own unit tests, not by source-text grep here.


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
