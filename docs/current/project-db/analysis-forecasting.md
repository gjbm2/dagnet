# Analysis Forecasting: Statistics on the Backend

**Status**: Core architecture implemented (Phases 1–8 done, 10-Feb-26). Parallel-run tested; defects 1–2, 5–8 fixed (11-Feb-26). MECE union aggregation mismatch under investigation. See `analysis-forecasting-implementation-plan.md` for detailed status.  
**Date**: 8-Feb-26 (design) · 10-Feb-26 (settings decision, implementation Phases 1–8)  
**Related**: `1-reads.md`, `2-time-series-charting.md`, design.md §5

---

## 1. The Problem

All statistical and forecasting logic currently lives on the **frontend** (TypeScript). The backend (Python) analysis routes have no access to:

- Lognormal distribution fitting (`fitLagDistribution`)
- CDF evaluation (`logNormalCDF`, `logNormalSurvival`)
- Completeness estimation (what fraction of conversions have been observed for a cohort of age *t* days?)
- Evidence-forecast blending (`computeBlendedMean`)
- Onset delta correction (`toModelSpace` and related functions)
- Latency constants (`LATENCY_*`, `FORECAST_BLEND_LAMBDA`, etc.)

This means the backend can currently only **aggregate historic data** (sum DeltaY, count rows). It cannot:

- Project immature cohorts forward to estimate final conversion rates
- Draw fan charts showing expected completion trajectories
- Apply evidence-forecast blends to partially-observed cohorts
- Estimate cohort maturity/completeness per data point

These capabilities are required by the Phase 5 charting features (`2-time-series-charting.md` §2.3 evidence/forecast distinction, §2.4 fan charts, §5 completeness overlays) and will also be needed for any analysis type that returns projected values rather than raw observations.

---

## 2. Current Frontend Statistical Architecture

### 2.1 Pure Maths Layer (dependency-free)

**File**: `graph-editor/src/services/lagDistributionUtils.ts` (~350 lines)

Intentionally free of service dependencies. Pure functions:

- `erf(x)` — Error function (Abramowitz & Stegun approximation)
- `standardNormalCDF(x)` / `standardNormalInverseCDF(p)` — Phi and Phi-inverse
- `logNormalCDF(t, mu, sigma)` — Lognormal CDF
- `logNormalInverseCDF(p, mu, sigma)` — Lognormal quantile
- `logNormalSurvival(t, mu, sigma)` — 1 - CDF
- `fitLagDistribution(medianLag, meanLag, totalK)` — Fit mu/sigma from Amplitude-reported stats
- `toModelSpace(onsetDelta, median, mean, t95, age)` — Onset delta correction

Behaviour is locked by `lagDistribution.golden.test.ts`.

### 2.2 Orchestration Layer (service-dependent)

**File**: `graph-editor/src/services/statisticalEnhancementService.ts` (~3200 lines)

Uses the pure maths layer plus graph state, window aggregation, and forecasting settings to:

- Compute per-cohort completeness from lognormal CDF + cohort age
- Blend evidence (observed) with forecast (baseline) weighted by completeness
- Apply recency weighting and blend lambda controls
- Handle the full LAG (Latency-Aware Graph) pipeline: per-cohort → fit → completeness → blend → p.mean

### 2.3 Constants

**File**: `graph-editor/src/constants/latency.ts`

Defines all tuning constants: `LATENCY_DEFAULT_SIGMA`, `FORECAST_BLEND_LAMBDA`, `LATENCY_T95_PERCENTILE`, `ONSET_MASS_FRACTION_ALPHA`, etc.

---

## 3. What the Backend Needs

For forecasting/projection within analysis results, the backend requires:

### 3.1 Minimum Viable: Completeness Estimation

Given:
- A row with `anchor_day`, `retrieved_at`, `Y`, `X`
- A lognormal fit (mu, sigma) for the parameter's lag distribution
- An onset delta (days of dead-time before conversions begin)

Compute:
- `cohort_age_days = (retrieved_at.date() - anchor_day).days`
- `model_age = max(0, cohort_age_days - onset_delta)`
- `completeness = logNormalCDF(model_age, mu, sigma)`

This is sufficient for:
- Colouring bars by maturity (complete vs immature)
- Showing "expect ~X% more conversions" tooltips
- Basic evidence/forecast distinction

### 3.2 Full Projection: Evidence-Forecast Blend

Given completeness + a baseline conversion rate (from mature cohorts in the same window):
- `w_evidence = (completeness * n_query) / (lambda * n_baseline + completeness * n_query)`
- `projected_pct = w_evidence * observed_pct + (1 - w_evidence) * baseline_pct`

### 3.3 Fan Charts: Quantile Projections

Given the lognormal fit and current completeness:
- Project forward: "at time *t + dt*, expected completeness will be..."
- Compute confidence bands around the projection using snapshot variance

---

## 4. Required Architectural Change: Split Fitting from Application

### 4.1 Why this split is necessary

Today, the frontend topo/LAG pass effectively does two different jobs in one go:

- **Fitting**: infer a stable lag distribution model for an edge (the “distro”) from accumulated cohort evidence.
- **Application**: for a given query window/context/date, evaluate maturity/completeness and compute evidence/forecast blends.

This coupling creates an unacceptable behavioural property:

> If the user changes `cohort()` / `window()` bounds or `context()` and then fetches, the same Stage‑2 pass can refit the model using a different slice/window selection. Model parameters can “move” for reasons unrelated to new data.

For analysis and charting, this is worse:

- We must **not** rerun fitting/topo computations per analysis request (especially not per scenario).
- We need **stable models** whose meaning does not depend on the current DSL.

Therefore we explicitly split the pipeline:

1. **Fit (in Python, master)**: recompute lag models only when underlying evidence changes, or when the user explicitly requests recomputation.
2. **Apply (in Python, analysis-time)**: evaluate completeness/projections/blends for the analysis window without refitting.

### 4.2 Canonical ownership: Python is master of fitting

We explicitly move the lag model fitting and forecasting logic to Python and treat it as the single source of truth.

The frontend becomes a slave for:

- Showing fitted parameters and derived scalars on the graph UI.
- Persisting those values to the graph/parameter files for offline use and reproducibility.

### 4.3 When fitting runs (and when it must NOT run)

Fitting runs only on **model update events**, not on query edits.

**Must run**:

- After a fetch from origin that writes new snapshot rows (evidence changed).
- When the user explicitly triggers “Recompute lag models / horizons” (manual action).

**Must NOT run**:

- When the user edits only the DSL (date range changes, `context()` changes, scenario DSL changes).
- When the user runs an analysis request (including multi-scenario cohort maturity analysis).

### 4.4 Persisted model state (schema extension — revised 10-Feb-26)

To evaluate completeness offline (cached fetch, no backend), the frontend needs the fitted distribution parameters on the graph edge.

**Decision (10-Feb-26)**: Flat scalars on `edge.p.latency`, not a nested `model_v1` object. Minimal schema surface; can be upgraded to a richer structure later if more sophisticated model fitting warrants it.

New fields on `edge.p.latency` (and similarly `edge.conditional_p[i].p.latency`):

| Field | Type | Purpose |
|---|---|---|
| `mu` | number | Fitted log-normal mu parameter |
| `sigma` | number | Fitted log-normal sigma parameter |
| `model_trained_at` | string (UK date, e.g. `10-Feb-26`) | When the model was last fitted; staleness detection |

These are **not exposed in the edge properties panel** and have **no `_overridden` flags**. They are internal model parameters, not user-facing values. If the user wants to constrain the model, they override `t95` (which already has `t95_overridden` and acts as a one-way sigma constraint on the fit). The raw graph YAML is available for inspection if needed.

The existing flat fields (`t95`, `median_lag_days`, `mean_lag_days`, `onset_delta_days`, `completeness`) remain unchanged. After cutover, `t95` becomes derived from `mu`/`sigma` rather than independently fitted, but the field itself stays the same.

**File persistence**: `mu`, `sigma`, and `model_trained_at` are synced to the parameter file via the existing graph↔file push/pull mechanism, alongside `t95`, `median_lag_days`, etc. This means they are committed to git and available in shared/cloned workspaces. The same fields appear in the parameter file's latency section and in the YAML param schema.

Provenance fields (training window, settings signature, quality gates, total converters) are returned by the recompute API response for logging/audit but are **not persisted on the graph or parameter files**. They can be added later if audit requirements warrant it.

This is the “one or two more modelling params” referenced in the requirement.

### 4.5 Forecasting settings: frontend sends, Python applies

**Decoupling principle (non-negotiable)**: The Python backend is logically decoupled from the frontend. It must NOT read files from frontend directories (`public/`, `src/`, etc.) at runtime. It may run on a remote server with no access to the repo filesystem. All configuration must arrive via the API request.

**Decision (10-Feb-26)**: Settings are per-repo configuration, edited in the frontend codebase (currently `graph-editor/src/constants/latency.ts`). The frontend sends them explicitly in every API request that needs them. Python defines hardcoded defaults (for tests and as documentation) but the frontend-supplied values are authoritative when present.

**Settings object shape** (`forecasting_settings`):

Fitting settings (control model creation):

- `min_fit_converters`: minimum converters for quality gate (default: 30)
- `min_mean_median_ratio`: lower quality gate on mean/median ratio (default: 0.9)
- `max_mean_median_ratio`: upper quality gate on mean/median ratio (default: 999999)
- `default_sigma`: fallback sigma when mean is missing (default: 0.5)
- `recency_half_life_days`: half-life for recency weighting (default: 30)
- `onset_mass_fraction_alpha`: onset estimation parameter (default: 0.01)
- `onset_aggregation_beta`: onset aggregation parameter (default: 0.5)

Application settings (control completeness evaluation and blending):

- `t95_percentile`: which percentile defines "t95" (default: 0.95)
- `forecast_blend_lambda`: evidence/forecast blend weight (default: 0.15)
- `blend_completeness_power`: blend curve shape (default: 2.25)

Mathematical constants (`epsilon = 1e-9`, erf coefficients, etc.) are hardcoded in both languages — they are mathematical invariants, not configuration.

**`settings_signature`**: Computed by the frontend as a stable hash of the `forecasting_settings` object it sends. Persisted with each fitted model for reproducibility and audit. If the settings change, the signature changes, and stale models can be identified.

**Python defaults**: Python defines the same default values as module-level constants (for use in tests and as self-documentation). A cross-language parity test asserts these defaults match the TS constants. At runtime, request-supplied values always take precedence.

**Parity guarantee** is achieved by:

- Python being the master implementation for fitting and application.
- Persisting `settings_signature` with each model so analyses can be audited.
- A golden fixture suite for the pure maths layer (CDF/inverse/fit) to lock behaviour.
- A parity test asserting Python default constants match the TS constants.

### 4.6 What data Python needs to fit a model

Python fitting does not depend on frontend parameter files. It relies on snapshot DB evidence.

At minimum, for each subject (edge parameter), Python needs:

- `param_id`, `core_hash`, `slice_keys` (to locate the correct semantic series)
- A training anchor window: `training_anchor_from/to` (ISO dates)
- Snapshot rows containing:
  - counts (`X`, `Y`) per `anchor_day`
  - per-anchor lag moments (as stored in the DB rows): `median_lag_days`, `mean_lag_days`
  - optionally: `onset_delta_days` evidence if available in rows (else use model/onset policy)
  - `retrieved_at` (to support recency weighting and to select the “latest known” evidence per anchor day)

The fitter must define a stable policy for:

- How it chooses the “evidence snapshot” per anchor day (typically: latest `retrieved_at` for that anchor day within the training sweep).
- How it aggregates moments across anchor days (recency weighting, and weighting by `X` or `Y` as appropriate).
- Quality gates (minimum converters, mean/median ratio bounds, etc.).

### 4.7 Offline behaviour

If the user is offline:

- Analyses can still run against locally-available graphs and cached snapshot-derived results only if a backend is present (offline here means “no backend” in practice).
- The UI remains usable; models and derived scalars persist on the graph/parameter files.
- The user cannot recompute lag models (fitting is backend-owned) until reconnected.

This is acceptable if model recomputation is an **occasional** operation (after real fetches or explicit user action), not an “every query change” operation.

---

## 5. Proposed Backend API: Recompute Lag Models

### 5.1 New route

Add a dedicated route that recomputes and returns lag models for a set of subjects:

- `POST /api/lag/recompute-models`

### 5.2 Request shape (conceptual)

Inputs:

- `workspace`: `{ repository, branch }`
- `subjects`: array of `{ subject_id, param_id, core_hash, slice_keys, target: { targetId, slot?, conditionalIndex? } }`
- `training_anchor_from/to`: ISO dates (explicit), OR a named policy e.g. `last_60d` (backend expands to dates)
- `as_at` (optional): ISO datetime for “what did we know as of …” fitting (rare; default is latest)
- `forecasting_settings` (required): the full settings object as defined in §4.5, sent by the frontend. Python uses these values for fitting and persists `settings_signature` with each model.

### 5.3 Response shape (conceptual)

For each subject:

- `model_v1`: `{ mu, sigma, onset_delta_days, t95_days, trained_at, training_window, settings_signature, quality_ok, total_k, notes? }`
- plus derived scalars to apply immediately:
  - `t95`, `path_t95` (if computed here), `completeness` for “today” or for a given evaluation date (optional)
  - `p_forecast` baseline (optional; can be computed during application)

The frontend applies these values to the graph (and optionally persists to parameter files) as a separate, explicit step.

---

## 6. Application in Analysis: Completeness + Evidence/Forecast Output

### 6.1 Completeness is mandatory output

Every cohort-style analysis must emit completeness so the chart can be labelled correctly.

For each anchor day (and for cohort maturity, for each frame), emit:

- `completeness` \(c \in [0, 1]\)
- `layer` classification:
  - `layer: 'evidence'` for the observed component
  - `layer: 'forecast'` for the projected component

### 6.2 Evidence/forecast split for F+E visualisation

For an anchor day with observed `y` conversions:

- `projected_y = y / max(c, eps)` (simple projection)
- `evidence_y = y`
- `forecast_y = projected_y - evidence_y`

The frontend can render:

- solid bar for `evidence_y`
- striped bar for `forecast_y` (immature portion)

If the full blend is desired (baseline p∞ + λ etc), the backend computes:

- a baseline probability from mature cohorts in the same analysis window (or from the persisted model metadata)
- blended `projected_pct` and corresponding `projected_y`

### 6.3 Fan chart outputs

Fan charts can be computed from the model by evaluating completeness forward in time for chosen horizons (e.g. +7d, +14d, +30d) and translating into projected final conversion percentiles.

Confidence bands require an explicit policy (initially model-based; later can incorporate empirical variance).

---

## 6.4 Can Python reproduce the frontend topo/LAG pass from DB + graph + slice plans?

This section answers the key question:

> What *other* data is the frontend using for the topo pass, and can Python compute the same results using only the snapshot DB + frontend-provided slice/signature plans + the scenario graph?

### 6.4.1 What the frontend topo pass consumes today (inputs)

The current topo/LAG computation in the frontend (`enhanceGraphLatencies` → `computeEdgeLatencyStats`) consumes four categories of inputs:

1. **Snapshot-style evidence** (per anchor day):
   - `X`, `Y` (denominator/trials and converters)
   - lag moments: `median_lag_days`, `mean_lag_days`
   - anchor-travel moments (for downstream edges): `anchor_median_lag_days`, `anchor_mean_lag_days`
   - optional onset evidence: `onset_delta_days`
   - `retrieved_at` (the “version boundary” of the evidence)

2. **Scenario graph structure** (topology + edge metadata):
   - nodes/edges connectivity (topological traversal)
   - start node semantics (`entry.is_start`, `entry.entry_weight`)
   - per-edge latency enablement and overrides:
     - `latency_parameter` enablement flag(s)
     - `t95_overridden`, `path_t95_overridden`, `onset_delta_days_overridden`
     - `t95` / `path_t95` when present (as constraints and/or horizon sources)

3. **Query semantics / mode**:
   - “window-mode” vs “cohort-mode” maturity semantics
   - optional “cohortWindow” scoping that defines which cohorts count for maturity/blend under the current query
   - scenario-aware edge enablement (what-if / scenario layer)

4. **Forecasting settings** (tuning constants + policies):
   - `RECENCY_HALF_LIFE_DAYS`
   - `FORECAST_BLEND_LAMBDA`
   - `LATENCY_BLEND_COMPLETENESS_POWER`
   - `LATENCY_MAX_MEAN_MEDIAN_RATIO`, quality gates, default horizons, onset aggregation settings, etc.

### 6.4.2 What Python is allowed to use

To keep the Python role clean and pure:

- ✅ Python may use **only** the snapshot DB (primary evidence source) and the scenario graph embedded in the request.
- ✅ Python may aggregate/transform DB rows deterministically.
- ✅ Python may accept a frontend-provided plan that states *exactly* which semantic series to operate on (e.g. slice keys).
- ❌ Python must not access parameter files or any other secondary storage.
- ❌ Python must not *infer* slice partitions or MECE unions (that’s frontend planning).

Importantly, “Python must not infer slice partitions” does **not** mean “Python cannot add numbers together”.
It means Python must not decide what to add. The frontend provides `slice_keys[]` explicitly.

### 6.4.3 Mapping: can Python reconstruct every frontend input?

| Frontend topo input | Where it comes from today | Can Python get it from DB + graph + FE plan? | Notes |
|---|---|---|---|
| `X`, `Y` per `anchor_day` | Parameter value arrays | ✅ Yes | Stored per DB row in `snapshots` |
| `median_lag_days`, `mean_lag_days` per `anchor_day` | Parameter value arrays | ✅ Yes | Stored per DB row in `snapshots` |
| `anchor_*_lag_days` per `anchor_day` | Parameter value arrays | ✅ Yes | Stored per DB row in `snapshots` |
| `onset_delta_days` evidence | Derived from histograms / stored | ✅ Yes (if stored in DB rows) or via override/settings | DB already has `onset_delta_days` column. If missing in practice, policy must define fallback. |
| Evidence “version boundary” | Parameter value `data_source.retrieved_at` | ✅ Yes | DB has `retrieved_at` per row |
| Which slices belong to the semantic series | Planner/MECE resolution in FE | ✅ Yes, if FE provides `slice_keys[]` | Py must treat `slice_keys[]` as authoritative; no inference. |
| Graph topology (for topo traversal) | In-memory graph | ✅ Yes | Graph is already sent in analysis requests (`scenarios[].graph`). |
| Start-node semantics / entry weights | Graph node metadata | ✅ Yes | Comes from graph. |
| Active latency edges | Graph edge metadata | ✅ Yes | Determined from graph (same rules can be implemented in Python). |
| Path horizon DP (`path_t95`) | Computed in FE | ✅ Yes | Can be recomputed in Python from graph + per-edge `t95`/defaults/overrides. |
| Query mode (window vs cohort) | DSL + FE mode selection | ✅ Yes, if made explicit | For forecasting in analysis, mode must be explicit in request/contract; avoid implicit inference. |
| Forecasting settings | FE service | ✅ Yes | Frontend sends `forecasting_settings` explicitly in the API request (§4.5). No local file reads. |

Conclusion: **Yes** — Python can reproduce the topo/LAG outputs using only snapshot DB rows + scenario graph + frontend-provided `slice_keys[]` + deterministic forecasting settings.

The risk is not missing data; it is **policy drift** (row selection, weighting, and mode semantics). Therefore the policies must be explicit and tested.

### 6.4.4 Evidence selection policy (must be explicit)

The snapshot DB contains multiple “versions” per anchor day (different `retrieved_at`), and potentially multiple slice keys.
Both fitting and application must define which rows are considered evidence.

Python must implement these policies explicitly (and tests must lock them):

- **Policy P1 (latest evidence)**:
  - For each `anchor_day` and each `slice_key` in `slice_keys[]`, pick the row with the greatest `retrieved_at` within the allowed sweep.
  - Then aggregate across slice keys (sum X/Y; and apply the chosen lag-moment aggregation policy).
  - This corresponds to “use what we know now”.

- **Policy P2 (as-at evidence)**:
  - Same as P1, but restrict to rows with `retrieved_at <= as_at`.
  - This corresponds to “what did we know as of time T”.

- **Policy P3 (sweep frames)** (for cohort maturity):
  - Identify a list of frame boundaries (distinct retrieval days/timestamps in `[sweep_from, sweep_to]`).
  - For each frame boundary `t`, apply P2 with `as_at = t` to compute the virtual snapshot evidence for that frame.

These policies are already conceptually present in the snapshot read modes; they are made explicit here because fitting/application must not silently “do something reasonable”.

### 6.4.5 Lag-moment aggregation policy (slice_keys union)

When `slice_keys[]` contains multiple keys (MECE union), Python must aggregate across them.
This is allowed because the frontend explicitly provided the union set; Python is not inferring it.

However, to match frontend semantics, the aggregation policy must be specified:

- Counts:
  - `X_total = Σ X_i`
  - `Y_total = Σ Y_i`

- Lag moments:
  - The system currently treats lag moments as part of the evidence stream; therefore Python needs a deterministic rule to aggregate them across slices.
  - (The exact rule must match the shipped frontend logic; initial implementation should mirror the existing mixture/aggregation approach used by FE.)

If the frontend already has a definitive mixture aggregation implementation (e.g. a lognormal mixture helper), port that logic to Python and lock it with tests.

### 6.4.6 Minimal data contract from frontend to Python (fit/apply)

To keep Python free of inference and free of local file dependencies, the frontend must provide:

- The semantic subject identity: `param_id`, `core_hash`
- The semantic slice plan: `slice_keys[]`
- The query semantics:
  - mode: `'window' | 'cohort'` (or an equivalent explicit flag)
  - evaluation horizon / as-at or sweep range as required by the analysis read mode
- The scenario graph (already in request)
- `forecasting_settings`: the full settings object (§4.5), required for both fitting and application

This is sufficient for Python to:

- Query the DB for evidence rows
- Select evidence by policy P1/P2/P3
- Fit models (when asked) using frontend-supplied settings
- Apply models (always during analysis) using frontend-supplied settings
- Return completeness and evidence/forecast outputs

---

## 7. Implementation Plan (Forecasting Phase)

### 7.0 Risk strategy: parallel-run migration

**Principle**: The frontend currently performs complex statistical fitting and application (topo/LAG pass). After this work, Python handles all of it. To confirm the port is correct, we must pass through an explicit intermediate state where **both codepaths are live and their outputs are compared**.

**Phase sequence**:

1. **Port** — Build the Python library and API. Frontend codepaths unchanged.
2. **Parallel run** — Both frontend and backend compute models/completeness. Frontend compares results and **hard-fails on mismatch** (session log error, not silent).
3. **Soak** — Run in production in parallel-run state. Investigate and fix any mismatches.
4. **Cutover** — Frontend stops computing, uses backend results only. Backend is authoritative.
5. **Cleanup** — Remove frontend fitting/application codepaths. Reduce code surface area.

**Parallel-run mechanics** (Phase 2):

For model fitting:
- Frontend computes model params as it does today (topo/LAG pass) producing `fe_model`
- Frontend calls `/api/lag/recompute-models` with the same subjects + `forecasting_settings` producing `be_model`
- Frontend compares `be_model.mu`, `.sigma`, `.onset_delta_days`, `.t95_days` against `fe_model`
- If any value differs beyond tolerance (e.g. |delta| > 1e-4 for mu/sigma, > 0.5 for t95_days): **emit diagnostic error** to session log + console with: subject_id, field name, FE value, BE value, delta, tolerance, and the `forecasting_settings` used. Must be enough to diagnose the mismatch without reproduction.

For completeness/application:
- Backend analysis responses include `completeness` per anchor_day
- Frontend also evaluates completeness locally from its own model params
- Frontend compares per anchor_day: **emit diagnostic error** on mismatch beyond tolerance (e.g. > 1e-3) with: subject_id, anchor_day, FE completeness, BE completeness, delta, and the model params (mu, sigma, onset_delta) used by each side.

**Tolerance rationale**: Floating-point maths is not bit-identical across TS and Python (different erf approximations, different rounding). The tolerances must be tight enough to catch real bugs but loose enough to accept legitimate FP differences. The golden parity tests (§7.1) establish the baseline tolerance.

**Graceful degradation during parallel run**: If the backend is unreachable (offline), the frontend falls back to its own computation silently (no hard error). The parallel comparison only fires when both results are available.

---

### 7.1 Build the Python modelling library

- `lag_distribution_utils.py`: port pure maths (erf, Φ, Φ⁻¹, lognormal CDF/inverse, moment-fit).
- `forecasting_settings.py`: define default constants (for tests/documentation), accept request-supplied settings, compute `settings_signature`. No file reads.
- `lag_model_fitter.py`: queries snapshot DB evidence and produces fitted model params (mu, sigma, plus transient provenance).
- `forecast_application.py`: computes completeness, projections, layers, fan chart points.

Golden tests: shared numerical fixtures (inputs + expected outputs) consumed independently by both TS and Python test suites. These establish the FP tolerance baseline for the parallel run.

### 7.2 Add persistence fields on graph/parameter models

- Extend the TypeScript types (`LatencyConfig`) to include `mu`, `sigma`, `model_trained_at` as optional flat fields (see §4.4).
- Extend Python Pydantic `LatencyConfig` and YAML param schema with matching fields.

### 7.3 Wire recompute into the product workflow

Two triggers:

- **Automatic**: after a successful fetch-from-origin job that writes new snapshot rows, call `/api/lag/recompute-models` for affected subjects (bounded set).
- **Manual**: a user action “Recompute lag models/horizons” that calls the same route for all latency edges.

### 7.4 Parallel-run comparison (frontend)

- Add a comparison layer in the frontend that runs after both FE and BE results are available.
- Comparison points: model params (mu, sigma, onset_delta, t95), completeness per anchor_day, blended projections.
- On mismatch: emit a detailed diagnostic error to both session log (`sessionLogService.error()`) and console log, including the comparison point name, FE value, BE value, delta, and tolerance. Must contain enough detail to unpick the root cause without reproducing the scenario.
- Gated by a feature flag (e.g. `FORECASTING_PARALLEL_RUN = true`) so it can be enabled/disabled.
- Offline fallback: if backend is unreachable, skip comparison and use FE results.

### 7.5 Cutover

- Disable the frontend topo/LAG fitting pass. Frontend reads model params from graph (persisted by the recompute workflow).
- Frontend reads completeness/projections from backend analysis responses.
- Remove the parallel-run comparison layer.

### 7.6 Cleanup

- Remove frontend fitting codepaths from `statisticalEnhancementService.ts` (the ~3200-line orchestration layer).
- Remove or simplify `lagDistributionUtils.ts` to retain only functions needed for display (if any).
- Significant code surface area reduction.

### 7.7 Ensure we do not refit on DSL edits

- Query DSL changes should only affect application (which frames/anchor days are evaluated and displayed), not fitting.
- Fitting uses the training window policy, not the current query window.
- This invariant is enforced by the fit/apply split: the recompute API is a separate call from analysis, triggered only by data changes or explicit user action.

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Behaviour drift between FE and BE | Low | High | Python is the single master; FE only persists and displays model outputs |
| Settings mismatch | Low | High | Frontend sends settings explicitly in every request (§4.5); `settings_signature` persisted per model; cross-language parity test on defaults |
| Insufficient DB evidence to fit | Medium | Medium | Quality gates + fallbacks; surface “quality_ok=false” and keep conservative defaults |
| Performance of bulk model recompute | Medium | Medium | Batch DB queries + dedup; recompute only for affected subjects; cache within request |

---

## 9. What `reads.md` Must Anticipate

The snapshot read path must support application-time forecasting outputs:

- `completeness` per anchor day (and per frame for cohort maturity)
- evidence/forecast split fields (`layer`, `projected_y`, etc.)
- fan chart support (future)

`SnapshotSubjectRequest` does **not** need to carry a full lag fit if `mu`/`sigma` are persisted on the graph edge (`edge.p.latency.mu`, `.sigma`) and the backend is responsible for applying them.

---

## 10. References

- `lagDistributionUtils.ts` — Pure maths (frontend, current implementation)
- `statisticalEnhancementService.ts` — Orchestration (frontend, current)
- `constants/latency.ts` — Tuning constants (frontend, current)
- `2-time-series-charting.md` §2.3, §2.4, §5 — Forecast/fan chart requirements
- design.md §5 — LAG architecture specification
