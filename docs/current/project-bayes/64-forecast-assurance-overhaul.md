# 64 — Forecast Assurance Overhaul

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
| `graph-editor/src/services/__tests__/conditionedForecastCompleteness.red.test.ts` | Keep the FE authority assertions, but rename and restate it as a live contract once the stale RED framing is removed. |
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

- `conditionedForecastCompleteness.red.test.ts`
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
- `conditionedForecastCompleteness.red.test.ts`
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

The assurance overhaul should land in five passes.

### Pass 1 — Freeze the target matrix

Write down the permanent test families and map each current asset to
keep, rewrite, retire, or quarantine. This note is that freeze point.

### Pass 2 — Build the semantic-atom fixtures

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

### Pass 3 — Rewrite the surviving migration tests

Turn migration-labelled tests into permanent contract suites. Rename
them, restate their assertions, and remove stale RED / phase framing.

### Pass 4 — Replace the parity tail

For every v1/v2 parity harness we retire, ensure there is a replacement
in one of the permanent families above. Deletion is only safe when the
semantic claim survives somewhere else in better form.

### Pass 5 — Delete the old engines and prune the suite

Once the replacement layers are green, delete the v1/v2 tests and any
now-pointless helpers. The resulting suite should be smaller, more
interpretable, and more directly tied to the live product semantics.

---

## 11. Minimum gate before deleting v1/v2

We should not delete `cohort_maturity` v1/v2 until all of the following
are true.

1. There is no remaining core test whose primary oracle is "matches v1"
   or "matches v2".
2. Runtime semantic contract tests are green for the factorised cohort
   model, multi-hop semantics, and query-scoped degradation.
3. Cross-consumer agreement tests are green across at least
   `cohort_maturity_v3`, `conditioned_forecast`, `daily_conversions`, and
   `surprise_gauge`, with `lag_fit` included where it shares the same
   temporal-selection seam.
4. Metamorphic tests prove the required collapse/diverge relations for
   leading-edge, downstream single-hop, multi-hop non-latent upstream,
   and multi-hop latent-upstream cases.
5. Invariance tests cover edge-order stability and mixed identifier
   stability.
6. FE authority tests are green for CF-owned graph fields.
7. The core outside-in CLI canaries are green on their designated
   fixtures.
8. Any remaining expected-red or diagnostic-only forecast harness is
   explicitly quarantined and not mistaken for a production gate.

If those conditions are not met, deleting v1/v2 will remove the wrong
tests before we have built the right ones.

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
