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
- **IPW** — Inverse Probability Weighting. Each observed contribution is scaled by `1 / Pr(observed)` to recover an unbiased estimator of the full-population quantity. Used in the cohort-maturity row reducer to derive `evidence_*_adjusted` from `evidence_*_strict` divided by per-anchor coverage, per Phase 6 §5.6.
- **MCAR** — Missing Completely At Random. Sparsity is uncorrelated with the underlying quantity being measured (e.g. snapshot-row presence is driven by retrieval timing and capture infrastructure, not by cohort or edge conversion behaviour). Under MCAR, IPW is an unbiased estimator. The variance-blow-up at low coverage is bias-free; epoch B dashing communicates the higher variance, not bias.
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
- **Forecast engine** — `lib/runner/forecast_state.py` + `forecast_runtime.py`. Inner kernel; analysis runners must not import directly. See [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md) §3.

---

## Cohort-maturity chart display modes

The `cohort_maturity_v3` chart can render three trajectory modes per scenario, selected in the FE chart UI. They differ in which forecast-engine output series they read from each row:

- **F mode** (model-only forecast) — reads `model_midpoint` / `model_fan_*` / `model_bands`. Pure-model projection: aggregate posterior `p` (from the resolved source-ledger model) times the latency CDF at τ. Decoupled from per-cohort observed slices — invariant under query window choice for a given fixture/posterior. F is `compute_forecast_trajectory.model_rate_draws` aggregated by `np.median` per τ.
- **E+F mode** (evidence + forecast) — reads `midpoint` / `fan_*` / `fan_bands`. Data-conditioned trajectory: cohort-loop output with IS conditioning on per-cohort observed slices, doc-52-blended with the IS-off twin where evidence is sparse. Pulls toward local evidence; varies sharply by query window.
- **E mode** (evidence-only) — reads `evidence_y` / `evidence_x` (Σy, Σx aggregated across cohorts contributing observation at τ). The chart shows the observed slice without model projection.

The bead display modes in [BEAD_DISPLAY_MODE.md](BEAD_DISPLAY_MODE.md) are a different concept (per-edge bead rendering), even though they reference "E or F mode" — those refer to which rate series feeds bead `k` values.

The F vs E+F invariant: at τ = `tau_solid_max` both lines should agree (latency CDF still small leaves both ≈ 0 in the typical drift-free case); off-frontier they diverge under drift / window-localised evidence. The contract — that F is the model-only projection, NOT a re-render of cohort observations — was restored 1-May-26 (regression where `model_rate_draws` had been wired to the cohort-loop IS-off twin).

## CF substrate (primitive runtime)

- **Primitive / Conditioned transition primitive** — A typed posterior over one parameterised graph edge under one `(scenario, role, date range, context, regime, source preference, anchor selection)` tuple. Lives in `primitives.py`; produced by `primitive_conditioning.condition_primitive` (the single conditioning locus); composed by `subject_span_composer.compose_primitive_span`; read by `primitive_readout`. The core unit of CF runtime computation. See [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md).
- **Identity carrier** — A degenerate carrier where `population_root == denominator_node`. `window()` and `cohort(A = X)` are identity-carrier data cases of the same runtime object. `composed_carrier` is `None`; the reducer treats `population_root == denominator_node` as semantic equality. Design: identity is data, not a route. Current implementation has 20+ `is_identity_carrier:` branches plus `_synthesize_identity_carrier_observed_surface` (audit H-5; AP58). [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3.10.
- **Two-clocks split** — In cohort `A != X` mode, the request has **two** `PrefixArrivalMap`s: carrier rooted at A binds carrier primitives; subject rooted at X (with X-day root weights from the carrier's reach to X) binds subject primitives. Built by `request_envelope.build_request_envelope_plan`. Invariant 5 of [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
- **Selected A-clock evidence / `SelectedAClockEvidence`** — Active `cohort(A, X→end)` observed count-flow on the selected A-clock. `SelectedAClockEvidenceCell(anchor_day, τ, x_at_query_x, y_at_subject_end, ...)`. Cell **presence** is observed-evidence-driven; cell **amplitude** reads from runtime-resolved dual-prefix objects. See [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) §2.4.
- **Dual prefix objects** — The four-piece object family the row pipeline builds: `_SelectedSourceDayMass` (`M_select(U, C, u)`), `_CarrierOnlyDenominatorPrefix` (`X_prefix`), `_RateAttributedSubjectPrefix` (`Y_prefix`), `SelectedAClockEvidence` (cell surface). All share one carrier reference. See [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) §2.
- **Seam invariant** — The reducer (`_selected_cohort_group_rate_draws`) and the row builder (`SelectedAClockEvidence.aggregate_by_tau`) MUST read the **same** selected prefix object for every selected cohort. From `cohort-1apr-falling-k-problem-statement.md` §A.4. Enforced at `cohort_forecast_v3.py:4751`.
- **Draw-family key / `DrawFamilyKey`** — Deterministic key that pins primitive draw coherence. Two consumers presenting the same key under the same scope MUST receive identical draws under matching indices. `make_rng(key, '<derivation>')` is the keyed RNG seam — 13 named derivations replace the legacy `seed=42|43|71` constants. See [DRAW_FAMILY_KEYING.md](DRAW_FAMILY_KEYING.md).
- **Hold-out engine** — One of three analytic engines (`funnel_engine`, `daily_conversions_derivation`, `cohort_maturity_derivation`) that compute `ΣY / ΣX` with their own evidence intake and projection logic, in parallel with the canonical selected-cohort mass reducer. Pending unification (audit F-1). See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md).
- **Legacy trajectory engine** — `forecast_state.compute_forecast_trajectory`. Pre-substrate cohort-loop projector. Post-73n status: "DO NOT ADD NEW CALLERS". Two surviving callers: `surprise_gauge` and `daily_conversions` row annotation. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md) §"The legacy trajectory engine".
- **Residual guard** — `primitive_residual_guard.classify_edge_requirement`. Refuses adjacency `1−p` derivation, residual closure, and rejected prepared spans by emitting `UNSUPPORTED_RESIDUAL` primitives rather than silently computing them. See [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md).

## Evidence operator / coverage algebra

Terms from the Phase 6 evidence-operator contract ([phase-6-evidence-operator-contract.md](../project-generalise/phase-6-evidence-operator-contract.md)).

- **Conditioned (model) operator** — Per-edge kernel `p × Δcdf` built from the fitted parametric posterior via `ConditionedTransitionPrimitive` / `condition_primitive`. Defined at every cell (continuous parametric fit). Drives model surfaces (`midpoint`, `fan_*`, `forecast_*`) and — with the row-presence mask — coverage and exposure. Phase 6 §4.1.
- **Empirical (evidence) operator** — Per-edge kernel `Δk_emp / n_emp` built directly from admitted snapshot rows. Per-draw via arrival-weighted aggregation; forward-filled across absent ages (Δ = 0 at absent cells, structurally). Drives strict evidence cumulatives. Phase 6 §4.9.
- **Value kernel** — `p × Δcdf` per edge from the conditioned operator. The "mass projection" kernel. Phase 6 §4.8.
- **Support kernel** — `value_kernel × mask`. Cell-wise zeroed at absent (mask = 0) cells. Phase 6 §4.8.
- **Exposure kernel** — `unit_density_shape × mask`. Independent of `p`. Distinguishes covered-zero (mask=1, value=0) from absent (mask=0) at terminal-zero cells. Phase 6 §4.8.
- **Masked kernel** — Generic term for any kernel × row-presence mask. Support and exposure are both masked kernels with different value bases.
- **Row-presence mask** — Per-cell `(edge, source_day, age)` indicator. `1` iff a snapshot row exists at that cell; `0` iff absent. Pure row-presence, independent of `k` / `n` values. Plumbed from `bind_primitive_evidence` through `condition_primitive` into the composer.
- **Coverage** — `cumulative_support / cumulative_value` per `(anchor, τ)`. Mass-weighted fraction of the wavefront passing through fully-observed paths. Computed exclusively against the conditioned operator's value stream (the empirical kernel collapses the ratio to 1). Phase 6 §4.8.
- **Per-terminal coverage** — Coverage read at distinct chain nodes. `coverage_x_A[τ]` at X (carrier terminal) drives `evidence_x_coverage` and the `evidence_x_adjusted` IPW factor. `coverage_y_A[τ]` at Z (chain terminal) drives `evidence_y_coverage` and the `evidence_y_adjusted` IPW factor. In window or `A=X` mode the carrier is identity and `coverage_x = 1` trivially.
- **Exposure (signal)** — `cumulative_exposure` per `(anchor, τ)`. `> 0` iff at least one wavefront path reached `(anchor, τ)` through observed cells. Drives admissibility filtering at the reducer.
- **Frontier (τ per anchor)** — `max τ where exposure_y_A[τ] > 0`. The last τ at which any wavefront path to the chain terminal is fully observed for that anchor.
- **Admissibility** — Per-`(anchor, τ)` `exposure_y_A[τ] > 0`. Cohorts failing the admissibility check at τ contribute neither to strict nor adjusted row-level sums at that τ.
- **Strict evidence** — `Σ_admissible evidence_y_strict_A[τ]` per τ, no scaling. The E-mode display fields `evidence_x`, `evidence_y`, `rate`. Falls naturally in epoch B with sparsity. Phase 6 §5.6.
- **Adjusted evidence** — `Σ_admissible evidence_y_strict_A[τ] / coverage_y_A[τ]` per τ, IPW under MCAR. The E+F-mode display fields `evidence_x_adjusted`, `evidence_y_adjusted`, `rate_adjusted`. Supersedes legacy `rate_blended`. Phase 6 §5.6.

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
