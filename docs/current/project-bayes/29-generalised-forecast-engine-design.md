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
   for current use cases or A→Z maturity.*

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
gates. The forecast-state contract (Phase 0) and A→Z maturity (Phase A) can
proceed without resolving any of them. When the generalised engine is built
(Phases 2–4), items 1–3 should be addressed as part of that work. Item 4 is
needed only when the shared contract is designed.

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

## Recommended Sequencing

The plan is sound but the sequencing should distinguish between design work and
ship-ready implementation. The remaining cohort-mode maths is the hard gate for
shipping a shared engine, not for writing down the contract.

| Phase | What | Why this order |
|-------|------|----------------|
| **0** | Design the forecast-state contract (Step 1) as a document, not code | Forces precision about what "reusable" means before writing anything |
| **1** | Record the live cohort() blockers precisely (Step 4) | Prevents the contract from freezing stale assumptions from older design notes |
| **2** | Fix the remaining cohort() maths blockers in Python | Hard prerequisite for a reusable shipping engine |
| **3** | Implement the contract in Python + unify basis resolution (Steps 1+2) | Backend-first, informed by corrected maths |
| **4** | Split layers (Step 3) and wire `cohort_maturity` to the new contract | First consumer validates the contract |
| **5** | Wire `surprise_gauge` to the same contract and retire semantic duplication in the FE | Second consumer proves reusability |
| **6** | Parity and contract tests (Step 6) throughout, but especially before switching consumers | Gate for promoting the shared engine |

---

## Generalised Cohort Maturity (A→Z Traversal)

**Added**: 7-Apr-26

The current cohort maturity implementation works only when `from(A).to(B)` specifies an adjacent pair (a single edge). We want to generalise it to work across any span — `from(A).to(Z)` where A→Z may traverse multiple intermediate nodes. This section reasons from first principles about what that requires, and argues that the correct sequencing is: **first generalise cohort maturity evidence+forecast across spans, then generalise the forecast engine broadly** (inserting before the Recommended Sequencing above).

### Why this sequencing

1. **Multi-hop cohort maturity has immediate user value.** Users want to see "of the cohort that entered at A, what fraction reached Z, and how is that maturing?" This is a concrete question with a well-defined answer. Delivering it does not require solving the full generalised forecast engine.

2. **The evidence part is straightforward.** The snapshot data for path-level evidence already exists in the DB — it requires cross-edge composition at the frame level, not new mathematical machinery.

3. **The forecast part has a usable approximation.** Per-edge Bayes params can be composed into path-level params (product of p values, path-level mu/sigma from the last edge's posterior). This is not the correct DAG propagation from §Step 4 above, but it is a reasonable approximation that works for the common case (linear chains with one dominant path). The full propagation then improves accuracy later.

4. **Building multi-hop maturity first creates the consumer that validates the forecast-state contract.** The contract from Phase 0 must serve both single-edge and multi-hop maturity. Building the multi-hop consumer first exposes contract gaps that would otherwise only surface in Phase 4.

### What cohort maturity for A→Z means (first principles)

**Definition**: For a group of cohorts anchored at dates d₁..dₙ, the path maturity curve plots:

```
r(τ) = Σᵢ yᵢ_Z(τ) / Σᵢ xᵢ_A(τ)
```

Where:
- `yᵢ_Z(τ)` = arrivals at Z observed by age τ for cohort i
- `xᵢ_A(τ)` = arrivals at A for cohort i (fixed in window mode, growing in cohort mode)
- τ = days since cohort anchor date

The denominator is **arrivals at A** (the query's from-node), not arrivals at the last edge's from-node. The numerator is **arrivals at Z** (the query's to-node), which equals `y` on the last edge(s) into Z.

**Relationship to edge-level maturity**: When A and Z are adjacent, this reduces to the current implementation (`y/x` on the single edge A→Z). The generalisation replaces the single-edge denominator `x` with the first-edge denominator `x_A`, and the single-edge numerator with the last-edge `y_Z`.

**Parallel paths**: If multiple routes exist from A to Z (e.g. A→B→D→Z and A→C→D→Z), the numerator includes arrivals at Z via all routes. This is correct: `r(τ)` answers "what fraction of A-entrants reached Z by age τ", regardless of route. The last edge(s) into Z that lie on an A→Z path all contribute to the numerator sum.

### What already works

| Component | Status |
|-----------|--------|
| **Scope rule** (`funnel_path`) | Already finds all edges on any A→Z path via BFS (`resolveFunnelPathEdges`) |
| **Snapshot retrieval** | Already fetches snapshots for every in-scope edge independently |
| **Per-edge maturity derivation** | `derive_cohort_maturity()` produces frames from one edge's snapshots |
| **Chart rendering** | Row schema (tau_days, rate, midpoint, fan_upper, fan_lower) is edge-agnostic — works unchanged |
| **Epoch planning** | Already handles sweep epochs per subject |

### What needs to change

#### Layer 1: Frontend — path structure resolution

`resolveFunnelPathEdges()` returns an unordered `Set<string>` of edge UUIDs. For multi-hop maturity, the backend needs to know which edge is **first** (for the denominator) and which edge(s) are **last** (for the numerator). Two options:

**Option A** (minimal): pass `from_node_uuid` and `to_node_uuid` alongside the existing subject list. The backend resolves first/last edges from the graph structure. No change to `resolveFunnelPathEdges`.

**Option B** (richer): add a new function `resolveOrderedFunnelPath()` that returns the ordered edge sequence. Pass this to the backend. More explicit, but only needed if the backend cannot infer order from the graph.

**Recommendation**: Option A. The backend already has the graph and can find edges incident to from/to nodes. The FE already passes `from_node` and `to_node` in subject metadata (see `subjectLabel` construction at `snapshotDependencyPlanService.ts:522–530`). Promote these to first-class fields on the subject request.

#### Layer 2: Backend — request shape

Currently each snapshot subject maps to one edge (one `param_id`, one `targetId`). For multi-hop maturity, the backend receives **multiple subjects** (one per in-scope edge) and needs to compose them.

Two approaches:

**Approach A** (compose in handler): The handler already receives all subjects for the scenario. Add a post-processing step that, for `cohort_maturity` with multi-hop paths, identifies the first-edge and last-edge subjects and composes their frames before calling `compute_cohort_maturity_rows`.

**Approach B** (new read_mode): Add `read_mode: 'path_cohort_maturity'` that explicitly signals multi-hop composition. The handler treats the subject list as a path, not independent edges.

**Recommendation**: Approach A. The `funnel_path` scope rule already produces the right subject set. The handler can detect multi-hop (more than one subject) and compose. No new read_mode needed.

#### Layer 3: Backend — path-level frame composition

This is the core new logic. Given frames from the first edge and frames from the last edge(s):

1. **Denominator extraction**: From the first edge (A→B) frames, extract `x` per (anchor_day, snapshot_date). This is `x_A` — arrivals at A.

2. **Numerator extraction**: From the last edge(s) (Y→Z) frames, extract `y` per (anchor_day, snapshot_date). This is `y_Z` — arrivals at Z. If multiple edges feed into Z on the path, sum their `y` values.

3. **Composition**: For each (anchor_day, snapshot_date), compute `rate = y_Z / x_A`. Emit a composed frame with the same schema as `derive_cohort_maturity` output but using the path-level rate.

4. **Join key alignment**: Both edges' frames are derived from snapshots retrieved on the same dates for the same cohorts. `derive_cohort_maturity` already interpolates to daily granularity, so the join on (anchor_day, snapshot_date) should align naturally.

**New function**: `compose_path_maturity_frames(first_edge_frames, last_edge_frames_list, graph, from_uuid, to_uuid) → composed_frames`. Pure function, no DB access.

**Edge case — single intermediate edge**: When the path is A→C→Z (two edges), the "first edge" is A→C and the "last edge" is C→Z. The denominator comes from A→C's `x` (arrivals at A), the numerator from C→Z's `y` (arrivals at Z). Straightforward.

**Edge case — fan-in at Z**: If Z has multiple incoming edges on the path (e.g. D→Z and E→Z), we sum `y` across both. This naturally captures all routes.

**Edge case — shared `a` field**: In many data sources, `a` (anchor population) is the same across all edges for a given cohort, and equals `x` on the entry edge. If `from_node = anchor_node` (common case), we can use `a` from any edge as the denominator, which is simpler than extracting `x` from the first edge specifically. The implementation should prefer `a` when from-node is the anchor, falling back to first-edge `x` otherwise.

#### Architectural decomposition: span kernel vs upstream denominator

**REFRAMED (8-Apr-26)**: The multi-hop problem contains two
mathematically distinct sub-problems. The original design treated them
as one coupled rewrite. They are not and must be separated.

**Problem 1 — the x→y span kernel** (Phase A): Given arrivals at x,
what is the probability of reaching y by age τ? This is the conditional
progression from x to y, hop by hop, using per-edge posteriors for each
hop in the queried span. This is a numerator problem.

**Problem 2 — the upstream denominator** (Phase B): How does
anchor-cohort mass reach x? This is the `reach(x)` ×
`CDF_upstream(τ)` computation currently in `compute_cohort_maturity_rows`
(lines 818–823 of `cohort_forecast.py`). This is a denominator problem.

**One-sentence summary**: Phase A fixes the multi-hop x→y numerator by
doing the hop-by-hop convolution correctly while keeping the existing
upstream x estimate unchanged; Phase B, if needed, replaces that
upstream x estimate with a proper anchor-to-x propagation solve.

**Why this split is correct**:
- It isolates the real numerator problem — the x→y span logic is what
  doesn't exist today.
- It avoids turning one fix into a full graph-propagation rewrite.
- It works cleanly in window() mode (x is flat) and improves cohort()
  mode immediately (better y forecast, same x forecast).
- It gives a stable seam: later work can swap in a better x provider
  without rewriting the x→y logic again.

**Architectural contract**: The row builder should be restructured to
consume x as an **input** and apply the span kernel to resolve y:

```
Input A:  current estimate of arrivals into x  (unchanged in Phase A)
Input B:  conditional x→…→y multi-hop kernel   (new in Phase A)
Output:   forecast y

Y_y(s,τ) = convolution of arrivals into x with the x→…→y progression kernel
```

The row builder must stop inventing or re-deriving x internally for
the multi-hop case. It should receive x and apply the kernel.

#### Layer 4: Backend — x→y span kernel (Phase A)

This is the core new logic. For each hop in the queried span x→…→y,
compose the per-edge conditional progression into a single span-level
kernel: "given arrival at x at time t, what is the probability of
being at y by age τ?"

**For a single hop** (x→y is one edge): The kernel is the existing
edge-level `p × CDF(τ)` — no change from current `cohort_maturity`.

**For multiple hops** (x→B→…→y): The kernel is the hop-by-hop
convolution of per-edge `pᵢ × CDFᵢ(τ)` kernels along the chain.

**Scope restriction — Phase A supports linear chains only; branching
deferred to Phase B**: For x→B→D plus x→C→D, `graph_select.py` returns
the union of edges across all valid paths (lines 297–309). Multiplying
p across the union is not a path probability. If `from(x).to(y)`
resolves to multiple routes, Phase A should either (a) refuse, or
(b) pick the single dominant route by highest cumulative p.

**Branching is a hard requirement** — it must be supported eventually.
The correct `p_path` for branching topologies is already available from
`calculate_path_probability(x, y)` (DFS with memoisation in
`path_runner.py`). The path CDF for branching is a weighted mixture of
per-route CDFs. Phase B addresses this along with the upstream
denominator work.

The evidence side (Layer 3) is **already correct for branching** —
fan-in numerator summation works for all topologies.

**New function**: `compose_span_kernel(graph, span_edge_ids,
is_window) → SpanKernel`. The `SpanKernel` encapsulates the x→y
conditional progression and provides:

- `span_p`: conditional probability of reaching y given arrival at x.
  For a linear chain: `Π pᵢ`. Uses per-edge posteriors.
- `span_cdf(τ)`: conditional CDF — probability of reaching y by age τ
  given arrival at x. For Phase A (linear chain): use the last edge's
  `path_mu`/`path_sigma`/`path_onset` when from-node = anchor (these
  are already composed by the Bayes engine). When from-node ≠ anchor,
  this needs adjustment (deconvolution of the prefix) — flag as a
  known approximation.
- `span_uncertainty`: posterior SDs for MC fan sampling. Use last
  edge's path-level SDs (`bayes_path_mu_sd`, `bayes_path_sigma_sd`,
  etc.). Underestimates true span uncertainty.
- `alpha_0`, `beta_0`: Bayesian prior for per-Cohort rate updating
  in the posterior predictive. From last edge's
  `posterior_path_alpha`/`posterior_path_beta`.

The kernel must provide all the fields that `compute_cohort_maturity_rows`
currently reads from `edge_params` (lines 390–418 of `cohort_forecast.py`),
matching the full `_read_edge_model_params` shape from `api_handlers.py`
(lines 760–880). See appendix for the full key set.

**Known approximations** (documented, not hidden):
1. Linear chains only — branching not supported in Phase A
2. Span CDF ≈ last edge's path params (correct only when from-node = anchor)
3. Span uncertainty ≈ last edge's SDs (underestimate)

#### Layer 5: Backend — row builder restructuring

The row builder (`compute_cohort_maturity_rows`) currently does three
things internally:

1. Resolves `edge_params` → edge-level or path-level mu/sigma/p/SDs
2. Computes upstream x forecast: `reach(from_node) × CDF_upstream(τ)`
3. Projects y from x using the edge kernel

For multi-hop, the row builder must be restructured to separate these
concerns:

**Phase A change**: accept the span kernel (Layer 4) as an input and
use it for the y projection (item 3). The upstream x forecast (item 2)
**stays unchanged** — it continues to use the existing
`reach_at_from_node × upstream_path_cdf_arr` logic from the target
edge's perspective.

In concrete terms:
- **Window mode**: x is flat (fixed denominator). The span kernel's
  `span_p` and `span_cdf(τ)` replace the single-edge `edge_p` and
  `_cdf(τ)` used for the y forecast. No x changes needed.
- **Cohort mode**: The existing x forecast (`a_pop × reach × CDF_path`)
  stays. The y forecast uses the span kernel instead of the single-edge
  kernel. The rate `y/x` is now span-level in the numerator, edge-level
  in the denominator. This is an improvement — the numerator correctly
  accounts for multi-hop progression — even though the denominator
  model is not yet span-aware.

**What this means for the frontier discontinuity**: In the observed
region, composed frames use `x_A` (actual arrivals at x from
snapshots). In the forecast region, the row builder's existing x model
produces its own estimate of arrivals at the target edge's from-node.
For the common case where from-node = anchor, `reach(anchor) = 1.0`
and the x forecast is simply `a_pop × CDF_upstream(τ)` which closely
matches the observed `x_A`. Any residual discontinuity at the frontier
is a known limitation to be resolved in Phase B.

**Phase B change** (later): replace the internal x forecast with an
explicit `x_provider` input — a function that returns `x(s, τ)` for
any cohort s and age τ. This enables:
- Proper anchor-to-x propagation for non-trivial upstream paths
- Upstream traversal with correct join handling
- Graph-wide x(s,τ) solve replacing the local shortcut
- Guaranteed frontier continuity (x provider matches observed x)

This is explicitly described as a **denominator-improvement phase**,
not mixed into the multi-hop span fix.

#### Layer 6: Frontend — chart rendering

No changes needed. The row schema is the same. The chart builder sums
and divides — it does not know or care whether the underlying rate is
edge-level or path-level.

The only cosmetic change: the chart title/subtitle should indicate it
shows path rate (x→y) rather than edge rate. This is a label change
driven by the `subjectLabel` field already present in the subject
metadata.

### Implementation strategy: new analysis type with single-hop parity gate

**Updated 8-Apr-26**: Phase A is implemented as a **new analysis type**
(`cohort_maturity_v2` or similar) rather than modifying the existing
`cohort_maturity`. This provides:

1. **Zero regression risk** — existing `cohort_maturity` is untouched
   during development.
2. **Built-in parity test** — run both analysis types on the same
   adjacent `from(A).to(B)` subject via CLI; assert identical output.
   Multi-hop must degenerate to single-hop, so parity on adjacent
   pairs is the acceptance gate.
3. **Visible from day one** — full FE+BE registration per the
   adding-analysis-types checklist. Can be tested in browser and via
   `graph-ops/scripts/analyse.sh --type cohort_maturity_v2`.
4. **CLI parity tooling** — extend `graph-ops/scripts/parity-test.sh`
   or write a dedicated script that runs both types and diffs output.

Once parity is proven and multi-hop is working, either:
- Retire the old type and rename v2 → `cohort_maturity`, or
- Keep both if there's value in having the simpler single-edge path
  as a distinct analysis.

### Implementation sequence for A→Z maturity

| Step | What | Depends on | Risk |
|------|------|-----------|------|
| **A.0** | Register `cohort_maturity_v2` as a new analysis type — full FE+BE registration per adding-analysis-types checklist. Reuse `cohort_maturity` ECharts builder (same chart shape). BE handler delegates to the same `derive_cohort_maturity` + `compute_cohort_maturity_rows` pipeline initially (clone of existing path). | — | Low: mechanical checklist |
| **A.1** | Implement `compose_path_maturity_frames()` in Python — pure function, no DB. Joins first-edge x with last-edge y. | — | Medium: join alignment |
| **A.2** | Implement `compose_span_kernel()` in Python — builds the x→y conditional progression from per-edge posteriors along the span. Must provide the full key set that `compute_cohort_maturity_rows` reads (matching `_read_edge_model_params` shape). | — | Low: composition logic |
| **A.3** | Restructure `compute_cohort_maturity_rows` to accept span kernel as input for y projection while keeping existing x forecast unchanged. Wire into v2 handler. | A.0, A.2 | Medium: row builder refactor |
| **A.4** | **Single-hop parity gate**: CLI test running both `cohort_maturity` and `cohort_maturity_v2` on identical adjacent subjects, asserting identical output field-by-field. Uses real graph data from data repo. | A.0 | Required gate — v2 must degenerate to v1 |
| **A.5** | **Multi-hop tests**: evidence parity (`y_Z / x_A` from composed frames vs manual computation) + forecast convergence (τ→∞, rate→span_p) + verify cohort-mode frontier behaviour is reasonable | A.1, A.2, A.3 | Required gate |

### How this feeds into the broader forecast generalisation

After Phase A (span kernel) is working:

1. **Phase B — upstream denominator improvement**: Replace the row
   builder's internal x forecast with an explicit `x_provider` input.
   This is the denominator-improvement phase:
   - Proper anchor-to-x propagation for non-trivial upstream paths
   - Branching graph support (fan-out/fan-in via
     `calculate_path_probability` and weighted mixture CDFs)
   - Graph-wide x(s,τ) solve replacing the local shortcut
   - Guaranteed frontier continuity
   - The span kernel (Phase A) is untouched — it consumes whatever
     x the provider delivers.

2. **The forecast-state contract (Phase 0 above)** can be designed with
   the span kernel as a first-class building block — the kernel from
   A.2 becomes the reference implementation for "conditional progression
   across a queried span".

3. **The remaining maths fixes (Phase 2 above)** improve the kernel:
   - τ-dependent Y_C convolution (currently heuristic)
   - Consistent probability bases
   - Unified tau_observed

4. **The unified resolver (Phase 3 above)** provides the `x_provider`
   with proper sub-path semantics.

In other words: Phase A delivers the span kernel (a new capability).
Phase B delivers the x provider (an improvement to an existing
estimate). These are cleanly separable — the span kernel consumes x
without caring how it was derived.

### Appendix: full key set for span kernel output

The span kernel must provide all keys that `compute_cohort_maturity_rows`
reads from `edge_params`. These are sourced from `_read_edge_model_params`
(`api_handlers.py` lines 760–880) and consumed at lines 390–418 of
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
(lines 393–418). For span kernels, the "path-level" values represent
the x→y span, and the "edge-level" values represent the last edge
(used as fallback).

### Post-doc-31 variant: active implementation path

**Added**: 7-Apr-26 | **Updated**: 8-Apr-26 — docs 30+31 now
implemented; this is the active path, not a hypothetical variant.

Docs 30 (regime selection) and 31 (BE subject resolution) are
implemented. The BE resolves path structure natively from the DSL
string. Several Phase A steps simplify and one new concern emerges.

**CLI testing**: `graph-ops/scripts/analyse.sh --type cohort_maturity`
with a non-adjacent `from(A).to(Z)` subject provides end-to-end
development testing of the charting pipeline.

#### What simplifies

| Phase A step | Pre-doc-31 | Post-doc-31 |
|---|---|---|
| **A.0** `from_node_uuid` / `to_node_uuid` on `SnapshotSubjectRequest` | New patch fields required | **Unnecessary** — BE resolves path from DSL natively, knows first/last edges |
| **A.6** FE passes from/to UUIDs | FE change required | **Unnecessary** — FE sends DSL string; BE resolves |
| **A.3** Handler detects multi-hop | Counts subjects > 1 | Inspects resolved path structure directly — more robust |
| Scope resolution | FE BFS via `resolveFunnelPathEdges`, sends flat subject list | BE BFS from DSL string via `graph_select.py` — path ordering preserved |

Steps A.1 (`compose_path_maturity_frames`) and A.2
(`compose_path_forecast_params`) are **unchanged** — they are pure
functions operating on frames and params, independent of how the path
was resolved.

#### New concern: cross-edge regime coherence

Doc 30 introduces per-edge regime selection: for each
`(edge, anchor_day, retrieved_at)` triple, the BE picks one observation
regime (one hash family) and discards alternatives. For single-edge
maturity this is sufficient.

For multi-hop maturity, the regimes selected for different edges need
**not** be identical. Doc 30 only requires one coherent regime per edge
per date — it then lets the consumer aggregate/filter within that
regime. Two edges can legitimately use different winning hashes and
still represent the same requested population (e.g. first edge resolved
via `context(channel)` hash, last edge via `context(device)` hash —
both are valid MECE representations of the same aggregate).

**No cross-edge regime enforcement needed**: the composition takes `x`
from the first edge and `y` from the last edge. As long as each edge's
own regime selection is coherent (guaranteed by doc 30), the composed
`y_Z / x_A` is correct. Enforcing identical regime families across
path edges would create avoidable evidence gaps on dates where edges
happen to have different winning hashes.

#### Revised Phase A steps (post-doc-31)

| Step | What | Notes |
|------|------|-------|
| **A.0** | Register `cohort_maturity_v2` — full FE+BE, reuse existing ECharts builder | Regression-safe development vehicle |
| **A.1** | `compose_path_maturity_frames()` — pure function, no DB | Evidence composition (exact for all topologies) |
| **A.2** | `compose_span_kernel()` — x→y conditional progression from per-edge posteriors | Must match full `_read_edge_model_params` key set (see appendix) |
| **A.3** | Restructure row builder: accept span kernel for y projection, keep existing x forecast | Span kernel in, existing denominator unchanged |
| **A.4** | **Single-hop parity gate**: v1 vs v2 on adjacent subjects, field-by-field | Required gate |
| **A.5** | **Multi-hop tests**: evidence parity + forecast convergence + frontier behaviour | Required gate |

---

## Revised Recommended Sequencing

**Updated 8-Apr-26**: The original "Phase A" has been decomposed into
two cleanly separable phases: **Phase A** (x→y span kernel — numerator
fix) and **Phase B** (upstream x provider — denominator improvement).
The broader forecast engine phases are renumbered accordingly.

| Phase | What | Why this order |
|-------|------|----------------|
| **A** | **x→y span kernel**: register `cohort_maturity_v2`, implement `compose_path_maturity_frames` + `compose_span_kernel`, restructure row builder to accept span kernel for y projection while keeping existing x forecast unchanged. Linear chains only. | Isolates the real numerator problem. Works in window() immediately, improves cohort() immediately. Existing x estimate is good enough for the common case (from-node = anchor). |
| **B** | **Upstream x provider**: replace the row builder's internal x forecast with an explicit `x_provider(s, τ)` input. Proper anchor-to-x propagation, branching graph support, frontier continuity guarantee. | Denominator-improvement phase. Only needed after span kernel is proven. Clean seam: span kernel consumes whatever x the provider delivers. |
| **0** | Design the forecast-state contract as a document, informed by Phases A+B | Forces precision; span kernel + x provider define the building blocks |
| **1** | Record the live cohort() blockers precisely (Step 4 above) | Prevents the contract from freezing stale assumptions |
| **2** | Fix the remaining cohort() maths in Python | Hard prerequisite for a reusable shipping engine |
| **3** | Implement the contract in Python + unify basis resolution | Backend-first, informed by corrected maths |
| **4** | Split layers and wire `cohort_maturity` to the new contract | First consumer validates the contract |
| **5** | Wire `surprise_gauge` to the same contract, retire FE duplication | Second consumer proves reusability |
| **6** | Parity and contract tests throughout | Gate for promoting the shared engine |

---

## Bottom Line

The multi-hop problem decomposes into two independent concerns:

1. **The x→y span kernel** (Phase A): "given arrival at x, what is the
   probability of reaching y by age τ?" — a conditional progression
   computed hop-by-hop from per-edge posteriors. This is the new
   capability that doesn't exist today.

2. **The upstream x estimate** (Phase B): "how does anchor-cohort mass
   reach x?" — an improvement to the existing denominator model. The
   current model (`reach × CDF_upstream`) is adequate for the common
   case (from-node = anchor, so reach = 1.0) and can be replaced later
   without touching the span kernel.

Phase A delivers user value immediately. Phase B improves accuracy for
edge cases. The broader forecast engine (Phases 0–6) generalises both
for all consumers. The span kernel is the stable seam between the two:
it consumes x as input and produces y as output, regardless of how x
is derived.
