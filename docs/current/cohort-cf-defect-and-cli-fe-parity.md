# CLI↔FE cohort() divergence investigation

Filed 23-Apr-26. Live, difficult investigation. The FE reproduces a
systematic cohort() underestimate on subject
`from(switch-registered).to(switch-success)` on `bayes-test-gm-rebuild`.
The CLI does not reproduce it. Getting to the bottom of this is blocking
all other development on the app.

## Working directory for current evidence

`/tmp/rightnow-ref/` contains the reference frame captured between two
`rightnow` marks (ts 1776981942280 → 1776981961041, a 19 s bracket of
the defect manifesting in the FE):

- `mark-extract.txt` — raw output from `scripts/extract-mark-logs.sh rightnow`
- `bracket.console.jsonl` (888 lines) — FE console between the two marks
- `bracket.session.jsonl` (403 lines) — structured FE session log between the two marks
- `bracket.python.jsonl` (711 lines) — Python BE stdout between the two marks
- `diag-state.json` (607 KB) — full FE state dump at mark 1
- `graph-snap-start.json` / `graph-snap-end.json` — graph state at each mark
- `analysis-dumps/` (8 dumps) — FE-dumped analysis response payloads
  inside the bracket, including the two cohort_maturity v3 tiles that
  exhibit the defect

Every claim in this doc should be traceable back to an artefact here,
to doc 65, or to executing the CLI equivalent.

## Confirmed defect signal from the mark capture

A single cohort_maturity v3 tile for `from(switch-registered).to(switch-success)`
was rendered in the FE at ts 1776981958847. Its dumped response
(`analysis-dumps/1776981958906_cohort_maturity_from(switch-registered)_to(switch-success).json`)
contains 182 rows spanning two scenarios:

| scenario | effective DSL (from BE log) | midpoint @ τ=90 |
|---|---|---:|
| `scenario-1776475304227-k1y6285` ("19-Mar – 16-Apr") | `window(-1d:)` | **0.8529** |
| `current` | `cohort(21-Apr-26:21-Apr-26)` | **0.1628** |

Same edge, same Bayesian posterior, two scenarios, very different
asymptotes. The 0.8529 is correct (it matches the edge's posterior mean
on disk). The 0.1628 is the defect under investigation.

## Whole-graph CF pre-pass observed in bracket

One `POST /api/forecast/conditioned` call fires during the bracket
(`bracket.python.jsonl`). It processes both scenarios in sequence at
ts 1776981954402, logging for the subject edge:

```
[forecast] scenario-1776475304227-k1y6285: switch-registered→switch-success p=0.8529 conditioned=False
[forecast] current: switch-registered→switch-success p=0.1630 conditioned=False
```

The two p values coincide with the v3 asymptotes for the corresponding
scenarios. **This is not a causal chain.** Both values are outputs of
the same CF cohort machinery for this query; their agreement says only
that the defect lives upstream of both consumers, somewhere in the
cohort code when confronted with this scenario's evidence shape. User
framing: "CF is systematically delivering too low an answer for
immature cohorts."

## Corrections received during this session (do not revert)

- **p.mean is a symptom, not a cause.** Treating the `p=0.163` from the
  CF pre-pass log as a mutated input that poisons the v3 chart was
  wrong. Both values come from the same CF cohort path and reflect the
  same upstream defect.
- **The CLI does run the whole-graph CF pre-pass.** `graph-ops/scripts/analyse.sh`
  exercises the same FE-facing preparation path, including the CF
  pre-pass. Any earlier claim in this doc or in doc 65 that the CLI
  bypasses the pre-pass is superseded.

The second correction is load-bearing: because both paths run the same
BE endpoints and the same pre-pass, the divergence cannot be "FE pre-
passes, CLI doesn't". The divergence must live in what each path sends
to the BE, or in state each path establishes that the BE then reads.

## How the CLI actually works (verified against current source)

- [graph-ops/scripts/analyse.sh](graph-ops/scripts/analyse.sh) shells to
  `npx tsx src/cli/analyse.ts` with `--graph <data-repo-path>
  --name <graph-name> --query <dsl>` plus any pass-through flags.
- [graph-editor/src/cli/bootstrap.ts:84-207](graph-editor/src/cli/bootstrap.ts#L84-L207)
  loads the graph from disk, seeds `fileRegistry`, detects workspace
  from git, and (if `--bayes-vars` is supplied) replays the sidecar
  through the same `applyPatchAndCascade` codepath the browser uses
  when a webhook patch lands.
- [graph-editor/src/cli/commands/analyse.ts:167-189](graph-editor/src/cli/commands/analyse.ts#L167-L189)
  iterates scenarios and for each calls
  `aggregateAndPopulateGraph(bundle, spec.queryDsl, { mode, workspace })`.
  The deprecation comment at
  [analyse.ts:194-207](graph-editor/src/cli/commands/analyse.ts#L194-L207)
  is explicit: "aggregate / fetchItems / Stage-2 now runs FE topo +
  BE topo + CF + promotion unconditionally, with awaitBackgroundPromises
  so all results are landed before returning." The whole-graph CF
  pass lives inside this function, not as a separate CLI step.
- [analyse.ts:249-296](graph-editor/src/cli/commands/analyse.ts#L249-L296)
  builds the `scenariosContext` exactly as the FE would: N live
  scenarios plus the last one named `current`, with
  `currentParams = lastEntry.params`, `scenariosReady: true`. A bare
  `--query` produces a single scenario → id `'current'`; there is no
  second live scenario unless `--scenario` is passed explicitly.
- [analyse.ts:266-296](graph-editor/src/cli/commands/analyse.ts#L266-L296)
  passes that context into `prepareAnalysisComputeInputs` (shared with
  the FE) and, for `cohort_maturity`, dispatches via
  `runPreparedAnalysis(prepared)` — the same entrypoint the FE's
  canvas-analysis compute uses. No hand-rolled payload for this
  analysis type. The only hand-rolled payload is for
  `analysisType === 'conditioned_forecast'` at
  [analyse.ts:329-360](graph-editor/src/cli/commands/analyse.ts#L329-L360),
  which is a different tile.

So for a `cohort_maturity` invocation, the CLI uses the same
`aggregateAndPopulateGraph` + `prepareAnalysisComputeInputs` +
`runPreparedAnalysis` triple that the FE canvas uses. They are not
independent implementations.

## How the shared data pipeline actually works

Verified by reading the code, not the handover:

1. **Per-scenario aggregation** via `aggregateAndPopulateGraph`
   ([src/cli/aggregate.ts:38-124](graph-editor/src/cli/aggregate.ts#L38-L124)).
   This calls the FE's `fetchDataService.fetchItems` — not a CLI-side
   re-implementation.
2. **Inside `fetchItems`** (per the call-sites at
   [fetchDataService.ts:2299-2650](graph-editor/src/services/fetchDataService.ts#L2299-L2650))
   the pipeline runs unconditionally:
   - FE topo pass (LAG, completeness, `UpdateManager`-driven edge-value
     apply)
   - BE topo pass (`runBeTopoPass`, writes `model_vars[analytic_be]`
     and re-runs promotion)
   - Conditioned Forecast via `runConditionedForecast(graph, dsl, …, workspace)`
     — sends ONE scenario to `/api/forecast/conditioned`
     ([conditionedForecastService.ts:131-152](graph-editor/src/services/conditionedForecastService.ts#L131-L152))
   - `applyConditionedForecastToGraph(graph, results)` writes CF-owned
     scalars back into the graph (blendedMean, forecast.mean,
     latency.completeness, latency.completeness_stdev)
3. **`runPreparedAnalysis` dispatches the per-tile analysis**
   ([analysisComputePreparationService.ts:636-720](graph-editor/src/services/analysisComputePreparationService.ts#L636-L720)).
   For `cohort_maturity` both paths use this entry. Internally:
   - `prepared.scenarios.length > 1` → `graphComputeClient.analyzeMultipleScenarios`
   - `prepared.scenarios.length === 1` → `graphComputeClient.analyzeSelection`
   Both hit `POST /api/runner/analyze` on the BE but with different
   payload shapes.
4. **BE `_handle_cohort_maturity_v3`**
   ([api_handlers.py:1508-1549](graph-editor/lib/api_handlers.py#L1508-L1549))
   iterates `scenarios[]` from the request body; each scenario brings
   its own `graph_data = scenario.get('graph')`. There is no
   implicit whole-graph CF pre-pass inside the v3 handler — it works
   from the graph bytes supplied by the caller.

So for any tile, the per-scenario sequence is: populate graph with
evidence → FE topo → BE topo → fetchDataService CF (writes back to
graph) → run analysis tile (sends per-scenario graph to BE). Both CLI
and FE traverse this sequence.

## Confirmed structural differences (NOT yet mechanism)

1. **`awaitBackgroundPromises` and CF timing**: CLI passes `true`
   ([aggregate.ts:75-83](graph-editor/src/cli/aggregate.ts#L75-L83))
   so the fetchDataService CF completes before the analysis tile
   dispatches. FE (`fetchItems` default) does not await. Bracket
   timing confirms this matters in practice:
   - Session log: `CONDITIONED_FORECAST` started at ts 1776981951665
     with `dsl=window(-1d:)`; "subsequent overwrite applied" at ts
     **1776981959865** (8199 ms total).
   - v3 cohort_maturity tile was **dispatched at ts 1776981957866**
     (BE log: `[v3] Resolved 1 subjects from DSL '…cohort(21-Apr-26…)'
     (scenario=current)`) and its response was dumped at ts
     **1776981958847**.
   - Therefore at v3 dispatch the fetchDataService CF pre-pass for
     `window(-1d:)` had not yet overwritten the FE graph. The v3
     BE call's graph input is the PRE-CF FE graph.
   - The CLI, by contrast, would see a post-CF graph for its sole
     scenario at analysis dispatch time.
2. **CLI fires fetchItems per scenario (aggregate.ts loop)**. Every
   scenario in a CLI invocation gets its own fetchDataService CF
   pre-pass. The FE also fires CF per visible scenario, but at
   scenario-regeneration time (not necessarily inside a given tile-
   render bracket). In the `rightnow` bracket only one
   `CONDITIONED_FORECAST` event is visible (`gen 1, dsl=window(-1d:)`)
   because the other scenarios' CFs fired before the bracket opened.
   An earlier claim in this doc — "FE fires one CF per batch" — was
   wrong on that point and is corrected here.

## Key intermediate values from the FE bracket (already captured)

The Python BE stdout in `/tmp/rightnow-ref/bracket.python.jsonl`
contains the full v3 internal trace for the defective render. For
subject `from(switch-registered).to(switch-success).cohort(21-Apr-26:21-Apr-26)`
under scenario=current, the trace shows:

- subject edge resolved posterior: `source='bayesian' p_mean=0.8514
  alpha=328.6568 beta=57.382 alpha_pred=7.9268 beta_pred=1.4126
  qscoped=False` — correct, consistent with on-disk posterior
- upstream fetch: 10836 observations across 181 cohorts, three edges
  (landing→created, created→delegated, delegated→registered)
- `[v3-debug] upstream_params[0]: p=0.13820733246981226
  mu=-1.9082 sigma=3.3466 onset=0.01 mu_sd=0.6958 sigma_sd=0.1951`
  — this is the carrier reach; 0.138 is small because the cohort is
  anchored one day ago and the upstream latency is long
- `[v3] carrier: tier=parametric`
- sweep: `apply_is=True t5:Y=0.0/X=0.6 … t40:Y=0.1/X=0.6 … t90:Y=0.1/X=0.6`
  — forecast stays at 0.1/0.6 from τ≈30 onward
- final midpoint at τ=90: **0.1628**

For scenario=k1y6285 (window mode) the same edge resolves the same
`p_mean=0.8514` but `[v3] carrier: tier=none`, carrier is an identity,
the sweep is driven by the observed window evidence 29/34 ≈ 0.853, and
midpoint asymptotes correctly.

So the FE trace already tells the cohort-mode story end to end: with
the one-day cohort slice, carrier reach is 0.138, the sweep projects
Y/X staying near 0.1/0.6 out to τ=90, and the row midpoint reflects
that. The open CLI-FE question is whether the CLI, on the identical
DSL and a graph matched to the FE's IDB, produces different
intermediates (different reach, different cohort counts, different
sweep projection) or whether it produces the same intermediates but
a different published midpoint.
2. **Graph source**: CLI reads from disk via
   [bootstrap.ts:110-112](graph-editor/src/cli/bootstrap.ts#L110-L112);
   FE reads from IndexedDB, which can carry pending dirty state not
   persisted. `graph-snap-end.json` in `/tmp/rightnow-ref/` is the FE
   IDB view at mark time and is the correct comparison target.
3. **Effective DSL resolution**: at mark time the FE's `current`
   scenario resolved `-1d:` to `cohort(21-Apr-26:21-Apr-26)` (today − 2
   d, one-day slice). Prior CLI runs in doc 65 used
   `cohort(22-Apr-26:22-Apr-26)` (today − 1 d). These are different
   evidence slices; comparing them is comparing different queries.

## Ruled out (do not re-investigate)

- **Scenario cardinality as sole cause.** The user has verified: running
  the FE with just one scenario does NOT fix the defect, and/or running
  the CLI with two scenarios does NOT reproduce it. Scenario count is
  not the axis.
- **CLI bypassing the CF pre-pass.** Code-verified: the CLI runs the
  same `fetchItems` pipeline including CF.
- **p.mean as the cause.** User-corrected: p.mean is an output of the
  CF machinery. Both the `[forecast] … p=0.1630` log line and the v3
  asymptote of 0.163 are downstream of the same CF cohort path.

## Still live investigation axes

Each is concrete and testable; none are confirmed:

- **IDB graph vs disk graph.** `graph-snap-end.json` provides the exact
  FE IDB state. Feed it into the CLI (or a synthetic repro script) and
  see if the defect reproduces.
- **BE request body divergence.** The CF call's payload
  (`runConditionedForecast` from
  [fetchDataService.ts:2322-2335](graph-editor/src/services/fetchDataService.ts#L2322-L2335))
  and the per-tile analysis call's payload (`runPreparedAnalysis`)
  each need to be captured for FE and CLI with identical DSL.
- **BE-side state reuse.** Whether session-scoped caches or
  snapshot-service state accumulate across requests in the FE's
  multi-tile render pass but not across the CLI's single-shot is
  unverified. The bracket shows `[snapshot_cache] BYPASS query_snapshots_for_sweep`
  for this session, which rules out that specific cache but not all
  BE state.
- **Dependence on scenariosContext composition.** Even if scenario
  count alone is not it, the *content* (parameters, effective DSLs,
  ordering, visibility modes) of the scenariosContext may materially
  change the CF output for scenario=current.

Any reproduction must hold constant: same effective DSL, same graph
bytes, same scenariosContext. Start from `/tmp/rightnow-ref/` for the
FE side; execute the CLI with identical inputs.

## What this is not (per doc 65 framing, still current)

- **Not Class A** (doc 65 §15.2 — reach=0 → carrier collapse). Today's
  bracket shows `[v3] carrier: tier=parametric` for the subject in
  scenario=current, not `tier=none`. Carrier is built.
- **Not an on-edge posterior defect.** The Bayes side-panel and on-disk
  `p._posteriorSlices.slices.cohort()` both yield ~0.85, consistent
  with the `window()`-mode scenario. The fit is fine. The defect is
  downstream in CF composition.

## Open question

Why does the CF cohort machinery, running end-to-end in both the CLI
and the FE, produce different p asymptotes for the same subject on the
same graph — ~0.83 via CLI, ~0.163 via FE in scenario=current?

Candidate axes of divergence, **not yet investigated** with concrete
evidence from today's bracket. Treat as hypotheses only:

1. **Scenario context contents.** The FE's `scenariosContext` carries
   both `current` and the named live scenario
   `scenario-1776475304227-k1y6285`. The CLI doc-65 invocations
   carried only `current`. Whether the presence of a second scenario
   affects the p estimate for `current` inside the CF pre-pass is
   untested.
2. **Effective DSL resolution.** The FE renders `-1d:` under scenario
   `current` as `cohort(21-Apr-26:21-Apr-26)` (a 1-day absolute window,
   today - 2d). CLI invocations in doc 65 used
   `cohort(22-Apr-26:22-Apr-26)` (today - 1d). Whether the day-shift
   changes the evidence set is untested.
3. **IDB graph vs on-disk graph.** The graph object the FE submits may
   differ from what the CLI reads from disk. `graph-snap-end.json` is
   available for comparison.
4. **model_vars, promotion, or slice-selection state** baked into the
   FE's graph before send vs the CLI's.
5. **tau_extent / display settings** routed through the request body.

## Next step

Per doc 65 §15.6: **diff the BE request body produced by FE and CLI for
the identical target DSL.**

Concrete approach:

- Instrument the relevant entry in `graph-editor/lib/api_handlers.py`
  to dump the full request body to disk on receipt. This captures both
  FE and CLI calls without touching either client.
- Re-run both, same DSL and scenario.
  - FE: render the tile in the browser (the mark bracket shows how).
  - CLI: reproduce with
    `bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild
    "from(switch-registered).to(switch-success).cohort(21-Apr-26:21-Apr-26)"
    --type cohort_maturity --no-cache --no-snapshot-cache --format json`.
    If the FE is running against a divergent IDB graph, the CLI may
    need the same graph / file objects copied in; `graph-snap-end.json`
    and the parameter-file contents visible in `diag-state.json` are
    starting points.
- Diff the two captured bodies. Any non-whitespace difference is a
  candidate cause.

If the two bodies are byte-identical and the BE still produces
different outputs, the defect is in BE state reuse across calls (e.g.
snapshot cache, scenario state persistence).

Once the FE defect reproduces via the CLI, bisection inside
`graph-editor/lib/runner/cohort_forecast_v3.py` and its resolvers
becomes possible. The test suite in
`graph-editor/lib/tests/test_v3_degeneracy_invariants.py` should be
extended to cover the reproduced case before any code fix is
attempted.

---

# Original note (preserved for context)

The sections below were written earlier on 23-Apr-26 before the mark
capture documented above. They contain useful framing on the semantic
backbone and the list of candidate mechanisms, alongside speculation
that today's evidence has superseded. Treat any specific named
mechanism in those sections as a hypothesis only until verified
against `/tmp/rightnow-ref/` or a fresh CLI reproduction.

## Executive summary

There are two distinct defects, stacked.

**Defect A — CLI does not exercise the same pathway as the FE.** This is a
blocking test defect. The CLI's `analyse` command, the CLI's conditioned
forecast flow, and the CLI's bayes-vars apply flow each enter the compute
pipeline through a different seam than the FE equivalent. The seams diverge
on graph state assembly, scenario context, whole-graph CF pre-pass, and
which per-analysis caches are populated. The consequence is that identical
DSL and identical data produce different internal state on the two
platforms, so a defect that shows up in FE cannot be isolated, bisected or
regression-tested via CLI. Until this is fixed, every FE defect is
effectively unreviewable and every fix is unverifiable.

**Defect B — cohort() is systematically biased low in the CF machinery.**
When the effective query has a `cohort(...)` temporal window, all downstream
CF consumers — the whole-graph enrichment pass, the funnel analysis, and
cohort\_maturity v3 — return `p_mean` values that are much lower than both
the on-edge posterior and the equivalent `window()` compute on the same edge
with the same data. The per-edge Bayesian posterior shown on the edge panel
(around 85 % for the subject under investigation) is correct and the
`window()` CF path returns the right number. The `cohort()` path does not.
The defect appears to sit somewhere in the v3 row builder or the resolver
feeding it, and it reaches every consumer that shells out to
`compute_cohort_maturity_rows_v3` for cohort-mode subjects.

Because Defect A exists, Defect B can only be observed in the FE. The CLI,
running the same DSL against the same graph, produces sensible numbers.
That is the core pain point: we can see the defect but not reproduce it in
a debuggable environment.

## Reproduction and the divergence it exposes

The investigation was run on `bayes-test-gm-rebuild`, subject
`from(switch-registered).to(switch-success)`.

On the FE, with this subject and `cohort(22-Apr-26:22-Apr-26)` anchored to
the `current` scenario, the cohort\_maturity v3 chart renders with
`p_infinity_mean ≈ 0.19` at τ=90 and `completeness ≈ 0.032`. The equivalent
subject evaluated with `window(-1d:)` against a live named scenario renders
`p_infinity_mean ≈ 0.853` — which is correct for the window evidence. The
live Bayesian panel for the same subject edge shows `p` of 85.1 % ± 1.8 %
on the window slice and 85.2 % ± 1.8 % on the cohort slice. So the fit is
fine, the `window()` CF path is fine, the `cohort()` CF path is 4.5× too
low.

On the CLI, the same DSL routed through `bash graph-ops/scripts/analyse.sh
bayes-test-gm-rebuild "from(switch-registered).to(switch-success).cohort(22-Apr-26:22-Apr-26)"
--type cohort_maturity --no-cache --no-snapshot-cache --format json
--display '{"tau_extent":90}'` returns `τ=90 midpoint ≈ 0.829` with
`p_infinity ≈ 0.833`. That is the expected number. The CLI cannot reproduce
the FE 0.19.

The user has observed the same cohort()-low pathology in three separate
FE-side consumers: the funnel display, the whole-graph CF overlay, and the
cohort\_maturity v3 chart. The user has not observed it in window()-mode
consumers on the same edges. The user has observed it across more than one
graph. Conclusion: the bug is not about one graph; it is about the cohort()
path through CF.

## Defect A — CLI↔FE pathway divergence

### The requirement

The agreed direction is that the CLI must exercise the *same* compute
pathway as the FE. The CLI is the only viable integration-test target: if
we cannot reproduce an FE defect through the CLI, then every user-visible
CF/stats defect becomes unrepro, and every fix becomes "works on my
machine".

### What currently diverges

Below are the concrete divergences I have identified in this session. Each
is a seam where the CLI and FE assemble different state or enter the
pipeline at a different point.

**Graph state assembly.** The CLI's `bootstrap.ts` loads the graph from
disk via `loadGraphFromDiskCached` and seeds the in-memory `fileRegistry`.
The FE reads the graph from IndexedDB, which tracks dirty state, pending
patches, and scenario overrides that the disk does not see. The user has
already flagged that the FE's IDB can diverge from disk in non-trivial
ways. For any FE-observed defect, the CLI is loading different bytes.

**Bayes-vars apply.** After an earlier push, the CLI's `--bayes-vars` flow
was aligned to use `applyPatchAndCascade` (the same choke point as
`useBayesTrigger → fetchAndApplyPatch`). That change is in place
([bootstrap.ts:163-207](graph-editor/src/cli/bootstrap.ts#L163-L207),
[bayes.ts apply-patch and submit branches](graph-editor/src/cli/commands/bayes.ts))
but it only proves that the *patch apply* step now matches. It does not
fix the divergence in the *compute* pipeline that consumes the applied
patch.

**Analysis dispatch.** The CLI's `analyse` command dispatches through
`runPreparedAnalysis`
([analyse.ts:363](graph-editor/src/cli/commands/analyse.ts#L363)) except
when `analysisType === 'conditioned_forecast'`, in which case it hand-rolls
a `POST /api/forecast/conditioned` payload inline
([analyse.ts:329-360](graph-editor/src/cli/commands/analyse.ts#L329-L360)).
The FE routes both paths through
`services/analysisPipelineService.ts` →
`services/conditionedForecastService.ts::runConditionedForecast`. Two
different payload assemblers feeding the same BE endpoint is exactly the
class of divergence that hides cohort()-specific bugs.

**Whole-graph CF pre-pass.** The FE fetchDataService runs a whole-graph
conditioned forecast before per-tile analyses (`[funnel] whole-graph CF`
traces are visible in the python-server log). That pre-pass writes
CF-owned scalars back onto the graph state via
`applyConditionedForecastToGraph`, so any subsequent per-tile request sees
those scalars already mutated into the graph. The CLI does not run this
pre-pass. Any CLI reproduction of a tile is therefore operating on an
un-enriched graph.

**Scenario context.** The FE tile compute receives a `scenariosContext`
with live named scenarios, each of which can rewrite the effective query
DSL. A good example is in this session's logs: for the *same* tile with
DSL `from(switch-registered).to(switch-success)`, the FE emits two BE
requests — one with `effective_query_dsl: "window(-1d:)"` for the named
scenario, and one with `effective_query_dsl: "cohort(23-Apr-26:23-Apr-26)"`
for the `current` scenario. The CLI's single-shot DSL invocation does not
express that fan-out.

**Snapshot builder reuse.** `buildConditionedForecastGraphSnapshot`
("engorgement" of the graph clone) is used by the CLI for the
conditioned\_forecast endpoint but not for the standard analyse dispatch.
The FE's CF service always routes through it. Any difference in how
engorgement seeds the `p.posterior` / `p._posteriorSlices` / `p.latency`
fields will manifest as a compute difference.

**Graph-snapshot caches.** The FE's tile compute goes through the
`canvasAnalysisResultCache` and `contentItemResultCache`
([useCanvasAnalysisCompute.ts](graph-editor/src/hooks/useCanvasAnalysisCompute.ts)),
and a chart can render a previously-cached result rather than re-computing.
The CLI bypasses these caches entirely. When the FE shows a stale number
and the CLI shows a fresh number, the two platforms are answering different
questions.

**Mappings file scope.** Graph snapshots need the workspace-scoped hash
mappings (`getMappingsFileAsync` vs `fileRegistry.restoreFile` with
`getWorkspaceScope()`). An earlier edit in this session pulled mappings
from the unprefixed IDB key and ended up reading the wrong workspace's
mappings. That is resolved for the snapshot flow but is emblematic of the
general class of single-workspace assumptions baked into FE state that the
CLI does not replicate.

### What a fix needs to guarantee

The user's directive is unambiguous: "the cli path must be IDENTICAL IN
EVERY FUCKING WAY to the FE experience of running a bayes fit. it should
use the same upsert codepath if poss. we CANNOT ALLOW ANYTHING TO BE
DROPPED".

Operationally the same rule applies to compute. The CLI's `analyse`
command, for each analysis type, must enter the *same function* the FE
tile renderer enters, with the *same payload shape*, after running the
*same pre-passes* (whole-graph CF), against the *same graph state*
(scenario overrides, CF-enriched posteriors, workspace-scoped mappings).
Any place that the CLI hand-rolls a payload inline is a bug.

Until this holds, no FE-only defect can be triaged in CLI, no CLI-green
fix can be trusted for FE, and every integration test has a silent asterisk
next to it.

## Defect B — cohort() systematically too low across CF consumers

### Observed signal

The user is seeing it in three places at once:

1. In the funnel tile, `p_mean` for a stage that should be 85 % is much
   lower when the effective DSL carries `cohort(...)`. The funnel's
   `step_probability` (single-edge) on the same stage shows the sensible
   value. So the low number is introduced by whatever composes CF output
   into the funnel's `p_mean`.

2. In the on-graph (whole-graph CF) overlay, the per-edge `p_mean` written
   back onto the graph after the pre-pass is too low for cohort()-mode
   edges. This is the whole-graph CF writing the wrong scalar.

3. In the cohort\_maturity v3 chart, `p_infinity_mean` at saturation is
   much lower than both the edge's posterior mean and the window()
   equivalent.

The subject edge (`switch-registered→switch-success`) under test has, on
disk, `p._posteriorSlices.slices.window()` → `alpha=16.45, beta=2.57`
(p≈0.865) and `p._posteriorSlices.slices.cohort()` → `alpha=70.51,
beta=11.88` (p≈0.856). The live Bayesian side-panel shows 85.1 % window
and 85.2 % cohort, consistent with disk. There is no dispute about the
fit; the fit is fine. The defect is downstream of the fit, in how CF reads
and composes cohort-mode state.

### Where the defect likely sits

The resolver at [model\_resolver.py:367-383](graph-editor/lib/runner/model_resolver.py#L367-L383)
prefers `posterior_block.cohort_alpha / cohort_beta` when `temporal_mode
== 'cohort'` and falls back to `posterior_block.alpha / beta`. The FE
projects those cohort fields correctly from the cohort()-slice at
[posteriorSliceResolution.ts:237-250](graph-editor/src/services/posteriorSliceResolution.ts#L237-L250).
So far so good on that axis.

The suspicious cascade is in
[read\_edge\_cohort\_params in forecast\_runtime.py:727-736](graph-editor/lib/runner/forecast_runtime.py#L727-L736),
which is how the *carrier/span builder* reads the same edge in cohort
mode:

```
mu = _first_num(
    lat_post.get('path_mu_mean'),
    lat_post.get('mu_mean'),
    latency.get('path_mu'),
    latency.get('mu'))
sigma = _first_num(
    lat_post.get('path_sigma_mean'),
    lat_post.get('sigma_mean'),
    latency.get('path_sigma'),
    latency.get('sigma'))
```

This cascade falls back from path-scoped (`path_*`) to edge-scoped (`mu`,
`sigma`) values silently. The path-scoped fields are loaded from the
cohort() slice; the edge-scoped fields from the window() slice. The user
has previously flagged this as "the fallback is just wrong — it conflates
semantics with quality". If an upstream edge has cohort-slice fields
missing (the disk scan shows that only the subject edge has a cohort()
slice — none of the upstream `bayes-test-landing-to-created`,
`bayes-test-create-to-delegated`, `bayes-test-delegated-to-registered`
edges have a cohort slice on disk), this cascade silently gives them the
*window-mode* mu/sigma when building the cohort-mode carrier. That is the
exact shape of a defect that is asymptomatic in single-edge window() and
catastrophic in multi-edge cohort() composition.

The second suspicious reader is
[forecast\_runtime.py:1781-1864 `_build_runtime_x_provider`](graph-editor/lib/runner/forecast_runtime.py#L1781-L1864),
which uses `calculate_path_probability(graph_nx, anchor_uuid, x_uuid)`.
That helper reads only `p.mean` (and has no cascade to
`_posteriorSlices`). For any cohort()-mode query with a `from(X)` that is
downstream of the anchor, the reach-product is computed from raw `p.mean`
values that are the *analytic* estimates, not the cohort-slice posterior
means. When those analytics are stale or zero — which the Class A trace
showed does happen — the carrier collapses and the saturation rate
drops, not because of cohort() semantics but because the reach helper is
underspecified.

The third vector is the funnel's own composition of CF output.
`handle_conditioned_forecast` at
[api\_handlers.py:2338-2359](graph-editor/lib/api_handlers.py#L2338-L2359)
reads `last_row.get('p_infinity_mean')` (fallback `last_row.midpoint`)
off the cohort\_maturity v3 row builder and returns that as the per-edge
scalar. If `p_infinity_mean` is wrong, every CF consumer that trusts it is
wrong in the same way.

### What does not explain the defect

Three hypotheses have been investigated and parked.

First, the `path_mu_mean` alias. Earlier in the investigation we thought
the cohort-slice `mu_mean` being projected into `lat.posterior.path_mu_mean`
([posteriorSliceResolution.ts:308](graph-editor/src/services/posteriorSliceResolution.ts#L308))
was the root cause. We injected a bad `path_mu=-1.3129` into a synth graph
(`synth-mirror-4step`) via a parameter-file cohort() slice — the trace
confirmed `read_edge_cohort_params` resolved `mu=-1.3129 sigma=2.9882`.
The cohort ramp front-loaded (earlier arrivals) but the *asymptote stayed
at ~0.72* (matching the subject's `p`). Bad `path_mu` does not reproduce
the 0.19 asymptote.

Second, the edge `p.mean=0` collapse (Class A). For the `current`
scenario with no post-frontier data, `_build_runtime_x_provider` can
produce reach=0, which collapses the carrier and drops the sweep result
toward the window-equivalent. That pathway was pinned by a `[trace-carrier2]`
diagnostic (now removed) and reproduces in CLI, but it is distinct from
the "some-data, too-low" pathology the user is now calling out.

Third, the stale snapshot-DB cache theory. The FE result emitted to the
UI carries `metadata.source = 'snapshot_db'`, which looked like a
smoking gun for "cached stale result". Inspection of
[graphComputeClient.ts:676](graph-editor/src/lib/graphComputeClient.ts#L676)
confirmed the label is hardcoded on every cohort\_maturity response — it
signals that observations come from the snapshot DB, not that the whole
result is cached. Not a defect source.

### The data I currently have in hand

From the subject edge on disk (`bayes-test-gm-rebuild`,
`c57ab84f...→04332060...`):

- `p.posterior`: alpha=16.45 beta=2.57, p≈0.865. This is the window
  posterior. Projected verbatim from the window() slice.
- `p._posteriorSlices.slices.window()`: alpha=16.45 beta=2.57, mu\_mean=1.238,
  sigma\_mean=1.0908, onset\_mean=4.81.
- `p._posteriorSlices.slices.cohort()`: alpha=70.51 beta=11.88, mu\_mean=2.8878,
  sigma\_mean=0.5905, onset\_mean=2.29, path\_t95 HDI [46.8, 52.9].
- `p.latency.posterior`: fully populated with both edge-level (`mu_mean`,
  `sigma_mean`) and path-level (`path_mu_mean`, `path_sigma_mean`) derived
  from the two slices respectively.
- `p.model_vars`: three sources — `bayesian`, `analytic`, `analytic_be`.
  Promoted source is `bayesian`.

From the FE mark-session traces for the same subject, `current` scenario,
`cohort(23-Apr-26)`:

- Resolved subject in cohort-mode: `p_mean=0.8470 alpha=239.72 beta=43.30
  alpha_pred=8.23 beta_pred=1.49 qscoped=False`. The alpha and beta here
  are *not* the disk numbers 70.51/11.88, so there is a further projection
  or aggregation happening that I have not yet identified.
- Carrier built: `tier=parametric reach=0.01768 has_mc_cdf=True`.
- Carrier CDF median (single-cohort, a\_pop=1): `t0:0.0000 t1:0.6665
  t5:0.8342 t10:0.8856 t30:0.9428 t90:0.9743`.
- Single-cohort aggregates: `X_C(t90)=0.0172 Y_C(t90)=0.0145`,
  `Y/X=0.843`.
- Engine sweep: `IS_ESS=2000 cohorts_conditioned=0 shape=(2000, 93)`.

These are sensible numbers. The row rate at τ=90 is ~0.84, which is the
right answer. That is the contradiction: the v3-debug in the mark session
looks healthy, but the chart the FE renders carries `p_infinity_mean ≈
0.19` from an earlier compute. The mark session was at ts
1776976293+ (Apr 23 ~22:31 UTC); tmp4.log was dumped at Apr 23 20:05 UTC.
The dump is pre-mark-session. Either the mark session re-computed
correctly and the UI is showing a stale cached chart, or the current
session re-computes the same bad answer and the mark log is for a
different code-path (e.g., the multi-edge funnel rather than the
single-edge cohort\_maturity tile). I have not been able to isolate which.

From the parallel conversion-funnel response logged in the same session
(DSL `from(household-delegated).to(switch-success).visited(switch-registered)`,
`current` scenario, stage `switch-success`):

- `step_probability: 0.84183701060709` — single-edge, correct.
- `forecast_mean: 0.846153...` — correct.
- `p_mean: 0.10579313958337769` — CF-composed, all-stage. This is
  `step_switch_registered * step_switch_success ≈ 0.126 * 0.842 = 0.106`,
  which is numerically consistent with the single-edge outputs. The
  low value is the product, not a defect here. But this is the
  `window()` run; I do not have an equivalent cohort() dump in the mark
  log for this funnel.

### Investigative approaches tried

1. FE log forensics against tmp4.log and the python-server.jsonl mark
   session. Yielded the subject's resolved alpha/beta, carrier CDF and
   single-cohort X\_C/Y\_C values cited above. Did not yield a direct
   observation of a cohort() CF call returning 0.19 with current disk
   state — the only 0.19 observed is in the *dumped* chart, which
   predates the mark-session compute. This is what "cannot reproduce"
   concretely means in the current session.

2. Direct CLI reproduction of the FE DSL. CLI returns 0.833 for the
   same subject and DSL. Divergence per Defect A.

3. Injection of bad `path_mu_mean` / `path_sigma_mean` into a synthetic
   graph's parameter YAML. Shifted the ramp but not the asymptote.
   Parked as "not the mechanism".

4. Trace of `read_edge_cohort_params` for every cohort-mode edge via a
   `[v3-debug]` print. Confirmed the cascade behaviour described above.
   The edge-scope fallback fires silently on upstream edges that have
   no cohort slice, which is true of three of four upstream edges on
   the subject path in `bayes-test-gm-rebuild`.

5. Audit of the FE applyPatch field coverage against the worker output.
   Identified several fields the applier does not read (`kappa_lat_mean`,
   cohort-slice `delta_elpd`, `pareto_k_max`, `n_loo_obs`, `ppc_*`).
   Not the immediate cause of the cohort() pathology but they are data
   the CLI loses versus what the worker produced. Need fixing as a
   separate sweep.

6. Post-refit sanity check. After re-running the Bayes fit for the
   subject edge, disk posterior slices look unchanged in shape and
   consistent with the FE side-panel (85.2 % cohort, path\_t95 HDI
   48–53 d). The defect survives the fresh fit.

### What remains unknown

The immediate unknown is whether the FE is currently recomputing the
0.19 on a fresh request or reading it from `canvasAnalysisResultCache`.
Mark-session evidence points to fresh compute being correct but I have
not captured a cohort\_maturity response body in that mark session to
prove it. Without Defect A being fixed, there is no way to run the FE's
exact compute path from the CLI and force a fresh recompute in a
deterministic environment.

The second unknown is the specific provenance of `alpha=239.72,
beta=43.30` in the mark-session resolver output. That is neither the
disk window() posterior (16.45/2.57) nor the disk cohort() slice
(70.51/11.88) nor any obvious sum of the two. It looks like the output
of some additional projection or accumulation inside
`prepare_forecast_runtime_inputs`. Identifying what projection produced
those numbers is probably the shortest path to the defect, because
whatever is perturbing alpha/beta by a factor of ~3.4 is the smoking gun
for the "cohort CF too low" symptom on multi-edge paths.

The third unknown is whether the pathology scales with the number of
upstream edges lacking a cohort() slice. The subject path in
`bayes-test-gm-rebuild` has three of four upstream edges without one.
A single-hop subject with a subject edge that *does* have a cohort()
slice is the cleanest test — if that test is clean, the defect is in the
upstream-cohort-slice missing cascade. If that test is *also* dirty, the
defect is deeper in the sweep itself.

## Recommended sequencing

**First, fix Defect A.** Nothing else can be trusted until it is fixed.
The concrete work is: converge CLI `analyse` and CLI CF dispatch onto the
FE's `analysisPipelineService` / `conditionedForecastService` entrypoints;
run the whole-graph CF pre-pass from the CLI when the FE would have run
it; respect `scenariosContext` in CLI mode so multi-scenario fan-out is
the same on both sides; stop hand-rolling payloads for conditioned forecast
in `analyse.ts`. Success criterion: for a given graph snapshot and DSL,
CLI and FE produce byte-identical BE request payloads and byte-identical
BE responses.

**Second, reproduce Defect B via CLI.** Once CLI and FE agree, repeat
the bayes-test-gm-rebuild cohort()/window() comparison and expect them
to diverge in the same way FE does. If they do not diverge, the defect
is in some FE-only state the CLI does not see — which would mean Defect A
is still incomplete and we go back to step one.

**Third, once reproducible, bisect `compute_cohort_maturity_rows_v3`.**
Specifically identify why resolved `alpha`/`beta` for the subject edge in
cohort-mode emerges as the mark-session numbers (239.72/43.30) rather
than the disk numbers (70.51/11.88). That's where the systematic low
asymptote most likely originates. Secondary suspects in order are the
`read_edge_cohort_params` window-fallback cascade on upstream edges
without cohort slices, the `calculate_path_probability` reach helper that
reads only `p.mean`, and the funnel/whole-graph composer that reads
`p_infinity_mean` from v3 rows.

## Files referenced

- [graph-editor/src/cli/bootstrap.ts](graph-editor/src/cli/bootstrap.ts)
- [graph-editor/src/cli/commands/analyse.ts](graph-editor/src/cli/commands/analyse.ts)
- [graph-editor/src/cli/commands/bayes.ts](graph-editor/src/cli/commands/bayes.ts)
- [graph-editor/src/services/analysisPipelineService.ts](graph-editor/src/services/analysisPipelineService.ts)
- [graph-editor/src/services/conditionedForecastService.ts](graph-editor/src/services/conditionedForecastService.ts)
- [graph-editor/src/services/fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
- [graph-editor/src/services/bayesPatchService.ts](graph-editor/src/services/bayesPatchService.ts)
- [graph-editor/src/services/posteriorSliceResolution.ts](graph-editor/src/services/posteriorSliceResolution.ts)
- [graph-editor/src/hooks/useCanvasAnalysisCompute.ts](graph-editor/src/hooks/useCanvasAnalysisCompute.ts)
- [graph-editor/src/lib/conditionedForecastGraphSnapshot.ts](graph-editor/src/lib/conditionedForecastGraphSnapshot.ts)
- [graph-editor/src/lib/graphComputeClient.ts](graph-editor/src/lib/graphComputeClient.ts)
- [graph-editor/lib/api\_handlers.py](graph-editor/lib/api_handlers.py)
- [graph-editor/lib/runner/cohort\_forecast\_v3.py](graph-editor/lib/runner/cohort_forecast_v3.py)
- [graph-editor/lib/runner/forecast\_runtime.py](graph-editor/lib/runner/forecast_runtime.py)
- [graph-editor/lib/runner/forecast\_state.py](graph-editor/lib/runner/forecast_state.py)
- [graph-editor/lib/runner/model\_resolver.py](graph-editor/lib/runner/model_resolver.py)
