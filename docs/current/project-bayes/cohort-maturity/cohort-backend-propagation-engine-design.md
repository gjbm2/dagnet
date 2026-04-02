# Backend Propagation Engine for `window()` and `cohort()` Queries

**Status**: Proposal  
**Date**: 1-Apr-26  
**Related**: `cohort-maturity-full-bayes-design.md`, `cohort-maturity-fan-chart-spec.md`, `cohort-maturity-project-overview.md`, `../11-snapshot-evidence-assembly.md`, `../18-compiler-journal.md`, `../../codebase/RESERVED_QUERY_TERMS_GLOSSARY.md`

---

## 1. Purpose

This note proposes an authoritative backend engine for snapshot-backed
query forecasting over the graph. The engine should consume FE-planned
snapshot subjects, bind snapshot evidence for all relevant edges, walk
the graph in topological order, and produce query-time forecast state
that can serve both graph scalars and analysis consumers.

The motivation is that the current FE stats pass is a reasonable fast
approximation for cache-backed UI updates, but the current BE
`cohort_maturity` path still inherits ratio-based shortcuts for upstream `x` and
therefore shows their failure modes clearly in fans and immature
Cohorts.

The design should cover both `window()` and `cohort()` queries. The
hardest unsolved issues are in `cohort()` mode, so that branch receives
more detail below, but the intended engine is shared.

The goal is not to replace the FE fast path on day one. The goal is to
establish one authoritative BE computation that can return a better
answer moments later, while the FE continues to supply a provisional
approximation immediately after QueryDSL changes.

### Storage and schema posture

This proposal does **not** assume snapshot DB schema changes or
parameter-file schema changes.

It is primarily a new BE computation path that consumes data already
present in the system:

- FE-planned `snapshot_subjects`
- snapshot DB rows (`a`, `x`, `y`, lag fields, `retrieved_at`)
- projected graph posteriors / model vars for the active slice
- fit-history or posterior resolution for `asat()`

The only likely contract changes are transient request/response shape
changes, such as carrying richer subject metadata, provenance, quality
flags, or BE-computed outputs back to the FE. Persisted storage is not
the intended place for this query-time forecast state.

### Terminology

In this note, **Cohort** means the user group attached to one
`anchor_day` in snapshot data: the people who did the anchor action on a
given date.

In this note, `cohort` or `cohort()` means the query semantics where
that date-anchored group is analysed over an `a-x-y` edge. This is the
modelling mode, not the population itself.

### QueryDSL contract

The engine must treat the incoming QueryDSL as part of the computation
contract, not just as a way to fetch some nearby data.

For `window()` queries, the BE should retain the current fixed-`x`
semantics: the denominator is edge-local, `x` is fixed within the
window-anchored subject, the relevant Cohort is defined at the
`from_node`, and no graph-wide moving-`x` propagation is needed to
define the denominator.

For `cohort()` queries, the BE must use `a-x-y` semantics explicitly:
the subject is a Cohort anchored at `a`, `x` is a moving quantity
because arrivals to the from-node are still maturing upstream, and the
authoritative answer requires graph-aware propagation rather than an
edge-local shortcut.

If `asat()` is present, the engine must treat it as an explicit
point-in-time frontier. It must therefore affect both evidence and
posterior consumption:

- snapshot evidence must be read only from rows available on or before
  the requested `asat()` time
- sweep-based reads must cap their upper bound at `asat()`, not wall
  clock "now"
- posterior or fit-history selection must also resolve "on or before
  `asat()`", not silently use a newer fit

This matters for both `window()` and `cohort()` queries. `asat()` is not
just a rendering annotation; it changes what the BE is allowed to
consider known.

Contexted, case-constrained, or otherwise sliced queries must preserve
slice isolation. The BE must bind only the FE-planned snapshot family
defined by `param_id`, seed `core_hash`, `equivalent_hashes`, and
`slice_keys`. Context must not be widened or implicitly dropped inside
the BE just because the fetch planner already handled it.

### FE commissioning and display flow

The intended runtime behaviour is:

1. The FE commissions the BE when QueryDSL or scenario state changes.
2. The FE waits a short grace period for an authoritative BE answer.
3. If no BE answer is ready within that grace period, the FE renders the
   current FE stats approximation as a provisional answer.
4. If the BE later returns an authoritative answer, the FE swaps the
   displayed values to the BE result.

The BE response should be treated as a **best-efforts upgrade**, not a
promise that every query will receive an authoritative answer. The BE is
allowed to decline to upgrade the FE result when the required basis is
not present.

The gating conditions for a BE upgrade should be explicit in the
response contract:

- usable Bayes model vars or posterior slices are available for the
  active query and active source
- snapshot evidence coverage is adequate for the requested edges and
  slices
- the query mode and `asat()` frontier are supported by the available
  evidence and posterior history
- any quality checks required for the relevant consumer mode pass

If these gates fail, the FE should keep the provisional FE answer and
surface provenance that no authoritative BE upgrade was available. A BE
"no upgrade" outcome is informative and should not be treated as an
error.

## 2. Current state and deficiency

Current graph-side forecasting is split across two approximations.
First, `graph-editor/src/services/statisticalEnhancementService.ts`
computes scalar `latency.completeness`, `p.mean`, and `p.n` from a
path-aware but compressed view of the active query. In `cohort()` mode
it collapses the active Cohorts into weighted completeness, blends local
evidence with a baseline forecast, and propagates expected mass
topologically as
`forecast_k`.

Second, `graph-editor/lib/runner/cohort_forecast.py` has access to raw
sweep rows for the subject edge, but still forecasts `cohort()`-mode `x`
from local frozen values plus upstream summary CDF and rate
approximations. It does not bind and sweep the upstream edges' own
Cohort histories per anchor day, and it does not derive graph-wide state
from one shared topological propagation pass.

This split is tolerable for fast scalar updates, but it is not strong
enough for a proper cohort-maturity fan chart. The edge cases that are
hidden in a single scalar become obvious when the backend must produce
per-Cohort forward paths, upstream `x` growth, joins, and Monte Carlo
bands across immature Cohorts.

## 3. Proposal overview

Introduce a backend graph propagation engine that works from the
beginning of the graph to the end for the active QueryDSL slice. The engine
should bind snapshot evidence for every relevant edge in the slice,
derive per-edge per-Cohort frozen observation state, then propagate
forecast state downstream in topological order.

The core rule is that the engine's primary output is not just
`completeness` or `p.mean`. Its primary output is per-edge, per-Cohort
forecast state at the query frontier and, when requested, across a `tau`
grid. Scalars, chart rows, and diagnostics are derived views of that
state.

This creates one authoritative computation for two classes of consumer:
graph overlays for the currently selected QueryDSL, and analysis views
such as `cohort_maturity`. The FE remains rendering-only and may continue to show a
provisional fast path until the BE result arrives.

## 4. Inputs and prerequisites

The engine should consume the scenario graph after slice-specific
posterior projection, the FE-planned `snapshot_subjects` for the active
query, and the snapshot DB rows returned for those subjects. It also
needs the existing edge and path posterior summaries already present on
the graph, including path latency params for `cohort()` mode and
point-in-time posterior selection when `asat()` is present.

A hard prerequisite is that analysis subjects carry the same FE-computed
hash family used elsewhere for evidence binding. The FE planner must
send both the seed `core_hash` and `equivalent_hashes`, and the BE read
path must use them unchanged. This is a separate plumbing fix, but the
propagation engine should assume that contract.

The engine must also preserve the current distinction between fast
provisional FE computation and authoritative BE computation. This
proposal is about better BE consumption of existing evidence, not about
moving maths back into the FE.

## 5. Primitive state model

The engine should build and keep explicit state objects rather than
jumping straight to aggregate scalars.

For each edge and Cohort anchor day, it should derive an evidence object
containing the bound snapshot history, the latest observed retrieval in
scope, the frozen `a`, `x`, and `y`, the observation frontier age, and
the slice-specific posterior params needed for forward projection.

From that it should derive a forecast state object for the query
frontier and, when needed, for a full `tau` grid. That state should
include forecast `x`, forecast `y`, the implied edge rate `y/x`,
maturity or completeness measures, and provenance flags describing
whether the point is observed, carried forward, or forecast.

For nodes, the engine does not need a separate persisted long-term
artefact, but it does need a transient arrival-state during propagation.
In `cohort()` mode, the downstream edge's `x` for a given Cohort is the sum
of forecast `y` from the incident upstream edges for that same Cohort
and draw. That transient node state is what the current code
approximates but does not model explicitly.

## 6. Binding and freezing stage

Before any propagation, the engine should bind snapshot rows for all
relevant edges using the FE-planned subjects and group them by edge,
slice family, and anchor day. This stage should reuse the existing
snapshot DB query and evidence-binding machinery rather than introducing
a new ad hoc read path.

For each edge and Cohort day, the engine should derive a frozen local
observation state at the query frontier. This is the local object the
edge can condition on directly: observed arrivals to the from-node,
observed conversions on the edge, the current age, and the local
posterior slice.

This stage should be graph-wide, not subject-edge-only. The whole point
is to make upstream evidence available as first-class input to
downstream `x` forecasting, rather than collapsing upstream behaviour
into one summary curve or one last frame.

## 7. Topological propagation stage

After binding, the engine should walk the graph in topological order
from anchor or start nodes to sinks. Leading edges have a simple base
case because their from-node population is known directly from the
anchor Cohort. Non-leading edges obtain their `x` from node arrival
state accumulated from upstream edges.

In `window()` mode, many edges will take the simpler branch: local
evidence is enough to define the denominator, `x` is fixed for the
window-anchored subject, and no moving-`x` graph solve is needed to
interpret the edge rate. Even there, the same engine is still useful for
consistent evidence binding, `asat()` handling, posterior selection, and
authoritative scalar production.

In `cohort()` mode, the engine must take the fuller branch: `x` is not
fixed, arrivals to the from-node are still maturing upstream, and the
state at one edge depends on forecast state from incident upstream
edges.

For each edge and Cohort, `y` forecasting remains local to that edge:
use the edge's own frozen `x` and `y`, its own posterior slice, and its
own maturity model to forecast conversions conditional on arrivals
already at the edge. The hard part is `x`, and the engine should resolve
that by deriving it from upstream incident-edge `y`, not from a direct
local ratio shortcut.

At joins, node arrival state is the sum across all active incident
upstream edges for the same Cohort. This is not optional bookkeeping; it
is the graph identity that keeps `x` and `y` coherent. The current
"pick one upstream edge" or "use one upstream summary curve" shortcuts
should disappear from the authoritative BE path.

### 7.1 Join semantics under incomplete inputs

The graph builder enforces a DAG (`nx.is_directed_acyclic_graph` at
build time), so topological ordering is guaranteed. The harder problem
is that real joins will routinely have incomplete inputs.

For each incoming edge at a join, the engine has one of four levels of
basis for forecasting `y` on that edge:

1. **Promoted model vars + Cohort evidence.** Full posterior
   predictive: the edge's fitted posterior updated with this Cohort
   day's observed `(x, y)`. This is the best case.

2. **Promoted model vars, no evidence for this Cohort day.** Prior
   predictive: the fitted posterior applied with no Cohort-specific
   observation update. Uncertainty is wider but the forecast is still
   model-informed. This is also what handles mismatched anchor-day
   ranges — if edge A has Cohorts {1-Jan to 31-Mar} and edge B has
   {1-Feb to 30-Apr}, the engine takes the union of anchor days and
   each edge uses its prior predictive for days outside its evidence
   range.

3. **No promoted model vars + Cohort evidence.** The Bayes fit failed
   quality gates, so no posterior exists, but snapshot rows are
   available. The engine should use the edge's frequentist `p.mean`
   and latency params as a point-estimate fallback:
   `y_forecast(d, τ) = p.mean × x_frozen(d) × CDF(τ) / CDF(τ_max)`.
   This is essentially the current ratio-based path — not
   authoritative, but grounded in real data. No MC draws are possible
   for this edge; it contributes a deterministic term to the join.

4. **No promoted model vars, no evidence.** The engine should use the
   same frequentist `p.mean × a_d × CDF(τ)` as a weak point
   estimate. This is the least reliable tier.

The important property is that the engine does not branch on these
cases. It evaluates every (edge, Cohort day) pair with whatever basis
is available, and the quality of the forecast degrades continuously as
the basis weakens. No special-case rules, no intersection logic, no
"require all incoming edges" gates.

**Provenance tracking and surfacing.** The engine should tag each
edge contribution at a join with its basis tier (1–4). This metadata
flows through three existing systems:

*Engine response contract.* The BE response for each subject edge
should include a `propagation_quality` block:

- `upstream_basis`: map of upstream edge ID → basis tier used
- `evidence_backed_mass_frac`: fraction of arrival mass from tiers
  1–2 vs tiers 3–4
- `has_point_estimate_upstream`: boolean — true if any incoming edge
  contributed a deterministic-only term (tiers 3–4)

*Graph issues* (`graphIssuesService` / `integrityCheckService`). When
the engine detects tier 3–4 upstream edges feeding a join, it should
emit a graph issue with `category: 'semantic'`, `severity: 'warning'`,
attached to the downstream edge's `edgeUuid`. Message:
"Upstream edge {id} has no promoted model — fan bands at this edge
understate uncertainty." This appears in the existing
GraphIssuesViewer and the canvas indicator overlay. It is a static
structural fact about the graph, not a per-query transient.

*Forecast quality overlay* (`forecast-quality` view overlay mode).
The existing `computeQualityTier()` evaluates per-edge posterior
health and drives the quality tier bead in `EdgeBeads` when the
`forecast-quality` overlay is active. The propagation engine should
elaborate this construct rather than creating a parallel reporting
path.

Concretely: `computeQualityTier()` currently scores based on the
edge's own posterior diagnostics (rhat, ESS, divergences, evidence
grade). The engine should extend this with an upstream propagation
dimension: even if this edge has a healthy posterior, its forecast
quality is degraded if upstream joins fed it point-estimate-only
mass. When `has_point_estimate_upstream` is true, the effective
quality tier should be capped at `'warning'` with `reason` indicating
the upstream gap. This flows through the existing forecast-quality
bead colour and tooltip without new UI components.

*Chart-level indicator.* The `cohort_maturity` chart should display a
small warning icon when `has_point_estimate_upstream` is true in the
response. Tooltip: "Fan bands may be narrower than true uncertainty —
one or more upstream edges lacked a Bayesian model." No band style
changes, no shaded regions — a single indicator that the fan is
conditional on point-estimate upstream assumptions.

## 8. Deterministic and Monte Carlo execution

The same engine should support two execution styles.

The fast deterministic style uses posterior means and returns
current-frontier graph scalars quickly. This is the likely default for
graph refresh after a QueryDSL change.

The full Monte Carlo style samples one shared draw per edge posterior
for a scenario and reuses those same draws consistently through the
whole graph. Within a draw, upstream `y` forecasts feed downstream `x`,
and joins sum upstream mass before downstream forecasting proceeds.
Quantiles are taken only after the graph-wide propagation is complete.
This is the mode `cohort_maturity` needs for midpoint and fan bands.

The critical rule is that uncertainty must be propagated through the
graph, not added afterwards from marginal summaries. Summing upstream
quantiles or using separately sampled upstream and downstream paths would
break covariance structure and yield visibly wrong fan behaviour.

### 8.1 Cross-edge posterior independence and the partition problem

The current per-edge MC draws from `MVN(θ_e, Σ_e)` where
`θ = [p, μ, σ, onset]`, independently per edge. Within a single edge
this is correct: the covariance between onset and μ is captured in Σ,
and the draws produce well-behaved fans.

The graph propagation engine introduces a structural coupling that the
independent-draw model does not account for: **shared denominators at
fan-out nodes**.

Consider node F with one upstream edge U and two downstream edges D1
and D2. Under the proposed engine:

- At draw `b`, the engine samples `θ_U^(b)` and propagates
  `y_U^(b)(τ)` forward. This becomes the shared denominator
  `x_{D1}^(b) = x_{D2}^(b)`.
- D1 and D2 each draw their own `θ_{D1}^(b)` and `θ_{D2}^(b)`
  independently.
- The engine then computes `y_{D1}^(b)` and `y_{D2}^(b)` from
  these independent draws, each conditional on the shared `x^(b)`.

Two problems arise from this:

**Denominator-induced spurious correlation.** When the upstream draw
happens to be high (large `x^(b)`), both D1 and D2 see a large
denominator. Their posterior rates are pulled toward their prior means
because the large denominator dilutes the evidence signal. When the
upstream draw is low, both rates become more volatile. This creates a
correlation structure in downstream rates that is an artefact of the
sampling scheme, not a reflection of real uncertainty. In a single-
edge fan display (the primary `cohort_maturity` consumer), this
distortion is invisible because only one edge's marginal fan is
shown. It would become visible if the engine ever needed to display
joint fans across sibling edges.

**Mass conservation violation.** If D1 and D2 are the only outflows
from node F, then `y_{D1} + y_{D2} ≤ x` must hold — you cannot
convert more people than arrived. But because D1 and D2 draw rates
independently, some draws will produce `y_{D1}^(b) + y_{D2}^(b) >
x^(b)`. These are impossible paths. For a single-edge fan the
violation is hidden (each edge's marginal fan is valid in isolation),
but it means the sampled joint distribution includes physically
impossible states.

**Why the current single-edge code avoids this.** Today, the MC in
`cohort_forecast.py` uses a point-estimate upstream CDF (scalar
`up_p`, `up_mu`, `up_sigma`) — it does not draw from the upstream
posterior. This means upstream uncertainty is ignored entirely, but
the denominator is constant across draws, so no spurious correlation
or partition violation occurs. The proposed engine deliberately
introduces upstream draws to capture upstream uncertainty, which is
the right goal, but it inherits these two structural side-effects.

**Recommended posture for Phase 3.** For the primary consumer (single-
edge `cohort_maturity` trajectory), the independent-draw-per-edge
scheme with shared upstream `x` is an acceptable mean-field
approximation. Each edge's marginal fan is correct in shape and
width; only the joint distribution across sibling edges is
approximate. The engine should:

1. Document this as a known approximation in the response contract.
2. Clip per-draw `y_e^(b)` to `[0, x^(b)]` at each edge to prevent
   individual edges from exceeding their denominator in any single
   draw.
3. Not attempt to enforce the sum constraint `Σ y_e ≤ x` across
   sibling edges in Phase 3. This would require Dirichlet partition
   sampling or a copula, which is additional modelling complexity that
   is not justified until joint fan display is a real consumer need.

If a future consumer requires joint fans across sibling edges (e.g. a
stacked area chart of outflows from one node), the right fix is
Dirichlet partition sampling: at each fan-out node, sample a
Dirichlet over outgoing edge rates conditional on the node's arrival
mass, so that draws respect the partition constraint by construction.
This is a modelling extension, not a bug fix, and should be scoped
separately.

## 9. Two consumer modes

The engine should expose two public modes built on the same core.

The first is scalar mode for graph overlays. It evaluates the active
query frontier only and returns per-edge query-time outputs such as
completeness, `p.mean`, `p.n`, forecast mass, and debug or provenance
information. This mode is meant to update the graph view after the FE
has already shown a provisional approximation. The FE commissions this
per scenario; the BE returns aggregate scalars that flow into param
packs — the existing carrier for per-scenario derived state.

The second is trajectory mode for analysis consumers. For
`cohort_maturity`, it evaluates the same graph-wide state across a `tau`
grid for the selected subject edge and returns per-`tau` aggregated rows
plus optional per-Cohort diagnostics. The FE commissions this
separately, sending all visible scenario graphs and snapshot subjects
in a single multi-scenario request. Other forecasted analyses could
reuse the same machinery with simpler `window()` semantics. This removes
the current duplication where graph scalars and analysis rows are
derived from different approximations.

In both modes the FE remains a consumer, not a calculator. The BE should
return authoritative state or derived views, and the FE should swap them
in without recomputing the underlying maths.

The FE should also preserve provenance in the display surface. At
minimum the UI needs to distinguish:

- provisional FE approximation
- authoritative BE result
- BE unavailable / insufficient basis

That distinction is part of the user contract; otherwise the fallback
path becomes invisible and analysts cannot tell whether they are seeing
the approximate or authoritative answer.

### 9.1 State model: what persists, what is recomputed

**Param packs carry aggregate scalars only.** The BE stats pass
(scalar mode) returns per-edge `p.mean`, `completeness`,
`forecast.mean`, `p.n`, and `forecast_k` — the same quantities the
FE currently approximates, but derived from graph-aware topological
propagation. These flow into param packs per scenario, which is the
existing mechanism for per-scenario derived state on the canvas.
Param packs are not extended with per-Cohort-day data.

**Per-Cohort-day state is not persisted.** The graph walk that derives
per-Cohort `x_propagated(d)`, `completeness(d)`, and `basis_tier(d)`
is deterministic and sub-millisecond for realistic graph sizes (10
edges × 100 Cohort days ≈ 1000 posterior-predictive evaluations,
fully vectorised). It is cheap enough to recompute per analysis
commission. The analysis handler already receives all scenario graphs
and snapshot subjects in the request; it has everything it needs to
redo the walk without cached intermediates.

**Consequence: no shared state between scalar and trajectory modes.**
The two modes share Python libraries and the propagation algorithm,
but not data. The FE sends snapshot subjects to the BE for the stats
pass, and sends them again when it commissions an analysis chart.
This is redundant at the data level but architecturally simple: no
cross-request cache, no stale-state management, no coupling between
the two commission lifecycles.

**Escape hatch.** If graph scale grows to the point where the
deterministic walk becomes expensive (many more edges, much deeper
Cohort history), param packs could be extended with a richer
per-Cohort structure. This would be a nested object within the param
pack, suppressed from the scenario palette edit modal UI but
available to BE analysis handlers. This is not needed for the initial
design and should be deferred until profiling shows recomputation is
a bottleneck.

## 10. Library decomposition and reuse

The propagation engine decomposes into six capabilities. Four are
shared libraries reusable by both the scalar stats pass and
`cohort_maturity` analysis. Two are mode-specific.

### 10.1 Shared libraries (new)

These do not exist today as standalone functions. They are currently
either absent, inlined in the MC loop, or approximated by shortcuts.

**Graph-wide evidence binder.** Takes FE-planned snapshot subjects
for all edges in the active slice, queries the snapshot DB via
`snapshot_service.query_snapshots_for_sweep()`, and returns a
structured binding: `Dict[edge_id, Dict[anchor_day,
FrozenObservation]]` where `FrozenObservation` holds `(a, x_frozen,
y_frozen, age, retrieved_at, slice_key)`.

Today: `stats_engine.enhance_graph_latencies()` receives
pre-aggregated `CohortData` per edge — it does not bind from
snapshot rows directly. `cohort_forecast.compute_cohort_maturity_rows()`
binds evidence for the subject edge only. The new binder does
graph-wide binding in one pass.

Reuse by `cohort_maturity`: replaces the per-subject-edge binding
currently done via `cohort_maturity_derivation.derive_cohort_maturity()`
for upstream edges. The subject edge's own frame derivation may still
use the existing derivation module for its richer per-retrieval-day
frame history.

**Per-Cohort posterior predictive evaluator.** Given `(x_frozen,
y_frozen, age)` and a posterior slice `(α, β, μ, σ, onset)`,
computes `y_forecast(τ)` using the Bayesian posterior predictive
formula from `cohort-maturity-full-bayes-design.md` §7.

Today: this formula is implemented in `cohort_forecast.py` (lines
945–976) but embedded inside the MC loop, not callable
independently. The new library factors it out as a pure function:
`posterior_predictive_y(frozen, posterior, tau_grid) → array`.

Reuse by `cohort_maturity`: the chart's midpoint and per-MC-draw `y`
both call this same function. Currently they do, but through the
monolithic `compute_cohort_maturity_rows`.

**Topological `x` propagator for `cohort()` mode.** Walks the graph
in topological order. At each node, sums `y_forecast` from all
incoming edges per Cohort day to produce `x_propagated(d)` for each
outgoing edge. Leading edges (from anchor/start nodes) get
`x_propagated = a_d` directly from the Cohort anchor population.

Today: does not exist. `stats_engine` propagates `forecast_k`
(aggregate scalar) topologically. `cohort_forecast` uses the
CDF-ratio shortcut with a hard guard at 0.01 (line 789). The new
propagator works per Cohort day using the posterior predictive
evaluator above.

Reuse by `cohort_maturity`: this is the core fix for the chart's
upstream `x` problem. The chart calls the propagator to get
per-Cohort-day `x_propagated` instead of using the ratio shortcut.

**Basis-tier resolver.** For each `(edge, Cohort day)`, determines
which of the four basis tiers (Section 7.1) applies: (1) promoted
model + evidence, (2) promoted model only, (3) no model +
evidence, (4) nothing. Selects the forecasting path accordingly and
tags provenance.

Today: does not exist. The current code either has a posterior or
doesn't, with no structured fallback chain.

Reuse by `cohort_maturity`: the chart needs the same resolution to
decide per-Cohort whether to use posterior predictive or
point-estimate fallback, and to report provenance in the response.

### 10.2 Mode-specific capabilities

**Deterministic frontier aggregation (scalar mode only).** Collapses
per-Cohort-day propagated state into aggregate per-edge scalars:
`p.mean`, `completeness`, `p.n`, `forecast_k`. This is the output
that flows into param packs. `cohort_maturity` does not need this —
it works per Cohort day, not aggregate.

This extends or replaces the current
`stats_engine.enhance_graph_latencies()` topological pass. The
existing Fenton-Wilkinson path composition, `compute_blended_mean`,
and `compute_completeness` remain useful within this aggregation
step.

**Graph-wide MC with shared upstream draws (trajectory mode only).**
Samples posteriors per edge, propagates draws through the graph via
the topological `x` propagator, collects quantiles after the full
walk. This is the primary consumer for `cohort_maturity` fan bands.

Today: the MC in `cohort_forecast.py` (lines 682–846) samples
per-edge and uses point-estimate upstream CDF. The new version
replaces the upstream CDF with per-draw propagated `x` from the
shared topological propagator. The per-draw `y` formula, quantile
extraction, and fan-band output remain largely unchanged.

### 10.3 File surface

The shared libraries (10.1) should live in a new module in
`graph-editor/lib/runner/`, separate from `cohort_forecast.py` and
`stats_engine.py`. Both consumers import from it.

The existing modules that should be reused rather than replaced are
`snapshot_service.py` for raw DB reads,
`cohort_maturity_derivation.py` for subject-edge frame derivation
where still useful, `forecast_application.compute_completeness()`
for the maturity model, and the FE snapshot-subject planning stack
under `graph-editor/src/services/`.

`api_handlers.py` should become a thin orchestration layer that
calls the shared libraries + mode-specific logic for each
commission type.

The existing FE fast path in
`graph-editor/src/services/statisticalEnhancementService.ts` should
remain in place initially as a provisional approximation. The BE
engine should arrive as a second-stage authoritative answer, not as
a prerequisite for every UI interaction.

## 11. Recommended delivery phases

Phase 1 (complete): hash-family plumbing. `equivalent_hashes` now flows
end-to-end from FE planning (`getClosureSet`) through
`graphComputeClient` request construction to `api_handlers.py`
extraction and forwarding to all `snapshot_service` query paths. The BE
reads the same snapshot family as Bayes fitting and fetch coverage.

Phase 2 should implement scalar mode in the BE using graph-wide binding
plus mode-aware propagation at the current query frontier. This gives a
useful authoritative overlay for both `window()` and `cohort()` queries
without requiring full `tau`-grid work.

Phase 3 should reimplement `cohort_maturity` trajectory mode on top of
the same engine, including shared-draw Monte Carlo and join-safe
propagation.

Phase 4 can retire or narrow the current ratio-based cohort-mode logic
in `cohort_forecast.py` once the new engine is trusted.

## 12. Non-goals and cautions

This proposal does not require a new inference model. It is a
consumption and propagation design built on top of the existing snapshot
evidence and posterior slices.

It also does not require new persisted schema for forecast state. The
authoritative outputs are query-time BE results, with the FE fast path
remaining as a provisional fallback while those results are pending or
unavailable.

It should not persist query-specific forecast state back to parameter
files or treat transient BE outputs as long-term graph truth. These are
per-query, per-scenario results.

It should also avoid inventing a new parallel FE maths path. The current
FE approximation is acceptable as a temporary fast path, but the
authoritative calculation should live in one place in the BE.
