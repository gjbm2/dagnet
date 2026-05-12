# Cohort Maturity — Evidence Coverage Design

**Status**: atom 1 landed (commit `4f5c96c2`, 7-May-26); atom 2 partly landed alongside it (window-mode coverage emission via legacy substrate), atom 2 substrate-unification pending; atom 3 pending
**Date**: 6-May-26 (revised 9-May-26 to reflect landed work and re-stage atom 2)
**Scope**: cohort maturity v3 chart evidence display semantics (FE + BE)
**Cross-references**:
- [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic source of truth; invariants 1 (one general forecast machinery path), 6 (identity carrier is data, not a route), 9 (projection must not re-decide semantics) are load-bearing for this design
- [`docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`](codebase/FORECAST_RUNTIME_ARCHITECTURE.md) — `ResolvedCFRuntime`, `SelectedAClockEvidence`, primitive-bound observed surfaces
- [`docs/current/codebase/KNOWN_ANTI_PATTERNS.md`](codebase/KNOWN_ANTI_PATTERNS.md) — AP58 (forking by case instead of degenerating one path)
- [`docs/current/cohort-maturity-selected-cohort-projection-pattern.md`](cohort-maturity-selected-cohort-projection-pattern.md) — Phase 3 active-cohort projection pattern (the precedent that fixed the reducer but left display branched)
- [`docs/current/handover/5-May-26-active-cohort-display-evidence.md`](handover/5-May-26-active-cohort-display-evidence.md) — Phase 3 implementation history

---

## 1. Problem

The cohort maturity chart's evidence display has two related defects:

1. **Active `cohort(A, X→end)` queries fail to render evidence circles for "covered" days where the cohort has not yet matured.** A snapshot taken on day τ for an anchor whose carrier mass has not yet reached X produces a row with `k_weighted = 0` (no conversions observed yet). The current pipeline filters this row at four sites — cell builder, pairing, aggregate, row builder — silently dropping the covered τ from the chart. The user has no way to distinguish "no observation taken" from "observation taken, nothing has happened yet".
2. **The defect bites only `cohort()` queries, not `window()`.** Window mode reads evidence through a legacy frame-derived forward-fill path (`engine_cohorts.obs_x/obs_y` populated from `build_cohort_evidence_from_frames`), which defaults the cohort base mass to `n` and never touches the value-zero filters. Active cohort reads through the newer primitive-bound `SelectedAClockEvidence` path, which is the one that filters.

The asymmetry is the symptom of an architectural over-branching: the row evidence display is forked between window and active-cohort even though the canonical semantics doc (invariants 1 and 9) says the projection must consume one resolved runtime object regardless of mode.

This document specifies (i) a **coverage signal** that replaces the binary "did a row land here" question with a continuous fractional signal, (ii) a **visual contract** for how the chart renders that signal, and (iii) a **staged implementation plan** that fixes the active path first and then unifies window onto the same display surface.

## 2. Coverage signal — definition

### 2.1 Domain

The coverage signal is a per-(chart row) numeric value in `[0, 1]` describing how strongly the row's evidence point is observed across the selected cohort set.

It is computed from data already in hand: each primitive-bound evidence row carries a `retrieved_at`, an `observed_date`, an `n_weighted`, a `k_weighted`, and a set of `root_day_shares` mapping the row onto selected anchor days. The signal sums these shares with a per-cohort cap.

### 2.2 Definition (per role)

For each role *r* ∈ {carrier (X side), subject (Y side)}, for each chart-row τ:

  `coverage_r(τ) = Σ_cohort min(1, Σ_row share_row × 1[exact-τ landing for cohort]) / |cohorts in scope|`

where:
- **"cohorts in scope" is the admissible subset of `fe.cohort_list`**, **not** the raw DSL date range and **not** `len(fe.cohort_list)` itself. `fe.cohort_list` is the runtime-materialised list from `build_cohort_evidence_from_frames` but it includes anchors that fail base-mass admission downstream — `compute_cohort_maturity_rows_v3` zeros `engine_cohort.a_pop` for anchors with `no_root_window_evidence` after `_root_window_carrier_n_by_anchor_day`. The coverage denominator must filter by admissible base mass:
  - In active mode (`A != X`): cohorts with `engine_cohort.a_pop > 0`.
  - In window or `cohort(A=X)`: cohorts with positive cohort base mass (i.e. the X-rooted subject primitive has a non-zero `n` for that anchor).

  An implementer must not divide by `len(fe.cohort_list)`; that includes zeroed-a_pop and zero-base-mass anchors and would spuriously drop epoch-A coverage below 1. The denominator is explicitly the count of admissible cohorts, exposed as an attribute on the selected-evidence object;
- the inner sum is over evidence rows that map onto this cohort at exactly this τ on the cohort's A-clock (`retrieved_at − anchor_day = τ`);
- `share_row` is the row's placement weight onto this cohort, derived from `root_day_shares` (and, for subject rows in active-cohort mode, the join-conditioned carrier backmap);
- the `min(1, …)` cap per cohort ensures that multiple rows landing at the same `(cohort, τ)` (e.g. carrier + subject simultaneously) cannot inflate the cohort's contribution above 1.

### 2.3 Definition (per row)

The chart's per-row coverage is the **minimum** of the two role coverages:

  `coverage(τ) = min(coverage_carrier(τ), coverage_subject(τ))`

Rationale: a chart point is no better observed than its weakest side. If the carrier observation is fresh but the subject observation has not yet arrived, the row reflects partial evidence on the Y side and the displayed point should be weighted accordingly. The per-role signals are also surfaced as separate fields so display logic can be more expressive if needed.

### 2.4 Properties

The signal naturally produces the four behaviours the chart needs:

1. **Epoch-A baseline at 1.** With daily snapshot retrieval through the cohort window, every selected cohort contributes a fresh row at every τ ≤ `tau_solid_max`. Per-cohort coverage = 1 for all cohorts; sum / |cohorts| = 1.
2. **Sub-1 from missing retrievals.** A retrieval gap on day D removes one row per affected cohort. The cohorts whose τ at D is the affected day contribute 0; coverage drops to (|cohorts| − affected) / |cohorts|.
3. **Smooth 1→0 decay through epoch B.** Past `tau_solid_max`, cohorts age past their last snapshot one by one. The youngest cohort runs out first, then the next-youngest, and so on; each running-out drops coverage by 1/|cohorts|. By `tau_future_max` only the oldest cohort still has fresh observations.
4. **Latency-distribution smoothing.** Subject rows on the X-clock are mapped onto the A-clock via the join-conditioned carrier CDF. A single subject snapshot at `(X-day, retrieved_at)` distributes its share across multiple anchor days proportional to the carrier's reach to those anchors at the relevant lag. Coverage at any one `(cohort, τ)` cell receives a fractional contribution. The further the subject is downstream of the anchor (more upstream edges to convolve), the more the signal blurs across τ. This is correct and expected: it reflects the genuine uncertainty about which anchor's cohort produced an observation at the subject end.

### 2.5 Window mode degenerates cleanly

In `window()` mode the carrier collapses to identity (`composed_carrier = None`, `population_root = denominator_node`). There is no carrier backmap; subject rows are placed at their own X-day with `share = 1.0`. Per-cohort coverage at each τ is binary 0 or 1 — the cohort either has a snapshot at exactly τ or it does not. Aggregate coverage in epoch A is 1 in the typical case, drops below 1 only on retrieval-gap days, and decays smoothly through epoch B as cohorts age out. No additional logic; window is a degenerate case of the same formula.

## 3. Data-layer contract

The chart row gains the following fields. Existing fields keep their semantics with one bug fix and a sharpened absent-vs-zero contract.

### 3.1 Three states (load-bearing)

The data layer distinguishes three states for evidence-named fields, including the new coverage fields. **Conflating any two is the original bug.**

| State | When | `evidence_x` / `evidence_y` | `evidence_x_coverage` / `evidence_y_coverage` / `coverage` | `rate` |
|---|---|---|---|---|
| **Absent** | Selected A-clock evidence machinery is unavailable for the row (no carrier primitives in active mode; no admissible primitive surface in window mode; or the request degraded per existing runtime invariant 12) | `None` | `None` | `None` |
| **Covered with zero mass** | Machinery exists and at least one cell at-or-before τ from at least one cohort, but the cumulative observed value is zero (e.g. carrier observed but nothing has reached X yet, or carrier observed but no subject conversions yet) | `0.0` (numeric) | numeric in `[0, 1]` (typically `> 0` since at least one cohort is contributing) | `None` (`0/0` is undefined) on the X=0 side; `0.0` on the Y=0 / X>0 side |
| **Covered with positive mass** | Machinery exists and at least one cohort has positive mass at-or-before τ | numeric > 0 | numeric in `[0, 1]` | numeric |

The runtime invariant the canonical doc already pins (FORECAST_RUNTIME_ARCHITECTURE.md §12: "If selected A-clock evidence is absent, evidence-named row fields are absent rather than reconstructed from a different clock") extends to the coverage fields verbatim — the absent state is the same gate.

### 3.2 New fields

- `evidence_x_coverage` — float in `[0, 1]` or `None`. Carrier-side per-row coverage as defined in §2.2 with `r = carrier`.
- `evidence_y_coverage` — float in `[0, 1]` or `None`. Subject-side per-row coverage with `r = subject`.
- `coverage` — float in `[0, 1]` or `None`. The min of the two per §2.3. This is the canonical field for chart visual weighting.

All three are `None` exactly when the row is in the **Absent** state of §3.1; otherwise numeric.

### 3.3 Existing fields — semantics fix

- `evidence_x` — observed cumulative X mass across selected cohorts at this τ. Latest-as-of carry-forward semantics (latest cell at-or-before τ per cohort, summed). **Fix**: must report `0.0` (not `None`) in the **Covered with zero mass** state — the "covered with no carrier mass yet" case. Stays `None` in the **Absent** state.
- `evidence_y` — observed cumulative Y mass with the same semantics. Same fix.
- `rate` — `evidence_y / evidence_x` if `evidence_x > 0`, otherwise `None`. Unchanged: `0/0` is genuinely undefined.
- `rate_pure` — same gating with the boundary-frozen denominator.

### 3.4 Field separation

`evidence_x` / `evidence_y` and the coverage fields are semantically independent: the former describe *what* was observed; the latter describe *how strongly* it was observed. They share an absent/present gate (per §3.1) but otherwise vary independently. A cell with `evidence_y = 0` and `coverage = 1` says "every selected cohort produced a fresh observation at this τ and they all said zero conversions". A cell with `evidence_y = 5` and `coverage = 0.3` says "we observed 5 conversions but only 30% of selected cohorts contributed fresh evidence to this point".

## 4. Visual semantics

### 4.1 Chart shape today (corrected)

The cohort maturity chart renders evidence through **line series with symbols**, not scatter — see [`cohortComparisonBuilders.ts`](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts) (`symbolSize: 6` on the evidence line). The "evidence circles" the user perceives are the symbols on that line. There is also an existing per-point opacity mechanism (`fadeOpacity(τ, baseOpacity)` rewriting `itemStyle.opacity` per point at lines 620-625) used for forecast shading. Any coverage-driven opacity treatment must compose with this existing mechanism rather than replace it.

### 4.2 Coverage → opacity composition

Coverage is mapped linearly to a per-point opacity multiplier:

  `point_opacity(τ) = coverage(τ) × fadeOpacity(τ, baseOpacity)`

so:
- `coverage = 1` does not change existing rendering — `fadeOpacity` is unchanged, base opacity is preserved.
- `coverage = 0` zeroes the symbol regardless of `fadeOpacity` — effectively hiding the marker at that τ.
- intermediate coverage linearly attenuates whatever opacity `fadeOpacity` produced.

The composition is multiplicative because the two effects are independent: `fadeOpacity` describes the chart's epoch-shading policy ("evidence past the seam should fade visually"), while `coverage` describes how strongly the underlying data supports the point. A point that is both past the seam *and* has weak coverage should be doubly faded.

The line itself (`lineStyle.opacity`) is not coverage-modulated. The line carries the evidence trajectory; the symbols carry the per-point coverage signal. If a future UX iteration wants the line to fade in low-coverage regions, that's a separate, additive change — the BE contract supports it (coverage is on every row).

### 4.3 Implementation note for the FE atom

**Scope of the multiplication: evidence-line symbols only.** The existing per-point opacity rewrite at [`cohortComparisonBuilders.ts:620-625`](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L620-L625) iterates per-series across all chart series — evidence line, midpoint, fan upper/lower, model overlays — and rewrites every series' per-point `itemStyle.opacity` via `fadeOpacity(τ, baseOpacity)`. The coverage multiplication must **not** apply uniformly to all series. Per §4.5, midpoint, fan, and model surfaces keep their existing per-point opacity behaviour unchanged. The implementation gates the coverage multiplication by series identity (the evidence line, identified by series id or role), and applies it only there.

Concretely: when the series being walked is the evidence line, the per-point `itemStyle.opacity = coverage(τ) × fadeOpacity(τ, baseOpacity)`. For all other series, the existing `fadeOpacity(τ, baseOpacity)` runs unchanged. No structural change to the series shape; no new scatter series needed.

If a separate "evidence circles" series is desired in the future (for clarity, or to render coverage on a non-line chart), that's an FE refactor that doesn't change the BE contract — the coverage field is already per-row.

### 4.4 What this gives the user

A chart point with strong evidence (every cohort contributing) renders at full strength under whatever the chart's fade policy already produces. A chart point with partial evidence (e.g. half the cohorts have aged past their last snapshot) renders at half-strength of that, signalling visually that the rate estimate at this τ is supported by less data. The same control applies to the latency-smoothing case: deeply convolved subject coverage produces faded symbols, naturally communicating uncertainty.

The smooth alpha decay through epoch B is the visual equivalent of the evidence "running out" past `tau_solid_max`. The chart no longer needs a hard epoch-B/epoch-A boundary in evidence rendering; the boundary is implicit in the alpha transition.

### 4.5 What it does not change

- The midpoint, fan, and model-overlay surfaces are not coverage-modulated. They continue to render as defined today.
- The evidence line's stroke is unaffected. Only the symbols' opacity changes.
- The data layer emits numeric `evidence_x` / `evidence_y` / `coverage` only when the row is in the **Covered** state per §3.1. In the **Absent** state, all three are `None` and the chart's existing "no data" rendering applies.

### 4.6 Edge cases

- **Absent state (§3.1)** — `coverage = None` propagates to no symbol drawn. The line series simply has no point at that τ. This matches existing chart behaviour for `None` data points.
- **`rate = None` with `coverage > 0`** — happens at the **Covered with zero mass** state when the X side is zero. No position to render; no symbol drawn regardless of coverage.
- **`rate` defined and `coverage = 0`** — the **Covered** state but no cohort contributed at this τ. Multiplied opacity = 0; effectively hidden. No special-case needed.
- **Coverage values outside `[0, 1]`** — a defect; the data layer must guarantee the cap.

## 5. Implementation plan — staged

The work falls into three atoms. Atoms 1 and 2 are independently reviewable and shippable. Atom 3 is documented for completeness but not required to land the user-visible fix.

### 5.1 Atom 1 — coverage signal in the active-cohort display path

**Status (9-May-26)**: landed in commit `4f5c96c2` ("Outside in _finally_ passes, post-full CF rebuild"). The `SelectedAClockEvidence` machinery — cell builder, pairing, aggregate, row builder — emits the coverage fields specified in §3.2 for active-cohort queries. The four value-based filters at the fork sites described below were removed at the corresponding sites in `cohort_forecast_v3.py`. The pinning tests live in `test_active_cohort_display_invariants.py` and pass. Window-mode coverage emission was added at the same time but via a degenerate per-cohort binary signal computed from the legacy frame-derived substrate; the substrate unification is atom 2's remaining work. The prose below is preserved as the historical specification of atom 1.

**Scope**: extend the existing `SelectedAClockEvidence`-driven display path used by active `cohort(A, X→end)` to compute and surface the coverage signal, and remove the value-based filters that today drop covered-zero rows.

**Goal**: the active-cohort row builder emits `evidence_x`, `evidence_y` as numeric (zero when covered with zero mass, never `None` when a cell exists), `evidence_x_coverage`, `evidence_y_coverage`, and `coverage` per row. Window-mode display is left unchanged for now.

**Changes by layer (in prose; one-to-one with the fork sites identified in the investigation)**:

- **Cell builder** for primitive-bound observed span surfaces. Today the row-walk skips rows whose `k_weighted` is non-positive and the cell-emit skips cells whose composed flow is non-positive. Both checks confuse "no observation" with "observed zero". The fix: the row-walk skips only rows that fail to produce *any* placement (genuine off-clock); the cell-emit always emits whenever any row landed, regardless of value. In parallel, the cell builder accumulates a per-cell sum of placement shares — the raw input to the coverage numerator — alongside the existing value accumulation.

- **Pairing** in the active-cohort selected A-clock evidence builder. Today the pairing requires positive carrier `observed_count` to emit a paired cell. The fix: the pairing emits whenever the carrier surface produced a cell at-or-before τ, regardless of count. The paired cell records `x_at_query_x` and `y_at_subject_end` directly (zero when applicable) and additionally carries the per-role share sums from the cell builder.

- **Aggregate** on `SelectedAClockEvidence`. Today the per-anchor sum and the bucket-emit gate exclude cells with `x_at_query_x = 0` and buckets with `sum_x = 0`. The fix: per-anchor sum admits any cell that exists at-or-before τ; bucket-emit fires whenever the iteration produced at least one contributing cohort. The boundary collector (which freezes the denominator past `tau_solid_max`) drops the `> 0` test on the boundary cell. Past the boundary, `denominator_pure` carries the boundary's frozen sum (which may legitimately be zero); `denominator_fe` continues with cumulative `sum_x`. The aggregate also computes per-cohort capped coverage sums per role and emits `sum_carrier_coverage`, `sum_subject_coverage`, and `n_cohorts_in_scope` per bucket.

- **Row builder**. Today the active-cohort branch sets `evidence_x` and `evidence_y` to `None` whenever the bucket's `rate_x` is non-positive; the fix removes that conditional and emits the numeric values whenever a bucket exists. `rate` and `rate_pure` keep their positive-denominator gates because `0/0` remains undefined. The row also computes `evidence_x_coverage = sum_carrier_coverage / n_cohorts_in_scope`, `evidence_y_coverage = sum_subject_coverage / n_cohorts_in_scope`, and `coverage = min(...)`, surfacing all three on the row dict.

**What this atom does not change**: the window-mode display branch, the reducer (`_selected_cohort_group_rate_draws`), the carrier/subject composition, the primitive conditioning, the model overlay, the completeness machinery, the per-cohort `a_pop` derivation, and the canonical semantics doc invariants.

**Test surface**:
- The three currently-failing pinning tests in `test_active_cohort_display_invariants.py` flip green: covered-zero buckets emit, primitive-bound surfaces preserve covered-zero rows, end-to-end rows surface numeric evidence at covered τs.
- Three new tests pin the coverage signal: (a) coverage is `1.0` in epoch A with synthetic dense snapshots and identity-share placements; (b) coverage decays smoothly as cohorts age past their last snapshot in epoch B; (c) coverage is fractional under deliberate share-distributing fixtures (multi-anchor placement with non-integer shares).
- The seven currently-passing tests stay green.
- The outside-in oracle suite for active-cohort scenarios re-runs without regressions.

**FE-side companion (separate change set, sequenced after atom 1's BE landing)**: the cohort_maturity ECharts builder reads the new `coverage` field from each row's evidence point and maps it linearly to `itemStyle.opacity`. The legacy "binary visible/hidden" toggle is replaced by the alpha mapping. No new chart kind, no new analysis type.

### 5.2 Atom 2 — unify the evidence display substrate

**Status as of 9-May-26**: a partial form of atom 2 has already landed alongside atom 1. Window-mode rows already emit `evidence_x_coverage`, `evidence_y_coverage`, and `coverage`, but compute them via a per-cohort binary signal (τ ≤ frontier_age → 1 else 0) aggregated from the legacy frame-derived `engine_cohorts.obs_x/obs_y` forward-fill — not from `SelectedAClockEvidence`. The reducer's selected-prefix path (`_selected_cohort_group_rate_draws`) is already invoked for both modes; the prior atom 2 deliverable "the reducer's selected-prefix path is invoked for both modes" is therefore done, not pending. The 73n generalisation of CF conditioning also landed an explicit runtime invariant — "window() and cohort(A=X) are data cases of the same runtime object: their carrier composition is identity" — which is the architectural premise of this atom, now codified in code rather than only in this design.

**Status as of 10-May-26**: sub-stages 2a, 2b, and 2c have all landed. The evidence builder is mode-agnostic (renamed `_build_selected_a_clock_evidence_from_runtime`), serves identity-carrier runtimes via the chain-of-length-0 carrier degeneracy and chain-of-length-1 subject degeneracy, and is invoked unconditionally at the row-builder call site. The row builder reads `selected_evidence_by_tau` for both modes; the `is_active_carrier` branch on the evidence side is gone; the `engine_cohorts.obs_x/obs_y` forward-fill loop has been removed from `_project_runtime_rows`. The cross-cutting natural-degeneracy parity test is in place at builder-level and end-to-end. The outside-in oracle suite is green across both modes (45 passed, 1 expected xfail). Two load-bearing fixes were required during implementation: (a) the midpoint shift in `_build_rate_attributed_subject_prefix` is now data-derived (`0.5 if len(anchor_buckets) > 1 else 0.0`) rather than a hardcoded `0.5` — the previous form silently zeroed single-source-day rates; (b) `_build_selected_source_day_mass` now treats `topology_case='identity'` as a Dirac at offset 0 (PMF=[1.0]) rather than as a degraded case — without this, identity-carrier window queries refused to wire selected-evidence prefix and outside-in fell back to legacy paths. Atom 2 is **closed**.

**What still needs doing**: nothing for atom 2 itself. `engine_cohorts` continues to feed the reducer's identity-carrier prefix and the `a_pop` derivation; atom 3 retires those residual responsibilities. The original "what still needs doing" framing — flip the read substrate, retire the forward-fill — is complete.

**Scope**: bring window-mode evidence display onto the same `SelectedAClockEvidence` substrate that atom 1 fixed. Eliminate the `is_active_carrier` branch in the row builder and the parallel frame-derived forward-fill path.

**Goal**: most of this machinery must be a **no-op for window queries** — that's the test of correctness. The no-op must emerge as natural degeneracy from the same composition pattern, not via `if is_window:` branches. Minimum code surface, minimum test span.

#### Acceptance: natural degeneracy as outcome contract

The watchword for this atom is *natural degeneracy*. It is an outcome property, not just an architectural one: given the same observation timeline and the same underlying truth, an equivalent `window(X→end)` query and `cohort(A=X, X→end)` query — which are the same runtime object per the 73n invariant — must produce **identical coverage blobs and identical chart-visible evidence series**. This is the falsifier for the atom: if after atom 2 a window query produces a binary opacity signal where the equivalent `cohort(A=X)` query produces a fractional one, or the covered-with-zero-mass rendering surfaces in one mode but not the other, atom 2 is incomplete regardless of how the read substrate is wired underneath. The substrate unification is the *means*; cross-mode consistent chart semantics is the *end*.

For non-trivial multi-hop window queries — where carrier composition is identity but subject composition runs on the calendar-date axis with the acknowledged mixed-cohort property of Appendix A — the natural-degeneracy rule applies to the *machinery*, not to output-equality with multi-hop active cohort. The two are genuinely different queries asking different questions, and their answers may differ. What must be the same across both modes is: the row schema (the same fields, populated under the same gates), the three-state contract (§3.1: Absent / Covered-with-zero-mass / Covered-with-positive-mass, with identical detection rules), the coverage formula (§2.2, applied identically), and the visual composition rule (§4.2, `coverage × fadeOpacity`). What may differ across modes is the values inside that schema, by design — values are a function of the underlying composition, which differs by query semantics.

This acceptance contract is operationalised as a **cross-cutting natural-degeneracy parity test**, written in sub-stage 2a (asserting builder-level equality on the identity-carrier degeneracy) and tightened in sub-stage 2c (asserting end-to-end row and chart-render equality between `window(X→end)` and `cohort(A=X, X→end)` for representative fixtures, modulo cohort indexing labels). This test, not the outside-in suite alone, is the gate for atom 2 closing.

#### The composition pattern (one for all modes)

Each primitive carries its own arrival map from conditioning (local-clock for window per Appendix A; A-rooted propagated for cohort). The display reads each primitive's rows and places them at `(observed_date, τ = retrieved_at − observed_date)` per its own arrival map. `_build_observed_span_evidence_surface` runs uniformly: per-edge contributions per `(anchor_axis, τ)` cell, then topology max-flow over the chain. Pairing produces a `SelectedAClockEvidenceCell` per `(anchor_axis, τ)`. Aggregate, row builder, and coverage signal consume this uniformly.

The chart's anchor axis is the `population_root` — A for active cohort, X for window or `cohort(A=X)`. Active cohort additionally maps subject placements from X-day onto A-day via the existing join-conditioned carrier backmap; that backmap is identity when `population_root == X`.

**Crucially**: there is no new arrival-map machinery, no clock-shifting in window mode, and no propagation for window display. Each primitive's existing conditioning placements feed the surface builder directly. Window multi-hop's calendar-date axis labels different cohorts uniformly — the **acknowledged mixed-cohort property** of window mode per Appendix A. The display inherits it; we are no longer hiding it behind a parallel frame-derived path.

#### What's a no-op for window — the correctness test

Tested as natural degeneracy, not as conditional branches:

| Machinery | Active multi-hop | Window single-hop | Window multi-hop |
|---|---|---|---|
| Carrier topology composition | `A→…→X` chain max-flow | empty chain → no-op | empty chain → no-op |
| Carrier backmap (X-day → A-day) | non-trivial join-conditioned CDF | identity (X = A) → no-op | identity (X = A) → no-op |
| Subject topology composition | `X→…→end` chain max-flow over A-clock placements | one-edge max-flow = that primitive's `k` | chain max-flow over local-clock placements |
| Subject placement onto chart axis | X-day → A-day via backmap | natural (observed_date = X-day) | natural (each primitive at its own source-day) |
| Coverage signal | per-cohort capped sum across primitives' shares | one primitive, share = 1.0 typical → coverage ∈ {0, 1} per cohort | mixed-cohort axis labelling per Appendix A; coverage is integer per cohort per τ |
| Aggregate + row builder | unified | unified | unified |

The only non-uniform construction step is the **denominator surface for identity carrier**: when the carrier chain is empty, the X-count comes from the X-rooted subject primitive's `n` directly (the X-rooted primitive's `n` is by-definition the X-cohort's base mass; there's no chain to compose). This is one structural property of the data, not a logical fork that propagates downstream.

#### Single-hop is the chain-of-length-1 case of multi-hop

Subject chain of length 1 → max-flow over one edge = that edge's k. No special-case logic. Carrier chain of length 0 (identity carrier) → no-edge case where the X-count comes from the X-rooted subject primitive's `n`. Both fall out of the same machinery.

#### Window multi-hop and the mixed-cohort axis (acknowledged)

In window multi-hop, primitives' rows place at their own source-days (per local-clock conditioning). Different primitives have different source-days. When the chart's calendar-date axis treats them uniformly under the same anchor label, max-flow runs on a calendar-date axis where different cohorts share labels (X-day=Mar1 and Y-day=Mar1 are different cohorts both placed at "Mar1"). This is **window mode's mixed-cohort property** per Appendix A — owned and accepted by the user. Active cohort doesn't inherit this property because cohort-mode binding propagates all primitives' rows onto a common A-day axis.

#### Sub-stages

The remaining work decomposes into three sub-stages with tight stop conditions. Each sub-stage is independently reviewable and shippable; each leaves the system in a verifiable state. The point of staging is to surface the load-bearing risk — multi-hop window numerical drift — *before* flipping production, not during it.

**Sub-stage 2a — make the evidence builder mode-agnostic.** Extend `_build_active_selected_a_clock_evidence_from_runtime` to operate on identity-carrier runtimes (`population_root == denominator_node`, the case for window or `cohort(A=X)`). Identity carrier is the chain-of-length-0 case of carrier composition: the carrier surface reads the X-rooted subject primitive's `n` directly; the backmap from X-day onto A-day is identity. Single-hop window is the chain-of-length-1 case of subject composition: max-flow over a one-edge chain trivially equals the primitive's `k`. Both fall out of the existing composition algebra; no new branches are introduced. As part of this sub-stage the function is renamed to drop the "active" qualifier — after the rename it serves both modes, and the old name carries an architectural claim ("active" as a route) that this atom is explicitly retiring. The new code path is provably correct for window-mode runtimes but is **not yet wired into the row builder**; sub-stage 2a is verified by direct unit tests on the builder, fed window-mode runtimes and asserting that the returned `SelectedAClockEvidence` reflects the identity-carrier and chain-of-length-1 degeneracies. The cross-cutting natural-degeneracy parity test is also written here in its builder-level form: feed the unified builder equivalent `window(X→end)` and `cohort(A=X, X→end)` runtimes and assert the returned `SelectedAClockEvidence` objects are equal. **Stop condition**: the builder accepts window-mode runtimes and returns evidence; the parity test passes at builder level; the row builder still reads `engine_cohorts`; no observable production behaviour change.

**Sub-stage 2b — shadow-parity diagnostic.** Invoke the now-unified builder for window mode at the same call site as the active invocation. The row builder continues to read evidence from `engine_cohorts.obs_x/obs_y` (the legacy production source); the unified path runs in shadow alongside it. A diagnostic test compares the legacy `(evidence_x, evidence_y)` series against the unified series for fixed window-mode fixtures. Single-hop window is expected to be numerically identical (one primitive, one edge — max-flow trivially yields `k`; denominator from the same primitive's `n`); any drift there is a parity bug in the new composition and must be fixed before the sub-stage lands. Multi-hop window drift is **expected and not a regression** — the legacy `compose_path_maturity_frames` path reads frame `dp.x`/`dp.y` which may not faithfully reflect topology composition for chains. Multi-hop drift is diagnosed against the canonical mixed-cohort interpretation per Appendix A of `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` and resolved case-by-case: either a bug in the new composition (fix in 2b) or the new path correctly contradicting a pre-existing legacy bug (catalogued for 2c's pinning-test refresh). The shadow path exists for risk control; it does not change user-visible behaviour and is removed before atom 2 closes. **Stop condition**: single-hop window parity holds across the diagnostic fixtures; multi-hop drift is fully catalogued with cause classified per fixture.

**Sub-stage 2c — flip and retire.** Switch the row builder to read evidence from `selected_evidence_by_tau` for both modes. Remove the `is_active_carrier` branch on the evidence side. Remove the `engine_cohorts.obs_x/obs_y` forward-fill loop in `_project_runtime_rows`. Remove the shadow path from sub-stage 2b. Update tests whose numerical expectations depended on the legacy substrate, with each refresh justified by reference to a sub-stage 2b finding rather than by the test failing in CI. The cross-cutting natural-degeneracy parity test is **tightened** at this sub-stage from builder-level to end-to-end: equivalent `window(X→end)` and `cohort(A=X, X→end)` queries — same observation timeline, same X, same end node, same date range — produce identical row dicts and identical chart-rendered evidence series (modulo cohort indexing labels). After this sub-stage, `engine_cohorts` continues to feed the reducer's identity-carrier prefix and the `a_pop` derivation but is no longer read by evidence display. Atom 3 retires the residual responsibilities; atom 2 closes here. **Stop condition**: the row builder has no `is_active_carrier` branch on the evidence side, no read of `engine_cohorts.obs_x/obs_y`; the end-to-end natural-degeneracy parity test passes; the outside-in suite is green across both modes.

#### Runtime delta (refreshed)

- The selected-evidence builder is invoked unconditionally (sub-stage 2b wires the call; sub-stage 2c removes the legacy alternative). The carrier-chain composition step short-circuits for identity carrier (`population_root == denominator_node`) — the carrier surface is built from the X-rooted subject primitive's `n`. The subject-chain composition runs unchanged. The carrier backmap, when invoked, is identity in identity-carrier mode (no shift).
- The row builder drops the `is_active_carrier` branch on the evidence side (sub-stage 2c). Reads `aggregate_by_tau` for both modes.
- The frame-derived `engine_cohorts.obs_x/obs_y` forward-fill in `_project_runtime_rows` is removed for evidence display (sub-stage 2c). `engine_cohorts` continues to feed the reducer's identity-carrier prefix until atom 3 retires it.
- The reducer's selected-prefix path is **already** invoked for both modes (landed with 73n; no work needed in atom 2).
- The `a_pop` derivation is **unchanged** — still sourced from `_root_window_carrier_n_by_anchor_day` for active and from frame `dp.a` for window per §6.5.

**What atom 2 does not change**: the canonical semantics; the conditioning binding (still local-clock for window, propagated for cohort); the carrier/subject composition algebra; the reducer (already unified by 73n); the model overlay; the completeness machinery; public scalar moments; the cache identity rules.

#### Risk

The single load-bearing risk is multi-hop window numerical drift. Sub-stage 2b's shadow-parity diagnostic exists specifically to surface this before sub-stage 2c flips production. Single-hop window is expected to be numerically identical; any drift there is a parity bug in the new composition and must be fixed inside 2b. Multi-hop drift is expected: the legacy path's window-mode composition was never formally pinned by the canonical doc; the new path's max-flow on the calendar-date axis is the principled mixed-cohort interpretation. Drift findings are catalogued during 2b and used to justify pinning-test refreshes in 2c. Either way the diagnostic gate prevents silent behaviour change, and 2c's pinning-test refreshes are auditable rather than reactive.

#### Test surface, by sub-stage

- **Sub-stage 2a**: new direct unit tests on the unified builder for the two degeneracies — chain-of-length-0 (identity carrier: the carrier surface reads the X-rooted subject primitive's `n`; the carrier backmap is identity) and chain-of-length-1 (single-hop window: max-flow over one edge yields the edge's `k`). Tests exercise the builder directly, not end-to-end through the row builder. The cross-cutting natural-degeneracy parity test is created here in its builder-level form (equivalent `window(X→end)` vs `cohort(A=X, X→end)` runtimes → equal `SelectedAClockEvidence`). All atom-1 tests stay green.
- **Sub-stage 2b**: the shadow-parity diagnostic test comparing legacy and unified evidence series across window-mode fixtures (single-hop and multi-hop). Single-hop parity is asserted; multi-hop drift is logged with diagnostic context and reviewed before sub-stage 2c. The 2a parity test stays green. All atom-1 tests stay green.
- **Sub-stage 2c**: all atom-1 tests stay green; sub-stage 2a tests stay green; the sub-stage 2b shadow test is removed alongside the shadow path. Single-hop window numerical pinning tests stay green. Multi-hop window numerical pinning tests refresh against the new readings per the catalogue produced in sub-stage 2b — each refresh has a citation. **The cross-cutting natural-degeneracy parity test is tightened from builder-level to end-to-end** and asserts identical row dicts and identical chart-rendered evidence series across `window(X→end)` and `cohort(A=X, X→end)` for representative fixtures (single-hop, identity-carrier multi-hop subject); this is the named gate for atom 2 closing. The outside-in oracle suite re-runs across both modes; any regressions outside catalogued multi-hop window display drift are bugs and block the sub-stage.

### 5.3 Atom 3 — retire the frame-derived evidence layer

**Baseline clarification (11-May-26)**: the later `window()` coverage collapse
seen after Atom 2 was not an Atom 3 symptom. Direct DB inspection showed the
snapshot DB lacked later retrieval rows for mature window cohorts because the
fetch policy stopped refreshing around edge-local `t95` while the parameter
file header still made the window look covered. That baseline issue is now
owned by the fetch/refetch policy via observation-horizon multipliers
(`2.0 × t95`, `1.5 × path_t95`). Atom 3 should not be used to paper over
missing DB rows; it remains about removing the residual reducer fallback to
frame-derived `engine_cohorts.obs_x/obs_y`.

**Status as of 10-May-26**: atom 3 is **not deletion-only housekeeping**. Atom 2 removed the chart row builder's read of `engine_cohorts.obs_x/obs_y`, but the selected-Cohort reducer still needs an observed prefix for each selected cohort: "what X/Y values are already known before the forecast arm takes over?" In the current v3 path the reducer can read that prefix from `SelectedAClockEvidence` when the object exists, but it still has a residual fallback to `engine_cohort.obs_x/obs_y`. Deleting the fields without retiring that fallback would change or break the reducer's numerical input, especially for identity-carrier `window()` cases.

**Scope**: retire `engine_cohorts.obs_x/obs_y` from the **v3 selected-Cohort chart/reducer path** by making the reducer's observed prefix an explicit `SelectedAClockEvidence`-derived input. Keep the broader `CohortEvidence.obs_x/obs_y` shape available for older non-v3 consumers until those consumers are migrated separately (notably the remaining `compute_forecast_trajectory` callers such as daily-conversions annotation and surprise-gauge-style legacy paths).

**Goal**: zero parallel evidence surfaces inside v3. One selected evidence object supplies both:
- the chart's observed evidence fields (`evidence_x`, `evidence_y`, coverage fields);
- the reducer's observed prefix (`obs_x`, `obs_y`, `frontier_age`, `x_frozen`, `y_frozen`) before Pop D / Pop C forecasting begins.

**Implementation path**:

1. Name the reducer input contract explicitly: selected cohort observed prefix. It is a reducer input, not a chart artefact.
2. Build that prefix from `SelectedAClockEvidence.prefixes_for_cohorts(...)` for active and identity-carrier modes.
3. In v3, refuse the `engine_cohort.obs_x/obs_y` fallback whenever selected evidence was expected but missing. Missing selected evidence should degrade visibly rather than silently splice in the old frame-derived clock.
4. Prove simple identity-carrier `window(X→end)` cases are numerically unchanged.
5. Catalogue any multi-hop `window()` changes separately. Some drift may be correct because the old frame-derived path was never the canonical topology-composed substrate, but it must be reviewed before test expectations move.
6. Only after those gates pass, shrink `build_cohort_evidence_from_frames` to cohort-list materialisation, epoch-boundary derivation, `a_pop` / base-mass plumbing, and evidence-superset metadata for v3.

**Test surface**: the active-cohort and window-mode regression nets continue to apply, but atom 3 needs reducer-specific tests, not only "field absent" tests:
- reducer-level test: when `SelectedAClockEvidence` exists, the selected-Cohort reducer never reads `engine_cohort.obs_x/obs_y`;
- identity-carrier parity test: simple `window(X→end)` produces the same observed prefix and rows before/after the migration;
- missing-prefix degradation test: if selected evidence is expected for v3 but missing for a cohort, the reducer does not silently fall back to frame-derived arrays;
- multi-hop window diagnostic: any output drift is classified before pinning expectations are refreshed.

**This atom is deferable.** Atoms 1 and 2 deliver the user-visible fix and the architectural unification. Atom 3 is housekeeping that prevents the legacy path from re-emerging in future refactors, but the chart works correctly without it.

## 6. Risks and open questions

1. **Coverage signal in deeply-convolved subject scenarios**. Multi-hop subject spans through several latent edges produce backmap distributions with long tails. The coverage signal will faithfully report low values at edges of the distribution; we should sanity-check against an outside-in fixture that the resulting alphas are not so faded as to look like missing data when the user reasonably expects to see something. The threshold/curve question is a UX detail — the data-layer signal is correct; if linear alpha proves too aggressive in practice, the FE can apply a non-linear mapping (e.g. a floor at `alpha = 0.15`, or compose `coverage^γ` for some `γ < 1`) without changing the BE contract.
2. **Coverage × `fadeOpacity` interaction**. The multiplicative composition (§4.2) is uniform but produces compound fading where both signals are weak. If a chart point is past the seam (`fadeOpacity` ~ 0.5) and has weak coverage (~ 0.4), the rendered opacity is 0.2. This may be too faint in practice. Mitigation if needed: cap the multiplier (`min(coverage × fadeOpacity, fadeOpacity)`), or apply coverage only inside epoch A (where `fadeOpacity = 1` typically). FE-only knob; doesn't affect the BE contract.
3. **Cache identity for the new fields**. `coverage`, `evidence_x_coverage`, `evidence_y_coverage` are deterministic functions of the same inputs that produce the existing row fields, so they fall under the same cache identity. No changes to cache keys are required.
4. **Window-mode parity in atom 2**. Sub-stage 2b (§5.2) is the named diagnostic mechanism: the legacy and primitive-bound evidence are computed in parallel for window-mode fixtures and compared. For single-hop window, the values should be identical and parity is asserted; any drift is a parity bug in the new composition and must be fixed before 2b lands. For multi-hop window, parity with the legacy path is **not** the goal — the legacy path is suspect (it reads frame `dp.x`/`dp.y` which may not faithfully reflect topology composition for chains). Multi-hop drift is catalogued during 2b with cause classified per fixture (composition bug → fix in 2b; legacy-path defect → pinning-test refresh in 2c). The catalogue is the input to 2c's auditable test refreshes.
5. **`window()` coverage collapse after Atom 2 was a fetch-policy baseline issue, not an Atom 2/3 evidence-substrate issue.** A later 11-May-26 investigation showed the snapshot DB lacked late retrieval rows for mature window cohorts because the fetch/refetch policy stopped refreshing around edge-local `t95` while the parameter-file header still made the window appear covered. The fix is the settings-backed observation horizon multiplier (`2.0 × t95`, `1.5 × path_t95`), not an Atom 3 reducer fallback change.
6. **`a_pop` in window mode**. Today `a_pop` is sourced from the frame's `dp.a` for window and from `_root_window_carrier_n_by_anchor_day` for active. Atom 2 should not change the `a_pop` derivation — only the evidence display. The `a_pop` plumbing remains in `compute_cohort_maturity_rows_v3` and is unaffected.
6. **Materialised cohort_list contract**. §2.2 pins `|cohorts in scope|` to the materialised cohort_list. The materialisation rule (which cohorts are in vs out of scope) lives in `compute_cohort_maturity_rows_v3` for active (gates on `_root_window_carrier_n_by_anchor_day` non-zero) and in `build_cohort_evidence_from_frames` for window (gates on frame `dp.x` presence). Atom 1 should not change these gates — only consume their output. Any future change to cohort admission semantics propagates through this denominator automatically.
7. **Overlap with future direct-`cohort()` rate-conditioning work**. WP8 (doc 60) is a separate seam; this design touches only the display layer and is orthogonal to the rate-conditioning seam. No interaction expected.
8. **Active-carrier X-coverage regression in production-like cohort queries**. A live diagnostic on `bayes-test-gm-rebuild`, subject `from(switch-registered).to(switch-success)`, with active `cohort(15-Apr-26:20-Apr-26)` reproduced a serious coverage regression that the existing tests miss. The returned rows had `tau_solid_max = 20`, `tau_future_max = 25`, six selected cohorts, and a smoothly-decaying subject/Y coverage signal through epoch B (`0.825 → 0.659 → 0.493 → 0.327 → 0.161`). But carrier/X coverage was already `0.0` across the same τs, so final `coverage = min(evidence_x_coverage, evidence_y_coverage)` collapsed to `0.0`.

   The earlier synthetic tests are insufficient because they cover either hand-built `SelectedAClockEvidence` cells or clean identity-carrier (`A = X`) outside-in fixtures. They do not exercise an active multi-hop carrier (`A != X`) where X-prefix mass is resolved from `runtime.selected_x_prefix` while carrier freshness is read from the separate observed carrier surface. The regression appears to be on the carrier/X coverage construction path (`_build_observed_span_evidence_surface` → `carrier_landing_coverage`), not necessarily on the selected-prefix mass path: in the diagnostic, reducer prefixes were `from_selected: true`, `Σx_frozen` matched row `evidence_x`, and `X_total_last_med` matched `forecast_x`. That does **not** prove mass is semantically correct, but it makes "coverage-only bug" the current leading hypothesis.

   Comparison oracle: there is a pre-atom-2 graph snapshot for this workstream that likely predates the regression. Use it to compare the same `bayes-test-gm-rebuild` active-cohort analyse query before/after atom 2, especially `evidence_x`, `evidence_y`, `midpoint`, `forecast_x`, `forecast_y`, `evidence_x_coverage`, `evidence_y_coverage`, and final `coverage` through epoch B. This is the fastest way to distinguish a pure coverage regression from broader selected-prefix / reducer mass drift.

   Missing test: extend the outside-in coverage test to include a non-identity active-carrier case (`A != X`) rather than only the clean identity-carrier `from(b).to(c).cohort(...)` shape. The new test should use either the production-like `bayes-test-gm-rebuild` fixture or a deterministic synthetic analogue with a multi-hop `A→X` carrier. It must assert component coverages as well as final `coverage`: X coverage must not collapse to zero before/through epoch B while Y coverage is still fresh, and any final min-based collapse must reflect a real missing denominator observation rather than an artefact of carrier-chain exact-τ placement.

## 7. Out of scope

- Changes to the canonical semantics. The `Y/X` displayed-rate contract is unchanged; coverage is purely a visual-weight signal layered on top.
- Changes to the reducer or to model-projection semantics. Midpoint, fan, and model overlays are unaffected.
- Changes to the `window()` evidence-binding semantics. Window subject primitives remain on local-clock binding per the canonical Appendix A taxonomy.
- Changes to public scalar moments (`p_infinity_mean`, `p_infinity_sd`, etc.).
- Changes to FE-topo / Stage 2 / `applyPromotion` machinery.

## 8. Acceptance criteria

The work is complete when:

- The three states of §3.1 are honoured end-to-end: rows with no admissible selected A-clock evidence machinery are in the **Absent** state (all evidence and coverage fields `None`); rows with admissible machinery are in the **Covered** state with numeric `evidence_x`, `evidence_y`, `evidence_x_coverage`, `evidence_y_coverage`, `coverage`. The two states are deterministically derivable from the runtime; `_build_active_selected_a_clock_evidence_from_runtime` returning `None` (and its window-mode counterpart) is the single gate.
- The zero-numerator-with-positive-denominator case (the original bug) renders a symbol at `rate = 0` with opacity = `coverage × fadeOpacity` when the carrier has observed positive X but the subject has not yet converted to subject_end. (When the denominator is also zero, `rate` is `None` per §4.6, no symbol is positioned regardless — that case is correctly absent on the chart.)
- The chart's evidence symbols fade smoothly through epoch B as cohorts age past their last snapshots, via the multiplicative composition of `coverage` and `fadeOpacity`.
- Window-mode evidence display (post-atom-2) reads through the same `SelectedAClockEvidence` substrate and surfaces the same coverage fields. Multi-hop window subjects compose the numerator via topology max-flow and source the denominator from the first subject primitive's `n` per anchor day.
- The display row builder contains no `is_active_carrier` branch on the evidence side. The carrier role exists in both modes; identity carrier is data, not a route.
- **Natural-degeneracy outcome contract holds**: equivalent `window(X→end)` and `cohort(A=X, X→end)` queries — same observation timeline, same X, same end node, same date range — produce identical row dicts and identical chart-rendered evidence series (modulo cohort indexing labels). Coverage blobs render fractionally in window mode wherever they would render fractionally in `cohort(A=X)`; covered-with-zero-mass surfaces in window mode wherever it surfaces in `cohort(A=X)`; the three-state contract (§3.1), the coverage formula (§2.2), and the visual composition rule (§4.2) apply identically across modes. The cross-cutting parity test asserting this is the named gate for atom 2 closing.
- The frame-derived `engine_cohorts.obs_x/obs_y` forward-fill (post-atom-3) is no longer reachable from the v3 row builder or the v3 selected-Cohort reducer. Any surviving `CohortEvidence.obs_x/obs_y` uses are explicitly legacy non-v3 consumers with their own migration item, not hidden fallbacks inside v3.
- The denominator of `coverage` is the materialised cohort_list per §2.2; epoch-A coverage is `1.0` for the materialised set when retrieval is dense, regardless of whether the DSL range nominally included additional unmaterialised dates.
- Epoch-B evidence-symbol coverage decays as cohorts pass their own last real retrieval. Covered-zero subject values inside the observed frontier remain visible, but active-carrier X coverage must not collapse to zero while the selected X prefix is still observed and the subject/Y side still has fresh fractional support.
- The outside-in cohort suite remains green throughout. Any multi-hop window numerical drift that surfaces during atom 2 is diagnosed before atom 2 lands.
- The three currently-failing display-invariant tests are green; their docstrings reflect the coverage-signal-based contract rather than the binary "did a row land here" framing of the prior investigation.
