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

For each test the verdict (Keep / Keep, trimmed / Merge / Drop / Handoff)
plus the load-bearing subcases. The §5 surviving-suite table is the
authoritative list; this section gives the per-test rationale.

**73c Purpose, method, layer index** — Drop as replacement-doc framing.
The six-step method drives over-testing. Replacement principle: each
surviving test states which implementation risk it removes.

### Layer C — per-scenario graph composition and delivery

Strongest section: per-scenario graphs currently inherit stale or
wrong-context model material; the cohort/window semantics doc makes
wrong-context substitution a semantic bug.

- **C-Test-1 `perScenarioModelVarsDerivation.test.ts`** — Keep.
  Subcases: exact DSL slice selection; `asat()` fit-history selection;
  full bayesian entry shape (probability + latency/path); no mutation of
  source data; analytic entry preserved; no cross-context fallback.
  Sentinel parameter files are fine — bug is slice selection, not numerics.
- **C-Test-2 `cfAndAnalysisDerivationParity.test.ts`** — Keep, trimmed.
  Parity assertion between analysis-prep and CF engorgement for the same
  `(edge, paramId, effective DSL)`. Use ≥3 scenarios with distinct DSLs
  (catches stale-closure bugs). C-Test-1 owns derivation correctness.
- **C-Test-3 `cfRequestPayloadModelVars.test.ts`** — Merge into
  `cfRequestEnvelope.test.ts`. Envelope content, not a separate concept.
- **C-Test-4** — Handoff to doc 73b (BE consumer-read migration).

### Layer A — CF dispatch

Load-bearing because doc 73a changes supersession from module-global to
per-scenario state and relies on per-scenario request graphs.

- **A-Test-1 `cfDispatchCoverage.test.ts`** — Keep, trimmed. Visible live
  scenarios dispatch exactly once; hidden don't dispatch; BASE doesn't;
  CURRENT not via `regenerateAllLive`; no duplicate dispatches.
  Drop mid-cycle scenario create/delete (lifecycle policy, not 73a risk).
- **A-Test-2 `cfPerScenarioSupersession.test.ts`** — Keep. A/B overlap
  with B-first-doesn't-cancel-A; gen-1 discarded after gen-2 exists;
  A-after-only-B-commissioned still accepted; no module-global
  `_conditionedForecastGeneration` reference; tracker is tab-scoped.
  Primary regression guard for Defect 3a.
- **A-Test-3 `cfRequestEnvelope.test.ts`** — Keep, trimmed; absorbs
  C-Test-3. Real scenarioId, effective DSL, per-scenario graph
  fingerprint ≠ BASE, closure capture with ≥3 scenarios, derived
  `model_vars[bayesian]` present and scenario-specific,
  `candidate_regimes_by_edge` present, `analytics_dsl` only if still in
  the live request contract. Drop the broad live-graph identity audit
  unless mutation risk is real.

### Layer B — CF response handling

- **B-Test-1 `cfResponseRouting.test.ts`** — Merge into
  `cfPerScenarioRouting.test.ts`, trimmed. A→A only, BASE/current
  unmutated, reverse response order safe. Drop duplicate-delivery and
  orphan-scenarioId-warning unless explicitly designed.
- **B-Test-2 `cfFieldMappingSentinel.test.ts`** — Keep. Sentinel-value
  mapping per §10 table. The `p_mean → p.forecast.mean` double-write
  subcase asserts only during 73a's lifetime; updated in lockstep with
  doc 73b's switchover. (See §7 contract check 1.)
- **B-Test-3 `cfResponseEdgeCases.test.ts`** — Keep only failed/empty CF
  subcases (merge into `scenarioRegenerationCfUpsert.test.ts`); drop
  partial-response, null-per-edge, orphan-edge_uuid (defensive branches
  with no implementation change).
- **Extensions to A-Test-2** — Merge into
  `cfPerScenarioSupersession.test.ts`. Keep check-before-apply.

### Layer D — pack lifecycle

Other strongest section: Defect 3b is exactly extract/diff/compositor fidelity.

- **D-Test-1 `extractDiffParamsContractCoverage.test.ts`** — Keep.
  One changed contract field at a time appears in diff even with `p.mean`
  unchanged; excluded fields stay out; epsilon boundary; node
  `entry.entry_weight` and `case.variants`; null base = full working
  params. Trim the broad `Object.freeze` immutability proof.
- **D-Test-2 `compositorReplayCoverage.test.ts`** — Keep, trimmed.
  Every contract field replays to the right location; `p.posterior`,
  `p.n`, `p.stdev`, `conditional_p` specifically replay (Defect 3b
  regression); shallow merge for nested blocks; layer order with three
  packs; documented null semantics. Drop deep-clone type audit and
  excluded-field validation.
- **D-Test-3 `scenarioPackContractRoundtrip.test.ts`** — Keep. The
  essential integration proof for 73a Stage 2:
  `extract → applyComposed → rebuilt` is byte-equal on contract fields;
  excluded fields come from lower layers. Two-scenario
  inheritance/override case included; idempotency only if cheap in the
  same setup.
- **D-Test-4 `scenarioPackPersistence.test.ts`** — Drop / defer.
  Generic IDB persistence belongs to the IDB suite, not this repair.

### Layer E — async lifecycle

Real risk is narrow: pack extraction can run before slow CF applies.

- **E-Test-1 `cfFastSlowPathSentinel.test.ts`** — Keep, trimmed. Fast CF
  inside 500ms doesn't double-apply; slow CF after 500ms applies after
  FE fallback; empty/failed slow CF preserves FE fallback. Drop the exact
  500ms boundary subcase and the 0ms-before-FE-topo subcase (not real
  risk in current code).
- **E-Test-2 `scenarioRegenerationCfUpsert.test.ts`** — Keep. Slow CF
  keeps regeneration unresolved until apply settles; persisted pack
  contains CF-derived sentinels; awaits the CF awaitable specifically;
  failed/empty settles cleanly; superseded stale CF doesn't get packed.
  Drop mid-extract UI edit and artificial "handle not registered"
  injection.
- **E-Test-3 `cfConcurrentRegenCycles.test.ts`** — Keep only the rapid
  double-`regenerateAllLive` subcase. Defer scenario-deleted-between-
  cycles and trigger interleaving (broader lifecycle, not parity repair).
- **E-Test-4 `cfPromiseLifecycleEdgeCases.test.ts`** — Drop / defer.
  Async platform concerns, not 73a's specific risk.

### Layer F — cleanup integrity

Cleanup matters during doc 73b's cleanup stage (Stage 6), only after
Stage 4's slice-material relocation has made the legacy persistent
stash non-load-bearing.

- **F-Test-1 `cleanupGrepGates.test.ts`** — Keep as static gate only.
  Absence checks for `_posteriorSlices`, `reprojectPosteriorForDsl`,
  removed projection helpers, BE consumer reads of legacy posterior
  fields. Use a Node-side file walker, not shell grep.
- **F-Test-2 `feDisplayAfterPosteriorRemoval.spec.ts`** — Trim hard.
  One browser smoke covering the highest-risk display surface (one edge
  properties / model-vars view + one chart that would go blank). No
  Playwright walk of every card/overlay. Share-bundle restore only if
  cleanup changes share-restore paths.
- **F-Test-3 `cleanupSchemaAudit.test.ts`** — Static gate only. Fixture
  audit for `_posteriorSlices`; type/schema absence. Drop the IDB
  persisted-state scrub unless a migration is implemented.

### Layer G — observability

Session log is a user-facing trace, but 73c over-specifies wording.

- **G-Test-1 `cfSessionLogShape.test.ts`** — Keep, trimmed. Structural
  assertions for commission (with scenarioId + generation), apply (fast
  and slow), superseded discard, empty result, failed CF, scenario
  verdict toast. Don't pin exact message templates beyond stable tags
  and required structured fields. Don't assert full parent/child
  hierarchy unless that's the public contract.
- **G-Test-2 `cfLogLevelInvariance.test.ts`** — Merge into G-Test-1 or
  drop. Fold the few important level assertions into the shape test.
- **CF call-site `isLevelEnabled` audit** — Drop unless heavy trace
  payloads are added.

### Layer H — end-to-end

One full-flow integration and one browser smoke, both reduced.

- **H-Test-1 `cfFullPipelineSentinel.integration.test.ts`** — Keep,
  trimmed. Real FE services + deferred CF boundary. Three scenarios
  produce three distinct request graphs; derived per-scenario
  `model_vars[]` reaches CF payloads (post-73b-switchover assertion);
  out-of-order responses apply to the right scenario; slow CF awaited
  before pack extraction; recomposed packs preserve scenario values.
  Drop the real-serialisation roundtrip and the chart-layer display
  agreement (covered by Playwright).
- **H-Test-2 `liveScenarioConditionedForecastRoundtrip.spec.ts`** — Keep
  as small Playwright smoke. Boot, create/load ≥2 live scenarios with
  distinct DSLs, wait for CF, assert visible per-scenario values differ,
  refresh/reload, assert values survive recomposition. Drop
  navigate-away-and-back, scenario reorder, mid-CF interaction, and
  real-BE-as-mandatory (stubbed CF in CI; real-BE manual/nightly).

### Failure-mode mapping (73c lines 1967-2040)

Do not carry forward. Bakes in the exhaustive frame; the §5 surviving
suite table is the replacement.

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
| 73b/4 | `perScenarioModelVarsDerivation.test.ts` | Keep | Correct slice picked, in-schema fields (`model_vars[bayesian]`, `p.posterior.*`, `p.latency.posterior.*`) project correctly per scenario, `fit_history` engorged out-of-schema for `epistemic_bands.py`, analytic preservation, no cross-context bayesian fallback. (Owned by doc 73b Stage 4(a) — per-scenario request-graph contexting + engorgement.) |
| 73b/4 | `cfAndAnalysisDerivationParity.test.ts` | Keep, trimmed | Analysis-prep and CF request paths produce identical request-graph state for the same scenario (both contexting and engorgement). (Owned by doc 73b Stage 4(a).) |
| 73b/4 | `liveEdgeReContextOnDslChange.test.ts` | Keep | On `currentDSL` change, the live edge's `model_vars[bayesian]`, `p.posterior.*`, and `p.latency.posterior.*` re-project to the new context's slice; `applyPromotion` re-runs and the narrow promoted surface (`p.forecast.{mean, stdev, source}`) updates. Sentinel: a parameter file with two distinct slices for `window()` vs `context(channel:google).window()` — switching live DSL flips `p.forecast.mean` to the new slice's value. Without this, after Stage 4(c) the canvas displays go stale on every context change. (Owned by doc 73b Stage 4(e) — live-edge contexting on currentDSL change.) |
| 73b/4 | `cliAnalysisPrepEngorgement.test.ts` | Keep | The CLI's `analysisComputePreparationService` consumer invokes the same contexting + engorgement step as the FE, with the scenario's effective DSL. Sentinel: CLI request payload contains the contexted slice for the scenario's DSL, not the live-edge load-time slice. Required for doc 73a Stage 6 CLI/FE parity. (Owned by doc 73b Stage 4(a) CLI subtask.) |
| 73b/4 | `carrierReadViaSharedResolver.test.py` | Keep | `_resolve_edge_p` (and any sibling reach/carrier site) routes its model-input read through `resolve_model_params`, not direct `p.mean`. Sentinel: a graph where `p.mean` and the promoted source disagree — carrier behaviour follows the promoted source, not `p.mean`. (Owned by doc 73b Stage 4(d) — carrier consumer read via shared resolver. Closes Defect 2 / Mismatch 4(i).) |
| 73b/4 | `shareRestorePosteriorRehydration.test.ts` | New | Opening a share bundle / share chart URL, with the persistent `_posteriorSlices` stash absent (post-Stage 4(b) world), still produces the right per-scenario posterior projection. Sentinel: a saved share whose `currentQueryDSL` selects a non-default slice — after restore, `analysisComputePreparationService` invokes the rewired re-projection and the request graph carries the slice that matches `currentQueryDSL`, not the live-edge load-time slice. Without this, the share-restore dependency on the parameter-file-backed re-projection (Stage 4(a)) can rot silently. (Owned by doc 73b Stage 4(a) — extends the same rewiring of `reprojectPosteriorForDsl`.) |
| 73b/6 | cleanup grep/static gates | Keep as static gates | Removed legacy symbols do not return after Stage 4's slice-material relocation. (Owned by doc 73b's cleanup stage (Stage 6); was 73a Stage 5c.) |
| 73b/6 | display-after-cleanup check | Trim | One or two high-risk display surfaces still render after legacy graph fields are removed. (Owned by doc 73b's cleanup stage; was 73a Stage 5c.) |
| 73a/3 | `cfSessionLogShape.test.ts` | Keep, trimmed | CF lifecycle visible enough for users and debugging; no brittle wording snapshots. |
| 73a/6 | `cliFeScenarioParity.test.ts` | Keep | FE and CLI build identical scenario graphs/payloads from same packs and DSL. **Phase note:** depends on doc 73b's switchover for the per-scenario `model_vars[]` derivation; cannot run pre-73b-switchover. |
| 73a/7 | `cfFullPipelineSentinel.integration.test.ts` | Keep, trimmed | Real FE seams work together across dispatch, apply, upsert, and recomposition. **Phase note:** the per-scenario derived-model-vars assertions assert only post-73b-switchover. |
| 73a/7 | `liveScenarioConditionedForecastRoundtrip.spec.ts` | Keep as smoke | Browser scenario CF/regeneration/reload works at least once end to end. |

## 6. Tests removed from the required plan

The §4 verdicts and the §5 surviving suite are the authoritative
record of what stays and what doesn't. The list below is a
rapid-reference summary; for rationale see §4.

Removed as named required artefacts:
`cfRequestPayloadModelVars.test.ts` (→ envelope),
`cfResponseRouting.test.ts` (→ per-scenario routing),
`cfResponseEdgeCases.test.ts` (failed/empty kept inside upsert),
`scenarioPackPersistence.test.ts` (generic IDB),
`cfConcurrentRegenCycles.test.ts` (one subcase only if cheap),
`cfPromiseLifecycleEdgeCases.test.ts` (async platform),
`cfLogLevelInvariance.test.ts` (→ shape test),
`cleanupSchemaAudit.test.ts` integration/IDB (static pieces only),
cross-cutting verification bundle (CI sequence, not a test).

## 7. Open contract checks before implementation

Settled contract decisions affecting test pinning:

1. **`p.forecast.mean` ownership** — RESOLVED (73b §11.2 conflict 6,
   option (a); doc 60 Decision 9 retired). 73a preserves the current
   CF double-write through its own lifetime; doc 73b's switchover
   makes `p.forecast.*` promotion-only.
   `cfFieldMappingSentinel.test.ts` names the current phase and is
   updated in lockstep with the switchover commit.
2. **`p_sd → p.stdev` persistence** — RESOLVED (73b OP9, decision
   B-narrow). CF writes `p_sd → p.stdev`; mapping test pins it.
3. **Wrong-context fallback** — covered. Doc 73b Stage 4(a)
   (engorgement at analysis-prep) removes `posteriorSliceResolution.ts`'s
   context-stripping fallback (or rejects mismatched returned slices
   at the seam). Derivation test keeps the no-cross-context case.
4. **`analytics_dsl` in CF requests** — open. The envelope test
   should assert whichever request contract is actually live; doc 73c
   includes the field but whole-graph CF design has moved on.
5. **Cleanup sequencing** — covered. Doc 73b's cleanup-stage (Stage 6)
   tests are gated on Stage 4 (slice-material relocation), which
   removes the persistent stash and its read-side projector.

## 8. Recommended replacement posture

Replace `73c` with this note. Tests are stage gates, not a catalogue
of every possible failure; each required test protects a named
implementation seam; edge cases become tests only when the
implementation changes that branch or production has shown it fails;
73a tests delivery and pack/upsert mechanics; 73b tests consumer
migration and long-term field ownership.
