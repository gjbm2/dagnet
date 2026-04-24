# 73 — BE Topo Removal and Forecast State Separation Plan

**Date**: 24-Apr-26  
**Status**: Active implementation plan  
**Audience**: engineers working on the Stage 2 fetch pipeline, model vars, FE topo, conditioned forecast, CLI parity, and graph-state consumers  
**Supersedes**: doc 72 as the active execution plan for graph-surface forecast state  
**Relates to**: `../codebase/STATS_SUBSYSTEMS.md`, `../codebase/FE_BE_STATS_PARALLELISM.md`, `../codebase/PARAMETER_SYSTEM.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `60-forecast-adaptation-programme.md`, `72-fe-cli-conditioned-forecast-parity-fix-plan.md`, `../cohort-cf-defect-and-cli-fe-parity.md`

## 1. Objective and scope

This plan defines one integrated workstream delivered as two named work
packages.

Work package A removes the quick BE topo pass entirely. Work package B
enforces a strict three-layer graph contract: model vars, promoted model vars,
and current query-scoped graph params.

These work packages are intentionally linked. Removing BE topo without fixing
field ownership only deletes code and leaves semantic ambiguity. Fixing field
ownership without removing BE topo leaves redundant source taxonomy and
duplicate analytic surface area.

The quick BE topo pass currently exists to populate `analytic_be`, re-run
promotion, support FE-versus-BE parity tooling, and preserve an older
transition plan where BE analytic would replace FE analytic. The intended
system no longer uses that transition plan. FE quick pass is the fast fallback
writer. BE conditioned forecast is the careful authoritative writer.

The deeper defect is field-role ambiguity. The same flat scalar can currently
mean model forecast, query-scoped evidence blend, or conditioned answer,
depending on write order. This plan removes that ambiguity and retires the
redundant BE analytic branch against a single target contract.

### 1.1 Terminology used in this plan

- "FE quick pass" is the canonical term and is equivalent to earlier wording
  "FE topo pass" and "FE quick path".
- "FE fallback model" means the model-bearing FE source entry (`analytic`), not
  the query-owned provisional answer.
- "Standard fetch pipeline" means the live Stage 2 enrichment pipeline used in
  normal operation. This replaces mixed terms "standard fetch path", "live
  fetch path", and "standard Stage 2 enrichment path".
- "Carrier behaviour" means runtime reach/carrier propagation outcomes,
  including tier selection, reach multiplication, and latency propagation for a
  fixed graph/query input.
- "Scenario-owned enriched graph state" means the per-scenario graph after
  baseline plus scenario composition and enrichment projection, including
  query-owned fields, rather than a stripped param-only representation.

## 2. Binding decisions (non-negotiable)

Decision 1. FE quick pass stays as a quick, rough, resilient immediate writer
from local graph state plus fetched evidence. This plan does not replace FE
quick pass with a slower solve.

Decision 2. BE conditioned-forecast pass stays as the careful, authoritative
writer of current query-scoped answer fields.

Decision 3. After delivery, only two query-time statistical writers remain in
the standard fetch pipeline: FE quick pass and BE conditioned-forecast pass.
There is no replacement quick BE analytic pass.

Decision 4. Model vars are source-owned model state, not current query answer
state. They are valid model inputs with provenance and support baseline model
selection before query-specific conditioning.

Decision 5. Promoted model vars are the selected baseline model surface on the
graph. Promotion selects one source and projects that model into graph fields
for consumers that mean "best baseline model", not "current query answer".

Decision 6. Current query-scoped graph params are query-owned fields derived
from promoted model state plus scoped evidence. FE may write provisional
values first and CF may overwrite later, but the layer remains query-owned.

Decision 7. `p.mean` and `p.forecast.mean` must stop collapsing onto the same
value. `p.mean` is current query-scoped answer. `p.forecast.*` is selected
baseline model forecast surface for this plan.

Decision 8. Baseline forecast estimate from
`graph-editor/src/services/windowAggregationService.ts` is model-bearing input.
It belongs in FE fallback model source and promoted model surface, not in
CF-owned current-answer fields.

Decision 9. Changing only current query-owned fields must not alter runtime
carrier behaviour, promoted source selection, or baseline model inputs used by
later solves.

### 2.1 Three-layer contract at a glance

Model-var layer: source-owned model state (`p.model_vars[]` entries) written by
model producers such as FE fallback, offline bayesian fits, and manual
override edits.

Promoted model layer: selected baseline model projection (including
`p.forecast.*` and promoted latency fields) written by promotion logic.

Current query-scoped layer: active-query answer fields (including `p.mean`,
`p.sd`, `p.evidence.*`, and completeness fields) written by FE quick pass
provisionally and CF authoritatively.

## 3. Target end state (contract to implement)

### 3.1 Model-var ledger

After implementation, live model-var sources are model-input families only.

`bayesian` remains aggregate fitted source from offline pipeline.

`manual` remains explicit user override source.

`analytic` becomes the single FE fallback model source representing FE
unconditioned baseline model built from full relevant `window()` slice family
for probability and existing all-history lag-fit inputs for latency. Active
query-scoped answer state must not live in `analytic`.

Do not introduce a fourth long-lived source name unless unavoidable during
migration. With `analytic_be` removed, `analytic` is the intended FE fallback
home.

### 3.2 Promoted model surface

Promotion flattens the winning source into stable graph fields meaning
"selected baseline model".

Latency already partly follows this pattern through promoted latency fields.

Probability must gain the same treatment. Preferred steady state is
reservation of `p.forecast.*` as promoted baseline model forecast surface for
this workstream. There is no unnamed temporary replacement field in this plan.
Probability must have a dedicated promoted surface distinct from current
query-scoped answer fields.

Promotion must not write current-answer fields. Promotion only projects the
selected model.

### 3.3 Current query-scoped surface

Current query-owned surface contains scoped evidence and answer for active
query.

Minimum surface includes `p.evidence.*`, `p.mean`, `p.sd`,
`p.latency.completeness`, and `p.latency.completeness_stdev`.

FE quick pass writes provisional values immediately. CF overwrites only fields
it owns as careful authoritative solve.

These fields are scenario-owned query state, not model vars and not promoted
model state. They must not be reused as priors.

### 3.4 Consumer read rules

Consumers needing baseline model forecast read promoted model surface.

Consumers needing current query answer read current query-scoped surface.

Consumers must not infer model state from whichever field was populated first.

## 4. Current mismatches to close

Mismatch 1. `graph-editor/src/services/fetchDataService.ts` still launches FE
topo pass, quick BE topo pass, and CF per fetch, even though BE topo now acts
as duplicate analytic model-var source plus promotion/diagnostic/logging path.

Mismatch 2. `analytic` and `analytic_be` currently behave like query-scoped
analytic posteriors instead of clean model sources, contaminating model-var
ledger with query-owned answer state.

Mismatch 3. `graph-editor/src/services/modelVarsResolution.ts` promotes latency
but does not yet own equivalent promoted probability surface. Probability state
is split across source entries, `p.forecast.mean`, `p.mean`, and ad hoc
pipeline writes.

Mismatch 4. FE quick path writes blended query-owned scalar into `p.mean` via
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/fetchDataService.ts`, and
`graph-editor/src/services/UpdateManager.ts` before CF lands. This lets later
consumers treat current-answer field as model-bearing input.

Mismatch 5. `graph-editor/src/services/conditionedForecastService.ts` currently
writes `edge.p.forecast.mean = edge.p_mean`, collapsing baseline forecast and
conditioned answer into one slot and destabilising `f` versus `f+e`.

Mismatch 6. FE, CLI, and analysis preparation still lack one clean
scenario-owned enriched-graph contract. Doc 72 exposed this as parity defect;
under this plan it is a query-owned state-isolation defect per scenario.

## 5. Work package A — remove quick BE topo pass entirely

Work package A removes redundant BE analytic branch and source taxonomy that
exists only to support it.

Action A1. Remove BE-topo orchestration from
`graph-editor/src/services/fetchDataService.ts`. Standard fetch pipeline must stop
importing `graph-editor/src/services/beTopoPassService.ts`, stop maintaining
BE-topo generation counter, stop attaching BE-topo background handlers, and
stop emitting BE-topo parity/completion logs.

Action A2. Remove `analytic_be` as live source from TypeScript and Python
source taxonomies, including:
`graph-editor/src/types/index.ts`,
`graph-editor/src/services/modelVarsResolution.ts`,
`graph-editor/lib/runner/model_resolver.py`,
`graph-editor/src/services/localAnalysisComputeService.ts`,
`graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`,
`graph-editor/src/components/PropertiesPanel.tsx`,
plus any remaining user-visible or diagnostic surfaces exposing "Analytic (BE)".

Action A3. Retire BE-topo transport and endpoint once no live caller remains,
including:
`graph-editor/src/services/beTopoPassService.ts`,
`/api/lag/topo-pass` route in `graph-editor/dev-server.py`,
`graph-editor/lib/api_handlers.py::handle_stats_topo_pass`,
implementation in `graph-editor/lib/runner/stats_engine.py`.
If any helper in `stats_engine.py` is genuinely shared, move or re-home it
explicitly instead of preserving dead topo-pass surface.

Action A4. Remove parity-only assurance surfaces used only for FE-versus-BE
analytic comparison, including:
`graph-editor/src/services/forecastingParityService.ts`,
`analytic_be` half of `--diag-model-vars`,
and FE/BE topo contract tests no longer matching live source-of-truth.
Keep FE quick-pass tests that still validate target system behaviour, and
rewrite them to FE-only contract instead of deleting casually.

Action A5. Update remaining CLI and graph-ops surfaces to remove implication of
quick BE topo stage. Legacy `--topo-pass` is already a no-op in places; remove
final diagnostic and documentation residue so toolchain matches two-writer
reality.

Completion gate for Work package A:
standard fetch pipeline launches only FE quick pass and CF,
graph no longer contains `analytic_be`,
and no BE subsystem depends on removed quick BE topo surface.

## 6. Work package B — separate model vars, promoted model vars, and current query-scoped graph params

Work package B restores intended semantic boundary across model, promoted, and
query-owned layers.

### 6.0 Parked issue carried from Phase 1

Known issue (parked; no intermediate fix): after Work package A removed
`analytic_be`, explicit horizon recompute can re-promote stale analytic latency
because preserved canonical latency and fresh FE-fitted latency share one lane,
`model_vars[source='analytic']`.

This is intentionally deferred to Work package B. Fix approach is completing
model-vs-promoted-vs-query separation, not adding temporary branches and not
reintroducing quick BE analytic path.

### 6.1 Redefine `analytic` as FE fallback model source

FE quick system still produces fallback model, but output must become clean
model source rather than query-owned posterior in disguise.

`analytic` target meaning is FE fallback model built from full relevant
`window()` family for probability and existing lag-fit inputs for latency.
Current query scoped evidence remains in `p.evidence.*`. Current query
provisional answer remains in current-answer fields.

Baseline forecast estimate from
`graph-editor/src/services/windowAggregationService.ts` lands in FE fallback
model (`analytic`) and then promotion, not in CF-owned or current-answer fields.

Probability parameterisation for promoted probability surface is fixed in this
plan as `mean` plus `stdev` on `p.forecast.mean` and `p.forecast.stdev`.
Source-specific distribution details may remain inside model-var source entries,
but promotion must project them onto this promoted pair.

### 6.2 Give probability a promoted model surface

Promotion must become symmetric so probability has a clear promoted home, as
latency already does.

`graph-editor/src/services/modelVarsResolution.ts` should own projection of
winning probability source onto promoted graph surface. Preferred steady state
reserves `p.forecast.*` for this role, making forecast-versus-current-answer
distinction explicit.

This removes informal behaviour where promoted probability depends on whichever
pass wrote a flat field first.

### 6.3 Keep FE quick pass as immediate query-owned projector

FE quick pass may keep computing and writing approximate `p.mean` and
completeness immediately.

Required change is input ownership: FE quick pass must consume promoted
baseline model state as forecast input and scoped evidence as evidence input.
It must not rewrite model ledger or promoted forecast slot with query-owned
answer.

Primary surfaces:
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/fetchDataService.ts`,
`graph-editor/src/services/UpdateManager.ts`.

FE quick path may still refresh FE fallback model source, but that remains
model-layer update. Immediate blended answer remains current-answer-layer
write.

### 6.4 Keep CF as careful authoritative current-answer writer

CF remains authoritative writer of current query-scoped answer.

`graph-editor/src/services/conditionedForecastService.ts` should continue
projecting CF-owned fields such as `p.mean`, `p.sd`, and CF-owned completeness
fields, while stopping overwrite of promoted baseline forecast slot.

Current "already query-scoped posterior" degraded rule remains valid migration
guard. End state removes query-scoped sources from promoted model layer rather
than relying on permanent ambiguity. Any future genuinely query-scoped source
must be explicit and non-default.

### 6.5 Make runtime and graph consumers obey layer split

BE runtime and graph consumers must read model inputs from model/promoted
surfaces, not from current-answer fields.

Primary surfaces:
`graph-editor/lib/runner/model_resolver.py`,
`graph-editor/lib/runner/forecast_state.py`,
`graph-editor/lib/runner/forecast_runtime.py`,
`graph-editor/lib/runner/graph_builder.py`,
`graph-editor/lib/runner/runners.py`,
plus any reach/carrier path still treating `p.mean` as model proxy.

Negative requirement is strict: changing only current query-owned scalar must
not alter carrier behaviour, promoted source selection, or baseline model used
by later solves.

### 6.6 Make current query-owned state scenario-owned

FE graph surface, analysis preparation, and CLI must preserve one enriched
graph per scenario so current query-owned fields cannot leak across scenarios
or be reconstructed from stripped param-only view.

This carries forward valid core of doc 72. Parity defect remains real, but is
implemented here as part of three-layer separation, not as standalone parity
patch.

Primary surfaces:
`graph-editor/src/services/analysisComputePreparationService.ts`,
`graph-editor/src/services/GraphParamExtractor.ts`,
`graph-editor/src/cli/commands/analyse.ts`,
scenario-facing FE orchestration around conditioned forecast.

Completion gate for Work package B:
- `analytic` is model-bearing FE fallback source, not query-owned answer state.
- `p.forecast.*` is promoted baseline model surface and remains distinct from
  current query-owned answer fields.
- FE quick pass consumes promoted model state plus scoped evidence and writes
  query-owned fields without rewriting promoted baseline slots.
- CF remains authoritative current-answer writer and does not overwrite
  promoted baseline forecast slots.
- Runtime carrier/reach consumers read model/promoted surfaces rather than
  current query-owned fields.
- FE and CLI both prepare analysis from scenario-owned enriched graph state per
  scenario.

## 7. Delivery stages and execution order

This workstream lands in six stages. Stages are sequential and each stage
closes a concrete boundary before the next stage starts.

Stage-to-work-package mapping is explicit: Stage 0 is foundation work for both
packages, Stage 1 delivers Work package A, and Stages 2-5 deliver Work
package B.

Stage 0. Freeze target contract and failing tests. Before behaviour changes,
tests must pin baseline-forecast versus current-answer distinction, pin
`analytic_be` removal, and pin consumer rule that current-answer fields are
not model inputs.

Stage 1. Remove quick BE topo pass from standard fetch pipeline and source taxonomy.
This is a hard removal, not feature-flagged shadow path. Purpose is reducing
surface area before deeper state-separation work.

Stage 2. Shadow-land FE fallback model path and promoted probability surface.
By stage end, graph already has stable baseline model forecast without using
current-answer fields for that role.

Stage 3. Switch FE quick pass to consume promoted model state and scoped
evidence, while writing only current query-owned answer fields. FE must remain
quick and resilient in user behaviour.

Stage 4. Switch CF, runtime consumers, and scenario preparation to new
ownership split. By stage end, mutating `p.mean` alone must not change model
selection or carrier behaviour.

Stage 5. Remove remaining compatibility writes, parity-era diagnostics, dead
source-selection branches, and stale docs so codebase cleanly represents one FE
quick path plus one BE careful path, not mixed old/new contracts.

## 8. Final acceptance criteria

This plan is complete only when all statements below are true.

1. Standard fetch pipeline has exactly two live statistical writers:
   FE quick pass and BE conditioned-forecast pass.
2. `analytic_be` no longer appears in graph state, source preference
   hierarchies, overlays, CLI output, or live-system docs.
3. Selected baseline model forecast is stable across scoped queries unless
   underlying model source changes. Narrow or zero-evidence queries no longer
   rewrite canonical baseline forecast for an edge.
4. `f` and `f+e` remain distinct after FE fallback and CF landing. `f` reads
   promoted baseline forecast. `f+e` reads current query-owned answer.
5. Changing only current query-owned fields cannot alter runtime carrier
   behaviour, promoted source selection, or model inputs for later solves.
6. FE quick pass remains fast and resilient and still provides immediate
   approximation when CF is pending or unavailable.
7. CF remains the only careful query-conditioning writer and no longer
   overwrites model-bearing baseline slots.
8. FE and CLI parity is demonstrated scenario-by-scenario from the
   scenario-owned enriched graph state defined in section 6.6, without relying
   on second analytic BE pass.

## 9. Non-goals

This plan does not add replacement quick BE analytic path.

This plan does not redesign Bayes compiler.

This plan does not reopen cohort-versus-window semantics.

This plan does not turn FE quick pass into second careful forecast engine.

This plan does not propose clean-slate graph-schema rewrite. Goal is clean
responsibility separation with smallest lasting field and source surface.

## 10. Documentation follow-through

When implementation starts landing, current-state docs must be updated in a
coordinated pass. Highest-priority targets are:
`docs/current/codebase/STATS_SUBSYSTEMS.md`,
`docs/current/codebase/FE_BE_STATS_PARALLELISM.md`,
`docs/current/codebase/PARAMETER_SYSTEM.md`,
graph-ops CLI playbooks,
and remaining docs that still describe quick BE topo pass or treat
`p.forecast.mean` and `p.mean` as one semantic slot.

These documentation updates should land with code changes, not before, so
reference docs continue to describe live system accurately while this plan
remains the execution note.
