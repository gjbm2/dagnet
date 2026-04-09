# 29 — Generalised Forecast Engine Design

**Date**: 7-Apr-26  
**Status**: Design reasoning (pre-implementation)

## Motivation

Cohort maturity does a more sophisticated job at estimating forecast and uncertainty than e.g. surprise gauge. We want to generalise the relevant components to allow generalised forecasting across the app — edge cards, overlays, surprise gauge, cohort maturity, and future consumers should all draw from a single forecast engine rather than maintaining parallel implementations.

---

## Assessment of Proposed Steps

### Step 1: Canonical backend forecast-state contract

**Current state**: There is no unified `ForecastState` type. The closest thing is `ModelVarsEntry` (probability + latency + quality + provenance), but it is a *parameter* record, not a *forecast state* record. Cohort maturity returns raw frames (anchor_day, x, y, rate, tau). Surprise gauge returns variables (quantile, sigma, zone). These are disjoint schemas.

**Assessment**: This is the right first move. The proposed fields (observed/forecast x/y, tau_observed, completeness, posterior slice identity, uncertainty summary, provenance) represent the *intermediate representation* that both consumers need but neither currently produces in a reusable form. Today `cohort_forecast.py` computes these internally (e.g. `tau_solid_max`, `tau_future_max`, `x_at_tau`, completeness via CDF) but emits chart-specific rows. Surprise gauge computes its own completeness-adjusted expectation from model_vars. **The contract should sit between "raw snapshot frames + posterior" and "chart-specific output".**

**Risk**: Getting the contract wrong forces all consumers to work around it. The contract must be *descriptive* (what the data says) not *prescriptive* (how to render it). Specifically: do not bake in tau bucketing or rate vs count mode — those are display concerns.

**Recommendation**: Define this in Python (Pydantic) first since the backend is authoritative. The TS mirror follows. Include: per-cohort observed trajectory, per-cohort model trajectory, epoch boundaries (tau_solid_max, tau_future_max), completeness profile c(tau), posterior identity (slice_key, source, fitted_at), and provenance flags. Do *not* include fan bands or zones — those are consumer-specific transformations of the state.

---

### Step 2: Unify basis resolution

**Current state**: Basis resolution is scattered across three places:

- `posteriorSliceResolution.ts` — hardcoded rule: edge ← window(), path ← cohort()
- `beTopoPassService.ts` — sends `lagSliceSource` to BE
- `cohort_forecast.py` `read_edge_cohort_params()` — its own resolution cascade (cohort posterior → window posterior → forecast mean)

**Assessment**: Correct and important. `read_edge_cohort_params()` re-implements basis resolution with a different priority order than `posteriorSliceResolution.ts`. The FE and BE each have their own notion of "which posterior do I use". Unifying this removes a class of subtle divergence bugs (e.g., FE uses window alpha/beta while cohort_forecast uses path_alpha/path_beta for the same edge).

**Risk**: The resolution logic is *intentionally* different in some cases — `read_edge_cohort_params` prefers path-level posteriors because cohort maturity needs a-anchored parameters, while surprise gauge compares against the slice-matched posterior. A naive unification might force one semantic where two are needed.

**Recommendation**: The unified resolver should accept a `scope` parameter (`edge` | `path`) and a `temporal_mode` (`window` | `cohort`) and return the resolved parameters with provenance. Both cohort_forecast and surprise_gauge then call the same resolver with different scope arguments. This preserves the semantic distinction while eliminating the duplicated cascade logic.

---

### Step 3: Split the maths into reusable layers

**Proposed split**:

- **Frontier state** → surprise gauge
- **Trajectory state** → cohort maturity
- **Scalar summaries** → edge cards / overlays

This maps well to actual data dependencies:

- **Scalar layer**: p, mu, sigma, onset, completeness at a single tau (or aggregated). This is what surprise gauge and edge cards need.
- **Trajectory layer**: p(tau), completeness(tau), observed vs forecast over tau range. This is what cohort maturity needs.
- **Frontier layer**: where tau_observed sits relative to the trajectory — the "how much do we know?" question. Both consumers need this but extract different things from it.

**Risk**: Over-abstraction. If these layers are thin wrappers around `forecast_rate()` and `compute_completeness()`, they add indirection without value. They are only worth it if they encapsulate non-trivial logic (MC sampling, epoch boundary detection, carry-forward) that would otherwise be duplicated.

**Recommendation**: The scalar layer is genuinely reusable today — extract `evaluate_forecast_at_tau(edge_params, tau) → {rate, completeness, uncertainty}` from `cohort_forecast.py`. The trajectory layer is cohort_maturity-specific for now; do not prematurely generalise it until a second consumer exists. The frontier layer (tau_observed, epoch boundaries) should be part of the forecast-state contract from Step 1.

---

### Step 4: Finish unresolved cohort() maths before broad reuse

**Assessment**: This remains the most important gate, but a few earlier notes
need correcting against the current implementation.

**Already true in code**:

- Epoch B carry-forward is implemented in `cohort_forecast.py` via dense
  `obs_x` and `obs_y` arrays, then reused by the evidence line, midpoint, and
  fan.
- The old recursive reach traversal defects are resolved on the primary Bayes
  path: the code now uses `calculate_path_probability()` plus an explicit
  `anchor_node_id` when available.
- The post-frontier arrival term no longer uses an "ultimate-rate" shortcut.
  The current `Y_C` term already multiplies by the tau-dependent model rate
  `p × CDF(τ)`.

**Known approximations** (potential enhancements, not blockers — see
`cohort-maturity/INDEX.md` for full pros/cons analysis of each):

1. **Graph-wide x(s,τ) propagation is not implemented**. The current code
   uses a subject-edge local shortcut. This works well for typical linear
   funnels but does not model upstream immaturity. *Enhancement, not required
   for current use cases or x→y maturity.*

2. **`Y_C = X_C × model_rate` is still heuristic**. Uses tau-dependent rate
   but applies it to cumulative arrivals rather than convolving with
   arrival-time distribution. *Second-order effect for most funnels; needs
   mathematical design work before implementation.*

3. **Mixed probability bases remain in the denominator model**. `reach` and
   the upstream CDF mixture may use different posterior bases. *Small effect
   in practice; best addressed as part of the unified basis resolver.*

4. **Frontier semantics are consumer-specific**. Cohort maturity uses
   per-Cohort `tau_observed`; surprise gauge uses aggregate completeness.
   *Only relevant when building the shared forecast engine contract.*

5. ~~**Primary-path and fallback-path anchoring differ**.~~ **RESOLVED
   (7-Apr-26)**: The no-Bayes fallback now resolves and passes
   `anchor_node_id`, matching the primary path.

**Recommendation**: these are accuracy and architecture improvements, not hard
gates. The forecast-state contract (Phase 0) and x→y maturity (Phase A) can
proceed without resolving any of them. When the generalised engine is built
(Phases 2–4), items 1–3 should be addressed as part of that work. Item 4
is needed only when the shared contract is designed.

---

### Step 5: Make the backend authoritative

**Current state**: The FE/BE parallelism doc describes a 3-phase transition:

- Phase 1 (current): parallel run, FE wins
- Phase 2: FE visible but BE authoritative
- Phase 3: FE deleted, BE promoted

Surprise gauge has *both* a FE implementation (`localAnalysisComputeService.ts`, ~250 lines) and a BE implementation (`api_handlers.py`, lines 103–510).

**Assessment**: Correct. The FE surprise gauge is ~250 lines of duplicated statistical logic. It exists because the BE was not ready when surprise gauge shipped. Now that the BE implementation exists, the FE should become a thin renderer. This aligns with the broader Phase 2→3 transition.

**Risk**: The FE fallback is valuable when the Python server is down (e.g., local development, offline mode). Killing it entirely removes resilience.

**Recommendation**: Keep the FE as a *fallback* but mark it clearly as degraded mode (which it already does with the ⚠ warning). The generalised forecast engine lives in Python; the FE consumes its output. Do not maintain two semantic implementations — maintain one implementation and one fallback that is known-stale.

---

### Step 6: Parity and contract tests

**Assessment**: Essential and correctly sequenced last. The specific test gaps identified are real:

1. **FE vs BE surprise gauge parity**: Currently no test compares FE `localAnalysisComputeService` output against BE `_compute_surprise_gauge` output for identical inputs. This is the highest-priority gap — without it, you cannot retire the FE implementation.

2. **Mature-limit convergence**: As tau → ∞, completeness → 1, and the forecast should converge to the posterior mean. This is an analytical invariant that should hold for both window and cohort mode. No test currently verifies this.

3. **Join/split tests for cohort-mode x**: When a branching node has multiple outgoing edges, the cohort-mode x values must sum correctly (Dirichlet constraint). No test currently verifies this at the forecast level.

4. **retrieved_at and asat frontier tests**: `resolveAsatPosterior()` has specific semantics around date boundaries. The cohort_forecast's tau_observed derivation from `evidence_retrieved_at` should agree with this.

5. **Consumer parity on shared payload**: If cohort_maturity and surprise_gauge both consume the same forecast-state contract, feeding them identical inputs should produce consistent scalar summaries (e.g., surprise gauge's expected-p should equal cohort_maturity's forecast rate at tau_observed).

**Recommendation**: Write tests 1 and 5 first — they validate the contract. Tests 2–4 validate the maths (Step 4). Test design should use real graph data from the data repo, not synthetic fixtures, per the testing standards.

---

## Original Sequencing (superseded — see revised sequencing below)

The original sequencing assumed the forecast engine generalisation
happens first. The revised sequencing (after the x→y traversal section)
inserts Phases A and B before the engine generalisation.

---

## Generalised Cohort Maturity (x→y Traversal)

**Added**: 7-Apr-26 | **Rewritten**: 8-Apr-26

### Notation

Throughout this section:

| Symbol | Meaning |
|--------|---------|
| **a** | **Anchor node** — the graph entry point that defines cohort identity. Cohort dates are anchored here. |
| **x** | **Query start node** — the `from()` node in the DSL. Denominator of the maturity rate. Often x = a. |
| **y** | **Query end node** — the `to()` node in the DSL. Numerator of the maturity rate. |
| **u** | **Last edge's source node** — the node immediately upstream of the final edge into y. In the current single-edge implementation, u = x. In multi-hop, u ≠ x. |

These are four distinct concepts. The current code conflates x, a, and
u because for a single adjacent edge they are often the same node. The
multi-hop generalisation requires distinguishing them.

### The two problems

The multi-hop maturity question — "of cohorts entering at x, what
fraction reached y by age τ?" — contains two mathematically distinct
sub-problems:

**Problem 1 — the x→y span kernel** (conditional progression):
Given arrival at x, what is the probability of reaching y by age τ?
This is a numerator problem. It does not exist today for multi-hop.

**Problem 2 — the x estimate** (denominator model):
How many cohort members have arrived at x by age τ? The current row
builder already estimates this via `reach(u) × CDF_upstream(τ)`. This
estimate exists and works, but is tuned for u (the last edge's source),
not for x (the query start).

**Phase A fixes the conditional x→y progression. Phase A does not
change the denominator model. Phase B replaces the denominator model.**

This split is correct because:
- It isolates the real numerator problem — the x→y span logic is what
  doesn't exist today.
- It avoids turning one fix into a full graph-propagation rewrite.
- It works cleanly in window() mode and improves cohort() mode
  immediately.
- It gives a stable seam: Phase B can swap in a better x provider
  without rewriting the x→y logic.

### Mode truth

- **In window() mode**, Phase A is the full fix. The denominator x is
  flat (fixed at observation time), so the existing x estimate is
  trivially correct. The span kernel is the only new work.
- **In cohort() mode**, Phase A is a numerator fix over a legacy
  denominator. The y forecast correctly models multi-hop progression,
  but the x forecast still uses the single-edge denominator model
  (reach to u, not reach to x). This is acceptable for the common
  case where x = a (reach = 1.0), but is a known limitation when
  x ≠ a. Phase B fixes this.

### Why multi-hop maturity comes first

1. **Immediate user value.** "Of the cohort that entered at x, what
   fraction reached y?" is a concrete question with a well-defined
   answer.

2. **The evidence part is exact.** Snapshot data for all edges already
   exists in the DB. Cross-edge composition at the frame level requires
   no new maths.

3. **Building multi-hop first creates the consumer that validates the
   forecast-state contract.** The contract from Phase 0 must serve both
   single-edge and multi-hop. Building the consumer first exposes gaps.

### What cohort maturity for x→y means (first principles)

**Definition**: For a group of cohorts anchored at dates d₁..dₙ, the
path maturity curve plots:

```
r(τ) = Σᵢ yᵢ(τ) / Σᵢ xᵢ(τ)
```

Where:
- `yᵢ(τ)` = arrivals at y observed by age τ for cohort i
- `xᵢ(τ)` = arrivals at x for cohort i (fixed in window mode, growing
  in cohort mode)
- τ = days since cohort anchor date

The denominator is **arrivals at x** (the query start node), not
arrivals at u (the last edge's source node). The numerator is
**arrivals at y** (the query end node), which equals `y` on the last
edge(s) into y.

**Relationship to edge-level maturity**: When x and y are adjacent
(single edge), this reduces to the current implementation (`y/x` on
the single edge x→y). The generalisation replaces the single-edge
denominator with arrivals at x (from x-incident edges), and the
single-edge numerator with arrivals at y (from y-incident edges).

**Parallel paths**: If multiple routes exist from x to y (e.g.
x→B→D→y and x→C→D→y), the numerator includes arrivals at y via all
routes. This is correct: `r(τ)` answers "what fraction of x-entrants
reached y by age τ", regardless of route.

### What already works

| Component | Status |
|-----------|--------|
| **Scope rule** (`funnel_path`) | Already finds all edges on any x→y path via BFS |
| **Snapshot retrieval** | Already fetches snapshots for every in-scope edge independently |
| **Per-edge maturity derivation** | `derive_cohort_maturity()` produces frames from one edge's snapshots |
| **Chart rendering** | Row schema (tau_days, rate, midpoint, fan_upper, fan_lower) is edge-agnostic — works unchanged |
| **Epoch planning** | Already handles sweep epochs per subject |

### What needs to change

#### Layer 1: Path structure resolution (post-doc-31: BE-native)

Docs 30+31 are implemented. The BE resolves path structure natively
from the DSL string via `graph_select.py`. The BE knows which edges
are in scope, which edges are incident to x, and which edges are
incident to y. No FE path-resolution changes
needed.

#### Layer 2: Evidence frame composition

Given per-edge frames from `derive_cohort_maturity()`, compose
span-level evidence:

1. **Denominator extraction**: Extract arrivals at x per (anchor_day,
   snapshot_date). **Canonical rule for the denominator carrier**:
   - When x = a (common case): use `a` (anchor population) from any
     edge's frames — all edges share the same `a` per cohort.
   - When x ≠ a: use the `x` field from any edge incident to x. All
     edges leaving x measure arrivals at x, so they should agree. If
     they differ (due to regime selection or data gaps), take the
     maximum — it represents the most complete observation.
   - Note: there is no single "first edge" when x has multiple
     outgoing edges (branching at x). The rule above handles this
     without requiring a singular first edge.

2. **Numerator extraction**: From the last edge(s)' frames, extract
   `y` per (anchor_day, snapshot_date). This is arrivals at y. If
   multiple edges feed into y, sum their `y` values.

3. **Composition**: For each (anchor_day, snapshot_date), compute
   `rate = y_at_y / x_at_x`. Emit a composed frame with the same
   schema as `derive_cohort_maturity` output.

4. **Join key alignment**: Both edges' frames are derived from
   snapshots retrieved on the same dates for the same cohorts.
   `derive_cohort_maturity` interpolates to daily granularity, so the
   join on (anchor_day, snapshot_date) should align naturally.

**New function**: `compose_path_maturity_frames(graph, x_node_id,
y_node_id, all_edge_frames) → composed_frames`. Pure function, no DB
access. The function identifies x-incident and y-incident edges from
the graph, then applies the extraction rules above.

Evidence composition is correct for all topologies including branching
at x and fan-in at y.

#### Layer 3: x→y span kernel (Phase A — new capability)

**Phase A keeps the current x estimate unchanged. It only changes how
y is produced from that x.**

The span kernel K_{x→y}(τ) answers: "given arrival at x at time 0,
what is the probability of having reached y by age τ?" This is the
conditional progression across the full downstream DAG from x to y,
including branching and joins.

##### Algebra

Each edge e_i has a sub-probability density on the discrete tau grid:

```
f_i(τ) = p_i · pdf_i(τ)
```

where `pdf_i` is the density of the shifted-lognormal latency for
edge i, and `p_i` is the edge conversion probability. The
corresponding sub-probability CDF is `F_i(τ) = Σ_{t≤τ} f_i(t)`.
Note: `F_i(∞) = p_i`, not 1.

**Linear chain** x→B→…→y: The path kernel density is the convolution
of per-edge sub-probability densities:

```
f_{x→y}(τ) = (f₁ * f₂ * … * fₙ)(τ) = Σ_t f₁(t) · f₂...ₙ(τ − t)
```

The path kernel CDF is the accumulation:

```
K_{x→y}(τ) = Σ_{t≤τ} f_{x→y}(t)
```

Asymptotic: K_{x→y}(∞) = Π p_i.

**Branching** (x→B→D and x→C→D, both reaching y): Each route r has
its own kernel density f_r(τ) (convolution of that route's per-edge
densities). The combined kernel density is the **sum** of per-route
densities (not a normalised mixture):

```
f_{x→y}(τ) = Σ_r f_r(τ)
```

This is correct because the routes are mutually exclusive given
arrival at x (a cohort member takes one route, not all). The
asymptotic K_{x→y}(∞) = Σ_r Π_{i∈r} p_i, which equals
`calculate_path_probability(x, y)` (already implemented via DFS with
memoisation in `path_runner.py`).

**Fan-in at intermediate node** (x→B→D and x→C→D, then D→y): The
density at D is the sum of per-route densities reaching D. The D→y
edge density is then convolved with this sum. This is handled
naturally by computing per-route path densities and summing.

**Single hop** (x→y is one edge): f_{x→y}(τ) = p · pdf(τ),
K_{x→y}(τ) = p · CDF(τ). Degenerates to the existing computation.

##### Convolution computation

Per-edge densities are shifted-lognormal. Their convolution has no
closed form. Two viable approaches:

1. **Numerical convolution on the tau grid** (recommended for Phase A):
   discretise each f_i onto the integer tau grid (0..max_tau), then
   convolve via standard discrete convolution (O(n²) per edge pair,
   O(n² · num_edges) total). For typical max_tau ≈ 200–400 and
   num_edges ≈ 2–5, this is trivially fast.

2. **Moment-matching approximation**: fit a single shifted-lognormal
   to the convolved density via matching of mean, variance, and onset.
   Faster but loses shape information (skew, multimodality from
   branching). Not recommended for Phase A.

Phase A uses approach 1. Each edge's shifted-lognormal pdf is
evaluated at integer tau values to produce a discrete density vector,
then standard discrete convolution composes the path.

##### Numerator formula

```
Y_y(s, τ) = Σ_u ΔX_x(s, u) · K_{x→y}(τ − u)
```

Where:
- `ΔX_x(s, u)` = incremental arrivals into x for cohort s at age u
  (from `x_provider` — see Layer 4)
- `K_{x→y}(τ)` = span kernel **CDF** (sub-probability, not density)

The convolution is with K (the CDF), not with f (the density). This
is correct because K_{x→y}(τ − u) is the probability that an arrival
at x at age u has reached y by age τ — a cumulative quantity. The
product `ΔX_x(s, u) · K_{x→y}(τ − u)` is the expected number of
those arrivals that have reached y by age τ. Summing over u gives
cumulative arrivals at y, which is what Y_y represents.

In window() mode, `ΔX_x` is a delta at τ=0, so the convolution
simplifies to `Y_y(s, τ) = X_x(s) · K_{x→y}(τ)`.

##### Computation: node-level DP (not path enumeration)

Enumerating all paths from x to y is exponential in the worst case on
wide DAGs. The correct approach is a **forward DP in topological
order**:

1. Topological sort nodes reachable from x that can reach y
2. Initialise: `g_x(τ) = δ(τ=0)` (unit impulse at x)
3. For each node v in topological order after x:
   `g_v(τ) = Σ_{edges u→v} (g_u * f_{u→v})(τ)`
   where `*` is discrete convolution and `f_{u→v}` is the per-edge
   sub-probability density
4. Result: `g_y = f_{x→y}`, the combined kernel density
5. Accumulate: `K_{x→y}(τ) = Σ_{t≤τ} g_y(t)`

This naturally handles branching (fan-out sums at convergence nodes)
and fan-in (multiple incoming edges contribute to g_v). Complexity is
O(|E| · max_tau²) — dominated by per-edge convolution on the tau grid.
For typical graphs (|E| ≈ 2–10, max_tau ≈ 200–400), this is trivially
fast.

##### SpanKernel interface

**New function**: `compose_span_kernel(graph, x_node_id, y_node_id,
is_window, max_tau) → SpanKernel`. The function runs the DP above.

The `SpanKernel` provides:
- `K(τ) → float`: the kernel CDF at tau (used in the numerator
  convolution — see below)
- `span_p`: asymptotic K(∞) = total conditional probability
- `tau_grid`: the discrete tau values the kernel is defined on

##### MC fan bands and frontier conditioning

The current row builder does not just apply the unconditional forecast.
For each cohort, it observes (y_observed, x_observed) up to
tau_observed, updates the prior (α₀, β₀) to a posterior via Bayesian
updating, then uses the posterior predictive for the forecast beyond
tau_observed. This is what makes the fan narrow around observed data
and widen into the future.

**Preservation rule: new operators, same sampler.** Phase A must keep
the current cohort-maturity forecasting discipline and only swap the
inner single-edge ingredients for richer span-level ones. In
particular, it must preserve:

- the observed/forecast splice at `tau_observed`
- the D/C decomposition (frontier survivors vs future arrivals)
- conditional late-conversion sampling for the D population only
- continuous expected-mass treatment of the C population (no Binomial
  noise on model-predicted future arrivals)
- posterior-draw fan generation and the current clipping/boundedness
  discipline

The approach:

1. **Per-cohort frontier conditioning**: At tau_observed, the composed
   evidence frames provide actual (y_at_y, x_at_x). Update the prior
   to posterior: `α_post = α₀ + y_observed`, `β_post = β₀ +
   (x_observed - y_observed)`.

   **In-transit approximation**: This update treats every arrival at x
   that hasn't reached y as a failure. For multi-hop spans, some of
   those arrivals are still in transit through intermediate nodes —
   they haven't failed, they just haven't had enough time. This is the
   **same approximation** as the current single-edge code (which also
   does not adjust for incomplete maturation at the frontier), but the
   effect is larger for multi-hop because more mass is in transit at
   any given tau_observed. The bias is conservative (overestimates
   failures, underestimates the rate), which is safe. A proper fix
   would use completeness-adjusted exposure:
   `x_effective = Σ_u ΔX_x(s, u) · K_{x→y}(tau_obs - u) / span_p`
   and update with `β_post = β₀ + (x_effective - y_observed)`. This
   is a potential Phase A+ improvement, not a Phase A blocker — it
   preserves adjacent-pair parity (where the approximation matches v1).

   **Empty evidence fallback**: If no composed evidence exists (no
   snapshots for the span), the entire chart is pure unconditional
   forecast with no frontier conditioning. This matches the current
   single-edge behaviour when no snapshots exist.

2. **Post-frontier forecast**: Use the posterior predictive with the
   span kernel's temporal shape. The updated rate replaces span_p in
   the forecast; the kernel's CDF shape provides the maturation curve.

3. **MC fan sampling**: Draw rate samples from `Beta(α_post, β_post)`.
   For each draw, forecast the immature portion using the span kernel's
   CDF shape. Aggregate across draws for quantile bands.

4. **Prior composition for multi-hop**: Phase A uses the last edge's
   `posterior_path_alpha/beta` as the span prior. These are already
   path-composed by the Bayes engine for the anchor→y path. When x = a
   this is exactly right. When x ≠ a it's an approximation (the prior
   reflects the a→y rate, not the x→y rate). This matches the single-
   edge behaviour for adjacent pairs (parity) and is adequate for
   Phase A. A more principled approach (method-of-moments from span_p
   + composed uncertainty) can be explored later.

5. **Latency-shape uncertainty for MC draws**: Phase A uses per-edge
   posterior SDs from the last edge's path-level values
   (`bayes_path_mu_sd`, `bayes_path_sigma_sd`, etc.). This
   underestimates true span uncertainty (ignores upstream edge
   uncertainty and cross-edge correlations) but matches the single-edge
   behaviour for adjacent pairs (parity). A per-draw reconvolution
   (draw per-edge params independently, reconvolve the kernel per MC
   sample) is the correct approach but adds O(num_draws × |E| ×
   max_tau²) cost. Recommend as a Phase A+ enhancement.

#### Layer 4: Row builder restructuring (Phase A — make the seam real)

The row builder (`compute_cohort_maturity_rows`) currently does three
things internally:

1. Resolves `edge_params` → edge-level or path-level mu/sigma/p/SDs
2. Computes x forecast: `reach(u) × CDF_upstream(τ)` (where u = last
   edge's source node)
3. Projects y from x using the edge kernel

Phase A introduces two explicit inputs:

- **`x_provider(s, τ) → float`**: returns the estimated cumulative
  arrivals at x for cohort s at age τ.
- **`span_kernel`**: the x→y conditional progression (Layer 3).

The row builder becomes a **composition layer** that applies the
numerator formula from Layer 3 and the frontier conditioning from
Layer 3's MC fan section. It stops hard-coding the single-edge
`p × CDF` ingredients; it does **not** replace the outer
cohort-maturity sampler.

**Why introduce x_provider in Phase A** (not Phase B): If Phase A
leaves x hidden inside the row builder, Phase B must refactor the row
builder *and* swap the implementation simultaneously. By extracting
x_provider now, Phase B only swaps the provider. The seam is real from
day one.

##### x_provider in Phase A

The x_provider must return **arrivals at x** (the query start node),
not arrivals at u or any other node. Feeding arrivals at u into a
kernel K_{x→y} that starts from x would double-apply the x→u portion
of the span. This is a correctness requirement, not an approximation.

**When x = a** (common case): arrivals at x = arrivals at the anchor
= `a_pop` (the cohort starting population). This is a constant for
all τ — there is nothing to model. The convolution
`a_pop · K_{a→y}(τ)` gives the correct numerator directly. No reach
computation, no CDF_upstream, no legacy estimate needed.

**When x ≠ a**: the x_provider needs to estimate how arrivals at x
grow with τ. This is genuinely the Phase B problem (anchor-to-x
propagation). For Phase A:
- **Observed region** (τ ≤ tau_observed): return actual `x_at_x` from
  composed evidence frames. Correct.
- **Forecast region** (τ > tau_observed): carry forward the last
  observed x value. This assumes x is mostly mature by tau_observed
  (reasonable when x is well upstream of y). Documented as an
  approximation.

**Window mode**: `x_provider` returns a constant for all τ (the
observed x from the evidence frame, which equals `a_pop` when x = a).

**Cohort mode, x = a**: `x_provider` returns `a_pop` for all τ.
Trivially correct. No legacy estimate involved.

**Cohort mode, x ≠ a**: Two-regime behaviour (observed, then carry-
forward). Phase B replaces the forecast-region implementation with a
proper a→x propagation solve.

##### What the row builder does

For each cohort s:
1. Call `x_provider(s, τ)` to get X_x(s, τ) for all τ — this is
   arrivals at x (when x = a: simply a_pop; when x ≠ a: observed
   then carry-forward)
2. Use the observed prefix exactly as today: actual `(x_obs, y_obs)` up
   to `tau_observed`, forecast only beyond the frontier
3. Split the immature region exactly as today into:
   - **D**: frontier survivors already at x by `tau_observed`
   - **C**: future arrivals to x after `tau_observed`
4. For **D**, use the span kernel in the same conditional style as the
   current code:
   `q_late(τ) = (K(τ) - K(tau_observed)) / (1 - K(tau_observed))`
   and preserve the existing sampling discipline (`none` / `normal` /
   `binomial`)
5. For **C**, treat future arrivals as model-predicted mass, not as
   observed Binomial trials. Combine arrival increments `ΔX_x` with the
   span kernel to get expected future `y`; do not introduce Binomial
   noise for this term
6. Combine observed prefix + forecast suffix, clip `y` into `[0, x]`,
   and preserve cumulative monotonicity / boundedness as in v1
7. MC fan: draw posterior rate samples (and latency-shape uncertainty
   where enabled), forecast per draw, aggregate quantiles

#### Layer 5: Frontend — chart rendering

No changes needed. The row schema is the same. The chart builder does
not know or care whether the rate is edge-level or span-level.

Cosmetic change: chart title/subtitle should indicate span rate (x→y)
rather than edge rate. Driven by the `subjectLabel` field already
present in the subject metadata.

### Implementation strategy: new analysis type

Phase A is implemented as a **new analysis type** (`cohort_maturity_v2`
or similar) rather than modifying the existing `cohort_maturity`:

1. **Zero regression risk** — existing `cohort_maturity` untouched.
2. **Built-in parity test** — run both types on the same adjacent
   `from(x).to(y)` subject via CLI; assert identical output.
3. **Visible from day one** — full FE+BE registration per the
   adding-analysis-types checklist. Testable in browser and via
   `graph-ops/scripts/analyse.sh --type cohort_maturity_v2`.
4. **CLI parity tooling** — extend `graph-ops/scripts/parity-test.sh`
   or write a dedicated script that runs both types and diffs output.

Once parity is proven and multi-hop is working, either retire the old
type (rename v2 → `cohort_maturity`) or keep both.

### Implementation sequence

| Step | What | Depends on | Risk |
|------|------|-----------|------|
| **A.0** | Register `cohort_maturity_v2` — full FE+BE per adding-analysis-types checklist. Reuse `cohort_maturity` ECharts builder. BE handler initially clones existing pipeline. | — | Low |
| **A.1** | `compose_path_maturity_frames()` — evidence frame composition. Handles all topologies (branching at x, fan-in at y). Uses canonical denominator carrier rule. | — | Medium: join alignment |
| **A.2** | `compose_span_kernel()` — conditional x→y kernel via numerical convolution of per-edge sub-probability densities on tau grid. Route enumeration + summation for branching. | — | Medium: DAG traversal + convolution |
| **A.3** | Extract `x_provider(s, τ)` — a_pop when x = a, observed + carry-forward when x ≠ a. Extract row builder as composition layer **while preserving the current D/C decomposition, frontier conditioning, sampling modes, clipping discipline, and MC fan behaviour**. Uses last edge's path alpha/beta for prior, last edge's path SDs for MC uncertainty. | A.0, A.1, A.2 | High: row builder refactor + frontier conditioning |
| **A.4** | **Single-hop parity gate**: v1 vs v2 on adjacent subjects, field-by-field. Real graph data. | A.3 | Required gate |
| **A.5** | **Multi-hop tests**: evidence parity (all topologies) + forecast convergence (τ→∞, rate→span_p) + frontier conditioning (fan narrows at observed data, widens into future) | A.1, A.2, A.3 | Required gate |

### How this feeds forward

| Phase | What it does | What it does NOT touch |
|-------|-------------|----------------------|
| **A** (span kernel) | New `span_kernel` (full DAG, incl. branching) + `x_provider` interface (a_pop when x = a, observed + carry-forward when x ≠ a). Fixes y projection for all multi-hop topologies. | Does not improve x estimation for x ≠ a beyond carry-forward. |
| **B** (x provider) | Swaps `x_provider` implementation for proper a→x propagation when x ≠ a. Frontier continuity. Completeness-adjusted frontier conditioning. | Does not change span kernel. |
| **0–6** (forecast engine) | Generalises both kernel and provider for all consumers. | — |

### Appendix: legacy key set (transitional)

During the transition from the existing row builder to the new
composition layer, the SpanKernel may need to provide a legacy-
compatible dict for code paths not yet refactored. This is a
**transitional** concern — the target interface is `K(τ)`, `f(τ)`,
`span_p`, and the MC fan parameters defined in Layer 3.

The legacy keys, sourced from `_read_edge_model_params`
(`api_handlers.py` lines 760–880), consumed at lines 390–418 of
`cohort_forecast.py`:

Edge-level: `mu`, `sigma`, `onset_delta_days`, `forecast_mean`,
`posterior_p`, `posterior_alpha`, `posterior_beta`, `p_stdev`,
`bayes_mu_sd`, `bayes_sigma_sd`, `bayes_onset_sd`,
`bayes_onset_mu_corr`, `t95`, `evidence_retrieved_at`.

Path-level: `path_mu`, `path_sigma`, `path_onset_delta_days`,
`posterior_p_cohort`, `posterior_path_alpha`, `posterior_path_beta`,
`p_stdev_cohort`, `bayes_path_mu_sd`, `bayes_path_sigma_sd`,
`bayes_path_onset_sd`, `bayes_path_onset_mu_corr`, `path_t95`.

The row builder selects edge-level or path-level based on `is_window`
(lines 393–418). Once the row builder is fully refactored to use the
SpanKernel interface directly, these legacy keys are no longer needed.

### Note: cross-edge regime coherence (doc 30)

Doc 30's per-edge regime selection guarantees one coherent regime per
(edge, anchor_day, retrieved_at). For multi-hop composition, different
edges need **not** use the same regime. The composition takes arrivals
at x from x-incident edges and arrivals at y from y-incident edges — as
long as each edge's own regime is coherent (guaranteed by doc 30), the
composed rate is correct. No cross-edge regime enforcement needed.

### Note: docs 30+31 are implemented

The BE resolves path structure natively from the DSL string via
`graph_select.py`. No FE patch fields (`from_node_uuid`, etc.) are
needed. CLI testing via `graph-ops/scripts/analyse.sh --type
cohort_maturity_v2` provides end-to-end development testing.

---

## Recommended Sequencing

| Phase | What | Why this order |
|-------|------|----------------|
| **A** | **Span kernel**: register `cohort_maturity_v2`. Implement `compose_path_maturity_frames` + `compose_span_kernel` (node-level DP, full DAG incl. branching). Introduce `x_provider(s, τ)` (a_pop when x = a; observed + carry-forward when x ≠ a). Row builder becomes composition layer with frontier conditioning and MC fan. | Numerator-only fix. Full fix in window(). Correct numerator in cohort(). x trivially correct when x = a (common case). |
| **B** | **x provider**: swap `x_provider` implementation for proper a→x propagation. Frontier continuity. | Denominator improvement only. Span kernel untouched. |
| **0** | Design forecast-state contract, informed by A+B | Forces precision on building blocks |
| **1** | Record live cohort() approximations precisely | Prevents contract from freezing stale assumptions |
| **2** | Fix remaining cohort() maths in Python | Hard prerequisite for reusable engine |
| **3** | Implement contract + unify basis resolution | Backend-first |
| **4** | Wire `cohort_maturity` to new contract | First consumer validates |
| **5** | Wire `surprise_gauge`, retire FE duplication | Second consumer proves reusability |
| **6** | Parity and contract tests | Gate for promotion |

---

## Acceptance Criteria

1. **Adjacent-pair parity**: `cohort_maturity_v2` on `from(x).to(y)`
   where x→y is a single edge produces identical output to
   `cohort_maturity`, field by field.

2. **Multi-hop parity** (all topologies): `cohort_maturity_v2` on
   `from(x).to(y)` across multiple hops — including branching and
   fan-in — produces results consistent with manual composition of
   per-edge evidence and forecast.

3. **x_provider extraction correctness**: v2's `x_provider(s, τ)`,
   when called with the same cohort and tau, returns values identical
   to v1's internally-computed x values. This tests that the
   extraction was correct, not that identical code produces identical
   results.

4. **x_provider correctness test**: A test on a multi-hop span
   verifying: (a) when x = a, x_provider returns a_pop for all τ,
   (b) when x ≠ a, x_provider returns observed x to the frontier then
   carry-forward beyond, (c) the convolution Y_y = ΔX_x * K produces
   the correct unconditional forecast.

5. **Sampling-discipline parity**: For adjacent pairs, v2 preserves the
   existing cohort-maturity sampler: observed/forecast splice at the
   frontier, D/C decomposition, no Binomial noise on model-predicted
   future-arrival mass, and fan-band behaviour consistent with v1.

---

## Bottom Line

Phase A fixes the conditional x→y progression over the full downstream
DAG (including branching and joins). Phase A does not change the
denominator model. Phase B replaces the denominator model.

Phase A introduces two explicit inputs to the row builder:

- **`x_provider(s, τ)`** — arrivals at x. When x = a (common case):
  `a_pop` for all τ (trivially correct, no modelling needed). When
  x ≠ a: observed arrivals to the frontier, carry-forward beyond.
- **`span_kernel` K_{x→y}(τ)** — the conditional x→y progression,
  computed via node-level DP (forward convolution of per-edge
  sub-probability densities through the DAG in topological order)

**New operators, same sampler**: the row builder keeps the current
cohort-maturity forecasting discipline — observed/forecast splice,
D/C decomposition, conditional sampling for frontier survivors only,
continuous treatment of future-arrival mass, posterior-draw fan bands,
and clipping/boundedness. What changes is only the inner input pair:
`x_provider(s, τ)` for arrivals at x and `span_kernel K_{x→y}(τ)` for
conditional progression from x to y.

Phase B swaps the x_provider's implementation for x ≠ a with a proper
a→x propagation solve, and introduces completeness-adjusted frontier
conditioning. The span kernel and row builder structure are untouched.

In window() mode, Phase A is the full fix. In cohort() mode with
x = a (common case), Phase A is also the full fix. In cohort() mode
with x ≠ a, Phase A uses carry-forward for x beyond the frontier —
an approximation resolved by Phase B.

**Known approximations in Phase A** (all inherited from or analogous
to current single-edge code; none block adjacent-pair parity):
1. Frontier conditioning treats in-transit arrivals as failures (same
   as v1; worse for multi-hop; completeness-adjusted update is a
   Phase A+ improvement)
2. Prior α₀/β₀ from last edge's path alpha/beta (matches v1 for
   adjacent pairs; approximate for multi-hop)
3. MC latency-shape SDs from last edge's path-level values
   (underestimates span uncertainty; per-draw reconvolution is a
   Phase A+ improvement)
4. x carry-forward when x ≠ a (only affects the uncommon x ≠ a case)
