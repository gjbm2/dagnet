# Analysis Forecasting: Statistics on the Backend

**Status**: Architectural Note (not yet implemented)  
**Date**: 8-Feb-26  
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

### 4.4 Persisted model state (schema extension)

To apply forecasts later without refitting, we persist the model and its provenance onto the graph/parameter layer.

We add a new persisted structure (name intentionally versioned):

- `edge.p.latency.model_v1` (and similarly `edge.conditional_p[i].p.latency.model_v1`):
  - `mu`: number
  - `sigma`: number
  - `onset_delta_days`: number
  - `t95_days`: number (derived from the fit, used for horizons and maturity semantics)
  - `trained_at`: ISO datetime (UTC)
  - `training_window`: `{ anchor_from: ISO date, anchor_to: ISO date }` (the evidence window used for fitting)
  - `settings_signature`: string (hash of the forecasting settings used for this fit)
  - `quality_ok`: boolean (quality gates passed)
  - `total_k`: number (converters used for fitting; audit and gating)
  - `notes?`: optional string (human-readable failure reason when quality gates fail)

This is the “one or two more modelling params” referenced in the requirement.

### 4.5 Forecasting settings: how Python gets them (and how parity is guaranteed)

The backend must have a deterministic, versioned settings input, otherwise fits are not reproducible.

**Requirement**: there is exactly one canonical source for forecasting settings used by Python fitting.

Two acceptable mechanisms (both can coexist, but one must be authoritative):

1. **Backend reads settings from disk**: Python loads `settings/settings.yaml` (or equivalent repo settings) at runtime.
   - Pros: one source; no API coupling.
   - Cons: needs deployment discipline (the backend bundle must include the settings file).

2. **Frontend includes settings in the recompute request**: Python accepts an explicit settings object and uses it for that job.
   - Pros: decouples the running backend from local filesystem.
   - Cons: request must include a stable settings signature and must not drift per user unless that is desired.

**Parity guarantee** is achieved by:

- Python being the master implementation for fitting and application.
- Persisting `settings_signature` with each model so analyses can be audited.
- A golden fixture suite for the pure maths layer (CDF/inverse/fit) to lock behaviour.

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
- `forecasting_settings` (optional): explicit settings object and/or settings signature

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
| Forecasting settings | FE service | ✅ Yes | Must be provided deterministically (backend authoritative load or request-supplied settings). |

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

To keep Python free of inference, the frontend must provide:

- The semantic subject identity: `param_id`, `core_hash`
- The semantic slice plan: `slice_keys[]`
- The query semantics:
  - mode: `'window' | 'cohort'` (or an equivalent explicit flag)
  - evaluation horizon / as-at or sweep range as required by the analysis read mode
- The scenario graph (already in request)

This is sufficient for Python to:

- Query the DB for evidence rows
- Select evidence by policy P1/P2/P3
- Fit models (when asked) and/or apply models (always during analysis)
- Return completeness and evidence/forecast outputs

---

## 7. Implementation Plan (Forecasting Phase)

### 7.1 Build the Python modelling library

- `lag_distribution_utils.py`: port pure maths (erf, Φ, Φ⁻¹, lognormal CDF/inverse, moment-fit).
- `forecasting_settings.py`: load settings and produce a stable `settings_signature`.
- `lag_model_fitter.py`: queries snapshot DB evidence and produces `model_v1`.
- `forecast_application.py`: computes completeness, projections, layers, fan chart points.

### 7.2 Add persistence fields on graph/parameter models

- Extend the TypeScript types (`LatencyConfig`) to include `model_v1` so the graph can store fitted model parameters.
- Extend YAML schema(s) / parameter file formats as needed.

### 7.3 Wire recompute into the product workflow

Two triggers:

- **Automatic**: after a successful fetch-from-origin job that writes new snapshot rows, call `/api/lag/recompute-models` for affected subjects (bounded set).
- **Manual**: a user action “Recompute lag models/horizons” that calls the same route for all latency edges.

### 7.4 Ensure we do not refit on DSL edits

- Query DSL changes should only affect application (which frames/anchor days are evaluated and displayed), not fitting.
- Fitting uses the training window policy, not the current query window.

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Behaviour drift between FE and BE | Low | High | Python is the single master; FE only persists and displays model outputs |
| Settings mismatch | Medium | High | Stable settings signature persisted per model; backend authoritative settings load policy |
| Insufficient DB evidence to fit | Medium | Medium | Quality gates + fallbacks; surface “quality_ok=false” and keep conservative defaults |
| Performance of bulk model recompute | Medium | Medium | Batch DB queries + dedup; recompute only for affected subjects; cache within request |

---

## 9. What `reads.md` Must Anticipate

The snapshot read path must support application-time forecasting outputs:

- `completeness` per anchor day (and per frame for cohort maturity)
- evidence/forecast split fields (`layer`, `projected_y`, etc.)
- fan chart support (future)

`SnapshotSubjectRequest` does **not** need to carry a full lag fit if the model is persisted on the graph (`edge.p.latency.model_v1`) and the backend is responsible for applying it.

---

## 10. References

- `lagDistributionUtils.ts` — Pure maths (frontend, current implementation)
- `statisticalEnhancementService.ts` — Orchestration (frontend, current)
- `constants/latency.ts` — Tuning constants (frontend, current)
- `2-time-series-charting.md` §2.3, §2.4, §5 — Forecast/fan chart requirements
- design.md §5 — LAG architecture specification
