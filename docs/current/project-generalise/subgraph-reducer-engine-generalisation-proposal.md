# Subgraph Reducer Engine Generalisation Proposal

**Status**: Proposal  
**Date**: 14-May-26  
**Scope**: Extend the span engine only. No reducer cutover. The engine extension includes value ledgers, value-weighted support ledgers, and the exposure stream required to distinguish covered-zero from absent at zero-value cells.

## Problem

The existing span core already has the right DAG algebra for terminal model curves: it walks the root→end subgraph, applies per-edge kernels, sums branches, and handles joins. The issue is that the DP state is thrown away. Callers get only the terminal `cdf_draws`.

That is not enough for a future reducer operating over subgraphs. The reducer will need:

- mass at internal nodes, e.g. `Y` in `window(X -> Y -> Z)`;
- concrete-edge contribution surfaces, especially when sibling/coincident edges share endpoints or enter the same terminal;
- carrier mass at `X` to seed subject-span readout in active cohort mode.
- support/coverage for those same node and edge surfaces, using the Phase 6 masked-kernel stream rather than the current placeholder support kernel;
- exposure surfaces for the same topology, so covered-zero and absent remain distinguishable even where propagated value is zero.

So the required generalisation is not new value algebra. It is **retaining and exposing the per-node/per-edge DAG ledger the current composer already computes internally**, and making the parallel support/exposure streams semantically real by plumbing evidence masks into the same DAG push-forward.

## Target

`ComposedPrimitiveSpan` should remain backwards-compatible for terminal model curves and additionally expose:

- `node_density_draws[node_id] -> (S, T)`  
  Unit-root arrival density from span root to each node, per draw.
- `edge_contribution_draws[edge_key] -> (S, T)`  
  Unit-root contribution through each concrete edge, per draw.
- `node_support_draws[node_id] -> (S, T)`  
  Unit-root support density propagated with the masked support kernels.
- `edge_support_contribution_draws[edge_key] -> (S, T)`  
  Concrete-edge support contribution, per draw.
- `node_exposure_draws[node_id] -> (S, T)`  
  Observation exposure propagated through the same topology, independent of conversion value.
- `edge_exposure_contribution_draws[edge_key] -> (S, T)`  
  Concrete-edge exposure contribution, per draw.
- `coverage_draws[node_id]` / terminal coverage projection helpers  
  `cumulative_support / cumulative_value` with the Phase 6 0/0 policy.
- `exposure_draws[node_id]` / terminal exposure projection helpers  
  Cumulative exposure used to distinguish observed-zero support from absent support at zero-value cells.
- concrete-edge topology metadata  
  Enough to distinguish coincident sibling edges and resolve incoming edges by node.

Existing terminal fields remain authoritative and unchanged:

- `span_p_draws`
- `cdf_draws`
- `span_p_mean`
- `cdf_mean`

All retained value/support/exposure surfaces are **densities**, not cumulative CDFs. Cumulative value, cumulative support, cumulative exposure, and coverage ratio are readout projections.

The support stream is Phase 6's value-weighted formulation. The exposure stream is required alongside it because support alone cannot distinguish covered-zero from absent when `cumulative_value = 0`.

## Required Changes

### 1. `span_kernel.py`

Make `SpanTopology` concrete-edge aware.

Current risk: edge maps keyed by `(from_id, to_id)` collapse coincident sibling edges.

Required changes:

- derive a stable concrete edge key for every graph edge, preferably from `edge_id` / `id`;
- store incoming edges by node as concrete edge refs, not predecessor node ids only;
- preserve concrete edge refs in `edge_list` and `path_adj`;
- keep node id canonicalisation, identity topology, and no-path behaviour unchanged.

Acceptance:

- `U -> V` with two concrete edges yields two topology edges, not one.
- Branch/join topology exposes every incoming concrete edge at the join.

### 2. `timing_span.py`

Make `_run_dp_density_grid` return a trace, not only terminal CDF.

The DP already computes `g[node]`. Retain it.

Required trace contents:

- `node_density_by_node[root] = delta(0)`;
- for each concrete edge `e: U -> V`, `edge_contribution_by_edge[e] = convolve(node_density_by_node[U], kernel[e])`;
- `node_density_by_node[V] = sum(edge_contribution_by_edge[e] for e entering V)`;
- `terminal_density = node_density_by_node[end]`;
- `terminal_cdf = cumsum(terminal_density)`.

`TimingSpan.density_cdf` must continue to expose the terminal CDF for existing callers.

Acceptance:

- for every non-root node, node density equals the sum of incoming concrete edge contributions;
- terminal CDF is unchanged from current behaviour.

### 3. `subject_span_composer.py`

Stack the per-draw traces onto `ComposedPrimitiveSpan`.

Required changes in `_compose_draws`:

- keep building per-edge per-draw kernels as now;
- key kernels by concrete edge key;
- for each draw, call the trace-returning timing composition;
- keep filling existing `cdf_arr` and `span_p_draws`;
- additionally stack:
  - `node_density_draws[node_id][draw, tau]`;
  - `edge_contribution_draws[edge_key][draw, tau]`.
  - `node_support_draws[node_id][draw, tau]`;
  - `edge_support_contribution_draws[edge_key][draw, tau]`.
  - `node_exposure_draws[node_id][draw, tau]`;
  - `edge_exposure_contribution_draws[edge_key][draw, tau]`.

Identity span:

- root node density is delta at τ=0 for every draw;
- root support density is delta at τ=0 for every draw;
- root exposure density is delta at τ=0 for every draw;
- no edge contributions;
- existing `cdf_draws = ones((S, T))` and `span_p_draws = ones(S)` remain unchanged.

Acceptance:

- existing F-mode terminal tests remain green;
- `cumsum(node_density_draws[end][s]) / span_p_draws[s]` matches `cdf_draws[s]` where reach is positive;
- coincident sibling edges have separate contribution arrays.
- support ledgers use the same topology and concrete edge keys as value ledgers.
- exposure ledgers use the same topology and concrete edge keys as value and support ledgers.

### 4. `primitive_readout.py` and `span_operator_supply.py`

Make the support and exposure streams real.

Required changes:

- plumb per-cell observation masks through primitive preparation so a conditioned primitive can expose the Phase 6 mask: observed-positive and covered-zero cells have mask 1; absent cells have mask 0;
- replace the current latent support placeholder (`ones_like(increments)`) with `value_increment × observed_mask`;
- add an exposure kernel for the same primitive: `exposure_increment = exposure_shape × observed_mask`, where `exposure_shape` is independent of conversion value and defined on the same timing grid;
- preserve non-latent and deterministic support semantics as the same masked-kernel idea on their degenerate timing grids.

Acceptance:

- a fully observed primitive has support increments equal to value increments;
- an absent cell contributes value mass but zero support mass;
- a covered-zero cell has mask 1 but zero value/support contribution because the value increment is zero;
- exposure is positive for observed cells even when value/support are zero;
- absent cells contribute zero exposure;
- support and exposure use the same concrete edge identity as value.

### 5. `model_span_spine.py`

Add engine readout helpers over retained surfaces.

Required helpers:

- read seeded mass at a node from `node_density_draws[node_id]`;
- read seeded contribution through a concrete edge from `edge_contribution_draws[edge_key]`;
- read seeded support at a node or edge from the matching support surfaces;
- read seeded exposure at a node or edge from the matching exposure surfaces;
- project coverage as `cumulative_support / cumulative_value` with the Phase 6 0/0 policy;
- project exposure alongside coverage so zero-value observed cells can be distinguished from absent cells;
- active-cohort handoff: seed carrier at A, read carrier mass at X, use that X-day density as the subject root seed.

Seed initialisation:

- for a multi-anchor `RuntimeRootMass`, root value and root support are both the observed cohort count `N_A(anchor_day)` for each anchor;
- root exposure is present for each observed anchor cohort;
- value, support, and exposure streams are identical at the root except for representation; they diverge only when downstream value/support/exposure kernels apply masks.

This is still engine work. It must not rewire reducer production call sites.

Acceptance:

- unit impulse seeded terminal readout matches existing terminal model readout;
- multi-anchor seed shifts by anchor day correctly;
- multi-anchor seed propagates value and support identically from the root;
- identity carrier returns root mass unchanged at X;
- active carrier output at X can seed subject readout.
- coverage is 1 when all positive contributing mass flows through observed cells, 0 when positive contributing mass flows only through absent cells, and partial for mixed support;
- exposure distinguishes observed-zero from absent when value is zero.

## Tests Required

Add focused engine tests for:

- linear `X -> Y -> Z`;
- branch/join `X -> {Y1, Y2} -> Z`;
- coincident sibling edges `U -> V`;
- identity span `X == X`;
- active cohort carrier-to-subject handoff.
- support/exposure mask cases: fully observed, absent, covered-zero, and mixed.

The tests must prove:

- topology does not collapse concrete sibling edges;
- node density equals incoming contribution sum;
- terminal CDF is unchanged;
- per-node surfaces expose intermediate subject mass;
- per-edge surfaces expose concrete sibling contributions.
- support propagates through the same topology as value;
- exposure propagates through the same topology as value and support;
- coverage projection is `cumulative_support / cumulative_value`, not raw support.
- covered-zero and absent are distinguishable at zero-value cells via exposure.

## Natural Degeneracy Requirements

The implementation must preserve the project-generalise no-branching rule:

- window, cohort, identity carrier, active carrier, single-hop, multi-hop, branch/join, and coincident siblings all run the same topology DP;
- case differences enter as topology, seed, concrete edge set, primitive surfaces, and support masks;
- identity span is the empty topology with value/support/exposure delta at τ=0 and no edge contributions;
- single-hop is a one-edge DAG;
- branch/join is the same incoming-edge sum with more than one incoming term;
- support/exposure states compile into mask values before the DP. The DP must not branch on observed-positive versus covered-zero versus absent;
- carrier-to-subject handoff is ledger handoff: carrier mass at `X` becomes the subject seed. No Pop C / Pop D branching inside the engine.

## Support And Exposure Semantics

This proposal implements both Phase 6 support streams:

- value-weighted support: `support_kernel = value_kernel × observed_mask`, projected as `cumulative_support / cumulative_value`;
- exposure: `exposure_kernel = exposure_shape × observed_mask`, projected as cumulative exposure.

The exposure stream is not optional in this proposal. It is required because value-weighted support cannot distinguish "observed covered-zero" from "absent/no support" when `cumulative_value = 0`.

The three-stream interpretation is:

- `value > 0`, `support/value > 0`: positive mass flowed through observed cells;
- `value > 0`, `support = 0`, `exposure > 0`: propagated mass exists, but observed cells on the path are covered-zero;
- `value > 0`, `exposure = 0`: propagated mass exists only through absent cells;
- `value = 0`, `exposure > 0`: zero value is observed/covered;
- `value = 0`, `exposure = 0`: zero value is indistinguishable from absence and must be treated as unsupported/unknown.

## Out Of Scope

No changes to:

- `_SelectedSourceDayMass`;
- `_CarrierOnlyDenominatorPrefix`;
- `_RateAttributedSubjectPrefix`;
- `SelectedAClockEvidence`;
- `_selected_cohort_group_rate_draws`;
- chart rendering.

Those are reducer cutover work after this engine extension is proven.

Also out of scope: changing display policy. This proposal computes engine coverage surfaces; it does not decide how the chart consumes them.

## Final State

After this proposal lands, the promoted span engine can answer:

- "What mass reaches node U?"
- "What contribution flows through concrete edge E?"
- "What mass reaches X from carrier A?"
- "What terminal CDF does this full subgraph imply?"
- "What fraction of the propagated mass is supported by observed cells?"
- "Was a zero-value cell observed/covered or absent?"

It can answer those for linear paths, branching DAGs, joins, identity spans, and coincident sibling edges, with value, support, and exposure streams kept in lockstep, without changing reducer behaviour yet.
