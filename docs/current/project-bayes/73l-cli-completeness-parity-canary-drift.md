# 73l — CLI completeness parity canary drift

**Status**: **RESOLVED 30-Apr-26 (evening).** Both canaries
(`test_cli_identity_collapse_matches_window_across_public_surfaces`,
`test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`)
now pass. The actual root cause was a long-standing TZ off-by-one in
[`formatDateUK`](../../graph-editor/src/lib/dateFormat.ts) for d-MMM-yy
strings — see "Final root cause" below. The four-defect diagnosis in the
body of this note was investigated and partially implemented; those defects
are real layer-contract cleanup but were *not* the canary mechanism. The
body is preserved for traceability.

**Date opened**: 30-Apr-26
**Date resolved**: 30-Apr-26 (evening)
**Parent**: [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) §F4
**Related**: [`FE_BE_STATS_PARALLELISM.md`](../codebase/FE_BE_STATS_PARALLELISM.md), [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md)

## Final root cause (30-Apr-26 evening)

`formatDateUK(date: Date | string)` at
[`src/lib/dateFormat.ts:14`](../../graph-editor/src/lib/dateFormat.ts) used
`new Date(date)` to parse a string input. For a d-MMM-yy literal such as
`"29-Apr-26"`, V8 parses this as **local** midnight. On a host running in
a TZ ahead of UTC (e.g. Europe/London during BST), local midnight 29-Apr-26
is `2026-04-28T23:00:00.000Z` UTC. `getUTCDate()` then returned **28**, and
the function output `"28-Apr-26"` — a one-day shift. The bug only manifested
for d-MMM-yy inputs falling inside BST months (late March through late
October), and only when the host TZ itself was BST.

**Why pack saw the right answer and analyse did not.** The param-pack CLI
hands the user's DSL string straight to
`aggregateAndPopulateGraph(bundle, queryDsl, …)`, which threads it
through `fetchItems` → `parseConstraints` and consumes the date strings
without renormalisation. The analyse CLI builds its per-scenario
`effective_query_dsl` via
`composeScenarioDsl(augmentDSLWithConstraint(currentDSL || '', recipeDsl), …)`.
With the CLI's `currentDSL` empty, `augmentDSLWithConstraint` early-returns
`normalizeConstraintString(newConstraint)`, and that path calls
`formatDateUK(start)` and `formatDateUK(end)` on each window/cohort
endpoint. The endpoint inside a BST month came back shifted, so analyse's
`effective_query_dsl` for `from(...).to(...).window(29-Jan-26:29-Apr-26)`
arrived at the fetch pipeline as `window(29-Jan-26:28-Apr-26)`. The 91-day
scoped cohort set lost its last day, completeness over the same lognormal
fit shifted from 0.8865 to 0.8872 in FE Step 2, CF read a different
graph state, and the canary fired.

**Forensic chain that localised this.**
[`src/services/forensicSnapshot.ts`](../../graph-editor/src/services/forensicSnapshot.ts)
(removed after the fix) was wired at five checkpoints — pack post-aggregate,
analyse post-clone, runScenarioMaterialisation entry, post-recontext,
post-materialise — plus per-edge inputs at the FE topo `computeEdgeLatencyStats`
call and the LAG-window setup in `fetchDataService`. The diff isolated:

1. μ, σ, t95 identical between pack's FE topo run and analyse's materialisation FE topo run.
2. `cohortsScopedCount` differed by 1 (pack 91, analyse 90); the missing cohort was 29-Apr-26 (n=44, k=22).
3. `cohortWindow.end` differed by one day (pack 29-Apr, analyse 28-Apr).
4. Tracing `effectiveQueryDsl` upstream located the corruption between `entry.queryDsl` (correct) and `runScenarioMaterialisation` entry (corrupted), narrowing the failure to `composeScenarioDsl(augmentDSLWithConstraint('', recipeDsl), …)` — which calls `normalizeConstraintString` → `formatDateUK("d-MMM-yy")`.
5. Direct test `formatDateUK("29-Apr-26") === "28-Apr-26"` reproduced the bug, with `Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/London"`.

## Fix

In `formatDateUK` at [`src/lib/dateFormat.ts`](../../graph-editor/src/lib/dateFormat.ts):
when the string input matches `isUKDate`, route through `parseUKDate` (which
uses `Date.UTC(...)`) instead of the implementation-defined
`new Date(string)`. Round-tripping a d-MMM-yy string through `formatDateUK`
now returns the input unchanged regardless of host TZ.

A regression test for round-tripping across the BST/GMT boundary is in
[`src/lib/__tests__/dateFormat.test.ts`](../../graph-editor/src/lib/__tests__/dateFormat.test.ts).

## Status of the four 73l defects

All four defects identified in the body of this note are now closed in the
working tree, even though the canaries themselves were already green from
the `formatDateUK` fix above. They are independently correct layer-contract
cleanup that closes the latent re-emergence risk for the same defect class.
None of the four moved the canary numbers — the canary cause was the TZ
bug — but each defect was real, and each is now landed.

- Defect 1 (analyse pre-runs CF) — implemented in
  [`src/cli/commands/analyse.ts`](../../graph-editor/src/cli/commands/analyse.ts)
  via the `needsSnapshots` branch that defers materialisation to
  `prepareAnalysisComputeInputs`. FE-only analyses (`graph_overview`,
  `node_info`, `edge_info`, …) keep the pre-aggregate path because they
  consume a fully-materialised graph for local compute and do not run a
  BE analysis afterwards.
- Defect 2 (single canonical CF response mapping) — implemented. The
  per-edge "CF write spec" projection is centralised in
  [`extractCfEdgeWriteSpec`](../../graph-editor/src/services/conditionedForecastService.ts).
  Both
  [`applyConditionedForecastToGraph`](../../graph-editor/src/services/conditionedForecastService.ts)
  (direct/slow path) and
  [`mergeCfIntoFe`](../../graph-editor/src/services/fetchDataService.ts)
  (race fast path) now consume that single helper. The two paths still
  differ in *output shape* — race writes into pre-existing `EdgeLAGValues`,
  direct constructs an `EdgeLAGValues[]` directly — but they cannot drift
  on which CF response fields are read or how they are validated. Drift
  was the failure mode 73l originally named.
- Defect 3 (fast-path `p_mean → forecast.mean` leak) — implemented; the
  spread that wrote a new `forecast.mean` is removed.
- Defect 4 (dispersion mapping alignment) — implemented; both paths now
  write `p_sd → stdev_pred`, `p_sd_epistemic → stdev`.

## Acceptance criteria — final status

- ✅ `test_cli_identity_collapse_matches_window_across_public_surfaces` passes.
- ✅ `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` passes.
- ✅ Focused TS test proves the CF race fast path does not mutate
  `p.forecast.*` or `model_vars[analytic].probability.*`
  (`conditionedForecastCompleteness.test.ts` —
  "CF fast path: does NOT leak p_mean into …").
- ✅ Focused TS tests prove the race fast path and direct path agree on
  field selection and validity gates
  (`conditionedForecastCompleteness.test.ts` —
  "extractCfEdgeWriteSpec — canonical CF response projection" and
  "CF response mapping parity — race fast path vs direct slow path").
- ✅ CLI analyse-path integration test proves `analyse` does not invoke
  graph-mutating CF before `runPreparedAnalysis` for `needsSnapshots`
  analyses (`test_cohort_factorised_outside_in.py` —
  `test_analyse_cli_does_not_pre_run_graph_mutating_cf_for_needs_snapshots`).
- ✅ Existing param-pack behaviour remains valid (the canaries pass
  end-to-end against the same param-pack output).

---

## Body of original investigation (preserved for traceability)


## Purpose

Document the mechanism behind a class of outside-in failures in [`test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py) where the public scalar `latency.completeness` disagrees between the param-pack CLI and the analyse CLI on the **same query**, and pin what is and is not yet known about the cause. The disagreement breaks the parity-canary contract that doc 45 §Delivery model and [`FE_BE_STATS_PARALLELISM.md`](../codebase/FE_BE_STATS_PARALLELISM.md) call out as a guarantee of conventional convergence between the two CLI surfaces.

This is not the carrier-aware completeness gap visible on Test 5 (`test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`) — that has a distinct mechanism and is noted briefly in §6 below as a separate concern that needs its own doc.

## Required context

Any reader needs these in scope:

- [`FE_BE_STATS_PARALLELISM.md`](../codebase/FE_BE_STATS_PARALLELISM.md) §"Two logical steps in one pass (FE topo)" — the dual-writer architecture for `latency.completeness`. FE Step 2 (`enhanceGraphLatencies`) writes a quick blend; BE CF (`runConditionedForecast`) overwrites with the careful importance-sampling result. Both writers target the same field on the same query-scoped surface. Race-based with a 500ms deadline; CLI callers set `awaitBackgroundPromises=true` so CF wins the race deterministically.
- [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) §F4 — original record of the same canary breakdown. F4 names two structural drift sources: Source A (Stage 6 `alpha_beta_query_scoped` retirement) and Source B (Stage 5 item 7 — the new `runScenarioMaterialisation` pass on the analyse CLI path). F4 quotes O(1e-4) magnitudes; the present doc records that the gap has widened by two orders of magnitude since.
- [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic contract: `completeness` is the maturity scalar for the query-scoped evidence set. Same DSL must produce one number, regardless of which CLI surfaces it.
- [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md) invariant 7 — projection must not re-decide semantics. Two CLI surfaces reading the same field for the same query must agree to within sampling tolerance; structural divergence is a contract violation.

## Problem statement

The outside-in test [`_assert_public_scalar_parity`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py) (helper at line 639) asserts that, for a given DSL, three values agree to absolute tolerance `_COMPLETENESS_ABS_TOL = 1e-4`:

- `pack_completeness` — `p.latency.completeness` extracted from the param-pack CLI's graph output
- `cf_completeness` — `completeness` field in the analyse CLI's `conditioned_forecast` response
- `cm_completeness` — `completeness` field in the last row of the analyse CLI's `cohort_maturity` response

Two failing tests carry this canary:

- `test_cli_identity_collapse_matches_window_across_public_surfaces` — synth-lat4 c→d, A=X identity case (`window(29-Jan-26:29-Apr-26)` and `cohort(synth-lat4-c, 29-Jan-26:29-Apr-26)`). Recorded magnitudes (29-Apr-26 → 30-Apr-26): pack=0.802855, cf=0.824894, |Δ|=0.022039.
- `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` — synth-lat4 c→d cohort with anchor synth-lat4-b. Recorded magnitudes: pack=0.773858, cm last-row=0.836027, |Δ|=0.062169.

Both queries are conventional: well-evidenced 90-day windows on the synth-lat4 fixture, anchors that exist in the topology, and edge `c→d` is the standard cohort-maturity-suite subject. Neither case exercises an edge of the contract; both should converge under the FE-Step-2-vs-CF parity guarantee.

73f §F4 measured the same canary at delta ≤4.79e-3 on 28-Apr-26 (the post-73e measurement). Today the `cli_identity_collapse` delta sits at 22e-3 — roughly 5× larger than F4's measurement, ~50× larger than the `_COMPLETENESS_ABS_TOL` budget. The widening is recent.

## Architecture recap — the dual-writer design (not a defect)

[`FE_BE_STATS_PARALLELISM.md`](../codebase/FE_BE_STATS_PARALLELISM.md) is explicit that `latency.completeness` has two writers by design:

1. **FE Step 2** (`statisticalEnhancementService.ts:enhanceGraphLatencies`). Synchronous, blocking. Computes a quick analytic blend of query-scoped cohorts against the moment-fitted lognormal CDF.
2. **BE CF** (`conditionedForecastService.ts:runConditionedForecast` → `forecast_state.py`). Race-based, importance-sampling against the full cohort frame set, drawing per-particle `(μ, σ, onset)` from the resolved posterior.

The race is deterministic on the CLI: `awaitBackgroundPromises=true` is set on both `param-pack` and `analyse` invocations so CF always finishes before the CLI returns. The pipeline contract is therefore "FE writes provisional, CF overwrites with careful — both visible to consumers as `p.latency.completeness`, with CF as the authoritative version when it returns non-empty." See `FE_BE_STATS_PARALLELISM.md` §"CF fast path vs slow path" and `mergeCfIntoFe` semantics.

The parity canary is the test that under conventional inputs the two writers produce numerically close output. They will not be bit-identical — one is a closed-form moment-blend, the other is an IS-resampled posterior median over S particles — but they should agree well within `_COMPLETENESS_ABS_TOL = 1e-4` on mature, well-evidenced fixtures. That contract is what the canary asserts.

## Corrected diagnosis — four defects, one symptom

**Update — 30-Apr-26**: the initial framing in this note correctly identified
that the analyse CLI and param-pack CLI feed CF different graph states, but it
under-described why the second state differs. The corrected diagnosis has
four defects:

1. **`analyse` runs graph-mutating CF before the requested analysis**.
   `analyse.ts` calls `aggregateAndPopulateGraph` for every scenario before
   it enters `prepareAnalysisComputeInputs`. That fetch-pipeline call runs FE
   topo and graph-mutating CF. The prepared-analysis contract says
   `analyse` should materialise a request graph, then call the requested BE
   analysis; if the requested analysis is `conditioned_forecast`, that call is
   the CF call. Running CF before the analysis is both inefficient and a
   source of state feedback.

2. **There are two independent graph-mutating CF response-mapping
   implementations**. The 500ms race path in `fetchDataService.ts` has its
   own local merge from CF response to FE edge values. The slow/direct path
   uses `applyConditionedForecastToGraph` in `conditionedForecastService.ts`.
   The timing distinction is legitimate; the duplicate mapping logic is not.
   There should be one canonical CF response-to-graph mapping, with the race
   deciding only when that mapping is applied.

3. **The fetch-pipeline CF fast-path writes the CF current answer into the
   promoted forecast/source path**. The fast-path merge in
   `fetchDataService.ts` maps CF `p_mean` onto `forecast.mean`. When that
   update is applied, `UpdateManager.applyBatchLAGValues` copies the
   `forecast.mean` value into `model_vars[analytic].probability.mean`, and
   `applyPromotion` fans it back out to `p.forecast.mean`. This violates the
   layered contract: CF owns L5 current-answer fields (`p.mean`,
   completeness), not L2 promoted baseline fields (`p.forecast.*`) or L1
   source-ledger fields (`model_vars[analytic]`). This is the concrete
   contamination path: CF #1 rewrites the analytic baseline that CF #2 later
   consumes.

4. **The fetch-pipeline CF fast-path maps dispersion differently from the
   direct CF apply path**. The direct `applyConditionedForecastToGraph` path
   contains the Stage 4(c) / Stage 4(f) contract: CF `p_sd` is predictive and
   should land on `p.stdev_pred`, while `p_sd_epistemic` lands on `p.stdev`;
   CF must not write `p.forecast.*`. The fast-path merge still maps `p_sd`
   into the bare `stdev` slot and does not handle `p_sd_epistemic` separately.
   This does not directly explain the completeness deltas, but it is the same
   class of bug: the fast-path CF response mapping has drifted from the
   canonical direct-apply mapping.

These four defects are related but distinct. Defect 1 explains why the
analyse CLI gives the system two opportunities to diverge. Defect 2 explains
how defects 3 and 4 were able to happen: the same response contract was
implemented twice. Defect 3 explains why the two CF calls can produce
materially different values despite fixed RNG seeds and the same user DSL.
Defect 4 is an adjacent response-mapping contract violation that should be
fixed in the same surface once mapping is made single-source.

## Mechanism — what differs between the two CLI calls

`pack_completeness` and `cf_completeness` are produced by two **separate CLI invocations** in the test helper [`_collect_public_edge_scalars`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py) at line 611. Each invocation runs an independent pipeline against the same DSL. The relevant difference is which graph state CF runs against in each case.

### Param-pack CLI path (produces `pack_completeness`)

`param-pack` CLI ([`paramPack.ts:115-143`](../../graph-editor/src/cli/commands/paramPack.ts)) calls `aggregateAndPopulateGraph` exactly once. Inside that:

- `fetchItems` runs Stage 2 enrichment (`runStage2EnhancementsAndInboundN`).
- FE Step 2 runs (`enhanceGraphLatencies`), writes provisional `p.latency.completeness` onto the edge.
- CF dispatches in parallel via `runConditionedForecast`. CLI awaits.
- CF response merges into the graph via `mergeCfIntoFe`, overwriting `p.latency.completeness` with CF's careful value.

The param-pack output then extracts `p.latency.completeness` from the resulting graph. This is the CF-overwritten value. **One CF call, no further graph mutation between CF's write and the extraction.**

### Analyse CLI path with `--type conditioned_forecast` (produces `cf_completeness`)

`analyse` CLI ([`analyse.ts:204`](../../graph-editor/src/cli/commands/analyse.ts) onward) runs the same `aggregateAndPopulateGraph` first — so the graph emerges from this stage in the same state as param-pack would leave it (CF-overwritten `p.latency.completeness`).

Then the analyse path runs additional steps that param-pack does not:

- `prepareAnalysisComputeInputs` ([`analysisComputePreparationService.ts:464`](../../graph-editor/src/services/analysisComputePreparationService.ts)).
- `runScenarioMaterialisation` ([`analysisComputePreparationService.ts:87`](../../graph-editor/src/services/analysisComputePreparationService.ts)). Two sub-steps:
  1. `recontextScenarioGraph` → `contextGraphForEffectiveDsl` ([`posteriorSliceContexting.ts:313`](../../graph-editor/src/services/posteriorSliceContexting.ts)). Re-projects `model_vars[bayesian]` from parameter-file posterior slices for the effective DSL. Calls `applyPromotion` ([`modelVarsResolution.ts:310`](../../graph-editor/src/services/modelVarsResolution.ts)) afterwards to write `p.posterior` and `p.latency.posterior` from the active source.
  2. `materialiseScenarioFeTopo` ([`feTopoMaterialisationService.ts:99`](../../graph-editor/src/services/feTopoMaterialisationService.ts)). Re-runs FE topo (`enhanceGraphLatencies`) on the re-contexted graph, **with `skipConditionedForecast: true`** (line 130 in that file) — CF is explicitly suppressed in this pass. FE topo overwrites `p.latency.completeness` with its provisional value.

After these two steps, the graph state has been mutated relative to what param-pack saw at extraction:
- `p.posterior` and `p.latency.posterior` may have been rewritten by the second `applyPromotion` call.
- `p.latency.{mu, sigma, t95, completeness}` may have been rewritten by the second FE topo run.

`runPreparedAnalysis` then dispatches the **second CF call** (`analyzeSelection` or `forecastConditionedScenarios` at [`analysisComputePreparationService.ts:865`](../../graph-editor/src/services/analysisComputePreparationService.ts) onward). This CF call runs against the materialised graph. The CF response carries the `completeness` field that becomes `cf_completeness`.

`cm_completeness` follows the same path with `cohort_maturity` instead of `conditioned_forecast` as the analysis type.

### Where divergence enters

The two CLI surfaces give CF different inputs:

- Param-pack CLI: CF runs once on the graph as it emerges from `aggregateAndPopulateGraph`.
- Analyse CLI: CF runs once inside `aggregateAndPopulateGraph` (same as param-pack), then a second time inside `runPreparedAnalysis` against the graph after `recontextScenarioGraph` + `materialiseScenarioFeTopo`.

If `recontextScenarioGraph` and `materialiseScenarioFeTopo` were idempotent on
already-materialised state, both CF calls would have identical inputs and
produce identical outputs. They are not idempotent. The dominant known
non-idempotency is no longer hypothetical:

- CF #1's fast-path response mapping writes `p_mean` into `forecast.mean`.
- The `UpdateManager` LAG apply path treats `forecast.mean` as a promoted
  probability-surface input and writes it into `model_vars[analytic]`.
- The second materialisation pass then sees an analytic source whose baseline
  mean has been rewritten by the first CF call.
- CF #2 resolves model params from that mutated source-ledger state.

The earlier two suspected mechanisms remain useful forensic checkpoints:
`applyPromotion` still runs twice on the analyse path, and FE topo still runs
twice. But the corrected root-cause chain is stronger: the first CF pass has
escaped the current-answer layer and entered the source/promotion layer via
the fast-path merge. That escape makes the second pass genuinely different,
not merely numerically noisy.

## Why the gap has widened post-F4

73f §F4 (28-Apr-26) measured the same canary at delta ≤4.79e-3. Two changes that landed since are candidates for amplification:

1. **fc728829 (29-Apr-26)** — `statisticalEnhancementService.ts` non-latency-edge gating per I-21/AP-18. Path-composition contributions from non-latency edges now produce identity (δ(0)) instead of folding their bouncey onset into `path_mu/path_sigma`. For synth-lat4 c→d the immediate carrier b→c is latency, but the change re-shapes path composition more broadly and may shift the second FE topo's recency-weighted fit relative to the first.
2. **30-Apr-26 posterior unification** — the `applyPromotion` rewrite makes `p.posterior` and `p.latency.posterior` source-agnostic projections written exclusively by promotion. The second `applyPromotion` call inside `recontextScenarioGraph` now exercises this single-writer contract; whether the projection it produces is bit-identical to the first call's projection on the same `model_vars` is the open question.

Neither change is itself a bug. Each is a contract-aligned refactor. But each adds a step in the two-pass pipeline whose idempotency must hold — and the post-F4 widening is consistent with their cumulative effect breaking idempotency further.

## Required forensic before any fix

The cheapest forensic remains a bit-level diff of the graph state at three
points along the analyse CLI path on the failing query (synth-lat4 c→d window
or identity-collapse cohort):

- **Snapshot A**: graph immediately after `aggregateAndPopulateGraph` returns (= param-pack's extraction state).
- **Snapshot B**: graph after `recontextScenarioGraph` (post second `applyPromotion`).
- **Snapshot C**: graph after `materialiseScenarioFeTopo` (post second FE topo, pre second CF).

For each snapshot, capture the relevant edge's `p.latency.{mu, sigma, t95, completeness, onset_delta_days, posterior}` and `model_vars[*].{probability, latency}`. The diff between A and B isolates `applyPromotion`'s second-call non-idempotency. The diff between B and C isolates the second FE topo's effect. The CF response from the analyse path's second CF call provides the symptom magnitude attributable to whichever differences appeared.

Add one extra field family to that diff: compare `p.forecast.*` and
`model_vars[analytic].probability.*` before and after CF #1. If those fields
move towards CF `p_mean`, the fast-path leak is confirmed directly.

The diff is still useful to quantify how much each mutation contributes, but
the existence of the fast-path leak is already code-traced. Fix sequencing no
longer needs to wait for a bit-level diff before addressing the mapping
contract violation.

## Sequencing — what 73g invariant 7 demands

The contract violation is structural: two surfaces reading the same field for the same query produce different numbers. The fix shape must restore numerical agreement, not paper over it with a tolerance widening.

Four fixes now follow:

1. **Remove the pre-analysis graph-mutating CF call from `analyse.ts`**.
   `analyse` should not call `aggregateAndPopulateGraph` if the purpose is to
   prepare a request graph for BE analysis. It should hand raw per-scenario
   graphs plus scenario DSLs to `prepareAnalysisComputeInputs`; that service
   owns request-graph materialisation and intentionally suppresses CF during
   FE topo materialisation. The requested BE analysis then runs exactly once
   through `runPreparedAnalysis`.

2. **Collapse graph-mutating CF response mapping to one implementation**.
   The race path may remain a distinct invocation/orchestration path, but it
   must call the same mapping contract as the slow/direct path. The codebase
   should not contain a hand-rolled `mergeCfIntoFe` mapping that can drift from
   `applyConditionedForecastToGraph`.

3. **Remove the `p_mean → forecast.mean` / source-ledger leak**. CF must not
   write `p.forecast.*` or mutate `model_vars[*]` through `UpdateManager`.
   `forecast.mean` remains promoted baseline, computed from `model_vars` by
   `applyPromotion`.

4. **Align dispersion mapping with the canonical direct path**:
   `p_sd → p.stdev_pred`, `p_sd_epistemic → p.stdev`.

5. **Keep idempotent materialisation as the longer-term direction, but do not
   use it as a substitute for fixing the layer violation**. Even if
   `runScenarioMaterialisation` becomes idempotent, the fast-path response
   mapping still must obey the L1/L2/L5 contract.

Fixes 1–4 should close the two canaries in this note. Fix 5 prevents the same
defect class from reappearing as more caller shapes move onto the shared
materialisation boundary.

### Implementation Checklist

This note, not 73i, owns the implementation plan for these two canaries.
73i is the shared evidence-merge design; this work is a prerequisite cleanup
of CF invocation and response mapping, not an evidence-merge stage.

Implementation should cover:

- `graph-editor/src/cli/commands/analyse.ts`: remove the pre-analysis
  `aggregateAndPopulateGraph` call for BE analysis execution. The command
  should pass raw per-scenario graphs plus effective DSLs into
  `prepareAnalysisComputeInputs`, then call `runPreparedAnalysis`.
- `graph-editor/src/services/fetchDataService.ts`: remove the local divergent
  CF response mapping from the 500ms race fast path.
- `graph-editor/src/services/conditionedForecastService.ts`: expose or share
  the canonical CF response-to-graph-update mapping so the race path and the
  slow/direct path cannot drift.
- `graph-editor/src/services/UpdateManager.ts`: change only if the shared
  mapper needs a narrower update shape that can express CF current-answer
  writes without touching `forecast` / source-ledger fields.
- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`: keep the two
  outside-in canaries as acceptance tests.
- Existing TS contract tests around `applyConditionedForecastToGraph`: extend
  them, or add adjacent tests, to pin that fast-path and direct-path mapping
  are identical.

Acceptance criteria:

- `test_cli_identity_collapse_matches_window_across_public_surfaces` passes.
- `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` passes.
- A focused TS test proves that the CF race fast path does not mutate
  `p.forecast.*` or `model_vars[analytic].probability.*`.
- A focused TS test proves that the race fast path and direct path agree on
  dispersion mapping: `p_sd` is predictive and `p_sd_epistemic` is epistemic.
- A CLI analyse-path test or integration assertion proves `analyse` does not
  invoke graph-mutating CF before `runPreparedAnalysis`.
- Existing param-pack behaviour remains valid: param-pack may still run the
  fetch pipeline and graph-mutating CF because its purpose is to extract graph
  scalar state, not to prepare a render-only BE analysis request.

## Tests expected to close

- `test_cli_identity_collapse_matches_window_across_public_surfaces` — pack
  vs cf parity assertion in `_assert_public_scalar_parity`. Currently 22e-3
  over the 1e-4 budget.
- `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`
  — pack vs cohort-maturity last-row completeness parity. Currently 62e-3.

Both are direct readouts of the same defect class on the same fixture
(synth-lat4 c→d). They should turn green once analyse stops pre-running
graph-mutating CF and the fetch-pipeline race path uses the same CF response
mapping as the direct path.

## Out of scope — separate concerns

This doc does not address:

- **Test 5** (`test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`). The carrier-active-cohort completeness shift is too small (0.011 vs required ≥0.02). Mechanism is distinct: BE-side `cdf_arr` at [`forecast_state.py:1043-1052`](../../graph-editor/lib/runner/forecast_state.py) reads only the subject edge's `(μ, σ, onset)` and never the path-level equivalents (`path_mu`, `path_sigma`, `path_onset`) even when a real upstream carrier is in play. So the carrier b→c on synth-lat4 contributes nothing to the BE's completeness scalar. This is a missing-input defect, not a parity-canary drift, and warrants its own forensic / investigation doc.
- **Test 6** (`test_v3_midline_at_saturation_converges_to_p`). Defect 1 is fixed (verified [`forecast_state.py:745`](../../graph-editor/lib/runner/forecast_state.py)); residual gap is Defect 2 per [`cohort-maturity-v3-midline-collapse-investigation.md`](../cohort-maturity-v3-midline-collapse-investigation.md), which calls for instrumentation before any model-shape fix.
- **Tests 1, 2** (`test_single_hop_non_latent_upstream_collapses_to_window`). Distinct mechanism — the cohort obs_x fallback at [`cohort_forecast_v3.py:752`](../../graph-editor/lib/runner/cohort_forecast_v3.py) produces zero or carry-forward when no per-τ snapshot observation exists, while window primes at `raw_n_i`. The factorised carrier branch that would handle this is gated off at [`forecast_runtime.py:1052`](../../graph-editor/lib/runner/forecast_runtime.py) by `has_semantic_upstream_latency` — a gate the [`factorised-carrier-replumb-plan.md`](../factorised-carrier-replumb-plan.md) §4.2 proposes to widen but has not landed.

## Open questions

- Does `applyPromotion` produce bit-identical output across consecutive calls
  on the same `model_vars[*]`? On synth-lat4 (analytic-only) and on graphs
  with bayesian sources?
- Does the second FE topo run in `materialiseScenarioFeTopo` produce
  bit-identical `(μ, σ, onset)` to the first run inside
  `aggregateAndPopulateGraph`, after the fast-path CF mapping leak is fixed?
- Is the laggard-caller rationale for `runScenarioMaterialisation` still
  load-bearing for any CLI analyse path once `analyse.ts` stops pre-running
  `aggregateAndPopulateGraph`?
- Are there other CF response mapping sites besides `mergeCfIntoFe` and
  `applyConditionedForecastToGraph`? If yes, they must be audited against the
  same L1/L2/L5 mapping contract.
