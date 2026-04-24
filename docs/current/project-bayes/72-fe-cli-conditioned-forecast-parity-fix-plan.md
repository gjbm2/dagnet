# 72 — FE/CLI Conditioned Forecast Parity Fix Plan

**Date**: 23-Apr-26  
**Status**: Historical implementation note — superseded by doc 73 for active execution  
**Audience**: engineers working on the FE graph pipeline, conditioned forecast, `cohort_maturity`, and CLI parity  
**Relates to**: `../cohort-cf-defect-and-cli-fe-parity.md`, `65-gm-rebuild-window-vs-cohort-cli-investigation.md`, `66-shared-cf-runtime-and-wp8-admission-plan.md`, `71-shared-cf-runtime-detailed-execution-plan.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `54-cf-readiness-protocol.md`

This note is retained as the narrower FE/CLI parity investigation record that
fed the broader execution plan in
`73-be-topo-removal-and-forecast-state-separation-plan.md`. New implementation
work for graph-surface forecast state should start from doc 73.

## 1. Purpose

This note turns the current CLI↔FE parity investigation into an execution
plan. The investigation has converged on three related defects rather than
one isolated bug.

The first defect is that the FE currently writes a query-owned probability
answer onto graph state before conditioned forecast has run. The second is
that the conditioned-forecast runtime does not resolve probability inputs
consistently across the target edge and the upstream carrier. The third is
that graph-surface conditioned forecast is not managed as first-class
scenario-owned state end to end, even though analysis objects already think
in those terms.

This plan does not reopen the cohort/window semantics, the subset rule, or
the WP8 admission discussion from docs 66 and 71. It takes those as given
and focuses on the execution work needed to make FE, CLI, and the shared
runtime obey them.

## 2. Binding contract

The fix begins from five binding points.

First, model estimation and query conditioning are separate layers. A
`window()`-derived FE pass may build the best available fallback model, but
it must not present a query-scoped answer as though it were the canonical
model for that edge.

Second, the FE fallback model should be estimated from the full relevant
`window()` slice family, not from the narrow evidence slice currently being
queried. Scoped evidence belongs in the conditioning layer, not in the
baseline model-estimation layer.

Third, conditioned forecast and `cohort_maturity` must resolve probability
inputs from one source-order contract. A higher-quality promoted model, such
as Bayes, must win wherever it is available. FE-derived analytic state is a
fallback model source, not a peer display scalar that may override the
runtime opportunistically.

Fourth, graph-surface conditioned forecast is scenario-owned work. Each
visible scenario must have its own conditioned-forecast pass, its own graph
input, its own graph updates, and its own generation lifecycle.

Fifth, CLI and FE parity is defined on request and response identity for the
same scenario graph and DSL. The CLI is only a trustworthy oracle when it
exercises the same state contract as the FE.

## 3. Current implementation drift

### 3.1 FE model-building and query conditioning are collapsed

The current FE path computes query-scoped evidence and then uses it to drive
the scalar that becomes `edge.p.mean`. In practice this joins three concerns
that should be separate: raw scoped evidence, a fallback unconditioned model,
and the current query's displayed answer.

The relevant write-path runs through
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/UpdateManager.ts`, and
`graph-editor/src/services/fetchDataService.ts`. The statistical enhancement
pass already distinguishes between all-history lag fitting and
query-scoped evidence, but the probability blend that is later promoted onto
`edge.p.mean` is still tied to the scoped path. That turns a transient query
answer into graph-owned model state.

This part is now code-traced, not merely inferred. The FE topo pass in
`graph-editor/src/services/statisticalEnhancementService.ts` computes
`edgeLAGValues.blendedMean` from scoped evidence plus the baseline forecast.
`graph-editor/src/services/fetchDataService.ts` then materialises
`lagResult.edgeValues` through `UpdateManager.applyBatchLAGValues`, and
`graph-editor/src/services/UpdateManager.ts` writes that value into
`targetP.mean`. The per-scenario analysis graph is later sent to the BE as
`scenario.graph`, and the Python carrier builder in
`graph-editor/lib/runner/forecast_runtime.py` computes upstream reach by
multiplying incoming reach terms by
`graph-editor/lib/runner/forecast_state.py::_resolve_edge_p`, which reads
`edge.p.mean` first. So the chain "scoped blendedMean → edge.p.mean →
carrier reach" is the current concrete write/read path.

Once that happens, later consumers cannot reliably tell whether `p.mean`
represents a stable model prior, a scoped evidence blend, or a conditioned
forecast output. The system has slipped from "build the best model, then
condition it" into "mutate the model slot with the current query's answer".

### 3.2 The runtime has split-brain probability resolution

The Python runtime does not currently use one probability resolver for all
forecast roles.

The target edge is resolved through the model-resolver path, which already
prefers posterior-backed information. The upstream carrier path, by
contrast, still includes `p.mean`-first resolution in
`graph-editor/lib/runner/forecast_state.py` and the reach-building code that
depends on it. That means one semantic solve may read one probability family
for the subject edge and a different family for the upstream carrier even
when both values are notionally "the probability for this edge".

This split is the key reason the FE query-owned write is dangerous. Even
where the subject-edge prior survives through posterior-first resolution, the
upstream carrier can still be pulled towards the FE scalar and therefore
change latency behaviour. That is the mechanism behind the cohort-latency
collapse class.

### 3.3 Target-edge posterior mass inflation is still unresolved

The bracket's subject-edge resolved `alpha=328.6568` and `beta=57.382` are
not explained by the carrier contamination path above and should remain an
explicit live witness.

The current code trace shows that
`graph-editor/lib/runner/model_resolver.py::resolve_model_params` does not
manufacture that kind of non-integer mass inflation on the way into v3. In
cohort mode it first reads `edge.p.posterior.cohort_alpha` and
`cohort_beta`, then falls back to window `alpha` and `beta`, then to
`forecast.mean`, and only then to the D20 evidence-derived fallback. That
D20 fallback yields evidence-shaped `alpha` and `beta`, not a free-form
non-integer pair preserving the same mean at much higher mass.

That means the inflated pair most likely enters earlier, on the FE scenario-
graph side rather than inside the runtime solve itself. The concrete suspect
entry points are the posterior projection path in
`graph-editor/src/services/analysisComputePreparationService.ts` via
`reprojectPosteriorForDsl`, the slice-to-graph projection code in
`graph-editor/src/services/posteriorSliceResolution.ts`, the Bayes projection
path in `graph-editor/src/services/bayesPatchService.ts`, and any
scenario-rehydration path that reuses FE state before analysis dispatch.

Work package A therefore needs to close two FE provenance questions, not one:
the already traced `p.mean` contamination path on the carrier side, and the
still-untraced source of the target-edge posterior mass seen in the bracket.

### 3.4 Conditioned forecast is not yet a first-class scenario service

The FE graph surface and the analysis layer do not yet share one scenario-
owned enriched graph contract.

At the graph-surface level,
`graph-editor/src/services/fetchDataService.ts` still orchestrates
conditioned forecast as an enrichment side-effect over the current graph
state. At the analysis layer,
`graph-editor/src/services/analysisComputePreparationService.ts` builds
per-scenario graphs explicitly. In the CLI,
`graph-editor/src/cli/commands/analyse.ts` aggregates per scenario but then
reuses the last populated graph as a base for later analysis preparation,
while `graph-editor/src/services/GraphParamExtractor.ts` does not preserve
the full model state needed to reconstruct a graph faithfully.

The result is that the system already talks about scenarios at the API and
analysis layers, but not yet as durable graph-owned enrichment state. That
gap leaves room for hidden cross-scenario reuse and makes parity fragile.

## 4. Work package A — restore the FE model/evidence split

This package fixes the conceptual error first: the FE analytic pass should
build the best fallback unconditioned model it can from full `window()`
evidence, and conditioned forecast should then decide what the scoped query
does with that model.

The required implementation move is to make the FE's all-window estimate a
model-bearing output rather than a query-answer scalar. The natural home is
the same promoted-model surface that other consumers already use:
`model_vars` plus the promoted flat fields that represent the active model.
The all-window FE estimate should therefore be written as analytic model
state, not as a pre-CF overwrite of `edge.p.mean`.

Scoped evidence should remain in `p.evidence.*`, with any query-scoped
completeness or display approximations kept in fields that are explicitly
display-owned rather than model-owned. If the graph UI still needs an
immediate approximate probability before conditioned forecast returns, that
approximation may exist, but it must not occupy the canonical model slot or
be reused later as a runtime input.

This package touches
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/UpdateManager.ts`,
`graph-editor/src/services/fetchDataService.ts`, and
`graph-editor/src/services/GraphParamExtractor.ts`. It also needs an FE-side
posterior provenance trace through
`graph-editor/src/services/analysisComputePreparationService.ts`,
`graph-editor/src/services/posteriorSliceResolution.ts`, and
`graph-editor/src/services/bayesPatchService.ts`, because the bracket's
inflated target-edge `alpha` and `beta` are a separate witness that the FE
scenario graph may be carrying a different prior mass than expected. The pass
that currently
uses query-scoped evidence to manufacture `blendedMean` needs to be split
into a model-estimation path and a display/conditioning path. Any extracted
scenario state must retain the model-bearing fields that the downstream
runtime will actually consume.

The acceptance criteria are simple. A narrow scoped query must no longer be
able to rewrite the canonical fallback model for an edge. The FE fallback
model must be derivable from full `window()` data even when the scoped query
has little or no evidence. And the model state emitted by the FE must remain
available to later scenario preparation without being reconstructed from a
query-scoped scalar.

## 5. Work package B — unify probability resolution inside CF and v3

Once the FE is capable of emitting a clean fallback model, the shared Python
runtime must consume it consistently.

This package introduces one probability-source contract for three roles: the
target edge prior, the upstream carrier/reach calculation, and any other
edge-level probability reads performed during runtime preparation. The
current split between `resolve_model_params` and `_resolve_edge_p` is not
acceptable in the final design because it makes the solve depend on which
sub-path happened to ask the question.

The implementation target is a single resolver or resolver family inside the
Python runtime, shared by `graph-editor/lib/runner/model_resolver.py`,
`graph-editor/lib/runner/forecast_state.py`, and
`graph-editor/lib/runner/forecast_runtime.py`. It must respect the promoted
model contract, preserve the subset-rule and query-scoped guardrails already
in the runtime, and surface provenance strongly enough that tests can assert
which source won for each edge.

The critical negative requirement is that changing a display scalar alone
must not change carrier behaviour. Once this package lands, editing
`edge.p.mean` without changing the promoted/posterior model source should not
be able to alter upstream reach, latency tier selection, or the resulting v3
trajectory. Bayes should continue to win wherever it is present; the FE
analytic fallback should matter only where no higher-quality source exists.

The acceptance criteria are that target-edge and upstream-carrier resolution
report the same winning source for the same edge and mode, and that the
latency-collapse failure mode no longer reproduces when only the FE display
scalar changes.

## 6. Work package C — make graph-surface CF scenario-owned

This package turns scenario isolation from an analysis-layer idea into a
graph-layer fact.

Each visible scenario should trigger its own conditioned-forecast pass with
an explicit `scenario_id`, an explicit scenario graph, and its own update
application. The graph surface should stop treating conditioned forecast as a
single enrichment side-effect over whichever mutable graph happens to be
current at the moment the pass resolves.

The FE needs a scenario-owned enriched-graph store or an equivalent
full-fidelity state object that preserves all model-bearing fields, not just
the subset currently extracted into scenario params. A param-only overlay is
insufficient if `model_vars` remain authoritative runtime inputs. The CLI
needs the same correction: it should preserve the full populated graph for
each scenario and stop treating the last populated graph as the universal
base for later analysis preparation.

This package touches
`graph-editor/src/services/fetchDataService.ts`,
`graph-editor/src/services/conditionedForecastService.ts`,
`graph-editor/src/services/analysisComputePreparationService.ts`,
`graph-editor/src/services/GraphParamExtractor.ts`, and
`graph-editor/src/cli/commands/analyse.ts`. The goal is not to push more
logic into analysis objects. The goal is to give both the graph surface and
the analysis layer the same scenario-owned enriched graph as input.

The acceptance criteria are that the FE emits one conditioned-forecast call
per visible scenario, each call carries the correct `scenario_id` and
scenario graph, and CLI versus FE parity can be demonstrated on a
scenario-by-scenario basis from the same graph snapshot.

## 7. Sequencing

These three packages must not be landed as one combined refactor. Doc 71's
discipline applies here directly: separate layers, shadow before substitute,
and no test weakening.

The first stage is an assurance stage. Add or tighten the failing parity
checks that represent the three defects before changing behaviour. At
minimum this means one FE/CLI request-parity harness, one runtime
source-provenance check for target-versus-carrier probability resolution,
and one graph-surface orchestration test that proves scenario ownership.

The second stage is a shadow landing for the FE all-window model path. Build
the full-window fallback model and promote it into model-bearing fields while
still leaving the current display behaviour intact. The parity point for
this stage is that the new model-bearing output is present, stable, and not
query-scoped.

The third stage is the runtime resolution switch. Make CF and v3 consume the
promoted model contract consistently for both target and upstream reads while
the old FE display scalar still exists as a display-only value. The parity
point here is that carrier behaviour no longer changes when only the display
scalar changes.

The fourth stage is the removal or demotion of the pre-CF query-owned
`p.mean` write. This should happen only after the runtime has stopped
depending on it. The parity point is that a low-evidence or no-evidence
query still produces the same or better answer while the graph no longer
uses the display scalar as a model input.

The fifth stage is scenario ownership. Move graph-surface conditioned
forecast onto per-scenario graphs, preserve those graphs in FE and CLI, and
make analysis preparation consume that scenario-owned state. The parity point
is byte-identical FE and CLI request bodies for the same scenario graph and
DSL.

The sixth stage is cleanup. Remove dead compatibility writes, remove any
temporary dual-write or shadow instrumentation, update readiness handling in
line with doc 54, and collapse tests onto the final contract.

## 8. Ordered implementation checklist

### 8.1 Stage 0 — lock the failing contracts first

Do not start behavioural changes until the current defect shape is pinned in
tests that fail for the right reason.

The TypeScript side should start with
`graph-editor/src/services/__tests__/beForecastingTriggerLogic.test.ts`.
That file currently codifies the wrong contract by expecting the CF request
graph to carry the FE-authored fallback `p.mean`. Invert that expectation.
The test should instead prove that the graph handed to conditioned forecast
carries model-bearing state and that any pre-CF display approximation is not
treated as the canonical model input.

Then tighten
`graph-editor/src/services/__tests__/analysisRequestContract.test.ts` and
`graph-editor/src/services/__tests__/forecastingParity.queryFlow.snapshotDb.integration.test.ts`
so they assert the scenario-owned request shape that the finished system is
meant to honour: explicit `scenario_id`, per-scenario graph bytes, and no
subject/temporal DSL leakage across the FE/CLI boundary.

Add one dedicated FE-to-BE witness for the subject-edge posterior block as
well. Start from the FE scenario-graph construction path in
`graph-editor/src/services/analysisComputePreparationService.ts`, trace the
posterior projection through
`graph-editor/src/services/posteriorSliceResolution.ts`, and assert which
`edge.p.posterior.cohort_alpha` and `cohort_beta` pair actually lands on the
`scenario.graph` sent to the BE. The bracket's `328.6568 / 57.382` pair
should remain a red witness until that provenance is explained.

On the Python side, extend
`graph-editor/lib/tests/test_model_resolver.py` and
`graph-editor/lib/tests/test_forecast_state_cohort.py` so they explicitly
prove that the target-edge path and the upstream-carrier path select the same
probability source for the same edge and mode. Use
`graph-editor/lib/tests/test_v3_degeneracy_invariants.py` as the outside-in
red witness for both observed failure modes until later stages close them.

The exit gate for Stage 0 is not "tests are green". It is that the current
tree now has precise failing witnesses for all three defects, and those
witnesses would break again if a future change reintroduced the same drift.

### 8.2 Stage 1 — shadow the FE all-window fallback model

This stage adds the new model-estimation path without yet deleting the old
display behaviour.

Start in
`graph-editor/src/services/statisticalEnhancementService.ts`. Split the
current probability work into two named outputs: the full-`window()`
fallback model estimate and the query-owned display approximation. The former
is model state; the latter is a render-time convenience only.

Then update `graph-editor/src/services/UpdateManager.ts` so the FE fallback
model is dual-written into model-bearing state rather than only into the
display scalar. The preferred landing is `model_vars` plus the promoted flat
fields that the rest of the runtime already expects. Do not remove the
current display path in this stage.

Thread that split through
`graph-editor/src/services/fetchDataService.ts` and
`graph-editor/src/lib/conditionedForecastGraphSnapshot.ts` so the graph used
for conditioned forecast can carry the model-bearing output independently of
the display approximation.

Finally, update `graph-editor/src/services/GraphParamExtractor.ts` so the
new model-bearing FE output survives any scenario extraction path that still
exists. If the extractor remains lossy with respect to model-bearing state,
Stage 1 is incomplete.

The main TypeScript checks for this stage are
`graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`,
`graph-editor/src/services/__tests__/perDayBlendPooledRate.test.ts`,
`graph-editor/src/services/__tests__/modelVarsResolution.test.ts`, and
`graph-editor/src/services/__tests__/GraphParamExtractor.topologicalOrder.test.ts`
or its successor if that file is broadened into a richer extractor contract.

The exit gate is that two narrow queries over the same edge can yield
different scoped evidence while still exposing the same FE fallback model in
model-bearing state.

### 8.3 Stage 2 — switch CF and v3 onto one probability resolver

This is the load-bearing runtime change.

Make `graph-editor/lib/runner/model_resolver.py` the canonical home for
probability-source selection, or extract a shared helper alongside it if the
current file boundary makes that cleaner. The important point is that both
the subject-edge path and the upstream-carrier path must now ask the same
question in the same way.

Route `graph-editor/lib/runner/forecast_state.py` through that contract so
`_resolve_edge_p` no longer has its own `p.mean`-first semantics. Then update
`graph-editor/lib/runner/forecast_runtime.py` so
`build_x_provider_from_graph` and related carrier helpers consume the unified
resolver and expose enough provenance for tests to assert what won.

Audit `graph-editor/lib/runner/cohort_forecast_v3.py` and
`graph-editor/lib/api_handlers.py` for any raw probability reads that still
bypass the unified resolver. If a codepath asks for "edge probability", it
must no longer be able to bypass the canonical source-order contract by
reading flat fields directly.

The primary test files are
`graph-editor/lib/tests/test_model_resolver.py`,
`graph-editor/lib/tests/test_forecast_state_cohort.py`,
`graph-editor/lib/tests/test_cohort_maturity_v3_contract.py`, and
`graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`.

The exit gate is that mutating a display-only FE scalar no longer changes
carrier reach, carrier tier selection, or the resulting cohort latency
trajectory when a promoted model source is unchanged.

### 8.4 Stage 3 — demote the pre-CF query-owned `p.mean` write

Only after Stage 2 lands should the old write-path be removed or demoted.

Update `graph-editor/src/services/UpdateManager.ts` so the FE analytic pass
no longer claims the canonical `edge.p.mean` slot before conditioned forecast
has run. The only writer that should remain authoritative for graph-owned
conditioned values is the conditioned-forecast projection path itself.

Keep `graph-editor/src/services/conditionedForecastService.ts` as the
authoritative graph projection boundary for CF-owned scalars such as
`p.mean`, `forecast.mean`, and completeness. If the FE still needs a visible
pre-CF approximation, place it in an explicitly display-owned field or
transient render path, not in the canonical model slot.

Then simplify the orchestration in
`graph-editor/src/services/fetchDataService.ts` so it no longer assumes that
the FE fallback value and the CF answer are competing writers for the same
field.

The most important TypeScript tests here are
`graph-editor/src/services/__tests__/beForecastingTriggerLogic.test.ts`,
`graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts`,
and `graph-editor/src/services/__tests__/fetchDataService.test.ts`.

The exit gate is that low-evidence or no-evidence queries still render a
useful provisional answer if desired, but that answer is no longer capable of
poisoning later CF or v3 runtime inputs.

### 8.5 Stage 4 — make FE conditioned forecast scenario-owned

With the model contract cleaned up, move the graph-surface orchestration onto
true scenario ownership.

Refactor `graph-editor/src/services/fetchDataService.ts` so it issues one
conditioned-forecast call per visible scenario, each with an explicit
`scenario_id`, its own scenario graph, and its own application target.
`graph-editor/src/services/conditionedForecastService.ts` should stop relying
on the default `'current'` scenario id for graph-surface orchestration.

At the same time, teach
`graph-editor/src/services/analysisComputePreparationService.ts` and the
scenario state holder around it to consume durable scenario-owned enriched
graphs rather than reconstructing analysis inputs from a lossy param overlay.
If additional state plumbing is needed, the likely homes are
`graph-editor/src/contexts/ScenariosContext.tsx`,
`graph-editor/src/hooks/useCanvasAnalysisCompute.ts`, and
`graph-editor/src/services/analysisBootCoordinatorService.ts`.

Keep `graph-editor/src/lib/conditionedForecastGraphSnapshot.ts` strict: it
should always clone a scenario graph faithfully, never synthesize one from
partial state when the full enriched graph is available.

The main FE test files for this stage are
`graph-editor/src/services/__tests__/analysisRequestContract.test.ts`,
`graph-editor/src/hooks/__tests__/liveCustomComputeParity.test.ts`,
`graph-editor/src/services/__tests__/forecastingParity.queryFlow.snapshotDb.integration.test.ts`,
and the scenario orchestration tests that currently sit nearest the FE graph
surface.

The exit gate is that the FE emits one CF request per visible scenario and no
later arrival from one scenario can overwrite another scenario's graph state.

### 8.6 Stage 5 — make the CLI consume the same scenario-graph contract

Once the FE owns per-scenario enriched graphs, the CLI must stop rebuilding a
different execution shape.

Start with `graph-editor/src/cli/aggregate.ts` and
`graph-editor/src/cli/commands/analyse.ts`. Preserve the fully populated
graph for each scenario and pass that forward directly. The pattern where the
last populated graph becomes the universal base graph must be removed.

Revisit `graph-editor/src/services/GraphParamExtractor.ts` from the CLI side
as well. If the CLI still needs a param-pack path for editing or export,
keep it, but do not let it remain the execution path for analysis if it loses
runtime-owned model state.

If any request-shape normalisation still lives in shared FE code, keep it in
`graph-editor/src/services/analysisComputePreparationService.ts` so the CLI
and FE continue to call the same preparation layer rather than re-diverging.

The relevant tests are the FE/CLI request-contract suite in
`graph-editor/src/services/__tests__/analysisRequestContract.test.ts`, the
CLI scenario and param-pack tests under `graph-editor/src/cli/__tests__/`,
and the outside-in Python witness
`graph-editor/lib/tests/test_v3_degeneracy_invariants.py`.

The exit gate is byte-identical FE and CLI BE payloads for the same scenario
graph and DSL, plus matching response normalisation at the graph boundary.

### 8.7 Stage 6 — remove shadow paths and close the loop

After the parity gates are green, remove any dual-write or shadow-only code
left behind in
`graph-editor/src/services/statisticalEnhancementService.ts`,
`graph-editor/src/services/UpdateManager.ts`,
`graph-editor/lib/runner/forecast_runtime.py`, and adjacent helpers.

Then align readiness and provisional-display semantics with
`docs/current/project-bayes/54-cf-readiness-protocol.md` so the UI does not
silently slide back into using display-owned fields as authoritative model
state.

The final regression run should include the TypeScript CF orchestration
contract tests, the Python resolver/runtime tests, and the outside-in CLI
degeneracy suite. Only after that should docs 65 and the investigation note
be updated from "open defect" language toward implementation status.

## 9. Test and parity gates

The permanent regression pack for this work should cover five things.

First, the FE analytic path must prove that the fallback model for an edge is
derived from full `window()` evidence even when the current query is narrow.

Second, the Python runtime must expose enough provenance that tests can prove
the same probability source won for the target edge and the upstream carrier.

Third, graph-surface conditioned forecast must prove scenario ownership:
one call per visible scenario, correct `scenario_id`, correct graph input,
and no shared-state overwrite between scenarios.

Fourth, the CLI and FE must have a request-diff harness that operates on the
same graph snapshot and DSL so that parity claims stop depending on
eyeballing downstream charts.

Fifth, the outside-in pack must keep both observed failure modes alive as
acceptance tests even though this plan is centred on the latency-collapse
mode. The no-evidence cohort-latency collapse and the low-evidence
under-reported asymptote are different symptoms of the same architectural
drift and should not be allowed to trade places undetected.

## 10. Open decisions that need explicit closure

The first open decision is whether the graph surface should show an
approximate pre-CF answer at all once the canonical `p.mean` write is gone.
If the answer is yes, the field must be explicitly display-owned and its
readiness semantics should line up with doc 54 rather than pretending to be
authoritative.

The second open decision is the storage shape for scenario-owned enriched
graphs. A full graph snapshot is conceptually simplest and safest. A richer
param-pack alternative is only acceptable if it preserves every runtime-owned
field currently needed by CF and v3, including model-bearing state.

The third open decision is how much of the current CLI scenario-preparation
flow can be retained once scenario-owned graphs become first-class. If the
answer involves keeping the "last populated graph as base graph" pattern,
then this plan has not actually been implemented.

## 11. Expected landing state

When this plan is complete, the FE will build the best fallback model it can
from full `window()` data and publish that as model state. Conditioned
forecast and `cohort_maturity` will consume promoted model state plus scoped
evidence, rather than consuming FE display scalars opportunistically. Each
scenario will own its own conditioned-forecast lifecycle and its own
enriched graph state. And the CLI will once again be a valid oracle for FE
behaviour because both sides will be exercising the same scenario graph,
the same runtime contract, and the same BE payloads.
