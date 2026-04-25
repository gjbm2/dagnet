# 73d — CF Test Strategy Triage

**Date**: 25-Apr-26  
**Status**: Review recommendation  
**Audience**: engineers replacing or reducing `73c-cf-staged-test-strategy.md`  
**Reviews**: `73a-scenario-param-pack-and-cf-supersession-plan.md`, `73b-be-topo-removal-and-forecast-state-separation-plan.md`, `73c-cf-staged-test-strategy.md`

## 1. Review basis

This note reviews `73c` test by test and recommends the reduced set of
tests that should survive into implementation. It is intentionally not a
second exhaustive failure-mode catalogue.

The review is grounded in the current app architecture:

- `SCENARIO_SYSTEM_ARCHITECTURE.md`: scenarios are ordered sparse
  param-pack deltas, not persisted graphs; regeneration composes a
  temporary working graph, runs Stage 2 enrichment, extracts a fresh pack,
  and stores only the pack.
- `PARAMETER_SYSTEM.md`: parameter files are the deep store; graph state is
  the current projection; scenario packs must carry only active projection
  fields needed for replay.
- `STATS_SUBSYSTEMS.md` and `FE_BE_STATS_PARALLELISM.md`: the live Stage 2
  statistical writers are FE topo and BE CF; CF races a 500ms deadline and
  may overwrite the FE fallback later.
- `SESSION_LOG_ARCHITECTURE.md`: logs are user-facing operation traces; raw
  diagnostics belong at debug/trace and should not be over-specified by
  brittle message snapshots.
- `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`: context, `asat`,
  denominator carrier, and subject-span semantics are load-bearing. Tests
  that allow wrong-context model material or wrong subject data onto a
  request graph are valuable; tests that only enumerate lifecycle anxieties
  are not.
- `TESTING_STANDARDS.md`: fewer real-boundary tests are preferred over many
  mock-heavy tests. A test earns its place only if it catches a realistic
  implementation regression that would otherwise reach users.

## 2. Triage key

- **Keep**: implement as a named test or fixture. It directly protects a
  known defect or a high-risk seam in `73a` / `73b`.
- **Keep, trimmed**: keep the test, but reduce subcases to implementation
  risk rather than enumerated possibility.
- **Merge**: the assertion is useful but should live inside another test.
- **Static gate only**: use a cheap source/type/fixture assertion, not an
  integration or Playwright test.
- **Drop / defer**: not justified by the planned implementation. Revisit
  only if the implementation explicitly adds that behaviour.
- **Handoff**: belongs to `73b`, not `73a`.

## 3. Overall verdict on `73c`

`73c` should not survive as the execution test strategy. Its method starts
from exhaustive failure-mode enumeration and therefore turns many possible
edge cases into mandatory tests. That conflicts with the repo's testing
standard: tests should protect real user-facing contracts at real boundaries,
not prove every imagined branch in an async state machine.

The useful material in `73c` is real. The problem is density and obligation.
The replacement strategy should keep the tests that protect:

1. per-scenario CF isolation and supersession;
2. correct request graph and effective DSL delivery;
3. per-scenario `model_vars[]` derivation, including no wrong-context fallback;
4. scenario pack extract / replay / round-trip fidelity;
5. CF response field mapping;
6. slow-CF pack upsert ordering;
7. FE/CLI prepared-graph parity;
8. one in-process full-flow seam check;
9. one browser smoke roundtrip.

Everything else should either be merged into those checks, reduced to a
static gate, handed to `73b`, or dropped.

## 4. Section-by-section triage of `73c`

### Lines 8-45 — Purpose and method

**Verdict: Drop as replacement-doc framing.**

The six-step method is internally disciplined, but it is the source of the
over-testing. It makes "unmapped failure mode" look like a defect even when
the failure mode is outside the implementation contract or better covered by
one higher-level real-boundary test.

**Keep only this principle:** each surviving test should state which
implementation risk it removes and what it does not cover.

### Lines 47-58 — Layer index

**Verdict: Replace with stage-risk index.**

The layer list is useful as analysis scaffolding but too broad as an
execution table. The replacement should group by `73a` implementation stage:
infrastructure, supersession, pack contract, CF routing/mapping, async upsert,
model-vars derivation, cleanup, CLI parity, final smoke.

### Lines 60-233 — Layer C, per-scenario graph composition and delivery

**Verdict: Mostly keep, with one merge.**

This is one of the strongest sections because it protects a real defect:
per-scenario graphs currently inherit stale or wrong-context model material.
The cohort/window semantics doc makes wrong-context substitution a semantic
bug, not a harmless fallback.

#### C-Test-1: `perScenarioModelVarsDerivation.test.ts`

**Verdict: Keep.**

Keep the subcases for:

- exact DSL slice selection;
- `asat()` fit-history selection;
- full bayesian entry shape, especially probability plus latency/path fields;
- no mutation of parameter-file source data or persistent graph;
- analytic entry preserved;
- no cross-context bayesian fallback.

This removes real risk from doc 73b's bundled-switchover delivery
sub-step (formerly doc 73a Stage 5a). It should be allowed to use
sentinel parameter files because the bug is slice selection and
materialisation, not Python forecast numerics.

#### C-Test-2: `cfAndAnalysisDerivationParity.test.ts`

**Verdict: Keep, trimmed.**

Keep the parity assertion between analysis-prep and CF engorgement for the
same `(edge, parameter id, effective DSL)`. Use at least three scenarios
with distinct effective DSLs to catch stale-closure bugs. Do not add further
pathology cases here; C-Test-1 owns derivation correctness.

#### C-Test-3: `cfRequestPayloadModelVars.test.ts`

**Verdict: Merge into `cfRequestEnvelope.test.ts`.**

The assertion is useful: derived data must survive into the outgoing CF
payload. But it is envelope content, not a separate conceptual test. Keeping
it separate adds setup and maintenance cost without much diagnostic gain.

#### C-Test-4 moved to `73b`

**Verdict: Handoff.**

Correct. BE consumer-read migration belongs to `73b`. `73a` should verify
delivery only; `73b` should verify consumers read the canonical promoted
surface.

### Lines 235-493 — Layer A, CF dispatch

**Verdict: Keep the core dispatch/supersession/envelope tests, trim lifecycle races.**

Dispatch is load-bearing because `73a` explicitly changes supersession from
module-global to per-scenario state and relies on per-scenario request graphs.

#### A-Test-1: `cfDispatchCoverage.test.ts`

**Verdict: Keep, trimmed.**

Keep:

- visible live scenarios each dispatch exactly once;
- hidden scenarios do not dispatch;
- BASE does not dispatch;
- CURRENT is not dispatched by `regenerateAllLive`;
- no duplicate dispatches within one cycle.

Drop from the required suite:

- mid-cycle scenario creation;
- mid-cycle scenario deletion.

Those are lifecycle race policy tests, not direct risk from the `73a`
implementation. Add them only if the implementation explicitly changes
scenario CRUD during regeneration.

#### A-Test-2: `cfPerScenarioSupersession.test.ts`

**Verdict: Keep.**

Keep:

- A and B overlap; B returning first does not cancel A;
- A generation 1 is discarded after A generation 2 exists;
- A response after only B was commissioned is still accepted;
- no module-global `_conditionedForecastGeneration` reference remains;
- state persists across unrelated fetches if the implementation's tracker is
  tab-scoped rather than fetch-scoped.

This is the primary regression guard for Defect 3a.

#### A-Test-3: `cfRequestEnvelope.test.ts`

**Verdict: Keep, trimmed and expanded with C-Test-3.**

Keep:

- real scenario id;
- effective DSL;
- per-scenario graph fingerprint not equal to BASE;
- closure capture with at least three scenarios;
- derived `model_vars[bayesian]` present and scenario-specific;
- `candidate_regimes_by_edge` present where the fixture requires it;
- `analytics_dsl` only if this field is still part of the live CF request
  contract being tested.

Trim:

- live editor graph fingerprint unchanged before/after dispatch, unless the
  request builder currently risks mutating the source graph. If mutation
  risk is real, keep it as one assertion, not a broad identity audit.

### Lines 495-710 — Layer B, CF response handling

**Verdict: Keep mapping and basic routing; trim edge cases.**

Response handling matters because `73a` adds or pins graph field writes.
However, much of this section tests defensive behaviour unrelated to the
planned changes.

#### B-Test-1: `cfResponseRouting.test.ts`

**Verdict: Merge into `cfPerScenarioRouting.test.ts`, trimmed.**

Keep:

- response A mutates only A's working graph;
- BASE/current are not mutated;
- reverse response order does not matter.

Drop:

- duplicate-delivery idempotency, unless the implementation introduces a
  retry or duplicate delivery path;
- orphan `scenarioId` warning as a hard test, unless this behaviour is
  explicitly designed. A missing scenario should not mutate graphs, but the
  precise log wording/level need not be pinned here.

#### B-Test-2: `cfFieldMappingSentinel.test.ts`

**Verdict: Keep.**

This is high-value. It protects the exact response-to-graph contract and
catches field-name slips cheaply.

Keep:

- `p_mean -> p.mean`;
- `p_mean -> p.forecast.mean` only while `73a` explicitly preserves the
  current double-write pending `73b`;
- `p_sd -> p.stdev` if `73a` keeps the decision to persist it;
- `p_sd_epistemic` response-only;
- `completeness -> p.latency.completeness`;
- `completeness_sd -> p.latency.completeness_stdev`;
- `evidence_k/evidence_n -> p.evidence.k/n`;
- non-owned latency fields such as `t95` unchanged.

Note: this test must be updated when `73b` changes ownership of
`p.forecast.*`. It should not make the legacy double-write look permanent.

#### B-Test-3: `cfResponseEdgeCases.test.ts`

**Verdict: Keep only as subcases where they affect upsert completion; otherwise drop.**

Keep or merge into `scenarioRegenerationCfUpsert.test.ts`:

- rejected CF does not leave partial writes and regeneration settles;
- empty CF preserves FE fallback and regeneration settles.

Drop from the required suite:

- partial response coverage warning;
- null per-edge value;
- orphan `edge_uuid`.

Those are defensive apply-path branches. They are worth testing only if the
implementation changes them or if there is a known production failure.

#### Extensions to A-Test-2

**Verdict: Merge into `cfPerScenarioSupersession.test.ts`.**

Keep check-before-apply for stale responses. It is directly tied to the
supersession fix.

### Lines 714-988 — Layer D, pack lifecycle

**Verdict: Keep extract/replay/roundtrip; drop generic IDB persistence.**

This is the other strongest section. Defect 3b is explicitly about extractor,
diff, and compositor fidelity.

#### D-Test-1: `extractDiffParamsContractCoverage.test.ts`

**Verdict: Keep.**

Keep:

- one changed contract field at a time appears in the diff even when
  `p.mean` does not change;
- excluded deep fields do not appear;
- epsilon boundary around `p.mean` or representative numeric fields;
- node `entry.entry_weight` and `case.variants`;
- null base means full working params if that remains a supported input.

Trim:

- do not require `Object.freeze` as a broad immutability proof unless the
  extractor has previously mutated input graphs. A plain before/after
  equality assertion is enough if mutation is the concern.

#### D-Test-2: `compositorReplayCoverage.test.ts`

**Verdict: Keep, trimmed.**

Keep:

- every contract field can replay to the right graph location;
- `p.posterior`, `p.n`, `p.stdev`, and `conditional_p` specifically replay;
- shallow merge for nested `p.evidence` / `p.latency` blocks;
- layer order with three packs;
- documented null semantics if null overlays are actually part of the pack
  contract.

Drop:

- deep-clone `Date` / `Symbol` / `function` audit. Graph and pack contracts
  should use serialisable data; this is not a `73a` risk.
- "pack contains excluded field; compositor should error/warn" unless the
  implementation adds pack validation. Exclusion is extractor/type contract;
  compositor should not become a schema validator by accident.

#### D-Test-3: `scenarioPackContractRoundtrip.test.ts`

**Verdict: Keep.**

This is the essential integration proof for Stage 2. It should assert
`extract -> applyComposed -> rebuilt` equals the working graph on contract
fields, and excluded fields come from lower layers or parameter files, not
from the pack.

Keep the two-scenario inheritance/override case. Keep idempotency only if it
is cheap in the same setup.

#### D-Test-4: `scenarioPackPersistence.test.ts`

**Verdict: Drop / defer.**

`73a` does not redesign IndexedDB persistence. Generic write/read fidelity,
mutation-after-write, and IDB failure propagation belong to the IDB/scenario
persistence suite, not this CF repair. Reintroduce only if the implementation
touches the scenario persistence API.

### Lines 992-1284 — Layer E, async lifecycle

**Verdict: Keep slow-CF upsert and a reduced fast/slow check; drop broad promise-lifecycle tests.**

The real `73a` async risk is narrow: pack extraction currently runs before
slow CF can apply. The rest of Layer E expands into general async policy.

#### E-Test-1: `cfFastSlowPathSentinel.test.ts`

**Verdict: Keep, trimmed.**

Keep:

- fast CF resolves inside 500ms and does not cause a second slow-path apply;
- slow CF resolves after 500ms and applies after FE fallback;
- empty/failed slow CF does not overwrite FE fallback.

Drop:

- exact 500ms boundary unless the implementation changes deadline comparison;
- response at 0ms before FE topo apply unless there is evidence the current
  code can enter that order and mishandle it.

#### E-Test-2: `scenarioRegenerationCfUpsert.test.ts`

**Verdict: Keep.**

This is essential. Keep:

- slow CF keeps regeneration unresolved until the CF apply path has settled;
- persisted pack contains CF-derived sentinel fields after slow CF;
- if the implementation can register multiple awaitables, verify it waits for
  the CF awaitable, not merely any promise;
- failed or empty CF settles and extracts the documented fallback graph state;
- superseded stale CF does not get packed.

Drop:

- mid-extract UI edit. That is an editing concurrency policy, not part of the
  repair unless `73a` explicitly defines it.
- artificial "promise handle not registered" injection unless the
  implementation exposes a meaningful error path. The normal slow-CF upsert
  test already fails if the handle is not registered.

#### E-Test-3: `cfConcurrentRegenCycles.test.ts`

**Verdict: Keep one subcase, defer the rest.**

Keep:

- two rapid `regenerateAllLive` cycles: older CF responses are discarded and
  both await chains settle.

Drop / defer:

- scenario deleted between cycles;
- simultaneous refresh-all plus single-scenario trigger.

Those are broader lifecycle behaviours. They do not need to block the narrow
CF parity repair.

#### E-Test-4: `cfPromiseLifecycleEdgeCases.test.ts`

**Verdict: Drop / defer.**

Hanging promises, tab-close aborts, and throwing handlers are important app
resilience concerns, but not the specific implementation risk unless `73a`
adds timeout/abort infrastructure. Testing them here would turn the repair
into an async platform project.

### Lines 1288-1477 — Layer F, cleanup integrity

**Verdict: Keep static gates; reduce UI/browser coverage.**

Cleanup matters during doc 73b's cleanup stage (Stage 6), but only
after doc 73b's consumer migration (Stages 4 and 5) has made the
legacy surfaces non-load-bearing.

#### F-Test-1: `cleanupGrepGates.test.ts`

**Verdict: Keep as static gate only.**

Keep absence checks for:

- `_posteriorSlices`;
- `reprojectPosteriorForDsl`;
- removed projection helpers if they are actually removed;
- BE consumer reads of legacy posterior fields once `73b` has migrated them.

Use a repository search or AST helper inside the test. Do not run shell
`grep` from the test if the project has a better Node-side file walker.

#### F-Test-2: `feDisplayAfterPosteriorRemoval.spec.ts`

**Verdict: Trim hard.**

Keep one browser or integration smoke that exercises the highest-risk display
surface that formerly depended on graph-side posterior fields. Do not walk
every card, chart, overlay, and share-bundle path in Playwright.

Recommended scope:

- one edge properties / model-vars display surface for a known Bayesian edge;
- one chart or analysis read that would go blank if the display still relied
  on removed graph-side posterior fields.

Share-bundle restore should be covered only if the cleanup actually changes
share restore data paths.

#### F-Test-3: `cleanupSchemaAudit.test.ts`

**Verdict: Static gate only; IDB migration only if implemented.**

Keep:

- fixture audit for `_posteriorSlices`;
- type/schema absence if the field is removed from public graph types.

Drop / defer:

- IDB persisted-state scrub unless the implementation includes a migration.
  If old data is merely ignored, test the reader ignores it in the relevant
  read-path suite, not as part of `73a`.

### Lines 1481-1712 — Layer G, observability

**Verdict: Merge and slim.**

The app's session log is a user-facing trace, so CF lifecycle visibility
matters. But `73c` over-specifies wording, hierarchy, and levels.

#### G-Test-1: `cfSessionLogShape.test.ts`

**Verdict: Keep, trimmed.**

Keep structural assertions for:

- commission entry includes scenario id and generation;
- applied entry exists for fast/slow success;
- superseded entry exists for stale discard;
- empty result is visible as warning or documented degraded outcome;
- failed CF is visible as error;
- compact scenario verdict toast exists for batch regeneration if
  `ScenariosContext` still uses that UX.

Do not pin exact message templates beyond stable tags and required
structured fields. Avoid asserting full parent/child hierarchy unless the
operation hierarchy is the public contract under review.

#### G-Test-2: `cfLogLevelInvariance.test.ts`

**Verdict: Merge into `cfSessionLogShape.test.ts` or drop.**

Separate log-level invariance is excitable. The important thing is that
failures are not hidden and routine internals are not surfaced at user level.
Fold those assertions into the shape test for the few lifecycle outcomes
that matter.

#### CF call-site `isLevelEnabled` audit

**Verdict: Drop from this suite unless heavy trace allocation is added.**

The session log architecture already owns `isLevelEnabled` discipline.
Adding a CF-specific grep gate is only useful if this implementation adds
heavy trace payloads.

### Lines 1716-1963 — Layer H, end-to-end

**Verdict: Keep one seam integration and one browser smoke, both reduced.**

The testing standards favour real boundaries. One full-flow integration and
one browser smoke are justified. The problem is the number of subcases.

#### H-Test-1: `cfFullPipelineSentinel.integration.test.ts`

**Verdict: Keep, trimmed.**

Keep a deterministic in-process integration with real FE services and the
deferred CF boundary. It should prove:

- three scenarios produce three distinct request graphs;
- derived per-scenario `model_vars[]` reaches CF payloads;
- responses resolved out of order apply to the right scenario;
- slow CF is awaited before pack extraction;
- recomposed packs preserve final scenario-specific values.

Drop:

- real serialisation roundtrip unless the payload contains non-plain objects;
- chart-layer display agreement if the Playwright smoke covers visible
  display. If kept, make it one assertion, not a chart subsystem test.

#### H-Test-2: `liveScenarioConditionedForecastRoundtrip.spec.ts`

**Verdict: Keep as a small Playwright smoke.**

Keep:

- boot known graph;
- create or load at least two live scenarios with distinct DSLs;
- wait for CF/regeneration to settle;
- assert visible per-scenario values differ as expected;
- refresh/reload once and assert values survive recomposition.

Drop:

- navigate-away-and-back;
- scenario reorder during in-flight CF;
- mid-CF arbitrary UI interaction;
- real-BE CI as mandatory. Prefer stable stubbed CF in CI and reserve real-BE
  for manual/nightly if it is too slow or variable.

### Lines 1967-2040 — Failure-mode mapping

**Verdict: Do not carry forward.**

The mapping is useful for auditing `73c`, but it bakes in the exhaustive
frame. The replacement doc should contain a smaller "surviving suite" table
with each test's implementation risk. It should not preserve every failure
mode as an obligation.

## 5. Recommended surviving suite

The suite below is the recommended replacement for `73c`.

| Stage | Artefact | Verdict | Risk removed |
|---|---|---|---|
| 0 | `helpers/cfTransactionHarness.ts` | Keep | Deterministic CF commissioning/resolution without real BE latency. |
| 0 | `cfTransactionHarness.test.ts` | Keep, trimmed | Harness resolves, rejects, overlaps scenarios, and supports same-scenario supersession. |
| 0 | sentinel fixtures | Keep | Field-routing slips fail with distinct values. |
| 0 | golden baselines | Trim | Keep only one narrow baseline for observable drift; avoid broad real-graph/session-log snapshots. |
| 1 | `cfPerScenarioSupersession.test.ts` | Keep | Removes global-counter regression risk. |
| 1/3 | `cfDispatchCoverage.test.ts` | Keep, trimmed | Visible live scenarios get exactly one CF; hidden/base/current rules hold. |
| 73a/1+3 | `cfRequestEnvelope.test.ts` | Keep, merged | Request carries scenario id, effective DSL, scenario graph, candidate regimes. **Phase note:** the "derived per-scenario model vars" subcase only asserts post-73b-switchover; before then the request carries baseline-inherited model_vars and the test must skip or xfail that subcase. |
| 73a/3 | `cfPerScenarioRouting.test.ts` | Keep, trimmed | Response applies to origin scenario only; BASE/current untouched. |
| 73a/4 | `cfFieldMappingSentinel.test.ts` | Keep | CF response fields land only on the documented graph targets. **Phase note:** the `p_mean → p.forecast.mean` double-write subcase asserts only during doc 73a's lifetime; the doc 73b switchover removes it. Update in lockstep. |
| 73a/4 | `cfFastSlowPathSentinel.test.ts` | Keep, trimmed | Fast path does not double-apply; slow path overwrites FE fallback correctly. |
| 73a/4 | `scenarioRegenerationCfUpsert.test.ts` | Keep | Slow CF is awaited before pack extraction; failed/empty/superseded outcomes settle cleanly. |
| 73a/2 | `extractDiffParamsContractCoverage.test.ts` | Keep | Contract fields are extracted even when `p.mean` is unchanged; excluded fields stay out. |
| 73a/2 | `compositorReplayCoverage.test.ts` | Keep, trimmed | Contract fields, `conditional_p`, nested merges, and layer order replay. |
| 73a/2 | `scenarioPackContractRoundtrip.test.ts` | Keep | Extract/recompose faithfully rebuilds working graph on contract fields. |
| 73b/4 | `perScenarioModelVarsDerivation.test.ts` | Keep | Correct slice, full shape, analytic preservation, no cross-context bayesian fallback. (Owned by doc 73b's bundled switchover; was 73a Stage 5a.) |
| 73b/4 | `cfAndAnalysisDerivationParity.test.ts` | Keep, trimmed | Analysis and CF request paths derive identical model vars. (Owned by doc 73b's bundled switchover; was 73a Stage 5a.) |
| 73b/6 | cleanup grep/static gates | Keep as static gates | Removed legacy symbols do not return after consumer migration. (Owned by doc 73b's cleanup stage; was 73a Stage 5c.) |
| 73b/6 | display-after-cleanup check | Trim | One or two high-risk display surfaces still render after legacy graph fields are removed. (Owned by doc 73b's cleanup stage; was 73a Stage 5c.) |
| 73a/G | `cfSessionLogShape.test.ts` | Keep, trimmed | CF lifecycle visible enough for users and debugging; no brittle wording snapshots. |
| 73a/6 | `cliFeScenarioParity.test.ts` | Keep | FE and CLI build identical scenario graphs/payloads from same packs and DSL. **Phase note:** depends on doc 73b's switchover for the per-scenario `model_vars[]` derivation; cannot run pre-73b-switchover. |
| 73a/7 | `cfFullPipelineSentinel.integration.test.ts` | Keep, trimmed | Real FE seams work together across dispatch, apply, upsert, and recomposition. **Phase note:** the per-scenario derived-model-vars assertions assert only post-73b-switchover. |
| 73a/7 | `liveScenarioConditionedForecastRoundtrip.spec.ts` | Keep as smoke | Browser scenario CF/regeneration/reload works at least once end to end. |

## 6. Tests to remove from the required plan

Remove these as named required artefacts:

- `cfRequestPayloadModelVars.test.ts` — merge into `cfRequestEnvelope.test.ts`.
- `cfResponseRouting.test.ts` — merge into `cfPerScenarioRouting.test.ts`.
- `cfResponseEdgeCases.test.ts` — keep only failed/empty cases inside upsert or log tests.
- `scenarioPackPersistence.test.ts` — generic IDB persistence, not a `73a`
  implementation risk.
- `cfConcurrentRegenCycles.test.ts` — keep only one rapid double-refresh
  subcase if cheap; not a full required file.
- `cfPromiseLifecycleEdgeCases.test.ts` — async platform behaviour, not this
  repair.
- `cfLogLevelInvariance.test.ts` — fold the few important level assertions
  into `cfSessionLogShape.test.ts`.
- `cleanupSchemaAudit.test.ts` as integration/IDB test — keep only static
  pieces if doc 73b's cleanup stage removes schema/type fields.
- cross-cutting verification bundle — a test that reruns all tests is a CI
  command, not a test.

## 7. Open contract checks before implementation

These are not test-count issues. They are contract decisions that must be
settled so the surviving tests do not pin contradictory behaviour.

1. **`p.forecast.mean` ownership**: while doc 73a preserves the current CF
   double-write through its own lifetime, doc 73b's bundled switchover
   (Stage 4) moves `p.forecast.*` to promotion-only and stops CF writing
   it. `cfFieldMappingSentinel.test.ts` must name the current phase and
   be updated when doc 73b's switchover lands.
2. **`p_sd -> p.stdev` persistence**: `STATS_SUBSYSTEMS.md` still documents
   `p_sd` as response-only in places, while doc 73a proposes persisting
   `p.stdev`. The mapping test should pin only the chosen settled contract.
3. **Wrong-context fallback**: if `posteriorSliceResolution.ts` still falls
   back from contexted DSL to bare `window()`, doc 73b's bundled-switchover
   delivery sub-step must either fix the resolver or explicitly reject
   mismatched returned slices. The derivation test must keep the
   no-cross-context case.
4. **`analytics_dsl` in CF requests**: `73c` includes it in envelope tests,
   while whole-graph CF design has evolved around temporal DSL plus graph-wide
   edge resolution. The envelope test should assert whichever request contract
   is live for this implementation, not both.
5. **Cleanup sequencing**: doc 73b's cleanup-stage tests must not run until
   doc 73b's consumer migration (Stages 4 and 5) has moved consumers off
   legacy posterior reads. Before then, absence checks would delete
   load-bearing behaviour.

## 8. Recommended replacement posture

Replace `73c` with a shorter test strategy derived from this note. Do not edit
`73c` in place into a smaller failure-mode matrix. The matrix framing is what
made it overgrow.

The replacement should say:

- tests are stage gates, not a catalogue of every possible failure;
- each required test protects a named implementation seam;
- edge cases become tests only when the implementation changes that edge case
  or production has already shown it fails;
- `73a` tests delivery and pack/upsert mechanics;
- `73b` tests consumer migration and long-term field ownership.
