# Phase 2 / Batch F — window() upstream-path discrimination

**Date:** 8-May-26
**Status:** plan / pre-implementation. Phase 0 tests not yet written.
**Touches:** [`graph-editor/lib/msmdc.py`](../../graph-editor/lib/msmdc.py); test refresh in the lag-fitter / cohort-maturity / selected-cohort-pop-D family. **Zero FE changes.**

## Why this matters

The post-CF rebuild leans heavily on `window()` evidence inside the factorised CF machinery. In any graph that has a split (a fan-in node anywhere upstream of an edge's `from_node`), the `window()` fetch for that edge currently retrieves **aggregate** traffic — i.e., the X count and Y count include users who arrived at the edge's from-node via *every* upstream path, not only the path the CF leg under evaluation represents. The downstream rate `y/x` is therefore the path-marginal rate, not the path-conditional rate the factorised CF expects to plug in. For any graph with a diamond or fan-in upstream of an evidence edge, this silently mis-conditions every fitter and every forecast that consumes the evidence.

The canonical case: graph `a→b→c→d` and `a→e→c`, edge being fetched is `c→d`. The current `window()` fetch returns "all c→d transitions in the window", including users whose c-arrival came via e. The factorised CF leg modelling the b-path then over-counts evidence and biases its rate estimate.

`cohort()` mode does not exhibit this (or exhibits it less) because MSMDC compiles `cohort()` queries with `from(anchor)` prepended, and Amplitude's funnel semantics impose a path-ordering constraint that partially discriminates. `window()` strips the anchor and is left topology-blind.

## What we already own

Five primitives are in place and tested today. The fix composes them; it does not extend the surface.

| # | Primitive | Location | What it gives us |
|---|---|---|---|
| 1 | MSMDC topology pass | [`msmdc.py:79-405`](../../graph-editor/lib/msmdc.py#L79-L405); diamond detector at [`:173-188`](../../graph-editor/lib/msmdc.py#L173-L188) | Computes minimal `{visited, exclude, visitedAny}` discriminators from graph topology. Iterative witness search via `_find_path_avoiding` / `_find_path_including`. |
| 2 | `visited()` / `exclude()` DSL | parsed at [`query_dsl.py:408-482`](../../graph-editor/lib/query_dsl.py#L408-L482); compiled to native Amplitude segment filters at [`amplitudeFunnelBuilderService.ts:170-206`](../../graph-editor/src/services/amplitudeFunnelBuilderService.ts#L170-L206) | Behavioural segment filters Amplitude has supported natively since 4-Dec-25. No funnel widening required. |
| 3 | Signature-stable identity | [`querySignature.ts:253-279`](../../graph-editor/src/services/dataOperations/querySignature.ts#L253-L279) | `.window()` and `.cohort()` bounds are stripped from `core_hash`; `visited_event_ids` and `exclude_event_ids` are *not*. A snapshot keyed with `exclude=[e]` is reusable across both modes for the same edge. |
| 4 | Anchor-free `n_query` form | [`msmdc.py:1032-1044`](../../graph-editor/lib/msmdc.py#L1032-L1044) | `n_query` is stored as `to(X)`. Cohort mode prepends `from(A)` at execution; window mode does not. The mode-specific lever already exists. |
| 5 | Auto MSMDC re-fire on topology change | [`graphMutationService.ts:292-720`](../../graph-editor/src/services/graphMutationService.ts#L292-L720); incremental regen via `downstream_of` filter at [`msmdc.py:925-943`](../../graph-editor/lib/msmdc.py#L925-L943) | When a graph edit creates or destroys a fan-in, MSMDC re-runs for affected edges automatically. No FE plumbing needed. |

## Confirmations from the pre-plan research

Three independent reads of the codebase, recorded so future readers don't have to redo them.

**C1 — MSMDC's topology pass is narrower than its name suggests.** The detector at [`msmdc.py:173-188`](../../graph-editor/lib/msmdc.py#L173-L188) inspects `predecessors(to_node) - {from_node}` only. For the canonical bug case (a→b→c, a→e→c, edge c→d) the diamond is *upstream of from_node*, and the existing check does not fire — MSMDC currently emits `from(c).to(d)` with no excludes for that edge today, in both cohort and window modes. There is also no DAG guard at the entry to `generate_query_for_edge`; a cycle would either hang or surface as an opaque NetworkX error. Existing tests in [`test_graph_analysis.py`](../../graph-editor/lib/algorithms/test_graph_analysis.py) cover direct-into-to_node diamonds but not the upstream-of-from_node case.

**C2 — Downstream consumers of `(x, y)` do not assume "x is unrestricted"; they assume "x and y are coherent".** The lag fitter at [`lag_model_fitter.py:112-203`](../../graph-editor/lib/runner/lag_model_fitter.py#L112-L203), the Beta-binomial conjugate at [`primitive_conditioning.py:1137-1160`](../../graph-editor/lib/runner/primitive_conditioning.py#L1137-L1160), the forecast blender at [`forecast_application.py:208-228`](../../graph-editor/lib/runner/forecast_application.py#L208-L228), and the anchor-lag aggregator in [`mece_aggregation.py`](../../graph-editor/lib/runner/mece_aggregation.py) all consume `(x, y)` as `(trials, successes)` and are mathematically correct under either semantics. Path-restricted x is the *more correct* of the two; the present unrestricted form is a calibration error. The risk is therefore not silent corruption but **calibration test refresh** — fixtures that asserted on absolute x were sized against the unrestricted aggregate.

**C3 — The FE is a pass-through for `edge.query` and `edge.n_query`.** [`buildDslFromEdge.ts`](../../graph-editor/src/lib/das/buildDslFromEdge.ts) parses `edge.query` verbatim — no re-derivation of visited/exclude from graph topology. The window planner adds only `.window(start:end)` decoration. `n_query` is never parsed or modified on the FE; it is stored, displayed, and forwarded. MSMDC re-fires automatically on topology changes via `graphMutationService.regenerateQueriesAsync`. **Patch scope is `msmdc.py` plus downstream Python consumers; zero FE changes.**

## Repair — Phase 0: blind tests, written first

The fix has too many subtle edges to validate without a pinned oracle. Phase 1 implementation does not begin until the Phase 0 suite is red on the bug cases and green on the negative-control cases.

The tests assert on the **materialised Amplitude query body** that MSMDC produces and on the **n_query** carried alongside. They do not assert on internal data structures of the MSMDC result; they assert on the observable behaviour at the FE/BE boundary, which is the contract we actually care about. Any implementation that passes them is acceptable; any that does not, is not.

New file: `graph-editor/lib/tests/test_msmdc_upstream_path_discrimination.py`. (New surface only because no existing test file covers upstream-of-from_node topology; this is an extension of the topology coverage in [`test_graph_analysis.py`](../../graph-editor/lib/algorithms/test_graph_analysis.py), not a parallel surface.)

Six topologies are covered, each defined as a YAML synth-graph fixture so the same fixtures are reusable by future tests in this family:

**T-α — linear baseline.** Graph a→b→c→d, edge c→d. Asserts no excludes are added and no n_query is emitted. Today this passes; the test pins it so the Phase 1 fix cannot regress the trivial case by adding spurious excludes.

**T-β — upstream-of-from_node diamond (the canonical bug case).** Graph a→b→c, a→e→c, c→d, edge c→d. Asserts that the materialised Amplitude query body for both the main fetch (Y count) and the n_query fetch (X count) carries a behavioural segment filter that discriminates the b-path from the e-path — either an exclude-on-e filter or a visited-on-b filter; the iterative witness search picks whichever is minimal, and the assertion accepts either form by inspecting the rendered Amplitude payload rather than the DSL string. Today this fails on both fetch surfaces.

**T-γ — direct-into-to_node diamond (negative control).** Graph a→b, b→c→d, b→e→d, edge c→d. Asserts no excludes are added. The c→d transition is naturally path-discriminating — only b→c→d users have a c→d event in their stream. This test guards against the Phase 1 fix becoming over-zealous and adding spurious excludes when the topology already discriminates the edge.

**T-δ — diamond-of-diamonds.** Graph a→b→c, a→e→c, c→d, plus c→f→g, c→h→g (irrelevant downstream fan-in). Edge c→d. Asserts the same exclude(e) (or equivalent visited(b)) as T-β; the irrelevant downstream f/h diamond does not contaminate the discriminator set.

**T-ε — cycle / self-edge.** Graph a→b→a or a→a. Asserts MSMDC raises a clear `ValueError` naming the cycle nodes, rather than NetworkX's opaque exception or hanging in `_reachable_path`. Even if production graphs are DAGs today, the missing guard is a latent foot-gun and the test pins the contract.

**T-ζ — end-to-end materialisation through the window-mode fetch path.** Reuses the T-β fixture and exercises the full FE chain: window planner → `getFromSourceDirect` → `buildDslFromEdge` → DAS adapter → HTTP body. Asserts (a) the Amplitude REST request body for the n_query carries the segment filter; (b) the request body for the main query carries the same filter; (c) the resulting `core_hash` in the snapshot row contains `exclude_event_ids = [<e's id>]` (or `visited_event_ids = [<b's id>]`); (d) the `core_hash` is identical for the same edge fetched in `window()` versus `cohort()` mode after stripping the bounds clauses, demonstrating the snapshot-reuse property the signature design intended.

The Phase 0 suite is the acceptance contract for Phase 1. Until T-β and T-ζ are red and T-α / T-γ are green on the bug branch, Phase 1 does not start. Once Phase 1 lands, all six tests must be green.

## Repair — Phase 1: implementation

Three surgical changes, all in [`msmdc.py`](../../graph-editor/lib/msmdc.py). Estimated diff: order of thirty lines.

**P1.1 — Generalise the topology discriminator to upstream-of-from_node fan-ins.** Replace the predecessors-of-to_node check at [`:173-188`](../../graph-editor/lib/msmdc.py#L173-L188) with a fan-in walk over the ancestor sub-DAG of `from_node`. For every node F in `ancestors(from_node) ∪ {from_node}` that has more than one predecessor, examine the parents of F that lie outside the canonical lineage to from_node, and run the existing iterative witness search (`_find_path_avoiding`, `_find_path_including`, [`:579-624`](../../graph-editor/lib/msmdc.py#L579-L624)) to derive the minimal set of `exclude` (or, where exclude alone cannot discriminate, `visited`) literals. The witness search and the `_reachable_path` helper are reused unchanged. The widened scan covers both the existing direct-into-to_node case and the new upstream-of-from_node case under one algorithm — no fork by case (cf. AP58).

**P1.2 — Add a DAG guard at the entry to `generate_query_for_edge`.** A single check that the NetworkX graph constructed by `_build_networkx_graph` is acyclic; if not, raise `ValueError` naming the cycle nodes. Cheap, prevents the silent hang on malformed input, and is preconditional to the iterative witness search behaving as documented.

**P1.3 — Propagate the residual discriminators into n_query.** The block at [`:1032-1044`](../../graph-editor/lib/msmdc.py#L1032-L1044) currently emits `n_query = "to(<from_id>)"` whenever `_residual_has_narrowing` is true. The fix uses the existing `QueryConstraints.to_query_string` serialiser to emit `to(<from_id>)` decorated with the residual visited/exclude/visitedAny clauses — i.e., the same discriminators carried by the main query. The residual sets are already computed by `_residual_has_narrowing`; this change uses them rather than discarding them. The mode-specific anchor prepending (cohort prepends `from(A)`, window does not) stays where it is; the discriminators ride alongside in both modes.

What is *not* in Phase 1: no new helpers, no new DSL clauses, no new graph traversal primitives, no new signature fields, no new Amplitude integration, no new snapshot DB column, no FE work. The composition uses only what is already present.

## Repair — Phase 2: calibration test refresh

After Phase 1, the C2 risk list will produce numerical test failures on fixtures sized against the unrestricted-x semantics. The refresh re-anchors each assertion against the corrected semantics, with a one-line comment explaining the regeneration. No assertion is weakened.

Affected tests, in priority order:

1. [`test_selected_cohort_pop_d_distribution.py`](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py) at lines 1052-1053 (cohort mode, diamond-adjacent fixture) and 1192-1206 (window mode, same fixture). This file is already in the modified-files set from the post-CF rebuild; the refresh folds into the existing edits.
2. [`test_lag_distribution_parity.py`](../../graph-editor/lib/tests/test_lag_distribution_parity.py) and [`test_lag_model_fitter.py`](../../graph-editor/lib/tests/test_lag_model_fitter.py) — any assertion on `evidence_x` or fitted `mu` / `sigma` that was sized against unrestricted aggregates on a graph with an upstream fan-in.
3. The `test_cohort_maturity_*` family (modified set) — any assertion on `x` totals that crosses an upstream fan-in.

For each refreshed assertion, the test comment must record (a) the date, (b) the fixture topology, (c) which path the path-restricted x corresponds to, so a future reader can reconstruct the intent without re-deriving it. AP17's vacuous-test smell does not apply here; the refreshed tests still exercise non-zero cohorts, just smaller ones reflecting the discriminated path.

## Repair — Phase 3: audit one open question before merge

The factorised CF machinery uses per-carrier-path semantics: in the diamond a→b→c, a→e→c with edge c→d, the CF wants per-carrier evidence on c→d — `c→d via b` *and* `c→d via e` as separate snapshots, one per carrier leg. Phase 1 produces *one* discriminated query per edge — it discriminates *some* path (whichever the fan-in walk converges to), not necessarily the path the CF leg under evaluation needs.

This is fine if the CF requests per-carrier evidence one carrier at a time and tells the fetcher which discriminator to apply per request — Phase 1 is sufficient. It is not sufficient if the CF expects one edge query to return all per-carrier variants in a single fetch — in which case `ParameterQuery` needs to become a list per edge, one per relevant carrier path. That is still composition (a list, not a scalar) and not new primitive logic.

Before merging Phase 1, read [`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py) `build_cohort_evidence_from_frames` (the AP58 fork at :750-803 that 73n is mid-fixing) and confirm which contract the CF expects. Pick the matching variant. Do not guess.

## What is explicitly not in scope

- **No FE topology pass.** [`buildDslFromEdge.ts`](../../graph-editor/src/lib/das/buildDslFromEdge.ts) and the window planner remain pure pass-throughs for whatever MSMDC produces.
- **No new graph-walk primitives.** The fan-in scan reuses `nx.ancestors`, `_reachable_path`, `_find_path_avoiding`, `_find_path_including` — all already present and tested.
- **No new snapshot DB column.** Discriminators ride in `core_hash` via the existing `visited_event_ids` and `exclude_event_ids` fields.
- **No new DSL clauses.** `visited()` and `exclude()` already compile to native Amplitude segment filters.
- **No window/cohort signature divergence.** [`querySignature.ts:255`](../../graph-editor/src/services/dataOperations/querySignature.ts#L255) already strips both bounds clauses; post-fix snapshots are reusable across both modes.
- **No Phase 1 code before Phase 0 tests are red.** TDD is mandatory. The failure modes are too subtle to validate without a pinned oracle, and the calibration shifts in Phase 2 will be uninterpretable without a test that pins the *intended* observable behaviour first.

## Open questions

1. **Does the witness search converge on `exclude(e)` or `visited(b)` for T-β and T-δ?** Both are mathematically valid discriminators in a strict diamond. The iterative search picks whichever is minimal under the current literal-weight heuristic. The Phase 0 test should accept either by asserting on the rendered Amplitude payload rather than the DSL string. If they diverge in higher-order topologies (third path, bridge edge), the witness search disambiguates and the test follows.

2. **Phase 3 contract — one carrier per fetch, or all carriers per fetch?** Decision deferred to the [`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py) read. The composition either way is mechanical; the architectural shape depends on what the CF expects.

3. **Per-carrier query expansion — one edge.query becomes a list of `ParameterQuery` per carrier path?** Only relevant if Phase 3 picks the all-carriers-per-fetch variant. If so, the existing `conditional_p[]` mechanism is the natural surface — each carrier becomes a `conditional_p` with the carrier-specific visited/exclude as its `condition`. No new field.

## Verify

```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_msmdc_upstream_path_discrimination.py \
  lib/tests/test_selected_cohort_pop_d_distribution.py \
  lib/tests/test_lag_distribution_parity.py \
  lib/tests/test_lag_model_fitter.py
```

Acceptance: all six T-α through T-ζ green; Phase 2 refreshed tests green; no regression in [`test_graph_analysis.py`](../../graph-editor/lib/algorithms/test_graph_analysis.py) (existing topology suite continues to pass — the wider scan is a strict superset).
