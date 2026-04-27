# 64 — Forecast Assurance Overhaul

**Historical note (`27-Apr-26`)**: this note pre-dates the removal of the quick BE topo pass (24-Apr-26). References below to `topo-pass` tests, `test_be_topo_pass_parity.py`, and "bounded-analytic topo-pass contract" describe the system as it stood when the note was written. After 73b's BE topo removal there is no surviving topo-pass test surface to rewrite; the forecast-assurance design principles themselves remain applicable and are now realised through doc 73b's stage gates and outside-in CLI regressions. See [project-bayes/73b](73b-be-topo-removal-and-forecast-state-separation-plan.md) for the current BE surface.

**Date**: 22-Apr-26  
**Status**: Proposed active design note  
**Related**: `59-cohort-window-forecast-implementation-scheme.md`, `60-forecast-adaptation-programme.md`, `57-cf-eligibility-topological-degradation.md`, `55-surprise-gauge-rework.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `../codebase/STATS_SUBSYSTEMS.md`, `../codebase/TESTING_STANDARDS.md`  
**Audience**: engineers retiring `cohort_maturity` v1/v2 and reviewers deciding what assurance must replace parity scaffolding

---

## 1. Why this note exists

The forecast-adaptation workstream used parity against older
implementations as scaffolding. That was appropriate while the main risk
was "did the new path still match the old one closely enough that we can
switch callers over without breaking users?".

That is no longer the right question.

We are about to delete `cohort_maturity` v1 and v2. Once those are gone,
"does v3 match v2?" stops being a meaningful oracle. Worse, parity has
now shown its core limitation: it can tell us that two implementations
agree, but it cannot tell us that they are both answering the wrong
semantic question.

The replacement assurance model therefore has to be built from first
principles:

- the oracle must be the semantic contract, not the deleted
  implementation
- tests must be conceptually orthogonal, so one blind spot cannot hide
  behind another
- the primary units of assurance must be semantic roles and public
  consumer surfaces, not historical module names
- fixtures must be chosen to isolate phenomena, not to maximise reuse
- outside-in CLI coverage must remain, because users and agents call the
  tooling, not our private helpers

This note reviews the current forecasting assurance surface, classifies
what to keep and what to retire, and defines the post-parity target
suite.

---

## 2. Diagnosis of the current suite

The current suite contains good material, but it was assembled around a
migration rather than around a stable long-term assurance model. That
produces four structural weaknesses.

First, too much of the confidence story still comes from
implementation-to-implementation comparison. That was useful during the
cut-over, but it couples correctness to legacy behaviour and keeps dead
paths alive as test oracles.

Second, several tests are not orthogonal. Multiple files protect the
same migration seam, while other failure classes remain weakly covered:
cross-consumer semantic divergence, request-plumbing drift,
identifier-canonicalisation drift, and invariance under incidental graph
ordering.

Third, some current harnesses mix three jobs that should be separate:
data-health checks, semantic assertions, and historical expected-red
tracking. That makes failures noisy and classification blurry.

Fourth, a non-trivial part of the suite is still named or framed as
"RED", "parity", or "Phase X" even where the underlying contract is now
live. That is a maintainability problem in itself: stale framing makes
it harder to tell which tests are active gates, which are migration
records, and which are quarantined research assets.

The implication is not that the current suite is bad. The implication is
that it is still shaped like a refactor in flight. We now need it to be
shaped like the permanent semantic defence system for forecasting.

---

## 3. Principles for the replacement model

The long-term forecast assurance model should be governed by the
following rules.

### 3.1 The oracle is the semantic relation

The test should state an invariant such as:

- these two consumers must agree because they are projections of the same
  solve
- these two modes must diverge because the denominator population
  changes
- these two modes must collapse because the upstream segment is
  non-latent
- changing edge-list order must not change the answer
- changing display-only state must not trigger recompute

Those are durable truths. "Matches v2" is not.

### 3.2 Each family of failure gets its own instrument

We need distinct test families for:

- semantic contracts
- cross-consumer agreement
- metamorphic relations
- non-semantic invariance
- projection and authority boundaries
- public-tooling outside-in behaviour
- branch-death and dependency hygiene

No single family should be asked to do all of that.

### 3.3 Fixtures should be minimal and one-purpose

The primary fixture for a claim should be the smallest graph that makes
that claim non-vacuous. Reusing a large mixed-purpose graph as the
default oracle is how subtle semantic drift becomes hard to interpret.

### 3.4 Goldens are secondary, not primary

Frozen JSON baselines are useful for public response-shape regression and
for migration bookkeeping. They are poor primary semantic oracles for
forecasting because they silently bless whatever behaviour happened to be
captured.

### 3.5 Outside-in coverage remains mandatory

Forecasting bugs have repeatedly escaped local reasoning because the
tooling path, snapshot plumbing, or CLI-to-BE hand-off behaved
differently from the in-process tests. The long-term suite therefore
must include a small, stable outside-in layer using `analyse.sh`,
`param-pack.sh`, and the same synth graphs users and agents can inspect.

### 3.6 Every new forecast test needs an authoring receipt

Before writing or rewriting any forecast test, the engineer should write
a short prose receipt covering all of the following.

1. **Family** — which permanent family from section 5 this test belongs
   to.
2. **Bug or invariant** — the exact failure mode the test would catch.
3. **Oracle type** — blind semantic relation, cross-consumer agreement,
   temporary cut-over parity, public contract, invariance, or static
   branch-death check.
4. **Primary apparatus** — static inspection, Python integration,
   TypeScript integration, or CLI canary, with one sentence on why a
   lower-cost apparatus would be insufficient.
5. **Fixture class** — which semantic atom, topology matrix, projection
   fixture, or public-tooling fixture is appropriate, and why it is the
   smallest non-vacuous choice.
6. **Reality boundary** — what is real, what if anything is stubbed, and
   why that stub does not hide the class of bug under test.
7. **False-pass analysis** — how the test could still pass while the
   system is broken, and what closes that gap.
8. **Retirement linkage** — if this test exists to replace a parity-era
   asset, name the old asset and the condition under which it can be
   deleted.

This is how the note should be used alongside
`../codebase/TESTING_STANDARDS.md`. The receipt is not bureaucracy. It is
the mechanism that stops a developer from reaching for the wrong oracle,
the wrong fixture, or the wrong harness out of convenience.

### 3.7 Temporary cut-over parity is still mandatory

This note does **not** overrule the repo-wide rule in
`../codebase/TESTING_STANDARDS.md` that a working path being replaced
must receive a real-boundary parity test before cut-over.

The correct discipline is:

- **during replacement** — write the temporary parity test and make the
  new path match the old one closely enough to switch safely
- **before deleting the old path** — also land a permanent semantic test
  from the appropriate family in section 5
- **after the permanent semantic replacement is green** — delete the
  parity-era harness rather than accidentally promoting it into the
  long-term oracle

Parity is therefore still mandatory at the cut-over seam, but it is not
the permanent acceptance oracle for the live system after the cut-over
is complete.

---

## 4. Review of the current assurance surface

The current suite should be understood as four distinct asset classes.

There are also several peripheral but still relevant adjunct tests that
sit one level below the main semantic gate set. Examples include
`graph-editor/lib/tests/test_forecast_application.py`,
`graph-editor/lib/tests/test_forecasting_settings.py`,
`graph-editor/lib/tests/test_analysis_request_contract.py`,
`graph-editor/src/lib/__tests__/graphComputeClient.test.ts`,
`graph-editor/src/services/__tests__/windowCohortSemantics.paramPack.e2e.test.ts`,
`graph-editor/src/services/__tests__/sampleFileQueryFlow.e2e.test.ts`,
and `graph-editor/src/services/__tests__/cohortModeSimpleEdgeOverride.e2e.test.ts`.
They should remain in the suite, but they should be classified as
projection, request-plumbing, or settings contracts rather than as the
primary semantic oracle for the forecast engine itself.

### 4.1 Assets to keep as core long-term gates

These are already aligned with the permanent shape of the live system.

| Asset | Why it survives |
|---|---|
| `graph-editor/lib/tests/test_forecast_stack_dependencies.py` | Guards the post-cut-over boundary and prevents silent reintroduction of v1/v2 runtime imports. |
| `graph-editor/lib/tests/test_forecast_state_cohort.py` | Protects runtime-bundle behaviour, summary semantics, carrier behaviour, and order invariance at engine level. |
| `graph-editor/lib/tests/test_cf_query_scoped_degradation.py` | Encodes the permanent doc 57 degraded/unavailable contract. |
| `graph-editor/lib/tests/test_non_latency_rows.py` | Protects the lagless / degraded row-builder contract directly. |
| `graph-editor/lib/tests/test_daily_conversions.py` | Covers the pure daily-conversions derivation. |
| `graph-editor/lib/tests/test_span_kernel.py` | Keeps the span-kernel algebra honest once semantic choice has moved upstream. |
| `graph-editor/lib/tests/test_funnel_contract.py` and `test_funnel_engine.py` | Protect the funnel as a consumer of forecast outputs rather than a second forecast engine. |
| `graph-editor/src/services/__tests__/beForecastingTriggerLogic.test.ts` | Guards FE/BE race, overwrite, and generation-counter behaviour. |
| `graph-ops/scripts/asat-blind-test.sh` | Remains the best outside-in guard for historical-basis semantics. |
| `graph-ops/scripts/conditioned-forecast-parity-test.sh` and `graph-ops/scripts/cf-topology-suite.sh` | Already exercise the whole-graph CF public surface against a v3 consumer reference across topology fixtures. |
| `graph-ops/scripts/conversion-rate-blind-test.sh` | Forecast-adjacent blind contract that does not depend on v1/v2 cohort maturity. |
| `graph-ops/scripts/cohort-maturity-model-parity-test.sh` | Targeted internal-consistency guard for main-chart versus overlay midline semantics. |

These should form the backbone of the future suite, though some need
renaming and cleanup.

### 4.2 Assets to keep but rewrite around the final contract

These files protect important seams, but their current oracle is tied to
legacy code, stale framing, or an over-narrow implementation detail.

| Asset | Rewrite direction |
|---|---|
| `graph-editor/lib/tests/test_doc56_phase0_behaviours.py` | Keep the cross-consumer agreement intent, but rewrite the file as a permanent semantic-canary suite rather than a "Phase 0 migration" record. |
| `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py` | Replace stale AST/red framing with live handler-boundary contract checks and a small runtime-backed slice where possible. |
| `graph-editor/lib/tests/test_be_topo_pass_parity.py` | Stop treating v2 as the completeness oracle; rewrite as a bounded-analytic contract for the topo pass itself. |
| `graph-editor/lib/tests/test_model_resolver.py` | Remove v1/v2 parity expectations and re-anchor on the canonical resolver contract and real graph fields. |
| `graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts` | Keep the FE authority assertions, but rename and restate it as a live contract once the stale RED framing is removed. |
| `graph-ops/scripts/multihop-evidence-parity-test.sh` | Keep the v3 multi-hop collapse/diverge claims, delete the v2 duplication, and separate data-health from semantic assertions. |
| `graph-ops/scripts/chart-graph-agreement-test.sh` | Either split the still-useful bounded claim from the known-red branch, or demote it to a targeted diagnostic harness rather than a general gate. |
| `graph-ops/scripts/golden-regression.sh` | Keep only as a public-contract smoke tool, not as a semantic oracle. |
| `graph-ops/scripts/cf-truth-parity.sh` | Keep conceptually, but normalise portability and clarify whether it is a blind truth check or a tolerated sanity bound. |

### 4.3 Assets to retire with v1/v2 deletion

These exist primarily to keep old engines alive as comparison oracles.

| Asset | Why it should retire |
|---|---|
| `graph-editor/lib/tests/test_v2_v3_parity.py` | Pure migration scaffolding once v2 is deleted. |
| `graph-ops/scripts/v2-v3-parity-test.sh` | Same. |
| `graph-editor/lib/tests/test_cohort_forecast.py` | Directly exercises v1 row-building code. |
| `graph-editor/lib/tests/test_cohort_fan_controlled.py` | Direct v1 fan-maths scaffolding. |
| `graph-editor/lib/tests/test_cohort_fan_harness.py` | Direct v1 harness. |
| the v2 half of `graph-ops/scripts/multihop-evidence-parity-test.sh` | Duplication after v2 retirement. |
| any remaining v1/v2 parity assertions embedded inside resolver or topo-pass tests | They stop being meaningful once the reference implementation is gone. |

### 4.4 Assets to quarantine or re-home

Some current assets are useful diagnostically but should not sit inside
the main semantic gate set.

| Asset | Disposition |
|---|---|
| `graph-editor/lib/tests/test_bayes_cohort_maturity_wiring.py` | Rewrite or delete; a permanently skipped module is not an assurance layer. |
| `graph-ops/scripts/capture-doc56-baselines.sh` | Keep as maintenance tooling for capturing baselines, not as a merge gate. |
| historical expected-red branches embedded in shell scripts | Pull out into explicit quarantine or resolve; do not leave them mixed into the main gate set. |

---

## 5. The target assurance architecture

The permanent forecast suite should be organised into seven families.
Each family answers a different question and uses a different oracle.

Before choosing a file or fixture, the engineer should choose the test
apparatus from the matrix below.

For this note, the apparatus names mean:

- **static test** — AST, import, schema, or response-shape inspection
  without executing forecasting logic
- **Python integration** — in-process calls through real handlers or the
  shared runtime seam on real fixtures, without mocking forecast logic
- **TypeScript integration** — real FE projection / state code over real
  graph objects; only acceptable stubs are the opposite-side boundary
  when the claim is explicitly FE-local rather than BE-semantic
- **CLI canary** — `graph-ops` shell tooling driving `analyse.sh` or
  `param-pack.sh` against the live Python BE and stable fixtures

Pure helper or unit-style tests are acceptable only when the question is
strictly local algebra or static structure, such as `span_kernel` or a
dependency audit. They are not an acceptable primary apparatus for
runtime semantics, cross-consumer agreement, or public-tooling
behaviour.

| Family | Primary oracle | Default apparatus | Secondary apparatus | Approach | Mock stance |
|---|---|---|---|---|---|
| A. stack hygiene | dead-branch / import prohibition | static test | none | not blind; direct structural inspection | no mocks |
| B. runtime semantic contracts | semantic relation from docs 57/59 and the cohort/window semantics note | Python integration | targeted CLI canary only if the same seam has escaped through tooling before | blind / contract-first | no mocks of forecast logic or snapshot-selection logic |
| C. cross-consumer agreement | agreement between live first-class consumers for the same semantic question | Python integration | one small CLI canary where the user-facing tooling depends on that relation | not legacy parity; live-system agreement | no mocks of the compared consumers |
| D. metamorphic semantics | must collapse / must diverge under a controlled transformation | Python integration | CLI blind canary on designated graphs | blind | no mocks |
| E. invariance | same answer under incidental representation change | Python or TypeScript integration depending where the representation lives | CLI only if the representation issue can escape through public tooling | blind with respect to representation | default no mocks; FE-local request/cache tests may stub only the far boundary and must not claim BE semantic coverage |
| F. projection and authority | field ownership, overwrite, projection, request/response contract | TypeScript integration for FE authority; small Python contract tests for handler shape | CLI only as a smoke check, not the primary oracle | contract-based, not blind | may isolate the opposite side of the boundary only when the test is explicitly layer-local |
| G. outside-in CLI canaries | end-to-end public-tooling invariant | CLI canary | none | blind or live cross-consumer agreement, depending the claim | zero mocks |

If a bug report already exists, the first new test should normally be a
failing blind or contract test at the lowest real boundary that would
have caught it. A CLI canary is then added only if the defect class can
escape through public tooling or has already done so.

### 5.1 Family A — Stack hygiene and branch-death guards

Purpose: ensure the live forecast stack cannot silently route back
through deleted or transitional branches.

Questions answered:

- are v1/v2 runtime imports gone from the live stack?
- are deleted compatibility branches truly dead?
- does the public stack still resolve through the canonical runtime seam?

Typical home:

- static Python tests
- lightweight dependency-audit tests

Current anchor:

- `test_forecast_stack_dependencies.py`

This family stays small and cheap.

### 5.2 Family B — Runtime semantic contract tests

Purpose: verify the explicit runtime object model itself.

Questions answered:

- is the factorised cohort default actually `carrier_to_x + subject_span`?
- does `window()` remain `X`-rooted?
- is multi-hop always full `X -> end` on the subject side?
- does query-scoped degradation happen at the shared predicate?
- do prepared bundles serialise the semantic roles explicitly?

Typical home:

- Python integration tests around `forecast_runtime`, `forecast_state`,
  `cohort_forecast_v3`, and handler preparation seams

Current anchors:

- `test_forecast_state_cohort.py`
- `test_cf_query_scoped_degradation.py`
- `test_non_latency_rows.py`

This family is the main replacement for implementation parity. It proves
that the runtime contract is right on its own terms.

### 5.3 Family C — Cross-consumer agreement tests

Purpose: prove that first-class forecast consumers are projections of one
semantic solve rather than bespoke mini-engines.

Questions answered:

- does whole-graph `conditioned_forecast` agree with scoped
  `cohort_maturity_v3` on the same subject?
- do `daily_conversions`, `surprise_gauge`, `lag_fit`, and other summary
  or trajectory consumers preserve the same temporal split?
- do direct-response consumers and graph-state consumers observe the same
  forecast semantics where they overlap?

Typical home:

- Python integration tests that call multiple public entry points with
  one fixture
- one small outside-in CLI matrix on stable synth graphs

Current anchor:

- the best parts of `test_doc56_phase0_behaviours.py`

This family should become the main consumer-level assurance layer.

### 5.4 Family D — Metamorphic semantic tests

Purpose: prove behavioural relations that must hold under controlled
transformations.

Questions answered:

- when must `window()` and `cohort()` collapse?
- when must they diverge?
- when should `A = X` collapse the carrier?
- when should a query-scoped posterior degrade rather than sweep?
- how should `asat()` alter evidence visibility without altering
  signature identity?

Typical home:

- Python integration tests for exact semantics
- CLI blind scripts for public-tooling confirmation

Current anchors:

- `asat-blind-test.sh`
- the v3 half of `multihop-evidence-parity-test.sh`

This family is critical because the recent defects were exactly
metamorphic failures: behaviour that should have changed did not, or
behaviour that should have collapsed did not.

### 5.5 Family E — Non-semantic invariance tests

Purpose: prove that answers do not depend on incidental representation.

Questions answered:

- does edge-list reorder change whole-graph CF output?
- do mixed `id` versus `uuid` representations change carrier or cache
  lookup?
- do display-only settings or focused-scenario toggles alter compute?
- do cache keys and request shapes stay stable under non-compute changes?

Typical home:

- Python tests for graph-order and identifier invariance
- frontend tests for request/cache invariance

Current anchors:

- order-invariance checks in `test_forecast_state_cohort.py`
- recent mixed-identifier regression coverage in
  `test_cf_query_scoped_degradation.py`

This family is conceptually separate from the semantic contract itself.
It protects representation discipline.

### 5.6 Family F — Projection and authority tests

Purpose: verify ownership boundaries between BE CF, BE topo, FE
projection, and chart consumers.

Questions answered:

- does CF own the graph fields it is supposed to own?
- does FE projection overwrite from the authoritative source and leave
  non-owned fields alone?
- does the topo pass stay analytically bounded instead of becoming a
  shadow forecast engine?
- do chart payload normalisers preserve the canonical semantics block
  without inventing new compute?

Typical home:

- TypeScript integration tests
- small Python contract tests at handler boundaries

Current anchors:

- `conditionedForecastCompleteness.test.ts`
- `beForecastingTriggerLogic.test.ts`
- parts of `test_conditioned_forecast_response_contract.py`

This family is where graph projection and public API shape belong. It
should not be conflated with runtime semantics.

### 5.7 Family G — Outside-in blind CLI canaries

Purpose: prove that the public tooling still asks and answers the right
questions end to end.

Questions answered:

- do `analyse.sh` and `param-pack.sh` preserve the semantic contracts the
  browser depends on?
- do historical-basis, whole-graph CF, and topology canaries still hold
  when driven through the public CLI?
- can a user or agent reproduce the core invariants without private test
  helpers?

Typical home:

- a small curated set of `graph-ops/scripts/*`

Current anchors:

- `asat-blind-test.sh`
- `conditioned-forecast-parity-test.sh`
- `cf-topology-suite.sh`
- `conversion-rate-blind-test.sh`
- a cleaned-up `multihop-evidence-parity-test.sh`

This family must stay deliberately small. Its role is confidence at the
tooling boundary, not exhaustive combinatorics.

---

## 6. Fixture classes we actually need

The suite should be built around fixture classes, not around whichever
synth graphs happen to exist already.

### 6.1 Semantic atom fixtures

These are the primary oracles. Each should isolate one phenomenon.

Required atoms:

1. **Leading-edge identity fixture**  
   `A = X`; `window()` and `cohort()` should collapse because the carrier
   is identity.

2. **Single-hop downstream factorisation fixture**  
   `A != X`; upstream latency exists; the carrier matters; `window()` and
   `cohort()` must diverge for the downstream edge.

3. **Multi-hop non-latent-upstream fixture**  
   upstream segment has no latency; `window()` and `cohort()` should
   collapse on the evidence basis for the subject.

4. **Multi-hop latent-upstream fixture**  
   upstream latency exists; `window()` and `cohort()` should diverge.

5. **Query-scoped posterior fixture**  
   same consumer family must degrade or become unavailable according to
   doc 57 rather than silently sweeping.

6. **Weak-prior / no-posterior fixture**  
   ensures the analytic fallback remains explicit and bounded rather than
   shadowing CF.

7. **Historical-basis fixture**  
   one small graph where `asat()` changes evidence visibility and
   downstream forecast behaviour in a human-interpretable way.

8. **Mixed-identity fixture**  
   same semantic graph in two representational forms to catch
   `id`/`uuid` drift.

These atoms should become the default source of truth for semantic tests.

#### 6.1.1 Atom fixture and test map (Pass 2 output)

Each atom's concrete (graph, DSL, test location) mapping. Red states
are blind contract tests correctly flagging live CF defects, not
regressions introduced by the test itself.

| Atom | Graph | Query | Python test | CLI canary | State |
|---|---|---|---|---|---|
| 1. Leading-edge A=X collapse | `synth-simple-abc` | `from(simple-a).to(simple-b)` window vs cohort | `test_doc56_phase0_behaviours.py::test_leading_edge_collapse_single_hop_window_vs_cohort` | — | red (CF defect) |
| 2. Single-hop downstream factorisation diverge | `synth-simple-abc`, `synth-mirror-4step` | `from(simple-b).to(simple-c)` / `from(m4-registered).to(m4-success)` window vs cohort | `test_doc56_phase0_behaviours.py::test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split`, `::test_chart_and_daily_conversions_do_not_collapse_window_and_cohort` | `multihop-evidence-parity-test.sh` Claim 2 | green |
| 3. Multi-hop non-latent upstream collapse | `synth-mirror-4step` | `from(m4-delegated).to(m4-success)` window vs cohort | `test_doc56_phase0_behaviours.py::test_multi_hop_non_latent_upstream_collapse_window_vs_cohort` | `multihop-evidence-parity-test.sh` Claim 1 | red (CF defect) |
| 4. Multi-hop latent upstream diverge | `cf-fix-deep-mixed` | `from(cf-fix-deep-e).to(cf-fix-deep-g)` window vs cohort | `test_doc56_phase0_behaviours.py::test_multi_hop_latent_upstream_diverges_window_vs_cohort` | — | green |
| 5. Query-scoped posterior degrades | inline synthetic in test | `window(-30d:)` with `analytic_be` source | `test_cf_query_scoped_degradation.py::test_query_scoped_latency_rows_use_degraded_contract`, `::test_query_scoped_latency_rows_keep_window_denominator_fixed`, `::test_surprise_gauge_unavailable_for_query_scoped_posterior`, `::test_daily_conversions_degraded_branch_reuses_closed_form_beta_surface` | — | green |
| 6. Weak-prior / no-posterior bounded | inline synthetic in test | Class-C fallback on empty evidence | `test_non_latency_rows.py::test_class_c_aggregate_prior_no_evidence_returns_prior`, `::test_class_c_query_scoped_no_evidence_returns_prior`, `::test_class_c_fe_is_none_returns_prior`, `::test_class_d_returns_empty`, `::test_aggregate_prior_model_bands_reflect_prior` | — | green |
| 7. `asat()` historical basis | `synth-simple-abc` | `window(...)`+`asat(...)` vs bare `window(...)` | — | `asat-blind-test.sh` | green |
| 8. Mixed identity (`id`≠`uuid`) | inline synthetic in test | direct call to `compute_cohort_maturity_rows_v3` with two identifier variants | `test_cf_query_scoped_degradation.py::test_surprise_gauge_mixed_ids_match_same_semantic_graph`, `::test_cohort_maturity_rows_v3_identity_drift` | — | green |

### 6.2 Topology matrix fixtures

These exist to exercise whole-graph and donor-routing behaviour.

Required shapes:

- linear chain
- branching fan-out
- fan-in / join
- diamond
- deep mixed-depth graph for donor-of-donor propagation

These should stay secondary. They are for topology-specific invariants,
not for proving every semantic relation.

### 6.3 Projection fixtures

Some consumers need fixtures that are chosen for output shape rather than
for forecast semantics alone.

Required projection fixtures:

- graph-state overwrite fixture for CF versus topo ownership
- daily-conversions fixture with an interpretable maturity/forecast split
- funnel fixture exercising `e`, `f`, and `e+f`
- chart overlay fixture where main midline versus overlay should be
  equivalent

### 6.4 Public-tooling fixtures

For CLI canaries, the fixture set should stay tiny and stable.

Recommended core set:

- `synth-simple-abc` for history / `asat()` / simple outside-in checks
- `synth-mirror-4step` for multi-hop and mixed latency semantics
- the existing CF topology fixtures only inside the topology suite, not
  as default oracles for every other claim

High-cardinality, slow-path, or research fixtures should remain outside
the core merge gate unless the exact property under test requires them.

---

## 7. What the post-parity suite should look like

The target suite should not be a bag of historical files. It should be a
deliberate matrix.

| Test family | Primary oracle | Main fixtures | Likely home |
|---|---|---|---|
| stack hygiene | dead-branch / import prohibition | none | static Python tests |
| runtime semantic contracts | explicit role semantics | semantic atoms | Python integration |
| cross-consumer agreement | one solve, many projections | semantic atoms + small topology cases | Python integration |
| metamorphic relations | must collapse / must diverge | semantic atoms + `asat()` fixture | Python + CLI |
| invariance | representation must not matter | edge-order, mixed-id, display-only toggles | Python + TypeScript |
| projection and authority | writer boundaries | projection fixtures | TypeScript + handler tests |
| outside-in CLI canaries | public-tooling correctness | `synth-simple-abc`, `synth-mirror-4step`, CF topology set | shell harnesses |
| frozen public baselines | response-shape drift only | a tiny stable subset | golden scripts / captured JSON |

The crucial change is that parity is no longer its own top-level family.
Where parity remains, it is local and purposeful:

- chart versus CF for the same semantic question
- main midline versus overlay for the same model curve
- FE projection versus CF response for owned fields

That is not legacy-implementation parity. It is cross-consumer agreement
inside the live system.

---

## 8. Proposed keep / rewrite / retire plan

### 8.1 Keep and elevate

The following should become named first-class layers in the permanent
suite:

- `test_forecast_stack_dependencies.py`
- `test_forecast_state_cohort.py`
- `test_cf_query_scoped_degradation.py`
- `test_non_latency_rows.py`
- `test_daily_conversions.py`
- `test_span_kernel.py`
- `test_funnel_contract.py`
- `test_funnel_engine.py`
- `beForecastingTriggerLogic.test.ts`
- `asat-blind-test.sh`
- `conditioned-forecast-parity-test.sh`
- `cf-topology-suite.sh`
- `conversion-rate-blind-test.sh`
- `cohort-maturity-model-parity-test.sh`

### 8.2 Keep but rename and restate

The following are valuable but framed as migration artefacts and should
be rewritten to reflect the steady-state contract:

- `test_doc56_phase0_behaviours.py`
- `test_conditioned_forecast_response_contract.py`
- `conditionedForecastCompleteness.test.ts`
- `multihop-evidence-parity-test.sh`

The key change here is rhetorical as well as technical: the new files
should describe the current live contract, not a historical path to it.

### 8.3 Rewrite before v1/v2 deletion lands

These should not survive in their current form:

- `test_be_topo_pass_parity.py`
- `test_model_resolver.py`
- `chart-graph-agreement-test.sh`
- `cf-truth-parity.sh`
- `golden-regression.sh` if it is still acting as a semantic oracle

Each of these has real value, but only if the oracle is re-anchored on
the final architecture.

### 8.4 Retire with the old engines

These should be removed once their replacements are green:

- `test_v2_v3_parity.py`
- `v2-v3-parity-test.sh`
- `test_cohort_forecast.py`
- `test_cohort_fan_controlled.py`
- `test_cohort_fan_harness.py`
- any remaining v2-specific branch inside mixed shell harnesses

### 8.5 Quarantine or delete

These should not remain as ambiguous half-live assets:

- permanently skipped forecast modules
- expected-red branches embedded in core scripts
- migration capture tooling treated as if it were a semantic gate

### 8.6 Replacement matrix

The table below is the concrete replacement plan. A junior developer
should use it to decide what to build first, what file to touch, and
what old asset is allowed to die afterward.

| Current asset | Action | Replacement asset or family | Apparatus and oracle | Pass | Retirement gate |
|---|---|---|---|---|---|
| `graph-editor/lib/tests/test_v2_v3_parity.py` and `graph-ops/scripts/v2-v3-parity-test.sh` | retire | Family B in `test_forecast_state_cohort.py`, Family C in a rewritten `test_doc56_phase0_behaviours.py`, and Family D/G in a rewritten `multihop-evidence-parity-test.sh` | Python blind contracts plus one CLI collapse/diverge canary | 2-4 | all replacement tests green and no live caller depends on v2 |
| `graph-editor/lib/tests/test_cohort_forecast.py`, `test_cohort_fan_controlled.py`, and `test_cohort_fan_harness.py` | retire | `test_forecast_state_cohort.py`, `test_non_latency_rows.py`, and `cohort-maturity-model-parity-test.sh` | runtime semantic contract plus targeted live-system parity where appropriate | 2-4 | replacement tests green and no v1 helper remains in live stack |
| `graph-editor/lib/tests/test_be_topo_pass_parity.py` | rewrite in place | same file, re-anchored as a bounded-analytic topo-pass contract | Python integration; contract, not v2 parity | 3 | no assertion in the file refers to v2 as oracle |
| `graph-editor/lib/tests/test_model_resolver.py` | rewrite in place | same file, re-anchored on the canonical resolver contract over real graph fields | Python integration; contract, not legacy reader parity | 3 | no v1/v2 reader remains as the expected answer |
| `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py` | rewrite and possibly rename | same seam, but framed as the live CF handler contract with runtime-backed slices where feasible | static plus small runtime contract | 3 | no stale RED/migration wording; live contract only |
| `graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts` | rewrite and rename | FE authority suite for CF-owned fields | TypeScript integration; FE-local authority contract | 3 | no RED wording; authority contract stated in live terms |
| `graph-ops/scripts/multihop-evidence-parity-test.sh` | rewrite | v3-only collapse/diverge CLI canary | CLI blind metamorphic test | 3 | no v2 branch and no mixed data-health / semantic logic in one phase |
| `graph-ops/scripts/chart-graph-agreement-test.sh` | split, demote, or rewrite | either a narrow diagnostic harness or an explicit bounded contract with a clear oracle | CLI diagnostic, not a core semantic oracle unless re-anchored | 4 | either reclassified out of the core gate set or rewritten with a stable oracle |
| `graph-ops/scripts/cf-truth-parity.sh` | rewrite | a clearly-scoped truth or catastrophe-bound canary | CLI blind truth check with portable paths | 4 | oracle and tolerance policy explicitly stated in the file header |
| `graph-ops/scripts/golden-regression.sh` and `graph-ops/scripts/capture-doc56-baselines.sh` | demote | public-contract smoke and maintenance tooling only | frozen baseline for shape drift, never primary semantics | 4 | not counted as semantic evidence for v1/v2 retirement |

---

## 9. What we should stop doing

The overhaul is not only about adding tests. It is also about removing
bad habits.

We should stop using the following as primary confidence mechanisms:

- "matches v2" once v2 is no longer the product
- broad full-row golden snapshots as the main semantic oracle
- mock-heavy FE tests as substitutes for BE semantic coverage
- giant mixed-purpose shell scripts that combine data freshness, semantic
  proof, and known-red tracking in one run
- one mega-fixture carrying every semantic claim
- expected-red tests left in the main gate set without explicit
  quarantine

These patterns create noise, false confidence, or both.

---

## 10. Rollout sequence

The assurance overhaul should land in four passes.

### Pass 1 — Freeze the target matrix

Write down the permanent test families and map each current asset to
keep, rewrite, retire, or quarantine. This note is that freeze point.

Output of the pass:

- the family taxonomy is fixed
- the apparatus/oracle matrix is fixed
- every parity-era asset has a named replacement path
- no engineer is allowed to invent a new "temporary" oracle without
  classifying it against this note

### Pass 2 — Build the semantic-atom fixtures and reframe surviving suites

Before deleting more legacy scaffolding, ensure the minimal fixture set
exists for:

- leading-edge collapse
- single-hop downstream divergence
- multi-hop non-latent collapse
- multi-hop latent divergence
- query-scoped degradation
- `asat()` historical-basis shift
- mixed identifier invariance

This is the most important pass. Without these atoms, the new suite will
still be organised around historical codepaths rather than around
meaning.

Migration-era tests are reframed in this same pass: rename them, restate
their assertions against the final oracle semantics, and strip stale
RED / phase / doc-56 framing so they stand as permanent family-C
contract suites rather than rename scaffolding.

Output of the pass:

- the semantic-atom fixtures in section 6.1 exist and are documented
- each atom has at least one Python integration test using a blind or
  contract oracle
- atoms that represent user-facing tooling risks have one designated CLI
  canary and no more
- `test_doc56_phase0_behaviours.py`,
  `test_conditioned_forecast_response_contract.py`,
  `conditionedForecastCompleteness.test.ts`,
  `test_be_topo_pass_parity.py`, `test_model_resolver.py`, and
  `multihop-evidence-parity-test.sh` are re-anchored on final-oracle
  semantics with no migration-era framing left
- no parity-era harness is retired yet

### Pass 3 — Replace the parity tail

For every v1/v2 parity harness we retire, ensure there is a replacement
in one of the permanent families above. Deletion is only safe when the
semantic claim survives somewhere else in better form.

The prospective retirement audit for this pass is complete — see
[64-retirement-audit.md](64-retirement-audit.md). Replacement tests
R1, R1b, R2, R3, R4, R7, R10, R11 (in
`test_cohort_maturity_v3_contract.py`) and R12 (in
`test_doc56_phase0_behaviours.py`) are green on main. Four v1
assertions (R5, R6, R8, R9) are design divergences rather than
coverage gaps and are not replaced.

Output of the pass:

- every row in section 8.6 marked "retire" either has a green
  successor or is documented in the audit as a v1-specific design
  rule that dies with v1
- any remaining goldens or diagnostics are explicitly demoted out of
  the core semantic gate set
- no expected-red harness remains mixed into the main merge gate by
  accident

### Pass 4 — Delete the old engines and prune the suite

Deletion runs in two phases, gated separately. See §10.1 item 7 for
the action list and §11 for the gate conditions.

- **Phase A — v2-oracle files:** imminent. Gated on (a) two test
  relocations (R13 and R14) and (b) fixing the
  `cohort-maturity-model-parity-test.sh` product defect so that
  canary goes green.
- **Phase B — v1-oracle files:** blocked on product-code work.
  Cannot begin until `api_handlers.py` stops calling v1's
  `compute_cohort_maturity_rows` at its six remaining call sites.
  Two utility-test classes must be relocated before this phase runs
  so they outlive v1.

Output of the pass:

- v1/v2 parity harnesses are gone (both phases complete)
- legacy forecast-helper tests that survived only as oracles are gone
- shared utility tests have been relocated into files that outlive v1
- the remaining suite reads as a permanent architecture document
  rather than as a migration diary

### 10.1 First-tranche backlog that can be assigned now

The first implementation tranche should be assigned in the following
order.

1. **Rewrite `graph-editor/lib/tests/test_doc56_phase0_behaviours.py`
   into a permanent Family C suite.**  
   Keep the downstream temporal-split canaries, remove the phase/migration
   framing, and make the file explicitly about cross-consumer agreement
   across at least `conditioned_forecast`, `cohort_maturity_v3`,
   `daily_conversions`, and `surprise_gauge`, with `lag_fit` included
   where it shares the same temporal-selection seam.

2. **Rewrite `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`
   into the live CF handler contract.**  
   Remove stale RED framing, preserve the handler-boundary assertions that
   still matter, and add a small runtime-backed slice where the current
   test is relying on stale static-only assumptions.

3. **Rewrite `graph-editor/lib/tests/test_be_topo_pass_parity.py`
   into a bounded-analytic topo-pass contract.**  
   The file should prove what the topo pass is allowed to do and not do.
   It should stop proving that the topo pass matches v2.

4. **Rewrite `graph-editor/lib/tests/test_model_resolver.py` into the
   canonical resolver contract.**  
   Keep real graph inputs, but make the expected answer come from the
   ratified resolver contract and field semantics rather than from legacy
   reader functions.

5. **Rewrite and rename
   `graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts`.**  
   Keep the FE authority claim, but restate it as a live Family F suite
   with clear boundaries: FE projection and overwrite behaviour only, not
   BE semantic correctness.

6. **Rewrite `graph-ops/scripts/multihop-evidence-parity-test.sh` into a
   v3-only CLI metamorphic canary.**  
   Separate freshness or setup concerns from the semantic claim, and make
   the script explicitly about collapse/diverge behaviour rather than
   historical RED status.

7. **Delete the parity tail in two phases.**  
   The prospective coverage audit required by this step is complete —
   see [64-retirement-audit.md](64-retirement-audit.md). It split the
   deletion targets into two groups by live-code dependency, and found
   that some v1 row-shape rules are design divergences rather than
   coverage gaps. What follows is the resulting action plan, not a
   second audit.

   **Phase A — v2-oracle retirement (unblocked, two relocations away):**
   - Deletion targets: `test_v2_v3_parity.py`, `v2-v3-parity-test.sh`.
   - Replacement-test status: R1, R1b, R2, R3, R4, R7, R10, R11 green in
     `graph-editor/lib/tests/test_cohort_maturity_v3_contract.py`;
     R12 green in `test_doc56_phase0_behaviours.py`.
   - CLI canary status: all four Family-G anchors are GREEN
     (`asat-blind`, `conversion-rate-blind`,
     `cohort-maturity-model-parity`, `multihop-evidence-parity`).
     The live CF defects that made them red have been fixed.
   - Remaining preconditions:
     1. Relocate `test_strong_evidence_midpoint_near_observed_rate`
        from `test_v2_v3_parity.py` to
        `test_cohort_maturity_v3_contract.py` (R13 — already green,
        just needs a new home before its current file dies).
     2. Relocate `test_v3_handler_widens_single_edge_downstream_cohort_span`
        from `test_v2_v3_parity.py` to
        `test_conditioned_forecast_response_contract.py` (R14 — same).
   - After those two land, both files can be deleted with no
     coverage loss.

   **Phase B — v1-oracle retirement (blocked on product-code work):**
   - Deletion targets: `test_cohort_forecast.py`,
     `test_cohort_fan_controlled.py`, `test_cohort_fan_harness.py`.
   - Blocker: `api_handlers.py` still calls v1's
     `compute_cohort_maturity_rows` at six call sites (lines 4476,
     4516, 4551, 4583, 4606, and the supporting import at 4476).
     Until those call sites are removed or switched to v3, these test
     files are covering live production code, not dead scaffolding.
   - This is a product-code clean-up, not an assurance clean-up.
     Scheduling it is out of scope for this note; the gate for Phase B
     is simply "v1 has zero call sites in production code".
   - Before deletion:
     - Move `TestCDFRatioCalibration` and `TestMCBand` out of
       `test_cohort_fan_controlled.py` into a new
       `test_confidence_bands.py` file. They test
       `runner.confidence_bands` utilities which are shared between
       v1 and v3 via `forecast_runtime.py` and outlive v1.
     - `TestForecastRate`, `TestReadEdgeCohortParams`,
       `TestGetIncomingEdges`, and `TestFindEdgeById` in
       `test_cohort_forecast.py` are v1-internal — they die with v1.

   **Design divergences confirmed by the audit (not gaps):**
   Four v1 row-shape rules do not apply to v3 and are not replaced:
   midpoint-null in epoch A, rate-null past `tau_future_max`, fan
   zero-width at the solid boundary, and fan opens through the
   forecast zone. v3 returns prior-mean midpoint in epoch A, fills
   `rate` in all branches (distinguishing observed from projected via
   separate fields), carries full posterior width at the boundary,
   and emits flat fans when the posterior applies uniformly across τ.
   These are deliberate v3 design choices — see audit §R5, §R6, §R8, §R9.

   **Standing rule**: a v2-oracle test that is the only numerical
   check on a surface stays until a v2-free numerical check replaces
   it. A docstring reframe is not a replacement.

8. **Finish by reclassifying goldens and diagnostics.**  
   `chart-graph-agreement-test.sh`, `cf-truth-parity.sh`,
   `golden-regression.sh`, and `capture-doc56-baselines.sh` should end
   this tranche either rewritten with explicit limited roles or
   reclassified out of the core semantic gate set.

For a junior developer, the rule is simple: do not delete anything
until you have personally verified, for each assertion in the file to
be deleted, that a green replacement exists elsewhere. Reframes are
not replacements.

---

## 11. Minimum gate before deleting v1/v2

Deletion runs in two phases — see §10.1 item 7. Each phase has its
own gate.

### Phase A gate — v2-oracle files (`test_v2_v3_parity.py`, `v2-v3-parity-test.sh`)

All of the following must be true:

1. No remaining core test has "matches v1" or "matches v2" as its
   primary oracle. Every assertion that was previously covered by a
   v1/v2 oracle has either a green v2-free replacement, or has been
   confirmed by the retirement audit to be a v1-specific design rule
   that v3 deliberately does not uphold (see 64-retirement-audit.md
   §R5, §R6, §R8, §R9). Numerical claims need numerical replacements;
   structural claims need structural replacements.
2. Runtime semantic contract tests are green for the factorised cohort
   model, multi-hop semantics, and query-scoped degradation.
3. Cross-consumer agreement tests are green across at least
   `cohort_maturity_v3`, `conditioned_forecast`, `daily_conversions`,
   and `surprise_gauge`, with `lag_fit` included where it shares the
   same temporal-selection seam.
4. Metamorphic tests prove the required collapse/diverge relations for
   leading-edge, downstream single-hop, multi-hop non-latent upstream,
   and multi-hop latent-upstream cases.
5. Invariance tests cover edge-order stability and mixed identifier
   stability.
6. FE authority tests are green for CF-owned graph fields.
7. The core outside-in CLI canaries are green on their designated
   fixtures. All four (`asat-blind`, `conversion-rate-blind`,
   `cohort-maturity-model-parity`, `multihop-evidence-parity`) are
   green today.
8. Any remaining expected-red or diagnostic-only forecast harness is
   explicitly quarantined and not mistaken for a production gate.
9. R13 and R14 have been relocated out of `test_v2_v3_parity.py` into
   their target files (see §10.1 item 7 Phase A).

Gates 1–8 are met today. Gate 9 (two test relocations) is the only
remaining work before Phase A can execute.

One Family-B/D Python test is currently red
(`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`).
This is a blind contract catching a real CF defect — it does not block
Phase A, but it is an unfixed product bug listed in §11.1 below.

### Phase B gate — v1-oracle files (`test_cohort_forecast.py`, `test_cohort_fan_*.py`)

Phase A must have completed, PLUS:

10. **v1 has zero call sites in production code.** Today,
    `api_handlers.py` calls `compute_cohort_maturity_rows` (v1) at six
    call sites (lines 4476, 4516, 4551, 4583, 4606, plus the module
    import). Until those are removed or switched to v3, the v1 test
    files are covering live production code.
11. `runner.confidence_bands` utility tests (`TestCDFRatioCalibration`,
    `TestMCBand`) have been moved to a dedicated file that outlives v1.

Gate 10 is a product-code clean-up, not an assurance clean-up, and is
out of scope for this note.

If the applicable gate is not met, deleting v1/v2 will remove the
wrong tests before we have built the right ones.

### 11.1 Currently-red blind-contract tests (product defects, not test issues)

The new test regime catches two real CF defects. These do not block
Phase A or Phase B deletion — they are product bugs that exist today
regardless of the assurance overhaul. Listed here so they are not
mistaken for regressions introduced by the new test suite.

1. `test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`
   — window and cohort model curves collapse onto each other on a
   bayesian-enriched synth fixture where they should diverge.
   Symptom: switching between window and cohort on a downstream edge
   with bayesian-enriched parameters shows the same chart.
2. `test_v3_handler_widens_single_edge_downstream_cohort_span` —
   handler passes edge-scoped CDF array (`cdf:x->y`) instead of
   anchor-to-target (`cdf:a->y`) for single-edge cohort spans with
   anchor ≠ from-node. This is the R14
   relocation target — the defect must be fixed before the test is
   moved into `test_conditioned_forecast_response_contract.py`, or
   the move has to take the assertion as-is (red) and treat it as an
   expected-red blind contract there.

---

## 12. End state

The desired end state is not "more tests". It is a cleaner assurance
system with clearer jobs.

After the overhaul:

- runtime semantics are guarded by explicit contract tests
- consumer agreement is guarded directly rather than inferred through
  deleted engines
- collapse/diverge relations are tested as first-class invariants
- FE/BE authority boundaries are explicit
- public CLI tooling remains covered
- v1/v2 parity scaffolding is gone

That is the point at which forecasting assurance becomes appropriate for
a stable live architecture rather than for a migration project.
