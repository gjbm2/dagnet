# Model-First Strict Span Cutover Plan

**Status**: active execution plan — strict sequence  
**Date opened**: 13-May-26  
**Scope**: cut over CF span readout to one algebraic span core, starting with model curves and only then moving to evidence spans.

## Purpose

The current branch has partially proven a new span core, but it has not cut over the conditioned-forecast runtime and it has not debranched the engine.

The strategic goal is still:

- no branching logic in the engine;
- one algebraic span core;
- natural degeneration instead of special routes: identity carrier is an empty operator list, non-latent timing is a point mass, single-hop is one operator, multi-hop is many operators, covered-zero is value zero with support, and absent evidence is no support.

This plan replaces broad cutover pressure with a narrower sequence. Each phase must be accepted before the next starts. If code is written ahead of the current accepted phase, that code is treated as unaccepted work-in-progress and does not advance the plan.

## Hard Sequencing Rule

Work proceeds strictly in phase order.

The only legal next action is the first unchecked acceptance item in the earliest incomplete phase. Later-phase code may exist in the working tree, but it is not credited and must not be expanded until all earlier gates are closed.

Closure requires the acceptance gate, not just code existing. A phase with one missing acceptance item is still incomplete.

## Progress Ledger

Current status after the 14-May-26 F-mode cutover, **revised 14-May-26 to correct a scoping error**: the original Phase 5 was declared complete too quickly. It cut over only the **unconditioned overlay** model surfaces (predictive bands and the epistemic model curve). The **conditioned forecast composition** — the composed subject⊗carrier request-rooted CDF that drives the actual `rate` row column for E+F and the scalar `completeness` — still runs through the bespoke `_composed_pair_request_cdf_draws` helper. That is also model-span algebra (operator-chain composition over already-resolved primitive surfaces) and was wrongly classified as "out of strict span scope" in the original audit. Phase 5 has therefore been split into 5a (unconditioned overlays — done) and 5b (conditioned forecast composition — not started). Evidence design (Phase 6) is held until the model-side debranching and the new Phase 5.5 algebraic-spine checkpoint both land.

| Phase | Status |
|---|---|
| 1. Baseline tests (regression boundary established) | **Done** |
| 2. Move core into permanent home (`span_readout.py`, `span_operator_supply.py`, `span_runtime_adapter.py`) | **Done** |
| 3. Pure model curves — unconditioned overlays (`model_curve_*`, F-mode `model_*`) | **Done** |
| 4. Conditioned primitives subject & carrier — replace `_composed_pair_request_cdf_draws` with promoted-core path. *Outside-in gate after.* | **Done** (14-May-26 outside-in confirmed by user) |
| 5. **Debranch #4** — remove model-side branching that the cutover left behind (caller-side `if carrier is None` forks, hardcoded timing-family, etc.). **No deletion** — that is Phase 9. *Outside-in gate after.* | Not started |
| 5.5. **Extract algebraic spine** — introduce a small role/span algebra layer that makes the request-to-carrier-to-subject sequence visible as one contiguous transformation. It must not own frame materialisation, row schema, provenance formatting, or legacy fallback. *Outside-in gate after.* | Not started |
| 6. Reducer spans: subject & carrier for `cohort()` — promoted-core prefix construction. *Outside-in gate after.* | Not started |
| 7. Reducer spans: subject & carrier for `window()` — promoted-core prefix construction. *Outside-in gate after.* | Not started |
| 8. De-branch reducer — `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, identity/active branches in `_selected_cohort_group_rate_draws`. *Outside-in gate after.* | Not started |
| 9. Final cleanup — shadow code, dead code (including `_composed_pair_request_cdf_draws`, currently annotated DEAD CODE in place), grep-based verification sweep that runtime is debranched, docs updated. **All deletions deferred from earlier phases land here as one cohesive cutover.** | Not started |

Verified during attempt 2:

- Promoted span focused suite: `52 passed`.
- Outside-in gate command: `109 passed, 7 xfailed`.
- Lints on touched span/CF files: clean.
- No `*_candidate.py` imports remain under `graph-editor/`.

Verified during the 14-May-26 F-mode cutover:

- Focused span + row-contract suite: `52 passed`.
- Focused F-mode outside-in slice: `3 passed`.
- Lints on touched span/CF files: clean.

Phase 4 progress (14-May-26):

- New helper `_strict_span_request_cdf_draws` added at [cohort_forecast_v3.py:1953](../../graph-editor/lib/runner/cohort_forecast_v3.py). Builds one operator chain per draw (carrier when active, then subject) with `p_draws=ones(S)` because the conditioned spans already incorporate primitive probability; routes through `evaluate_with_operators`. Preserves the legacy `np.clip(0.0, 1.0)` for byte-for-byte parity (clip is debt to be removed in Phase 5, not now).
- Both call sites of `_composed_pair_request_cdf_draws` switched to the new helper: `_runtime_request_cdf_draws` (drives `completeness`) and `_selected_cohort_group_rate_draws` at [cohort_forecast_v3.py:5083](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5083) (drives the conditioned `rate` numerator/denominator). The legacy `_composed_pair_request_cdf_draws` is still defined in the file but unreachable — Phase 5 deletes it.
- Focused promoted-span suite: `53 passed`.
- Outside-in gate command was launched and exited 0, but the agent piped pytest stdout through `| tail -80`, which violated the CLAUDE.md "no truncation on test/build output" rule and means the per-test pass/fail breakdown is **not recorded**. The next agent must re-run the outside-in gate without any `tail` / `head` on the output before Phase 4 can be closed and Phase 5 started.

Phase 5 progress (May 2026, in-progress):

- **Engine layer (`subject_span_composer.py`, `span_kernel.py`)** — `compose_primitive_span` no longer raises on `x == end`. `_build_span_topology` no longer guards on `x == y` (both raw-form and canonical-form guards removed). A zero-edge walk produces a valid empty topology; the composer emits a `ComposedPrimitiveSpan` with `primitive_count = 0`, `draw_count = 0`, `span_p_draws = []`, `cdf_draws = zeros((0, T))`, and algebraic-identity moments (`span_p_mean = 1.0`, `cdf_mean = ones(T)`). The internal `draw_counts != 1` check is replaced with `S = next(iter(draw_counts), 0)`. The "no path with x != y" case still propagates as `None`-topology → `AttributeError` downstream (engine-fail-hard per principle). Three "guard pinning" tests updated to assert the new algebraic behaviour. Focused engine tests green (25/25).
- **Substrate cascade (`primitive_readout.py`)** — Removed the `if carrier_resolutions:` perimeter branch in `compute_resolved_runtime_readout`. `compose_primitive_span` is now called unconditionally for the carrier; identity carrier falls out as a zero-edge composition. Removed the `carrier_is_identity` boolean from `ResolvedRuntimeReadoutResult` (no external consumers — was internal-only). Removed the `carrier_mode: "identity"|"composed"` diag string and the redundant `(carrier_is_identity or composed_carrier is not None)` check in `substituted`. Unconditioned overlays (`ComposedUnconditionedOverlay`) similarly always have a non-None `carrier` — `carrier: ComposedPrimitiveSpan` (no longer Optional). The `composed_carrier: Optional[ComposedPrimitiveSpan]` field on the result is now Optional **only** to carry early-skip signal (`None` = request couldn't be resolved at all), not to signal identity carrier — documented in the dataclass docstring.
- **Helper-layer rewrite (`cohort_forecast_v3.py`)** — `_strict_span_request_cdf_draws` and `_strict_span_model_rate_draws` rewritten to use a single unified per-draw chain builder, `_build_span_per_draw_chain(span, S, days, edge_id, reach_draws)`. The builder works for both subject and carrier roles with no role-flag; mode degenerates by data (a zero-edge composition yields an empty operator chain per draw, composition with an empty prefix is the algebraic identity). Helper bodies are now uniform: `for s in range(S): evaluate_with_operators(operators=carrier_chain[s] + subject_chain[s], …)` — no `if carrier is None`, no `if carrier_ops is not None else`, no shape guards. Result: window() and cohort() and identity-carrier and active-carrier all run the same code path; mode is expressed in the endpoint pair handed to the composer, not in any branch.
- **Outside-in oracle: green.** 51 passed, 2 xfailed (pre-existing strict markers, not regressions). Run took 7m 42s. The cascade — engine `x == end` fix, substrate Optional removal, helper unification — is coherent end-to-end.
- **Annotation in place** — `_composed_pair_request_cdf_draws` carries a "DEAD CODE — superseded, retained for Phase 9 deletion" docstring. No callers as of Phase 4.
- **Design spine annotated in code (14-May-26)** — a comment block was added to [cohort_forecast_v3.py](../../graph-editor/lib/runner/cohort_forecast_v3.py) immediately above `_build_span_per_draw_chain`, preserving the algebraic spine of subject/carrier span construction. The spine names two distinct clock data values per primitive: `T1` (conditioning clock: arrival-map root used to weight evidence rows) and `span_root` (composition / readout origin for a whole carrier or subject span). `window(X-Z)` sets `T1 = source(prim)` per subject primitive (local) and `subject_span_root = X`. `cohort(A, X-E)` sets `T1 = A` on every carrier primitive with `carrier_span_root = A`, and `T1 = X` on every subject primitive with `subject_span_root = X`. The conditioning layer (upstream in `primitive_readout` / `primitive_conditioning`) builds an arrival-day weight map at each primitive's source via `build_arrival_map(root=T1[prim], target=source(prim))`, which degenerates to identity (delta at t=0) when `T1 == source` and propagates from composed `root → source` timing otherwise; the map is normalised conditioning support, with reach kept on a separate surface. Composition then runs `compose(carrier_prims, root=A)` and `compose(subject_prims, root=X)`. The key invariant for `window(X-Y-Z)`: only the displayed denominator / window population is fixed at `X`; the `Y→Z` primitive still has local `n=Y`, `k=Z`, and composition propagates X-rooted mass through Y to Z. Local conditioning at the primitive layer plus X-rooted span at the composition layer — both honest, no double-bookkeeping.
- **Reach asymmetry eliminated (14-May-26)** — `_build_span_per_draw_chain` signature changed: `reach_draws: Optional[np.ndarray] = None`, defaulting to `span.span_p_draws` (the span's natural reach) when the caller omits it. Both call sites in `_strict_span_model_rate_draws` now omit `reach_draws` entirely — subject and carrier are passed identically. Carrier reach now appears in both numerator (carrier + subject chain) and denominator (carrier chain) and cancels symbolically in the rate ratio rather than being pre-cancelled by hard-coding `ones(S)` on the carrier. Algebraically equivalent to the prior form (carrier reach cancels in numerator/denominator). `_strict_span_request_cdf_draws` continues to pass `ones(S)` explicitly on both calls — that is the "conditioned CDF emission" mode where conditioning has already absorbed primitive probability into the CDF shape; both calls remain symmetric.

Phase 5 residual work (not yet done):

- **Residual identity guard in `_compose_draws`** ([subject_span_composer.py:362-385](../../graph-editor/lib/runner/subject_span_composer.py#L362-L385)): an `if n_edges == 0: return identity-element ComposedPrimitiveSpan` block at the top of the function. Required to produce algebraic identity values (reach=1, cdf=ones) without `np.mean(empty_array)` emitting NaN that the JSON serialiser rejects. Removing it cleanly requires one of: making `span_p_mean` / `cdf_mean` computed properties on the dataclass; pre-loop initialisation of accumulators to identity values; or NaN-tolerant response serialisation.
- **Supply-boundary identity check in `_build_span_per_draw_chain`** ([cohort_forecast_v3.py](../../graph-editor/lib/runner/cohort_forecast_v3.py)): `if cdf is None or cdf.shape[0] == 0: return tuple(() for _ in range(S))`. This is the only remaining "this is identity carrier" recognition in the chain build; eliminating it requires either operator-chain-per-edge representation (so an empty chain naturally falls out from iterating zero edges, no shape check needed) or accepting it as a perimeter shape inspection.
- **Pre-existing stale unit tests in `test_span_runtime_adapter.py`** (`test_strict_span_model_rate_matches_identity_carrier_formula` and `test_strict_span_model_rate_matches_active_carrier_formula`): these failures pre-date this work and were introduced in commit `993eaffa` ("Generalising (again........)" — current HEAD), which refactored `_strict_span_model_rate_draws` to route through `_build_span_per_draw_chain` but did not update the test fixtures. The fixtures use `types.SimpleNamespace(span_p_draws=..., cdf_draws=...)` for the subject without `is_draw_coherent`, and the new helper accesses `span.is_draw_coherent` unconditionally — so the tests crash with `AttributeError`. Fix is trivial (add `is_draw_coherent=True` to each subject fixture) but is not strictly Phase 5 scope. The outside-in oracle is the canonical gate per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` and is the load-bearing test for this work. A `denominator > 1e-9` threshold-edge subtlety exists in `_strict_span_model_rate_draws` (the threshold compares the actual `carrier.span_p × carrier_CDF` product rather than `carrier_CDF` alone after the symmetry change); same arithmetic rate value where the threshold passes, only the cutoff into `rate = 0` shifts slightly for very small `carrier.span_p`. Should be verified by a fresh outside-in run before declaring Phase 5 closed.

Next legal action:

1. Decide the residual `_compose_draws` identity-block design (computed properties vs pre-loop init vs NaN-tolerant serialiser).
2. Resolve the remaining Phase 5 verification fallout from the reach-symmetry change: stale focused fixtures in `test_span_runtime_adapter.py`, the very-small-carrier-threshold edge case in `_strict_span_model_rate_draws`, and a fresh outside-in gate.
3. Phase 5 acceptance gate (outside-in oracle, focused suites) re-run after each design decision lands.
4. After Phase 5 closes, Phase 5.5 is the next legal checkpoint. Do not start evidence operator design until the algebraic spine exists and its gate is green.
5. Do not edit evidence reducer code or selected-prefix code until Phase 5.5 closes.
6. Do not start Phase 6 (evidence operator contract) until Phase 5.5's gate is closed.

## Open Work Routing Ledger

This ledger assigns the remaining known work to a phase so later agents do not treat review findings as floating follow-ups.

| Work item | Owning phase | Boundary / acceptance signal |
|---|---|---|
| Residual zero-edge identity block in `_compose_draws` | Phase 5 | Either retained as an explicitly accepted algebraic identity perimeter or replaced by a cleaner identity accumulator/computed-property design; focused span suite and outside-in gate remain green. |
| Residual supply-boundary identity shape check in `_build_span_per_draw_chain` | Phase 5 | Either replaced by operator-chain-per-edge construction where empty chains fall out naturally, or explicitly documented as a perimeter shape inspection; no evaluator-level mode branch. |
| Focused-test and threshold fallout from the reach-symmetry change | Phase 5 | Stale `test_span_runtime_adapter.py` fixtures are updated without weakening intent; the tiny-denominator cutoff in `_strict_span_model_rate_draws` is verified or adjusted deliberately; focused model tests and outside-in gate remain green. |
| Large "Strict-span algebra — design spine" comment currently embedded in `cohort_forecast_v3.py` | Phase 5.5 | Replaced by a small maintained algebra layer plus concise code comments; the executable code, not a comment block, becomes the source reviewers read. |
| Extracted carrier/subject algebra layer | Phase 5.5 | One small code surface exposes request roles, conditioning roots, carrier span, subject span, and request-level model readout without frame evidence, row schema, provenance formatting, or fallback policy. |
| Stale identity-carrier comments that say `composed_carrier is None` after zero-edge carrier cutover | Phase 8 or Phase 9, depending on touched code | If in reducer code being debranched, fix during Phase 8. If only residual documentation after deletion, fix during Phase 9 cleanup. No stale comment may remain at final acceptance. |
| Evidence operator contract: value/support/frontier/midpoint policy | Phase 6 | Contract written in prose before code; explains covered-zero vs absent support and protects the known regression clusters. |
| Denominator and numerator evidence prefixes | Phase 7 | Row evidence and reducer frontier read the same promoted prefix object; `_CarrierOnlyDenominatorPrefix` / `_RateAttributedSubjectPrefix` stop being authorities for migrated roles. |
| Identity/active branches inside `_selected_cohort_group_rate_draws` | Phase 8 | Reducer is deleted or reduced to semantics-free `ΣY / ΣX` aggregation over promoted prefix surfaces; no Pop C / Pop D carrier-subject convolution remains outside the promoted plan/core contract. |
| `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, and old observed-prefix authorities | Phase 8 | Deleted or demonstrably unreachable as runtime authorities; outside-in oracle remains green. |
| Dead code and shadow/candidate residue, including `_composed_pair_request_cdf_draws` | Phase 9 | Removed in one cohesive final cleanup after migrated callers are green; grep verifies no old authority remains. |
| Codebase docs that describe candidate/shadow or old prefix architecture as current | Phase 9 | Maintained docs describe the promoted span architecture; candidate docs are archived or clearly superseded. |

## Baseline And Current Code Status

Baseline investigation on 13-May-26 found:

- The isolated candidate core exists under `docs/current/project-generalise/`: `span_readout_candidate.py`, `span_operator_supply_candidate.py`, `runtime_model_span_adapter_candidate.py`, and candidate pytest files.
- The candidate pytest files passed: 53 tests passed when run with pytest.
- The production shadow file `graph-editor/lib/runner/generalised_span_model_shadow.py` existed with its own independent dense operator-chain algebra.
- `graph-editor/lib/tests/test_generalised_span_model_shadow.py` passed: 5 tests passed.
- Production row authority still lives in `cohort_forecast_v3.py`: `SelectedAClockEvidence`, `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `_selected_cohort_group_rate_draws`, and `_project_runtime_rows`.
- The README currently suggests a `unittest discover` candidate command, but the candidate tests are pytest-style; that command found zero tests.
- A previous release attempt recorded 14 failures across outside-in and selected-evidence suites. Those failures are the regression boundary for this plan.

Current F-mode-cutover state:

- `graph-editor/lib/runner/span_readout.py`, `span_operator_supply.py`, and `span_runtime_adapter.py` now exist.
- No `*_candidate.py` imports remain under `graph-editor/`.
- `generalised_span_model_shadow.py` no longer owns independent algebra; it delegates to `span_readout.py`. Its name and diagnostic hook still create confusion, but cleanup is final hygiene and does not block model cutover.
- `model_curve_*` and F-mode `model_midpoint` / `model_bands` currently route through the promoted core. They consume `runtime.unconditioned_overlays`; no conditioned primitives enter this path.
- The **conditioned forecast composition** — composing `runtime.composed_subject` and `runtime.composed_carrier` into a request-rooted CDF — now routes through `_strict_span_request_cdf_draws` and the promoted span core. The old `_composed_pair_request_cdf_draws` helper is annotated as dead code and retained only for the Phase 9 deletion pass.
- E+F reducer prefix construction, evidence prefixes, and the selected-prefix family are not cut over. These are evidence concerns and are deferred to Phase 6+.

Conclusion: the branch has the model-side carrier/subject span path mostly cut over to the promoted core. Phase 5 remains open only for residual model-side debranch and verification work listed above. The next work after Phase 5 is the Phase 5.5 algebraic-spine extraction; evidence operator design remains blocked until that checkpoint closes.

## Non-Negotiable Rules

- No shadow-only acceptance. A passing diagnostic comparison is not cutover.
- No flag-off acceptance. A path that only passes because old code still answers production is incomplete.
- No new old/new production branch. Temporary diagnostics may exist during one atom, but the stage is not complete until the temporary branch is gone.
- No oracle weakening. Do not change outside-in assertions, tolerances, fixtures, DSLs, or xfail markers to make this work.
- No candidate imports from production or production tests after promotion.
- No engine fallback code. Defence and shape refusal live at the perimeter, not inside the span evaluator.
- No phase jumping. Do not start or expand work in Phase N+1 until Phase N is accepted.
- No "mostly done" phase closure. Missing one acceptance item means the phase is incomplete.
- No "follow-up" escape hatch at the end. The final phase is not complete until old authorities are deleted, docs are updated, and all gates are green.

## Permanent Homes

Promote the candidate work into stable runtime modules before any CF cutover:

- `graph-editor/lib/runner/span_readout.py`: pure algebra core. Owns root value/support, ordered operators, ledger propagation, prefix projection, support propagation, and provenance.
- `graph-editor/lib/runner/span_operator_supply.py`: production operator construction. Owns conversion from already-resolved primitive/model/evidence surfaces into `SpanOperator` objects.
- `graph-editor/lib/runner/span_runtime_adapter.py`: thin adapter from `ResolvedCFRuntime` and `ConditionedTransitionPrimitive` shapes into span plans. This module may inspect runtime semantics; the evaluator must not.

`generalised_span_model_shadow.py` must not keep independent algebra. Any remaining shadow-named diagnostic wrapper is final cleanup, not a blocker for model cutover, because accepted execution paths do not call it.

## Pre-Implementation Audit: Call-Site Inventory

**Status**: complete as of this update. This was missing pre-plan hygiene and should have been done before the plan and before code changes.

This inventory is the authority for what still needs cutover. It covers span-like model, evidence, selected-prefix, reducer, and diagnostic surfaces in `cohort_forecast_v3.py`.

| Surface | Role | Current implementation | Promoted span core status | Cutover implication |
|---|---|---|---|---|
| `_runtime_provenance_with_generalised_span_shadow` | Diagnostic provenance hook | Calls `generalised_span_model_shadow` when `emit_diagnostics=True`; adds `generalised_span_model_shadow` to runtime provenance. | Diagnostic-only; not on accepted cutover execution path. | Final cleanup should delete or rename/formally own this hook. It does not block model cutover. |
| `_build_generalised_span_shadow_plans` | Diagnostic model comparison plan builder | Rebuilds carrier/subject/request plans from runtime primitive resolutions and expected composed spans. | Diagnostic-only; uses shadow wrapper. | Final cleanup should delete or rename/formally own it. It is not production cutover. |
| `_build_generalised_evidence_shadow_plans` | Diagnostic evidence comparison plan builder | Converts selected evidence aggregates into shadow plans. | Diagnostic-only; not accepted evidence cutover. | Final cleanup should delete it before declaring the project done unless a non-shadow diagnostic owner is explicitly retained. |
| `_composed_pair_request_cdf_draws` | Conditioned request-rooted CDF composition | Pads carrier/subject CDF draws from `composed_subject` / `composed_carrier` (the conditioned spans) and convolves them per draw; uses `np.clip`. | Legacy bespoke composition; **mis-classified previously as out-of-scope**. | This is model-span algebra over conditioned primitive surfaces — operator-chain composition with no support frontier or evidence ledger. It must route through the promoted core in Phase 5b. Its callers are `_selected_cohort_group_rate_draws` (the conditioned `rate` numerator/denominator) and `_runtime_request_cdf_draws` (completeness). |
| `_strict_span_model_rate_draws` | Unconditioned overlay rate draws | Builds promoted span operators from `runtime.unconditioned_overlays` and evaluates them through `span_readout.py` for both F-mode `model_*` and opt-in `model_curve_*` overlays. | Promoted core. | F-mode and model-curve now differ by supplied unconditioned overlay basis, not evaluator. Phase 5b will add a sibling entry point that consumes `runtime.composed_subject` / `runtime.composed_carrier` and routes the conditioned forecast through the same core. |
| `_runtime_request_cdf_draws` / `_runtime_completeness` | Conditioned request-rooted CDF and scalar completeness readout | Uses `_composed_pair_request_cdf_draws` to compose the conditioned request-rooted CDF, then projects scalar completeness at selected cohort frontier ages. | Legacy bespoke composition; **mis-classified previously as out-of-scope**. | The composition step is a model-span operation and is in scope for Phase 5b. The scalar projection (frontier-age sampling) on top of the resulting CDF is a pure post-projection and is not a span operator. |
| `_build_selected_cohort_projection_bases` | E+F reducer basis | Builds selected-Cohort model/evidence basis from engine cohorts and selected prefixes. | Not promoted. | Boundary item between model and evidence phases. It shapes reducer inputs and must not grow new semantics. |
| `_root_window_carrier_n_by_anchor_day` | Root mass / evidence admission for selected cohorts | Reads flat request candidate pool to derive selected base mass. | Perimeter/admission logic, not span evaluator. | May remain outside the core, but must be named as operator/root-surface supply when evidence cutover starts. |
| `_build_selected_source_day_mass` / `_SelectedSourceDayMass` | Selected source-day mass `M_select(U,C,u)` | Composes A-rooted timing and builds bespoke mass surface. | Legacy selected-prefix authority. | Phase 5 must replace or narrow this as a runtime authority. |
| `_build_carrier_only_denominator_prefix` / `_CarrierOnlyDenominatorPrefix` | Denominator evidence prefix `X_prefix` | Builds bespoke carrier-only prefix from selected source-day mass. | Legacy selected-prefix authority. | Phase 5 denominator-prefix target. |
| `_build_observed_span_evidence_surface` / `_build_zero_edge_observed_surface` | Observed support/value surface | Builds carrier/subject observed surfaces, including zero-edge degeneracy. | Legacy evidence-surface builder; not promoted. | Phase 4 must decide evidence operator contract before touching this. Phase 5 must then migrate it deliberately. |
| `_join_conditioned_carrier_backmap` | Subject-row placement onto A-clock | Places subject evidence via carrier backmap. | Evidence placement, not promoted. | Phase 4 contract must preserve this semantics before evidence code changes. |
| `_build_rate_attributed_subject_prefix` / `_build_evidence_local_rate_attributed_subject_prefix` / `_RateAttributedSubjectPrefix` | Numerator evidence prefix `Y_prefix` | Builds rate-attributed subject prefix through bespoke evidence propagation. | Legacy selected-prefix authority. | Phase 5 numerator-prefix target. |
| `_build_selected_a_clock_evidence_from_runtime` / `SelectedAClockEvidence` | Selected A-clock evidence cells | Combines X prefix, Y prefix, observed surfaces, support/frontier diagnostics. | Legacy evidence cell/readout authority. | Phase 5 must ensure row evidence, support, and reducer frontier read the same promoted prefix object before this loses authority. |
| `_selected_cohort_group_rate_draws` | E+F selected-Cohort reducer | Owns Pop D / Pop C mass projection and divides `ΣY / ΣX`. Contains identity/active branching. | Not promoted. | Evidence/reducer phase target. It must eventually stop owning semantic carrier/subject projection or become a pure aggregator over promoted prefix surfaces. |
| `_project_runtime_rows` / `_overlay_rate_draws` | Row projection orchestrator | Model-only overlays route through `_strict_span_model_rate_draws`; E+F uses selected reducer; evidence uses selected evidence buckets; completeness is a scalar request-CDF projection. | Mixed. | The F-mode/model-curve split is closed. Evidence/reducer work remains later-phase. |
| `compute_cohort_maturity_rows_v3` | Public row-builder entry | Builds runtime, selected prefix objects, selected evidence, projection bases, then projects rows. | Mixed. | Final acceptance requires this entry to assemble plans/surfaces and call one promoted span path, not wire old and new authorities side-by-side. |

Audit conclusion (revised 14-May-26):

- The promoted core is on the accepted execution path for `model_curve_*` and F-mode `model_*` overlays; the unconditioned-overlay slice of model cutover is complete (Phase 5a).
- The **conditioned forecast composition** still runs through `_composed_pair_request_cdf_draws`. This is model-span algebra over conditioned primitive surfaces and is the next legitimate model-only cutover (Phase 5b). The original audit incorrectly classified this as out-of-scope; the correction is that "model" includes conditioned model composition, not only unconditioned overlay bands.
- The reducer-side span work — selected A-clock evidence, selected-Cohort reducer prefix construction, denominator and numerator evidence prefixes, support frontier, covered-zero policy — is a separate body of work and remains the proper scope of Phase 6+. It is genuinely distinct from model composition because it introduces value/support separation, support frontier propagation, midpoint and interpolation policy, and admission semantics.
- Shadow diagnostics are not needed for accepted execution and do not block model cutover, but they must be removed or renamed before final acceptance.
- The next action is therefore Phase 5b. Do not start the evidence operator contract or touch evidence reducer code until 5b is accepted.

## Phase 1: Promote The Pure Core

**Status**: complete.

Move the candidate core into `graph-editor/lib/runner/span_readout.py` without changing production CF behaviour.

Deliverables:

- Move candidate tests into `graph-editor/lib/tests/` and update imports to the promoted module.
- Delete or retire the candidate test dependency on `docs/current/project-generalise/`.

Acceptance gate:

- Candidate proof still passes through the promoted production module.
- Grep shows no production or production-test import of `span_readout_candidate`.
- There is one dense value/support evaluator in production.
- The progress ledger above is updated to mark Phase 1 complete.
- No Phase 2 work may be expanded until this gate is satisfied.

## Phase 2: Promote Model Operator Supply

**Status**: complete.

Before touching evidence, promote only model operator construction.

Deliverables:

- Move model operator supply into `span_operator_supply.py`.
- Preserve draw-family coherence. The production path must compute joint mass from same-index primitive draws where draws are available, not `E[p] * E[CDF]` unless explicitly labelled as a diagnostic.
- Add a non-latent / deterministic timing test proving point-mass degeneration through the same operator path.
- Add a production-path smoke test for the exact model surface that Phase 3 will cut over.
- Use the pre-implementation audit's model call-site list in this phase and mark which model calls are eligible for cutover.

Acceptance gate:

- Latent, non-latent, deterministic, single-hop, and multi-hop model operators all feed the same span core.
- Draw-coherent and deterministic degeneracy tests pass.
- No evidence row logic has changed.
- The progress ledger above is updated to mark Phase 2 complete.
- No Phase 3 work may be expanded until this gate is satisfied.

## Phase 3: Cut Over Model Curve First

**Status**: complete.

Cut over the model-curve row surface before F-mode, E+F, or evidence rows.

The first production target is the model-curve overlay surface, currently emitted as `model_curve_midpoint`, `model_curve_*`, and `model_curve_bands`. This is the lowest-risk surface because it is model-only and does not own selected A-clock evidence, support frontiers, or the E+F boundary.

Deliverables:

- Build a model span plan from the runtime's resolved model primitives.
- Route model-curve readout through the promoted core.
- Remove the old model-curve helper as an authority for that surface once parity is proven.
- Keep any comparison diagnostics temporary and diagnostic-only.

Acceptance gate:

- Model-curve output is produced by the promoted span core only.
- The old model-curve readout helper is no longer reachable for that surface.
- Existing model-curve tests pass, plus the new draw-coherence and degeneration tests.
- Evidence fields (`rate`, `evidence_x`, `evidence_y`, coverage, frontier) are unchanged.
- The model-curve path has no old/new comparison, no shadow route, and no candidate import.
- The outside-in smoke subset for model-curve-adjacent rows passes.
- The progress ledger above is updated to mark Phase 3 complete.
- No Phase 4 gate run may be credited until this gate is satisfied.

## Phase 4: Outside-In Oracle Gate

**Status**: complete for the model cutover gate.

Before evidence-span work starts, the model cutover must have outside-in coverage. The full oracle suite passed after the model-curve cutover, and the focused F-mode outside-in slice passed after the F-mode cutover.

Minimum gate:

- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`
- `graph-editor/lib/tests/test_selected_evidence_natural_degeneracy.py`
- `graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py`
- `graph-editor/lib/tests/test_multihop_evidence_parity.py`
- `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`
- `graph-editor/lib/tests/test_doc56_phase0_behaviours.py`
- The focused promoted span suite, including the renamed replacement for `test_generalised_span_model_shadow.py` after shadow retirement.

Acceptance gate:

- No outside-in oracle failure.
- No new xfail.
- No loosened tolerance.
- No fixture or DSL weakening.
- If any oracle fails, stop and fix the model cutover before touching evidence spans.
- The progress ledger above is updated to mark Phase 4 complete.
- No Phase 5 work may start until this gate is satisfied.

## Phase 5: Cut Over Remaining Model Span Calls

**Status**: complete for model-only span surfaces.

After the oracle gate, migrate the remaining model-only span surfaces.

Deliverables:

- Route F-mode model surfaces through the promoted core.
- Route request-level model span projections through the promoted core.
- Remove the conditional split where `basis == 'epistemic'` uses the promoted core and predictive F-mode uses legacy helper logic.
- Route every model-only surface through one span-plan path. F-mode and model-curve differ by supplied primitive surfaces or dispersion basis, not by evaluator.
- Reducer narrowing is evidence/reducer work and is not part of the model-only span cutover gate.

Acceptance gate:

- Model readout uses the promoted model span path; evidence readout migration is deferred to the evidence phases.
- No model path asks whether a request is identity carrier, active carrier, single-hop, multi-hop, latent, or non-latent inside the evaluator.
- F-mode and model-curve both call the same promoted model span path.
- Outside-in oracle gate remains green.
- The progress ledger above is updated to mark Phase 5 complete.
- No Phase 5.5 work may start until this gate is satisfied.

## Phase 5.5: Extract Algebraic Spine

**Status**: not started.

Before evidence-span work starts, make the carrier/subject algebra visible as one small maintained code surface. The aim is not to lift all of `cohort_forecast_v3.py` out in one behavioural rewrite. The aim is to extract the mathematical spine so the current orchestration calls one role/span layer instead of re-expressing the request semantics across scattered helpers.

The extracted spine owns only the durable algebraic sequence: request roles, primitive conditioning roots, carrier span composition, subject span composition, and the handoff to request-level readout. It must not own frame materialisation, selected-Cohort row schema, provenance formatting, session diagnostics, old/new comparisons, or legacy fallback policy. Those remain at orchestration or projection boundaries until their own phases deliberately migrate them.

Deliverables:

- Add or identify one maintained role/span algebra layer whose implementation is short enough that reviewers can follow the full carrier and subject sequence in one place.
- Make `cohort_forecast_v3.py` call that layer for the model-side carrier/subject sequence instead of locally rebuilding the same semantic decisions.
- Preserve the Phase 5 model-span behaviour exactly unless the plan explicitly records a semantic upgrade.
- Keep window, cohort, identity carrier, active carrier, single-hop, multi-hop, latent, and non-latent cases as data or algebraic degeneracies at the supply boundary, not branches in the extracted spine.
- Do not migrate evidence prefixes, selected A-clock evidence, or reducer Pop C / Pop D arithmetic in this phase.

Acceptance gate:

- One code location is the visible source of the carrier/subject algebraic sequence from role resolution through composed spans.
- The extracted layer has no frame evidence materialisation, row projection, provenance formatting, shadow comparison, or fallback responsibility.
- Existing model-span and conditioned-request readout tests remain green.
- The outside-in oracle gate remains green.
- The progress ledger above is updated to mark Phase 5.5 complete.
- No Phase 6 work may start until this gate is satisfied.

## Phase 6: Evidence Span Design Checkpoint

**Status**: not started.

Only after Phase 5.5 should evidence-span work start. Do not begin by editing the row projection.

Deliverables:

- Write the evidence operator contract in prose before code.
- Explicitly define covered-zero versus absent support.
- Define how midpoint shift, interpolation correction, source-day-specific evidence, and support frontier enter operator supply.
- Define how selected A-clock evidence, row evidence, and reducer frontier all read the same prefix object.

Acceptance gate:

- Reviewers can point to one contract section for value, support, coverage, frontier, and midpoint policy.
- The contract explains how the previous 14-failure clusters are protected.
- The progress ledger above is updated to mark Phase 6 complete.
- No Phase 7 evidence code may start until this gate is satisfied.

## Phase 7: Cut Over Evidence Prefixes

**Status**: not started.

Replace evidence prefix authority one role at a time.

Order:

1. Denominator evidence prefix.
2. Numerator evidence prefix.
3. Coverage/support projection.
4. Frontier state.
5. Reducer frozen-prefix inputs.

Acceptance gate:

- Row evidence and reducer frontier read the same promoted prefix object.
- `SelectedAClockEvidence.aggregate_by_tau` no longer owns amplitude if a promoted prefix exists.
- `_CarrierOnlyDenominatorPrefix` and `_RateAttributedSubjectPrefix` are no longer authorities for migrated roles.
- Outside-in oracle gate remains green after each role.
- The progress ledger above is updated to mark Phase 7 complete.
- No Phase 8 deletion may start until this gate is satisfied.

## Phase 8: Delete Branches And Dead Code

**Status**: not started.

Deletion is part of cutover, not cleanup.

Delete or make unreachable:

- candidate imports from production and production tests;
- independent `generalised_span_model_shadow.py` algebra;
- `_SelectedSourceDayMass` as runtime authority;
- `_CarrierOnlyDenominatorPrefix` as runtime authority;
- `_RateAttributedSubjectPrefix` as runtime authority;
- `_selected_cohort_group_rate_draws` as a semantic carrier/subject projection engine;
- any local-window or zero-delay denominator substitution branch;
- row-projection branches that exist only for identity versus active carrier routing;
- old/new comparison branches used during development.

Acceptance gate:

- Grep shows one production span evaluator.
- Grep shows no `candidate` import in production runtime or production tests.
- Grep shows no independent shadow evaluator.
- Grep shows no semantic Pop D / Pop C projection outside the promoted plan/core contract.
- Outside-in oracle gate remains green.
- The progress ledger above is updated to mark Phase 8 complete.
- No documentation close-out may start until this gate is satisfied.

## Phase 9: Documentation Close-Out And Final Proof

**Status**: not started.

Update the maintained codebase docs so the next agent reads the architecture that actually exists.

Deliverables:

- Update `CF_ROW_PIPELINE.md` to describe the promoted strict span readout as the row/model/evidence readout architecture.
- Update `FORECAST_RUNTIME_ARCHITECTURE.md` to describe the stable span plan/compiler/evaluator boundary.
- Update `CF_PRIMITIVE_SUBSTRATE.md` to describe how primitive-bound model and evidence surfaces become span operators.
- Update `CF_DEFENSIVE_FINDINGS.md` to retire or narrow findings that are genuinely fixed.
- Archive or clearly mark superseded candidate docs under `docs/current/project-generalise/` so they cannot be mistaken for maintained implementation.
- Run the final focused span suite and the full outside-in oracle gate.

Acceptance gate:

- Docs and code agree.
- No active doc describes candidate or shadow modules as the production strategy.
- Focused span suite is green.
- Outside-in oracle gate is green.
- Grep confirms no candidate imports, no shadow evaluator, and no old selected-prefix runtime authority.
- The progress ledger above is updated to mark Phase 9 complete.

## Final Acceptance State

The work is complete only when all of these are true:

- The permanent span core lives under `graph-editor/lib/runner/` and has no candidate or shadow naming.
- Every CF model span call routes through the promoted core.
- Every CF evidence span call routes through the promoted core.
- The engine core contains no branching logic for identity carrier, active carrier, single-hop, multi-hop, latent, non-latent, model, or evidence.
- Those cases appear only at operator/root-surface supply boundaries and degenerate naturally in the algebra.
- The old selected-prefix family is deleted or demonstrably unreachable as runtime authority.
- The outside-in oracle suite is green with no new xfails, no weakened tolerances, and no fixture changes made to hide regressions.
- Codebase docs describe the promoted span core as the maintained CF row/readout architecture.

Anything short of this is not cutover. Anything with a live old/new route is not debranched.

## Stop Conditions

Stop and report if:

- a model-curve migration changes evidence rows;
- the promoted core needs evaluator-level mode branching;
- a production fallback is needed to keep tests green;
- draw-family coherence cannot be preserved;
- covered-zero and absent evidence cannot be distinguished;
- any outside-in oracle fails after model-curve cutover;
- deleting an old prefix class reveals an unplanned caller.

## Appendix A: Algebraic Spine Template

This appendix is the intended review template for Phase 5.5. It is deliberately prose, not implementation pseudocode: the actual code may choose names and boundaries that fit the surrounding modules, but reviewers must be able to point to one small maintained surface that follows this sequence.

1. Resolve request roles.
   The request resolves to a selected population root `R`, denominator node `X`, subject end `E`, a carrier role over `R -> X`, and a subject role over `X -> E`. For `window()` and `cohort(R = X)`, the carrier role is the zero-edge identity. Single-hop and multi-hop differ only by the number of subject operators.

2. Assign conditioning roots.
   Carrier primitives use the carrier root `R` as their conditioning root. Cohort subject primitives use `X` as their conditioning root. Window subject primitives use each primitive's own source node as their conditioning root. These roots are data supplied to the binding layer; they are not mode branches inside the algebra.

3. Build primitive arrival weights.
   For each primitive `U -> V`, build arrival-day weights at `U` from its conditioning root to `U`. Root-equals-`U` is the identity arrival map. Root-not-equals-`U` is the propagated arrival map through the already-resolved upstream timing. These weights are normalised timing support for evidence binding; primitive reach remains a separate fitted surface.

4. Bind and condition primitives.
   Each primitive binds the common request candidate pool against its own arrival weights, then passes the resulting weighted view through the single conditioning locus. The output is a conditioned primitive with local reach and local conditional timing for `U -> V`. No span composition, row projection, reducer, or scalar path re-conditions a primitive.

5. Compose role spans.
   The carrier role composes its conditioned primitives into the `R -> X` carrier span, with zero-edge identity when `R = X`. The subject role composes its conditioned primitives into the `X -> E` subject span. Composition consumes local primitive transition operators and produces role-labelled span reach plus conditional timing; it does not know whether the caller is window, cohort, identity carrier, active carrier, single-hop, or multi-hop.

6. Produce request-level readout surfaces.
   Model-side request readout combines the carrier and subject spans through the promoted span core. Conditional request CDF, model-rate surfaces, and scalar completeness all read from these composed role surfaces. Evidence prefixes and selected-Cohort reducer surfaces are intentionally outside Phase 5.5 unless a later phase migrates them onto the same algebraic contract.

7. Hand off to orchestration and projection.
   The spine returns role-labelled spans, request-level model readout surfaces, and enough provenance for callers to describe what happened. It does not materialise frame evidence, build selected A-clock row fields, format response rows, run shadow comparisons, or choose legacy fallbacks.

The acceptance question for Phase 5.5 is: can a reviewer read one code surface and see this sequence directly, without reconstructing carrier/subject semantics by chasing scattered helpers in `cohort_forecast_v3.py`?
