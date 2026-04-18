# Analysis-Types Refactor Proposal

**Author**: 18-Apr-26
**Status**: Draft, not yet scheduled
**Related**: [docs/current/codebase/adding-analysis-types.md](./codebase/adding-analysis-types.md)

---

## Context

Adding a snapshot-based analysis type currently touches ~15 files
(see the playbook file-touch list). About 3 of those files contain
genuinely bespoke logic — the derivation, the builder, and the CLI
blind test. The remaining ~12 are boilerplate: each holds a
hardcoded list, switch, or type union that must be kept in sync
across files nobody thinks to look at. This produces the classic
"shotgun surgery" failure mode — adding one type mutates a dozen
modules, any of which can silently drop the change on the floor.

The conversion_rate onboarding exposed the problem most clearly.
Beyond the file count, the scattered registration caused downstream
failures: charts hung on missing boot-trace entries; normalisers
dropped fields silently; chart kinds were invisible because one of
three lookup tables missed them. These aren't bugs in any one file;
they're structural — the per-type record lives in many places
instead of one.

The refactor target is stated simply: **adding a new analysis type
should touch one declarative registry entry plus a small number of
genuinely-bespoke logic files** (derivation, builder, test).
Everything else should fall out from the registry automatically.

---

## Target outcome

After the refactor, adding a time-series snapshot analysis type
should require:

- **One FE registry entry** — declarative record with id, name,
  icon, selection predicate, chart-kind list, snapshot-contract
  shape, display-settings composition, and a pointer to the builder
  function. This single entry replaces writes to eight files today.

- **One BE registry entry** — declarative record with id, runner,
  subject-resolution scope, snapshot read mode, and a pointer to
  the derivation function. Replaces writes to two files today.

- **One derivation function (BE Python)** — pure function over
  input rows, the edge, and the subject. Returns the response dict.

- **One builder function (FE TypeScript)** — takes canonical
  per-scenario / per-subject data and returns the series list.
  Axis, tooltip, legend, and theming come from a shared chart
  helper; the builder plugs in series generation and nothing else.

- **One blind test (CLI shell)** — asserts invariants over the
  BE response on a synth graph.

Total: four files, of which two are declarative and three are
genuinely analysis-specific. For local-compute types, the
snapshot-boot files and the BE registry entry go away entirely.

The existing analysis types (conversion_rate, daily_conversions,
cohort_maturity, bridge, surprise_gauge, branch_comparison,
graph_overview, etc.) migrate into registry entries with no
semantic change; consumers read from the registry instead of
their own hardcoded tables.

---

## Phases

Each phase is independently shippable and adds new abstractions
additively before removing the old scattered tables. This avoids
flag-days and lets the migration proceed one analysis type at a time.

### Phase 1 — Unified FE registry (highest ROI)

Introduce an `AnalysisTypeRegistry` module that exports one canonical
record per analysis type. The record contains every per-type fact
currently scattered across [analysisTypes.ts](../../graph-editor/src/components/panels/analysisTypes.ts),
[analysisTypeResolutionService.ts](../../graph-editor/src/services/analysisTypeResolutionService.ts),
[AnalysisChartContainer.tsx](../../graph-editor/src/components/charts/AnalysisChartContainer.tsx),
[chartDisplayPlanningService.ts](../../graph-editor/src/services/chartDisplayPlanningService.ts),
[snapshotBootTrace.ts](../../graph-editor/src/lib/snapshotBootTrace.ts),
[analysisDisplaySettingsRegistry.ts](../../graph-editor/src/lib/analysisDisplaySettingsRegistry.ts),
[analysisEChartsService.ts](../../graph-editor/src/services/analysisEChartsService.ts),
and the analysis_type union in [graphComputeClient.ts](../../graph-editor/src/lib/graphComputeClient.ts).

Fields on the record: identity and display (id, name, short
description, icon, selection hint); predicate (the `when` rule for
when this type appears in the dropdown); chart-kind list; snapshot
contract (if snapshot-based); subject-selector flag; time-series
flag and multi-scenario flag; display-settings composition; builder
function reference; the normaliser-row-shape descriptor if snapshot-based.

Migration pattern: for each consumer (the eight files above),
replace its hardcoded table or switch with a derivation from the
registry. Do this one consumer at a time. When all consumers are
migrated, delete the old tables. No semantic changes; pure
refactor.

This phase alone collapses ~70% of the boilerplate. ETA: 2-3 days
for the registry shape plus consumer migration plus tests.

Risk: low. Each consumer migration is independently testable.
The registry is additive; old tables stay until their consumers
are all migrated.

### Phase 2 — BE dispatch and subject resolution consolidation

The BE has three scattered locations for per-type knowledge:
[analysis_types.yaml](../../graph-editor/lib/runner/analysis_types.yaml)
(the only one that's already declarative),
[analysis_subject_resolution.py](../../graph-editor/lib/analysis_subject_resolution.py),
and the chain of `elif analysis_type == 'X':` branches in
[api_handlers.py](../../graph-editor/lib/api_handlers.py)'s snapshot
handler.

The refactor folds subject scope and read-mode into the yaml
schema — they are already per-type facts with no runtime logic.
The derivation dispatch becomes a dict lookup: each registered
analysis type maps to a derivation callable with a standard
signature. The chain of ifs disappears in favour of a one-line
dispatch.

ETA: 1-2 days. Risk: low to medium — touching the snapshot handler
requires careful test coverage, but the parity harness
([v2-v3-parity-test.sh](../../graph-ops/scripts/v2-v3-parity-test.sh),
[conversion-rate-blind-test.sh](../../graph-ops/scripts/conversion-rate-blind-test.sh),
and friends) catches regressions.

### Phase 3 — Response normaliser factory (or move to BE)

The snapshot response normalisers in
[graphComputeClient.ts](../../graph-editor/src/lib/graphComputeClient.ts)
are each around 80 lines and 90% identical: they flatten
per-scenario / per-subject blocks into flat data rows, collect
scenario metadata, and wrap the result in a canonical
`AnalysisResult` shape. The per-type variation is just the row
shape and the semantics block.

Two options, to decide during implementation:

First option: factor out a normaliser factory on the FE that takes
a row-shape descriptor and a semantics record from the registry,
returns a normaliser. This matches the current architecture.

Second option (preferred, stretch): push the flattening into the BE.
Each derivation returns pre-flattened rows with scenario_id and
subject_id already attached; the FE normaliser becomes a trivial
pass-through. This is the correct semantic home — the BE already
iterates over scenarios and subjects, so flattening there is one
line per derivation rather than a factory abstraction on the FE.

If the second option is chosen, the normaliser waterfall in
`graphComputeClient.ts` collapses to a single generic handler.

ETA: 1-2 days depending on option chosen. Risk: medium. The
existing shape is tested via several integration tests; any
change must preserve field-by-field parity.

### Phase 4 — Time-series ECharts builder factory

The remaining bespoke territory is the ECharts builders
themselves. [daily_conversions](../../graph-editor/src/services/analysisECharts/snapshotBuilders.ts),
[conversion_rate](../../graph-editor/src/services/analysisECharts/snapshotBuilders.ts)
(same file), and the time-series variant of
[cohort_maturity](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts)
all share: time-axis configuration, crosshair styling, legend
concept+swatch pattern, theme colour resolution, size-scaling
for scatter, common grid layout, and tooltip formatter shape.

A `buildTimeSeriesChart` helper would take a descriptor of series
factories (how to build bars, lines, scatter from the data), axis
configuration (time vs categorical, formatter preferences), and
a legend-concept list; return the full ECharts option. Builders
shrink to series-generation logic plus a small config block.

This phase is deliberately last. Builder factories are where
premature abstraction causes the most pain — patterns that look
shared often diverge when a fourth or fifth type arrives. Wait
until at least one more time-series type exists before committing
to the shared helper shape. The three existing types are enough
to extract common patterns, but the fourth validates the abstraction.

ETA: 2-3 days after the trigger. Risk: medium to high — builders
carry the visual specification, so a bad abstraction makes visual
regressions hard to catch without thorough screenshot tests.

---

## What stays bespoke (the 10% that can't be generalised)

Some facts are genuinely per-type and should remain so:

- **The derivation function.** The core domain logic — how raw rows
  become the analysis result — is the whole point of the analysis
  type. No abstraction should touch this.

- **The builder's series generation.** Mapping data to chart
  series is where the visual specification lives. The shared
  helper gives the builder the common scaffolding; the builder
  decides what series to render.

- **The subject predicate.** The `when` rule (one node, two
  nodes, sibling, etc.) is a type-defining property.

- **The blind test.** Each type has its own invariants to assert.
  A generic harness could help (Phase 5, stretch), but the
  assertions themselves stay type-specific.

---

## Non-goals

- **No changes to the data model.** Posterior schema, model_vars
  shape, slice keys, completeness semantics — all untouched.

- **No changes to the Bayes compiler, worker, or webhook.** This
  refactor is pure plumbing on the analysis-type consumption side.

- **No change to existing chart output.** Pixel-for-pixel parity
  during migration; visual regressions are bugs, not acceptable
  churn.

- **No new analysis types during the refactor.** Freeze the
  catalogue while migrating; add new types on the new scaffolding
  after Phase 1 ships.

---

## Sequencing and dependencies

Phase 1 unblocks everything else — the registry is the spine that
phases 2, 3, and 4 reference. Phase 1 can ship before anything
else starts.

Phases 2 and 3 are independent of each other. Either can follow
Phase 1 in any order.

Phase 4 depends on Phase 1 (registry) and benefits from Phase 3
(normalisers) but does not require it. Phase 4 should only start
once the existing time-series builder set has stabilised for
several weeks post-Phase-1, to let common patterns settle.

---

## Migration strategy

Per-type incremental migration. For each analysis type:

1. Add its registry entry in Phase 1. Keep old tables populated.
2. Migrate consumers one at a time to read from the registry for
   this type. When a consumer migrates all types, the old table
   deletes.
3. If BE-dispatch or normaliser changes apply, migrate those for
   this type too, in the same PR if scope allows.

Parity enforcement: each migration must leave the existing
test suite green, including
[chart-graph-agreement-test.sh](../../graph-ops/scripts/chart-graph-agreement-test.sh),
[v2-v3-parity-test.sh](../../graph-ops/scripts/v2-v3-parity-test.sh),
[conversion-rate-blind-test.sh](../../graph-ops/scripts/conversion-rate-blind-test.sh),
and any other blind tests currently passing.

Order within Phase 1: start with simpler types (surprise_gauge,
graph_overview, node_info, edge_info) to shake out the registry
shape. Then medium (daily_conversions, conversion_rate,
lag_histogram). Finally the complex ones (cohort_maturity,
cohort_maturity_v2, bridge, branch_comparison). By the time the
complex types migrate, the registry shape is proven.

---

## Rollout summary

Phase 1 ships a mechanical refactor with no semantic change,
collapsing ~70% of the touch count for new types. This is the
bulk of the value.

Phase 2 closes the BE-side gap and makes the BE dispatch match
the FE's declarative shape.

Phase 3 (or a BE-side normalisation shift) removes the last large
chunk of boilerplate from the FE data path.

Phase 4 is a deferred quality-of-life improvement for builder
authors. Don't rush it.

At the end of Phases 1-3, adding a new snapshot-based time-series
analysis type should touch: one registry entry (declarative), one
BE registry entry (declarative), one derivation function (BE), one
builder function (FE), one blind test (shell). Five files total,
of which two are declarative — down from fifteen.

---

## Open questions

- **Registry source format**: is the FE registry a single
  TypeScript module, a generated artifact from a yaml descriptor,
  or a hybrid (declarative fields in yaml, function references in
  code)? The hybrid route keeps the declarative parts language-agnostic
  and shareable with the BE registry, but introduces a generation
  step. Tentative preference: single TypeScript module, mirror of
  the BE yaml, with a small contract test that the two agree.

- **Normaliser home (FE vs BE)**: leaning toward BE-side
  flattening, but needs a survey of what the current FE
  normalisers actually do — if several rename or derive fields
  on the FE, that logic has to migrate somewhere. Decide in
  Phase 3 based on the field-by-field survey.

- **Registry and the canvas chart containers**: the chart
  container [AnalysisChartContainer.tsx](../../graph-editor/src/components/charts/AnalysisChartContainer.tsx)
  currently encodes per-type labels, kind inference, subject-selector
  policy, etc. These should all become registry lookups. Confirm
  no other canvas node components hold similar per-type
  knowledge.

- **Display settings composition**: the current registry in
  [analysisDisplaySettingsRegistry.ts](../../graph-editor/src/lib/analysisDisplaySettingsRegistry.ts)
  is already partly declarative. Decide whether to fold it into
  the unified registry or leave it as a companion module cross-referenced
  by id. Tentative: keep it separate (it's the one registry that's
  already working) but link by id.

---

## Expected impact metrics

Files touched per new snapshot time-series analysis type:

| | Before | After P1 | After P3 |
|---|---|---|---|
| Declarative entries | 0 | 1 | 2 |
| Bespoke logic files | 3 | 3 | 3 |
| Scattered boilerplate | 12 | 4 | 0 |
| **Total** | **15** | **8** | **5** |

Developer time to add a simple new analysis type (estimated):

| | Before | After P3 |
|---|---|---|
| Discovery / reading | 2h | 30m |
| Implementation | 6h | 3h |
| Testing | 2h | 1h |
| Debugging "why isn't it rendering" | 4h | 30m |
| **Total** | **~14h** | **~5h** |

Impact on incident rate (qualitative): the "silent drop" failures
(missed boot-trace, missed chart kind, missed normaliser union)
are structurally impossible after the registry is the single
source of truth. These were the most demoralising failures during
the conversion_rate session; they don't recur once Phase 1 ships.
