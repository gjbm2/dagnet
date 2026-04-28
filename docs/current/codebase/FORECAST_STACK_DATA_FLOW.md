# Forecast stack — data flow and interface contracts (post-73b)

**Date**: 27-Apr-26 (promoted into codebase 28-Apr-26)
**Status**: Canonical reference for the post-73b forecast / CF / analyse
architecture. Maintained in lockstep with the layered contract; if the
contract changes, this doc must be revised in the same PR.
**Audience**: engineers reviewing pull requests against any of the
post-73b interfaces, or implementing a new consumer that touches the
layered contract or one of the labelled interfaces (I1–I17).
**Provenance**: promoted from `docs/current/project-bayes/73b-appendix-b-data-flow-and-interfaces.md`
per [73b plan §11.1](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md) closing
item, on completion of 73b Stage 6 (28-Apr-26). The original
project-bayes path now redirects here.

**Cross-references**:
- [73b plan body](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md) —
  the layered contract this doc diagrams (sections 3.1–3.9, 6.x, 12, etc.).
  When the body of this doc says "§3.3.4" or "§6.5" without a doc prefix,
  the reference is to 73b.
- [73a-scenario-param-pack-and-cf-supersession-plan.md](../project-bayes/73a-scenario-param-pack-and-cf-supersession-plan.md) §8 (pack contract) and §10 (CF apply mapping).
- [SCHEMA_AND_TYPE_PARITY.md](SCHEMA_AND_TYPE_PARITY.md) —
  schema surfaces touched by 73b's persistent-field changes.
- [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) §3.3 — the
  CF-response vs Bayes-posterior naming-convention residual asymmetry
  that the apply mapping translates at the CF response boundary.

**Status note on diagrams**: rendered in monospace ASCII so they read
identically in any text view. Updated in lockstep with the layered
contract; if the contract changes, these diagrams must be revised in
the same PR.

---

## B.1 Source-material provenance

Two source families, two production pipelines. Both produce aggregate,
generator-owned material; user authoring never writes into either
pipeline. Each `[Iₙ]` tag marks an interface traversal (process
boundary or in-FE format change). Contract shape, transport, and
ownership for each are listed in the **Interface contracts** legend
at the end of this section.

```
                    BAYESIAN PIPELINE (offline; file-backed)
                    ════════════════════════════════════════

   FE app (user)
      │
      │  [I1]  FE ──► BE   commission a Bayes run
      ▼
   ┌───────────────────────────────┐
   │ BE compiler + worker          │  pyMC / nutpie
   │  builds evidence, emits IR,   │ ──MCMC──► InferenceData
   │  invokes sampler              │            (BE in-process)
   │  (Modal or local)             │
   └───────────────┬───────────────┘
                   │
                   │  [I2]  BE ──► FE   posterior result delivered
                   ▼
   ┌───────────────────────────────┐
   │ bayesPatchService             │   (FE side)
   │  receives the result          │
   └───────────────┬───────────────┘
                   │
                   │  [I3]  FE ──► file   upsert into parameter file
                   ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ Parameter file  (per-edge, file-backed, persistent)           │
   │   posterior.slices[]      — multi-context slice library       │
   │   posterior.fit_history   — per-asat fit-history entries      │
   │   evidence                — embedded file evidence            │
   │                                                                │
   │   This is the single source of truth for bayesian material.   │
   │   The graph never persistently holds the whole slice library. │
   └───────────────┬───────────────────────────────────────────────┘
                   │
                   │  Two readers (both via the shared slice helper):
                   │
                   ├──► [I4]  file ──► graph   in-schema slice projection
                   │       on currentDSL change [Stage 4(e)] OR per-scenario
                   │       request build [Stage 4(a)]
                   │
                   └──► [I5]  file ──► request graph   out-of-schema engorgement
                          per BE call only (transient request-graph copy);
                          attaches material BE consumers need that does not
                          fit the normal graph schema


                    ANALYTIC PIPELINE (online; graph-only)
                    ══════════════════════════════════════

   FE app
      │
      │  [I6]  FE ──► data layer   data fetch request
      ▼
   ┌───────────────────────────────┐
   │ Window / cohort data sources  │
   │  (versioned cache + live API) │
   └───────────────┬───────────────┘
                   │
                   │  [I7]  data layer ──► FE   raw observation rows
                   ▼
   ┌───────────────────────────────┐
   │ windowAggregationService      │
   │  recency-weighted aggregation │
   └───────────────┬───────────────┘
                   │ (in-FE; no boundary)
                   ▼
   ┌───────────────────────────────┐
   │ FE topo Step 1                │  writes aggregate Beta shape,
   │  (statisticalEnhancement-     │  latency, source mass, provenance
   │   Service)                    │  per §3.9
   └───────────────┬───────────────┘
                   │
                   │  [I8]  in-FE write   to model_vars[analytic] entry
                   ▼
       Live edge model_vars[analytic]
       Per-scenario request graph model_vars[analytic]
                   (graph-only; never persisted to a parameter file;
                    re-derived from current graph state on every refresh)

   Same fetch ALSO writes the scoped evidence layer (not a model var):
     [I7] rows ── per-scenario aggregator ──► p.evidence.{n, k, mean}
   That is L4 in B.2 below; it is query-scoped, not aggregate.
```

The bayesian pipeline crosses three process boundaries (FE → BE submit;
BE → FE result; FE → file upsert), then a fourth in-FE format change
(file → graph). The analytic pipeline crosses one boundary (the data
fetch). The graph sees both sources arriving as ledger entries with
the same shape; promotion picks between them per the selector and
quality gate (§3.2).

### Interface contracts (B.1)

| ID | Direction | Transport | Payload contract (post-73b) |
|----|-----------|-----------|------------------------------|
| **I1** | FE → BE | HTTPS POST `/submit` (Modal or local), encrypted envelope | **BayesSubmitEnvelope** — compiled graph IR, evidence dict (DB-fetched and file-fetched rows), per-query context DSL, graph metadata, model version. Owner: Bayes pipeline schema. |
| **I2** | BE → FE | webhook callback OR pull from `/status` | **BayesResultPayload** — per-edge `posterior.slices[]` (each slice carries Beta shape `alpha`/`beta`, predictive `alpha_pred`/`beta_pred`, `n_effective`, `kappa`, latency `mu`/`sigma`/`t95`/`onset_*`, onset observations, provenance, HDI, `evidence_grade`); `posterior.fit_history[]` per `asat`; embedded `evidence`; diagnostics (R̂, ESS, LOO, PPC). Owner: Bayes result schema. |
| **I3** | FE → file (workspace IDB / file system) | `fileOperationsService` write | **Parameter-file format** (YAML/JSON, per-edge) — `posterior.slices[]`, `posterior.fit_history[]`, `evidence{}` (aggregate counts plus cohort daily-row series), file metadata (hash signatures, fit timestamp, model version). Owner: parameter-file schema. |
| **I4** | file → graph (in-FE) | `resolvePosteriorSlice(slices, effectiveDsl)` + `buildSliceKey` projection | **In-schema graph fields** (per-edge, single context) — `model_vars[bayesian]` entry with `probability` / `latency` / `onset` blocks; `p.posterior.*` (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`, ...); `p.latency.posterior.*` (`mu`, `sigma`, `t95`, `onset_*`, ...). **Conditional probabilities follow the same rule**: each entry under `conditional_p[X]` (using the §1.1 notation for "the entry whose condition string is X" — array form on the live graph, Record form in packs, per 73a §3 rule 7) has its own `p` block (posterior + latency posterior + forecast + evidence + locks) and is re-contexted on the same trigger as the unconditional `p`. Identity is by condition string in both storage forms; on the live graph form (array) access is by walking entries and matching `condition`. **Match-rule is uniform across both call sites**: both the live-edge re-context [Stage 4(e)] and the per-scenario request-graph build [Stage 4(a)] inherit today's `resolvePosteriorSlice` semantics unchanged — exact-match → bare-mode aggregate fallback → undefined (per 73b §3.2a Wiring and §3.8 register entry 4, which explicitly withdraws an earlier "exact-context only" framing). 73b does not relegislate slice-match semantics. Owner: graph schema. |
| **I5** | file → request graph (in-FE) | `bayesEngorge.ts` per BE call | **Out-of-schema transient fields** on the request-graph copy — `_bayes_evidence` (file evidence + cohort daily-row time series); `_bayes_priors` (priors, `kappa`, latency, onset observations); `_posteriorSlices.fit_history`. Discarded after the BE call. **Owner**: Stage 4(a) request-graph engorgement contract (this plan, §3.2a (ii)). **Producer**: [`bayesEngorge.ts`](../../graph-editor/src/lib/bayesEngorge.ts) (FE). **BE consumers**: BE CF / forecast_runtime (reads `_bayes_evidence` and `_bayes_priors` for IS-conditioning); [`epistemic_bands.py:148-149`](../../graph-editor/lib/runner/epistemic_bands.py#L148-L149) (reads `_posteriorSlices.fit_history`); [`api_handlers.py:2099`](../../graph-editor/lib/api_handlers.py#L2099) (reads `_bayes_evidence` rows to supplement DB-snapshot rows). New consumers join this list explicitly. |
| **I6** | FE → data layer | versioned cache OR HTTPS GET data API | **DataFetchRequest** — workspace, scenario DSL, anchor dates, fetchMode (`from-file` / `versioned`), no-snapshot-cache flag. Owner: data-layer API. |
| **I7** | data layer → FE | response payload | **Typed observation rows** — per-cohort or per-window (`k`, `n`, `dates`, cohort id, ...). Owner: data-layer API. |
| **I8** | in-FE write | direct property assignment via `UpdateManager` | **`model_vars[analytic]` entry** on the live edge or request graph — window-family + cohort-family Beta shape, latency, provenance per §3.9. Owner: graph schema. |

## B.2 Per-edge layered model

```
                          PER-EDGE LAYERED MODEL (post-73b)
                          ════════════════════════════════════

  LAYER                    FIELDS                                COMPUTED / WRITTEN BY
  ─────────────────        ─────────────────────────────────     ─────────────────────────────

  EXTERNAL                 parameter file slice library          offline Bayes pipeline
   (off the graph)         window/cohort fetched data            FE data fetch
                           DB snapshot                           BE direct query

  ─────────────────        ─────────────────────────────────     ─────────────────────────────

  L1  SOURCE LEDGER        model_vars[bayesian]            ◄──── slice helper, on currentDSL
       (aggregate,                                                change   [Stage 4(e)]
        generator-owned)
                           model_vars[analytic]            ◄──── FE topo Step 1, on data fetch

  L1.5  SELECTOR           model_source_preference         ◄──── user pin (props panel)
        (user authoring)   model_source_preference_overridden

  ─────────────────        ─────────────────────────────────     ─────────────────────────────

  L2  PROMOTED BASELINE    p.forecast.{mean,stdev,source}  ◄──── applyPromotion
       (selected source                                            ──the only computer──
        projected)         p.latency promoted block         ◄──── applyPromotion
                           (mu, sigma, t95, onset_*,
                            path_*, ...)

                           Selection rule (per OP3, Decision 5):
                             1. user pin (model_source_preference_overridden=true)
                                wins over the quality gate WHEN the pinned
                                source exists for this edge/scenario;
                             2. if the pinned source is absent, fall back to
                                the available source (normally analytic),
                                RETAINING the pin (UI may render "pinned but
                                currently inactive"); promotion never
                                auto-clears the pin;
                             3. if no pin: quality-gated default — bayesian
                                wins if its quality gate passes, otherwise
                                analytic.

                           Triggers that re-run applyPromotion:
                             • any change to L1 (bayesian or analytic) —
                               including a pinned source becoming
                               available/unavailable;
                             • any change to L1.5 (`model_source_preference`
                               value or `model_source_preference_overridden` flag);
                             • quality-gate input change (ESS / Rhat / LOO).

  ─────────────────        ─────────────────────────────────     ─────────────────────────────

  L3  POSTERIOR DISPLAY    p.posterior.*                   ◄──── slice helper, on currentDSL
       (single context)    p.latency.posterior.*           ◄──── change   [Stage 4(e)]

  L4  EVIDENCE             p.evidence.{n, k, mean}         ◄──── FE data fetch (scoped DSL)
       (scoped to query)                                   ◄──── BE CF: writes evidence_k/n
                                                                 (post-Stage-6: writes
                                                                  unconditionally)

  L5  CURRENT ANSWER       p.mean, p.stdev, p.stdev_pred,  ◄──── FE topo Step 2 (provisional)
       (scoped to query)   p.n                              ◄──── BE CF (authoritative —
                           completeness, completeness_sd          broader evidence base
                                                                  than FE: CF incorporates
                                                                  DB snapshot rows and file
                                                                  evidence; FE topo Step 2
                                                                  sees only the live data
                                                                  fetch)
                           + *_overridden lock flags       ◄──── user overtype
                            (only on p.mean and p.stdev;
                             not on p.stdev_pred — per §3.3.4)

       Dispersion split (§3.3.4):
        • p.stdev      — always epistemic. Both writers populate it.
        • p.stdev_pred — always predictive. FE topo Step 2 may write it
                          provisionally and CF may overwrite it
                          authoritatively, but only when the promoted
                          source is bayesian + kappa fitted; absent under
                          analytic source.
       Bare-name = epistemic, _pred = predictive (mirrors doc 61's
       latency convention). Reader fallback: p.stdev_pred if present,
       else p.stdev — same as ResolvedLatency.mu_sd_predictive.


  Per-condition mirror: each condition under conditional_p (notation per §1.1:
   array on live graph, Record in packs — both keyed by condition string per
   73a §3 rule 7) carries its own p block with the same shape (posterior,
   evidence, forecast, locks) — so the conditional p.posterior.*, p.mean, etc.,
   follow the same per-layer rules. On the live graph, access is by walking
   the array and matching condition; in packs, access is direct via the
   Record key.

  Per-scenario duplication: every scenario carries its own L3+L4+L5 (and its
   own contexted L1, when bayesian). Current is on the live edge with per-
   field *_overridden flags; non-Current scenarios are pack-backed with
   scenario-level live-vs-static state. See §3.3.1 for the storage model.


  CONSUMERS
  ─────────
   Display 'f'              reads L2  (p.forecast.mean)
   Display 'e'              reads L4  (p.evidence.mean)
   Display 'f+e'            reads L5  (p.mean)
   Carrier consumers        reads L1 + L1.5 + L2 via resolve_model_params
    (forecast_state,                  (single shared resolver — never reads L5)
     graph_builder,
     path_runner)


  WRITE-DIRECTION SUMMARY
  ────────────────────────
                                        L1 ─┐
                                        L1.5┼──► applyPromotion ──► L2
                                                 (computer)
                                        L1 ─┐
                                        L2 ─┼──► FE topo Step 2  ──► L5  (provisional)
                                        L4 ─┘

      BE CF inputs (read from per-scenario request graph + DB):
                                        L1 (contexted, on req graph)         ┐
                                        L3 (contexted, on req graph)         │
                                        L4 (per-scenario evidence)           ├──► BE CF
                                        DB snapshot (queried directly)       │
                                        engorged: _bayes_evidence,           │
                                                  _bayes_priors,             │
                                                  _posteriorSlices.fit_history┘

      BE CF writes (per scenario):
                                        BE CF ──► L5  (authoritative; current-answer scalars)
                                        BE CF ──► L4  (evidence_k/n; post-Stage-6 the
                                                       analytic_degraded skip-guard is
                                                       retired and the write fires
                                                       unconditionally)
                                        BE CF never writes L1, L1.5, L2, or L3.
```

## B.3 Per-scenario request graph (transient, per BE call)

Each `[Iₙ]` tag below marks an interface traversal. `[I4]`/`[I5]` are
the same interfaces defined in B.1 (now reused at request-build time);
`[I9]`–`[I12]` are introduced here. Contract shape, transport, and
ownership for the new interfaces are listed in the **Interface
contracts** legend at the end of this section.

```
                  PER-SCENARIO REQUEST GRAPH (transient)
                  ════════════════════════════════════════

      Live edge (single context)
            │
            │  [I9]  in-FE   graph copy (live edge unchanged)
            ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Request graph (discarded after BE call)                     │
   │                                                              │
   │  ┌───────── CONTEXTING (in-schema, [I4]) ──────────────────┐ │
   │  │                                                         │ │
   │  │  parameter file ── slice helper ──► model_vars[bayesian]│ │
   │  │  (matching slice for                p.posterior.*       │ │
   │  │   scenario's effective DSL)         p.latency.posterior.*│ │
   │  │                                                         │ │
   │  └─────────────────────────────────────────────────────────┘ │
   │                                                              │
   │  ┌───────── ENGORGEMENT (out-of-schema, [I5]) ─────────────┐ │
   │  │                                                         │ │
   │  │  parameter file ── bayesEngorge ──► _bayes_evidence     │ │
   │  │                                       (file evidence +  │ │
   │  │                                        cohort daily-row │ │
   │  │                                        time series)     │ │
   │  │                                     _bayes_priors       │ │
   │  │                                       (priors, kappa,   │ │
   │  │                                        latency, onset)  │ │
   │  │                                     _posteriorSlices.   │ │
   │  │                                        fit_history      │ │
   │  │                                                         │ │
   │  └─────────────────────────────────────────────────────────┘ │
   │                                                              │
   └──────────────────────────────────┬───────────────────────────┘
                                      │
                                      │  [I10]  FE ──► BE   analyse / CF request
                                      ▼
                         ┌─────────────────────────┐    ┌──────────────┐
                         │      BE CF              │    │ DB snapshot  │
                         │  (forecast_runtime)     │ ◄──│ (queried     │
                         │                         │ [I11] directly,  │
                         │  reads request graph    │    │ BE-internal) │
                         │  + DB snapshot          │    └──────────────┘
                         └────────────┬────────────┘
                                      │
                                      │  [I12]  BE ──► FE   CF response
                                      ▼
                            scenario's L5 (current-answer scalars)
                            scenario's L4 (evidence_k/n) — post-Stage-6 the
                              analytic_degraded skip-guard is retired
                              and the write fires unconditionally

                            For Current the target is the live edge.
                            For non-Current scenarios the target is the
                            scenario's pack (or per-scenario enriched graph).
                            CF never writes L1, L1.5, L2, or L3.

  Other BE consumers of the [I5]-engorged fields:
   • epistemic_bands.py:148-149     reads _posteriorSlices.fit_history
   • api_handlers.py:2099           reads _bayes_evidence rows
                                       (supplements DB snapshot)
```

### Interface contracts (B.3)

| ID | Direction | Transport | Payload contract (post-73b) |
|----|-----------|-----------|------------------------------|
| **I9** | in-FE | structured-clone graph copy | **Request-graph copy** of the live graph, taken before contexting/engorgement. Live edge is unchanged. Owner: `analysisComputePreparationService` / `buildConditionedForecastGraphSnapshot`. |
| **I10** | FE → BE | HTTPS POST `/analyse` (or specific CF endpoint per analysis type) | **AnalyseRequest** (or CF-specific equivalent) — `{ scenarios: [{ scenario_id, graph (post-contexting + engorgement), query_dsl, analytics_dsl, visibility_mode, asat, … }], workspace, analysis_type, snapshot_regimes, display_settings?, request_id?, no_snapshot_cache? }`. Engorged fields ride inside each scenario's `graph`. **WP8 discipline**: ordinary 73b CF requests carry **no enabled** direct-`cohort()` rate-conditioning path. Any WP8-adjacent runtime-bundle field (`p_conditioning_direct_cohort`, dispatch flags equivalent) defaults to **false/off** and is not set by the standard 73b request builders. Tests that enable WP8 are explicitly labelled WP8-only and are outside the Stage 0–6 acceptance gates (see 73b §7 "Stabilised fast-follow requirement"). Owner: BE analyse / CF endpoint contract. |
| **I11** | BE → DB (BE-internal, not a cross-process boundary from FE) | parameterised SQL via `query_snapshots_for_sweep_batch` etc. | **Snapshot query** — request: snapshot subjects, candidate regimes, `asat` date; response: typed snapshot rows. Owner: snapshot DB contract (see `30-snapshot-regime-selection-contract.md`). |
| **I12** | BE → FE | HTTP response | **`ConditionedForecastScenarioResult[]`** — per scenario `{ scenario_id, success, edges: [{ edge_uuid, p_mean, p_sd, p_sd_epistemic, completeness, completeness_sd, evidence_k, evidence_n, conditioning{ r, m_S, m_G, applied, skip_reason }, cf_mode, cf_reason, tau_max, n_rows, n_cohorts, conditioned }], skipped_edges? }`. **Per-scenario projection (post-73b, post-Stage 4(f) and Stage 6)** — the canonical CF response → graph apply mapping is doc 73a §10; this row mirrors it: `p_mean → p.mean` (L5); **`p_sd → p.stdev_pred`** (L5, predictive — Stage 4(f) split, was `p_sd → p.stdev`); **`p_sd_epistemic → p.stdev`** (L5, epistemic — Stage 4(f) makes this newly persisted, was response-only); `completeness → p.latency.completeness` (L5); `completeness_sd → p.latency.completeness_stdev` (L5); `evidence_k → p.evidence.k` (L4) and `evidence_n → p.evidence.n` (L4). The `analytic_degraded` skip-guard on those L4 writes is **retired** post Stage 6 — `cf_mode` is now always `'sweep'`, `cf_reason` is always `null`, and the writes fire unconditionally. **Response-only, NOT persisted on the graph**: `conditioning{...}`, `cf_mode`, `cf_reason`, `tau_max`, `n_rows`, `n_cohorts`, `conditioned`, `skipped_edges`. CF never writes L1, L1.5, L2, or L3 (post-73b: Stage 4(c) removes the legacy `p_mean → p.forecast.mean` write at `conditionedForecastService.ts`). Target per scenario: live edge for Current; scenario pack / enriched graph state for non-Current. **Naming-convention boundary**: the response uses doc 49 convention (`p_sd` = predictive, `p_sd_epistemic` = epistemic); the graph uses doc 61 convention (bare = epistemic, `_pred` = predictive). The apply mapping translates by name at this boundary (§3.3.4). Owner: CF endpoint response schema (`ConditionedForecastEdgeResult` in [conditionedForecastService.ts](../../graph-editor/src/services/conditionedForecastService.ts), produced by `api_handlers.handle_conditioned_forecast`); apply mapping owned by 73a §10 (Stage 4(f) co-edits). |

## B.4 BE analyse dispatch — full surface

CF (B.3) is one specific BE analyse path. The full analyse surface
shares a single FE preparation pipeline and a single per-scenario
contexting + engorgement contract; it diverges at dispatch by analysis
type, hitting different BE endpoints / handlers with different
response shapes and persistence rules. This section maps the rest so
the reader has the full picture and all fields are accounted for.

**Single load-bearing property**: of all analyse paths, **only CF
persists state to the graph**. Every other analyse type returns a
render-only result that drives charts/panels and is otherwise
discarded. There is no `applyToGraph` for runner-style or
snapshot-style analyses (verified by grep: only
`applyConditionedForecastToGraph` exists, in
`conditionedForecastService.ts`).

```
                    BE ANALYSE DISPATCH (general case)
                    ════════════════════════════════════

   FE app  (chart, panel, hover, CLI analyse)
      │
      │  shared preparation [I13]:
      │   prepareAnalysisComputeInputs → PreparedAnalysisComputeReady
      │   per-scenario contexting + engorgement (B.1 [I4]/[I5])
      │   snapshot subject resolution (when needed)
      │   candidate regimes per edge
      │   MECE dimensional reduction
      │   visibility-mode projection
      ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ runPreparedAnalysis  (analysisComputePreparationService.ts) │
   │ dispatches by analysisType:                                 │
   └────┬─────────────┬──────────────────────┬──────────────────┘
        │             │                      │
        ▼             ▼                      ▼
   LOCAL-COMPUTE   CF (B.3)              BE-RUNNER-ANALYZE
   (FE-only —      [I10] / [I12]         [I14]
    no BE call)    /api/forecast/        /api/runner/analyze
                   conditioned           (single multiplexed
   node_info,                             endpoint; routes
   edge_info,                             internally by
   ...                                    analysis_type)
   (hasLocalCompute(type))
                                          │
                                          │ internal dispatch (BE-side)
                                          ▼
                                ┌─── runner registry ────┐
                                │ (analysis_types.yaml)  │
                                │  graph_overview        │
                                │  from_node_outcomes    │
                                │  to_node_reach         │
                                │  path_through          │
                                │  path_between          │
                                │  conversion_funnel     │
                                │  constrained_path      │
                                │  branches_from_start   │
                                │  branch_comparison     │
                                │  outcome_comparison    │
                                │  multi_*_comparison    │
                                │  general_selection     │
                                │  ...                   │
                                │  (graph-only;          │
                                │   no DB snapshot)      │
                                └────────────────────────┘
                                ┌─── snapshot router ────┐
                                │  cohort_maturity →     │
                                │   _handle_cohort_      │
                                │   maturity_v3 [I15]    │
                                │  cohort_maturity_v2 →  │
                                │   _handle_cohort_      │
                                │   maturity_v2          │
                                │  cohort_maturity_v1 →  │
                                │   _handle_snapshot_    │
                                │   analyze_subjects     │
                                │  lag_histogram /       │
                                │  lag_fit /             │
                                │  daily_conversions /   │
                                │  conversion_rate /     │
                                │  branch_comparison     │
                                │  (snapshot-DB) /       │
                                │  surprise_gauge →      │
                                │   _handle_snapshot_    │
                                │   analyze_subjects     │
                                │   [I16]                │
                                │  (DB snapshot          │
                                │   required)            │
                                └────────────────────────┘
                                (gating: ANALYSIS_TYPE_SCOPE_RULES
                                 in analysis_subject_resolution.py
                                 decides whether the type needs a
                                 snapshot)

        │             │                      │
        ▼             ▼                      ▼
   render-only    persists to graph      render-only
   (FE result)    via [I12] apply        (response → chart / panel)
                  mapping
```

### Persistence summary across analyse paths

| Path | Persists to graph? | What gets persisted |
|---|---|---|
| Local-compute (`node_info`, `edge_info`, ...) | No | n/a — render-only result. |
| CF (`/api/forecast/conditioned`) | **Yes** | Per [I12] mapping — L4 (`evidence_k/n`) and L5 (`p.mean`, `p.stdev`, `p.stdev_pred`, completeness fields). |
| Runner-analyze (graph-only types) | No | n/a — render-only AnalysisResponse. |
| Snapshot-analyze (snapshot-DB types) | No | n/a — render-only result; per-subject series of histograms / counts / rows. |
| `cohort_maturity_v3` | No | n/a — render-only per-tau row series. **Reads** CF-applied edge state from a prior CF dispatch when present, but does not write back. |
| `surprise_gauge` | No | n/a — back-end projection of `compute_forecast_summary` per doc 55; reads CF state, does not write. |
| Funnel runner (per doc 52) | No (direct) | The funnel runner makes its own whole-graph CF call internally; that CF call's [I12] response is applied to the graph by the standard CF apply path. The funnel response itself is render-only. |

So the entire post-73b graph-write surface for analyse is exactly the
[I12] mapping. Every other analyse path's contract is "render and
discard". This is what makes the L1 / L1.5 / L2 / L3 / L4 / L5 layered
contract enforceable: **among analyse paths**, only CF writes L4/L5;
no analyse path writes L1/L1.5/L2/L3. (Outside analyse, FE topo Step 2
also writes L5 provisionally and the FE data fetch writes L4
`p.evidence.*` — see B.2 write-direction summary; `applyPromotion`
remains the only L2 writer per §3.2.) All other analyse paths are
read-only consumers.

### Interface contracts (B.4)

| ID | Direction | Transport | Payload contract (post-73b) |
|----|-----------|-----------|------------------------------|
| **I13** | in-FE | function call | **`PreparedAnalysisComputeReady`** (from `analysisComputePreparationService.ts`) — shared base for all BE analyse dispatches. Shape: `{ analysisType, analyticsDsl, status, signature, scenarios: [{ scenario_id, name, colour, visibility_mode, graph (post-contexting + engorgement per B.1 [I4]/[I5]), effective_query_dsl, candidate_regimes_by_edge, snapshot_subjects?, analytics_dsl }], displaySettings?, meceDimensions? }`. Owner: `analysisComputePreparationService` (FE). |
| **I14** | FE → BE → FE | HTTPS POST `/api/runner/analyze` | **AnalysisRequest** — `{ scenarios: [I13.scenarios], analytics_dsl, analysis_type, no_cache?, query_dsl? (deprecated) }`. **Internal dispatch** (BE-side): `analysis_subject_resolution.ANALYSIS_TYPE_SCOPE_RULES` decides whether the type needs a snapshot; if no, falls through to the standard runner registry (analysis_types.yaml). **Response — `AnalysisResponse`**: shape varies per runner (`graph_overview` returns outcome aggregates; `from_node_outcomes` returns per-outcome probabilities; `path_between` returns reach + cost; `conversion_funnel` returns per-stage rows; etc.). The TS-side type union is `AnalysisResponse` in `runAnalysisService.ts` / `graphComputeClient.ts`. **Persistence**: none — render-only. Owner: BE runner registry (`graph-editor/lib/runner/`) + `handle_runner_analyze` in `api_handlers.py`. |
| **I15** | FE → BE → FE | same `/api/runner/analyze` (internal dispatch when `analysis_type ∈ {cohort_maturity, cohort_maturity_v2, cohort_maturity_v1, cohort_maturity_v3}`) | **`cohort_maturity_v3` request** — same I14 envelope; analysis_type triggers `_handle_cohort_maturity_v3` (api_handlers.py:1510). Reads contexted+engorged request graph (B.1 [I4]/[I5]) AND DB snapshot (BE-internal [I11] — snapshot subjects come from each scenario's `snapshot_subjects` list). **Response**: per-scenario per-tau row series — `{ rows: [{ tau, midpoint, model_midpoint, completeness, completeness_sd, ... }], display_meta?, ... }`. Cohort-maturity v3 also reads the CF-applied edge state on the graph when CF has previously run for the same scenario; it does not invoke CF itself. **Persistence**: none — render-only. Owner: `_handle_cohort_maturity_v3`. |
| **I16** | FE → BE → FE | same `/api/runner/analyze` (internal dispatch when `analysis_type` is snapshot-aware and not a `cohort_maturity_v*` variant) | **Snapshot-analyse request** — same I14 envelope; analysis_type ∈ `{lag_histogram, lag_fit, daily_conversions, conversion_rate, branch_comparison, surprise_gauge, ...}` triggers `_handle_snapshot_analyze_subjects`. Per-subject DB queries via [I11]. **Response**: per-subject series — histograms / per-day counts / fitted lag distributions / rate bands. `surprise_gauge` is a back-end projection of `compute_forecast_summary` reading CF state (doc 55); does not invoke CF. **Persistence**: none — render-only. Owner: `_handle_snapshot_analyze_subjects` + the per-type sub-handlers in api_handlers.py. |
| **I17** | BE-internal | reuses [I10] inside its handler | **Funnel runner** (doc 52) — invoked through `/api/runner/analyze` as `conversion_funnel`, but internally fires a **whole-graph CF call** ([I10] / [I11] / [I12]) and applies the result to the graph via the standard CF apply path before extracting the subgraph for the funnel rendering. The funnel response itself is render-only; persistence happens through the embedded CF call's [I12] mapping. Owner: funnel runner (`graph-editor/lib/runner/funnel_engine.py`). |
