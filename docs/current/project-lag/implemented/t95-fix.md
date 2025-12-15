# t95 Fix: Parameter-Level Overrides for `t95` and `path_t95`

Date: 12-Dec-25  
Updated: 15-Dec-25

## Purpose

We currently compute `t95` and `path_t95` automatically from fetched evidence and graph topology. This has two problems:

- The system can be systematically wrong in the presence of long-tail latency, especially on deeper paths.
- There is no simple, inspectable mechanism for a user to override the computed horizons when they know better.

This document specifies a simpler and more traceable model:

- `t95` and `path_t95` are treated as parameter-level fields with standard `*_overridden` companions.
- The system computes and writes derived values when not overridden.
- If the user overrides a value, downstream logic uses the override (no mixing of derived + manual).
- A global default is used for first fetches when neither derived values nor overrides exist.

## Relationship to Window/Cohort LAG Semantics

This proposal is part of a broader, conceptually integrated effort:

1. **Phase 1:** Correct and stabilise `window()` vs `cohort()` semantics per the canonical spec (`graph-editor/public/docs/lag-statistics-reference.md`), including:
   - baseline `window()` vs query `window(start:end)` separation,
   - evidence/forecast sourcing,
   - completeness semantics,
   - and defensible blending into `p.mean`.
2. **Phase 2 (this document):** Migrate horizon primitives away from `legacy maturity field` and towards **parameter-level, overridable** `t95` and `path_t95`, to improve:
   - horizon stability for heterogeneous edges (bounding/planning and external conversion windows),
   - traceability of horizons,
   - and user control when automated derivation is systematically wrong.

This document does not re-specify the LAG maths; it focuses on making the horizon primitives stable and inspectable.

### Phase 1 status (15-Dec-25)

Phase 1 (`window()`/`cohort()` semantics + regressions) is **complete and signed off** on 15-Dec-25 with a full `graph-editor` test suite run:

- 2567 passing
- 32 skipped
- 3 todo
- Total: 2602

### Baseline vs query windows (terminology alignment)

This proposal assumes (and should remain consistent with) the semantics work:

- **Baseline `window()`** (whole/pinned, typically ~90 days): the stable source of:
  - `p.forecast.*` baselines, and
  - lag-shape priors (`median` + `mean`) for distribution fitting.
- **Query `window(start:end)`**: the user-selected X-anchored cohorts used for:
  - `p.evidence.*` for the current view, and
  - window-mode completeness.
- **Query `cohort(anchor,start:end)`**: the user-selected A-anchored cohorts used for:
  - cohort-mode evidence, and
  - cohort-mode completeness (with upstream delay adjustment).

`t95/path_t95` are horizon primitives that support retrieval bounding and planning across these modes; they do not redefine these query semantics.

## Scope

This proposal covers:

- Data model (parameter schema + types)
- UpdateManager behaviour (how values flow between stored parameter data and the in-memory edge parameter view)
- Default injection and overwrite rules (how values are initialised and when they may be updated)
- Where in the application `t95` and `path_t95` are used (fetch planning, Amplitude conversion windows, LAG analytics)
- Tests and documentation updates required

This proposal is intentionally designed for the current test environment (single graph), with a focus on traceability and predictable behaviour.

## Terminology

- `t95`: the edge-local latency horizon (intended to approximate “95% of eventual converters have converted by this many days” for the edge’s conversion).
- `path_t95`: the cumulative latency horizon from the anchor to the end of the edge (used for downstream cohort horizons and for Amplitude conversion windows in cohort mode).
- “Parameter-level”: stored and versioned alongside the parameter’s time-series values (the same layer where `legacy maturity field` currently lives in practice).
- “Derived”: computed by the system from observed cohorts and model fitting.
- “Override”: user-supplied value that replaces the derived value for all downstream logic.

## High-level behaviour

### User workflow (target behaviour)

1. User enables latency tracking for an edge.
2. User may optionally specify:
   - edge `t95` (and mark it overridden), and/or
   - `path_t95` (and mark it overridden).
3. User fetches data.
4. On first fetch:
   - if no user overrides exist, the system falls back to a global default horizon (for cohort-mode conversion windows and retrieval bounds) until enough evidence exists to compute derived values.
5. On subsequent fetches:
   - the system computes derived `t95` and derived `path_t95` and writes them to the parameter data (only if not overridden).
6. User may later overwrite either value; from that point onward the system uses the override.

### Override semantics (no mixing)

`t95` and `path_t95` are treated as **single fields** that consumers read directly from the graph/parameter view.

The `*_overridden` flags do not introduce an “effective value” abstraction. Instead, they only control **whether the system is allowed to overwrite the stored values**:

- If `t95_overridden` is true, the system must not overwrite `t95` with derived values.
- If `path_t95_overridden` is true, the system must not overwrite `path_t95` with derived values.

This produces a simple rule for readers: if the field exists, it is authoritative. There is no blending between manual and derived values.

### Explicit separation: horizon primitives vs completeness

To avoid conceptual confusion:

- `t95` and `path_t95` are **horizon primitives** used for:
  - retrieval bounding / “how far back to fetch”,
  - conversion window construction for external APIs,
  - and stable horizon behaviour on long/heterogeneous edges.
- Completeness is still computed from lag CDF evaluation over cohort ages (and is mode-dependent as per the canonical spec).
  `path_t95` is not a substitute for upstream median delay; we do not invert percentiles into medians.

### Phase 2 simplification: delete “Formula A” (tail substitution) entirely

Phase 2 will delete the “Formula A / tail substitution” construct from the implementation.

`p.mean` will be computed via the canonical completeness-weighted blend of:

- narrow evidence (`p.evidence.*`) from the relevant query cohort set, and
- baseline forecast (`p.forecast.*`) from the pinned baseline `window()` slice,

with completeness computed from the lag CDF (with the Phase 2 “t95 tail constraint” applied where applicable).

### Phase 2 design note: tail-safe completeness CDF using `t95` (recommended)

We have identified a structural risk in the current system:

- `p.mean` blending depends on `p.latency.completeness`.
- `p.latency.completeness` depends on the latency CDF fit.
- A lognormal fit can be systematically wrong for fat/long-tailed edges, which can cause mis-blending (often: evidence is overweighted too early).

Phase 2 gives us a clean mitigation because `t95` becomes a persisted/overridable horizon:

- If a large baseline window (or a user override) indicates the edge tail is long, we should not permit a “thin tail” completeness CDF that contradicts that horizon.

**Proposed approach (simple, non-invasive):**

- Continue to fit the completeness CDF from baseline-window lag summaries (`median_lag_days`, `mean_lag_days`) as the primary shape signal.
- Additionally enforce a *tail constraint* so the fitted CDF is not more optimistic than the effective `t95`.

#### Precise specification: “t95 tail constraint” for completeness CDF

This is the design contract for Phase 2. It is deliberately simple: we only ever *inflate* tail weight (never deflate it), because the core failure mode we are correcting is **thin-tail optimism** on fat-tailed edges.

**Inputs (per edge, per context slice family):**

- `median_lag_days` (baseline window summary; required for meaningful fit)
- `mean_lag_days` (baseline window summary; optional)
- `t95_days` (the authoritative horizon):
  - if `t95_overridden` is true: use the stored overridden value
  - else: use the stored derived value (written from baseline-window evidence)
- `LATENCY_T95_PERCENTILE` (single constant defining the meaning of “t95”)

**Output:**

- A lognormal distribution parameterisation used for **completeness CDF evaluation**:
  - `mu` and `sigma` for `CDF_X_to_Y(t)`

**Algorithm:**

1. Compute the base fit (moment fit):
   - `mu = ln(median_lag_days)`
   - `sigma_moments`:
     - if `mean_lag_days` is valid: `sigma_moments = sqrt(2 * ln(mean_lag_days / median_lag_days))`
     - else: `sigma_moments = LATENCY_DEFAULT_SIGMA`
2. Compute the minimum sigma needed to honour the horizon:
   - `z = NormalInverseCDF(LATENCY_T95_PERCENTILE)` (a positive constant for 0.95)
   - `sigma_min_from_t95 = ln(t95_days / median_lag_days) / z`
3. Apply the tail constraint:
   - `sigma = max(sigma_moments, sigma_min_from_t95)`

**Guard rails:**

- If `t95_days` is missing/invalid: do not apply the constraint.
- If `median_lag_days` missing/invalid: fall back to existing defaults (constraint cannot be applied).
- If `t95_days <= median_lag_days`: do not apply the constraint (it would imply a degenerate/contradictory tail).
- Clamp any computed sigma to a sane maximum if needed for numerical stability (implementation detail).

**How this affects completeness:**

- Completeness is computed via `p.latency.completeness = Σ n[d] * CDF_X_to_Y(effective_age[d]) / Σ n[d]`.
- The tail constraint can only make `sigma` larger (or unchanged).
- For young cohorts/windows this makes `CDF_X_to_Y(t)` smaller and therefore reduces completeness.
- That directly reduces the evidence weight in blending (because blend uses `n_eff = completeness * n_query`), preventing the “overweight evidence too early” failure mode on fat tails.

**Semantics note (critical):**

- This does **not** create a second meaning for `t95`.
- `t95` remains a horizon primitive for bounding/planning and for external conversion windows.
- The tail constraint simply prevents the completeness CDF from contradicting the authoritative horizon.

#### Why this is “using the data we have”

When `t95` is derived (not overridden), it represents what the wide baseline window evidence implies for the tail horizon under the system’s current fitting approach. When it is overridden, it represents user knowledge about the tail. In either case, the system must not then use a completeness CDF whose implied `t95` is *smaller* than that authoritative horizon.


## Data model changes

### New/standardised fields (parameter-level)

The following fields are treated as parameter-level fields (persisted in the parameter data backing an edge’s `p.latency` view):

- `t95`
- `t95_overridden`
- `path_t95`
- `path_t95_overridden`

### Latency enablement (single-pass migration)

Latency enablement must be explicit, independent of numeric horizons, and consistent across the stack. We will implement this as a **single-pass migration** (no phased approach):

- Introduce a new boolean field `latency_parameter` that indicates whether a parameter-backed edge probability is latency-tracked.
- Add `latency_parameter_overridden` so the graph↔file mapping can follow the standard override pattern (the flag is required even for booleans).
- Treat `t95` and `path_t95` as the only numeric latency horizons (each with an `*_overridden` companion).
- Perform a repo-wide audit of **every** usage of `legacy maturity field` and replace it with one of:
  - `latency_parameter` (for enablement checks),
  - `t95` / `path_t95` (for horizon usage), or
  - the global default `t95` (only during default injection when enabling latency).

After the migration, `legacy maturity field` should no longer be used as an enablement marker or a horizon input anywhere in the application logic.

## Computation and write-back rules

### Derived `t95`

Derived `t95` continues to be computed from cohort evidence via the existing fitting logic and quality gates.

Important context:

- Baseline `window()` slices are expected to be wide (typically ~90 days) and provide stable lag-shape summaries (`median` + `mean`) for many edges.
- Cohort selections (especially “last week”) are often immature; empirical cohort lag signal may be sparse.
- `t95` should therefore be treated as the *canonical horizon* once introduced, so the system can remain stable even when empirical lag data is weak.

Additional clarity:

- Because baseline windows are wide, `t95` derivation should prioritise stability and tail safety over responsiveness to very narrow/immature cohort selections.
- User overrides exist precisely for the “heterogeneous long tail” scenario where automated derivation is systematically wrong.

Write-back policy:

- If `t95_overridden` is true, do not overwrite `t95`.
- Else, write the derived `t95` into the parameter data (and therefore into the edge parameter view).

### Derived `path_t95`

Derived `path_t95` continues to be computed in the current fashion:

- It may be computed via topological accumulation and/or via anchor-aware estimation when the necessary anchor lag evidence exists.
- The computed result is written into the parameter data as `path_t95`.

Write-back policy:

- If `path_t95_overridden` is true, do not overwrite `path_t95`.
- Else, write the derived `path_t95`.

Clarification:

- `path_t95` is primarily for retrieval bounding and cohort-vs-window targeting.
- It is not used as a proxy for upstream median delay in completeness calculations.

### Default injection (first enablement)

We must avoid ad-hoc fallback chains across the codebase. To achieve that, when a user enables latency on an edge (`latency_parameter = true`), the system must ensure a conservative default exists immediately:

- If `t95_overridden` is false and `t95` is missing or invalid, set `t95` to the global conservative default of 30 days.
- `path_t95` will then be computed from the graph using the existing `path_t95` accumulation logic over per-edge `t95` values. This means that before the first fetch, `path_t95` is derived from defaults (and becomes more accurate after data-driven derivation writes improved values).

After this default injection, downstream consumers should read `t95` and `path_t95` directly without local fallbacks.

## Application impact areas

### Amplitude `window()` conversion window (avoid accidental censoring)

Although `cs` (conversion window) is most obviously associated with `cohort()` mode, we also require a **fixed conversion window** for `window()` queries when retrieving baseline window slices from Amplitude.

Rationale:

- Baseline `window()` slices are the stable source for lag-shape summaries and horizon derivation (including `t95`).
- If we do not specify a conversion window for `window()` queries, we risk accidentally using a provider default that censors long journeys.
- That would systematically bias baseline lag summaries and therefore any derived `t95` (especially for fat/long-tailed edges).

Requirement (Phase 2 design):

- All `window()` queries sent to Amplitude must set `cs` to a **constant 30 days**.
- To avoid proliferating constants, this should use the same value as the global default horizon:
  - `DEFAULT_T95_DAYS = 30`

This is a retrieval-safety policy only; it does not change the meaning of `t95/path_t95` as horizon primitives.

## Repo-wide audit: current read/write sites

This section inventories **all current code sites** where `legacy maturity field`, `t95`, and `path_t95` are written and read.

Notes:

- A “write” means the value is assigned (direct assignment, object literal construction, or UpdateManager applying computed values onto the graph parameter view).
- A “read” means the value is consulted to decide behaviour (planning, refetch, query construction, analytics, UI).
- Tests are listed separately so we can update them deterministically during the migration.

### `legacy maturity field` (current)

- **Writes (production)**
  - **`graph-editor/src/services/UpdateManager.ts`**: bidirectional mapping between graph `p.latency.legacy maturity field` and stored parameter latency (`latency.legacy maturity field`), including override flag wiring.
  - **`graph-editor/src/lib/das/buildDslFromEdge.ts`**: writes `queryPayload.cohort.legacy maturity field` (used as Amplitude `cs` by the adapter).
  - **`graph-editor/src/services/dataOperationsService.ts`**: constructs/threads the cohort object which contains `legacy maturity field` (via `queryPayload.cohort` passthrough).
  - **`graph-editor/src/lib/das/types.ts`**: defines the cohort payload field `legacy maturity field` (write surface at the DAS boundary).
- **Reads (production)**
  - **`graph-editor/src/constants/statisticalConstants.ts`**: single source of truth for all LAG/statistical constants (percentiles, quality gates, horizon buffers, refetch cooldowns, etc.). This file currently contains some of these; Phase 2 will consolidate all remaining ones into it.
  - **`graph-editor/src/services/fetchRefetchPolicy.ts`**: enablement and maturity/refetch decisions use `latencyConfig.legacy maturity field` (and prefer `t95` when present).
  - **`graph-editor/src/services/statisticalEnhancementService.ts`**: used as a fallback contributor in `computePathT95()` when `t95` is absent.
  - **`graph-editor/src/services/cohortRetrievalHorizon.ts`**: used as a fallback horizon input.
  - **`graph-editor/src/services/windowAggregationService.ts`**: cohort/window aggregation and related logic references `legacy maturity field` in LAG-related pathways.
  - **`graph-editor/src/services/paramRegistryService.ts`**: parameter value typing/fields include cohort-related latency structures where `legacy maturity field` appears.
  - **`graph-editor/src/services/windowFetchPlannerService.ts`**: includes `legacy maturity field` in the `GraphForPath` representation used for on-demand `path_t95` computation.
  - **`graph-editor/src/services/fetchDataService.ts`**: includes `legacy maturity field` in the `GraphForPath` representation used for `path_t95` computation and application.
  - **`graph-editor/src/services/dataOperationsService.ts`**: checks `legacy maturity field` to decide whether latency tracking is enabled for policy decisions.
  - **`graph-editor/src/components/edges/ConversionEdge.tsx`**: UI-only heuristic fallback (uses `legacy maturity field` when median lag display is missing).
  - **`graph-editor/src/components/ParameterSection.tsx`**: latency config display/edit surface (reads the latency config block including `legacy maturity field`).
  - **`graph-editor/src/services/GraphParamExtractor.ts`**: extracts latency config fields from edge parameters for downstream consumption.
  - **`graph-editor/src/services/integrityCheckService.ts`**: includes latency fields in integrity checks/diagnostics.
- **Writes/Reads (adapter + schemas + Python)**
  - **`graph-editor/public/defaults/connections.yaml`**: reads `cohort.legacy maturity field` to set Amplitude `cs` (seconds).
  - **`graph-editor/dist/defaults/connections.yaml`**: built copy of the adapter config (do not edit directly; update source in `public/`).
  - **`graph-editor/public/param-schemas/parameter-schema.yaml`**: defines `legacy maturity field` in the schema.
  - **`graph-editor/dist/param-schemas/parameter-schema.yaml`**: built copy (do not edit directly; update source in `public/`).
  - **`graph-editor/public/schemas/conversion-graph-1.0.0.json`**, **`graph-editor/public/schemas/conversion-graph-1.1.0.json`**: include latency/maturity shape.
  - **`graph-editor/dist/schemas/conversion-graph-1.0.0.json`**, **`graph-editor/dist/schemas/conversion-graph-1.1.0.json`**: built copies (do not edit directly; update source in `public/`).
  - **`graph-editor/lib/graph_types.py`**: Python model includes `legacy maturity field` (+ overridden flag) and documents its current enablement semantics.
  - **`graph-editor/lib/runner/graph_builder.py`**: extracts and emits `legacy maturity field` in latency payloads.
  - **`graph-editor/public/ui-schemas/parameter-ui-schema.json`** and **`graph-editor/dist/ui-schemas/parameter-ui-schema.json`**: UI schema surfaces `legacy maturity field`.
- **Reads (documentation)**
  - **`graph-editor/public/docs/glossary.md`**
  - **`graph-editor/public/docs/lag-statistics-reference.md`**
- **Reads (bundled artefacts)**
  - **`graph-editor/dist/assets/index-CWQR91N3.js`**: built bundle; do not edit directly (source lives in `src/`).
- **Tests**
  - **`graph-editor/src/services/__tests__/fetchRefetchPolicy.test.ts`**
  - **`graph-editor/src/services/__tests__/fetchRefetchPolicy.branches.test.ts`**
  - **`graph-editor/src/services/__tests__/fetchMergeEndToEnd.test.ts`**
  - **`graph-editor/src/services/__tests__/fetchPolicyIntegration.test.ts`**
  - **`graph-editor/src/services/__tests__/mergeTimeSeriesInvariants.test.ts`**
  - **`graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`**
  - **`graph-editor/src/services/__tests__/allSlicesSimulation.test.ts`**
  - **`graph-editor/src/services/__tests__/pathT95Computation.test.ts`** (via fallback behaviour)
  - **`graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortAnchor.test.ts`** (documentation + scenarios)
  - **`graph-editor/src/lib/das/__tests__/amplitudeThreeStepFunnel.integration.test.ts`**
  - **`graph-editor/src/services/__tests__/addEvidenceAndForecastScalars.test.ts`**
  - **`graph-editor/src/services/__tests__/cohortRetrievalHorizon.test.ts`**
  - **`graph-editor/src/services/__tests__/sampleFileQueryFlow.e2e.test.ts`**
  - **`graph-editor/lib/tests/test_lag_fields.py`**

### `t95` (current)

- **Writes (production)**
  - **`graph-editor/src/services/statisticalEnhancementService.ts`**: computes derived `t95` as part of the LAG pipeline and emits it in edge latency outputs.
  - **`graph-editor/src/services/UpdateManager.ts`**: applies computed `latency.t95` into `edge.p.latency.t95`.
  - **`graph-editor/src/services/dataOperationsService.ts`**: logs/threads `t95` as part of latency config diagnostics during fetch planning and bounded cohort logic.
- **Reads (production)**
  - **`graph-editor/src/constants/statisticalConstants.ts`**: single source of truth for all LAG/statistical constants (including the `t95` percentile and any related gates/buffers after consolidation).
  - **`graph-editor/src/services/fetchRefetchPolicy.ts`**: prefers `t95` over `legacy maturity field` for refetch maturity cutoffs.
  - **`graph-editor/src/services/statisticalEnhancementService.ts`**: used as a component for `path_t95` accumulation and for downstream path calculations.
  - **`graph-editor/src/services/cohortRetrievalHorizon.ts`**: used as a fallback horizon input when `path_t95` is absent.
  - **`graph-editor/src/services/windowFetchPlannerService.ts`**: includes `t95` in `GraphForPath` when computing `path_t95` on demand.
  - **`graph-editor/src/services/fetchDataService.ts`**: includes `t95` in `GraphForPath` when computing and applying `path_t95`.
  - **`graph-editor/src/lib/das/buildDslFromEdge.ts`**: fallback chain for cohort conversion window consults `t95`.
  - **`graph-editor/src/services/dataOperationsService.ts`**: consults `t95` in horizon decisions and diagnostics.
  - **`graph-editor/src/components/edges/ConversionEdge.tsx`** and **`graph-editor/src/components/canvas/buildScenarioRenderEdges.ts`**: latency-aware UI rendering can consult `t95` depending on available display data.
  - **`graph-editor/src/services/GraphParamExtractor.ts`**: extracts latency fields including `t95`.
- **Writes/Reads (schemas + Python)**
  - **`graph-editor/public/param-schemas/parameter-schema.yaml`**: defines `t95` in the schema.
  - **`graph-editor/dist/param-schemas/parameter-schema.yaml`**: built copy (do not edit directly; update source in `public/`).
  - **`graph-editor/lib/graph_types.py`**: includes `t95` in the Python latency model.
  - **`graph-editor/lib/runner/graph_builder.py`**: extracts and emits `t95` in latency payloads.
- **Reads (documentation)**
  - **`graph-editor/public/docs/glossary.md`**
  - **`graph-editor/public/docs/lag-statistics-reference.md`**
  - **`graph-editor/docs/current/update-problems.md`**
- **Reads (bundled artefacts)**
  - **`graph-editor/dist/assets/index-CWQR91N3.js`**: built bundle; do not edit directly (source lives in `src/`).
  - **`graph-editor/dist/schemas/conversion-graph-1.0.0.json`**, **`graph-editor/dist/schemas/conversion-graph-1.1.0.json`**: built copies.
- **Tests**
  - **`graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`**
  - **`graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`**
  - **`graph-editor/src/services/__tests__/fetchMergeEndToEnd.test.ts`**
  - **`graph-editor/src/services/__tests__/fetchPolicyIntegration.test.ts`**
  - **`graph-editor/src/services/__tests__/windowAggregationService.test.ts`**
  - **`graph-editor/src/services/__tests__/pathT95Computation.test.ts`**
  - **`graph-editor/src/services/__tests__/batchFetchE2E.comprehensive.test.ts`**
  - **`graph-editor/src/services/__tests__/addEvidenceAndForecastScalars.test.ts`**
  - **`graph-editor/src/services/__tests__/cohortRetrievalHorizon.test.ts`**
  - **`graph-editor/src/services/__tests__/sampleFileQueryFlow.e2e.test.ts`**
  - **`graph-editor/lib/tests/test_lag_fields.py`**

### `path_t95` (current)

- **Writes (production)**
  - **`graph-editor/src/services/statisticalEnhancementService.ts`**: computes/sets `path_t95` in the LAG pass (including topo accumulation and the anchor+edge estimation path) and can apply it onto graph edges.
  - **`graph-editor/src/services/fetchDataService.ts`**: computes and applies topo `path_t95` onto in-memory edges after fetch pipelines.
  - **`graph-editor/src/services/UpdateManager.ts`**: applies computed `latency.path_t95` into `edge.p.latency.path_t95`.
  - **`graph-editor/src/services/dataOperationsService.ts`**: may select between “moment-matched estimate” and “graph.path_t95” for bounded cohort windows (diagnostics include both).
- **Reads (production)**
  - **`graph-editor/src/constants/statisticalConstants.ts`**: single source of truth for all LAG/statistical constants (including the `path_t95` percentile after consolidation).
  - **`graph-editor/src/lib/das/buildDslFromEdge.ts`**: uses `edge.p.latency.path_t95` as the primary input to cohort conversion windows (Amplitude `cs`).
  - **`graph-editor/src/services/windowFetchPlannerService.ts`**: reads `edge.p.latency.path_t95` or computes it on demand for bounded cohort planning.
  - **`graph-editor/src/services/cohortRetrievalHorizon.ts`**: uses `path_t95` as the primary horizon input for bounding.
  - **`graph-editor/src/services/dataOperationsService.ts`**: uses `path_t95` (and/or the moment-matched estimate) for cohort bounding and for diagnostics in session logs.
  - **`graph-editor/src/services/fetchDataService.ts`**: uses existing `path_t95` where present (persisted vs computed) when applying and logging.
  - **`graph-editor/src/services/GraphParamExtractor.ts`**: extracts latency fields including `path_t95`.
- **Writes/Reads (schemas + Python)**
  - **`graph-editor/public/param-schemas/parameter-schema.yaml`**: schema includes latency fields; `path_t95` is present in the latency block type definitions.
  - **`graph-editor/dist/param-schemas/parameter-schema.yaml`**: built copy (do not edit directly; update source in `public/`).
  - **`graph-editor/dist/schemas/conversion-graph-1.1.0.json`**: built copy references `path_t95`.
  - **`graph-editor/lib/graph_types.py`**: includes `path_t95` in the Python latency model.
  - **`graph-editor/lib/runner/graph_builder.py`**: extracts and emits `path_t95` in latency payloads.
- **Reads (documentation)**
  - **`graph-editor/public/docs/CHANGELOG.md`**
  - **`graph-editor/public/docs/glossary.md`**
  - **`graph-editor/public/docs/lag-statistics-reference.md`**
  - **`graph-editor/docs/current/update-problems.md`**
- **Reads (bundled artefacts)**
  - **`graph-editor/dist/assets/index-CWQR91N3.js`**: built bundle; do not edit directly (source lives in `src/`).
- **Tests**
  - **`graph-editor/src/services/__tests__/pathT95Computation.test.ts`**
  - **`graph-editor/src/services/__tests__/cohortHorizonIntegration.test.ts`**
  - **`graph-editor/src/services/__tests__/cohortModeSimpleEdgeOverride.e2e.test.ts`**
  - **`graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`**
  - **`graph-editor/src/services/__tests__/windowFetchPlannerService.test.ts`**
  - **`graph-editor/src/services/__tests__/fetchDataService.test.ts`**
  - **`graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortAnchor.test.ts`**
  - **`graph-editor/src/services/__tests__/cohortRetrievalHorizon.test.ts`**
  - **`graph-editor/lib/tests/test_lag_fields.py`**

### Types

Update TypeScript types so the latency block contains both values and override flags.

Impacted area:

- `graph-editor/src/types/index.ts` (and any shared latency types used by services)

### Parameter schema

Update the parameter YAML schema so these fields are valid, persisted, and round-trip cleanly.

Impacted area:

- `graph-editor/public/param-schemas/parameter-schema.yaml`

### UpdateManager

UpdateManager must treat these fields as standard graph-mastered/parameter-backed fields with override flags:

- Read them from stored parameter data into the edge parameter view.
- Write derived values back into the parameter data unless overridden.
- Ensure the override flags prevent write-back overwrites.

Impacted area:

- `graph-editor/src/services/UpdateManager.ts`

### LAG computation pipeline

The statistical computation must:

- compute derived `t95` and derived `path_t95` as it does today, but
- avoid silently overriding user overrides.

Consumers should read the stored fields directly.

Impacted areas:

- `graph-editor/src/services/statisticalEnhancementService.ts`
- `graph-editor/src/services/fetchDataService.ts` (path computation application step)

### Fetch planning and refetch policy

Places that currently use `legacy maturity field`, `t95`, or `path_t95` must be updated to use:

- `t95` for edge-local maturity/refetch decisions.
- `path_t95` for cohort bounding decisions that depend on anchor-to-edge horizons.

Impacted areas:

- `graph-editor/src/services/fetchRefetchPolicy.ts`
- `graph-editor/src/services/windowFetchPlannerService.ts`
- `graph-editor/src/services/cohortRetrievalHorizon.ts`
- `graph-editor/src/services/dataOperationsService.ts`

### Amplitude cohort-mode conversion window (`cs`)

The Amplitude adapter uses `cohort.legacy maturity field` to construct `cs`. The application sets `queryPayload.cohort.legacy maturity field` during query payload build.

We must ensure cohort-mode `cs` is driven by an effective, overridable horizon:

- use `path_t95` if present and valid
- otherwise fall back to `t95`
- otherwise fall back to the global default `t95` (which should exist due to default injection on enablement)

Impacted area:

- `graph-editor/src/lib/das/buildDslFromEdge.ts`

### UI / editing controls

This proposal requires a user-accessible way to set and clear overrides.

Minimum UI requirements:

- Allow the user to input numeric `t95` and/or `path_t95` values.
- Provide a clear “override on/off” toggle per value (setting a value should set the override flag; clearing should unset).
- Provide a “revert to derived” action that clears the override flag and allows the system to write derived values again.

Impacted areas (exact components to be confirmed by implementation):

- the edge properties editor (latency section)
- any “advanced” properties panel where parameter-backed edge fields are edited

## Operational and analytical semantics

### What these values are used for

- `t95` is used as an edge-local maturity horizon and as a component in derived `path_t95`.
- `path_t95` is used for:
  - cohort-mode conversion windows (Amplitude `cs`)
  - cohort retrieval bounding / “how far back to fetch”
  - downstream latency-aware analytics requiring anchor-to-edge horizons

### What these values are not

Overrides are a user policy tool. An overridden value should not be presented or logged as a purely empirical estimate.

## Defaults and first-fetch behaviour

Define a single global default `t95` used at latency enablement time:

- When `latency_parameter` is enabled and `t95` is not overridden and missing, set `t95` to the default immediately.
- `path_t95` will be computed from the graph using the current `t95` values, so it will naturally build from defaults until the first fetch provides enough evidence to write improved derived values (unless overridden).

The default should be documented and centrally defined (single source of truth) so it is consistent across fetch planning and query construction.

## Tests

Update/add tests that prove:

- If `*_overridden` is true, derived computation does not overwrite the stored value.
- Default injection occurs when latency is enabled (and does not occur when overridden).
- Amplitude cohort-mode `cs` uses `path_t95` (or `t95` fallback) and does not reintroduce `legacy maturity field` fallbacks.
- Cohort bounding uses `path_t95` consistently.

Expected impacted test areas:

- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/pathT95Computation.test.ts`
- `graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortAnchor.test.ts`
- integration tests covering fetch planning + bounded windows (planner → DAS call chain)

## Rollout plan (single pass)

This change should be executed as a single coherent migration so we do not miss any `legacy maturity field` usage.

Required steps:

- Add the new boolean `latency_parameter` field (plus `latency_parameter_overridden`) to the parameter schema and shared types.
- Implement the override fields (`t95_overridden`, `path_t95_overridden`) and the overwrite-gating rules.
- Implement default injection for `t95` on latency enablement.
- Update UpdateManager to:
  - write derived values only when not overridden, and
  - honour the override flags consistently.
- Replace every `legacy maturity field` reference across the application:
  - identify whether each call site is enablement, horizon selection, refetch policy, or UI-only,
  - migrate it to `latency_parameter` and/or `t95` / `path_t95` as appropriate,
  - delete any remaining fallback semantics that accidentally treat `legacy maturity field` as a horizon or enablement flag.
- Update UI editing controls to set/clear overrides.
- Update and add tests for the new enablement flag and override precedence.

## Non-goals

- Replacing the existing statistical fitting approach in this change.
- Implementing new probability models for long-tail behaviour.
- Multi-graph migration concerns (out of scope for the current test environment).


