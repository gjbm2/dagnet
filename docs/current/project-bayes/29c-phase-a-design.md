# Phase A — Multi-Hop Cohort Maturity: Span Kernel

**Date**: 9-Apr-26
**Status**: Design + implementation plan
**Depends on**: Docs 30 (regime selection, implemented), 31 (BE subject
resolution, implemented)
**Companion docs**:
- Phase B design: `29d-phase-b-design.md`
- Operator algebra + stress tests: `29b-span-kernel-operator-algebra.md`
  (live companion — 16 stress cases verifying (L) latency and (M) mass
  across all topologies, plus the DAG-cover planner design)

---

## 1. What Phase A Does

Phase A fixes the conditional x→y progression — the numerator of the
multi-hop maturity rate. It does not change the denominator model.

**One sentence**: given arrivals at x, compute how those arrivals
progress to y across the full downstream DAG, including branching and
joins.

### What Phase A does NOT do

- Does not change how X_x(τ) (arrivals at x) is estimated
- Does not introduce a new upstream propagation engine
- Does not replace the current cohort-maturity sampler (D/C
  decomposition, frontier conditioning, MC fan bands)

Phase B addresses the denominator. Phases 0–6 generalise the forecast
engine for all consumers (surprise gauge, edge cards, overlays).

---

## 2. Notation

| Symbol | Meaning |
|--------|---------|
| **a** | **Anchor node** — defines cohort identity. Cohort dates anchored here. |
| **x** | **Query start node** — `from()` in the DSL. Denominator. Often x = a. |
| **y** | **Query end node** — `to()` in the DSL. Numerator. |
| **u** | **Last edge's source node** — node upstream of the final edge into y. In single-edge code, u = x. In multi-hop, u ≠ x. Only appears in legacy code references. |

---

## 3. Problem Decomposition

The multi-hop maturity rate is:

```
rate(s, τ) = Y_y(s, τ) / X_x(s, τ)
```

This decomposes into two independent problems:

| | Problem | Phase A approach |
|---|---------|-----------------|
| **Numerator** Y_y | Conditional x→y progression | New span kernel K_{x→y}(τ) via DP over subject DAG |
| **Denominator** X_x | Arrivals at x | Existing estimate (a_pop when x = a; carry-forward when x ≠ a) |

### Mode truth

- **window() mode**: Phase A is the full fix. X_x is constant (fixed
  at observation time). The span kernel is the only new work.
- **cohort() mode, x = a**: Phase A is the full fix. X_x = a_pop for
  all τ (trivially correct).
- **cohort() mode, x ≠ a**: Phase A is a numerator fix. The
  denominator uses observed x to the frontier, then carry-forward.
  This is an approximation resolved by Phase B.

---

## 4. Operator Abstraction

Every available piece is represented as one operator type:

```
Operator(s, t, f(τ), F(τ), metadata)
```

- `f(τ)` = sub-probability density on discrete tau grid
- `F(τ) = Σ_{u≤τ} f(u)` = sub-probability CDF
- `F(∞) < 1` encodes leakage (no special handling needed)
- Interpretation: "given unit mass at s, what mass reaches t by age τ?"

**Sources**:

| Source | Notation | Density |
|--------|----------|---------|
| Window() edge posterior | `W(u→v)` | `f(τ) = p · pdf(τ; onset, mu, sigma)` |
| Fitted cohort() macro-block | `C[a \| s→t]` | `f(τ) = p_path · pdf(τ; path_onset, path_mu, path_sigma)` |

**Composition algebra** (two operations only):

- **Serial** (at shared node m): `f_{s→t} = f_{s→m} * f_{m→t}` (convolution). Asymptotic: `F(∞) = F_{s→m}(∞) · F_{m→t}(∞)`.
- **Parallel** (routes merge): `f_{s→t} = Σ_r f_r`. Asymptotic: `F(∞) = Σ_r F_r(∞)`.

Numerical implementation: discrete convolution on integer tau grid
(0..max_tau). O(max_tau²) per serial composition.

---

## 5. Subject Regime: x→y Span Kernel

### 5.1 Definition

K_{x→y}(τ) = P(reach y by age τ | arrived at x at age 0)

This is a sub-probability CDF. K_{x→y}(∞) = conditional probability
of ever reaching y given arrival at x.

### 5.2 Per-edge sub-probability density

Each edge e_i has:

```
f_i(τ) = p_i · pdf_i(τ; onset_i, mu_i, sigma_i)
```

Where pdf_i is the shifted-lognormal latency density, p_i is the edge
conversion probability. F_i(∞) = p_i.

### 5.3 Computation: node-level DP

**Do not enumerate paths.** Use forward DP in topological order:

1. Topological sort nodes reachable from x that can reach y
2. Initialise: `g_x(τ) = δ(τ=0)` (unit impulse at x)
3. For each node v in topological order after x:
   `g_v(τ) = Σ_{edges u→v} (g_u * f_{u→v})(τ)`
   where `*` is discrete convolution
4. Result: `g_y` is the combined kernel density f_{x→y}
5. Accumulate: `K_{x→y}(τ) = Σ_{t≤τ} g_y(t)`

This naturally handles:
- **Branching**: fan-out produces multiple g values; they sum at
  convergence nodes
- **Fan-in**: multiple incoming edges contribute to g_v via summation
- **Leakage**: encoded in per-edge p_i (F_i(∞) < 1)
- **Single hop**: degenerates to K(τ) = p · CDF(τ)

Complexity: O(|E| · max_tau²). For typical |E| ≈ 2–10 and
max_tau ≈ 200–400, trivially fast.

### 5.4 SpanKernel interface

```python
compose_span_kernel(graph, x_node_id, y_node_id, is_window, max_tau) → SpanKernel
```

SpanKernel provides:
- `K(τ) → float`: kernel CDF at tau
- `span_p: float`: asymptotic K(∞)
- `tau_grid: array`: discrete tau values

### 5.5 Numerator formula

```
Y_y(s, τ) = Σ_u ΔX_x(s, u) · K_{x→y}(τ − u)
```

The convolution is with K (the CDF, not the density). K_{x→y}(τ − u)
is the probability that an arrival at x at age u has reached y by
age τ — a cumulative quantity. The product is the expected count of
those arrivals that have reached y. Summing over u gives cumulative
arrivals at y.

In window() mode, ΔX_x is a delta at τ=0:
`Y_y(s, τ) = X_x(s) · K_{x→y}(τ)`.

---

## 6. Upstream Regime: x_provider

### 6.1 Contract

`x_provider(s, τ) → float` returns estimated cumulative arrivals at x
for cohort s at age τ.

The x_provider must return arrivals **at x** (query start), not at u
or any other node. Feeding arrivals at u into K_{x→y} would
double-apply the x→u portion. This is a correctness requirement.

### 6.2 Phase A implementation

**x = a** (common case): `x_provider(s, τ) = a_pop(s)` for all τ.
Trivially correct. No modelling needed.

**x ≠ a, window() mode**: `x_provider(s, τ) = x_observed(s)` (fixed
count from evidence frame). Correct.

**x ≠ a, cohort() mode**:
- Observed region (τ ≤ tau_observed): actual x_at_x from composed
  evidence frames
- Forecast region (τ > tau_observed): carry forward last observed x.
  Approximation: assumes x is mostly mature by tau_observed.

### 6.3 Upstream latency carrier (for informational display)

When x ≠ a and the chart needs to show how x grows with τ (cohort
mode), the temporal shape comes from:

1. Aligned cohort-mode blocks on edges entering x (ingress blocks
   carry a→x path latency). If x has fan-in, form p-weighted CDF
   mixture. This is what the current code does.
2. If ingress blocks unavailable: fall back to edge-wise convolution
   through the upstream DAG (same DP as §5.3, applied to G_up).

Phase A uses approach 1 (ingress blocks) which matches current code.

### 6.4 Upstream mass policy (Phase A)

Phase A uses Policy A: `reach(a→x) × F_{a→x}(τ)`.

This is only relevant for x ≠ a cohort mode in the forecast region
(carry-forward). The reach scalar and CDF shape come from the existing
code (`reach_at_from_node`, `upstream_path_cdf_arr`).

Phase B will introduce Policy B: evidence-driven upstream propagation
where k(τ) evidence exists across the fully recursed upstream
sub-graph, falling back to Policy A where evidence is incomplete.

---

## 7. Evidence Frame Composition

### 7.1 compose_path_maturity_frames()

Given per-edge frames from `derive_cohort_maturity()`, compose
span-level evidence.

**Denominator carrier rule**:
- x = a: use `a` (anchor population) from any edge's frames
- x ≠ a: use `x` field from any edge incident to x. If values differ,
  take maximum (most complete observation). No singular "first edge"
  required.

**Numerator extraction**: From y-incident edge(s), extract `y` per
(anchor_day, snapshot_date). Sum across edges if fan-in at y.

**Composition**: For each (anchor_day, snapshot_date), emit
`rate = y_at_y / x_at_x` in the same frame schema as
`derive_cohort_maturity` output.

**Join alignment**: Both edges' frames derive from snapshots retrieved
on the same dates. Daily interpolation ensures alignment on
(anchor_day, snapshot_date).

**Topologies**: Correct for branching at x, fan-in at y, and all
intermediate structures. Evidence composition is exact — no model
approximations.

### 7.2 Regime coherence (doc 30)

Per-edge regime selection (doc 30) guarantees one coherent regime per
(edge, anchor_day, retrieved_at). Different edges in the span need not
use the same regime. No cross-edge enforcement needed.

---

## 8. Row Builder Restructuring

### 8.1 Current state

`compute_cohort_maturity_rows` currently:
1. Resolves edge_params → mu/sigma/p/SDs
2. Computes x forecast: reach(u) × CDF_upstream(τ)
3. Projects y from x using single-edge p × CDF(τ)
4. Applies D/C decomposition, frontier conditioning, MC fan

### 8.2 Phase A change

**New operators, same sampler.** Replace only the inner inputs (items
1–3). Preserve the outer forecasting discipline (item 4).

The row builder receives:
- `x_provider(s, τ)` — arrivals at x
- `span_kernel` — K_{x→y}(τ)
- Composed evidence frames — actual (x_obs, y_obs) per cohort

For each cohort s:
1. Get X_x(s, τ) from x_provider
2. Use observed (x_obs, y_obs) up to tau_observed (from evidence)
3. Split immature region into D (frontier survivors) and C (future
   arrivals)
4. For D: conditional late-conversion using span kernel shape
   `q_late(τ) = (K(τ) − K(tau_obs)) / (1 − K(tau_obs))`
5. For C: model-predicted mass via ΔX_x convolved with K (no
   Binomial noise on future arrivals)
6. Combine, clip y ∈ [0, x], preserve monotonicity
7. MC fan: draw posterior rate + latency-shape samples, forecast per
   draw, aggregate quantiles

### 8.3 Evidence/forecast boundary

- **Observed region** (τ ≤ tau_observed): actual (x, y) from composed
  evidence frames. No model used.
- **Forecast region** (τ > tau_observed): operator model (x_provider +
  span kernel) with frontier conditioning.
- **Frontier**: Bayesian update of prior using observed (x, y) at
  tau_observed. Posterior predictive for the forecast.

### 8.4 Frontier conditioning

**Prior**: Last edge's `posterior_path_alpha/beta`. Matches v1 for
adjacent pairs. Approximate for multi-hop (reflects a→y rate, not x→y
rate when x ≠ a).

**Update**: `α_post = α₀ + y_obs`, `β_post = β₀ + (x_obs − y_obs)`.

**In-transit approximation**: Treats all x-arrivals not yet at y as
failures. Same as v1. Conservative bias (underestimates rate). Larger
effect for multi-hop. Completeness-adjusted update is a future
improvement.

**Empty evidence**: Pure unconditional forecast, no conditioning.
Matches v1 behaviour when no snapshots exist.

### 8.5 MC uncertainty

**Rate uncertainty**: from prior alpha/beta (§8.4). Draw from
Beta(α_post, β_post).

**Latency-shape uncertainty**: Last edge's path-level SDs
(bayes_path_mu_sd, etc.). Underestimates span uncertainty. Per-draw
reconvolution is a future improvement.

---

## 9. Implementation Strategy

### 9.1 New analysis type

Register `cohort_maturity_v2` as a new analysis type:
- Full FE+BE per adding-analysis-types checklist
- Reuse `cohort_maturity` ECharts builder (same chart shape)
- BE handler initially clones existing pipeline
- CLI: `graph-ops/scripts/analyse.sh --type cohort_maturity_v2`

### 9.2 Implementation sequence

| Step | What | Depends on | Risk |
|------|------|-----------|------|
| **A.0** | Register `cohort_maturity_v2` — full FE+BE. Clone existing BE handler. | — | Low |
| **A.1** | `compose_path_maturity_frames()` — evidence composition. All topologies. Canonical denominator carrier rule. | — | Medium |
| **A.2** | `compose_span_kernel()` — node-level DP. Per-edge sub-probability densities. All topologies incl. branching. | — | Medium |
| **A.3** | Extract x_provider + restructure row builder. Preserve D/C decomposition, frontier conditioning, sampling discipline, MC fan. | A.0, A.1, A.2 | High |
| **A.4** | **Single-hop parity gate**: v1 vs v2, field-by-field, real data. | A.3 | Gate |
| **A.5** | **Multi-hop tests**: evidence parity + forecast convergence + frontier conditioning + sampling discipline | A.1–A.3 | Gate |

### 9.3 Acceptance criteria

1. **Adjacent-pair parity**: v2 on single-edge `from(x).to(y)` =
   v1 output, field by field.

2. **Multi-hop parity** (all topologies): evidence and forecast
   consistent with manual per-edge composition, including branching
   and fan-in.

3. **x_provider extraction**: v2's x_provider(s, τ) returns identical
   values to v1's internal x computation for the same inputs.

4. **x_provider correctness**: x = a returns a_pop; x ≠ a returns
   observed then carry-forward; convolution Y_y = ΔX_x * K produces
   correct unconditional forecast.

5. **Sampling-discipline parity**: For adjacent pairs, v2 preserves
   observed/forecast splice, D/C decomposition, no Binomial noise on
   future-arrival mass, and fan-band behaviour matching v1.

---

## 10. Known Approximations

All inherited from or analogous to current single-edge code. None
block adjacent-pair parity.

| # | Approximation | Effect | Future fix |
|---|--------------|--------|------------|
| 1 | Frontier conditioning treats in-transit arrivals as failures | Conservative bias; larger for multi-hop | Completeness-adjusted exposure |
| 2 | Prior α₀/β₀ from last edge's path alpha/beta | Matches v1 for adjacent; approximate for multi-hop | Method-of-moments from span_p |
| 3 | MC latency SDs from last edge's path-level values | Underestimates span uncertainty | Per-draw reconvolution |
| 4 | x carry-forward when x ≠ a | Only affects uncommon case | Phase B propagation |

---

## 11. Appendix: Legacy Key Set (Transitional)

During the transition from the existing row builder to the new
composition layer, the SpanKernel may need to provide a legacy-
compatible dict for code paths not yet refactored. This is
**transitional** — the target interface is K(τ), span_p, tau_grid.

Keys sourced from `_read_edge_model_params` (`api_handlers.py` lines
760–880), consumed at lines 390–418 of `cohort_forecast.py`:

**Edge-level**: `mu`, `sigma`, `onset_delta_days`, `forecast_mean`,
`posterior_p`, `posterior_alpha`, `posterior_beta`, `p_stdev`,
`bayes_mu_sd`, `bayes_sigma_sd`, `bayes_onset_sd`,
`bayes_onset_mu_corr`, `t95`, `evidence_retrieved_at`.

**Path-level**: `path_mu`, `path_sigma`, `path_onset_delta_days`,
`posterior_p_cohort`, `posterior_path_alpha`, `posterior_path_beta`,
`p_stdev_cohort`, `bayes_path_mu_sd`, `bayes_path_sigma_sd`,
`bayes_path_onset_sd`, `bayes_path_onset_mu_corr`, `path_t95`.

The row builder selects edge-level or path-level based on `is_window`
(lines 393–418). Once refactored to use SpanKernel directly, these
legacy keys are no longer needed.

---

## 12. Key Code References

| Component | Current location |
|-----------|-----------------|
| Row builder | `cohort_forecast.py:compute_cohort_maturity_rows()` (line 325) |
| Edge params | `api_handlers.py:_read_edge_model_params()` (line 760) |
| Reach computation | `path_runner.py:calculate_path_probability()` |
| Upstream CDF | `cohort_forecast.py` lines 765–780 |
| Evidence derivation | `cohort_maturity_derivation.py:derive_cohort_maturity()` |
| Path structure resolution | `graph_select.py` (doc 31, implemented) |
| Regime selection | `snapshot_regime_selection.py` (doc 30, implemented) |
