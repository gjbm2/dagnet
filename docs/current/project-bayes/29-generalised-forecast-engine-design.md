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

#### Layer 4: Backend — path-level forecast params

`compute_cohort_maturity_rows` needs Bayes params for the path-level forecast. Currently it takes `edge_params` for a single edge.

For multi-hop, compose path-level params:

- **path_p**: Product of per-edge p values along the path: `p_path = Π pᵢ`. This is exact under conditional independence (each edge's conversion is independent given arrival at its from-node).
- **path CDF**: The path-level latency CDF is the convolution of per-edge shifted-lognormal CDFs. **Approximation for this phase**: use the `path_mu` / `path_sigma` / `path_onset_delta_days` already stored on the last edge's posterior (these are computed by the Bayes engine for the anchor→target path). When from-node = anchor, these are directly usable. When from-node ≠ anchor, they need adjustment (deconvolution of the prefix path) — defer this to the full DAG propagation phase.
- **Uncertainty**: Use the last edge's path-level posterior SDs (`bayes_path_mu_sd`, `bayes_path_sigma_sd`, etc.) as the path uncertainty estimate. This underestimates true path uncertainty (ignores upstream edge uncertainty) but is the best available without the full covariance structure.

**New function**: `compose_path_forecast_params(graph, path_edge_ids, is_window) → Dict[str, float]`. Returns the same key structure as `read_edge_cohort_params` but with path-level values.

**Known approximations** (documented, not hidden):
1. Per-edge p values are assumed independent (reasonable for most funnels)
2. Path CDF ≈ last edge's `path_mu`/`path_sigma` (correct only when from-node = anchor)
3. Path uncertainty ≈ last edge's path posterior SDs (underestimates)

The full DAG propagation (Phase 2 below) replaces these with correct values.

#### Layer 5: Backend — compute_cohort_maturity_rows adaptation

If `compose_path_maturity_frames` produces frames in the same schema as `derive_cohort_maturity` (with `x` = path denominator and `y` = path numerator), then `compute_cohort_maturity_rows` may need **no changes at all** — it already reads `x` and `y` from frames. The `x` in composed frames represents arrivals at A rather than arrivals at the last edge's from-node, but the function doesn't care — it sums and divides.

The only necessary change: pass the composed `path_params` instead of single-edge `edge_params` for the forecast/fan computation.

#### Layer 6: Frontend — chart rendering

No changes needed. The row schema is the same. The chart builder sums and divides — it does not know or care whether the underlying rate is edge-level or path-level.

The only cosmetic change: the chart title/subtitle should indicate it shows path rate (A→Z) rather than edge rate (Y→Z). This is a label change driven by the `subjectLabel` field already present in the subject metadata.

### Implementation sequence for A→Z maturity

| Step | What | Depends on | Risk |
|------|------|-----------|------|
| **A.0** | Add `from_node_uuid` and `to_node_uuid` as first-class fields on `SnapshotSubjectRequest` | — | Low: additive field |
| **A.1** | Implement `compose_path_maturity_frames()` in Python — pure function, no DB | — | Medium: join alignment |
| **A.2** | Implement `compose_path_forecast_params()` in Python — reads per-edge params from graph | — | Low: straightforward composition |
| **A.3** | Modify `_handle_snapshot_analyze_subjects` to detect multi-hop (`funnel_path` with >1 subject), compose frames and params, then call existing `compute_cohort_maturity_rows` | A.0, A.1, A.2 | Medium: handler plumbing |
| **A.4** | Tests: path-level evidence parity (compose y_Z/x_A from frames, compare against known rates from data repo) | A.1 | Required gate |
| **A.5** | Tests: path-level forecast convergence (as τ→∞, rate→path_p) | A.2 | Required gate |
| **A.6** | FE: pass from/to node UUIDs in subject requests | A.0 | Low |

### How this feeds into the broader forecast generalisation

After A→Z maturity is working:

1. **The forecast-state contract (Phase 0 above)** can be designed with multi-hop as a first-class concern — the composed frames and params from Steps A.1–A.2 become the reference implementation for "what path-level forecast state looks like".

2. **The four maths fixes (Phase 2 above)** replace the approximations:
   - Graph-wide x(s,τ) propagation replaces the `a × reach × CDF_path` shortcut and the first-edge-x-as-denominator join
   - τ-dependent Y_C replaces the composed-p × CDF approximation
   - Consistent probability bases replace the mixed window/cohort p values in composition
   - Unified tau_observed replaces the per-edge tau_max

3. **The unified resolver (Phase 3 above)** replaces `compose_path_forecast_params` with a proper resolution that accounts for sub-path semantics.

4. **The trajectory layer (Phase 4 above)** replaces `compose_path_maturity_frames` with DAG-propagated trajectories.

In other words: Steps A.1–A.2 are **deliberate scaffolding** that will be replaced by the correct implementations in Phases 2–4. They exist to deliver user value now while the harder maths is being developed. The scaffolding functions are clearly named, documented as approximate, and have parity tests that will validate their replacements.

### Post-doc-31 variant: what changes when BE owns subject resolution

**Added**: 7-Apr-26

Docs 30 (regime selection) and 31 (BE subject resolution) redesign how
analysis requests reach the backend. If Phase A is implemented *after*
docs 30+31, several steps simplify and one new concern emerges.

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

For multi-hop maturity the regimes selected for the **first edge** and
**last edge** must be **compatible** — both must represent the same
underlying cohort population. If different regimes are selected (e.g.
first edge uses `context(channel)` regime, last edge uses
`context(device)` regime), the composed rate `y_Z / x_A` is meaningless
because numerator and denominator count different populations.

**Proposed rule**: when composing path maturity, enforce that all path
edges use the **same regime family** for a given `(anchor_day,
retrieved_at)`. If no single regime covers all edges for that date, the
date is excluded from evidence (no composition). This is conservative
but correct — better to have a gap than a wrong number.

**Implementation**: `compose_path_maturity_frames()` receives regime
metadata per frame and filters to dates where the regime family is
consistent across all contributing edges.

#### Revised Phase A steps (post-doc-31)

| Step | What | Notes |
|------|------|-------|
| **A.1** | `compose_path_maturity_frames()` — pure function, no DB | Unchanged; add regime coherence filter |
| **A.2** | `compose_path_forecast_params()` — reads per-edge params from graph | Unchanged |
| **A.3** | Handler integration — BE resolves path from DSL, composes frames+params | Simpler: path structure available natively |
| **A.4** | Tests: evidence parity + regime coherence | Extended: verify correct exclusion of incoherent-regime dates |
| **A.5** | Tests: forecast convergence (τ→∞, rate→path_p) | Unchanged |

Steps A.0 and A.6 are eliminated entirely.

---

## Revised Recommended Sequencing

The original sequencing above assumed the forecast engine generalisation happens first. With A→Z maturity as a precursor, the revised sequencing is:

| Phase | What | Why this order |
|-------|------|----------------|
| **A** | Generalise cohort maturity to A→Z spans (Steps A.0–A.6 above) | Immediate user value; creates multi-hop consumer; uses documented approximations for forecast |
| **0** | Design the forecast-state contract as a document, informed by Phase A's multi-hop needs | Forces precision; Phase A reveals what "path-level" means concretely |
| **1** | Record the live cohort() blockers precisely (Step 4 above) | Prevents the contract from freezing stale assumptions |
| **2** | Fix the remaining cohort() maths blockers in Python — replaces Phase A's approximations | Hard prerequisite for a reusable shipping engine |
| **3** | Implement the contract in Python + unify basis resolution (Steps 1+2 above) | Backend-first, informed by corrected maths |
| **4** | Split layers and wire `cohort_maturity` to the new contract — replaces Phase A scaffolding | First consumer validates the contract |
| **5** | Wire `surprise_gauge` to the same contract and retire semantic duplication in the FE | Second consumer proves reusability |
| **6** | Parity and contract tests throughout, but especially before switching consumers | Gate for promoting the shared engine |

---

## Bottom Line

The reusable core is the **state model and propagation architecture**, not the current chart-specific formulas. The forecast-state contract (Phase 0) is the highest-leverage activity because it forces agreement on semantics before code proliferates. The cohort() maths fixes (Phase 2) are the hard gate — without them, generalisation means generalising bugs.

**However**, multi-hop cohort maturity (Phase A) can and should be delivered before the full generalisation. The evidence composition is exact (no approximation needed). The forecast composition uses documented approximations that work for the common case and are replaced by correct implementations in subsequent phases. This sequence delivers user value immediately, creates the first multi-hop consumer that validates the forecast-state contract, and makes the approximation/correctness boundary explicit rather than hidden.
