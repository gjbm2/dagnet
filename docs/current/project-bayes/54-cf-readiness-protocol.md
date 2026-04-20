# CF Readiness Protocol — Signalling Enrichment State to Analyses

**Status**: Design — not yet implemented. Dependency for funnel v2 (doc 52) and future CF-dependent analysis types.
**Date**: 20-Apr-26
**Relates to**: [FE_BE_STATS_PARALLELISM.md](../codebase/FE_BE_STATS_PARALLELISM.md) (CF race mechanics), [STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) (what each pass writes), [doc 45 — Forecast Parity Design](45-forecast-parity-design.md) (CF pass ownership of `p.mean, p.sd, completeness, completeness_stdev`), [doc 50 — CF Generality Gap](50-cf-generality-gap.md) (lagless edge limitations), [doc 52 — Funnel Hi/Lo Bars Design](52-funnel-hi-lo-bars-design.md) (first consumer), [surprise-gauge-design.md](../codebase/surprise-gauge-design.md) (existing CF-dependent consumer)

---

## 1. Problem statement

The BE CF pass (`/api/forecast/conditioned`) is the sophisticated enrichment that produces query-scoped, IS-conditioned per-edge scalars (`p.mean`, `p.sd`, `completeness`, `completeness_stdev`) used by multiple analysis types. It is asynchronous and sometimes slow:

- **Fast path** (< 500 ms): merges into first render.
- **Slow path** (exceeds 500 ms, observed 2–3 s on larger graphs): first render uses FE/BE-topo fallback; CF overwrites on arrival and triggers a second render.

Today's coping strategy is naive: every analysis reads the flat `edge.p.*` fields whenever it renders. If CF hasn't landed yet, the analysis silently reads the topo-pass fallback; when CF arrives, the graph fields change and consumers re-render. This works for the **scalar funnel** (today's `run_conversion_funnel`) — the numbers just shift a little between renders and no one notices. It breaks down once analyses consume **structure** that's only meaningful when CF has run:

- **Funnel v2 e+f mode** (doc 52): bar heights + bands derived from CF-written `p.mean, p.sd`. If those fields come from topo fallback instead, the "conditioned posterior" bars are a lie. Bands will measurably shift when CF lands.
- **Surprise gauge** ([surprise-gauge-design.md](../codebase/surprise-gauge-design.md)): already computes IS-conditioned z-scores from CF-era draws. Similar failure mode if CF is pending.
- **Future analyses** — bridge charts, attribution, scenario diffs — will all depend on CF-conditioned quantities.

The class of problem is not specific to funnels. It is: **an analysis type declares a dependency on the BE CF pass, but the standard fetch pipeline doesn't guarantee CF has run before the analysis renders.**

We need a general signalling mechanism.

## 2. Constraints

**Constraint A — no graph-file persistence.** Enrichment readiness is ephemeral per-fetch state. It must not be written into graph files (on disk, via `fileRegistry` or IDB persistence), because:

- The graph file is the user's source of truth for the model; enrichment provenance is orthogonal.
- Graph files are shared across browser sessions, users, and git. Enrichment state is session-local.
- Re-serialising the graph with enrichment flags would churn dirty state on every fetch.

Readiness state lives **in-memory**, in a dedicated service, not as a field on the graph object.

**Constraint B — no atomic updates to the graph.** When the user changes the query DSL, Stage 2 of the fetch pipeline updates the graph progressively — FE topo pass lands first, BE topo pass later, CF pass whenever it arrives. Different edges may have different enrichment state at any given moment (especially true for CF whole-graph mode, where per-edge results are applied as they return). We cannot mandate atomic graph updates without breaking the fetch performance model, and shouldn't.

Therefore readiness is **per-edge**, not graph-global.

**Constraint C — generation-aware.** Prior passes' arrivals for older fetch cycles must not falsely satisfy readiness for the current query. The existing `_conditionedForecastGeneration` and `_beTopoPassGeneration` counters in `fetchDataService.ts` already protect writes from stale arrivals; readiness state must track the same generation.

**Constraint D — non-blocking by default.** Analyses must not refuse to render while waiting for CF. A chart showing approximate values with a "upgrading…" indicator is better than a blank canvas for 2 seconds.

**Constraint E — per-analysis-type opt-in.** Analyses that don't care about CF (e.g. path counting, evidence-only scalar funnel) should not pay any UI cost. Only CF-dependent analyses subscribe to readiness.

## 3. Design

### 3.1 In-memory readiness store

A new service, sketched as `enrichmentStatusStore` (in `src/services/`), holds per-edge enrichment state for the current fetch generation:

```
EnrichmentStatus {
  edgeUuid: string
  generation: number              // matches fetchDataService's current generation
  scenarioId: string              // per-scenario tracking (CF is per-scenario)
  passes: {
    fe_topo: { applied_at: Date } | null
    be_topo: { applied_at: Date } | null
    cf:      { applied_at: Date } | null
  }
}
```

The store exposes:
- `getStatus(edgeUuid, scenarioId): EnrichmentStatus | null`
- `subscribe(edgeUuids, scenarioId, callback)` — notifies when any of the listed edges changes state
- `reset(generation)` — called by fetchDataService when a new fetch generation begins; clears stale entries
- `markApplied(edgeUuid, scenarioId, pass, generation)` — called by each pass's apply-back path when it succeeds

**Write sites** (where `markApplied` gets called):
- FE topo: `statisticalEnhancementService.ts` after `enhanceGraphLatencies` → `applyBatchLAGValues`, per edge touched
- BE topo: `beTopoPassService.ts` → `applyBeTopoResult`, per edge written
- CF: `conditionedForecastService.ts` → `applyConditionedForecastToGraph`, per edge written

These sites already know the edge identity and the current generation.

**Read sites**: analysis hooks that declare CF dependency (see §3.3).

### 3.2 Per-analysis-type dependency declaration

Extend `analysis_types.yaml` with a new per-type field:

```
cf_dependency: required | preferred | none
```

| Value | Behaviour |
|---|---|
| `none` | Analysis ignores CF state. Renders whenever graph state is sufficient (current behaviour). |
| `preferred` | Analysis renders approximate output from topo-pass fallback when CF pending; upgrades when CF lands. Requires the analysis to supply approximation logic and a status badge. |
| `required` | Analysis shows a loading state until CF lands (or timeout). No fallback rendering. |

Initial mapping:

| Analysis type | cf_dependency | Rationale |
|---|---|---|
| `path`, `path_to_end`, `path_through`, `branch_comparison`, `end_comparison` | `none` | Scalar path products; topo fallback is perfectly usable |
| `conversion_funnel` (v1, scalar) | `none` | Same as path family |
| `conversion_funnel_v2` (proposed) | `preferred` | Approximate via promotion fallback; upgrades cleanly |
| `cohort_maturity` | `none` | Runs its own MC in-band; doesn't consume CF-written scalars |
| `surprise_gauge` | `none` (interim per doc 55 Tier 0); `required` (post-cut-over, see §8) | Superseded by [doc 55](55-surprise-gauge-rework.md). Doc 55 makes the gauge a self-contained backend sweep with no approximation path. Interim: gauge runs its own CF, does not consult on-edge CF scalars, so readiness signalling is not engaged. Post-cut-over: gauge reads gauge-specific CF scalars from the edge (see §8 for the contract extension) and becomes `required` — fail-loud rather than approximate because doc 55 rejects the approximate path |
| Future: bridge chart, attribution, scenario diff | TBD (likely `preferred`) | Decide per-type when designed |

No analysis is `required` in the initial mapping — avoiding hard blocking is the non-blocking default. `required` is available for future analyses where approximate rendering is genuinely misleading (e.g. fan charts over conditioned posteriors with very different band widths; an approximate fan would misinform rather than inform).

### 3.3 Analysis result status contract

Analysis runners emit an additional status object alongside their usual payload:

```
{
  result: ...,                    // the usual rows/summary
  enrichment_status: {
    state: "definitive" | "approximate" | "pending",
    awaiting: ["cf"] | [],
    cf_applied_edges: number,     // count of path edges where CF has landed
    cf_total_edges: number,       // count of edges the analysis consumed
    generation: number,
    rendered_at: Date,
  }
}
```

States:

- **`definitive`**: all CF-dependent edges have CF applied (or analysis declares `cf_dependency: none`). No upgrade pending.
- **`approximate`**: analysis rendered with topo-pass fallback for at least one edge. Chart shows a badge ("model refinement pending…"). Will re-render when CF lands.
- **`pending`**: analysis is `cf_dependency: required` and CF hasn't landed for any path edge. Chart shows loading state.

This lets the chart renderer show the right UI without knowing the specifics of each analysis type.

### 3.4 Re-render trigger

When an analysis renders with `state: "approximate"`, its client-side hook subscribes to `enrichmentStatusStore` for the path edges. When CF lands for a subscribed edge (and the generation still matches), the subscription fires and re-invokes the analysis.

Re-render should debounce — if CF lands for edges 3, 7, and 12 of a 20-edge funnel within 200 ms of each other, one re-render suffices. Recommended debounce window: ~100 ms.

### 3.5 Approximation logic per analysis type

Each `cf_dependency: preferred` analysis must supply approximation logic — i.e. the rule for what to render when CF hasn't landed. Guidance:

- **Funnel v2 e+f**: read whatever is promoted to `edge.p.mean, edge.p.sd` (falls through CF → analytic_be → analytic via `modelVarsResolution.ts`). Approximate bands are wider-than-truth because topo's `p.sd` is heuristic rather than IS-conditioned. Shows badge.
- **Surprise gauge**: superseded by [doc 55](55-surprise-gauge-rework.md). The gauge runs its own CF sweep inline for its own subject (interim pattern per §8) and produces a definitive result or no result at all. There is no approximation path and no badge under this protocol in the interim — the gauge is `cf_dependency: none`. Post-cut-over, the gauge becomes `cf_dependency: required`, reading gauge-specific CF scalars (see §8) from the edge and rendering a pending state until the readiness store confirms CF has applied. Doc 55 §3.3 lists the failure reasons; none of them are "approximate".
- **Others**: defined per analysis at design time.

Approximation is an **expected correctness degradation**, not a silent failure. The badge makes this visible. Document the approximation's accuracy characteristics in the analysis-type's own design doc.

### 3.6 Timeout and failure paths

If CF fails (error) or times out beyond a configurable deadline (say 10 s), the analysis:
- `preferred`: stays on approximate, badge changes from "refining…" to "couldn't refine — showing approximate" with a tooltip explaining (linking to CF generality gap, doc 50, where relevant).
- `required`: falls back to approximate with a prominent warning.

CF failure events are already logged to session log (`CONDITIONED_FORECAST` error level). The readiness store should expose failure state too:

```
passes.cf = { applied_at: Date } | { failed_at: Date, reason: string } | null
```

Subscribers can distinguish "CF still pending" from "CF failed — no upgrade coming".

## 4. Interaction with progressive graph updates

Progressive updates across scenarios and edges are the norm (constraint B). The readiness store must handle this cleanly:

- **Per-edge per-scenario tracking**: each `(edgeUuid, scenarioId, generation)` tuple is a cell in the readiness matrix. An analysis that touches multiple edges across multiple scenarios subscribes to all of them.
- **Partial satisfaction**: `enrichment_status.cf_applied_edges / cf_total_edges` tells the user how close to definitive the analysis is. A funnel with 18/20 edges CF-applied is approximate but close; 0/20 is approximate and far.
- **Scenario isolation**: readiness for scenario A doesn't imply readiness for scenario B. Each scenario's CF call is independent.

## 5. Implementation plan

**M1 — Readiness store**
- Create `enrichmentStatusStore.ts` in `src/services/`
- API: `getStatus`, `subscribe`, `reset`, `markApplied`
- Unit tests: store mutations, generation invalidation, subscription notifications

**M2 — Pass apply-back wiring**
- Call `markApplied` from FE topo, BE topo, and CF apply paths
- Integration test: run a fetch, verify all three passes reach the store with correct generation

**M3 — Analysis type dependency field**
- Add `cf_dependency` to `analysis_types.yaml` schema and types
- Populate initial mapping per §3.2
- Validation: analysis types with `cf_dependency: preferred` must have approximation metadata

**M4 — Result status contract**
- Extend analysis result schema with `enrichment_status`
- Runners that consume CF-dependent fields compute `cf_applied_edges / cf_total_edges` at render time by querying the store
- Schema parity test

**M5 — FE badge and re-render hook**
- Chart renderer reads `enrichment_status.state` and shows badge
- Analysis hook subscribes to readiness store on `state: "approximate"` and triggers re-render when upgrade possible
- Visual regression test: same chart rendered approximate then definitive

**M6 — First consumer: funnel v2**
- Wire funnel v2 (doc 52) through the protocol as `cf_dependency: preferred`
- Verify approximate → definitive transition on CF slow path
- Contract test: funnel v2 M1-M3 from doc 52 must include a readiness-aware path

**M7 — Second consumer: surprise gauge (superseded)**
- Superseded by [doc 55](55-surprise-gauge-rework.md). Under doc 55 Tier 0 the gauge runs its own sweep inline (per §8 interim pattern) and does not consume on-edge CF scalars, so it does not engage this protocol in the initial rework. The Tier-2 cut-over — reading gauge-specific CF scalars from the edge and subscribing to the readiness store as `cf_dependency: required` — is covered in §8 and listed there as a performance-driven follow-on workstream.

**Dependencies**: none external. M1-M5 are prerequisites for funnel v2 M1 (doc 52). M7 is superseded; see §8 for the surprise gauge's cut-over.

## 6. Open questions

**Q1 — should readiness track per-scenario or per-(scenario × edge)?**
CF is per-scenario (each scenario has its own graph). Edges are shared keys but scenarios override fields. Recommendation: per-(scenario × edge) to match CF's own granularity. Happy to revisit if this becomes too noisy.

**Q2 — what about FE/BE topo readiness? Do any analyses depend on them specifically?**
Unclear today. FE topo always lands first, so there's no "waiting for FE topo" problem in practice. BE topo lands before CF usually, but `cf_dependency: preferred` captures the interesting case. Could generalise to `topo_dependency` later if surface appears; for now, track all three passes in the store but expose only CF in the analysis contract.

**Q3 — interaction with share links and live share**
When a viewer opens a share link, the fetch pipeline runs the same Stage 2 enrichment. Readiness works identically. Live-share broadcasts should not include enrichment state (it's receiver-local); the receiver computes it from their own fetch.

**Q4 — CLI behaviour**
CLI callers set `awaitBackgroundPromises=true` ([FE_BE_STATS_PARALLELISM.md](../codebase/FE_BE_STATS_PARALLELISM.md) §"CLI determinism") which already awaits CF before returning. So CLI analyses always render definitive. No special CLI handling needed — the status contract still works, CLI just never sees `state: "approximate"` in practice.

**Q5 — session log integration**
Should approximate-state renders log a session-log entry? Useful for forensic debugging ("user saw approximate funnel for edge X at generation G"). Recommend: yes, at `info` level, tied to the existing `CONDITIONED_FORECAST` log category. One entry per render transition, not per edge.

**Q6 — what if CF is disabled or unavailable?**
If CF endpoint is unreachable, all `cf_dependency: preferred` analyses stay on approximate indefinitely. Badge copy should reflect "CF unavailable" differently from "CF pending". Requires distinguishing "never fired" from "fired-and-failed" from "pending" in the readiness store (handled via the three-state `passes.cf` field in §3.6).

## 7. Why this belongs as a separate doc (not doc 52)

- **Cross-cutting**: consumed by funnel v2, surprise gauge, future bridge/attribution/etc. Design lives in one place, all consumers reference it.
- **Separable implementation**: M1-M5 can land before any consumer is built; provides the platform.
- **Orthogonal to the statistical semantics**: doc 52 is about what the funnel *means*; this doc is about *when* it can render correctly. Same as doc 29's engine design is separate from per-analysis applications.

## 8. Interim pattern — per-analysis CF calls before M1-M6 land

M1-M6 provide the shared readiness + enrichment-reuse platform. Until they land, CF-dependent analyses can make **their own per-query CF calls**, paying duplicate compute for correctness.

**Interim approach**:
- Funnel v2 (doc 52) e+f and surprise gauge (doc 55 rework) each invoke `compute_forecast_trajectory` — or `handle_conditioned_forecast` scoped to the analysis's edge set — as part of their own runner, rather than reading CF-written fields from the graph.
- The analysis is self-contained and correct regardless of the fetch-pipeline CF race, at the cost of recomputing what the fetch-pipeline CF pass would have already computed.

**What's duplicated (temporarily)**:
- Per-query CF computation done by the fetch pipeline is repeated by each CF-dependent analysis for its own edge set.
- For a single funnel on a 5-edge path, that's five extra `compute_forecast_trajectory` calls per analysis request.
- Latency cost is linear in path length per analysis, not aggregated across analyses on the same render.

**When to cut over to the shared protocol**:
- M1-M5 land (readiness store + pass markers + dependency field + status contract + FE badge/hook).
- Then CF-dependent analyses retrofit to read enriched graph fields and subscribe to the readiness store. The duplicate per-analysis CF calls are retired.
- This is explicitly a **performance optimisation**, not a correctness change. The analysis outputs should match within MC tolerance before and after the cut-over; contract tests at cut-over time must verify this.

**Why this ordering is fine**:
- CF-dependent analyses are new — funnel v2 doesn't exist yet; surprise gauge rework (doc 55) is awaiting approval. Getting them correct on day one is more valuable than saving the duplicate compute.
- The shared protocol (M1-M6) is the right long-term architecture but adds new in-memory plumbing across FE services; doing it carefully is preferable to rushing it for the sake of an early funnel rollout.
- The interim pattern keeps the CF call scoped to the analysis's actual edges — which is narrower than whole-graph CF. For a 5-edge funnel, the interim call is cheaper than the fetch-pipeline's whole-graph CF would have been. So it's not wasteful in absolute terms; it's wasteful only *relative to* reading cached results.

**What this doc 54 prescribes for the interim period**:
- Funnel v2's runner may call CF directly. Document this in doc 52 as expected interim behaviour.
- Surprise gauge's rework (doc 55) may call its own sweep — already the design direction per doc 55's "self-contained" framing.
- Neither analysis writes its CF outputs back to the shared readiness store yet (the store doesn't exist). Once the store lands, both retrofit to read-from-shared rather than compute-locally.

The shared-protocol cut-over (M1-M7 from §5) becomes a dedicated follow-on workstream after funnel v2 and surprise gauge rework ship. Listed as a performance-driven refactor, not a functional change.

### 8.1 CF scalar output contract — extension required for the surprise gauge cut-over

The surprise gauge cannot cut over to reading on-edge CF scalars until CF's per-edge scalar output is extended. The two gauge variables per [doc 55](55-surprise-gauge-rework.md) need four scalars that the current contract does not supply, and one existing pair needs disambiguating.

**Currently CF-written** (per §1 and [FE_BE_STATS_PARALLELISM.md](../codebase/FE_BE_STATS_PARALLELISM.md)): `edge.p.mean`, `edge.p.sd`, `edge.p.latency.completeness`, `edge.p.latency.completeness_stdev`.

**Problem 1**: `edge.p.mean` is the **blended** (f+e) rate — the weighted combination of forecast and evidence scalars, as written by the CF fast/slow path to drive user-facing probability display. It is not the unconditioned posterior-predictive expected rate `E[p × c̄]` across draws, which is what doc 55's `p` variable compares observed aggregate `Σk/Σn` against. Reading `edge.p.mean` as the gauge's "expected" would silently substitute the wrong quantity.

**Problem 2**: `edge.p.latency.completeness` and `completeness_stdev` are a single pair. The gauge needs **both** unconditioned and conditioned completeness moments, because its `completeness` variable compares the two against each other (the surprise is how much the evidence shifts the model's belief about maturity). A single pair cannot encode the comparison.

**Required CF output fields for gauge cut-over** (names provisional — finalise at implementation time alongside doc 47):

- `edge.p.posterior_predictive.unconditioned.mean` and `.sd` — n-weighted mean and SD of `p_s × c̄_s` across the unconditioned posterior draws the sweep already produces. This is the gauge `p` variable's expected distribution. All downstream consumers that want the unconditioned posterior-predictive (not the blended scalar) read from here.
- `edge.p.latency.completeness_unc_mean` and `_sd` — n-weighted mean completeness across **unconditioned** draws, and its SD. "What the model thinks maturity is, before conditioning on this window's evidence."
- `edge.p.latency.completeness_cond_mean` and `_sd` — same, across **IS-conditioned** draws. "What the model thinks maturity is, after seeing how this window's cohorts actually converted."

All four unc/cond completeness scalars are already computed inside every CF sweep invocation; the change is persistence rather than new compute.

**Disambiguation**: the existing `completeness` / `completeness_stdev` pair currently serves a specific consumer path (doc 45, forecast parity). Leave it in place with its current semantics but document which flavour (conditioned, unconditioned, or blended) it represents, and alias or name it consistently with the new fields so that readers cannot mistake one for another.

Cut-over M8 (surprise gauge, post-extension): once the above scalars are reliably written on each edge by the whole-graph CF pass (doc 47) and M1-M5 of this protocol have shipped, the gauge handler drops its inline `compute_forecast_trajectory` call and becomes a short dict-read-and-z-score projection. This is the performance upgrade called out in doc 55 §4.6 and in the cost discussion that led to §8.
