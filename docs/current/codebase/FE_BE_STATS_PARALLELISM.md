# Stage 2 Fetch-Pipeline Orchestration (FE Topo + BE CF)

How the live graph-enrichment pipeline coordinates its two statistical writers — the synchronous **FE topo pass** and the race-based **BE conditioned-forecast (CF) pass** — during Stage 2 of every fetch.

Previously this note also covered a "quick BE topo pass" that ran in parallel and wrote an `analytic_be` source. That branch was removed on `24-Apr-26` per [project-bayes/73b](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md); CF is now the sole BE writer on the Stage 2 path.

**See also**: [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) (canonical four-subsystem map and "which Python entry point do I call" table), [LAG_ANALYSIS_SUBSYSTEM.md](LAG_ANALYSIS_SUBSYSTEM.md) (what FE topo actually computes — t95, mu/sigma, lag fit detail), [STATISTICAL_DOMAIN_SUMMARY.md](STATISTICAL_DOMAIN_SUMMARY.md) (broader statistical architecture), [PROBABILITY_BLENDING.md](PROBABILITY_BLENDING.md) (how computed values feed into blended probabilities).

## What the Stage 2 passes compute

Per edge, given raw cohort evidence, Stage 2 produces:
- **t95**: 95th percentile lag (days) — when 95% of conversions have occurred
- **mu, sigma**: log-normal distribution parameters for lag CDF fitting
- **path_t95, path_mu, path_sigma**: cumulative path-level equivalents (Fenton-Wilkinson composition)
- **completeness**: fraction of conversions completed by the query date
- **blended_mean**: forecast-weighted conversion rate = `w_evidence * evidence.mean + (1 - w_evidence) * forecast.mean`
- **p_infinity (forecast)**: mature window baseline conversion rate

### Dual-evidence treatment: what's query-scoped and what isn't

The FE topo pass deliberately splits the cohort evidence it consumes into two sets. The split is load-bearing — mixing them produces survivor bias on one side and stale evidence on the other.

| Derivation | Evidence used | Why |
|---|---|---|
| Lag fit (`mu`, `sigma`, `t95`) | **Full unscoped cohorts** — all history | The lag shape is a property of the edge, not of the user's current query. Scoping would bias the fit toward newer cohorts that haven't finished maturing ("survivor bias") |
| `p_infinity` (asymptote from mature cohorts) | **Full unscoped cohorts**, filtered to `age ≥ t95` with recency weighting | Needs fully-matured cohorts to estimate the true endpoint rate. Query-window cohorts are typically not yet mature |
| `evidence.{n, k, mean}` | **Query-scoped cohorts** (the DSL window) | This is the user's "what actually happened in the window I'm looking at". Must match the DSL |
| `completeness`, `completeness_stdev` | **Query-scoped cohorts** | "How mature is the evidence we just aggregated" — must match the evidence set |
| `alpha`, `beta` on `model_vars[analytic]` | Derived from **query-scoped** `total_k, total_n` (Jeffreys-style: `α = k+1, β = n-k+1`) | A query-scoped Jeffreys posterior, not an aggregate prior |

**Implication for downstream consumers**: the `α, β` on `analytic` is **already a query-scoped posterior**. It is not a prior that should be updated with query-scoped evidence again — doing so double-counts. This is the key difference from `model_vars[bayesian].probability.{alpha, beta}`, which is aggregate (not query-scoped) and is a legitimate prior for conjugate updates or as an IS proposal.

See [STATS_SUBSYSTEMS.md §5 Confusion 7](STATS_SUBSYSTEMS.md) for the full scoping table.

## The two live passes

### FE topo pass (blocking, synchronous)

- **Service**: `statisticalEnhancementService.ts` → `enhanceGraphLatencies()`
- **Triggered by**: `fetchDataService.ts` Stage 2, after per-item fetches complete
- **Writes to**: `analytic` model_vars entry on each edge, plus promoted flat fields (`p.latency.*`, `blendedMean`)
- **Blocks UI**: yes — runs synchronously in the fetch pipeline
- **Source of truth** (until CF lands): authoritative

### Conditioned forecast pass (CF, race-based)

- **Service**: `conditionedForecastService.ts` → `runConditionedForecast()`
- **Endpoint**: `POST /api/forecast/conditioned` → `handle_conditioned_forecast` (doc 45)
- **Triggered by**: `fetchDataService.ts` Stage 2, fired alongside the FE topo pass
- **Writes to**: per-edge `p.mean`, `p.sd`, `latency.completeness`, `latency.completeness_stdev` (CF owns these scalars per doc 45)
- **Blocks UI**: partially — raced against a **500ms** deadline (`CF_FAST_DEADLINE_MS`). Fast path merges CF scalars into the same FE apply (single render); slow path renders FE fallback and overwrites on arrival.
- **Source of truth**: CF `p.mean` / completeness supersede FE's blended equivalents when CF returns non-empty results.

## Orchestration in the fetch pipeline

Two passes run per fetch, coordinated in `fetchDataService.ts` Stage 2. The sibling rebalancing path (`UpdateManager.applyBatchLAGValues`) runs exactly once with whichever scalars are available at render time, regardless of which pass produced them.

**Flow**:

1. FE topo pass runs synchronously (`enhanceGraphLatencies`), producing `EdgeLAGValues[]`. Results are **held, not applied yet**.
2. Conditioned forecast (`runConditionedForecast`) fires and returns a promise. `Promise.race` waits up to **500ms** for it.

### CF fast path vs slow path

The naming **fast path** / **slow path** refers to whether CF returns within the 500ms deadline. It is one call — the path just reflects how quickly it responds.

| CF outcome | Renders | What happens |
|----------|---------|--------------|
| CF responds < 500ms with usable `p_mean` | 1 | CF scalars (p_mean, p_sd, completeness, completeness_sd) merged into FE `EdgeLAGValues`; `applyBatchLAGValues` runs once with the merged values — no FE-fallback flash. |
| CF responds < 500ms with empty/failed | 1 | FE fallback applied. Warning logged. |
| CF exceeds 500ms | 2 | FE fallback applied immediately; a `.then()` handler overwrites `p.mean` (and completeness) on CF's eventual arrival, triggering a second render. |
| CF fails after 500ms | 1 | FE fallback stays. Error logged. |

Stale CF responses (from a previous fetch cycle, identified by `_conditionedForecastGeneration`) are discarded.

**Merge semantics for CF fast path**: `mergeCfIntoFe` overwrites `blendedMean`, `forecast.mean`, `latency.completeness`, `latency.completeness_stdev` on each `EdgeLAGValues` entry where CF returned a finite `p_mean`. FE's latency fit fields (mu, sigma, t95, path_t95, median_lag_days, etc.) are preserved — those are FE topo's responsibility. Evidence (n, k, evidence.mean) also stays from FE — authoritative from actual data.

**CLI determinism**: CLI callers set `awaitBackgroundPromises=true` on `runStage2EnhancementsAndInboundN`, which awaits the CF slow-path overwrite handler before returning. Browser callers don't set this — they render fast and let handlers catch up.

### Session log entries

Payload shape: CF pass-completion entries include a per-edge sample `{ uuid, p_mean, p_sd, completeness, completeness_sd }` so forensic runs can reconstruct the values each pass applied.

`CONDITIONED_FORECAST`:
- `info` — Conditioned forecast started (gen G, DSL)
- `info` — Conditioned forecast applied in Nms (fast path, single render), with per-edge payload
- `info` — Conditioned forecast pending after 500ms — FE fallback applied
- `info` — Conditioned forecast subsequent overwrite applied in Nms, with per-edge payload (slow path)
- `warning` — Conditioned forecast returned empty/no usable p.mean after Nms
- `warning` — Conditioned forecast result discarded (stale gen)
- `error` — Conditioned forecast failed / apply failed

FE topo emits its own pipeline start/end/error entries via `fetchDataService.ts`'s Stage-2 session-log hooks.

## model_vars entries

Each edge can have multiple model_vars entries from different sources. The `modelVarsResolution` preference hierarchy determines which is promoted:

| Source | Written by | When |
|--------|-----------|------|
| `analytic` | FE topo pass | Every fetch (blocking) |
| `bayesian` | Bayes MCMC service | On Bayes fit completion |
| `manual` | User override | Manual entry |

Promotion order for `best_available`: gated `bayesian`, else `analytic`. `manual` always wins when present for an edge.

## Heuristic dispersion SDs

When Bayes has not run, the FE analytic stats pass produces heuristic uncertainty estimates so downstream consumers (fan chart, confidence bands) have non-zero envelopes. Implemented in `statisticalEnhancementService.ts` and consumed on the BE via `confidence_bands.py`.

**Edge-level** (mirrors the formulas that used to live in `stats_engine.py`):

| Field | Derivation | Section |
|-------|-----------|---------|
| `p_sd` | Beta-binomial SD: `sqrt(p*(1-p)*(1+kappa)/(n+1))` | §3.1 |
| `mu_sd` | Normalised moment: `sigma / sqrt(2*n_converters)` | §3.2 |
| `sigma_sd` | Default-safe scale: `sigma / sqrt(2*n_converters)` | §3.3 |
| `onset_sd` | Onset constraint: `max(1.0, onset * 0.15)` | §3.4 |
| `onset_mu_corr` | Fixed correlation: `-0.5` (onset↔mu anti-correlation) | §3.5 |

**Path-level**: quadrature sum propagation — `path_mu_sd = sqrt(mu_sd^2 + upstream_mu_sd^2)`, same for `sigma_sd` and `onset_sd`.

**BE consumption**: `confidence_bands.py:70,103` builds a 4x4 covariance matrix from these 5 fields for MC band generation.

Design: `project-bayes/archive/heuristic-dispersion-design.md`.

## Promoted fields (production/consumption separation)

Model output writes to `promoted_*` fields to avoid overwriting user-configured values:

| User field | Model output field | Fallback |
|------------|-------------------|----------|
| `latency.t95` | `latency.promoted_t95` | `promoted_t95 ?? t95` |
| `latency.onset_delta_days` | `latency.promoted_onset_delta_days` | `promoted_onset ?? onset` |

Defined in `graph_types.py:72-74`. FE consumers use fallback chains (e.g. `localAnalysisComputeService.ts:417,576,623`).

## CLI

The CLI uses the same Stage 2 orchestration as the browser via `fetchDataService.fetchItems({ mode: 'from-file' })`. The important difference is **timing**, not a separate implementation:

- **Browser**: renders as soon as the synchronous FE topo pass lands, then lets CF overwrite later if it resolves after the render deadline
- **CLI**: sets `awaitBackgroundPromises=true` on `runStage2EnhancementsAndInboundN`, so FE topo and the CF background handler both settle before the command returns

This gives deterministic headless output without creating a parallel CLI-only topo implementation.

For `analyse --type conditioned_forecast`, the CLI still dispatches directly to `/api/forecast/conditioned` after the shared analysis preparation step. The request payload is built by `src/lib/conditionedForecastGraphSnapshot.ts`, which engorges the scenario graph using the disk-loaded parameter YAML map. That helper must stay runtime-neutral; the CLI should not import the browser `conditionedForecastService.ts` module just to build the payload.

## Key files

| File | Role |
|------|------|
| `src/services/fetchDataService.ts` (Stage 2) | Orchestrates FE topo + CF race |
| `src/services/statisticalEnhancementService.ts` | FE topo pass (`enhanceGraphLatencies`) |
| `src/services/modelVarsResolution.ts` | Preference hierarchy for model_vars |
| `src/services/conditionedForecastService.ts` | CF client (`runConditionedForecast`, `applyConditionedForecastToGraph`) |
| `lib/api_handlers.py` | `/api/forecast/conditioned` handler |
| `lib/runner/forecast_state.py` | Forecast engine: `_evaluate_cohort` (shared primitive), `compute_forecast_trajectory`, `build_node_arrival_cache`, `compute_forecast_summary` (CF / surprise-gauge surfaces) |
| `lib/runner/model_resolver.py` | Promoted model resolver: `resolve_model_params(edge, scope, temporal_mode)` — also derives alpha/beta from evidence n/k when no Bayesian posterior (D20) |
| `src/cli/commands/analyse.ts` | CLI analyse command |

`cohort_maturity` analysis type now routes to v3 (engine consumer, 185 lines). v1 and v2 are gated to dev only (`devOnly: true`).
