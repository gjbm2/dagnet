# Factorised carrier replumb — symmetric span-kernel composition for `carrier_to_x`

**Status**: implementation-ready proposal, pending peer review
**Author**: Greg + Claude (Opus 4.7)
**Date**: 29-Apr-26 (third revision after second-pass peer review)
**Scope**: `graph-editor/lib/runner/**` (BE-runner-cluster)

---

## 0. Revision notes

**Third revision** — addresses five findings from the second-pass review:

1. **Reach is horizon-dependent** if drawn from `kernel.span_p`. `span_kernel.py:301` defines `span_p = K[-1]` over the finite grid. For multi-edge or long-tailed upstream chains, `span_p` undershoots the eventual A→X reach, making the conditional CDF saturate artificially. This revision separates eventual reach (topological) from finite-horizon K(t).
2. **All-non-latency upstream is suppressed by the existing `enabled` gate** at `forecast_runtime.py:1052` (`enabled = reach > 0 AND has_semantic_upstream_latency(...)`). Without changing that contract, the new δ(0) carrier never becomes consumed because `build_prepared_runtime_bundle` only marks `mode='upstream'` when `x_provider.enabled=True`. This revision makes the contract change explicit and load-bearing.
3. **The replacement surface is broader than v2 stated**. Three live callers construct carriers: `build_x_provider_from_graph`, `build_node_arrival_cache` (per-node cache used by whole-graph CF), and the inline `XProvider(...)` construction at `api_handlers.py:1380`. All three are now in scope.
4. **Tier 2 empirical lacks a reach contract under O1 (empirical-first)**. Empirical's internal `_eventual_reach` differs from the externally-exposed topological reach. This revision specifies the contract: reach is always topological; empirical only governs CDF shape.
5. **Existing tests need intentional rebaselining**. `test_phase1_non_latent_upstream_collapses_to_identity` (test_forecast_state_cohort.py:646) and `test_single_hop_non_latent_upstream_collapses_to_window` (test_cohort_factorised_outside_in.py:790) assert the current "collapse to identity / window" contract that this plan deliberately reverses.

The first revision was rejected for joint-vs-conditional confusion, backwards δ(0) acceptance test direction, and silent dispatcher behaviour change. Those were corrected in v2 and remain corrected here. Apologies for the iterative quality.

---

## 1. Executive summary

Per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, cohort-mode forecasts factor into a denominator-side `carrier_to_x` (A→X) and a numerator-side `subject_span` (X→end). Both are CDFs over τ, both should be composed from per-edge `(p, μ, σ, onset)` resolved through the active source. The subject side already uses the factorised span-kernel machinery (`compose_span_kernel`); the carrier side uses a probability-weighted mixture of pre-composed `path_mu` / `path_sigma` / `path_onset_delta_days` scalars.

This proposal populates `PreparedCarrierToX` in `mode='upstream'` via the same factorised machinery, with `(start, end) = (anchor_node_id, from_node_id)`. The change is supported by four contract corrections without which the replumb does not actually fix the v3 chart:

- **Eventual reach is decoupled from finite-horizon K(t)**. Reach remains the topological product (a property of the graph, not the integration grid). The kernel produces the CDF shape only; the conditional CDF normalises by the kernel's own endpoint, not by reach.
- **The `enabled` gate on `XProvider` changes meaning**. It currently requires upstream latency presence. After this PR it requires only that the carrier is in upstream mode and reach > 0. Non-latency upstream chains in cohort mode A≠X then produce a δ(0) carrier (conditional CDF = 1.0 from τ=0) instead of collapsing to identity.
- **All three live carrier-construction sites migrate together**. `build_x_provider_from_graph`, `build_node_arrival_cache`, and the inline construction at `api_handlers.py:1380` all switch to the factorised mechanism in this PR. Partial migration would leave the whole-graph CF and the dispatcher path on different contracts.
- **Tier 1 / Tier 2 dispatcher ordering becomes an explicit decision**. The current parametric-first ordering effectively retires Tier 2 (because factorised parametric is always available); this PR proposes empirical-first as the principled choice with a reach contract that says "reach is topological regardless of which tier wins; only CDF shape moves with the tier."

The change retires the BE's read of `path_mu` / `path_sigma` / `path_onset_delta_days` for live-path purposes, dissolves the persistence-staleness bug class at the consumer, and brings carrier and subject under one composition machinery.

---

## 2. Diagnostic

### 2.1 Observed symptoms

On `gm-rebuild-jan-26`, cohort_maturity v3 for `from(household-delegated).to(switch-registered)` shows window and cohort curves overlapping with a small vertical translation. The upstream chain `Landing-page → household-created → household-delegated` is all-non-latency.

In the current contract, `has_semantic_upstream_latency=False` → `x_provider.enabled=False` → `mode='identity'` → carrier collapses, cohort = window numerically (vertical translation comes from elsewhere — cohort/window denominator differences). What is actually observed in the trace, however, is `[v3-debug] upstream_params[0]: mu=-3.85 sigma=3.55` and `[v2] carrier tier=parametric: 1 edges` — the carrier *is* firing, with bogus values. That contradicts the supposed identity collapse and points at a divergence between the bundle-level enabled gate and the dispatcher-level acceptance.

The values trace to stale `path_mu = -4.39`, `path_sigma = 2.47` etc. on the upstream non-latency edges, persisted by a prior FE topo emission. `read_edge_cohort_params` reads them; `_build_tier1_parametric` mixes them into `mu=-3.85, sigma=3.55`. The dispatcher accepts this (parametric wins). The bundle apparently accepts it too despite `has_semantic_upstream_latency=False`. The two gates are not consistent — one calls non-latency upstream "no carrier", the other admits a polluted parametric carrier.

### 2.2 Root cause

The proximate cause is stale persisted scalars. The deeper cause is two-fold:

1. The BE consumes pre-composed `path_*` scalars at all. The semantics doc establishes `carrier_to_x` and `subject_span` as parallel objects on different clocks, both built from per-edge resolved params. The subject side already does this; the carrier side does not.
2. The current "is this upstream chain meaningful" gate is `has_semantic_upstream_latency`, which conflates "no upstream latency edges" with "carrier collapses to identity". This is wrong for cohort mode A≠X with non-latency upstream: Pop C arrivals exist (instantly), the carrier is δ(0) but **active**, and the denominator is scaled by reach (creating the small vertical offset between window and cohort that the user has been observing all along).

### 2.3 Where carriers are built today

Three live sites:

- **`forecast_runtime.build_x_provider_from_graph`** (line 948). Called by `cohort_forecast_v3._build_factorised_carrier`. Walks topology for reach, calls `read_edge_cohort_params` per direct incoming edge, populates `XProvider.upstream_params_list`. Sets `enabled = reach > 0 AND has_semantic_upstream_latency(...)`.
- **`forecast_state.build_node_arrival_cache`** (line 363). Called by whole-graph CF (api_handlers.py:377). Walks the graph in topo order, at each node calls `build_upstream_carrier` with `read_edge_cohort_params`-extracted params and builds a `NodeArrivalState` cache. Same legacy path-scalar reads.
- **`api_handlers.py:1380`** inline `XProvider(...)` construction. Used by the v2/v3 single-edge handler when an upstream observations dict is being prepared. Uses `_ingress` (built locally from `read_edge_cohort_params`) and `_upstream_enabled` (built from the same gate).

All three migrate together in this PR.

### 2.4 The dispatcher

`forecast_runtime.build_upstream_carrier` (line 1582) tries Tier 1 (parametric) → Tier 2 (empirical) → Tier 3 (weak prior). Tier 1 wins when `_build_tier1_parametric` returns non-None. After the replumb, factorised parametric returns non-None whenever any A→X path exists, which is every real cohort case. Tier 2 becomes effectively unreachable on the live path under the current ordering.

---

## 3. Rationale (semantics-aligned)

### 3.1 Methodological symmetry

`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` §"General abstraction points" enumerates `carrier_to_x` and `subject_span` as parallel objects. §"Mapping to the current Python surfaces" identifies `x_provider`/`from_node_arrival` as denominator-side and `span_kernel` as subject-side. The proposal applies the same mechanism (compose-from-per-edge-resolved-params) to both objects with different endpoints. This is the architectural shape the doc implies.

### 3.2 Naturally degenerating template

The doc's §"Template for a naturally degenerating implementation" calls for one pattern that degenerates across `window()` vs `cohort()`, single-hop vs multi-hop, A=X vs A≠X. `PreparedCarrierToX.mode='identity'|'upstream'` already encodes window and A=X collapses to identity. The replumb only changes how `mode='upstream'` is populated. Inside `mode='upstream'`, single-chain vs fanout vs all-non-latency degenerate naturally inside `compose_span_kernel`. One mechanism, four degeneracies.

### 3.3 Pop C and Pop D unchanged in semantics, but Pop C now actually exists

The doc §"Cohort semantics: cohort(A, X-Y)" §"Denominator side" explicitly says Pop C (future arrivals to X after the frontier) exists "only when A != X". It is gated on A≠X, not on whether the upstream chain has latency edges. The current code gates Pop C indirectly via `has_semantic_upstream_latency`, which is too restrictive: it suppresses Pop C in the all-non-latency upstream case where the doc says Pop C should exist (just with δ(0) timing).

The replumb makes the gate match the doc: Pop C exists whenever cohort mode is selected, A≠X, and reach > 0.

### 3.4 Source-pinning consistency

`build_prepared_span_execution_from_topology` calls `resolve_model_params(scope='edge')` per edge, honouring source pins. The carrier and subject become source-consistent automatically. The legacy `read_edge_cohort_params` preferred bayesian posterior path scalars regardless of pin; that asymmetry disappears.

### 3.5 What this proposal does **not** decide

Per the semantics doc §"What this note does not decide": this PR does not engage with B3 mature cohort path-level latents, does not authorise gross-fitted whole-query numerators, and does not change `numerator_representation` from `'factorised'`. It changes the implementation mechanism for the carrier latency CDF and the gate semantics for when the carrier is active.

---

## 4. Proposed change

### 4.1 Reach is topological; CDF is horizon-truncated

The replumb separates two quantities that the previous draft conflated:

- **Eventual reach** — a property of the graph: the probability-mass-product of all paths from anchor to from_node. Computed via the existing topological walk in `build_x_provider_from_graph` (multiplying `node_reach[from] × edge_p` along the DAG). This is the canonical `reach` exposed via `XProvider.reach` and `NodeArrivalState.reach`.
- **Finite-horizon kernel CDF** — `K(t)` for `t ∈ [0, max_tau]`, produced by `compose_span_kernel`. `K[max_tau]` is `kernel.span_p` and is generally less than eventual reach for long-tailed upstream chains.

The conditional carrier CDF is `K(t) / K[max_tau]` (normalised by the kernel's own endpoint), guaranteeing values on `[0, 1]` regardless of horizon. The joint shape downstream consumers see is `eventual_reach × conditional_CDF(t)` — saturating at `eventual_reach × 1 = eventual_reach` at τ = max_tau, capturing the "all eventual mass treated as having arrived by horizon" semantics that the cohort-maturity sweep already operates under.

This decouples reach from the integration grid. A horizon-truncation correctness concern remains for very long-tailed upstream lognormals (tracked in §5.1) but is the same concern that exists today, no worse.

The `kernel.span_p` value is **not** stored as reach. It is used only to normalise the conditional CDF.

### 4.2 The `enabled` semantics change (load-bearing)

Today: `enabled = reach > 0 AND has_semantic_upstream_latency(graph, anchor, from_node)`.

After this PR: `enabled = reach > 0 AND population_root != X AND mode == 'cohort'`.

Equivalently: `enabled = (mode == 'cohort') AND (anchor != from_node) AND (reach > 0)`. The `has_semantic_upstream_latency` predicate is no longer used for the gate. Pop C exists whenever the doc says it does.

This is a behaviour change. Acceptance tests (§6) cover both directions: all-non-latency upstream now produces a δ(0) carrier with reach < 1 (instead of collapsing to identity, which would yield reach = 1.0 and cohort = window numerically). Latent upstream behaviour is unchanged in shape; the carrier just comes from the kernel rather than the mixture.

The window mode and A=X cases continue to produce `mode='identity'` via separate gates upstream of `XProvider.enabled`. This change does not affect them.

### 4.3 Migrating `build_x_provider_from_graph`

The function's body in the upstream-carrier branch is replaced. Inputs unchanged. Outputs: an `XProvider` with `reach` (eventual, from the topological walk — kept), `enabled` (new contract per §4.2), `carrier_det_cdf` and `carrier_mc_cdf` (new fields holding the conditional CDFs from the kernel), and the legacy `upstream_params_list`/`ingress_carrier`/`upstream_obs` retained for backwards-compat with the dispatcher's empirical and weak-prior tiers.

Internal mechanism:

1. Resolve `from_node_id` from `target_edge`. Compute eventual reach via the existing topological walk.
2. Apply the new enabled gate. If disabled, return the empty XProvider as today.
3. Call `build_prepared_span_execution(graph, anchor_node_id, from_node_id, temporal_mode, graph_preference)`.
4. Call `compose_span_kernel(topo, edge_params, max_tau)` with a max_tau chosen per §4.7.
5. Build `carrier_det_cdf[t] = K(t) / K[max_tau]` for `t ∈ [0, max_tau]`. If `K[max_tau] ≤ 0`, the kernel produced no mass — return empty XProvider with `tier='none'`.
6. Build `carrier_mc_cdf` analogously via `mc_span_cdfs` for the same anchor→from_node span, normalised per draw.
7. Populate `XProvider`. `upstream_params_list` and `ingress_carrier` are populated as empty lists (unused by the new dispatcher branch but retained for type stability).

### 4.4 Migrating `build_node_arrival_cache`

The per-node cache builder at `forecast_state.py:363` walks the graph in topo order and builds a `NodeArrivalState` per node. Today it does `read_edge_cohort_params` over each node's incoming edges and calls `build_upstream_carrier`. After the replumb, at each node it calls the same factorised mechanism with `(start, end) = (anchor_id, this_node_id)` to populate the per-node `NodeArrivalState.deterministic_cdf`/`mc_cdf` directly. `NodeArrivalState.reach` stays as the topological accumulator already computed in the loop.

This matters for whole-graph CF, which uses the cache for downstream Tier 2 empirical cohort-arrival construction.

### 4.5 Migrating the inline `XProvider` construction at api_handlers.py:1380

The inline construction uses `_ingress` and `_upstream_enabled` built nearby. These local vars become populated from the same factorised path: `_reach_to_x` from the topological walk; `_ingress` empty; `_upstream_enabled` per the new gate; `carrier_det_cdf` and `carrier_mc_cdf` from the kernel. The empirical observations dict (`_upstream_obs`) construction is unchanged.

### 4.6 Dispatcher tier ordering

Three options:

- **(O1) Empirical-first**: invert the dispatcher to try Tier 2 before Tier 1. Empirical observations are the highest-fidelity carrier representation when present. Reach contract: empirical can update CDF shape but **not** reach — reach remains topological. This keeps eventual A→X mass tied to graph structure, preserving the invariant that downstream consumers (Pop C × subject_p × subject_CDF) expect.
- **(O2) Parametric-first preserved**: leave the dispatcher unchanged. Empirical effectively dies on the live path because parametric always succeeds. No reach-contract dilemma but loses Tier 2 entirely.
- **(O3) Quality-gated**: parametric returns `None` only when degenerate (e.g., kernel produced no mass), letting empirical fire as a fallback. Adds policy not in the semantics doc.

Recommendation: **O1**, with the explicit reach contract that empirical updates shape but not reach. §6.8 covers this.

### 4.7 max_tau choice for the carrier kernel

The carrier kernel needs a `max_tau` large enough that `K[max_tau]` is close to eventual reach for long-tailed upstream chains, otherwise the conditional CDF is severely compressed (the long-tail mass gets folded into τ=max_tau and rendered as instant for τ > max_tau). The default `saturation_tau` (often 30-60 days) is adequate for most graphs but not for upstream chains with σ ≥ 1.5.

Heuristic: `max_tau = max(saturation_tau, ceil(τ99 of the worst upstream lognormal))`, capped at 400 to match the subject-side `max_tau=400` precedent at `forecast_runtime.py:1823`. Per-upstream-edge τ99 can be derived from the resolved edge `(μ, σ, onset)` via the lognormal quantile.

This adds machinery. An alternative is to use `max_tau=400` unconditionally for the carrier, matching the subject-side default and removing the heuristic. The cost is slightly more compute in the kernel; the benefit is conservative correctness without per-edge tuning. **Recommendation: max_tau=400 unconditionally for the carrier**, deferring the per-edge τ99 heuristic to a follow-up.

### 4.8 What stops being read on the BE

After the replumb, no live BE caller reads `latency.path_mu`, `latency.path_sigma`, `latency.path_onset_delta_days`, `latency.posterior.path_mu_mean`, `latency.posterior.path_sigma_mean`, `latency.posterior.path_onset_delta_days` for cohort-mode carrier construction. v1/v2 dev-only callers retain their reads via `read_edge_cohort_params`. FE spark charts and lag-fit overlays are unaffected.

`read_edge_cohort_params` and `_build_tier1_parametric` retain their v1/v2 callers and are not deleted. They are dead on the live path.

### 4.9 Reach parity assertion

During migration, the new `eventual_reach` (topological walk in `build_x_provider_from_graph`) and the legacy walk should produce identical values on every graph. Both are the same algorithm, kept in step. The kernel's `span_p` is allowed to differ from eventual reach by the horizon-truncation amount. No assertion needed against the kernel's `span_p`.

---

## 5. Risks and mitigations

### 5.1 Horizon truncation on long-tailed upstream

If `K[max_tau] << eventual_reach`, the conditional CDF compresses the lognormal tail into the horizon, mis-representing arrival timing. With `max_tau=400` per §4.7 this is a concern only for upstream chains with very high σ (above ~2.0) or absurd onset values. A diagnostic counter logs `K[max_tau] / eventual_reach` per carrier build; if persistently low across the test corpus, raise max_tau or implement the per-edge τ99 heuristic.

### 5.2 Conditional vs joint discipline

Every carrier-CDF write/read site must respect: stored is conditional `[0, 1]`; reach is the separate scalar; `joint = reach × conditional` is what consumers compute when they need the joint shape. A targeted unit test asserts `carrier_det_cdf[-1] ≈ 1.0` (the kernel-endpoint normalisation) on every graph. Any consumer that multiplies by reach a second time is a bug.

### 5.3 Enabled-gate change behaviour delta

§4.2's gate change makes Pop C exist in cases where it previously didn't. Expected effects on the v3 chart:

- All-non-latency cohort A≠X: previously cohort = window numerically (collapse to identity → reach=1). After: cohort = reach × subject_progression, producing the small vertical translation that the user has been observing all along (and that §2.1 misattributes to denominator-only).
- Latent-upstream cohort A≠X: shape unchanged (carrier still active); only the *source* of the carrier CDF changes from mixture to kernel.

A regression test on a pre-existing graph where window and cohort are expected to coincide (e.g., A=X) must pass — that case routes through `mode='identity'` and is unaffected.

### 5.4 Three-site migration coordinated

Partial migration (e.g., migrating `build_x_provider_from_graph` but not `build_node_arrival_cache`) leaves the whole-graph CF on a different contract than the single-subject CF. The PR migrates all three; an integration test that exercises whole-graph CF on `gm-rebuild-jan-26` confirms the cache builder behaves consistently with the subject builder.

### 5.5 Tier 1 / Tier 2 / Tier 3 semantics under O1

If empirical-first wins, reach is topological (per §4.6). Empirical's internal `_eventual_reach` is recomputed as a sanity check but not exposed. Acceptance test §6.9 asserts shape differs (empirical CDF vs parametric CDF) when both are available, but reach is identical.

### 5.6 Test rebaseline (intentional, not collateral)

`test_phase1_non_latent_upstream_collapses_to_identity` (test_forecast_state_cohort.py:646) currently asserts `x_provider.enabled is False`, `x_provider.upstream_params_list == []`, `mode='identity'` for non-latent cohort A≠X. Under the new contract: `enabled=True`, `mode='upstream'`, `carrier_det_cdf ≈ [1.0]*N`, `reach > 0`. The test name is also misleading post-change ("collapses to identity" is no longer correct); rename to `test_phase1_non_latent_upstream_produces_dirac_carrier` or similar.

`test_single_hop_non_latent_upstream_collapses_to_window` (test_cohort_factorised_outside_in.py:790) similarly asserts collapse-to-window; it must be rebaselined to assert vertical-translation (cohort = reach × window) shape.

These are intentional rebaselines reflecting the contract change, not test failures to be silently fixed.

### 5.7 WP8 seam non-interference

`PreparedConditioningEvidence` and `direct_cohort_enabled` operate on the rate side (`p`), not the carrier latency. The replumb does not touch the conditioning seam, does not authorise gross-fitted whole-query numerators, and does not change `numerator_representation`.

### 5.8 σ=0 edges in the kernel

Non-latency edges resolve to `(p, 0, 0, 0)`. The kernel's DP convolution must treat σ=0 as Dirac identity (mass passes through unchanged). The subject side already exercises this on non-latency subject edges; mid-chain non-latency edges in long upstream carriers may be less exercised. §6 includes a directed test.

### 5.9 Source-pinning across upstream

Mixed pins per upstream edge are honoured automatically by `resolve_model_params(scope='edge')`. This is a behaviour change in the semantics-doc-aligned direction. Smoke test on a mixed-pin graph.

---

## 6. Acceptance tests

### 6.1 All-non-latency upstream — δ(0) carrier (correct direction)

Synthetic graph: `A → M → X → Y`, both `A→M` and `M→X` non-latency, `X→Y` is the latency subject edge. Cohort query `cohort(A, X-Y)`. Assert:

- `eventual_reach ≈ p(A→M) × p(M→X)`, the topological product.
- `carrier_det_cdf[t] ≈ 1.0` for all `t ≥ 0`, within numerical tolerance. (This is the conditional shape after kernel-endpoint normalisation. Note: a "carrier CDF = 0.0" answer would be the joint shape `reach × 0`, which is the wrong invariant to test; v1 of this plan said 0.0, that was backwards.)
- `XProvider.enabled = True`, `mode='upstream'`. (Today's contract returns `enabled=False`, `mode='identity'`; this assertion is the inverse of `test_phase1_non_latent_upstream_collapses_to_identity`.)
- The v3 chart for this query shows cohort = reach × window vertical translation, not exact overlap.

### 6.2 Single-latency upstream

`A → X → Y`, `A→X` latency `(μ=1.0, σ=0.5)`, `X→Y` latency subject. Assert `carrier_det_cdf[t]` matches the standalone shifted-lognormal CDF of `A→X`, normalised by `K[max_tau]`. `eventual_reach ≈ p(A→X)`.

### 6.3 Two-edge latency chain

`A → M → X → Y` with `A→M` and `M→X` both latency. Assert the conditional CDF matches the kernel's DP-convolved shape; `eventual_reach = p(A→M) × p(M→X)`.

### 6.4 Mixed latency-then-non-latency chain

`A →[latency μ,σ]→ M →[non-latency]→ X → subject Y`. Assert the conditional CDF equals `A→M`'s lognormal CDF (downstream non-latency edge contributes identity); `eventual_reach = p(A→M) × p(M→X)`.

### 6.5 Fanout upstream

`A → {M1, M2}` both reaching X via different probabilities and latencies. Assert the conditional CDF is the kernel's DP-convolved mixture; `eventual_reach` equals the sum of path-probability products. Compare against the legacy `_build_tier1_parametric` mixture: they may differ in cases where the legacy per-direct-incoming-edge interpretation does not match the topology — the new behaviour is correct on fanout, the old one wasn't necessarily.

### 6.6 Source-pin consistency

Same chain, run with analytic vs bayesian pinned globally. Assert conditional CDFs differ in the expected direction.

### 6.7 Reach parity (topological vs legacy)

For every test graph in §6.1-6.6, assert the new topological-walk reach equals the legacy walk's reach to within `1e-9`. Both implementations should be byte-identical; this is a regression check.

### 6.8 Horizon truncation diagnostic

For each test graph, log `K[max_tau] / eventual_reach`. Threshold: ≥ 0.99 expected. Fail the test if any graph in the corpus produces a value below 0.95, indicating the max_tau heuristic needs sharpening.

### 6.9 Tier ordering (O1)

Graph with both empirical observations (snapshot data) and parametric inputs. Assert empirical wins (carrier_tier='empirical'); shape differs from parametric; reach equals topological reach regardless of which tier wins.

### 6.10 Rebaselined existing tests

- `test_phase1_non_latent_upstream_collapses_to_identity` → flipped to assert `enabled=True`, `mode='upstream'`, conditional CDF ≈ [1.0]*N. Renamed to reflect new contract.
- `test_single_hop_non_latent_upstream_collapses_to_window` → flipped to assert cohort = reach × window vertical-translation shape.

These are explicit rebaselines, called out in the PR description and reviewed as contract changes, not bug fixes.

### 6.11 Whole-graph CF integration

Re-run whole-graph CF on `gm-rebuild-jan-26`. Assert per-edge `(p_mean, p_sd, completeness, completeness_stdev)` outputs change only on edges whose upstream chain previously triggered legacy-mixture pollution; assert no unexpected regressions on edges where the upstream chain has clean latency data.

### 6.12 End-to-end on the original problem

`from(household-delegated).to(switch-registered)` on `gm-rebuild-jan-26`. Assert:

- `[v3-debug] upstream_params` no longer shows mu=-3.85, sigma=3.55. Either the trace is removed, or it shows the kernel-derived shape (which for this all-non-latency upstream is `~1.0` from τ=0 in the conditional).
- Cohort and window curves on the v3 chart show the small vertical-translation offset (cohort = reach × window-shape), not the polluted near-instant lognormal collapse.

---

## 7. Migration and rollout

### 7.1 Sequencing

Single PR. All three carrier-construction sites migrate together. Tier ordering decision (O1) made explicitly in the PR. No FE changes required.

### 7.2 Backwards compatibility

CF response shape, cohort_maturity row schema, v3 chart payload unchanged. Internal interfaces (XProvider gains `carrier_det_cdf`/`carrier_mc_cdf`, `enabled` semantics flip, dispatcher order flips) all in this PR.

### 7.3 Persisted-data compatibility

Stale `path_mu`/`path_sigma`/`path_onset_delta_days` on non-latency edges become benign. No re-fit required.

### 7.4 Feature flag

None. Contract change is atomic; clean revert if needed. The reach-parity assertion catches walk-level regressions; the rebaselined tests catch contract regressions.

### 7.5 Removal of legacy code

`read_edge_cohort_params` and `_build_tier1_parametric` retain v1/v2 dev-only callers. Removal is a follow-up PR.

---

## 8. Out of scope

- FE persistence cleanup (UpdateManager atomic-replacement).
- `switch-registered → switch-success` partial path-onset bug (separate FE-topo).
- `model_resolver.py` `scope='path'` divergence (becomes inert).
- Tier 2 empirical methodological alignment (empirical is shape-only here; deeper rework deferred).
- v1/v2 cohort_forecast deprecation.
- B3 mature cohort path-level latents.
- 73b residuals.
- Per-edge τ99 max_tau heuristic (default 400 used; sharpening is follow-up).

---

## 9. Reviewer questions

1. **§4.6 tier ordering**: O1 (empirical-first, recommended), O2 (parametric-first preserved, empirical effectively dies), or O3 (quality-gated)? Load-bearing.
2. **§4.6 reach contract under O1**: reach is topological regardless of tier — confirmed correct? An alternative is that empirical's `_eventual_reach` overrides topological when admissible per the doc's `admission_policy`. The simpler topological-always rule is recommended; the alternative is more principled but adds admission-policy machinery.
3. **§4.7 max_tau**: 400 unconditionally for the carrier (recommended) or per-upstream-edge τ99 heuristic? The unconditional choice trades a small compute cost for not having a tuned knob.
4. **§4.5 inline XProvider construction at api_handlers.py:1380**: migrate as described, or refactor it through `build_x_provider_from_graph` so there is a single carrier construction site in this PR? Refactor is cleaner but expands surface.
5. **§6.5 fanout test**: existing graph in the test corpus, or author a synthetic one?
6. **§5.6 test rename**: ack that `test_phase1_non_latent_upstream_collapses_to_identity` should be renamed in the same PR, or land the contract flip first and rename in a follow-up?

---

## 10. Acceptance

PR merge-ready when:

1. All three carrier-construction sites use factorised composition for `mode='upstream'`. `build_x_provider_from_graph`, `build_node_arrival_cache`, inline at `api_handlers.py:1380`.
2. The `enabled` gate is the new contract per §4.2. `has_semantic_upstream_latency` is no longer the gate condition.
3. Reach is topological; conditional CDFs are normalised by `K[max_tau]`; no consumer multiplies by reach twice.
4. Tier dispatcher ordering decision per §4.6 is explicit; corresponding test in §6.9 passes.
5. Acceptance tests §6.1-6.12 pass.
6. Rebaselined tests §6.10 are renamed and pass under the new contract.
7. Reviewer questions §9 resolved.
8. Briefing-receipt discipline observed for every edit in `graph-editor/lib/runner/**`.
