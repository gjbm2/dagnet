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
