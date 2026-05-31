# Glossary and Acronyms

Companion to [RESERVED_QUERY_TERMS_GLOSSARY.md](RESERVED_QUERY_TERMS_GLOSSARY.md), which is canonical for query-DSL semantics (`cohort`, `window`, `asat`, anchor, etc.). This doc covers everything else: acronyms, statistical terms, subsystem names, and short symbolic notation that recurs across the codebase docs.

When in doubt, this glossary points at the canonical doc; that doc is the source of truth.

---

## System / Architecture

- **AP** — Anti-Pattern (numbered, e.g. AP 11). See [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md).
- **BE** — Backend (Python, FastAPI, `lib/`, `bayes/`).
- **FE** — Frontend (TypeScript, `src/`).
- **CLI** — Headless Node entry point in `graph-editor/src/cli/`. See [GRAPH_OPS_TOOLING.md](GRAPH_OPS_TOOLING.md).
- **DSL** — Domain-Specific Language. See [RESERVED_QUERY_TERMS_GLOSSARY.md](RESERVED_QUERY_TERMS_GLOSSARY.md) and [DSL_SYNTAX_REFERENCE.md](DSL_SYNTAX_REFERENCE.md).
- **HRN** — Human-Readable Notation. The `e.<edge>.p.mean: 0.42` form for param packs.
- **DAG** — Directed Acyclic Graph. The conversion graph topology.
- **DAS** — Data Adapter Service. Pluggable transformation pipeline for external data sources. See [DATA_SOURCES_REFERENCE.md](DATA_SOURCES_REFERENCE.md).
- **HMR** — Hot Module Replacement. Vite's live-reload mechanism. See [DEV_ENVIRONMENT_AND_HMR.md](DEV_ENVIRONMENT_AND_HMR.md).
- **IDB** — IndexedDB. Browser-side persistence layer. See [INDEXEDDB_PERSISTENCE_LAYER.md](INDEXEDDB_PERSISTENCE_LAYER.md).
- **MECE** — Mutually Exclusive, Collectively Exhaustive. Property of a slice partition. See [CONTEXT_SYSTEM.md](CONTEXT_SYSTEM.md).
- **MSMDC** — Minimal Set of Maximally Discriminating Constraints. Auto-generates query strings for data retrieval. See [DATA_RETRIEVAL_QUERIES.md](DATA_RETRIEVAL_QUERIES.md) and [PYTHON_BACKEND_ARCHITECTURE.md](PYTHON_BACKEND_ARCHITECTURE.md).
- **RF** — ReactFlow. The canvas rendering library. See [REACTFLOW_CONTROLLED_MODE.md](REACTFLOW_CONTROLLED_MODE.md).
- **RJSF** — React JSON Schema Form. The form-rendering system. See [FORM_EDITOR_AND_MONACO.md](FORM_EDITOR_AND_MONACO.md).
- **TTL** — Time-To-Live. Cache-expiry duration.

---

## Statistical

- **α / β** — Beta distribution shape parameters. Posterior conversion rate `p ~ Beta(α, β)`.
- **μ / σ** — Log-normal latency parameters. `LogNormal(μ, σ)`.
- **δ / onset / `onset_delta_days`** — Dead-time shift before conversions can occur. Total lag `T = δ + LogNormal(μ, σ)`.
- **κ / kappa** — Concentration / dispersion parameter (Beta-Binomial overdispersion).
- **κ_lat / `kappa_lat`** — Per-edge latency dispersion. See `project-bayes/34-latency-dispersion-background.md`.
- **t95** — 95th percentile of total edge lag. One-way constraint preventing thin-tail optimism.
- **`path_t95`** — Path-level t95 (Fenton-Wilkinson convolution from anchor through upstream edges).
- **p_∞ / `p_inf` / `p_infinity`** — Mature-window asymptotic conversion rate.
- **CDF** — Cumulative Distribution Function. Used for completeness and maturity.
- **PMF / PDF** — Probability Mass / Density Function.
- **HDI** — Highest Density Interval. Bayesian credible interval.
- **BB** — Beta-Binomial likelihood (overdispersed Binomial).
- **DM** — Dirichlet-Multinomial likelihood (overdispersed Multinomial).
- **FW** — Fenton-Wilkinson moment-matching for sums of log-normals (path latency composition).
- **MC** — Monte Carlo. Used for forecast uncertainty bands.
- **MCMC** — Markov Chain Monte Carlo. Used by the Bayes compiler.
- **NUTS / HMC** — No-U-Turn Sampler / Hamiltonian Monte Carlo. NUTS is the default sampler.
- **IS** — Importance Sampling. CF's per-edge conditioning mechanism.
- **PSIS** — Pareto-Smoothed Importance Sampling.
- **LOO** — Leave-One-Out cross-validation.
- **ELPD** — Expected Log Pointwise Predictive Density (the LOO score).
- **ΔELPD** — Bayesian model's ELPD minus analytic null's. Per-edge model adequacy.
- **Pareto k** — PSIS reliability indicator. `<0.5` reliable, `>0.7` unreliable.
- **PPC** — Posterior Predictive Check. Coverage/calibration of model intervals.
- **PIT** — Probability Integral Transform. Used in PPC.
- **ESS** — Effective Sample Size. Convergence diagnostic for MCMC.
- **rhat / R̂** — Gelman-Rubin convergence diagnostic. `<1.01` good.
- **ELBO** — Evidence Lower Bound. SVI optimisation target.
- **EWMA** — Exponentially Weighted Moving Average. Recency-biased aggregator used for snapshot smoothing and per-window evidence weighting where applicable.
- **completeness** — Fraction of eventual converters observed by a given cohort age. `LogNormalCDF(age − onset, μ, σ)`.
- **τ_observed / `tau_observed`** — Maximum observed cohort age. Drives epoch boundaries in cohort maturity charts.

---

## Pipeline / Subsystems

- **LAG** — Latency-Adjusted Graph. The FE topo pass that enriches edge latency scalars during Stage 2 of every fetch. See [LAG_ANALYSIS_SUBSYSTEM.md](LAG_ANALYSIS_SUBSYSTEM.md).
- **FE topo pass** — In-browser analytic enrichment. Step 1 produces aggregate `model_vars`; Step 2 produces query-scoped current-answer surface. See [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) §3.2.
- **CF pass / Conditioned Forecast** — BE topologically-sequenced MC + IS pass that races the FE topo pass per fetch. See [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) §3.3 and [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md).
- **BE topo pass** — Removed `24-Apr-26` per `project-bayes/73b`. Older docs reference it; runtime no longer runs it.
- **Bayes compiler** — Offline MCMC inference (`bayes/`). Writes `model_vars[bayesian]` per edge. See [PYTHON_BACKEND_ARCHITECTURE.md](PYTHON_BACKEND_ARCHITECTURE.md) §Bayesian.
- **Stage 1 / 2 / 3** — Fetch pipeline stages. Stage 1 = fetch from sources. Stage 2 = enrichment (FE topo + CF race). Stage 3 = render. See [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md).
- **Snapshot DB** — Postgres time-series store for repeated cohort observations. See [SNAPSHOT_DB_ARCHITECTURE.md](SNAPSHOT_DB_ARCHITECTURE.md).
- **Analysis runner** — Per-query chart producer (path, funnel, `cohort_maturity`, etc.). See [ANALYSIS_TYPES_CATALOGUE.md](ANALYSIS_TYPES_CATALOGUE.md).
- **Forecast engine** — `lib/runner/forecast_runtime.py` is the live runtime-assembly layer for the forecast stack (graph helpers, span-prior construction, upstream carrier composition). `forecast_state.py` is no longer an engine: post-73q it is just a carrier resolver (`_resolve_edge_p`), a legacy-fallback warning, and the `CohortEvidence` container. Analysis runners go through `cf_analysis` / `cohort_forecast_v3`, not these modules directly. See [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md) §3.

---

## Cohort-maturity chart display modes and surfaces

Terminology is fixed by the frontier-conditioned chart-surface proposal,
[frontier-conditioned-chart-surface-proposal-21-May-26.md](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md)
Appendix B. **E, F, and E+F name display modes only; `ef_*` / `f_*` / overlay name internal surfaces.** The maintained surface-vs-mode contract:

### Display modes

- **E mode** — Chart display that renders only the strict evidence layer where evidence support exists. Reads `evidence_y` / `evidence_x` (Σy, Σx aggregated across cohorts contributing observation at τ).
- **F mode** — Chart display that renders the **conditioned model surface** (`f_*`) with epistemic bands. Reads `model_midpoint` / `model_fan_*` / `model_bands` row fields, sourced from `selected_projection.f_rate_draws` (the spine's unspliced query-conditioned model surface on the epistemic operator basis). Decoupled from per-cohort observed slices but conditioned on the query's evidence binding.
- **E+F mode** — Chart display that renders the **evidence layer** in epochs A/B plus the **forecast layer** in epochs B/C. Reads `rate` / `evidence_y` / `evidence_x` for the evidence layer and `midpoint` / `fan_*` / `fan_bands` for the forecast layer. Epoch B is the overlap region; in epoch C only the forecast layer remains visible (no evidence support).

### Internal surfaces

- **Strict evidence surface** — Strict empirical row fields (`rate`, `evidence_x`, `evidence_y`). Supplies E mode and the evidence layer in E+F mode.
- **Evidence layer** — The visual layer in E+F mode that renders the strict evidence surface. Visible only where observed or partially observed evidence support exists (epochs A/B); absent in epoch C.
- **Forecast layer** — The second visual layer in E+F mode (curve + bands rendered in epochs B/C). Reads the FC surface (`ef_*`) post-Atom-6. The output layer suppresses the forecast layer in epoch A only; the spine still emits `ef_*` across the full tau sweep so prefix-pinning and continuity are testable internally.
- **Conditioned model surface** (`f_*`) — Full-root query-conditioned model surface generated from conditioned primitives on the epistemic operator basis. F mode renders this surface. Carried by row fields `model_midpoint` / `model_fan_*` / `model_bands`.
- **FC surface** (`ef_*`) — Internal frontier-conditioned surface generated by `model_span_spine.project_selected_cohort_rows`. Prefix-pinned to strict evidence through each Cohort's frontier; continues unresolved mass after the frontier on the predictive operator basis. Generated for the full tau sweep regardless of display gating. Carried by row fields `midpoint` / `fan_*` / `fan_bands` / `projected_rate` and the future-residual surfaces `forecast_x` / `forecast_y` (sourced from `ef_forecast_x` / `ef_forecast_y`).
- **Optional model overlay** — Existing unconditioned model curve with epistemic bands. Sourced from `runtime.unconditioned_overlays['epistemic']`; carried by row fields `model_curve_midpoint` / `model_curve_fan_*` / `model_curve_bands`. May remain as an explicit overlay via the display setting `show_model_curve`, but is **not a display mode** — it is rendered alongside whichever display mode is active.

### Epoch mapping

`tau_solid_max` and `tau_future_max` define the three epochs (see [CF_ROW_PIPELINE.md §6](CF_ROW_PIPELINE.md#6-the-epoch-model)). Public display rules:

| Display mode | Epoch A (τ ≤ tau_solid_max) | Epoch B (tau_solid_max < τ ≤ tau_future_max) | Epoch C (τ > tau_future_max) |
|---|---|---|---|
| **E mode** | strict evidence surface | strict evidence surface (dwindling cohort coverage) | no evidence layer |
| **F mode** | conditioned model surface | conditioned model surface | conditioned model surface |
| **E+F mode** | evidence layer only (forecast layer suppressed in epoch A) | evidence + forecast layers | forecast layer only |
| **Optional model overlay** | overlay if enabled | overlay if enabled | overlay if enabled |

The forecast layer's underlying `ef_*` arrays are generated across the full tau sweep; epoch-A suppression is an output-layer rendering choice, not a data gap. Within `ef_*`, every draw is pinned to strict evidence through each Cohort's frontier and only the unresolved future is continued.

The bead display modes in [BEAD_DISPLAY_MODE.md](BEAD_DISPLAY_MODE.md) are a different concept (per-edge bead rendering), even though they reference "E or F mode" — those refer to which rate series feeds bead `k` values.

## CF substrate (primitive runtime)

- **Primitive / Conditioned transition primitive** — A typed posterior over one parameterised graph edge under one `(scenario, role, date range, context, regime, source preference, anchor selection)` tuple. Lives in `primitives.py`; produced by `primitive_conditioning.condition_primitive` (the single conditioning locus); composed by `subject_span_composer.compose_primitive_span`; read by `primitive_readout`. The core unit of CF runtime computation. See [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md).
- **Identity carrier** — A degenerate carrier where `population_root == denominator_node`. `window()` and `cohort(A = X)` are identity-carrier data cases of the same runtime object. `composed_carrier` is `None`; the reducer treats `population_root == denominator_node` as semantic equality. Design: identity is data, not a route. [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3.10. (The `is_identity_carrier` branches and `_synthesize_identity_carrier_observed_surface` referenced here were removed in the 73q row-pipeline refactor; the identity-carrier concept itself still holds.)
- **Two-clocks split** — In cohort `A != X` mode, the request has **two** `PrefixArrivalMap`s: carrier rooted at A binds carrier primitives; subject rooted at X (with X-day root weights from the carrier's reach to X) binds subject primitives. Built by `request_envelope.build_request_envelope_plan`. Invariant 5 of [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
- **Selected A-clock evidence** — Active `cohort(A, X→end)` observed count-flow on the selected A-clock. Cell **presence** is observed-evidence-driven; cell **amplitude** reads from runtime-resolved prefix objects. (NOTE: the `SelectedAClockEvidence` / `SelectedAClockEvidenceCell` classes named here were removed in the 73q row-pipeline cutover; see [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) §2.4 for the current surface.)
- **Dual prefix objects** — The prefix object family the old row pipeline built (`_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, plus the cell surface), all sharing one carrier reference. (NOTE: these classes were removed in the 73q row-pipeline cutover; see [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) §2 for the current prefix model.)
- **Seam invariant** — The selected-cohort rate reducer and the row builder MUST read the **same** selected prefix object for every selected cohort. From `cohort-1apr-falling-k-problem-statement.md` §A.4. (NOTE: the `_selected_cohort_group_rate_draws` reducer and the `SelectedAClockEvidence` row builder named here were removed in the 73q row-pipeline cutover; the current reducers live in `cohort_forecast_v3.py` as `reduce_cohort_maturity_rows` / `reduce_daily_conversions_rows` / `reduce_cf_scalars`. Re-anchor this entry to the current seam before relying on it.)
- **Draw-family key / `DrawFamilyKey`** — Deterministic key that pins primitive draw coherence. Two consumers presenting the same key under the same scope MUST receive identical draws under matching indices. `make_rng(key, '<derivation>')` is the keyed RNG seam — 13 named derivations replace the legacy `seed=42|43|71` constants. See [DRAW_FAMILY_KEYING.md](DRAW_FAMILY_KEYING.md).
- **Hold-out engine** — One of three analytic engines (`funnel_engine`, `daily_conversions_derivation`, `cohort_maturity_derivation`) that compute `ΣY / ΣX` with their own evidence intake and projection logic, in parallel with the canonical selected-cohort mass reducer. Pending unification (audit F-1). See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md).
- **Legacy trajectory engine** — `forecast_state.compute_forecast_trajectory`. Pre-substrate cohort-loop projector, now **deleted** (retired in 73q Phase 7). The two former callers, `surprise_gauge` and the `daily_conversions` path, both migrated to the shared CF projection/scalar bundle (`prepare_cf_scalar_bundle` + `reduce_cf_scalars`). `forecast_state.py` retains only `_resolve_edge_p` / `_warn_legacy_pmean_carrier` and the `CohortEvidence` container. The name survives only in stale comments and test fixtures. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md) §"The legacy trajectory engine".
- **Residual guard** — `primitive_residual_guard.classify_edge_requirement`. Refuses adjacency `1−p` derivation, residual closure, and rejected prepared spans by emitting `UNSUPPORTED_RESIDUAL` primitives rather than silently computing them. See [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md).

## Evidence operator terms

- **Conditioned (model) operator** — Per-edge value kernel `p × Δcdf` built from the fitted parametric posterior via `ConditionedTransitionPrimitive` / `condition_primitive`. Drives model surfaces (`midpoint`, `fan_*`, `forecast_*`).
- **Empirical (evidence) operator** — Per-edge value kernel `Δk_emp / n_emp` built directly from admitted snapshot rows. Per-draw via arrival-weighted aggregation; forward-filled across absent ages. Drives strict evidence cumulatives.
- **Value kernel** — The per-edge mass-transfer kernel consumed by span composition.
- **Coverage** — A simple Cohort applicability scalar used by cohort-maturity display opacity, not a DP-derived mask/support ratio.
- **Strict evidence** — The unscaled observed evidence display fields `evidence_x`, `evidence_y`, and `rate`.
- **Selected retrieval frontier / frontier τ per anchor** — The per-anchor observation boundary τ for the selected Cohort set. One query-wide observation frontier date (`_analysis_observation_frontier_date`, derived from the admitted evidence-superset rows) is mapped to each anchor as `(frontier_date − anchor).days`. Below the frontier the FC surface (`ef_*`) is prefix-pinned to strict evidence; above it the unresolved mass is continued on the predictive operator basis. Built by `SelectedRetrievalFrontier` / `_build_selected_retrieval_frontier` (`cohort_forecast_v3.py`); empty-frames cohorts (`tau_observed = -1`) carry no frontier, and `bounds = (min, max)` of the per-anchor τ supplies the row epoch boundaries. Behaviour-preserving re-source of the surface formerly read off `SelectedAClockEvidence`.

## Cohort/Window roles

- **A** — Anchor node (cohort entry node).
- **X** — Denominator node (subject start; edge `from_node` for window mode).
- **Y** — Numerator node / subject end (single-hop).
- **Z** — Multi-hop subject end.
- **a, x, y** — Counts at A, X, Y respectively.
- **carrier (A→X)** — Denominator-side: how anchor mass arrives at X.
- **subject span (X→end)** — Numerator-side: progression kernel from X to subject end.
- **Pop C / Pop D** — Frontier sub-populations in cohort forecasting. See [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
- **`anchor_median_lag_days`** — A→X lag, NOT A→Y. Single most important semantic distinction in the snapshot field model. See [SNAPSHOT_FIELD_SEMANTICS.md](SNAPSHOT_FIELD_SEMANTICS.md).

---

## Snapshot DB / Hashing

- **`core_hash`** — Truncated SHA-256 of canonical signature. Snapshot table primary-key component. ~22 chars base64url. See [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md).
- **`identityHash` / `c`** — Inner non-context hash (full SHA-256 hex). Don't confuse with `core_hash`.
- **structured signature** — `{ c: identityHash, x: contextDefHashes }` JSON. Hashed to produce `core_hash`.
- **`slice_key`** — Context value carrier (e.g. `context(channel:google).window(-90d:)`). NOT in `core_hash`.
- **`anchor_day`** — Cohort date (date column). Window mode = arrival date at X. Cohort mode = entry date at A.
- **`retrieved_at`** — Observation timestamp. Multiple values per `anchor_day` = repeated panel observation.
- **`equivalent_hashes`** — Closure set of hashes linked through `hash-mappings.json` for rename resilience.
- **regime** — One slice family per `retrieved_at` date, selected per `project-bayes/30-snapshot-regime-selection-contract.md`.
- **virtual snapshot** — Reconstructed "what we knew on date X" via latest-wins per `anchor_day`.

---

## Probability posterior sources

- **bayesian** — Aggregate offline MCMC fit. Quality-gated by ESS, rhat, divergences.
- **analytic** — Query-scoped FE-topo Beta posterior moments-based fit.
- **manual** — User override (always wins).
- **best_available** — Promotion order: gated bayesian → analytic. Default preference.
- **promoted** — Whichever source `applyPromotion` selected; flat scalars on `edge.p.latency.*`.
- **`alpha_beta_query_scoped`** — Retired discriminator on `ResolvedModelParams` (73b Stage 6, 28-Apr-26). Always `False` post-retirement. The property is retained as a no-op so callers still load; the consumer branches that once routed analytic edges through a no-update shortcut have been removed. All sources now go through conjugate update uniformly.
- **predictive (`α_pred`, `β_pred`, `mu_sd_pred`)** — κ-inflated for observation noise. Per doc 49 (probability) and doc 61 (latency).
- **epistemic (`α`, `β`, `mu_sd`)** — Posterior uncertainty only.

---

## DSL roles in analysis requests

- **`analytics_dsl`** — Subject path (`from(X).to(Y)`). Constant across scenarios. Identifies which edge(s) to query.
- **`effective_query_dsl`** — Per-scenario temporal/context clauses (`window(-90d:)`, `cohort(...)`). Varies per scenario.
- **`dataInterestsDSL`** — Pinned graph-level retrieval template for nightly batch fetches.
- **`pinnedDSL`** — Synonym for `dataInterestsDSL` in some code paths.

See [DSL_SYNTAX_REFERENCE.md](DSL_SYNTAX_REFERENCE.md) §"DSL Roles in the Analysis Request Flow".

---

## Common test fixtures

- **`@requires_synth(name, enriched=bool)`** — Pytest fixture that ensures synth graph is fresh + enriched. See [TESTING_STANDARDS.md](TESTING_STANDARDS.md).
- **`@requires_db`** — Skip if `DB_CONNECTION` not set.
- **`@requires_data_repo`** — Skip if data repo unavailable.

---

## Date format

- **`d-MMM-yy`** — Canonical UK date format (`1-Dec-25`, `15-Jan-26`). Used everywhere except external API boundaries.

---

## Pointers onward

- Query-DSL term semantics → [RESERVED_QUERY_TERMS_GLOSSARY.md](RESERVED_QUERY_TERMS_GLOSSARY.md)
- System map → [TOPOLOGY.md](TOPOLOGY.md)
- Statistical model intuition → [STATISTICAL_DOMAIN_SUMMARY.md](STATISTICAL_DOMAIN_SUMMARY.md)
- Subsystem disambiguation → [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md)
