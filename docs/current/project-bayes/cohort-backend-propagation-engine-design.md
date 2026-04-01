# Backend Propagation Engine for `window()` and `cohort()` Queries

**Status**: Proposal  
**Date**: 1-Apr-26  
**Related**: `cohort-maturity-full-bayes-design.md`, `cohort-maturity-fan-chart-spec.md`, `cohort-maturity-project-overview.md`, `11-snapshot-evidence-assembly.md`, `18-compiler-journal.md`, `../codebase/RESERVED_QUERY_TERMS_GLOSSARY.md`

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

## 9. Two consumer modes

The engine should expose two public modes built on the same core.

The first is scalar mode for graph overlays. It evaluates the active
query frontier only and returns per-edge query-time outputs such as
completeness, `p.mean`, `p.n`, forecast mass, and debug or provenance
information. This mode is meant to update the graph view after the FE
has already shown a provisional approximation.

The second is trajectory mode for analysis consumers. For
`cohort_maturity`, it evaluates the same graph-wide state across a `tau`
grid for the selected subject edge and returns per-`tau` aggregated rows
plus optional per-Cohort diagnostics. Other forecasted analyses could
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

## 10. File surface and likely implementation shape

The new engine should live in `graph-editor/lib/runner/` near the
existing cohort machinery, not in the FE stats pass. A new module is
likely cleaner than continuing to accrete logic inside
`cohort_forecast.py`, because the new engine has a broader scope than
one chart.

The existing modules that should be reused rather than replaced are
`graph-editor/lib/snapshot_service.py` for raw reads,
`graph-editor/lib/runner/cohort_maturity_derivation.py` for subject-edge
frame derivation where still useful, and the FE snapshot-subject
planning stack under `graph-editor/src/services/`.
`graph-editor/lib/api_handlers.py` should become a thin orchestration
layer that requests either scalar mode or trajectory mode from the new
backend engine.

The existing FE fast path in
`graph-editor/src/services/statisticalEnhancementService.ts` should
remain in place initially as a provisional approximation. The BE engine
should arrive as a second-stage authoritative answer, not as a
prerequisite for every UI interaction.

## 11. Recommended delivery phases

Phase 1 should fix the hash-family plumbing for analysis so the BE reads
the same snapshot family as Bayes fitting and fetch coverage. Without
that, graph-wide evidence binding will remain inconsistent regardless of
forecasting quality.

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
