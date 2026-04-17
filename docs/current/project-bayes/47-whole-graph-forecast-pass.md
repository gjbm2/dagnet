# 47 — Whole-Graph Conditioned Forecast Pass

**Date**: 17-Apr-26
**Status**: Design — not yet implemented
**Depends on**: Doc 29 (generalised forecast engine), doc 30 (snapshot
regime selection contract), doc 31 (BE subject resolution), doc 45
(forecast parity separation), doc 46 (v3 cohort midpoint inflation caveat)

## Problem

The conditioned forecast handler (`handle_conditioned_forecast`) was
built as a subject-scoped call — it mirrors the v3 chart handler,
processing ONE edge span per request. The FE fires it with the
global temporal DSL but no analytics DSL (`from(X).to(Y)`), so
subject resolution fails and the handler returns zero edges.

Even if the analytics DSL were provided, the handler can only
process one edge per call. Running it per-edge independently would
be wasteful (redundant snapshot queries, redundant carrier building)
and wrong (misses topological dependencies where upstream carriers
feed downstream edges).

The conditioned forecast is a **graph enrichment pass**, not a
per-subject analysis. It must walk the full graph in topological
order, computing p.mean for every edge in a single request, with
upstream results feeding downstream carriers.

## Design target and caveat

**Long-term target**:

> The graph edge scalar and the cohort maturity chart read the same
> conditioned sweep output for a given edge, temporal mode, and date
> range. The graph reads scalars; the chart reads the trajectory.

This is the real architectural invariant: one computation, two reads.

**Temporary migration gate**:

> Until doc 46 is resolved, the whole-graph pass must reproduce the
> current v3 midpoint at tau_max for the same edge, temporal mode, and
> date range.

Doc 46 records that current v3 cohort midpoints are still suspect in at
least one important cohort-mode case. So v3 parity is a migration safety
oracle, not yet the final correctness proof. The design should target
shared computation with v3, but should not describe today's v3 midpoint
as unquestioned truth.

## Architecture

### Single entry point

The handler receives the graph and temporal DSL. It does NOT receive
an analytics DSL — it processes ALL edges. Per scenario, the handler:

1. Resolves per-edge anchors for the graph
2. Builds a topological order of graph nodes (Kahn's algorithm)
3. Walks nodes in topo order, accumulating per-node arrival state
4. For each edge: resolves model, queries snapshots, builds evidence,
   runs the MC sweep, extracts scalars
5. Returns per-edge results for ALL eligible edges in the response

### Phase 1: Graph-level preparation (once per scenario)

**Anchor map, not one global anchor.** Precompute `anchor_node_id` per
edge, using `compute_all_anchor_nodes(graph)` or equivalent. Using the
first edge's anchor as a scenario-global anchor is only safe on graphs
with a single upstream start. The whole-graph pass should support the
general case and let each edge use its own resolved anchor.

**Topological sort.** Kahn's algorithm on graph nodes using in-degree
counting. Upstream start nodes come first. Determines edge processing
order: edge `u→v` is processed after node `u`'s arrival state is cached.

**Temporal mode.** Derive `is_window` from the temporal DSL. Constant
across all edges in a scenario.

**Date range.** Parse `anchor_from`, `anchor_to`, `sweep_from`,
`sweep_to` from the temporal DSL. Constant across all edges.

**Candidate regimes.** FE sends `candidate_regimes_by_edge` keyed by
edge UUID. Used during per-edge regime selection.

**Eligible edges.** Only parameterised edges with usable model params
and candidate regimes participate in the sweep. Structural-only edges,
edges with no parameter identity, and edges with no usable evidence are
recorded as skipped with structured reasons.

### Phase 2: Per-edge subject resolution (reuse doc 31 contract)

The handler should NOT invent a second BE subject-synthesis path by
reading raw edge metadata ad hoc. Instead, extend the doc 31 BE subject
resolution path with a graph-wide analysis type (for example
`conditioned_forecast` or `graph_forecast`) whose scope rule is
`all_graph_parameters`.

That gives the handler a resolved per-edge subject set using the same
contract as the existing analysis path:

- `edge_uuid`, `from_node`, `to_node`, and path metadata come from the
  BE resolver, not bespoke graph walking in the handler.
- `candidate_regimes` come from the FE-provided
  `candidate_regimes_by_edge` map keyed by resolved edge UUID.
- The broad snapshot read contract stays the same as doc 30/doc 31:
  subjects do a broad read and regime selection narrows later.
- `slice_keys` therefore stay as the broad read (`['']`) rather than
  being narrowed from the temporal DSL before the query.

This matters because the current regime-selection architecture relies on
one broad read over the candidate hash family, with per-date regime
selection afterwards. Narrowing the read too early would break
uncontexted fallback, mixed-era coverage, and hash-mapping recovery.

### Phase 3: Snapshot data fetch (batched, one DB round-trip)

All edges share the same temporal window. Collect every hash from every
candidate regime family (primary + equivalents) across all resolved
edges, then issue one broad batched query over that full hash set.

Critical contract details:

- The batch query is a **discovery read**, not the final evidence set.
- It remains a broad read (`slice_keys=['']`) so doc 30 regime
  selection can decide which family wins per `retrieved_at`.
- Per edge, the handler assembles that edge's candidate-family rows by
  taking the union of all rows whose `core_hash` belongs to one of the
  edge's candidate regimes, then applies the existing regime selection
  utility / temporal ordering logic.
- Do NOT index evidence only by the candidate's primary `core_hash`.
  That would miss rows that exist only under equivalent hashes or
  lower-preference fallback families.

This keeps the whole-graph pass inside the same regime-selection
contract already used by the BE analysis path. If the current
`query_snapshots_for_sweep_batch` return shape makes per-edge family
assembly awkward, extend that helper rather than weakening the broad
read contract.

### Phase 4: Per-node arrival state (parity-critical carrier fidelity)

Reuse the topo-order cache structure from `forecast_state.py`, but do
NOT ship the current `upstream_obs=None` cache as the parity
implementation. That cache only has parametric / weak-prior information
and is known to be lower fidelity than the current v3 handler on edges
where empirical upstream evidence is available.

The whole-graph pass should therefore extend the cache builder so node
arrivals can consume empirical upstream observations derived from the
Phase 3 snapshot rows / frames. The goal is that an edge that currently
gets a Tier 2 empirical carrier in v3 does not silently downgrade to a
Tier 1 or Tier 3 carrier in the whole-graph pass.

Parametric / weak-prior fallbacks remain valid when empirical upstream
evidence is genuinely absent, but they are sparse-data fallbacks, not
the initial parity design.

The cache is built ONCE per scenario and shared by all downstream
edges.

### Phase 5: Per-edge forecast sweep (topo order)

For each edge `u→v`, processed in topo order:

**5a. Model resolution.** `resolve_model_params(edge, scope,
temporal_mode)` — fast dict lookup from the edge's promoted
model_vars. No dependency on other edges.

**5b. Frame derivation.** `derive_cohort_maturity(rows)` on the
edge's regime-selected snapshot rows (from Phase 3). Then
`compose_path_maturity_frames` for single-edge composition.

**5c. Cohort evidence.** `build_cohort_evidence_from_frames(frames,
target_edge, anchor_from, anchor_to, sweep_to, is_window, resolved)`
— shared function already extracted in `cohort_forecast_v3.py`.
Produces `CohortEvidence` list and max_tau.

**5d. Span kernel + MC draws.** `compose_span_kernel(graph,
from_node, to_node, is_window, max_tau=400)` for the edge kernel.
If span widening applies (cohort mode, `anchor_node_id_by_edge[edge]`
≠ `from_node`), also build `compose_span_kernel(graph, anchor_node,
to_node, ...)` for the widened kernel.

`mc_span_cdfs(topo, graph, ...)` for per-draw CDF arrays.
`span_kernel_to_edge_params` + `build_span_params` for IS prior
(alpha, beta) and latency SDs.

**5e. Upstream carrier (x_provider).** Read the from-node's
arrival state from the Phase 4 cache:

    arrival = node_arrival_cache.get(from_node_id)

The key requirement is fidelity, not just reuse: the sweep must consume
the same quality of from-node arrival state that the current v3 path
uses for that edge class. The whole-graph cache is the shared source of
truth; per-edge weak-prior rebuilds are not the target design.

**5f. Engine call.** `compute_forecast_sweep(resolved, cohorts,
max_tau, from_node_arrival, mc_cdf_arr, mc_p_s, span_alpha,
span_beta, span_mu_sd, ...)` — same 14 parameters as v3.

**5g. Scalar extraction.** Four quantities, each with dispersion:

    # p.mean — IS-conditioned asymptotic rate
    p_mean = float(np.median(sweep.rate_draws[:, -1]))
    p_sd = float(np.std(sweep.rate_draws[:, -1]))

    # Completeness — n-weighted blended CDF at cohort eval ages
    completeness = sweep.completeness_mean
    completeness_sd = sweep.completeness_sd

    # Unconditioned model rate (for surprise gauge / prior comparison)
    p_model = float(np.median(sweep.model_rate_draws[:, -1]))
    p_model_sd = float(np.std(sweep.model_rate_draws[:, -1]))

    # Latency dispersions (from the resolved model, not the sweep)
    mu_sd = resolved.latency.mu_sd
    sigma_sd = resolved.latency.sigma_sd
    onset_sd = resolved.latency.onset_sd

`rate_draws[:, -1]` is the conditioned rate at the last tau — the
asymptotic value. During migration, `np.median` is compared against the
current v3 midpoint as the parity gate. Once doc 46 is fixed, the same
read remains valid but the oracle becomes the corrected v3 output.
`model_rate_draws[:, -1]` is the unconditioned equivalent (pure
p × CDF, no evidence splice). The difference between conditioned
and unconditioned quantifies how much evidence shifted the forecast.

### Phase 6: Response

    {
      success: true,
      scenarios: [{
        scenario_id,
        edges: [{
          edge_uuid, from_node, to_node,
          p_mean, p_sd,
          completeness, completeness_sd,
          p_model, p_model_sd,
          mu_sd, sigma_sd, onset_sd,
          tau_max, n_cohorts, is_ess
        }],
        skipped_edges: [{
          edge_uuid, reason
        }]
      }]
    }

The response should distinguish successful edges from skipped ones. A
silent omission makes debugging impossible on large graphs.

## Performance budget

### Done ONCE per scenario

| Step | Cost | Notes |
|------|------|-------|
| Anchor resolution | <5ms | Per-edge anchor map on small DAG |
| Topo sort | <1ms | Kahn's on small graphs |
| Snapshot batch query | 50-200ms | One DB round-trip |
| Node arrival cache | ~50ms/node | Carrier construction (Tier 1/2/3) |

### Done PER EDGE

| Step | Cost | Notes |
|------|------|-------|
| Model resolution | <1ms | Dict lookup |
| Regime selection | <5ms | Filter + sort |
| Frame derivation | ~10ms | Lightweight aggregation |
| Span kernel | ~20ms | Forward DP on tau grid |
| MC span CDFs | ~100-200ms | 2000-draw reconvolution |
| Forecast sweep | ~100-300ms | 2000 draws × T × N cohorts |
| **Per-edge total** | **~200-500ms** | |

### Expected totals

| Graph size | Time | Acceptable? |
|-----------|------|-------------|
| 2 edges | ~0.6-1.2s | Yes |
| 4 edges | ~1.0-2.2s | Yes |
| 10 edges | ~2.2-5.2s | Marginal |
| 20 edges | ~4.2-10.2s | Needs timeout increase |

The FE shows the instant p.mean immediately; the forecast pass
overwrites asynchronously. The 10s timeout in the FE should be
increased to 20s for safety.

### What is NOT re-done

- No redundant DB queries (batched in Phase 3)
- No redundant carrier building (cached per node in Phase 4)
- The topo pass (Job A) is NOT re-run — the forecast pass reads
  model vars already promoted by the topo pass
- No redundant span topology BFS (could cache by node pair, but
  the cost is low enough to not bother initially)

## FE caller changes

The caller in `fetchDataService.ts` passes:

    runConditionedForecast(graph, dsl)

No analytics DSL needed. The handler processes all edges from the
graph directly.

The request-building side in `conditionedForecastService.ts` is mostly
compatible already: it builds `candidate_regimes_by_edge` and sends only
the temporal DSL.

The response-application side MUST change. The current
`applyConditionedForecastToGraph` mutates `graphEdge.p.mean` directly.
That bypasses the canonical batch-apply / sibling-rebalancing path used
by the BE topo pass. The whole-graph conditioned forecast should apply
its results through the same atomic graph-write path as the topo pass so
probability writes, sibling residual allocation, and associated derived
fields stay consistent.

The 10s timeout should be increased to 20s.

## What changes from current implementation

### BE handler (`handle_conditioned_forecast`)

**Current**: mirrors v3 chart handler for ONE subject. Resolves
from analytics DSL, queries one edge's snapshots, builds one span
kernel, runs one sweep, returns one edge. Fails silently when no
analytics DSL is provided.

**New**: graph-wide topo-order pass. Phases 1-6 as described above.
The per-edge pipeline (5a-5f) reuses the same sweep primitives as v3.
The outer loop, batched broad query, per-edge regime-family assembly,
and parity-grade arrival cache are new.

### FE caller

**Current**: passes `dsl` (temporal only), no analytics DSL → BE
gets zero subjects → returns empty edges → p.mean never updated.

**New**: passes `dsl` (temporal only). BE resolves all eligible edges
through the shared subject-resolution path, not a bespoke metadata walk.
No analytics DSL needed. Works for all eligible edges.

### What is NOT changed

- `compute_forecast_sweep` engine
- `build_cohort_evidence_from_frames` shared function
- `compose_span_kernel`, `mc_span_cdfs`
- `resolve_model_params`
- The v3 chart handler (untouched)

## Relationship to docs 30, 31, 45, and 46

**Doc 30**: this design must stay inside the broad-read /
per-`retrieved_at` regime-selection contract. It must not replace that
contract with narrow per-edge slice-key filtering.

**Doc 31**: this design should extend the BE subject-resolution path
with a graph-wide analysis type instead of inventing a second edge
subject assembler inside `api_handlers.py`.

**Doc 45**: this design implements doc 45 Step 3b with the correct
architecture: whole-graph topo-order pass instead of single-subject
mirroring. The real design goal remains shared computation between graph
scalar and chart.

**Doc 46**: until the v3 cohort midpoint inflation defect is resolved,
whole-graph parity against v3 is a migration gate, not the final
correctness claim.

Doc 45 Steps 1 (revert topo pass), 2 (commit valuable work), and 4
(retire topo pass forecast) are unaffected by this design.

## Resolved design decisions

1. **Multi-hop path scalars are not the goal of this pass.** The
   whole-graph conditioned forecast enriches each physical edge on the
   graph. Multi-hop `from(X).to(Z)` remains a chart / analysis concern.
   This pass writes per-edge graph scalars, not per-path graph scalars.

2. **Compute only the active temporal mode.** Window mode uses the
   window path and cohort mode uses the cohort path. The active temporal
   clause on the request determines which mode is computed. Computing
   both modes would double the work and is unnecessary unless the graph
   schema grows a second stored scalar set.

3. **Edges without usable evidence are skipped explicitly.** The
   handler should return `skipped_edges` with structured reasons such as
   missing parameter identity, missing candidate regimes, missing model
   params, or empty snapshot evidence after regime selection.

## Proposed implementation sequencing and testing gates

This implementation should be run as a strict test-first migration.
Because it replaces a code path, parity tests are the blocking gate.
Because the current failure is a contract bug, the first tests should be
written blind from this doc and the request contract, not by copying the
current implementation's assumptions.

### Test design gate before any code

Before editing the implementation, write short prose test designs for
the Python and TypeScript coverage you intend to add. Each design should
state the real bug it catches, what is real versus mocked, and what a
false pass would look like. Default to zero mocks. The Python server,
snapshot DB, candidate-regime machinery, and hash-selection path are all
part of the system under test and should be exercised for real.

### Phase 0: Write blind red tests first

Start by writing tests from this contract before opening the production
files:

- A BE contract test that submits the current FE-style request
  (temporal DSL only, no analytics DSL, candidate regimes present) and
  expects one result per eligible edge rather than zero edges.
- A BE regime-selection test that expects mixed-era and mapped-hash data
  to survive through the whole-graph batch path via a broad read and
  per-date regime selection.
- A BE parity test that expects the whole-graph pass to degenerate to
  the existing single-edge v3 result on a one-edge graph, and to match
  the one-edge-at-a-time reference output field-by-field on a multi-edge
  graph.
- A FE integration test that expects conditioned-forecast application to
  use the canonical batch apply path and preserve sibling rebalancing /
  derived field consistency rather than direct graph mutation.

Prefer extending the existing parity suites if they remain coherent,
especially `graph-editor/lib/tests/test_be_topo_pass_parity.py` and
`graph-editor/lib/tests/test_v2_v3_parity.py`. If that becomes too
awkward, add dedicated conditioned-forecast test files; this endpoint
does not currently have a natural existing home.

The first run of these tests should be red. Do not proceed by writing
code first and promising to add tests later.

### Phase 1: Shared subject-resolution path only

First extend the BE subject-resolution path so the endpoint can resolve
all eligible parameter edges from the graph without requiring an
analytics DSL. Keep the per-edge computation otherwise as close as
possible to the current single-edge path. The only goal of this phase is
to make the temporal-only request shape produce resolved edge subjects.

Expected gate: the handler contract test goes green, while the broader
parity and carrier-fidelity tests may still be red.

### Phase 2: Broad batched read with regime-correct row assembly

Next introduce the one-round-trip batched snapshot read, but keep it
inside the doc 30 broad-read contract. The handler should batch-query
all candidate-family hashes, reassemble per-edge family rows, and only
then apply regime selection.

Expected gate: the mixed-era / hash-mapping red tests go green and the
single-edge parity test still passes. If batching changes edge output on
the single-edge degenerate case, the batch implementation is wrong.

### Phase 3: Parity-grade node arrival cache

Only after the broad batched read is correct should the implementation
switch to a shared whole-graph node-arrival cache. This phase must carry
empirical upstream evidence forward so edges that currently get Tier 2
empirical carriers in v3 do not silently degrade.

Expected gate: the upstream-aware cohort fixtures and the parity cases
that currently depend on empirical carrier evidence go green. Do not
accept a cache that is merely faster but less informed.

### Phase 4: Whole-graph sweep and scalar extraction

Once subject resolution, batched reads, and carrier fidelity are in
place, move the endpoint fully onto the topo-order whole-graph sweep.
At this point the implementation should produce per-edge scalars for the
full graph in one pass.

Expected gate: the whole-graph parity suite is green on real graph data,
field-by-field, against the existing one-edge-at-a-time reference path
for every eligible edge in the graph.

### Phase 5: Frontend write-path switch

Only after the BE parity gates are green should the FE switch to using
the new whole-graph results in production. This phase should remove the
direct graph-mutation helper from the live path and route conditioned
forecast writes through the same atomic batch apply path used by the BE
topo pass.

Expected gate: the TypeScript integration test is green and a real
browser / CLI smoke check shows non-empty conditioned-forecast results
appearing on the graph without sibling drift or partial field updates.

### Phase 6: Timeout, diagnostics, and cleanup

Increase the FE timeout to 20 seconds only after correctness is proven.
Add structured skip reporting and retain enough dev diagnostics to make
carrier tier, regime choice, and edge skip reasons inspectable during
verification. Cleanup of transitional helpers belongs here, after the
main correctness gates have passed.

### Switch-over gates

The whole-graph pass should not replace the current path until all of
the following are true:

- The blind red tests were written first and observed failing.
- The temporal-only request contract test is green.
- The batched broad-read / regime-selection tests are green.
- The whole-graph parity suite is green against the current single-edge
  reference path on real graph data.
- The upstream-aware cohort fixtures are green, proving the cache did
  not degrade carrier fidelity.
- The FE application-path integration test is green.
- Manual smoke checks in the browser and CLI show non-empty graph
  enrichment on a real graph.

After doc 46 is fixed, rerun the parity suite against the corrected v3
outputs and update this document so the temporary migration language is
removed.
