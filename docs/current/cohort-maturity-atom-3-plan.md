# Cohort Maturity — Atom 3 Implementation Plan

**Status**: planning
**Date**: 12-May-26
**Scope**: retire the frame-derived `engine_cohort.obs_x/obs_y` substrate from the v3 selected-cohort path; fix the wiring defects that the atom 2 closure gate masked; install a durable guard against AP59 silent-rescue recurrence.
**Cross-references**:
- [`cohort-maturity-evidence-coverage-design.md`](cohort-maturity-evidence-coverage-design.md) — parent design (atoms 1–3); §5.3 and §6 risk #8 motivate this plan
- [`codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — invariants 1, 6, 9, 12
- [`codebase/FORECAST_RUNTIME_ARCHITECTURE.md`](codebase/FORECAST_RUNTIME_ARCHITECTURE.md) — `SelectedAClockEvidence`, refusal-vs-degradation contract
- [`codebase/KNOWN_ANTI_PATTERNS.md`](codebase/KNOWN_ANTI_PATTERNS.md) — AP58 (over-branching), AP59 (silent rescue under a green gate)

---

## 1. Premise

Atom 2 was declared closed by a named end-to-end parity test (`test_end_to_end_parity_window_vs_cohort_a_equals_x_row_dicts`) that asserts row-dict equality between equivalent `window(X→end)` and `cohort(A=X, X→end)` queries. Code review during atom 3 planning has established that the test fixture **manually pre-populates** `runtime.selected_source_day_mass` and `runtime.selected_x_prefix` before calling the row builder, bypassing the production wiring step (`_root_window_carrier_n_by_anchor_day` and the `n_by_anchor`-gated assignment in `compute_cohort_maturity_rows_v3`). That production wiring contains a slice-family filter that admits only `SliceFamily.WINDOW` rows. For a `cohort(A=X)` request, the X-rooted candidates carry `SliceFamily.COHORT`, the filter starves the n_by_anchor map, the unified builder refuses with `runtime_did_not_resolve_selected_source_day_mass`, and the reducer's branch-3 silently reads legacy `engine_cohort.obs_x/obs_y`. The parity test is green via the rescue, not via the unified path.

The same slice-family filter exists a second time, on the carrier-side observed-span evidence surface. For an active `cohort(A != X)` query whose request slice is itself a `cohort(...)` section, the carrier-chain rows are dropped wholesale by that filter, the carrier landing-coverage cells contain only zeros, and final `coverage = min(X_coverage, Y_coverage)` collapses to zero across all τ even when the selected X-prefix mass path is fully populated. This is risk #8 of the parent design, reproduced live on `bayes-test-gm-rebuild` with subject `from(switch-registered).to(switch-success)` and `cohort(15-Apr-26:20-Apr-26)`.

Atom 3 therefore is **not deletion-only housekeeping**. Before any deletion of `engine_cohort.obs_x/obs_y` reads can be safe, the wiring defects that force the rescue must be fixed and the closure-gate test must be made honest. Only after both can the legacy substrate be retired without changing user-visible behaviour for any production fixture.

## 2. Outcome contract

Atom 3 is complete when all of the following hold:

- The v3 selected-cohort path traverses the unified `SelectedAClockEvidence` builder for every `cohort(A=X)` and identity-carrier `window(X→end)` query whose evidence superset contains the necessary X-rooted rows, regardless of those rows' slice-family classification. No production fixture lands in the reducer's legacy-rescue branch because the builder refused.
- The carrier-side observed-span evidence surface composes placement shares for active `cohort(A != X)` queries whose request slice is a `cohort(...)` section, so that carrier landing-coverage is non-zero at fresh τ. Final per-row coverage reflects real carrier observation, not an artefact of the filter.
- The parity test that gates atom 2 closure asserts on the *origin* of the row values, not only on their numerical equality. It is impossible to make the test pass via the rescue branch.
- A new pinning test exists that exercises an active multi-hop `A != X` carrier with a `cohort(...)` request slice and asserts non-zero X coverage through epoch A and smooth decay through epoch B, mirroring the live `bayes-test-gm-rebuild` diagnostic.
- Inside v3, no code path reads `engine_cohort.obs_x` or `engine_cohort.obs_y`. The reducer's branch-3 rescue is deleted; the FrameEvidence aggregate at `cohort_forecast_v3.py:6020-6025` is deleted (or scoped strictly to non-v3 legacy consumers via an explicit separate object).
- A session-level invariant assertion exists in the v3 run path: every cohort diagnostic emitted by the reducer must carry `from_selected: True`, or the runtime must carry a visibly-degraded refusal token. The assertion is exercised by at least one regression test and by the outside-in suite.
- The outside-in cohort suite remains green across `window()`, `cohort(A=X)`, and `cohort(A != X)` modes. Any numerical drift surfaced during the rewire is catalogued with cause-classification (genuine fix of a prior legacy defect, vs. parity bug in the new composition) before pinning expectations are refreshed.

## 3. Stages

The work decomposes into eight stages. Each stage is independently reviewable, independently shippable, and leaves the system in a verifiable state. The point of staging is to surface the load-bearing risks — wiring drift in identity-carrier mode, multi-hop active carrier coverage drift, multi-hop window coverage drift — *before* deleting the rescue substrate that currently masks them.

### Stage 0 — production diagnostic, no code change

The first action is a single empirical run that converts the AP59 hypothesis from "verified at the code level" to "verified in production for at least one real fixture". The run uses a `cohort(A=X)` query against a graph whose X-rooted edge has only `cohort(...)` rows in its evidence superset values list (no overlapping `window(...)` rows that might incidentally satisfy the slice-family filter). The diagnostic captures, for the runtime and for each cohort, the values of `runtime.selected_a_clock_evidence_diagnostics.refusal`, `runtime.selected_source_day_mass`, `runtime.selected_x_prefix`, and the reducer's per-cohort `from_selected` flag. If the refusal token is `runtime_did_not_resolve_selected_source_day_mass` and `from_selected` is false for every cohort, the AP59 silent rescue is confirmed in production. The run is logged and attached to this plan as a baseline; it becomes the regression oracle for stage 5 deletion.

Stop condition: a baseline diagnostic exists, classified as "rescue active" or "rescue not triggered" for the chosen fixture. If "rescue not triggered" — meaning the fixture incidentally contains a WINDOW-family X-rooted row — choose a different fixture and repeat until the rescue is reproducibly observable. The stage does not end with the assumption that AP59 is unreachable.

### Stage 1 — make the closure-gate test honest

The existing parity test `test_end_to_end_parity_window_vs_cohort_a_equals_x_row_dicts` is rewritten to assert provenance, not only numerical equality. The fixture stops pre-populating `runtime.selected_source_day_mass` and `runtime.selected_x_prefix` and instead drives the production wiring path that `compute_cohort_maturity_rows_v3` uses — the same path a real query takes. The assertions are extended to require: the runtime's selected-evidence object exists and reports cells for every selected cohort; the runtime's diagnostics carry no refusal token; the reducer's per-cohort diagnostics all report `from_selected: True`; row-dict equality across the two modes continues to hold modulo cohort labels.

This stage will turn the test red on the current `cohort(A=X)` side. That redness is the correct signal: it is the closure-gate test now performing its named function. The stage lands the test in red, with a tracking comment citing this plan, so that the failure is visible in CI from this point forward and cannot be re-suppressed by accident. The reducer is not changed in this stage; the rescue continues to operate. The redness is on the provenance assertion, not on row equality.

Stop condition: the test asserts provenance; the test fails on `cohort(A=X)` with a refusal/`from_selected` mismatch (matching the stage 0 baseline); the test continues to pass on `window(X→end)`; no other test regresses.

### Stage 2 — fix `n_by_anchor` for identity carrier

The root cause of the wiring failure is that `_root_window_carrier_n_by_anchor_day` was generalised at atom 2c to admit identity-carrier modes, but its candidate-selection filter still admits only `SliceFamily.WINDOW`. For identity carrier the cohort base mass `N_cohort` is by definition the X-rooted subject primitive's `n`, which the parent design's invariant 6 makes load-bearing: the identity carrier is the chain-of-length-0 case of carrier composition, and there is no carrier discovery to perform. The fix is structural rather than a filter widening: when `population_root == denominator_node`, source `N_cohort` per anchor day directly from `engine_cohort.a_pop`, which already carries the X-cohort base mass per anchor and is independent of slice-family classification of the subject rows. The `slice_family is not WINDOW` filter remains correct for active `A != X` where the count must come from a discovered A-rooted carrier candidate — that case is unchanged.

The decision branch is on `population_root == denominator_node`, a structural property of the resolved runtime, not on the request's mode token. This preserves the design's principle that identity carrier is data, not a route.

After this stage, the stage 1 test turns green on the `cohort(A=X)` side: the wiring populates `selected_source_day_mass`, the builder produces cells, the reducer's selected-prefix branch fires, `from_selected: True` is emitted. The reducer's branch-3 rescue is still present in code but is no longer exercised by the parity-test fixture or by typical `cohort(A=X)` queries.

Stop condition: the parity test from stage 1 passes; no other test regresses; the outside-in cohort suite remains green; the stage 0 diagnostic, re-run, now shows `refusal: None` and `from_selected: True` everywhere.

### Stage 3 — fix carrier-side observed-surface filter (Risk #8)

The carrier-side observed-span evidence surface contains the same `slice_family is not WINDOW` filter as the n_by_anchor builder, but on a different axis: it gates the placement shares that feed `edge_share_surfaces` and ultimately `carrier_landing_coverage`. For active `cohort(A != X)` queries whose request slice is a `cohort(...)` section, the carrier-chain rows carry `SliceFamily.COHORT` and are dropped wholesale; the carrier surface contains only zeros; the final per-row coverage collapses to zero across all τ even when the X-prefix mass path is fully populated.

The fix is to widen the filter for the carrier role to admit the slice-family classifications that genuinely contribute carrier observations for the chosen anchor. The mass path's principle — that identity carrier is data and that the resolved runtime knows whether a row's placement contributes to its anchor — applies here. The carrier-coverage path must read placement shares from whatever conditioned primitive rows feed the carrier chain, gated by their per-row anchor-day shares (already in hand) rather than by their DSL slice section.

This stage adds a dedicated pinning test mirroring the live `bayes-test-gm-rebuild` diagnostic: an active multi-hop `A != X` carrier with a `cohort(...)` request slice over six anchors, asserting non-zero `evidence_x_coverage` through epoch A and smooth decay through epoch B. The test must distinguish "X coverage collapses spuriously" (the current defect) from "X coverage collapses because the carrier has genuinely aged out" (correct behaviour past `tau_solid_max` for the oldest cohort).

Stop condition: the new pinning test passes; the outside-in suite passes; the diagnostic on `bayes-test-gm-rebuild` shows non-zero carrier coverage through epoch A. Any numerical drift in pre-existing tests is classified in writing before expectations are touched.

### Stage 4 — retire the reducer's branch-3 rescue

With stage 2 in place, the reducer's branch-3 (the `else` arm that reads `engine_cohort.obs_x/obs_y` when `selected_a_clock_evidence is None`) is no longer exercised by any v3 production fixture. The stage deletes the branch and replaces it with an explicit refusal: when the v3 path runs and `selected_a_clock_evidence` is `None`, the runtime surfaces a visible degradation marker rather than silently reading the legacy substrate. This matches invariant 12's "failures degrade visibly; they do not silently fall back" rule.

The stage adds a pinning test that constructs a deliberately broken runtime — one where the unified builder is forced to refuse — and asserts that the row builder reports degradation rather than emitting rescue-derived numeric fields. The test exists to catch any future regression that reintroduces a silent rescue path.

The `elif use_selected_evidence` branch (active mode, builder produced an object but no cells for a particular cohort) is unchanged — its existing zero-prefix-with-refusal behaviour was already correct.

Stop condition: branch-3 is gone; the degradation-marker pinning test passes; the outside-in suite passes; no production fixture trips the degradation path.

### Stage 5 — retire the FrameEvidence `evidence_by_tau` aggregate inside v3

The second residual reader of `engine_cohort.obs_x/obs_y` is the FrameEvidence aggregate at `cohort_forecast_v3.py:6020-6025`. Its purpose during atom 2 was to keep the v3 path's frame-derived evidence shape available for diagnostic and shadow-parity comparisons. With stage 3 in place, the v3 row builder no longer consumes this aggregate. The stage scopes the aggregate strictly to non-v3 consumers (notably the remaining `compute_forecast_trajectory` callers — daily-conversions annotation, surprise-gauge-style legacy paths) by either deleting the v3-side write entirely or moving it behind a feature flag whose only consumers are the named legacy modules.

The non-v3 legacy consumers are not migrated by this plan; they retain their existing reads against the unchanged `CohortEvidence.obs_x/obs_y` field shape. The parent design explicitly defers their migration to a separate work item, and this stage preserves that boundary.

Stop condition: the v3 row-builder and reducer paths contain no reads of `engine_cohort.obs_x/obs_y`; daily-conversions and surprise-gauge regression tests remain green; a code-search confirms the remaining readers are all outside the v3 selected-cohort path.

### Stage 6 — durable AP59 guard

The session-level invariant test is added: for every v3 run completed during the outside-in suite, every cohort diagnostic emitted by the reducer must carry `from_selected: True`, or the runtime must carry a visibly-degraded refusal token. The assertion is folded into the suite's per-run teardown and into a stand-alone regression test that exercises a representative `cohort(A=X)`, `cohort(A != X)`, and `window(X→end)` fixture in one parameterised invocation.

This is the closure of the named anti-pattern: the rescue substrate is deleted, the wiring is fixed, and the invariant test ensures no future refactor can reintroduce a silent legacy path without immediate CI failure. It is the durable equivalent of the parity-test tightening in stage 1.

Stop condition: the invariant test exists, passes, and is wired into the standard test surface; the outside-in suite runs it on every cohort fixture.

### Stage 7 — shrink `build_cohort_evidence_from_frames`

With v3 no longer consuming `engine_cohort.obs_x/obs_y`, `build_cohort_evidence_from_frames` no longer needs to populate those fields for v3 consumers. The stage shrinks the builder to its remaining v3 responsibilities: cohort-list materialisation, epoch-boundary derivation, `a_pop` / base-mass plumbing, and evidence-superset metadata. The legacy `obs_x/obs_y` forward-fill loop inside the builder is moved behind the same non-v3 feature flag used in stage 5, or split into a separate builder consumed only by the legacy modules.

The stage does not change the shape of `CohortEvidence` as exposed to non-v3 consumers. The split is internal to the builder. The outside-in suite remains green; the daily-conversions and surprise-gauge suites remain green.

Stop condition: the builder is split or feature-gated such that v3 receives only the metadata it actually consumes; the legacy modules continue to receive their full shape unchanged; all suites remain green.

## 4. Risk catalogue

The load-bearing risk is multi-hop window numerical drift introduced at stage 2 or stage 3, where the new wiring composes an X-prefix or a carrier surface differently from how the legacy frame-derived path did. The parent design's §5.2 risk paragraph anticipates this: single-hop window is expected to be numerically identical (one primitive, one edge, max-flow trivially yields `k`); multi-hop window drift is expected and not necessarily a regression because the legacy path was never the canonical topology-composed substrate. The stage 1 parity test, broadened to multi-hop window fixtures, is the diagnostic gate. Any drift is catalogued with cause classification (composition bug → fix in stage; legacy-path defect → pinning-test refresh with citation) before stage 4's deletions land.

A secondary risk is that the diagnostic in stage 0 fails to reproduce AP59 on every available fixture — meaning every accessible fixture happens to contain an X-rooted WINDOW-family row that satisfies the filter incidentally. In that case the hypothesis remains code-verified but production-unverified. The plan does not pause for this: stages 1–7 are still required, because the code-level reachability of the rescue branch is itself a defect under invariant 12 regardless of whether any specific fixture currently exercises it. The stage 0 baseline simply becomes "reproducer not yet found; rescue branch reachable per code reading" and the work proceeds.

A tertiary risk is that the non-v3 legacy consumers turn out to be more numerous or more deeply entangled with v3 internals than the audit suggests. The stage 5 and stage 7 scoping decisions assume a clean cut; if entanglement is found, the stage 5 deletion is downgraded to "branch behind feature flag" and the entanglement is documented as a follow-up work item rather than blocking atom 3 closure.

## 5. Acceptance criteria

Atom 3 is complete when:

- The stage 0 baseline diagnostic (or a code-level review confirming the rescue branch is unreachable in production today) is recorded.
- The parity test asserts provenance (`refusal`, `from_selected`, `has_cells`) and passes for `window(X→end)`, `cohort(A=X)`, and one representative `cohort(A != X)` fixture.
- The new Risk #8 pinning test (active multi-hop `A != X` with cohort request slice) passes with non-zero carrier coverage through epoch A.
- The reducer's branch-3 rescue is deleted; a degradation-marker pinning test passes.
- The v3 path contains no reads of `engine_cohort.obs_x/obs_y`. Code-search produces zero hits inside the v3 selected-cohort subtree.
- The session-level AP59 invariant assertion is wired into the outside-in suite and into a stand-alone regression test.
- The outside-in cohort suite is green across `window()`, `cohort(A=X)`, and `cohort(A != X)` modes. Multi-hop window numerical drift, if any, is catalogued and the pinning-test refreshes carry citations.
- `build_cohort_evidence_from_frames` is shrunk or split such that v3 consumes only metadata; legacy non-v3 consumers continue to receive their full shape via an explicitly-scoped path.

## 6. Out of scope

- Migration of the remaining `compute_forecast_trajectory` callers (daily-conversions annotation, surprise-gauge-style legacy paths) off `CohortEvidence.obs_x/obs_y`. This is a separate work item.
- Changes to the canonical semantics, the reducer's positive-mass branch, the model overlay, the completeness machinery, public scalar moments, or cache identity rules.
- Any change to the `window()` evidence-binding semantics. Window subject primitives remain on local-clock binding per the canonical Appendix A taxonomy.
- Any change to `a_pop` derivation beyond the structural sourcing for identity carrier in stage 2. The existing `_root_window_carrier_n_by_anchor_day` path for active `A != X` is unchanged.

## 6a. Stage 0 baseline (recorded 12-May-26)

Two fixtures were exercised via `bash graph-ops/scripts/analyse.sh ... --type cohort_maturity --diag --no-cache`:

**Fixture 1 — `synth-simple-abc`, `from(simple-a).to(simple-b).cohort(29-Jan-26:29-Apr-26)`** (identity carrier, `cohort(A=X)`):
- `regime_selection.candidate_modes = ["window","cohort"]` — the X-rooted edge has both families in its evidence superset, so the WINDOW-family row satisfies the slice-family filter at `cohort_forecast_v3.py:1799`.
- `rate_evidence_provenance.admission_decision = "identity_collapse"`, `selected_family = "window"`.
- `selected_cohort_projection.cohorts[*].from_selected = true` for every one of 52 cohorts.
- Rescue branch **not triggered**.

**Fixture 2 — `bayes-test-gm-rebuild`, `from(switch-registered).to(switch-success).cohort(15-Apr-26:20-Apr-26)`** (active carrier, `A != X`, the Risk #8 live fixture):
- `regime_selection.candidate_modes = ["window","cohort"]` — same superset shape; WINDOW-family row present.
- `selected_cohort_projection.cohorts[*].from_selected = true` for all 6 cohorts. Rescue branch **not triggered**.
- Per-row coverage on the chart output: `evidence_x_coverage` and `evidence_y_coverage` move in lockstep at every τ (epoch A both `1.0`, epoch B decay `0.66 → 0.49 → 0.30 → 0.16` with carrier and subject identical). **Risk #8 does NOT reproduce** — carrier X coverage does not collapse to zero. Final `coverage = min(X, Y)` is non-zero through epoch B as the design intended.

**Interpretation**: the AP59 silent rescue is **reachable in code** per the audit (filter at `cohort_forecast_v3.py:1799` plus reducer branch-3 at `4796-4801` remain in place) but is **not exercised by either of the two representative fixtures** because their evidence supersets contain WINDOW-family rows on the X-rooted edge that incidentally satisfy the filter. Risk #8's carrier-coverage collapse, observed live when the design doc was written, **no longer reproduces** on the same fixture under current code — either the carrier-coverage construction path was fixed since the design doc's diagnostic was captured, or the snapshot DB / parameter files have changed in a way that side-steps the original defect.

**Consequence for atoms 3 stages 1-7**: the original premise — "fix two production-breaking bugs and then delete the rescue" — is partially invalidated. The rescue branch is still a defect under invariant 12 (silent fallback violates "failures degrade visibly") and is still reachable on a cohort-only fixture that we have not yet constructed, but no production-visible user-facing defect is currently masked by it. Stages 1, 4, 6 (test tightening, branch-3 deletion, AP59 invariant guard) remain justified on invariant-12 / future-regression-prevention grounds. Stages 2 (identity-carrier `n_by_anchor`) and 3 (Risk #8 carrier-filter widening) lose their headline justification — the wiring already succeeds on both tested fixtures, and the carrier-coverage path no longer collapses. They may still be load-bearing for cohort-only or differently-shaped fixtures we have not exercised; that needs a synthetic fixture to confirm.

The stage 0 stop condition admits this outcome explicitly: "reproducer not yet found; rescue branch reachable per code reading; work proceeds." Stages 1-7 are not invalidated, but their priority and scope should be reconsidered before stage 1 lands. The user should decide whether to:
(a) proceed with stages 1–7 as written, on invariant-12 / hardening grounds;
(b) construct a synthetic cohort-only fixture to attempt AP59 reproduction empirically before deciding;
(c) shrink the plan to stages 1, 4, 6 only (test tightening + branch-3 deletion + invariant guard) and defer stages 2/3 until a real defect is observed;
(d) park atom 3 as lower-priority given the empirical baseline.

## 7. Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Stage 0 — completed 12-May-26 — baseline recorded in §6a; rescue branch reachable per code reading but not empirically triggered on synth-simple-abc or bayes-test-gm-rebuild; Risk #8 does not reproduce
- [x] Stage 1 — completed 12-May-26 — provenance assertions (`refusal='ok'`, `has_cells()`) added to builder-level parity test in `test_selected_evidence_natural_degeneracy.py`; existing test's docstring corrected to acknowledge it is NOT end-to-end (fixture pre-populates `selected_source_day_mass`/`selected_x_prefix`); new true end-to-end test `test_a_equals_x_provenance_uses_unified_path_not_rescue` added in `test_cohort_factorised_outside_in.py` asserting `from_selected=True` on every non-skipped cohort for both window and cohort(A=X) modes; both pass on `synth-simple-abc` per §6a baseline; full natural-degeneracy file green (15/15)
- [~] Stage 2 — **attempted and reverted 12-May-26**. Tried to source identity-carrier `N_cohort` from `engine_cohort.a_pop` (chain-of-length-0 degeneracy per invariant 6). The full outside-in suite then surfaced a regression in three multi-hop window tests on `synth-window-rate-prop`: `evidence_x` dropped from ~1,137,406 to 14, a ~80,000× collapse. **Investigation finding**: `_root_window_carrier_n_by_anchor_day` returns the candidate's raw `n` **per `observed_date`** (the per-day X-rooted count under window binding). `engine_cohort.a_pop` is a per-cohort frame-derived scalar (`a_frozen`/`x_frozen` from `build_cohort_evidence_from_frames`). For multi-hop window subjects these aren't equivalent: substituting `a_pop` collapsed the per-day amplitude surface that `_build_selected_source_day_mass` and `_build_carrier_only_denominator_prefix` depend on. The invariant-6 framing in the plan was architecturally suggestive but numerically wrong — identity carrier may be "data, not a route" semantically, but the data the two paths surface is at different aggregation levels. **Reverted**. AP59 reachability for cohort-only-evidence fixtures is not a current production defect (§6a baseline established it doesn't reproduce); the stage 1 provenance test (`test_a_equals_x_provenance_uses_unified_path_not_rescue`) remains the invariant guard.
- [~] Stage 3 — **attempted and reverted 12-May-26**. Tried to widen the slice-family-WINDOW filter at `cohort_forecast_v3.py:2829` inside `_build_observed_span_evidence_surface`, motivated by Risk #8 of the parent design (active-carrier X-coverage collapse). The change broke the same multi-hop window tests as stage 2 (different cause). **Investigation finding**: the candidate-pool loop and the primitive-bound-row loop in `_build_observed_span_evidence_surface` are mutually exclusive per edge (line 2909 gates the primitive loop on `edge_id not in candidate_backed_local_edges`). The candidate pool's raw `(n, k)` is only semantically interchangeable with window-rooted local-clock observations; COHORT-family candidates carry `(n, k)` rooted at the cohort anchor A, a different counting basis. Admitting them via the candidate pool starves the rate cache `edge_nk_by_local_source_day` (consumed by `_build_age_only_rate_cache` / `_build_local_source_day_rate_cache`) by replacing arrival-weighted multi-row primitive aggregates with single raw cohort-rooted counts. **The docstring at line 2731 claiming this surface is "for COVERAGE only" is misleading** — `edge_local_nk_surfaces` IS the source of rates feeding the rate-attributed Y prefix (= `evidence_y`). The filter is doing real work. **Reverted**. Risk #8 did not reproduce on the live `bayes-test-gm-rebuild` fixture per §6a baseline; the hypothetical defect the filter widening was meant to fix is not a current production defect. The comment at 2829 was updated to explain what the filter is actually gating.
- [x] Stages 4+5+7 — completed 12-May-26 in one sweep. **Stage 4**: reducer branch-3 rescue (the `else: obs_x = ec.obs_x; obs_y = ec.obs_y` at cohort_forecast_v3.py:4796-4801, plus the `use_selected_evidence` discriminator) deleted. The reducer now has exactly two paths: `if selected_prefix is not None` reads from selected evidence; `else` projects zero-prefix from the prior. No silent fallback to legacy `engine_cohort.obs_x/obs_y` — invariant 12 enforced structurally. **Stage 5**: `FrameEvidence.evidence_by_tau` field + its build loop (cohort_forecast_v3.py:6006-6028) + the `evidence_by_tau` parameter on `_project_runtime_rows` + the call-site arg all deleted (pure dead-output post-stage-4). **Stage 7** (dead code reductions): `_evidence_display_at_tau` helper deleted (zero callers); `FrameEvidence.x_provider`, `from_node_arrival`, `carrier_tier` dead fields removed; `legacy_p_mean/_sd/_sd_epistemic` plumbing removed from cohort_forecast_v3.py (`build_resolved_cf_runtime` params + call site) and primitive_readout.py (`ResolvedRuntimeReadoutResult` fields + `compute_resolved_runtime_readout` params + `delta_p_mean`/`delta_p_sd`/`within_shadow_band` diagnostics + `_within_band` helper + the four `SHADOW_*`/`ACCEPTANCE_*` band constants from `__all__`). Full outside-in suite green (51 passed, 1 xfailed).
- [x] Stage 6 — covered by the end-to-end provenance test landed in Stage 1 (`test_a_equals_x_provenance_uses_unified_path_not_rescue` in `test_cohort_factorised_outside_in.py`). Asserts every non-skipped cohort carries `from_selected: True` for both `window(X→end)` and `cohort(A=X, X→end)` modes on the production wiring path. The deletion of branch-3 in Stage 4 makes the assertion structurally enforceable: if any cohort ever surfaces `from_selected: False`, it would be a reducer code defect (no rescue branch exists to silently mask it).
