# 29e — Generalised Forecast Engine: Implementation Plan

**Date**: 13-Apr-26
**Depends on**: doc 29 (design), doc 29c (Phase A), doc 29d (Phase B)
**Status**: Plan only. No code written for the engine itself. Phase A
infrastructure (v2 row builder, span kernel, x_provider) is
substantially implemented.

---

## Phasing Overview

```
Phase 0: Parity gates (v1 → v2)
Phase 1: Promoted model resolver
Phase 2: Window-mode ForecastState
Phase 3: Cohort-mode ForecastState (graph-wide topo pass)
Phase 4: Consumer migrations (surprise gauge, edge cards, beads)
Phase 5: cohort_maturity_v3 (clean-room engine consumer)
Phase 6: Parity and contract tests
Phase 7: Future enhancements (posterior covariance, asat projection)
```

Each phase has explicit entry gates, exit gates, and the files touched.

### HARD RULE: v2 is frozen

`cohort_forecast_v2.py` and its call sites (`_handle_cohort_maturity_v2`
in `api_handlers.py`) must not be modified. v2 is the parity reference
that all engine work tests against. This also applies to v2's
infrastructure: `cohort_forecast.py` (v1 carrier hierarchy),
`span_kernel.py`, `span_evidence.py`, `span_adapter.py`. All frozen
until v3 passes parity and v2 is retired (Phase 5.5).

If the engine cannot match v2's output, the engine is wrong — not v2.

---

## Phase 0: Parity Gates (v1 → v2)

**Purpose**: confirm Phase A is complete before building on it.

**Entry gate**: Phase A code exists (`cohort_maturity_v2` registered,
`cohort_forecast_v2.py` implemented, span kernel working).

### 0.1 Single-hop parity gate — PASSED 13-Apr-26 ✓

v1 vs v2 field-by-field on real graph data, window and cohort modes.
Tests in `test_doc31_parity.py` (`TestCohortMaturityV1V2Parity`).

**Exit gate**: ~~all parity assertions pass on at least two real graph
edges (one window, one cohort).~~ **PASSED.**

### 0.2 Multi-hop acceptance — parallel quality work

Run `cohort_maturity_v2` on multi-edge spans. Assert:
- Evidence parity across chain, branching, fan-in topologies
- Forecast convergence: τ→∞ produces rate→span_p
- Frontier conditioning: fan narrows at observed data, widens into
  future

**Files touched**:
- `graph-editor/lib/tests/` — new test file for multi-hop acceptance

**Exit gate**: multi-hop tests pass on at least one real multi-edge
path.

### 0.3 Promote v2 as default

Fix any issues surfaced by 0.1 and 0.2. Optionally rename
`cohort_maturity_v2` → `cohort_maturity` (or keep both with v2 as
default).

**Files touched**:
- `graph-editor/lib/runner/analysis_types.yaml`
- `graph-editor/lib/api_handlers.py` (dispatch logic, line ~623)
- `graph-editor/src/services/analysisTypeResolutionService.ts`
- `graph-editor/src/components/panels/analysisTypes.ts`

**Exit gate**: v2 is the default cohort maturity implementation.
v1 code retained as reference but not active.

---

## Phase 1: Promoted Model Resolver

**Purpose**: single Python-side resolver that returns best-available
model params with provenance. Prerequisite for all subsequent phases.

**Entry gate**: Phase 0 complete.

### 1.1 Define resolver interface

Pydantic model for resolver input and output:

```
Input:  edge, model_vars[], preference, scope (edge|path),
        temporal_mode (window|cohort)
Output: p (mean, stdev), latency (mu, sigma, onset + SDs),
        path-level equivalents, quality metadata, provenance
        (source, fitted_at, gate_passed)
```

**Files touched**:
- `graph-editor/lib/runner/` — new file `model_resolver.py`
- `graph-editor/lib/graph_types.py` — new Pydantic models if needed

### 1.2 Implement resolver

Unify logic from four current locations:
- `_read_edge_model_params()` in `api_handlers.py` (lines 1322–1550)
- `_resolve_promoted_source()` in `api_handlers.py` (lines 1287–1300)
- `read_edge_cohort_params()` in `cohort_forecast.py` (lines 176–284)
- `_resolve_completeness_params()` in `api_handlers.py` (lines
  1302–1320)

The resolver must:
- Accept scope (edge|path) × temporal_mode (window|cohort)
- Respect per-edge and graph-level `model_source_preference`
- Prefer Bayesian if quality-gated, then analytic_be, then analytic,
  then manual
- Return path-level params (path_mu, path_sigma, path_onset) when
  scope=path and they exist; fall back to edge-level

**Files touched**:
- `graph-editor/lib/runner/model_resolver.py` (new)
- `graph-editor/lib/api_handlers.py` — refactor
  `_read_edge_model_params` to call resolver
- `graph-editor/lib/runner/cohort_forecast.py` — refactor
  `read_edge_cohort_params` to call resolver
- `graph-editor/lib/runner/cohort_forecast_v2.py` — update imports

### 1.3 Tests

- Resolver returns identical params to `_read_edge_model_params` for
  all source types (analytic, analytic_be, bayesian, manual)
- Resolver respects scope: window → edge-level, cohort → path-level
- Resolver respects preference cascade
- Resolver handles missing model_vars gracefully

**Files touched**:
- `graph-editor/lib/tests/` — new test file `test_model_resolver.py`

**Exit gate**: resolver produces identical output to existing scattered
logic on real graph data. All four current call sites can be migrated
without behaviour change.

---

## Phase 2: Window-Mode ForecastState

**Purpose**: extract window-mode forecast computation into a reusable
function that produces `ForecastState`. Inject into BE topo pass.

**Entry gate**: Phase 1 complete (resolver available).

### 2.1 Define ForecastState contract

Pydantic model per doc 29 §ForecastState Contract:

```python
class ForecastState(BaseModel):
    edge_id: str
    source: str
    fitted_at: str
    tier: str  # 'fe_instant' | 'be_forecast'

    evaluation_date: str
    evidence_cutoff_date: str
    posterior_cutoff_date: str

    completeness: float
    completeness_sd: float

    rate_unconditioned: float
    rate_unconditioned_sd: float

    rate_conditioned: float
    rate_conditioned_sd: float
    tau_observed: int

    mode: str  # 'window' | 'cohort'
    path_aware: bool

    dispersions: Dispersions  # p_sd, mu_sd, sigma_sd, onset_sd

    trajectory: Optional[List[TrajectoryPoint]] = None
    resolved_params: Optional[ResolvedModelParams] = None
```

**Files touched**:
- `graph-editor/lib/runner/` — new file `forecast_state.py`
- `graph-editor/lib/graph_types.py` — Pydantic models
- `graph-editor/src/types/index.ts` — TypeScript mirror interface

### 2.2 Window-mode forecast function

Extract from `forecast_application.py` (`compute_completeness`,
`annotate_data_point`) + promoted resolver into:

```python
def compute_forecast_state_window(
    edge_id, resolved_params, evidence_cohorts,
    evaluation_date, evidence_cutoff_date, posterior_cutoff_date,
) -> ForecastState
```

Computation:
- `completeness` = n-weighted CDF across cohorts (existing formula)
- `completeness_sd` = sample from (mu ± mu_sd, sigma ± sigma_sd,
  onset ± onset_sd) using onset_mu_corr, evaluate CDF for each draw,
  take SD across draws
- `rate_unconditioned` = p × completeness
- `rate_unconditioned_sd` = sqrt((p × completeness_sd)² +
  (completeness × p_sd)²) — independence assumption (doc 29 §note)
- `rate_conditioned` = blend(evidence_rate, model_rate, completeness)
- `rate_conditioned_sd` = composed from all three uncertainty sources
- `tau_observed` = n-weighted age of cohorts

**Files touched**:
- `graph-editor/lib/runner/forecast_state.py` (new, continued)
- `graph-editor/lib/runner/forecast_application.py` — refactor
  `compute_completeness` to also return SD (or add companion function)

### 2.3 Inject into BE topo pass

After existing LAG fit + model vars upsert + promotion, call
`compute_forecast_state_window` for each edge in window mode. Return
`ForecastState` alongside existing `ModelVarsEntry` results.

**Files touched**:
- `graph-editor/lib/runner/stats_engine.py` — add ForecastState
  computation after `compute_edge_latency_stats`
- `graph-editor/lib/api_handlers.py` — `handle_stats_topo_pass` returns
  ForecastState per edge in response
- `graph-editor/src/services/beTopoPassService.ts` — consume
  ForecastState from BE response, write to `edge.p.forecast_state`
- `graph-editor/src/services/fetchDataService.ts` — pass
  ForecastState through Stage-2 orchestration

### 2.4 Tests

- ForecastState completeness matches existing
  `latency.completeness` within tolerance
- completeness_sd > 0 when mu_sd > 0
- rate_unconditioned_sd > rate_conditioned_sd at high completeness
  (evidence constrains)
- Mature-limit: tau→∞ produces completeness→1, rate→posterior mean

**Files touched**:
- `graph-editor/lib/tests/` — new `test_forecast_state_window.py`

**Exit gate**: BE topo pass returns ForecastState for window-mode
edges. Values consistent with existing computations. completeness_sd
is non-trivial (not always 0).

---

## Phase 3: Cohort-Mode ForecastState

**Purpose**: upstream-aware completeness computation in the BE topo
pass. This is the propagation engine scoped to ForecastState scalars.

**Entry gate**: Phase 2 complete.

### 3.1 Per-node arrival cache

Walk edges in topological order. At each node, accumulate arrival
state from all upstream edges:

```python
@dataclass
class NodeArrivalState:
    deterministic_cdf: List[float]   # weighted upstream CDF
    mc_cdf: Optional[np.ndarray]     # (S, T) if upstream has uncertainty
    reach: float                      # reach from anchor to this node
    evidence_obs: Optional[Dict]      # observations for IS conditioning
```

Cache keyed by node ID. Each outgoing edge reads its from-node's
cache as the x_provider.

**Files touched**:
- `graph-editor/lib/runner/forecast_state.py` — add
  `compute_forecast_states_graph` (graph-wide pass)
- `graph-editor/lib/runner/` — may factor into new
  `forecast_propagation.py` if too large

### 3.2 Cohort-mode forecast function

Port upstream carrier logic from `cohort_forecast_v2.py` (the
three-tier carrier: `_build_tier1_parametric`,
`_build_tier2_empirical`, `_build_tier3_weak_prior`,
`build_upstream_carrier`) into the graph-wide pass. The v2 code is
the reference — the engine reimplements the same computation reading
from the per-node cache rather than building from scratch per edge.

```python
def compute_forecast_state_cohort(
    edge_id, resolved_params, evidence_cohorts,
    node_arrival_state,  # from per-node cache
    evaluation_date, evidence_cutoff_date, posterior_cutoff_date,
) -> ForecastState
```

**Files touched**:
- `graph-editor/lib/runner/forecast_state.py` (continued)
- `graph-editor/lib/runner/forecast_propagation.py` (new, if needed)
- `graph-editor/lib/runner/stats_engine.py` — call graph-wide pass
  for cohort-mode edges

### 3.3 Inject into BE topo pass

The topo pass now runs two computations per edge:
- Window-mode edges: `compute_forecast_state_window` (Phase 2)
- Cohort-mode edges: `compute_forecast_state_cohort` (Phase 3)

Mode determination follows existing logic in `stats_engine.py`
(query_mode parameter from FE).

**Files touched**:
- `graph-editor/lib/runner/stats_engine.py`
- `graph-editor/lib/api_handlers.py` — `handle_stats_topo_pass`

### 3.4 Tests

- Cohort-mode completeness from engine matches v2 row builder's
  completeness at tau_observed (within tolerance — v2 uses MC, engine
  uses deterministic + SD)
- Per-node cache produces identical upstream CDF to v2's x_provider
  for adjacent edges
- Graph-wide pass on a 10-edge graph completes in <2s (performance
  baseline)

**Files touched**:
- `graph-editor/lib/tests/` — new `test_forecast_state_cohort.py`
- `graph-editor/lib/tests/` — new `test_forecast_propagation.py`

**Exit gate**: BE topo pass returns ForecastState for both window and
cohort-mode edges. Cohort-mode completeness is upstream-aware and
consistent with v2 chart output. Performance acceptable (<2s for
typical graphs).

---

## Phase 4: Consumer Migrations — ELIMINATED

**Status**: eliminated 14-Apr-26. The engine writes to existing graph
fields per doc 29 §Schema Change. Consumers already read those fields.
No `ForecastState` TS interface, no `forecast_state` sidecar on the
graph. The BE topo pass is a full upgrade of FE values — consumers
automatically get improved completeness, composed p_sd, and
completeness_stdev without any migration.

**Original purpose (no longer applicable)**: wire existing consumers
to read from ForecastState instead of computing independently.

### 4.1 Edge bead ± correction

Replace bead stdev sources:
- F mode: `p.forecast.stdev` → `forecast_state.rate_unconditioned_sd`
- F+E mode: `p.stdev` → `forecast_state.rate_conditioned_sd`
- E mode: unchanged (`p.evidence.stdev` is already correct)
- Completeness: bare "70%" → "70% ± 12%" from
  `forecast_state.completeness_sd`

**Files touched**:
- `graph-editor/src/components/edges/edgeBeadHelpers.tsx` —
  `getProbabilityBeadValueForLayer` (lines 414–453) reads from
  `forecast_state` when available
- `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts` —
  pass `forecast_state` fields through to edge render data

### 4.2 Edge display (chevron, quality tier)

- Completeness chevron: reads `forecast_state.completeness` instead
  of `latency.completeness`. Value may differ (promoted model,
  upstream-aware in cohort mode).
- Quality tier badge: show `forecast_state.tier` ('fe_instant' vs
  'be_forecast') alongside existing source badges.

**Files touched**:
- `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts` —
  `EdgeLatencyDisplay` construction (line ~679)
- `graph-editor/src/components/edges/ConversionEdge.tsx` — tier
  indicator rendering

### 4.3 Surprise gauge migration

Replace `_compute_surprise_gauge` (~400 lines in `api_handlers.py`)
with:
1. Call promoted resolver for the edge
2. Call `compute_forecast_state_window` or
   `compute_forecast_state_cohort` (depending on mode)
3. Read `rate_unconditioned ± rate_unconditioned_sd` as the expected
   baseline
4. Compare against observed rate
5. Surprise = (observed - expected) / rate_unconditioned_sd

The FE surprise gauge (`localAnalysisComputeService.ts`, ~250 lines)
becomes a fallback that reads `forecast_state` from the edge when
available, only computing independently when the BE hasn't responded.

**Files touched**:
- `graph-editor/lib/api_handlers.py` — rewrite
  `_compute_surprise_gauge` (lines 106–513)
- `graph-editor/src/services/localAnalysisComputeService.ts` —
  `buildSurpriseGaugeResult` reads from `forecast_state` when
  available (lines 918–1166)

### 4.4 Edge card / completeness overlay migration

Replace scattered completeness annotation in `api_handlers.py`
(~500 lines across `_handle_snapshot_analyze_subjects` and model
curve generation) with reads from the promoted resolver +
ForecastState.

**Files touched**:
- `graph-editor/lib/api_handlers.py` — annotation in
  `_handle_snapshot_analyze_subjects` (lines 2060–2086, 2111–2436)

### 4.5 Tests

- Parity: surprise gauge output with ForecastState matches existing
  output within tolerance
- Bead ± values change correctly per regime (E unchanged, F wider,
  F+E properly composed)
- Edge display completeness matches ForecastState.completeness

**Files touched**:
- `graph-editor/src/services/__tests__/localAnalysisComputeService.test.ts`
- `graph-editor/src/services/__tests__/buildScenarioRenderEdges.test.ts`
- `graph-editor/lib/tests/` — surprise gauge parity test

**Exit gate**: all consumers read from ForecastState. No consumer
independently computes completeness or rate from raw edge params.
Bead ± values are correct per regime. Surprise gauge parity passes.

---

## Phase 5: `cohort_maturity_v3`

**Purpose**: clean-room cohort maturity implementation that consumes
the forecast engine directly. v2 (1154 lines) is frozen as the parity
reference. v3 should be substantially smaller because the engine
handles completeness, carrier hierarchy, and model resolution.

**Entry gate**: Phase 3 complete. Engine functions available:
`build_node_arrival_cache`, `compute_forecast_state_cohort/window`,
`resolve_model_params`. Phase 4 eliminated (engine writes to existing
fields — no consumer migration needed).

### What v3 replaces

v2 reimplements completeness, carrier hierarchy, IS conditioning, MC
fan bands, and model resolution internally. v3 delegates all of that
to the engine and focuses solely on:

1. Assembling per-τ rows from evidence frames + engine output
2. Running MC fan bands using engine-resolved params
3. Epoch classification (solid/dashed/dotted regions)

### What v3 preserves (non-negotiable FE contract)

The FE chart builder (`buildCohortMaturityEChartsOption` in
`cohortComparisonBuilders.ts`) reads these fields per row. v3 must
emit the identical row schema:

| Field | Type | Meaning |
|-------|------|---------|
| `tau_days` | int | Age in days (X-axis) |
| `rate` | float? | Observed evidence rate y/x |
| `rate_pure` | float? | Pure evidence rate (only real obs) |
| `evidence_y`, `evidence_x` | float? | Raw observed counts |
| `projected_rate` | float? | Annotation projected rate |
| `forecast_y`, `forecast_x` | float? | Forecast counts |
| `midpoint` | float? | Bayesian posterior median (primary forecast) |
| `fan_upper`, `fan_lower` | float? | Default-level quantiles |
| `fan_bands` | dict? | Multi-level: `{'80': [lo,hi], '90': [lo,hi], ...}` |
| `model_midpoint` | float? | Prior median (unconditioned) |
| `model_fan_upper`, `model_fan_lower` | float? | Prior quantiles |
| `model_bands` | dict? | Prior multi-level bands |
| `tau_solid_max` | int | All cohorts present (epoch A boundary) |
| `tau_future_max` | int | Some cohorts present (epoch B boundary) |
| `boundary_date` | str | Sweep-to date |
| `cohorts_covered_base` | int? | Cohorts with obs at τ |
| `cohorts_covered_projected` | int? | Cohorts with projected data |

The response wrapper is also preserved:
`{subjects: [{subject_id, result: {maturity_rows, frames, span_kernel}}]}`

### 5.1 Register analysis type

`cohort_maturity_v3` registered FE + BE. Reuses existing ECharts
chart builder — row schema unchanged, so no FE chart code changes.

**Files touched**:
- `graph-editor/lib/runner/analysis_types.yaml` — new entry
- `graph-editor/lib/api_handlers.py` — new handler
  `_handle_cohort_maturity_v3` (dispatch only — delegates to v3 module)
- `graph-editor/src/services/analysisTypeResolutionService.ts` — register
- `graph-editor/src/components/panels/analysisTypes.ts` — register
- `graph-editor/src/lib/graphComputeClient.ts` — type registration,
  normalisation maps to same `cohort_maturity` response shape

### 5.2 v3 module: `cohort_forecast_v3.py`

New file. Target: under 400 lines (v2 is 1154).

**What v3 does**:

1. **Subject resolution and evidence framing** — reuses the existing
   `resolve_analysis_subjects` + `derive_cohort_maturity` +
   `compose_path_maturity_frames` pipeline (same as v2's handler).
   No reimplementation.

2. **Engine call** — for the target edge:
   - `resolve_model_params(edge, scope, temporal_mode)` → resolved params
   - `build_node_arrival_cache(graph, anchor_id)` → per-node arrival
   - For each τ in range:
     `compute_forecast_state_cohort(edge_id, resolved, [(τ, 1)], from_node)`
     → completeness at that τ
   - This replaces v2's `build_span_params` + `_cdf()` + carrier
     convolution (~300 lines)

3. **MC fan bands** — using resolved params from the engine:
   - Draw `(mu, sigma, onset)` from joint distribution (using
     `resolved.latency.mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`)
   - For each draw, evaluate CDF at each τ → per-draw CDF array
   - Draw `p` from Beta(alpha, beta) posterior
   - Per-τ rate draws = p_draw × CDF_draw(τ)
   - IS conditioning on frontier evidence (same as v2 lines 762-790)
   - Quantiles → `fan_bands`, `midpoint`, `fan_upper`, `fan_lower`
   - This replaces v2's MC section (~250 lines) but reuses the same
     maths — just reads params from the engine resolver instead of
     reimplementing the resolution cascade

4. **Evidence extraction** — from composed frames, extract per-τ:
   - `rate = y/x` (observed)
   - `evidence_y`, `evidence_x` (raw counts)
   - `cohorts_covered_base` (count with obs at τ)
   - Epoch boundaries from frame date range

5. **Row assembly** — combine evidence + engine completeness + MC
   fan bands into the row schema above. One row per τ.

**What v3 does NOT do** (delegated to engine):
- Model resolution (preference cascade, quality gates)
- Carrier hierarchy (Tier 1/2/3)
- Completeness computation (CDF evaluation, upstream convolution)
- Completeness SD (MC sampling from dispersions)
- Rate composition (p × completeness, SD propagation)

**Files touched**:
- `graph-editor/lib/runner/cohort_forecast_v3.py` — new file
- `graph-editor/lib/api_handlers.py` — `_handle_cohort_maturity_v3`

### 5.3 Parity gate (v2 → v3)

v3 must produce identical output to v2 for single-edge subjects on
the enriched synth graph (`synth-simple-abc`). Field-by-field
comparison of `maturity_rows`:

- `rate` — must match exactly (same evidence frames)
- `midpoint` — within 2% (MC sampling variance)
- `fan_bands` — within 5% per quantile (MC variance)
- `tau_solid_max`, `tau_future_max` — must match exactly
- `evidence_y`, `evidence_x` — must match exactly

Test uses the synth graph with DB data (same pattern as
`test_be_topo_pass_parity.py`).

**Files touched**:
- `graph-editor/lib/tests/test_v2_v3_parity.py` — new test file

### 5.4 Multi-hop acceptance

v3 on multi-edge spans (e.g. `synth-simple-abc` A→C via B). Same
acceptance criteria as Phase 0.2: v3 output is structurally valid
and quantitatively reasonable (not necessarily identical to v2 for
multi-hop, since v3 uses the engine's carrier convolution which
differs from v2's path-param approach by ~2%).

### 5.5 Retire v2

When v3 passes parity:
- Remove `cohort_forecast_v2.py` (1154 lines)
- Remove `_handle_cohort_maturity_v2` from `api_handlers.py`
- Remove `span_adapter.py` (transitional, 160 lines)
- Update FE type registrations to route `cohort_maturity` → v3 handler
- Update `analysis_types.yaml`
- Unfreeze `cohort_forecast.py`, `span_kernel.py`, `span_evidence.py`

**Exit gate**: v3 is the sole cohort maturity implementation. v2 code
deleted. All existing tests pass against v3. v3 is under 400 lines.

---

## Phase 6: Parity and Contract Tests

**Purpose**: comprehensive test suite proving the engine contract.

**Entry gate**: Phase 5 complete.

### Test plan

| Test | What it validates |
|------|-------------------|
| FE vs BE ForecastState parity (window) | FE instant completeness vs BE completeness — within tolerance |
| Mature-limit convergence | tau→∞: completeness→1, rate→posterior mean. Both modes. |
| Consumer parity | Surprise gauge expected-p = v3 unconditioned rate at tau_observed |
| Cohort-mode completeness convergence | Edge-display completeness = chart completeness for same edge |
| FE vs BE surprise gauge parity | Pre-retirement validation of FE fallback |
| Regime ± correctness | E: binomial. F: model + completeness. F+E: all three sources. |

**Files touched**:
- `graph-editor/lib/tests/` — new `test_forecast_engine_contract.py`
- `graph-editor/src/services/__tests__/` — new TS contract tests

**Exit gate**: all contract tests pass. Engine is the single source of
truth for completeness, rate, and dispersions.

---

## Phase 7: Future Enhancements

Not blocking any of the above. Each is independent.

### 7.1 Posterior covariance matrix

Emit 5×5 covariance matrix (p, mu, sigma, onset, kappa_lat) from
the Bayesian compiler. Store on edge. Forecast engine draws from
MVN(means, cov) instead of independent normals. Improves accuracy
of combined uncertainty by capturing p–mu anti-correlation.

**Files touched**:
- `bayes/compiler/inference.py` — extract covariance from trace in
  `summarise_posteriors`
- `bayes/compiler/types.py` — add `posterior_cov` field to
  `PosteriorSummary` / `LatencyPosteriorSummary`
- `bayes/worker.py` — emit covariance in patch output
  (`_build_unified_slices`)
- `graph-editor/src/services/bayesPatchService.ts` — read and store
  covariance on edge
- `graph-editor/src/types/index.ts` — add covariance field to
  posterior types
- `graph-editor/lib/runner/forecast_state.py` — use covariance for
  draws when available

### 7.2 asat() projection support

Full three-date model: evidence_cutoff, evaluation_date,
posterior_cutoff. asat > now produces forward projection with
uncertainty bands.

**Files touched**:
- `graph-editor/lib/runner/forecast_state.py` — date parameter
  handling
- `graph-editor/lib/runner/model_resolver.py` — historical posterior
  selection (consult fit_history)
- `graph-editor/src/services/posteriorSliceResolution.ts` —
  `resolveAsatPosterior` alignment

### 7.3 FE stats deletion

Once the engine is authoritative and all consumers migrated, the FE
topo pass (~3,830 lines in `statisticalEnhancementService.ts`) can
be reduced to a thin fallback. Three design decisions needed first
(D11, Pattern A, cohortsForFit — see v2 release plan §Fast-follow).

**Files touched**:
- `graph-editor/src/services/statisticalEnhancementService.ts`
  (3,830 lines — bulk deletion)
- `graph-editor/src/services/forecastingParityService.ts` (151 lines
  — no longer needed)

### 7.4 Cross-request caching

Cache per-node arrival state keyed by (graph_hash, query_mode,
date_range). Only pursue if performance profiling shows the graph-wide
pass is too slow for interactive use.

---

## Dependency Graph

```
Phase 0 (parity gates)              ✅
  │
  ▼
Phase 1 (promoted resolver)         ✅
  │
  ▼
Phase 2 (window-mode engine)        ⚠ partial — functions exist, not on shared codepath
  │
  ▼
Phase 3 (cohort-mode engine)        ⚠ partial — same
  │
  ▼
Phase 4 (consumer migrations)       ELIMINATED — engine writes to existing fields
  │
  ▼
Phase 5 (cohort_maturity_v3)        ✅ in progress — parity green 17/17
  │
  ▼
Phase G (codepath generalisation)   ← NEXT after Phase 5
  │  Unifies topo pass and chart onto shared engine primitives.
  │  v3 is the invariant reference; topo pass must call the same
  │  compute_forecast_trajectory function. See doc 29f §Phase G.
  │
  ▼
Phase 6 (contract tests)            Updated to assert same-function guarantee
  │
Phase 7.1–7.4 (enhancements) — independent, any time after Phase G
```

**Key insight (16-Apr-26)**: Phases 2–3 built `compute_forecast_state_window`
and `compute_forecast_state_cohort` as standalone functions, but neither
is called by any production codepath. The topo pass calls
`compute_forecast_summary` instead — a structurally different
function with different IS conditioning, different carrier fidelity,
and different rate semantics. Phase G replaces these with calls to the
same `compute_forecast_trajectory` that v3 uses, ensuring the graph display
and the chart cannot diverge.

---

## Surface Area Summary

### New files

| File | Phase | Purpose |
|------|-------|---------|
| `lib/runner/model_resolver.py` | 1 | Promoted model resolver |
| `lib/runner/forecast_state.py` | 2–3 | ForecastState contract + computation |
| `lib/runner/forecast_propagation.py` | 3 | Per-node arrival cache (if needed) |
| `lib/runner/cohort_forecast_v3.py` | 5 | Clean-room v3 row builder |
| `lib/tests/test_model_resolver.py` | 1 | Resolver tests |
| `lib/tests/test_forecast_state_window.py` | 2 | Window-mode tests |
| `lib/tests/test_forecast_state_cohort.py` | 3 | Cohort-mode tests |
| `lib/tests/test_forecast_propagation.py` | 3 | Propagation tests |
| `lib/tests/test_v2_v3_parity.py` | 5 | Parity gate |
| `lib/tests/test_forecast_engine_contract.py` | 6 | Contract tests |

### Modified files

| File | Lines | Phases | Nature of change |
|------|-------|--------|------------------|
| `lib/api_handlers.py` | 3,765 | 1,2,3,4,5 | Refactor parameter resolution; rewrite surprise gauge; add v3 handler |
| `lib/runner/stats_engine.py` | 1,429 | 2,3 | Add ForecastState computation after LAG fit |
| `lib/runner/forecast_application.py` | 228 | 2 | Add completeness_sd companion |
| `lib/runner/cohort_forecast.py` | 1,570 | 1 | Refactor `read_edge_cohort_params` to use resolver |
| `lib/runner/cohort_forecast_v2.py` | 1,154 | 1,5(delete) | Refactor imports; eventually deleted |
| `lib/runner/span_adapter.py` | 160 | 5(delete) | Deleted when v3 replaces v2 |
| `lib/runner/analysis_types.yaml` | ~50 | 0,5 | Register/rename analysis types |
| `src/types/index.ts` | 1,462 | 2 | ForecastState TypeScript interface |
| `src/services/beTopoPassService.ts` | 316 | 2,3 | Consume ForecastState from BE response |
| `src/services/fetchDataService.ts` | 2,489 | 2,3 | Pass ForecastState through Stage-2 |
| `src/services/localAnalysisComputeService.ts` | 1,167 | 4 | Read from ForecastState when available |
| `src/services/modelVarsResolution.ts` | 218 | 1 | Align with Python resolver |
| `src/components/edges/edgeBeadHelpers.tsx` | 1,063 | 4 | Read ± from ForecastState per regime |
| `src/components/canvas/buildScenarioRenderEdges.ts` | 819 | 4 | Pass ForecastState fields to edge |
| `src/components/edges/ConversionEdge.tsx` | ~2,500 | 4 | Tier indicator rendering |
| `src/services/analysisTypeResolutionService.ts` | ~200 | 0,5 | Type registration |
| `src/lib/graphComputeClient.ts` | 2,082 | 5 | Type registration for v3 |
| `lib/graph_types.py` | ~400 | 1,2 | Pydantic models |

### Deleted files (Phase 5)

| File | Lines | Reason |
|------|-------|--------|
| `lib/runner/cohort_forecast_v2.py` | 1,154 | Replaced by v3 |
| `lib/runner/span_adapter.py` | 160 | Transitional bridge no longer needed |

### Public documentation (user-facing)

Updates to `graph-editor/public/docs/` required alongside the code
changes. These explain the new forecasting behaviour to users.

| File | Phase | Change |
|------|-------|--------|
| `public/docs/lag-statistics-reference.md` | 4 | New section: generalised forecast engine. Explain completeness with uncertainty, three uncertainty regimes (E/F/F+E), what ± means in each. Update blend formula description to reference composed uncertainty. Explain two-tier FE/BE delivery and quality tier indicator. |
| `public/docs/forecasting-settings.md` | 2–3 | Update if new settings are introduced (e.g. completeness_sd sampling draws, blend regime controls). Explain how promoted model preference interacts with forecast quality. |
| `public/docs/glossary.md` | 4 | New terms: completeness uncertainty, evidence-conditioned forecast, promoted model source, forecast quality tier (fe_instant / be_forecast). Update existing completeness and forecast definitions to reference uncertainty. |
| `public/docs/user-guide.md` | 4 | New section or update to existing edge display section: what the ± on probability and completeness beads means, how to interpret the quality tier badge, what changes between E/F/F+E regimes. |
| `public/docs/CHANGELOG.md` | 6 | Release entry covering: generalised forecast engine, completeness uncertainty on edges, improved ± in F and F+E modes, two-tier forecast delivery, cohort maturity v3. |

### Codebase documentation (developer-facing)

| File | Phase | Change |
|------|-------|--------|
| `docs/current/codebase/STATISTICAL_DOMAIN_SUMMARY.md` | 2–3 | Update to reference ForecastState as the canonical forecast output. |
| `docs/current/codebase/FE_BE_STATS_PARALLELISM.md` | 2–3 | Update to describe ForecastState two-tier delivery alongside existing topo pass parallelism. |
| `docs/current/project-bayes/programme.md` | 6 | Update Steps 1–3 references to reflect implemented engine. |
| `docs/current/v2-release-plan.md` | 6 | Update Block 1 (forecast engine) status. |

### Files touched only in Phase 7 (future)

| File | Lines | Enhancement |
|------|-------|-------------|
| `bayes/compiler/inference.py` | 1,772 | 7.1: posterior covariance |
| `bayes/compiler/types.py` | 765 | 7.1: covariance field |
| `bayes/worker.py` | 2,149 | 7.1: emit covariance in patch |
| `src/services/bayesPatchService.ts` | ~500 | 7.1: store covariance |
| `src/services/posteriorSliceResolution.ts` | 336 | 7.2: asat alignment |
| `src/services/statisticalEnhancementService.ts` | 3,830 | 7.3: bulk deletion |
| `src/services/forecastingParityService.ts` | 151 | 7.3: deletion |
