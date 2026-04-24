# 75 — Execution Plan for FE/CLI Conditioned-Forecast Parity Repair

**Date**: 24-Apr-26
**Status**: Active implementation plan
**Audience**: engineers executing the next FE/CLI parity repair
**Relates to**:
`72-fe-cli-conditioned-forecast-parity-fix-plan.md`,
`74-doc-72-scope-correction.md`,
`../codebase/PARAMETER_SYSTEM.md`,
`../codebase/SCENARIO_SYSTEM_ARCHITECTURE.md`,
`../codebase/STATS_SUBSYSTEMS.md`

## 1. Purpose

Doc 72 described three defects that together produced FE/CLI divergence in
conditioned-forecast (CF) analysis. After the reversion, doc 74 narrowed the
follow-up scope: keep the FE quick topo pass, keep the current scenario
storage model (thin ordered param-pack deltas), but fix the three defects
that actually break parity.

This doc is the step-by-step plan for that narrowed pass. It names the
files, fields, and behaviours to change, and gives a rationale for each
change so an engineer can judge edge cases without re-reading docs 72 and
74.

Out of scope: redesigning the FE topo pass, renaming probability fields
project-wide, redesigning the statistical source taxonomy, replacing the
scenario store with persisted per-scenario graphs.

## 2. The three defects this plan closes

### Defect 1 — FE writes a query-scoped scalar into the model-bearing slot

`edge.p.mean` is the flat scalar that the Python runtime treats as the
edge's canonical probability. When the FE topo pass runs inside
[statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts),
it computes `blendedMean` — a blend of scoped evidence and the baseline
forecast for the *current query only* — and then
[UpdateManager.applyBatchLAGValues](graph-editor/src/services/UpdateManager.ts)
writes that scalar into `edge.p.mean`. Doc 72 traced this chain end to end:

```
scoped blendedMean → edge.p.mean → scenario.graph → BE forecast_runtime._resolve_edge_p → carrier reach
```

Because `edge.p.mean` is read by the upstream carrier reach calculation in
[forecast_state.py](graph-editor/lib/runner/forecast_state.py), a
query-scoped display estimate pollutes the model input of the very query
that produced it. The problem is not that the FE computes a provisional
answer — it is that the provisional answer lives in the same field the
runtime treats as "the edge's probability".

### Defect 2 — Python uses two different probability-source rules

For the target edge, the runtime calls
[`resolve_model_params`](graph-editor/lib/runner/model_resolver.py) which
follows a defined source order: cohort posterior → window posterior →
forecast → evidence-derived fallback.

For the upstream carrier (the edges on the path into the target), the
runtime calls
[`_resolve_edge_p`](graph-editor/lib/runner/forecast_state.py) which reads
`edge.p.mean` first. So inside the same solve, the target edge and its
upstream carriers can disagree about which source to use for the *same
edge's* probability — and the carrier path is exactly the one that
Defect 1 poisons.

### Defect 3a — CF supersession is global, not per-scenario

[fetchDataService.ts](graph-editor/src/services/fetchDataService.ts) holds a
module-global counter `_conditionedForecastGeneration`. Before a CF call
fires, the counter is incremented and the current value captured as
`cfGen`. When the response returns, it is discarded if
`cfGen !== _conditionedForecastGeneration`.

This cancels late responses across *all* scenarios. If Current and a live
scenario both have an in-flight CF, whichever fires second cancels the
first, even though they should be independent. Supersession must be
per-scenario.

### Defect 3b — Scenario packs cannot rebuild a faithful graph

Scenarios are thin param-pack deltas. To analyse a scenario,
[analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts)
takes the baseline graph and replays the ordered packs onto it via
[CompositionService.applyComposedParamsToGraph](graph-editor/src/services/CompositionService.ts).

Two problems:

- The extractor
  ([GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts))
  does not serialise `p.n` (the sample count driving evidence-derived
  fallback).
- The compositor does not replay `p.posterior.*`, `p.n`, or
  `conditional_p`, even when they are present in the pack.

Rebuild diverges from the working graph on exactly the fields the runtime
reads, so FE and CLI can produce different analyses from the same scenario
input.

### Defect 3c — `_posteriorSlices` is a graph-side stash for historical depth

[mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
stashes the full file-level posterior inventory (including `fit_history`)
on each edge as `edge.p._posteriorSlices` when a parameter file is loaded.
[`reprojectPosteriorForDsl`](graph-editor/src/services/analysisComputePreparationService.ts)
reads this stash to re-project posteriors for asat queries.
[epistemic_bands.py](graph-editor/lib/runner/epistemic_bands.py) reads it
for historical band resolution.

This stash is file-depth data living on the graph. It is not part of the
scenario pack and is not meant to be — but it is the current workaround for
consumers that need historical posterior depth. These consumers must be
moved to file-backed resolution before the stash is removed.

The target-edge posterior-mass witness from doc 72 (`alpha=328.66`,
`beta=57.38` appearing with no integer-count provenance) also remains open.
This plan keeps it as a live witness but does not assume it will be
resolved by these stages.

## 3. Binding design rules (constraints on all solutions)

1. **Parameter files are the authoritative store.** They keep the full
   posterior slice inventory, fit history, retrieval metadata, and the
   model-source ledger. Nothing the FE or CLI does may shift that
   authority.

2. **The graph holds structure plus current projection.** "Current
   projection" means the active scenario's scalars: `p.mean`, `p.stdev`,
   `p.posterior.*`, `p.evidence.*`, `p.forecast.*`, `p.latency.*`, `p.n`,
   node overrides, `conditional_p`, plus the active entries in
   `p.model_vars[]`. It is not the long-term home for raw slice
   inventories.

3. **The FE topo pass may compute a provisional display answer**, but that
   answer must not occupy the same slot that the runtime reads as model
   input. Runtime input means `edge.p.mean`, `edge.p.model_vars[]`, and
   `edge.p.posterior.*`.

4. **Scenarios stay as thin ordered param-pack deltas.** Layer order is
   semantically load-bearing — later deltas override earlier ones. No
   scenario is a stored graph.

5. **Scenario packs may carry only the active projection** needed for
   rebuild. They may not carry raw `posterior.slices`, full
   `p.model_vars[]` inventory, or `fit_history`.

6. **CF supersession is per-scenario, in tab-scoped scenario state.** Not a
   module-global counter.

7. **`conditional_p` is part of the pack contract and must replay.**

## 4. Sequencing rules (why the stages are ordered this way)

- **Extractor and compositor must be faithful before `_posteriorSlices` is
  retired.** Otherwise consumers lose their only source of posterior depth
  and analysis breaks.
- **The FE model-slot split (Stage 1) and the Python resolver unification
  (Stage 2) must land before the pack contract is frozen (Stage 4).**
  Freezing the pack surface while `edge.p.mean` still carries a
  query-scoped scalar locks in the wrong field semantics.
- **Do not widen scenario packs with raw posterior inventory** as a
  shortcut. If a consumer still needs file-depth state, move the consumer
  to file-backed resolution instead.
- **Per-scenario CF supersession (Stage 3) stays in its own commit group.**
  It shares no code surface with the pack-contract work and must remain
  separately bisectable.

## 5. Stage 1 — Separate the FE provisional display answer from model-bearing state

### Why

Defect 1. `edge.p.mean` is currently overloaded: the FE topo pass writes a
query-scoped blend into it, and the Python runtime later reads it as the
edge's model probability. The two roles must live in two different slots.

### Changes

1. In
   [statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts),
   split the topo pass outputs into two named streams:
   - A **model-bearing output** — the FE analytic fallback model, written
     as an entry in `edge.p.model_vars[source='analytic']` plus the
     appropriate promoted latency scalars. This is the fallback the runtime
     may consume when no better source is available.
   - A **display-only output** — any provisional scalar the UI needs to
     render before CF arrives. If this output is kept at all, it must be a
     new field that is explicitly not read by any runtime path. Reasonable
     names: `edge.p.displayMean`, `edge.p._provisional.mean`. The exact
     name is a decision for the implementer; what matters is that the
     field is documented as display-only and not in the set read by
     `resolve_model_params` or `_resolve_edge_p`.

2. In
   [UpdateManager.ts](graph-editor/src/services/UpdateManager.ts), change
   `applyBatchLAGValues` so it no longer writes the FE `blendedMean` scalar
   into `edge.p.mean`. `edge.p.mean` becomes writable only by
   (a) promotion from `model_vars` (the existing promotion cascade) and
   (b) CF result application
   ([conditionedForecastService.ts](graph-editor/src/services/conditionedForecastService.ts)).

3. In
   [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts),
   ensure the CF snapshot builder
   ([conditionedForecastGraphSnapshot.ts](graph-editor/src/lib/conditionedForecastGraphSnapshot.ts))
   reads `edge.p.model_vars`, `edge.p.posterior.*`, and `edge.p.mean` (if
   present from a previous CF) — never the new display-only field.

4. Audit every consumer that currently reads `edge.p.mean` on the FE side.
   If any relied on the query-scoped blend, move it to either
   (a) `edge.p.model_vars` with explicit source selection, or
   (b) the new display-only field.

### Stage gate

- Two narrow queries over the same edge with different scoped evidence
  produce different display-only scalars but the same model-bearing entry
  in `edge.p.model_vars[source='analytic']`.
- Changing the display-only field alone does not change the scenario graph
  bytes sent to the BE.

## 6. Stage 2 — Unify Python probability resolution

### Why

Defect 2. Target-edge and upstream-carrier paths in the BE currently use
different rules for reading an edge's probability. One calls
`resolve_model_params`, the other reads `edge.p.mean` first via
`_resolve_edge_p`. The split lets a poisoned `edge.p.mean` change carrier
reach even when the target-edge resolution correctly prefers the posterior.

### Changes

1. Route the upstream-carrier path through the same resolver contract as
   the target edge. In
   [forecast_state.py](graph-editor/lib/runner/forecast_state.py), replace
   `_resolve_edge_p`'s `p.mean`-first logic with a call to
   `resolve_model_params` (or a shared helper extracted from it). The
   resolver must return the same winning source for the same edge
   regardless of which caller asks.

2. In
   [forecast_runtime.py](graph-editor/lib/runner/forecast_runtime.py),
   update `build_x_provider_from_graph` and the reach-building helpers so
   the probability used to multiply incoming reach by edge probability
   comes from the unified resolver, with provenance attached.

3. Audit every other runtime path that reads edge probability directly
   from flat fields — in
   [cohort_forecast_v3.py](graph-editor/lib/runner/cohort_forecast_v3.py),
   [api_handlers.py](graph-editor/lib/api_handlers.py), and any
   resolver-adjacent helper. Route every such read through the unified
   contract.

4. Expose source provenance on the resolver output so tests can assert
   which source won for each edge role.

### Stage gate

- For any edge, the target-edge path and the upstream-carrier path report
  the same winning probability source (posterior / forecast / evidence
  fallback / etc) for the same temporal mode.
- Mutating only `edge.p.mean` (or the Stage 1 display-only field) does not
  change carrier reach, latency tier selection, or the v3 trajectory when
  no better source is promoted.

## 7. Stage 3 — Move CF supersession to scenario scope

### Why

Defect 3a. The module-global
`_conditionedForecastGeneration` counter in
[fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
cancels legitimate responses whenever a different scenario fires a newer
request. Current and live scenarios should be able to have overlapping CF
requests.

### Changes

1. Move the "latest commission" record out of module scope and into
   tab-scoped scenario state. The natural home is
   [ScenariosContext.tsx](graph-editor/src/contexts/ScenariosContext.tsx)
   — add a `Map<scenarioId, generation>` or per-scenario counter field.

2. Thread an explicit `scenarioId` through every CF entry point:
   - FE call sites in
     [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
     must pass the scenario ID that is commissioning this CF.
   - [conditionedForecastService.ts](graph-editor/src/services/conditionedForecastService.ts)
     must stop defaulting to the literal string `'current'` for
     graph-surface orchestration. The only caller allowed to use
     `'current'` as a default is the Current tab itself.

3. The stale-response check becomes: apply a returning CF result only if
   the generation it carries still matches the latest generation recorded
   for *its own scenarioId*. Responses for scenario A never cancel because
   scenario B ran later.

4. Keep the existing 500ms fast-path / slow-path race semantics unchanged.
   This stage changes ownership of the supersession check only. It does
   not change which field CF writes to (that is part of Stage 1), nor the
   race timing.

### Stage gate

- Current and at least one live scenario can have overlapping CF requests
  without cancelling each other.
- A late CF response for scenario A is discarded only when a newer CF
  commission for scenario A exists. Scenario B's activity does not cancel
  scenario A's responses.

## 8. Stage 4 — Freeze the minimal scenario projection contract

### Why

Before extractor and compositor changes (Stage 5), the contract they serve
must be written down explicitly. Today the "which fields should a scenario
pack carry" question is answered implicitly by extractor whitelists and
compositor switch statements, and they disagree.

### Changes

1. Determine the consumer set for scenario-built graphs:
   - FE scenario rendering
     ([analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts)).
   - CLI analysis prep
     ([analyse.ts](graph-editor/src/cli/commands/analyse.ts)).
   - Any display path that reads a scenario-built graph (not a parameter
     file) directly.

2. Write the minimal projection contract — the exact list of fields
   scenario packs must carry. The list follows from the consumer audit,
   but as a starting point:

   **Included** (model-bearing fields the runtime reads):
   - `p.mean`, `p.stdev`
   - `p.posterior.{alpha, beta, hdi_lower, hdi_upper, ess, rhat,
     fitted_at, fingerprint, provenance}` plus cohort-slice variants
   - `p.evidence.{mean, stdev, n, k}`
   - `p.forecast.{mean, stdev}`
   - `p.latency.{mu, sigma, t95, path_t95, promoted_*_sd, completeness,
     completeness_stdev, median_lag_days}` plus latency posterior
   - `p.n`
   - `conditional_p` (same shape per condition, including posterior and
     evidence blocks)
   - node `entry.entry_weight`
   - node `case.variants`

   **Excluded** (file-depth or source-ledger data):
   - `p.model_vars[]` (source inventory — lives on graph, reconstructed on
     fetch; not carried in packs)
   - raw `p.posterior.slices[]` and `p._posteriorSlices` (file-depth slice
     inventory)
   - `p.fit_history[]` (file-only)
   - `p.evidence.{scope_from, scope_to, source, retrieved_at}` (retrieval
     metadata)
   - `p.latency.{latency_parameter, anchor_node_id}` (config)

   **Conditionally included**: `p.forecast.k` is not admitted by default.
   It is added to the contract only if the Stage 5 consumer audit proves
   a live consumer needs it *after* `p.n` replay is fixed (because `k`
   can be derived from `p.n` times `p.mean` for many purposes).

3. Write the contract into three places that must agree:
   - The `ProbabilityParam` / `EdgeParamDiff` / `NodeParamDiff` types in
     [scenarios.ts](graph-editor/src/types/scenarios.ts).
   - Comments at the top of
     [GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts)
     next to the whitelists.
   - A contract section in
     [SCENARIO_SYSTEM_ARCHITECTURE.md](../codebase/SCENARIO_SYSTEM_ARCHITECTURE.md).

### Stage gate

The contract list exists in exactly one canonical place (the types file),
with pointers from the extractor comments and the docs. The extractor
whitelist, compositor switch, and types match it field for field.

## 9. Stage 5 — Make extraction and replay faithful to the Stage 4 contract

### Why

Defect 3b. Today's extractor drops `p.n`; today's compositor drops
`p.posterior.*`, `p.n`, and `conditional_p`. Scenario rebuild cannot match
the working graph on fields the runtime reads.

### Changes

1. Update
   [GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts)
   to serialise every Stage 4 contract field currently missing. At
   minimum this is `p.n` on each edge. The extractor's existing whitelist
   pattern
   (`PROBABILITY_POSTERIOR_FIELD_WHITELIST` and similar) is the correct
   seam — extend the whitelists.

2. Update
   [CompositionService.applyComposedParamsToGraph](graph-editor/src/services/CompositionService.ts)
   to replay every Stage 4 contract field that the pack can now carry. At
   minimum:
   - `p.posterior.*` (currently unhandled).
   - `p.n` (currently unhandled).
   - `conditional_p` (currently marked TODO at line ~215 — finish it).

3. Leave
   [`buildGraphForAnalysisLayer`](graph-editor/src/services/CompositionService.ts)
   behaviour unchanged with respect to the non-cumulative composition
   rule. This stage is about fidelity of rebuild, not about restacking
   layers.

4. Only change
   [ScenariosContext.tsx](graph-editor/src/contexts/ScenariosContext.tsx)
   if the extractor/compositor fixes still leave fields missing from the
   regenerated pack. The existing regeneration flow (temp working graph →
   diff pack via `extractDiffParams`) stays. Do not persist whole working
   graphs.

### Stage gate

For a regenerated live scenario, the temporary working graph and the graph
rebuilt from `baselineGraph + composed scenario pack` match field-by-field
on every Stage 4 contract field. A byte-level diff of the two graphs (on
the contracted fields) is empty.

## 10. Stage 6 — Move posterior projection authority off `_posteriorSlices`

### Why

Defect 3c. Stages 4 and 5 make scenario packs carry the active
`p.posterior.*` block. Once that works, the `edge.p._posteriorSlices`
stash is no longer needed for scenario rebuild. Removing it eliminates a
file-depth stash living on the graph.

But there are still consumers reading it. They must be migrated first.

### Changes

1. For live scenarios: make scenario regeneration in
   [ScenariosContext.tsx](graph-editor/src/contexts/ScenariosContext.tsx)
   finalise the active posterior projection for the scenario's effective
   DSL *before* pack extraction. This means the temp working graph already
   has the right `p.posterior.*` block at the moment the diff pack is
   computed.

2. For the `current` scenario: keep the existing file-to-graph projection
   path (driven by
   [mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
   Flow G) as the source of the active posterior projection. Do not add a
   parallel Current-specific cache.

3. Remove
   [`reprojectPosteriorForDsl`](graph-editor/src/services/analysisComputePreparationService.ts)
   once rebuilt graphs already carry the correct active posterior
   projection. This removes the last FE consumer of `_posteriorSlices`
   for scenario preparation.

4. Migrate
   [epistemic_bands.py](graph-editor/lib/runner/epistemic_bands.py) and
   any other BE reader off `_posteriorSlices`. If a BE path needs
   historical posterior depth (for asat or for historical bands), resolve
   that depth from the parameter files or from the backend-side parameter
   loading — not from the graph. The backend already has access to the
   authoritative files; it should read them directly rather than depending
   on FE state stashed on an edge.

5. Only after the last active reader is migrated, remove the
   `_posteriorSlices` write from
   [mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
   (Flow G) and clean up the corresponding delete/clear paths in
   [bayesPriorService.ts](graph-editor/src/services/bayesPriorService.ts).

### Stage gate

- No live analysis or runtime path reads `edge.p._posteriorSlices`.
  `grep` for `_posteriorSlices` in both FE and BE code returns only the
  removed write path and tests that assert it is absent.
- Freshly built graphs no longer receive a `_posteriorSlices` field from
  the mapping layer.

## 11. Stage 7 — Align CLI and FE on one scenario reconstruction contract

### Why

FE and CLI diverge today because the CLI in
[analyse.ts](graph-editor/src/cli/commands/analyse.ts) uses the last
populated scenario graph as the base graph for later analysis preparation,
while the FE uses per-scenario graphs rebuilt from the baseline plus
packs. With Stages 1–6 landed, both must consume the same contract.

### Changes

1. Keep
   [analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts)
   as the single scenario-build entry point for FE and CLI. Any shared
   request-shape normalisation stays there; no CLI-only equivalent is
   created.

2. Update [analyse.ts](graph-editor/src/cli/commands/analyse.ts) and
   [aggregate.ts](graph-editor/src/cli/aggregate.ts):
   - Stop using the last populated graph as the universal base graph for
     analysis preparation. Every scenario is prepared from the baseline
     graph plus its own ordered scenario packs.
   - Pass explicit scenarioIds through, matching the FE contract — not
     synthetic `'scenario-N'` IDs generated at CLI entry.
   - Use the Stage 5 replay contract exclusively. If the CLI keeps a
     param-pack path for editing or export, that path is separate from the
     analysis path.

3. Verify the other scenario-build surfaces that reuse
   `buildGraphForAnalysisLayer()` — live, custom, share-style consumers —
   all route through the same contract.

### Stage gate

Given the same base graph, the same ordered scenario packs, and the same
effective DSL, FE and CLI produce byte-identical scenario graphs on the
Stage 4 contract fields, and byte-identical BE request payloads.

## 12. Stage 8 — Verification and cleanup

### Why

The repair surfaces from Stages 1–7 each need a regression test that
would fail if the previous defect resurfaced. Without these, the next
refactor in this area silently reintroduces the bug.

### Changes

Add or update targeted tests around the actual repair surfaces:

- Per-scenario CF supersession (Stage 3):
  [fetchDataService.test.ts](graph-editor/src/services/__tests__/fetchDataService.test.ts)
  or adjacent CF tests. Assert that a late response for scenario A is
  accepted when scenario B's generation has advanced.
- Python resolver/runtime parity (Stage 2):
  [test_model_resolver.py](graph-editor/lib/tests/test_model_resolver.py),
  [test_forecast_state_cohort.py](graph-editor/lib/tests/test_forecast_state_cohort.py).
  Assert same winning source for target-edge and upstream-carrier paths on
  the same edge.
- Pack replay fidelity (Stage 5): add or tighten assertions in
  [CompositionService tests](graph-editor/src/services/__tests__/CompositionService.test.ts)
  covering `p.posterior.*`, `p.n`, and `conditional_p` replay.
- Param-pack reconstruction semantics:
  [windowCohortSemantics.paramPack.e2e.test.ts](graph-editor/src/services/__tests__/windowCohortSemantics.paramPack.e2e.test.ts).
- Shared FE rebuild behaviour:
  [liveCustomComputeParity.test.ts](graph-editor/src/hooks/__tests__/liveCustomComputeParity.test.ts).
- CLI parity surfaces (Stage 7): CLI parity tests under
  [graph-editor/src/cli](graph-editor/src/cli/); the analysis-preparation
  tests; any `parity-test.ts` or similar harness.
- `_posteriorSlices` cleanup (Stage 6):
  [bayesPriorService.integration.test.ts](graph-editor/src/services/__tests__/bayesPriorService.integration.test.ts)
  and related tests must no longer assert `_posteriorSlices` as a live
  graph contract. Add a negative assertion: fresh graphs have no
  `_posteriorSlices` field.

Keep the target-edge posterior-mass witness from doc 72 alive through all
eight stages. The witness is the observation that bracket analyses see
`alpha=328.66`, `beta=57.38` on the target edge with no integer-count
provenance. This plan does not claim the witness will be resolved by the
work above; it must simply not be quietly dropped from the regression
pack. If it does resolve during one of the stages, capture in that
stage's commit message why.

Do not replace one graph-stash dependency with a test suite that
snapshots file-depth posterior inventory back onto graphs. Tests must
assert the contract, not the old mechanism.

### Stage gate

Every stage has at least one targeted regression test or parity artefact
that would fail if the stage's defect resurfaced.

## 13. Commit groups

The work lands in seven separately bisectable commit groups:

1. Stage 1 — FE provisional-answer / model-bearing split (TS only).
2. Stage 2 — Python resolver unification (Python only).
3. Stage 3 — Per-scenario CF supersession (TS only; independent of 1 and
   2).
4. Stage 4 + Stage 5 — Pack contract freeze plus extractor/compositor
   fidelity (TS only; coupled because the contract constrains the
   extractor/compositor and they must move together).
5. Stage 6a — Migration of active `_posteriorSlices` consumers. The old
   stash may still be written temporarily as shadow support.
6. Stage 6b — Removal of `_posteriorSlices` write/read paths, including
   mapping and cleanup code.
7. Stage 7 + Stage 8 — CLI parity closure, remaining verification tests,
   doc updates.

## 14. Stop rules (abort signals)

- **If a stage requires persisting full scenario graphs** to succeed, the
  stage is mis-scoped. Stop and re-read doc 74.
- **If a consumer appears to need raw posterior inventory on the graph**
  to work, migrate that consumer to file-backed resolution. Do not widen
  the graph or the pack.
- **If Stage 1 cannot cleanly name which field is authoritative for
  runtime input** — i.e. cannot split display-only from model-bearing
  with a named field — stop. The pack contract work downstream depends on
  that boundary being explicit.
- **If the Stage 5 diff reveals a live scenario consumer reading a field
  not in the Stage 4 contract**, add the field to the contract explicitly,
  name the consuming path in the commit message and the docs, then
  proceed.
- **If the target-edge posterior-mass witness changes value during any
  stage**, capture the change in that stage's commit message. Do not
  assume the change means the underlying defect is fixed — it may have
  only moved.

## 15. Acceptance gates (plan is complete when all true)

1. The FE provisional display answer cannot rewrite `edge.p.mean`,
   `edge.p.model_vars`, or any other field the Python runtime reads as
   model input.
2. The Python runtime uses one resolver contract for every edge
   probability read — target-edge and upstream-carrier paths agree on the
   winning source.
3. CF supersession is per-scenario. Current and live scenarios do not
   cancel each other's CF responses.
4. Scenario packs carry only the Stage 4 contract fields. No pack
   contains full graphs, `p.model_vars[]` inventory, raw
   `p.posterior.slices`, or `p.fit_history`.
5. A rebuilt scenario graph matches the working graph byte-for-byte on
   the Stage 4 contract fields.
6. `edge.p._posteriorSlices` is not part of any live runtime or analysis
   path. It is neither written nor read.
7. FE and CLI produce identical prepared scenario graphs and identical BE
   request payloads from the same base graph, scenario packs, and
   effective DSL.
8. The target-edge posterior-mass witness is explicitly resolved
   (with stage/commit attribution) or explicitly carried forward as
   separate work. It is not silently dropped.
