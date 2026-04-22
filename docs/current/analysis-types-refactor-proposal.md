# Analysis-Types Refactor Proposal

**Author**: 18-Apr-26  
**Updated**: 22-Apr-26  
**Status**: Final draft, ready to schedule  
**Primary references**: [docs/current/codebase/adding-analysis-types.md](./codebase/adding-analysis-types.md), [docs/current/project-bayes/55-surprise-gauge-rework.md](./project-bayes/55-surprise-gauge-rework.md), [docs/current/project-bayes/59-cohort-window-forecast-implementation-scheme.md](./project-bayes/59-cohort-window-forecast-implementation-scheme.md), [docs/current/project-bayes/60-forecast-adaptation-programme.md](./project-bayes/60-forecast-adaptation-programme.md), [docs/current/codebase/ANALYSIS_TYPES_CATALOGUE.md](./codebase/ANALYSIS_TYPES_CATALOGUE.md)

---

## Summary

This proposal is the plumbing follow-on to the forecast-adaptation work,
not a competing semantic design. Docs 59 and 60 now define and implement
the shared forecast-consumer contract. What remains here is the
analysis-type registration and response-plumbing debt: too many
hardcoded lists, too many partially-overlapping registries, and too many
places where an analysis type can be silently dropped or mis-routed even
when the underlying computation is correct.

The target is simple:

- one canonical FE registry for analysis-type metadata
- one canonical BE registry for snapshot-envelope dispatch metadata
- one standard FE normaliser factory for snapshot-envelope responses
- no hidden lookup tables for chart kinds, snapshot boot, or
  analysis-type-specific routing

The refactor should reduce file-touch count, but the real goal is
stronger invariants. Adding a new analysis type should stop being a
search exercise across unrelated files.

---

## Why this note still matters

When this note was first drafted, the analysis-types problem and the
forecast-consumer problem were still intertwined. That is no longer the
right framing.

The forecast-consumer seam has now moved:

- doc 59 is the active target contract for shared runtime objects,
  projection surfaces, and first-class forecast consumers
- doc 60 is the active implementation record and acceptance checklist for
  that workstream

This proposal therefore no longer designs forecast semantics. It assumes
those semantics are binding and already live. Its job is narrower:

- finish the catalogue/registry consolidation on the FE
- consolidate BE snapshot-envelope dispatch metadata
- standardise the FE-side snapshot normalisation contract
- preserve the load-bearing asymmetries that the current system depends on

The surprise-gauge work remains highly relevant, but as evidence about
response shape and projection boundaries, not as permission to reopen the
forecast runtime design.

---

## Current live state

The codebase is not starting from zero. The important current shape is:

- `graph-editor/src/components/panels/analysisTypes.ts` is already a real
  FE metadata source for identity, labels, icons, snapshot contracts,
  dev/internal flags, some view-kind declarations, and minimised
  renderers
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts` is already a
  real registry for chart-kind display settings and compute-affecting
  flags
- many UI surfaces already read `analysisTypes.ts` directly for names,
  icons, kind pickers, and snapshot-capability checks
- the surprise-gauge multi-scenario normalisation path has already
  established a useful seed contract for preserved scenario structure via
  `scenario_results` and `focused_scenario_id`

The remaining drift is concentrated in a smaller, but still important,
set of seams:

- chart-kind availability and FE augmentation in
  `analysisTypeResolutionService.ts`
- chart-kind aliases, labels, inference, and subject-selector policy in
  `AnalysisChartContainer.tsx`
- snapshot-needed and snapshot-boot decisions in
  `useCanvasAnalysisCompute.ts`, `analysisBootCoordinatorService.ts`, and
  `snapshotBootTrace.ts`
- hardcoded snapshot normaliser waterfalls in
  `graphComputeClient.ts`
- BE scope/read-mode tables in `analysis_subject_resolution.py`
- BE snapshot derivation dispatch branches in `api_handlers.py`
- small CLI mirrors such as `src/cli/analysisTypeRegistry.ts` and
  `src/cli/commands/parity-test.ts`

The right mental model is therefore not "invent a registry". It is
"finish consolidating the registry surfaces that already exist, and stop
creating new side tables".

---

## Problem statement

The current debt has three distinct parts.

### 1. Catalogue metadata is split across unrelated consumers

The same analysis-type facts are still reconstructed in multiple places:
name and icon in one file, chart kinds in another, snapshot boot in a
third, subject-selection behaviour in a fourth, and snapshot dispatch
metadata on the Python side in two more. This is classic catalogue drift.

### 2. Analysis type, chart kind, and consumer family are being conflated

They are different axes:

- **analysis type** answers "what question are we asking?"
- **chart kind** answers "how are we rendering the result?"
- **consumer family** answers "which semantic runtime/projection family
  does this surface belong to?"

The refactor must not collapse these into one concept. In particular:

- chart builders are chart-kind concerns, not analysis-type concerns
- snapshot-backed compute is sometimes analysis-type-specific, but in
  some cases it is analysis-type × chart-kind specific
- forecast-consumer semantics are a separate, already-designed layer from
  docs 59 and 60

### 3. Response normalisation is still analysis-type-by-analysis-type

The snapshot normalisers in `graphComputeClient.ts` are now one of the
largest remaining boilerplate clusters. The problem is not merely
duplication. It is that projection decisions such as:

- what becomes a flat `data` row
- what remains preserved per scenario
- what counts as display-only projection
- which fields belong in `dimension_values`

are currently re-specified by hand. The surprise-gauge work showed that a
flat row set alone is not enough for all consumers.

---

## Load-bearing constraints

The refactor must preserve the following constraints.

### Forecast semantics are an input, not design scope

This work must consume the contracts in docs 59 and 60. It must not
re-litigate shared preparation, runtime-object roles, regime selection,
or multi-hop `window()` / `cohort()` semantics.

### FE snapshot planning, BE snapshot dispatch, and FE snapshot normalisation are three different signals

The current system only works because these signals are not identical.
The refactor must model them explicitly rather than accidentally merging
them.

The key counterexample is `conversion_funnel`:

- on the FE, it needs snapshot-adjacent preparation because the request
  must carry `candidate_regimes_by_edge`
- on the BE, it must **not** route through the snapshot-subject handler
- on the FE response side, it does **not** use the snapshot-envelope
  normaliser path

Any registry design that cannot represent that asymmetry is wrong.

### Snapshot need is sometimes analysis-type × chart-kind, not analysis-type alone

`branch_comparison` and `outcome_comparison` only need snapshot-backed
compute when the selected chart kind is `time_series`. Their bar/pie
variants should continue to use the standard path-runner pipeline.

This means the registry must be able to answer both:

- "is this analysis type snapshot-capable?"
- "does this particular analysis-type × kind combination require the
  snapshot-backed path?"

### Chart-kind settings remain chart-kind concerns

`analysisDisplaySettingsRegistry.ts` is already the right abstraction for
chart-kind-level controls and compute-affecting flags. This proposal
should not fold that file into the FE analysis-type registry. The FE
registry should reference chart-kind capabilities, not replace the
chart-kind settings registry.

### Pixel output and response semantics must remain stable

This is a refactor. Existing charts and responses should not change their
meaning or visual output during the migration. Regressions are bugs, not
acceptable churn.

---

## Resolved design decisions

The following decisions are now settled for this proposal.

### 1. FE registry source: evolve the existing `analysisTypes.ts`

The canonical FE registry should be the existing
`graph-editor/src/components/panels/analysisTypes.ts`, or a new module
extracted from it with compatibility re-exports. Do not create a second
source of truth and migrate toward it slowly. The current file is already
widely imported and is the natural seed.

### 2. BE registry source: extend `analysis_types.yaml` with an optional snapshot stanza

The BE already has one declarative registry in
`graph-editor/lib/runner/analysis_types.yaml`. That file should remain the
canonical BE home for analysis IDs and runner selection. Snapshot-envelope
types should add an explicit optional snapshot stanza carrying:

- subject scope
- read mode
- derivation identifier
- dispatch mode

Non-snapshot or asymmetric types such as `conversion_funnel` simply omit
that stanza and keep their standard runner path.

### 3. Phase 3 stays FE-side

For this programme, flattening remains an FE normalisation concern.
Pushing flattening into Python would broaden scope, increase migration
risk, and couple this refactor to a public BE response-shape change. The
correct Phase 3 move is an FE normaliser factory plus a clearer preserved
scenario contract.

### 4. Canonical preserved scenario block

The standard preserved scenario block should be `scenario_results`, with
`focused_scenario_id` identifying the default focused scenario when a
surface needs one. This names the thing the FE actually needs and matches
the live surprise-gauge shape. If a later family needs something broader,
that should be a separate change with a concrete second use case.

### 5. Builder dispatch remains chart-kind keyed

The FE analysis-type registry should not point directly at ECharts
builders. Builders are chart-kind infrastructure and should remain owned
by `analysisEChartsService.ts` plus the builder modules. The registry
should instead own:

- valid view/kind combinations
- chart-kind aliases and defaulting rules
- chart-planning hints
- whether a given kind requires snapshots

### 6. Display settings remain a companion registry

`analysisDisplaySettingsRegistry.ts` stays separate. The FE
analysis-type registry should consume it, not absorb it.

---

## Target architecture

### FE target shape

The FE should have one canonical analysis-type registry answering all
analysis-type questions that are not inherently chart-kind-specific.

| Concern | Current owner | Final owner |
|---|---|---|
| id, name, icon, selection hint, dev/internal flags | `analysisTypes.ts` | FE registry |
| minimised renderers and labels | `analysisTypes.ts` | FE registry |
| view_type → valid kind matrix | partly `analysisTypes.ts`, partly scattered | FE registry |
| snapshot planning contract | `analysisTypes.ts` | FE registry |
| chart-kind options and defaulting rules | `analysisTypeResolutionService.ts`, `chartDisplayPlanningService.ts`, `AnalysisChartContainer.tsx` | FE registry helpers |
| chart-kind aliases, labels, inference rules | `AnalysisChartContainer.tsx` | FE registry helpers |
| snapshot-required kind policy | `useCanvasAnalysisCompute.ts`, `analysisBootCoordinatorService.ts`, `snapshotBootTrace.ts` | FE registry helpers |
| subject-selector policy | `AnalysisChartContainer.tsx` | FE registry |
| display settings definitions | `analysisDisplaySettingsRegistry.ts` | stays in companion registry |
| chart builders | `analysisEChartsService.ts` | stays chart-kind keyed |

The FE registry should become the one place a caller asks:

- which kinds exist for this analysis and view
- which of those kinds require snapshot-backed compute
- how a chart kind should be labelled or normalised
- whether this type has a minimised renderer
- whether a type uses subject selection

### BE target shape

The BE should answer snapshot-envelope dispatch questions from one
declarative place instead of split tables and `elif` chains.

| Concern | Current owner | Final owner |
|---|---|---|
| analysis ID, name, `when`, runner | `analysis_types.yaml` | `analysis_types.yaml` |
| snapshot subject scope | `analysis_subject_resolution.py` | optional snapshot stanza in `analysis_types.yaml` |
| snapshot read mode | `analysis_subject_resolution.py` | optional snapshot stanza in `analysis_types.yaml` |
| derivation target | `api_handlers.py` branch chain | registry-backed dispatch map |
| asymmetric standard-runner types | implicit exclusions | explicit omission of snapshot stanza |

The important point is that the BE registry is not a mirror of the FE
registry. It answers BE dispatch questions, not FE planning questions.

### Normalisation target shape

The FE normalisation contract should have two layers:

- **flat rows** for tables, generic chart containers, CSV export, and
  common dimension/metric infrastructure
- **optional preserved scenario structure** for surfaces whose display is
  not reconstructible from rows alone

The standard output contract for snapshot-envelope normalisers should be:

- canonical `AnalysisResult`
- flat `data`
- `dimension_values`
- optional `scenario_results`
- optional `focused_scenario_id`

No analysis should need to invent an entirely bespoke top-level side
channel once this contract exists.

---

## What stays bespoke

Some variation is real and should remain real.

- **Derivation logic** stays bespoke per analysis type. That is the point
  of the analysis.
- **Eligibility predicates** such as "this is a direct edge" or "this
  edge has usable model vars" stay as real code, even if the registry
  points to them.
- **Series-generation logic** stays chart-kind or analysis-specific where
  the visual specification is genuinely different.
- **Blind assertions** stay per analysis type even if the harness
  machinery becomes more reusable.

The refactor is about centralising metadata and routing, not flattening
real domain differences.

---

## Phases

### Phase 0 — Freeze the seam tests and current-state inventory

Before moving more metadata, lock down the current seam coverage that
already exists and add the missing contract tests needed for the
refactor.

The important current FE suites are:

- `graph-editor/src/services/__tests__/analysisRequestContract.test.ts`
- `graph-editor/src/services/__tests__/contentItemSpec.test.ts`
- `graph-editor/src/services/__tests__/HoverAnalysisPreview.test.ts`
- `graph-editor/src/lib/__tests__/analysisDisplaySettingsRegistry.test.ts`
- `graph-editor/src/lib/__tests__/graphComputeClient.test.ts`

The important outside-in harnesses are:

- `graph-editor/src/cli/commands/parity-test.ts`
- the existing `graph-ops` blind/parity scripts already used for snapshot
  analyses

Phase 0 is done when the refactor has a green or intentionally-red test
story at the metadata, dispatch, and normalisation seams.

### Phase 1 — Complete the FE registry

This is the highest-value phase and should ship first.

Scope:

- expand the existing FE registry schema to cover all analysis types, not
  just identity and snapshotContract
- move chart-kind availability and augmentation out of
  `analysisTypeResolutionService.ts`
- move chart-kind labels, aliases, inference rules, and subject-selector
  policy out of `AnalysisChartContainer.tsx`
- move snapshot-required-kind logic out of `useCanvasAnalysisCompute.ts`,
  `analysisBootCoordinatorService.ts`, and `snapshotBootTrace.ts`
- remove CLI mirror lists that can be derived from the registry

Constraints:

- keep `analysisDisplaySettingsRegistry.ts` as a companion registry
- keep builder dispatch chart-kind keyed
- preserve asymmetric cases such as `conversion_funnel`
- preserve analysis-type × chart-kind cases such as comparison
  `time_series`

This phase should be a pure FE plumbing refactor with no semantic change.

### Phase 2 — Consolidate BE snapshot-envelope dispatch

Scope:

- extend `analysis_types.yaml` with an optional snapshot stanza
- replace `ANALYSIS_TYPE_SCOPE_RULES` and `ANALYSIS_TYPE_READ_MODES` with
  registry-derived data
- replace the per-type snapshot derivation branch chain in
  `api_handlers.py` with a registry-backed dispatch map

Constraints:

- do not route `conversion_funnel` through the snapshot-subject handler
- do not infer asymmetry from omission by accident; model it explicitly
- preserve existing runner selection and `when` ordering

This phase brings the BE into the same declarative posture as the FE
without pretending the two sides answer identical questions.

### Phase 3 — Introduce the FE snapshot normaliser factory

Scope:

- replace the snapshot normaliser waterfall in `graphComputeClient.ts`
  with a descriptor-driven factory
- standardise the preserved scenario contract around `scenario_results`
  and `focused_scenario_id`
- make display-only projections explicit and testable

Constraints:

- no public BE response-shape redesign
- preserve field-by-field result parity
- do not collapse display-only projection into backend recompute

The first goal is not maximum abstraction. It is to remove duplicated
shape handling while keeping the result contract stable.

### Phase 4 — Optional chart-builder helper

This is deliberately last and explicitly optional.

If, after Phases 1-3, the time-series builders still show stable common
scaffolding across enough kinds, extract a shared chart-kind helper.
Until then, leave builders alone. Premature abstraction here is more
dangerous than the remaining duplication.

---

## Assurance package

The proposal needs two kinds of assurance: preserve what already works,
and add the tests that make registry drift impossible to miss.

### Existing suites to preserve and extend

| Suite | What it already protects |
|---|---|
| `analysisRequestContract.test.ts` | request-shape and snapshotContract invariants |
| `contentItemSpec.test.ts` | registry-driven view/kind behaviour in the FE UI |
| `HoverAnalysisPreview.test.ts` | chart-kind completeness, pipeline uniformity, snapshot-kind coverage |
| `analysisDisplaySettingsRegistry.test.ts` | chart-kind settings integrity and capability-group consistency |
| `graphComputeClient.test.ts` | snapshot normaliser output shape |
| CLI parity/blind harnesses | outside-in parity over real preparation and normalisation |

### New tests required by this refactor

| Exposure | Required test | Boundary |
|---|---|---|
| FE catalogue drift | FE registry completeness contract test | TypeScript |
| FE/BE snapshot metadata drift | FE/BE snapshot-envelope parity test | TS + Python contract |
| Load-bearing asymmetry loss | explicit `conversion_funnel` asymmetry test | TS integration |
| analysis-type × kind drift | comparison `time_series` snapshot-needed test | TS integration |
| normaliser drift | parity tests between legacy normalisers and factory output | TS integration |
| display-vs-compute drift | request/cache invariance tests for display-only settings | TS integration |
| BE dispatch drift | snapshot dispatch parity tests before removing branch chains | Python integration |

The testing standards remain those in
[docs/current/codebase/TESTING_STANDARDS.md](./codebase/TESTING_STANDARDS.md):
real boundaries by default, parity tests when replacing code paths, and
blind contract assertions instead of implementation-shaped mocks.

This proposal does **not** duplicate the broader forecast-consumer
semantic harnesses from docs 59 and 60. Those remain dependencies and
must stay green, but they are not the primary assurance deliverable of
this registry/normalisation programme.

---

## Migration sequence

The right migration order is by **consumer seam**, not by analysis type.

1. Freeze and extend the seam tests.
2. Expand the FE registry schema while keeping existing helpers and
   behaviour intact.
3. Migrate chart-kind availability and augmentation helpers.
4. Migrate chart-kind labels, aliases, inference, and subject-selector
   policy.
5. Migrate snapshot-needed and snapshot-boot decisions.
6. Remove FE mirror lists and helper tables that the registry now answers.
7. Consolidate the BE snapshot-envelope registry and dispatch.
8. Replace FE snapshot normalisers with the factory.
9. Only after the previous phases are stable, consider any optional
   builder-helper extraction.

This order keeps the risk low:

- Phase 1 is mostly FE-local and heavily testable
- Phase 2 changes BE dispatch only after the FE contracts are explicit
- Phase 3 changes normalisation only after the metadata and routing are
  already centralised

---

## Non-goals

- no reopening of docs 59 or 60
- no Bayes compiler, worker, or webhook changes
- no change to existing chart semantics or visual output
- no BE-side flattening of snapshot-envelope responses in this programme
- no attempt to unify FE and BE into one generated cross-language registry
- no immediate time-series builder abstraction unless Phases 1-3 leave a
  clearly stable target
- no new analysis types until Phase 1 lands

---

## Done criteria

This proposal is successful when the following are true.

### Structural criteria

- there is one canonical FE registry for analysis-type metadata
- there is one canonical BE declaration for snapshot-envelope dispatch
  metadata
- there is one standard FE normaliser factory for snapshot-envelope
  analysis results
- no remaining hidden tables own chart-kind availability, snapshot boot,
  or snapshot-needed routing

### Behavioural criteria

- asymmetric cases such as `conversion_funnel` still work exactly as they
  do today
- comparison `time_series` still uses snapshot-backed compute while the
  other comparison kinds do not
- existing chart output and result semantics are unchanged

### Authoring criteria

After Phases 1-3:

- adding a new snapshot-envelope analysis that reuses an existing chart
  kind should normally require:
  - one FE registry entry
  - one BE snapshot stanza
  - one BE derivation
  - one FE normaliser descriptor
  - one focused test or blind harness update
- adding a new analysis that also introduces a new chart kind will still
  need the chart-kind work:
  - builder implementation
  - chart-kind display settings entry
  - any chart-kind-specific tests

That is the correct target. The analysis-type registry should remove the
hidden boilerplate, not pretend that new chart kinds are free.

---

## Expected impact

Today, adding a snapshot-envelope analysis type still tends to touch a
mix of:

- one real derivation
- one real test
- several hidden FE lookup tables
- several hidden BE dispatch tables
- one bespoke normaliser branch

After Phases 1-3, the hidden-table part should disappear. The remaining
work should be the work that actually belongs to a new analysis:

- define the analysis in the FE registry
- define the snapshot-envelope dispatch in the BE registry if needed
- implement the derivation
- describe the normalised row shape
- prove it with a focused test

That will not only reduce touch count. It will also make future failures
legible. When a new analysis does not render, there should be one or two
obvious seams to inspect, not a dozen places to grep.
