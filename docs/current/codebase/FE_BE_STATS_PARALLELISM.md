# FE/BE Stats Parallelism

Why both frontend and backend run the same statistical topo pass, how they're coordinated, and the transition plan.

**See also**: `STATS_SUBSYSTEMS.md` (**start here if you don't already know how the five statistical subsystems differ** — this doc covers only FE topo / BE topo / CF orchestration; `STATS_SUBSYSTEMS.md` §7 has the canonical "which Python entry point do I call" table), `LAG_ANALYSIS_SUBSYSTEM.md` (what the topo pass actually computes — t95, mu/sigma, lag fit detail), `STATISTICAL_DOMAIN_SUMMARY.md` (broader statistical architecture), `PROBABILITY_BLENDING.md` (how computed values feed into blended probabilities)

## Context

DagNet currently runs the same "analytic topo pass" (Stage 2 of the fetch pipeline) in **both** TypeScript (FE) and Python (BE). This is intentional and temporary — a zero-downtime migration strategy from FE-only to BE-only computation.

## What the topo pass computes

Per edge, given raw cohort evidence:
- **t95**: 95th percentile lag (days) — when 95% of conversions have occurred
- **mu, sigma**: log-normal distribution parameters for lag CDF fitting
- **path_t95, path_mu, path_sigma**: cumulative path-level equivalents (Fenton-Wilkinson composition)
- **completeness**: fraction of conversions completed by the query date
- **blended_mean**: forecast-weighted conversion rate = `w_evidence * evidence.mean + (1 - w_evidence) * forecast.mean`
- **p_infinity (forecast)**: mature window baseline conversion rate

### Dual-evidence treatment: what's query-scoped and what isn't

Both FE and BE topo passes deliberately split the cohort evidence they
consume into two sets. The split is load-bearing — mixing them
produces survivor bias on one side and stale evidence on the other.

| Derivation | Evidence used | Why |
|---|---|---|
| Lag fit (`mu`, `sigma`, `t95`) | **Full unscoped cohorts** — all history | The lag shape is a property of the edge, not of the user's current query. Scoping would bias the fit toward newer cohorts that haven't finished maturing ("survivor bias") |
| `p_infinity` (asymptote from mature cohorts) | **Full unscoped cohorts**, filtered to `age ≥ t95` with recency weighting | Needs fully-matured cohorts to estimate the true endpoint rate. Query-window cohorts are typically not yet mature |
| `evidence.{n, k, mean}` | **Query-scoped cohorts** (the DSL window) | This is the user's "what actually happened in the window I'm looking at". Must match the DSL |
| `completeness`, `completeness_stdev` | **Query-scoped cohorts** | "How mature is the evidence we just aggregated" — must match the evidence set |
| `alpha`, `beta` on `model_vars[analytic/analytic_be]` | Derived from **query-scoped** `total_k, total_n` (Jeffreys-style: `α = k+1, β = n-k+1`) | These are a query-scoped Jeffreys posterior, not an aggregate prior |

**Implication for downstream consumers**: the `α, β` on `analytic` /
`analytic_be` is **already a query-scoped posterior**. It is not a
prior that should be updated with query-scoped evidence again —
doing so double-counts. This is the key difference from
`model_vars[bayesian].probability.{alpha, beta}`, which is aggregate
(not query-scoped) and is a legitimate prior for conjugate updates
or as an IS proposal.

See [STATS_SUBSYSTEMS.md §5 Confusion 8](STATS_SUBSYSTEMS.md) for the
full scoping table across all three sources.

## The two implementations

### FE topo pass (blocking, synchronous)

- **Service**: `statisticalEnhancementService.ts` → `enhanceGraphLatencies()`
- **Triggered by**: `fetchDataService.ts` Stage 2, after per-item fetches complete
- **Writes to**: `analytic` model_vars entry on each edge
- **Blocks UI**: yes — runs synchronously in the fetch pipeline
- **Source of truth**: currently authoritative (UI displays these results)

### BE topo pass (fire-and-forget)

- **Service**: `beTopoPassService.ts` → `runBeTopoPass()`
- **Endpoint**: `POST /api/lag/topo-pass` → `lib/runner/stats_engine.py` (Python port of the FE logic)
- **Triggered by**: `fetchDataService.ts` Stage 2, fired concurrently with the FE topo pass
- **Writes to**: `analytic_be` model_vars entry on each edge; also triggers `applyPromotion` so the selected source (per `model_source_preference`) is re-promoted into the flat latency fields
- **Blocks UI**: no — a `.then()` handler applies results whenever the promise resolves. Stale responses are discarded via a generation counter (`_beTopoPassGeneration`).
- **Source of truth**: preferred when available (promotion hierarchy prefers `analytic_be` over `analytic`)

**Note**: the BE topo pass (`/api/lag/topo-pass` via `stats_engine.py`) is distinct from the generic `/api/stats-enhance` endpoint (`stats_enhancement.py`), which handles raw-aggregation enhancement (trends, MCMC-style summaries, robust stats).

### Conditioned forecast pass (CF, race-based)

- **Service**: `conditionedForecastService.ts` → `runConditionedForecast()`
- **Endpoint**: `POST /api/forecast/conditioned` → `handle_conditioned_forecast` (doc 45)
- **Triggered by**: `fetchDataService.ts` Stage 2, fired alongside BE topo pass
- **Writes to**: per-edge `p.mean`, `p.sd`, `latency.completeness`, `latency.completeness_stdev` (CF owns these scalars per doc 45)
- **Blocks UI**: partially — raced against a **500ms** deadline (`CF_FAST_DEADLINE_MS`). Fast path merges CF scalars into the same FE apply (single render); slow path renders FE fallback and overwrites on arrival.
- **Source of truth**: CF `p.mean` / completeness supersede FE's blended equivalents when CF returns non-empty results.

## Orchestration in the fetch pipeline

Three passes run per fetch, coordinated in `fetchDataService.ts` Stage 2. The sibling rebalancing path (`UpdateManager.applyBatchLAGValues`) runs exactly once with whichever scalars are available at render time, regardless of which pass produced them.

**Flow**:

1. FE topo pass runs synchronously (`enhanceGraphLatencies`), producing `EdgeLAGValues[]`. Results are **held, not applied yet**.
2. BE topo pass (`runBeTopoPass`) fires and returns a promise — fire-and-forget. When it resolves, its scalars are upserted onto `analytic_be` model_vars and promotion re-runs on the freshest graph.
3. Conditioned forecast (`runConditionedForecast`) fires and returns a promise. `Promise.race` waits up to **500ms** for it.

### CF fast path vs slow path

The naming **fast path** / **slow path** refers to whether CF returns within the 500ms deadline. It is one call — the path just reflects how quickly it responds.

| CF outcome | Renders | What happens |
|----------|---------|--------------|
| CF responds < 500ms with usable `p_mean` | 1 | CF scalars (p_mean, p_sd, completeness, completeness_sd) merged into FE `EdgeLAGValues`; `applyBatchLAGValues` runs once with the merged values — no FE-fallback flash. |
| CF responds < 500ms with empty/failed | 1 | FE fallback applied. Warning logged. |
| CF exceeds 500ms | 2 | FE fallback applied immediately; a `.then()` handler overwrites `p.mean` (and completeness) on CF's eventual arrival, triggering a second render. |
| CF fails after 500ms | 1 | FE fallback stays. Error logged. |

Stale CF responses (from a previous fetch cycle, identified by `_conditionedForecastGeneration`) are discarded.

BE topo pass is **independent** of the CF race. It applies on its own schedule whenever it arrives; its model vars land on `analytic_be` and promotion re-runs on top of whatever CF/FE state exists at that moment.

**Merge semantics for CF fast path**: `mergeCfIntoFe` overwrites `blendedMean`, `forecast.mean`, `latency.completeness`, `latency.completeness_stdev` on each `EdgeLAGValues` entry where CF returned a finite `p_mean`. FE's latency fit fields (mu, sigma, t95, path_t95, median_lag_days, etc.) are preserved — those are FE topo's responsibility. Evidence (n, k, evidence.mean) also stays from FE — authoritative from actual data.

**CLI determinism**: CLI callers set `awaitBackgroundPromises=true` on `runStage2EnhancementsAndInboundN`, which awaits all fire-and-forget handlers (CF slow-path overwrite, BE topo apply) before returning. Browser callers don't set this — they render fast and let handlers catch up.

### Session log entries

Payload shape: all three pass-completion entries include a per-edge sample `{ uuid, p_mean, p_sd, completeness, completeness_sd|completeness_stdev }` so forensic runs can reconstruct the values each pass applied. CF uses `completeness_sd` on its response; bounded BE-topo samples may omit `completeness_stdev` entirely because the analytic topo pass no longer computes conditioned completeness uncertainty.

`BE_TOPO_PASS`:
- `info` — BE topo pass started for N edges (gen G)
- `info` — BE topo pass model vars applied in Nms, with per-edge payload
- `warning` — BE topo pass result discarded (stale gen)
- `warning` — BE topo pass returned null/empty after Nms
- `error` — BE topo pass failed / apply failed

`CONDITIONED_FORECAST`:
- `info` — Conditioned forecast started (gen G, DSL)
- `info` — Conditioned forecast applied in Nms (fast path, single render), with per-edge payload
- `info` — Conditioned forecast pending after 500ms — FE fallback applied
- `info` — Conditioned forecast subsequent overwrite applied in Nms, with per-edge payload (slow path)
- `warning` — Conditioned forecast returned empty/no usable p.mean after Nms
- `warning` — Conditioned forecast result discarded (stale gen)
- `error` — Conditioned forecast failed / apply failed

`FE_BE_PARITY` (one child per edge, emitted after BE topo applies, see `logParity`): FE→BE side-by-side for completeness, completeness_stdev, p_mean, p_sd.

## What FE sends to BE

`beTopoPassService` packages **deterministic input parity** so BE can mirror FE's derivations exactly:

| Field | Purpose |
|-------|---------|
| `graph` | Full graph structure |
| `cohort_data` | Per-edge cohort arrays (filtered by DSL) |
| `edge_contexts.onset_from_window_slices` | Weighted median onset (from window slices) |
| `edge_contexts.window_cohorts` | Cohorts aggregated from window() slices |
| `edge_contexts.scoped_cohorts` | Windowed cohorts |
| `edge_contexts.n_baseline_from_window` | Sum of n from window() slices |
| `forecasting_settings` | Lambda, half-life, blend config |

## Parity comparison

**Service**: `forecastingParityService.ts` → `compareModelVarsSources()`

After BE writes `analytic_be` entries, compares against `analytic` entries on each edge:

| Metric | Warning threshold | Error threshold |
|--------|-------------------|-----------------|
| mu, sigma | 0.1% relative | 1% relative |
| t95 | ±0.5 days | ±0.5 days |
| p.mean | 0.1% relative | 1% relative |

Results logged to session log:
- `ANALYTIC_PARITY_OK` — all match
- `ANALYTIC_PARITY_MISMATCH` — detailed list of divergences
- `ANALYTIC_PARITY_DRIFT` — within warning but approaching error

## model_vars entries

Each edge can have multiple model_vars entries from different sources. The `modelVarsResolution` preference hierarchy determines which is promoted:

| Source | Written by | When |
|--------|-----------|------|
| `analytic` | FE topo pass | Every fetch (blocking) |
| `analytic_be` | BE topo pass | Every fetch (background) |
| `bayesian` | Bayes MCMC service | On Bayes fit completion |
| `manual` | User override | Manual entry |

Currently `analytic` wins by default. The transition plan makes `analytic_be` the winner.

## Transition plan

| Phase | State | FE computes | BE computes | UI shows |
|-------|-------|-------------|-------------|----------|
| **1 (current)** | Parallel run | `analytic` (held) | `analytic_be` (race, 500ms/3s deadline) | BE if fast, else FE then BE merge |
| **2** | Validated parity | `analytic` (blocking) | `analytic_be` (fire-and-forget) | BE results (switched) |
| **3** | FE deprecated | Removed | `analytic` (promoted, blocking) | BE results |

**Why this order**:
- FE is faster (synchronous, no network) — safe default
- BE is more flexible (Python, easier to experiment with) — target state
- Running both allows zero-downtime validation before switching
- Mismatches surface as session log entries (visible in UI)

**Feature flag**: `FORECASTING_PARALLEL_RUN = true` in `forecastingParityService.ts`

## Heuristic dispersion SDs

When Bayes has not run, the analytic stats pass produces heuristic
uncertainty estimates so downstream consumers (fan chart, confidence
bands) have non-zero envelopes. Implemented in both FE and BE with
edge-level parity at 1e-9 (Vector 6 contract test).

**Edge-level** (`stats_engine.py:608-650`, FE equivalent in
`statisticalEnhancementService.ts`):

| Field | Derivation | Section |
|-------|-----------|---------|
| `p_sd` | Beta-binomial SD: `sqrt(p*(1-p)*(1+kappa)/(n+1))` | §3.1 |
| `mu_sd` | Normalised moment: `sigma / sqrt(2*n_converters)` | §3.2 |
| `sigma_sd` | Default-safe scale: `sigma / sqrt(2*n_converters)` | §3.3 |
| `onset_sd` | Onset constraint: `max(1.0, onset * 0.15)` | §3.4 |
| `onset_mu_corr` | Fixed correlation: `-0.5` (onset↔mu anti-correlation) | §3.5 |

**Path-level** (`stats_engine.py:1038-1044`): quadrature sum
propagation — `path_mu_sd = sqrt(mu_sd^2 + upstream_mu_sd^2)`,
same for `sigma_sd` and `onset_sd`.

**FE consumption**: `confidence_bands.py:70,103` builds a 4x4
covariance matrix from these 5 fields for MC band generation.

Design: `project-bayes/archive/heuristic-dispersion-design.md`.

## Promoted fields (production/consumption separation)

Model output writes to `promoted_*` fields to avoid overwriting
user-configured values:

| User field | Model output field | Fallback |
|------------|-------------------|----------|
| `latency.t95` | `latency.promoted_t95` | `promoted_t95 ?? t95` |
| `latency.onset_delta_days` | `latency.promoted_onset_delta_days` | `promoted_onset ?? onset` |

Defined in `graph_types.py:72-74`. FE consumers use fallback chains
(e.g. `localAnalysisComputeService.ts:417,576,623`).

## CLI topo pass

The CLI now uses the same Stage 2 orchestration as the browser via
`fetchDataService.fetchItems({ mode: 'from-file' })`. The important
difference is **timing**, not a separate topo implementation:

- **Browser**: renders as soon as the synchronous FE topo pass lands,
  then lets BE topo / CF overwrite later if they resolve after the
  render deadline
- **CLI**: sets `awaitBackgroundPromises=true` on
  `runStage2EnhancementsAndInboundN`, so FE topo, BE topo, and CF
  background handlers all settle before the command returns

This gives deterministic headless output without creating a parallel
CLI-only topo pass.

For `analyse --type conditioned_forecast`, the CLI still dispatches
directly to `/api/forecast/conditioned` after the shared analysis
preparation step. The request payload is built by
`src/lib/conditionedForecastGraphSnapshot.ts`, which engorges the
scenario graph using the disk-loaded parameter YAML map. That helper
must stay runtime-neutral; the CLI should not import the browser
`conditionedForecastService.ts` module just to build the payload.

The legacy `--topo-pass` flag is retained only as a deprecated no-op
for backwards compatibility with older scripts.

## Key files

| File | Role |
|------|------|
| `src/services/fetchDataService.ts` (Stage 2) | Orchestrates both passes |
| `src/services/statisticalEnhancementService.ts` | FE topo pass (`enhanceGraphLatencies`) |
| `src/services/beTopoPassService.ts` | BE topo pass client (`runBeTopoPass`) |
| `src/services/forecastingParityService.ts` | Parity comparison (`compareModelVarsSources`) |
| `src/services/modelVarsResolution.ts` | Preference hierarchy for model_vars |
| `lib/runner/stats_engine.py` | BE topo pass implementation (Python port of FE) |
| `lib/api_handlers.py` | `/api/lag/topo-pass` endpoint handler |
| `lib/runner/forecast_state.py` | Forecast engine: `_evaluate_cohort` (shared primitive), `compute_forecast_trajectory`, `build_node_arrival_cache`, `compute_forecast_summary` (CF / surprise-gauge surfaces, not BE topo) |
| `lib/runner/model_resolver.py` | Promoted model resolver: `resolve_model_params(edge, scope, temporal_mode)` — also derives alpha/beta from evidence n/k when no Bayesian posterior (D20) |
| `src/cli/topoPass.ts` | CLI topo pass: builds cohort_data + scoped edge_contexts from DSL (D18), calls BE endpoint |
| `src/cli/commands/analyse.ts` | CLI `--topo-pass` flag |

## Bounded analytic topo surface

The BE topo pass now stops at `stats_engine.py` output. It does **not**
call `compute_forecast_trajectory`, does not build a secondary
conditioned scalar surface, and does not compete with CF for ownership
of `p.mean` or `latency.completeness_stdev`.

What still flows through `/api/lag/topo-pass`:

1. Query-scoped analytic cohort inputs (`cohort_data`,
   `edge_contexts.scoped_cohorts`, window-derived onset / baseline
   helpers)
2. Fenton-Wilkinson latency composition and the analytic fallback
   scalars from `stats_engine.py` (`completeness`, `p_infinity`,
   `blended_mean`, heuristic `p_sd`)
3. Upsert of `analytic_be` model vars and re-promotion of latency
   fields on arrival

What does **not** flow through `/api/lag/topo-pass`:

- `compute_forecast_trajectory`
- conditioned completeness uncertainty
- topo-sequenced upstream-carrier propagation
- any second write path that tries to shadow CF semantics

This keeps the BE topo pass as the analytic fallback / model-var
generator, while the 500ms fast/slow-path race remains solely a CF
concern.

`cohort_maturity` analysis type now routes to v3 (engine consumer,
185 lines). v1 and v2 are gated to dev only (`devOnly: true`).
