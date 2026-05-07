# Cohort 1-Apr falling-k — problem statement

**Status**: investigation note, 6-May-26
**Scope**: active `cohort(A, X→end)` queries displaying observed evidence — specifically the user-reported case `from(switch-registered).to(switch-success).cohort(1-Apr-26:1-Apr-26)` showing falling k between successive τ in count mode.

The main body states the symptom, traces what the implementation actually does, names the candidate defects, and lists what we don't yet know. Appendix A records the later implementation requirements agreed after validating D1-D3 and choosing a rate-attributed evidence-line interpretation.

## 1. Symptom

For `cohort(A, X→end)` rendered in count mode, the user reports:

- evidence dots appear in the latter part of epoch A (post earlier fixes — see §6)
- the count value falls between some successive τ (e.g. k(τ=15) < k(τ=14))
- this is impossible under any sensible CDF interpretation: a conversion cannot un-occur for a fixed cohort

The user's principle: properly normalised, superadded successive convolved latency curves sum to a monotone CDF. Falling k indicates the implementation is computing something that **isn't** that sum.

## 2. Empirical observations from the latest diag run

For `from(switch-registered).to(switch-success).cohort(1-Apr-26:1-Apr-26)`:

```
[v3] upstream: 36 observations across 1 cohorts
[evi_diag] subject_root_weights: n_days=399 sum=399.0000 source=carrier_X_arrivals
[evi_diag] surface role=carrier_a_to_x        edges=3 raw_rows=3   placed=3   off_clock=0  cells_emitted=1   chain_incomplete=1
[evi_diag] surface role=subject_x_to_end_on_a edges=1 raw_rows=34  placed=34  off_clock=0  cells_emitted=14  chain_incomplete=0
[evi_diag] selected_a_clock: anchor_days=1 carrier_has_cells=True subject_has_cells=True emitted_cells=15 invalid_pairs=2
```

What this says with no further inference:

- 1 selected cohort (anchor=1-Apr)
- carrier surface admitted 3 rows across 3 edges, emitted 1 cell
- subject surface admitted 34 rows on 1 edge, emitted 14 cells
- pairing emitted 15 cells, with `invalid_pairs=2` (subject Y > carrier X at 2 cells, capped to X)

Subject is `switch-registered → switch-success` (single hop, source U=X). Carrier is `Landing-page → … → switch-registered` (3 edges).

## 3. The data model — what each row physically represents

Per `evidence_merge.py` and `primitive_evidence.py`:

- An `EvidenceCandidate` carries `(observed_date, retrieved_at, n, k)` plus an `EvidenceIdentity` that names slice family (`window` or `cohort`) and optionally an anchor.
- For this query, the temporal regime selector picks `mode=window` for both the subject and the upstream carrier edges. The v3 log confirms this for every fetched edge.
- Window-mode rows are **not** anchor-tagged. The `n` is the count of people observed at U on `observed_date` regardless of which upstream cohort they came from. The `k` is the count of those who reached V by `retrieved_at`, also mixed-cohort.

So a subject row `(observed_date=10-Apr, retrieved_at=15-Apr, n=120, k=18)` says "120 people arrived at X on 10-Apr from anywhere upstream; 18 of them have converted to subject_end by 15-Apr". It is **not** "120 people from cohort 1-Apr".

This is empirically grounded — confirmed by `mode=window` in the temporal regime log.

## 4. What the placement step actually does

For each subject row at `(d_obs, d_ret, n, k)`:

1. `bind_primitive_evidence` ([primitive_evidence.py:215](graph-editor/lib/runner/primitive_evidence.py#L215)) computes `arrival_weight = arrival_weights[X].weight_on(d_obs)`. Post the support-mask fix this is `1.0` (or `0`).
2. `n_weighted = n × arrival_weight`, `k_weighted = k × arrival_weight`.
3. `root_day_shares = arrival_weights[X].root_day_shares_on(d_obs)`. For X-rooted maps, contributions to `d_obs` come from itself only, so `root_day_shares = {d_obs: 1.0}`.
4. `_row_selected_a_clock_placements` ([cohort_forecast_v3.py:1480](graph-editor/lib/runner/cohort_forecast_v3.py#L1480)) iterates `root_day_shares` and uses the carrier backmap (`_join_conditioned_carrier_backmap.root_day_shares_on(d_obs)`) to map each X-day onto selected anchors.
5. The carrier backmap normalises across selected anchors: `weights[anchor] / sum(weights.values())`. With one selected anchor (1-Apr) in scope, the divisor equals the numerator, so the share returned is **1.0** for any `d_obs` that's reachable from 1-Apr at all.
6. The placement appends `(anchor=1-Apr, τ=d_ret−1-Apr, weight=1.0)`.
7. The accumulator at `_build_observed_span_evidence_surface` ([cohort_forecast_v3.py:1840-1843](graph-editor/lib/runner/cohort_forecast_v3.py#L1840-L1843)) does:

   ```python
   by_tau[τ] = by_tau.get(τ, 0.0) + value × share
              = by_tau.get(τ, 0.0) + k_weighted × 1.0
              = by_tau.get(τ, 0.0) + k
   ```

So per-(edge, anchor=1-Apr, τ), the bucket is the **sum of raw k values** across all rows whose `d_ret = anchor + τ` — regardless of which X-day each row's `d_obs` was. Multiple X-days landing at the same τ all add into the same bucket. The X-day axis is collapsed at this point.

## 5. Where forward-fill happens

`_latest_value_at_or_before` ([cohort_forecast_v3.py:1992](graph-editor/lib/runner/cohort_forecast_v3.py#L1992)) returns the value at the latest τ' ≤ τ in `by_tau`. This is what the surface composer calls for chain coverage and what `aggregate_by_tau` uses for cumulative reads.

Forward-fill operates on the **already-summed** per-(edge, anchor) bucket. There is no per-X-day intermediate.

## 6. Recent changes in scope

For background — what's already been changed in this debugging session:

- `request_envelope.py`: carrier root weights narrowed from donor-extended to selected-anchor-only.
- `cohort_forecast_v3.py` runtime: subject's prefix-arrival map now uses carrier-derived X-day support mask (`{d: 1.0 for d in carrier reach}`).
- `primitive_readout.py`: `_build_request_arrival_map` accepts `override_root_day_weights` for the subject path.
- Coverage forward-fill: `landing_coverage` now read from `cell_at_or_before` rather than exact-τ (CDF semantics).

These got the subject surface populated (`raw_rows=34`) and dots appearing. They are **not** what's causing falling k. The falling-k mechanism predates these changes; it was just invisible while the subject surface was empty.

## 7. Candidate defects, distinguished by confidence

### 7.1 Confirmed via code reading

**D1. The X-day axis is collapsed at the placement step.** Per §4, multiple rows with different `d_obs` but the same `d_ret` sum into a single per-τ bucket. The structural information "which X-day this row came from" is lost the moment the placement appends to `by_tau[τ]`.

**D2. The carrier backmap denominator only sums over selected anchors.** Per §4 step 5, `_join_conditioned_carrier_backmap.root_day_shares_on` ([cohort_forecast_v3.py:1572-1588](graph-editor/lib/runner/cohort_forecast_v3.py#L1572-L1588)) divides by `sum(weights.values())` over selected anchors only. With one selected anchor, share is forced to `1.0`. This **claims** that the entirety of any reachable `d_obs`'s mass is attributable to the single selected cohort, regardless of how concentrated the carrier PMF actually is at that X-day from that anchor.

**D3. The `value` accumulated is `k_weighted` directly, not `k_weighted × cohort_attribution`.** Per §4 step 7, the placement multiplies `value × share` where `share` is the (overclaimed) backmap fraction. The expression is **not** weighted by `n_weighted` or by carrier increments. There's no rate-and-attribute step.

### 7.2 Remaining hypothesis and now-closed decisions

**S1. Falling k is caused by data sparseness combined with D1.** Hypothesis: the snapshot DB does not have a row for every (X-day, retrieved_at) pair. When the per-τ sum at τ' includes contributions from X-days that are absent at τ'+1, the τ'+1 sum drops. Forward-fill operates on the already-collapsed sum, so it picks up the smaller value. **Need to verify**: dump `by_tau` for one falling-k cell, identifying which X-days contributed at τ' vs τ'+1.

**Decision 1. The evidence line should use rate attribution, not raw k.** Each window-family subject row carries an observed local rate `k/n` for that X-day. The selected Cohort's contribution is selected mass at that X-day multiplied by this carried local rate. In other words, the corrected display prefix uses `N_selected_at_X_day × k/n`, carried forward per X-day, then superadded. This closes the S2 question for the evidence-line fix.

**Decision 2. Direct `cohort()` evidence / WP8 is out of scope for this fix.** Doc 60 WP8 is a separate, narrow `p_conditioning_evidence` seam. This falling-k fix must not add a direct-`cohort()` evidence route, route the display through cohort-mode snapshot rows, or reopen direct-cohort rate conditioning. The evidence display must be corrected using the admitted primitive evidence clock already used by conditioning.

### 7.3 Possible alternatives I have not yet investigated

- whether the conditioning step (`primitive_conditioning.condition_primitive`) does something to the rows that changes how they should later attribute
- whether the topology max-flow composition step interacts with the per-edge sum in a way that masks or amplifies the falling-k symptom
- whether the chart's "count" mode rendering applies any further transformation before display

## 8. What this problem is *not*

- **It's not a presentation/coverage problem**. We see dots (coverage forward-fill landed earlier). The values themselves fall.
- **It's not a binder weight problem**. With the support-mask fix, binding admits rows at full strength.
- **It's not the carrier root narrowing**. Carrier rooting is correct per the cohort-attribution semantics.
- **It's not subject root narrowness**. Subject support mask spans the carrier reach.

## 9. What still needs verification before implementation

V1. **Empirically demonstrate falling k for a specific τ.** Dump the row-level contributions to one falling cell. Confirm: are multiple X-days contributing, do some drop out at the next τ, is the per-X-day k itself monotone where data exists?

V2. **Confirm the "mixed-cohort row" interpretation for forensic completeness.** Run a manual fetch for one `(X-day, retrieved_at)` pair and inspect the snapshot DB row. Is `n` mixed-cohort or per-cohort? This is useful evidence for the record, but direct `cohort()` rows are no longer a candidate implementation route for this fix.

V3. **Closed: use rate attribution for the evidence line.** The implementation should compute `(selected source-day mass × k/n)` per admitted row, carry forward per source day, and superadd after carry-forward. Using cohort-mode rows directly is explicitly out of scope.

V4. **Spec gap to close.** [FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md](codebase/FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md) §A.7 places one row at one `(C, τ)` point with no per-X-day handling. §A.8 forward-fills paired cells across τ for one cohort but does not address X-day collapse. The spec should be extended so A.7 preserves source-day state until after per-source-day carry-forward and rate attribution.

## 10. Decisions now made

- D1-D3 are validated code-level defects/mechanisms.
- The evidence line should use the primitive evidence clock and admitted primitive row set, not a posterior-smoothed re-placement and not a separate cohort-mode evidence route.
- Window-family subject rows contribute observed local rate `k/n`, scaled by selected source-day mass. Raw `k` is not selected-Cohort `Y` mass.
- Carry-forward must happen per primitive source day before superaddition across source days.
- The corrected selected prefix must feed both A8 evidence aggregation and A9's epoch-B frontier state (`x_frozen`, `y_frozen`) so the epoch A/B seam dovetails by identity.
- Direct `cohort()` evidence / WP8 is not part of this fix.
- The selected source-day mass comes from the carrier-only primitive-conditioned carrier distribution, scaled by observed root-window `N_cohort`; it must not be sourced from subject evidence or from the joint selected A-clock backmap.
- The implementation must not branch on single-hop. Single-hop is the one-edge degeneracy of the same subject-span evidence projection; the source-mass rule applies to every subject primitive `U -> V`.

## Appendix A. Required implementation changes

This appendix records the agreed direction after the D1-D3 code-reading defects were validated. It is intentionally scoped to the active `cohort(A, X→end)` evidence display path. It does not reopen WP8/direct-`cohort()` rate conditioning: doc 60 WP8 is a narrow `p_conditioning_evidence` seam and must not rewrite carrier semantics, latency semantics, or numerator representation.

### A.1 Target evidence-line semantics

For active `cohort(A, X→end)`, a window-family subject row must not contribute its raw `k` as selected-Cohort mass at the primitive destination. A row at primitive source node/day `(U, u)` and retrieval day `r` provides an observed local primitive rate, `k_UV(u,r) / n_UV(u,r)`, for the primitive's own clock. The selected-Cohort display contribution is that local rate multiplied by the selected-Cohort mass attributed to the same primitive source node/day.

The contribution is **source-node mass scaled** and **selected-A-clock placed**. For any subject primitive `U -> V`, scale by selected mass at `U` on `u`, not by `A_pop` directly. Place the resulting contribution on the chart at `tau = r - C.anchor_day`. For the first subject edge, `U = X`; for a single-hop subject this is simply the one-edge degenerate case of the same rule.

The selected mass source is:

- `N_cohort(C)`: the observed root-window `n` for the selected anchor day on the first carrier primitive rooted at `A`. This is the same quantity currently recovered by `_root_window_carrier_n_by_anchor_day`; it must not come from a posterior, from frame-bundle `a`, or from the joint selected A-clock backmap.
- `M_select(U, C, u)`: the selected-Cohort mass at primitive source node `U` on source day `u`, produced by the same resolved carrier/subject-span prefix machinery. At `U = X`, this degenerates to `N_cohort(C) × g_carrier(C, u)`, where `g_carrier` is the carrier-only primitive-conditioned arrival increment at `X`. Downstream `U` values are not a separate route; they are the result of composing the preceding subject-span primitives in the same general prefix object.

So a subject primitive's evidence contribution is `M_select(U, C, u) × k_UV(u,r) / n_UV(u,r)`.

The denominator prefix is carrier-only, not rate-attributed: `X_prefix(C, tau) = N_cohort(C) × G_carrier(C, tau)`, where `G_carrier` is the cumulative carrier-only arrival distribution through the same evidence-clock basis. The numerator prefix is the superadditive rate-attributed sum over source days.

Multi-hop subject display must not be handled by a fork. The selected mass at downstream `U` and the topology composition into `end` must be represented in the same selected prefix object that single-hop uses in degenerate form. If the current runtime object does not expose enough information to compute `M_select(U, C, u)` without a mode/path-length branch, the runtime object must be extended; the projection layer must not invent a multi-hop shortcut.

In prose, the selected evidence prefix should be:

- derive selected mass at the primitive source day using the same row set, regime/asat admission, and primitive evidence clocking support used to bind the row for conditioning;
- carry the latest observed local rate per source day as-of the chart retrieval day;
- multiply selected source-day mass by that carried local rate;
- superadd across source days only after the per-source-day carry-forward has happened.

This preserves the user's monotone-CDF mental model: non-negative selected source-day masses times monotone carried local rates, summed after carry-forward, cannot fall merely because one source-day row is missing from a later retrieval bucket.

### A.2 Current code state that must change

`bind_primitive_evidence` in `graph-editor/lib/runner/primitive_evidence.py` currently produces `WeightedEvidenceRow` objects with `(observed_date, retrieved_at, n, k, n_weighted, k_weighted, root_day_shares)`. This remains the right evidence-admission boundary. The display fix should reuse this admitted row set and its primitive-clock support; it should not fetch a second row family and should not move display evidence onto a post-conditioning posterior-smoothed clock.

`_row_selected_a_clock_placements` in `graph-editor/lib/runner/cohort_forecast_v3.py` currently returns only `(anchor_day, tau, share)`. That is not enough information for the corrected display object because the source-day axis has already disappeared by the time `_build_observed_span_evidence_surface` accumulates values. The placement result must preserve the primitive source day (`d_obs` / X-day for the first subject edge) alongside the selected anchor and chart tau.

`_join_conditioned_carrier_backmap.root_day_shares_on` currently normalises over the selected anchor set. With one selected anchor this makes every reachable X-day receive share `1.0`. That remains acceptable as a coverage-placement normalisation only if the count amplitude is separately scaled by selected source-day mass. It must not be used as the entire count attribution for raw `k`.

`_build_observed_span_evidence_surface` currently accumulates `value = k_weighted` into `edge_surfaces[edge_id][anchor_day][tau]` and then `_latest_value_at_or_before` forward-fills the already-collapsed per-tau bucket. This is the direct D1/D3 failure site. The replacement must keep a per-source-day intermediate and carry forward within each source day before summing. For subject rows, the accumulated quantity should be selected source-day mass times the row's observed local rate, not raw `k_weighted`.

`SelectedAClockEvidence.aggregate_by_tau` currently assumes each paired cell already contains a cumulative selected-Cohort prefix. That assumption is fine only if the builder has produced cumulative prefix cells. The aggregate should remain a projection of the selected prefix; it must not repair monotonicity by sorting, clipping, cumulative-max, or any other display-layer patch.

`_selected_cohort_group_rate_draws` already accepts `selected_a_clock_evidence` and calls `prefixes_for_cohorts` before falling back to `engine_cohorts`. This is the right seam, but it is also the main partial-fix risk. After the evidence display is corrected, the reducer's `x_frozen` and `y_frozen` must come from the same corrected selected prefix object that feeds `aggregate_by_tau`. Do not leave epoch B initialisation on legacy `engine_cohorts.obs_x/obs_y` or on the old raw-`k` selected cells.

`_project_runtime_rows` currently plots active evidence from `selected_a_clock_evidence.aggregate_by_tau` and obtains E+F rows from `_selected_cohort_group_rate_draws`. The required invariant is that both surfaces read the same selected prefix at the epoch A/B seam. If the evidence line uses the corrected rate-attributed prefix but the reducer initialises from a different object, the seam can still gap.

The shape change is broad and should land cleanly, without compatibility shims. The current surface effectively has `edge -> anchor -> tau` cells. The corrected surface needs to preserve `edge -> anchor -> source_day -> tau` or an equivalent source-day-keyed intermediate until after per-source-day carry-forward. Consumers to update or audit include `_row_selected_a_clock_placements`, `_latest_value_at_or_before`, `_build_observed_span_evidence_surface`, `_build_active_selected_a_clock_evidence_from_runtime`, `SelectedAClockEvidence.cells_by_anchor_day`, `aggregate_by_tau`, `prefix_for_anchor_day`, `prefixes_for_cohorts`, `_selected_cohort_group_rate_draws`, `_project_runtime_rows`, and the active-cohort display/unit tests that construct selected evidence fixtures directly.

### A.3 Clocking requirement

The evidence-line prefix should use the extant primitive evidence clock: the same admitted candidate rows and the same primitive-local arrival support used when conditioning each primitive. It should not use the joint-conditioned carrier or subject particles to re-place the same evidence after conditioning. Doing so would turn the evidence line into a posterior-smoothed reconstruction, not an observed-evidence readout.

The forecast continuation remains posterior-driven. The separation is:

- epoch A evidence prefix: admitted rows, primitive evidence clock, selected source-day mass scaling, carried per source day;
- epoch B continuation: conditioned runtime particles, starting from the exact epoch A frontier prefix.

This is not a contradiction. Conditioning learns the primitive posterior from primitive-clock rows. Display evidence projects those same admitted rows into selected-Cohort count space. Forecast projection then propagates selected mass with the conditioned runtime.

### A.4 Seam invariant

Let `F` be the frontier used for the epoch A/B boundary. The implementation must construct one selected prefix object such that:

- `X_prefix(C, tau)` and `Y_prefix(C, tau)` are the displayed selected evidence prefixes for Cohort `C`;
- `aggregate_by_tau(F)` reads those prefixes for the evidence line;
- `_selected_cohort_group_rate_draws` uses `x_frozen = X_prefix(C, F)` and `y_frozen = Y_prefix(C, F)` for the same Cohort `C`;
- all future Pop D / Pop C residual terms are zero at `tau = F`.

Under those conditions the seam dovetails by identity: the evidence point at `F` and the E+F continuation's boundary state are the same mass, not two separately calibrated estimates. Merely using the same latency weights in two independently-built paths is not sufficient.

### A.5 Test requirements before behavioural change is reported complete

The implementation should add focused tests before claiming the chart is fixed:

- a synthetic row-level test proving the current collapsed-bucket shape can fall when one X-day is missing from the next retrieval bucket;
- a corrected-prefix test proving per-source-day carry-forward then superaddition is monotone for non-negative selected masses and monotone local row rates;
- an active-cohort subject-span test where each subject primitive contribution uses `k/n` scaled by selected mass at that primitive's source node/day rather than raw `k`;
- a denominator-prefix test proving `X_prefix` is carrier-only (`N_cohort × G_carrier`) and is not rate-attributed or sourced from `A_pop`/posterior fallback;
- a seam test proving the row at `tau_solid_max` and the reducer frontier state read the same `X_prefix/Y_prefix` values;
- a regression guard that active evidence placement uses the primitive evidence clock and does not re-place evidence with posterior-conditioned draw surfaces.
- a shape/audit test covering direct consumers of the selected-evidence object so the source-day-keyed intermediate is not accidentally collapsed back to `edge -> anchor -> tau`;
- an aggregate-layer negative test that injects a deliberately non-monotone upstream prefix and verifies `aggregate_by_tau` exposes it rather than smoothing, clipping, or cumulative-max repairing it.
- a no-branching test/provenance assertion that single-hop and multi-hop enter the same subject-span evidence projection, with single-hop appearing only as the one-edge degeneracy.

The outside-in cohort suite remains the acceptance oracle for public behaviour. The focused tests above are necessary because the public symptom can disappear through clipping or fallback while the semantic defect remains.

### A.6 Build order

The change is committed atomically, but the working tree progresses through dependency-ordered phases. Each phase is a precondition for the next; reversing the order either leaves the foundation absent (notably multi-hop `M_select`) or produces a partial fix that masks one of the invariants stated above. Atomicity is a commit property; this is a build property.

1. **Runtime exposure of `M_select(U, C, u)`** as a first-class per-primitive selected-source-day mass surface, populated from the carrier-only primitive-conditioned carrier distribution and `_root_window_carrier_n_by_anchor_day`. Multi-hop composition through preceding subject primitives lives on the runtime object, not in the projection layer. Without this surface the no-branch directive in §10 has nowhere to land and the projection will be tempted to invent a single-hop shortcut.

2. **Placement shape extension.** `_row_selected_a_clock_placements` returns `(anchor_day, source_day, tau, share)` rather than `(anchor_day, tau, share)`; surfaces store `edge -> anchor -> source_day -> tau`. This is the foundation for every accumulator and forward-fill below.

3. **Per-source-day forward-fill and rate-attribute composition** in `_build_observed_span_evidence_surface`. `n_weighted` and `k_weighted` accumulate separately per source day. The rate is forward-filled within source day. The contribution at `(C, tau, source_day)` is `M_select(U, C, source_day) × k_at_or_before(source_day, tau) / n_at_or_before(source_day, tau)`. The contribution is summed across source days only after per-source-day carry-forward.

4. **Dual-prefix object.** `X_prefix(C, tau) = N_cohort(C) × G_carrier(C, tau)`, carrier-only and not rate-attributed. `Y_prefix(C, tau)` is the rate-attributed sum from phase 3. Both are exposed through `SelectedAClockEvidence` (`cells_by_anchor_day`, `prefix_for_anchor_day`, `prefixes_for_cohorts`, `aggregate_by_tau`) so downstream consumers read a single object.

5. **Seam wiring.** `_selected_cohort_group_rate_draws` derives `x_frozen` and `y_frozen` from the same prefix object that feeds `aggregate_by_tau`. `_project_runtime_rows` reads evidence and continuation from the same object. Any legacy `engine_cohorts.obs_x/obs_y` initialisation and any raw-`k` selected-cell fallback are removed at this phase, not later.

6. **Strip any latent monotonicity repair** from the aggregate path: sort, clip, cumulative-max, floor-zero, or any other display-layer correction. The negative test in A.5 only catches upstream regressions if the aggregate truly forwards the upstream prefix.

7. **Tests and shape audit** per A.5.

The order matters because the public symptom may already look fixed after phase 4. Without phase 5 the seam still gaps; without phase 6 a future regression is silently smoothed. Stopping at phase 4 is the most likely partial-fix failure mode, and the build order is designed to prevent it.

### A.7 Residual work after this fix lands

This rate-attribution fix is the substantive content of Atom 1 of [`cohort-maturity-evidence-coverage-design.md`](cohort-maturity-evidence-coverage-design.md), extended in scope after D1-D3 were discovered. The original Atom 1 was about the coverage signal and the absent/covered-zero/covered-positive three-state contract; this document supersedes its computational core (the rate-attributed dual-prefix object) without changing the coverage-signal goals. The two remaining atoms from that design are unchanged in intent and become the natural next commits:

**Atom 2 — unify the display path across window and active.** Bring window-mode evidence display onto the same `SelectedAClockEvidence` substrate that this fix has just hardened, eliminating the `is_active_carrier` branch in the row builder and the parallel frame-derived forward-fill path. The no-branching directive in §10 and the per-primitive `M_select(U, C, u)` runtime exposure built in A.6 phase 1 do the architectural groundwork: window single-hop becomes the chain-of-length-1 degeneracy of the unified composition, and identity carrier becomes the chain-of-length-0 degeneracy where the carrier surface reads the X-rooted subject primitive's `n` directly and the carrier backmap is identity. Atom 2 then reduces to (i) invoking `_build_active_selected_a_clock_evidence_from_runtime` unconditionally with the identity-carrier short-circuit, (ii) dropping the `is_active_carrier` branch on the evidence side of the row builder, (iii) removing the frame-derived `engine_cohorts.obs_x/obs_y` forward-fill from `_project_runtime_rows`. Atom 2's load-bearing risk is multi-hop window numerical drift versus the legacy `compose_path_maturity_frames` path; the drift must be diagnosed case-by-case before Atom 2 lands. The original design's Atom 2 §5.2 remains the spec.

**Atom 3 — retire the frame-derived evidence layer.** Once the row builder no longer reads from `engine_cohorts.obs_x/obs_y`, shrink `build_cohort_evidence_from_frames` to its residual responsibilities (cohort_list materialisation, epoch-boundary derivation, `a_pop` plumbing, evidence-superset metadata) and remove the forward-fill machinery and the `is_active_carrier` parameter that today gates whether the prefix is zeroed. Pure housekeeping; deferable without blocking user-visible behaviour, but worth landing soon after Atom 2 to prevent the legacy path from silently re-emerging in future refactors. The original design's Atom 3 §5.3 remains the spec.

The original design doc remains the source of truth for Atoms 2 and 3 and for the coverage-signal three-state contract (§3.1). This document supersedes only its Atom 1 computational core. Read together: this falling-k document for the rate-attributed prefix machinery; the original design for what comes next.
