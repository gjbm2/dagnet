# Phase 6: Evidence Operator Contract

**Status**: Draft. Phase 6 deliverable for `model-first-strict-span-cutover-plan-13-May-26.md` §6.

**Date**: 14-May-26.

**Scope**: prose-only specification of the evidence-side algebra that the reducer will consume in Phase 7. No code. No API signatures. No implementation choices. The intent is to make the algebra reviewable as one document, name the invariants the implementation must honour, and pin the failure modes that the previous attempt (rolled back 11-May-26) suffered.

This doc is companion to `model-first-strict-span-cutover-plan-13-May-26.md`. It does not supersede the plan; it discharges plan §6's deliverable.

---

## 1. Purpose and reading order

The Phase 5 / 5.5 cutover landed the *model-side* algebra: per-draw operator chain composition, evaluated against a unit-impulse root mass, producing the F-mode model overlay. This works because the model-side algebra is mode-blind in a load-bearing way — window and cohort are data degeneracies of one composition.

Phase 7 will migrate the *evidence-side* reducer onto the same composition. The risk is that the reducer's per-cohort `ΣY / ΣX` plumbing has historically been a tangle of mode-specific branches with timing-axis conventions that drift between adjacent code paths. The previous attempt at this migration (preserved at `cohort_forecast_v3.generalisation-attempt.py`) was rolled back after a 1-day timing-shift bug at the single-hop cohort case that was never root-caused before the release deadline.

This doc fixes the algebra in prose so the Phase 7 implementer has a fixed target. The reading order:

- §2 — the two invariant families (cohort mass conservation, window local-rate reproduction) and why they differ.
- §3 — the four load-bearing rules (τ-axis, arrival-map / propagation consistency, unified push-forward, cumulative-vs-incremental boundary).
- §4 — the evidence-side surfaces (per-edge rate kernel, seed mass, the unified propagation formula, the cohort cancellation result, window non-cancellation, the support / freshness / emission contract in §4.7, and the masked-kernel coverage algebra in §4.8 — the same convolution as mass propagation, with an observation mask).
- §5 — how this maps to the new engine core (`model_span_spine.py`), including the term-by-term §4-symbol mapping in §5.1.5, the thin Phase 7 wrapper scope in §5.2, the prefix-object index reads in §5.3, and §5.4's pointer at the existing display contract pinned by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md). The load-bearing section. Read §5.1.5 first if you have an intuition gap or are picking up Phase 7 implementation cold.
- §6 — closure criteria and test families.
- §7 — out of scope.

---

## 2. The two invariant families

Cohort and window are not just different DSL clauses producing different outputs. They are different *algebraic regimes* with different conservation properties. Phase 6 specifies both, and the implementation must distinguish them.

### 2.1 Cohort: mass conservation

In `cohort(A, X→Z)`, we are propagating one real cohort — users observed at A on the anchor day — through the chain. Every conversion at Z is a user who was first seen at A. Every user at A either eventually reaches Z (with probability `Π p_i`) or is lost en route.

This produces a hard algebraic constraint: **at τ→∞, total at Z equals `N_A × Π_i p_i`**, where `N_A` is the observed cohort at A and `p_i` is the conditioned reach of edge i. Mass conservation holds at every intermediate node too: total at U at τ→∞ equals `N_A × Π_{j≤U} p_j`.

This is the load-bearing invariant for cohort. If the algebra breaks mass conservation at saturation, it is wrong.

### 2.2 Window: local-rate reproduction (NOT mass conservation)

In `window(X→Z)`, the cohort is defined at X on the query window. For multi-hop window, the implied cohort at every intermediate node is *synthetic*: it is whatever local-evidence cohort the edge's own window selects, not the propagation of X's cohort. Window's evidence at each edge is conditioned on that edge's local source-day cohort, independent of upstream.

Mass conservation in the cohort sense does not apply: the "cohort at Y" used to condition Y→Z's evidence is not the same set of users as the X-cohort propagated through X→Y. They are different physical populations. Asking whether mass propagates conservatively from X to Z through the chain is a category error — the propagation isn't tracking one cohort.

What window *does* satisfy is local-rate reproduction:

- At each edge, the saturation rate equals the locally-observed `k/n` for that edge's window evidence.
- The multi-hop rate at saturation equals the product of per-edge local rates: `p_window(X→Z) = Π_i p_i_local`.
- Per-edge timing CDFs reproduce locally observed shape.

The composition of locally-conditioned per-edge primitives gives the right saturation behaviour and the right composed timing CDF, even though "mass at Y" along the way is not a real physical quantity.

### 2.3 Why this distinction matters

The implementation must not assume mass conservation holds for window or local-rate reproduction holds for cohort. The two regimes are governed by different invariants, and the test set in §6 enforces each against its own regime.

The previous attempt's failure was not located at this boundary — it was further upstream, at the τ-axis convention — but conflating the two regimes is a known failure surface in the broader CF codebase (AP58 instance documented in the cf-defensive-coding audit) and the Phase 6 contract must keep them separate.

---

## 3. The four rules

These rules together fix the propagation algebra. Every subsequent statement in §4–§5 composes them.

### 3.1 τ-axis convention

**Right-edge cumulative.** For an edge U→V with source day s at U:

- `rate(s, age) = k_age(s) / n(s)`, where `k_age(s)` is cumulative conversions on or before *end of day* `s + age`, and `n(s)` is the U-cohort size on day s.
- `n(s)` carries no age index. The denominator is the cohort size, fixed once observed.
- `rate(s, 0)` includes same-day conversions (users who arrived at U on day s and converted to V on the same day).
- `rate(s, age)` is monotone non-decreasing in age and bounded by `p_edge`.

**Density is the right-edge difference.** For `age ≥ 1`, `density(s, age) = rate(s, age) − rate(s, age − 1)`. For `age = 0`, `density(s, 0) = rate(s, 0)`.

**Source-day axis is real.** Rates are indexed by source day s, not just by age. The age-only kernel `rate_aggregate(age) = Σ_s k_age(s) / Σ_s n(s)` is the stationarity-assuming degeneracy of the per-source-day kernel, valid when the edge's rate does not drift across s in the query window.

### 3.2 Arrival-map / propagation consistency

**Single source of truth.** For every edge U→V in the chain, the latency map used to weight evidence at U during primitive conditioning must equal the latency kernel used to propagate mass to U during composition. Both must come from one object: the composed root→U timing per draw.

An implementation that derives the arrival map from one surface (e.g. model prior, aggregate window estimate, fast approximation) and the propagation kernel from another (e.g. fitted posterior, locally observed) is **non-conforming**. It will not conserve mass at saturation, even when the two surfaces are numerically close in expectation, because per-draw consistency breaks first.

**Per-draw consistency.** The invariant must hold per draw, not per draw-set mean. The spine's per-draw operator chain evaluation guarantees this when arrival map and propagation come from the same `ComposedPrimitiveSpan.cdf_draws` object. Drawing one from a moment-matched approximation and one from the full draw set violates the invariant even though aggregate values agree.

**Consequence.** The conservation theorem in §2.1 follows from this rule plus the per-edge rate kernel's bounded-by-p property. Without arrival-map / propagation consistency, the chain `Σ_s density × rate → p × p` identity fails at the seam.

### 3.3 Unified push-forward

**One operator for all modes.** The push-forward evaluator that composes per-edge kernels and a seed mass to produce terminal mass is mode-blind. It does not branch on window vs cohort, single-hop vs multi-hop, identity carrier vs active carrier. The same evaluator handles every case.

**Mode encoding lives in primitive conditioning, not in the operator.** The window-vs-cohort distinction is encoded at evidence-binding time via the T1 (conditioning clock) parameter, which is selected per primitive based on the primitive's *role* in the request — not by a single global chain root spanning roles. Per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` Appendix A invariant 5 and as implemented in `model_span_spine.py`:

- **Window** (`window(X→Z)`): no carrier; each subject primitive's T1 is `source(prim)` — that primitive's own local clock. Evidence is weighted by an identity arrival map at the primitive's source. The composer's `window_identity=True` is the implementation expression of this choice.

- **Cohort active** (`cohort(A, X→Z)` with `A ≠ X`): the request has carrier primitives along A → X and subject primitives along X → Z. **Each carrier primitive's T1 is `A`** (the carrier role's chain root); **each subject primitive's T1 is `X`** (the subject role's chain root). Evidence at carrier primitives is weighted by the A-rooted arrival map; evidence at subject primitives is weighted by the X-rooted arrival map. The X-day distribution that roots the subject map is itself the carrier's propagated reach to X — that is the two-clocks structure invariant 5 names.

- **Cohort identity** (`cohort(A, X→Z)` with `A = X`): the carrier composes to the zero-edge identity. Subject primitives' T1 is the subject role's chain root `X`, which equals A. Evidence weighting reduces to an identity arrival map at X.

In every case, T1 for a primitive is the chain root of **that primitive's role**, never a global chain root spanning roles. Carrier and subject are separate algebraic roles with separate roots; "the chain root" without a role qualifier is ambiguous. Window mode has only the subject role and uses per-primitive local-clock identity weighting.

This produces *different conditioned primitives at the same edge* depending on the request's mode and the primitive's role. The composition is identical for all cases. The mode-and-role distinction is upstream of the composer, not inside it.

**Source-day cardinality varies by case, not the operator shape.** The carrier in cohort mode has one source day per anchor (anchor day itself). The first hop of window or A=X cohort similarly has one source day. Active cohort's subject and any second-or-later hop have many source days. The kernel shape is identical in every case — `rate(source_day, age)` — and the push-forward sums over whatever source-day set is supplied. Degeneracy by data, not by branch.

### 3.4 Cumulative vs incremental boundary

**Internal mass propagation uses Δk; terminal readout uses k.** Every edge in the DAG propagates per-day densities; the cumulative-by-τ projection happens once, at the chart readout from the terminal node's density:

- At every edge `(U, V)` in the DAG (internal or terminal to a leaf), the per-source-day contribution flows forward as a per-day arrival increment — `Δk_UV(s, age) = k_UV(s, age) − k_UV(s, age − 1)` for `age ≥ 1`, `Δk_UV(s, 0) = k_UV(s, 0)`. The Δk quantity is the right-edge density. Edge convolution composes densities into the destination node's per-day arrival surface (summed over all incoming concrete edges; see §4.3).

- The chart row's cumulative `k` count is `np.cumsum` of the terminal node's per-day arrival density. The cumulative is a *projection*, not a property of any one edge; nothing along the way carries cumulative `k`.

Mixing the two quantities is the most likely τ-axis failure mode:

- Feeding cumulative `k` forward into a downstream hop's mass surface double-counts: each day's contribution would include mass that already arrived on earlier days.
- A one-day misalignment of the increment boundary (left-edge vs right-edge in the Δk definition, off-by-one in the indexing) produces the rising-edge-deficit-with-asymptotic-recovery signature documented in `multi-hop-rate-composition-y-deficit-investigation.md` — the previous attempt's exact failure mode.

The Δk vs k distinction is **not** a τ-axis convention difference (that is §3.1's concern); it is a structural property of the DAG DP: every edge convolves densities into per-day node arrival surfaces, and exactly one cumulative sum happens at projection. There is no "terminal edge" special case — the terminal is a *node*, and the cumulative is its readout projection.

---

## 4. The evidence-side surfaces

### 4.1 Per-edge cohort-conditioned rate kernel

The unit consumed by the push-forward is one rate kernel per edge in the chain, indexed by source day and age. For each edge U→V:

- **Domain**: source day s spans the support of the arrival map at U (the days during which the upstream chain's propagated mass actually arrives at U). Age spans 0 to the horizon.
- **Range**: `[0, p_edge]`, monotone non-decreasing in age, no per-draw or per-source-day boundary inversion.
- **Construction**: from snapshot evidence at the edge, filtered/weighted by the arrival map at U (per §3.2). The weighting selects rows whose user-arrival-at-U corresponds to the chain-root cohort's wavefront. The fitted CDF is the cohort-conditioned posterior. Per-source-day if data supports it; age-only as the stationarity-degenerate fallback.
- **Covered-zero vs absent-support distinction**: a source day with observed `n(s) > 0` and `k_age(s) = 0` is *covered-zero* — the rate is genuinely 0 there. A source day for which no evidence row exists is *absent-support* — the rate is undefined. These two cases must not be conflated in the kernel: covered-zero contributes 0 to the propagation; absent-support is not in the kernel's domain. The implementation must distinguish.

### 4.2 Seed mass

The seed mass is the observed cohort at the chain root, indexed by anchor day and source day.

- For `cohort(A, X→Z)`: seed at A, one source day per anchor (anchor day itself), count = `N_A(anchor_day)`.
- For `cohort(A, X→Z)` with A == X: seed at X, identical structure to above (carrier is identity).
- For `window(X→Z)`: seed at X, one source day per anchor (anchor day itself), count = `N_X(anchor_day)` from the local X-window observation.

The seed's source-day axis is degenerate (single value per anchor) at the chain root. The source-day axis becomes non-trivial only after the first hop's propagation smears mass across multiple intermediate-node source days.

### 4.3 The unified mass-propagation formula

The push-forward computes mass at each node as a per-(anchor, day) surface, then integrates the terminal edge's cumulative k for the chart row.

**Seed**:

```
m_root(anchor = C) = N_C
```

The cohort size at the chain root, indexed by anchor day. One source day (anchor itself) at the root.

**Internal nodes** — per-day arrival surface at each downstream node V with incoming edges `inflows(V)`:

```
m_V(t_V) = Σ_{(U, V) ∈ inflows(V)}  Σ_{s_U}  m_U(s_U) × Δk_UV(s_U, t_V − s_U) / n_UV(s_U)
```

Mass at V on day `t_V` is the sum over all incoming edges of each edge's convolution from its upstream source. For each incoming edge (U, V), the contribution is the per-source-day convolution: our cohort's mass at U on day `s_U`, weighted by:

- the relative-mass ratio `m_U(s_U) / n_UV(s_U)` — our cohort's mass at U on that source day, divided by the snapshot bucket's observed denominator for the U → V edge;
- the per-day arrival increment `Δk_UV(s_U, t_V − s_U)` — the right-edge density at edge-local age `t_V − s_U`.

`Δk` is used at every internal node per §3.4. The number of terms in the outer sum is determined by the topology, not by a case distinction: a node with one incoming edge has one term, a node with three incoming edges has three. Natural degeneracy by data — no separate handling for serial vs branching shapes.

**Terminal readout** — cumulative k at the chart row. For the terminal node T with incoming edges `inflows(T)`:

```
K_terminal(chart_τ) = Σ_{(U, T) ∈ inflows(T)}  Σ_{s_U}  m_U(s_U) × k_UT(s_U, chart_τ − (s_U − C)) / n_UT(s_U)
```

Each incoming edge to the terminal contributes its cumulative `k`, evaluated at edge-local age `chart_τ − (s_U − C)`. Summed across upstream source days for each edge, then across all incoming edges to T.

The per-edge ratio `m_U(s) / n_UV(s)` is the load-bearing factor that distinguishes cohort and window. In cohort mode (with proper clocking) it is identically 1; in window mode it is generally not.

### 4.4 The cohort cancellation

Under proper evidence clocking (rule §3.2 applied to cohort mode), the snapshot bucket at every edge satisfies `n_UV(s) = m_U(s)` — the bucket's observed denominator equals our cohort's propagated mass at U on that source day, **by construction** of the latency-weighted row selection. Equivalent statement: the rows admitted into the bucket are exactly the rows whose user-at-U arrival corresponds to our cohort's wavefront, and the bucket's `n` is the count of those rows.

Every per-edge ratio collapses to 1. Substituting:

```
m_V(t_V)              = Σ_{s_U}  Δk_UV(s_U, t_V − s_U)                                  (internal mass = sum of Δk's)

K_terminal(chart_τ)   = Σ_{s_last}  k_terminal(s_last, chart_τ − (s_last − C))          (terminal k = sum of cumulative k's)
```

The chain reduces to: **at every internal hop, read the upstream edge's Δk directly to seed the next node's mass surface; at the terminal, sum the terminal edge's cumulative k across the cohort-tagged source-day buckets.** No per-edge ratio arithmetic; the cancellation does it.

This is the central algebraic result of the contract. It is not a special case or an optimisation. It is the consequence of clocking consistency: when the bucket's denominator equals our propagated mass at every edge, the ratio factor disappears and only the edge's observed counts (Δk internally, k at the terminal) carry through.

The intuition: cohort identity is preserved by **which rows are selected** at each edge, not by **how the row values are combined**. The latency map's job is the row selection; the algebra's job is then trivial — just read the relevant counts in the right form (Δk internally, k at the terminal) and sum.

### 4.5 Window non-cancellation

In window mode, the bucket's `n_UV(s)` is the edge's local-window denominator at source day `s` — the count of users observed at U on day `s` in the snapshot's local window for that edge. This is **unrelated to our cohort's propagated mass** at U on day s, because window's evidence at each edge is locally anchored, not chain-rooted.

Concretely: `n_UV(s)` is the snapshot's observed n at the U → V edge for users at U on day s in the snapshot's natural framing. `m_U(s)` is `N × density_through_upstream_chain(s)` — what we project to be at U on day s given our cohort propagated from the chain root.

These are different counts. The ratio `m_U(s) / n_UV(s)` is generally not 1; the chain product retains the ratio through every hop:

```
K_terminal(chart_τ) = N × convolution_of_densities_with_terminal_rate_curve
                    (computed via the full per-hop ratio arithmetic in §4.3)
```

No internal cancellation. The terminal k is computed by carrying densities through the chain and integrating the terminal edge's locally-observed rate curve at the appropriate edge-local age.

Equivalent statement at saturation: `K_terminal(∞) = N × Π_i p_i_local`, where each `p_i_local` is the saturation rate read from edge i's local-window evidence. Under stationarity this numerically equals the cohort answer; under non-stationarity it diverges.

### 4.6 Aggregation and the seam

The reducer aggregates `K_terminal(anchor_day, chart_τ)` across anchors to produce per-τ chart values. The per-(anchor, τ) surfaces are also exposed for the selected A-clock evidence cells (the seam invariant — both row builder and reducer read the same per-(anchor, τ) surface, per `cohort-1apr-falling-k-problem-statement.md §A.4`).

Under cohort cancellation, the per-(anchor, τ) surface is the per-anchor sum of terminal `k_terminal(s_last, chart_τ − offset)` — a direct read of the terminal edge's evidence under cohort-aware bucketing. No intermediate object materialises; the seam reads the same surface both ways by construction.

### 4.7 Support states — pointer at the existing design doc

The three-state load-bearing trichotomy of evidence cells is already pinned in [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) §3.1: **Absent**, **Covered with zero mass**, **Covered with positive mass**. Atom 1 of that doc's plan landed in commit `4f5c96c2` (§5.1) and includes the data-layer contract (§3.2–3.4) and the visual semantics (§4) — alpha-on-blobs via `point_opacity = coverage × fadeOpacity` (§4.2), implemented at [cohortComparisonBuilders.ts:702-711](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L702-L711).

Phase 6 does not redefine those states. It uses them as the per-edge atomic input to the chain-level propagation algebra in §4.8. The terminology below maps to the design doc's names directly:

- **Absent** (design doc §3.1) ↔ §4.1's "absent-support" ↔ the masked-kernel `𝟙_observed = 0` in §4.8.
- **Covered with zero mass** ↔ §4.1's "covered-zero" ↔ the masked-kernel `𝟙_observed = 1` with `Δcdf = 0` in §4.8.
- **Covered with positive mass** ↔ §4.1's "observed-positive" ↔ the masked-kernel `𝟙_observed = 1` with `Δcdf > 0` in §4.8.

**What Phase 6 adds (and only this).** §4.8 specifies how these per-edge states *propagate through a multi-hop chain* via the masked-kernel parallel stream — i.e. how a chain-cell at terminal `(a, τ)` inherits a coverage value derived from the per-edge states along every contributing path. The design doc above pins per-edge state, per-row coverage, and visual semantics at the chart; §4.8 fills the gap of chain composition that lies between them.

**Freshness, emission policy, dashing thresholds, alpha-mapping function** — all pinned by the design doc §4 and the implementation it cites. Phase 6 inherits them unchanged; see §5.4 for the pointer.

Coverage as the continuous projection of the discrete support state is defined in the design doc §2.2–2.3 (per-role and per-row). Under E mode it drives evidence-blob alpha per design doc §4.2 (`point_opacity = coverage × fadeOpacity`, implemented at [cohortComparisonBuilders.ts:702-711](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L702-L711)); under E+F it drives the BE-side `rate_blended` carry-forward and acts as an optional annotation overlay.

### 4.8 Coverage as a masked-kernel parallel stream

Section 4.7 specifies the discrete support state (observed-positive / covered-zero / absent per-edge; supported / partly-supported / unsupported per-chain-cell). Section 5.4 specifies coverage as the continuous projection of that state, and the linear blend that consumes coverage at display time. This section pins how the chain-level support state is *computed* from the per-edge state — using the same convolution that propagates mass, with a masked kernel.

The principle: **support is propagated through the chain by the same algebra as value, with the per-edge kernel replaced by an observation-masked version of itself.** Two parallel streams, one convolution operator, one ratio at projection. No bespoke coverage algorithm.

**The two-stream kernel construction.** For every edge U → V in the chain, define two kernels:

- **Value kernel**:

  ```
  kernel_UV^value(s, age) = p_UV × Δcdf_UV(s, age)
  ```

  The per-(source-day, age) mass-transfer kernel under proper T1 conditioning (per §3.3 and §4.3, with the cohort cancellation embedded structurally per §4.4).

- **Support kernel**:

  ```
  kernel_UV^support(s, age) = kernel_UV^value(s, age) × 𝟙_observed^UV(s, age)
  ```

  The value kernel multiplied by a binary per-cell mask. `𝟙_observed^UV(s, age) = 1` iff the (UV, s, age) per-edge cell is observed-positive or covered-zero (per §4.7); `0` iff the cell is absent.

**Propagation.** Both streams run through the same chain convolution. At the chain root, the seed carries the cohort:

```
value_seed(a, anchor_day(a))   = N_A(a)
support_seed(a, anchor_day(a)) = N_A(a)
```

Seed support equals seed value: the cohort itself *is* observation at the chain root — it is the observed cohort size on the anchor day. Every downstream node propagates both streams by the same push-forward:

```
value_V(t)   = Σ_s  value_U(s)   × kernel_UV^value(s, t − s)
support_V(t) = Σ_s  support_U(s) × kernel_UV^support(s, t − s)
```

The two streams are independent — they do not interact during propagation. Each hop applies its own value and support kernels via the same convolution; the streams diverge wherever the kernel mask zeros out a contribution.

**Coverage at projection.** After the chain composes both ledgers to the terminal, projection by `(anchor_day, τ)` and a cumulative sum gives two per-cell quantities; their ratio is coverage:

```
cumulative_value(a, τ)   = Σ_{t ≤ anchor_day(a) + τ}  value_terminal(a, t)
cumulative_support(a, τ) = Σ_{t ≤ anchor_day(a) + τ}  support_terminal(a, t)

coverage(a, τ) = cumulative_support(a, τ) / cumulative_value(a, τ)
```

Genuine 0/0 case: when no mass has reached `(a, τ)` (the wavefront has not arrived), coverage is undefined and emits 0; per design doc §4.6 the cohort's evidence marker at this τ is drawn with alpha = 0 (effectively invisible) and no line point is rendered. Same div-guard pattern as the mass algebra's small-τ carrier guard.

**The §4.7 trichotomy emerges from the ratio.**

- `coverage(a, τ) = 1` ⇔ every (hop, source-day, age) cell that contributes to the wavefront at (a, τ) is observed → **supported**.
- `coverage(a, τ) = 0` ⇔ every contributing cell is absent → **unsupported**.
- `coverage(a, τ) ∈ (0, 1)` ⇔ mixed; the value is the **mass-weighted fraction** of the wavefront flowing through observation-backed cells → **partly-supported**.

No wavefront enumeration code, no per-cell classifier, no per-hop combiner logic. The mass-weighting §4.7 requires (a partly-supported cell weighted by how much of the propagated mass came through observed cells) emerges from convolution: the support kernel zeros out absent cells' contributions, so a wavefront path component routed through an absent cell contributes to value but not to support, and the ratio captures the mass-weighted observed-fraction exactly.

**Why convolution composes coverage correctly.** Consider a wavefront component at terminal cell (a, τ) routed through one specific path `(hop_1, s_1, age_1), (hop_2, s_2, age_2), ..., (hop_n, s_n, age_n)`:

- contributes to `cumulative_value(a, τ)` proportionally to `Π_i Δcdf_{hop_i}(s_i, age_i)`;
- contributes to `cumulative_support(a, τ)` proportionally to the same product **multiplied by** `Π_i 𝟙_observed^{hop_i}(s_i, age_i)`.

The path-product mask is 1 iff every hop's cell on this path is observed; 0 iff any one hop's cell is absent. Convolution sums over all paths weighted by their mass; the support stream sums only those paths whose every hop is observed. The ratio is therefore the mass-weighted "fully-observed-path fraction" through the chain — exactly the §4.7 chain-level wavefront support, by construction.

**Composition with cohort cancellation.** §4.4 reduces the value algebra to sums of Δk through the chain because `p × Δcdf` under T1 = role-root *is* the cancelled form. The support stream inherits this: the masked kernel is also of the cancelled form (multiplied by a 0/1 mask), and convolution composes coverage through the chain without ever materialising a per-hop coverage ratio. Coverage is computed *once* at projection from two cumulatives, never per-hop.

**Composition with window non-cancellation.** Window mode uses the same kernel structure with T1 = source(prim) yielding a locally-conditioned kernel. The support stream uses the same masked-kernel construction at each edge. Coverage at projection is computed from the two cumulatives. The §3.3 mode-blindness applies to coverage as it applies to value: one algebra, one engine, mode encoded upstream at primitive conditioning.

**Freshness as a third parallel stream (optional, same shape).** Freshness — whether a cell's observation was retrieved within `asat` rather than forward-filled — is orthogonal to support (§4.7) but algebraically identical in shape. Construct a third per-edge kernel:

```
kernel_UV^fresh(s, age) = kernel_UV^value(s, age) × 𝟙_fresh^UV(s, age)
```

with `𝟙_fresh^UV(s, age) = 1` iff the (UV, s, age) cell is observed *and* retrieved fresh, 0 otherwise. Run the same chain convolution. At projection, the freshness ratio is either:

- `freshness(a, τ) = cumulative_fresh(a, τ) / cumulative_value(a, τ)` — fraction of total mass that is both observed and fresh, or
- `fresh_given_observed(a, τ) = cumulative_fresh(a, τ) / cumulative_support(a, τ)` — fraction of observed mass that is fresh.

Same algebra, additional masked stream per orthogonal axis. Cost: one extra kernel per edge, one extra convolution per hop. Benefit: a per-cell freshness map computed identically to coverage. §5.4 treats freshness as an axis orthogonal to coverage; whether Phase 7 implements freshness as a runtime parallel stream or computes it from snapshot retrieval metadata at display time is a policy choice the contract admits in either form. The algebra above pins the runtime-stream path if it is chosen.

**Covered-zero vs absent — resolved by the parallel exposure stream.** The masked-kernel value-stream above carries *conversion-mass support*: how much wavefront mass flowed through observed cells. It distinguishes the three per-cell states correctly when a path has positive value:

- **Observed-positive** `(UV, s, age)`: `Δcdf_UV > 0`, mask = 1. Positive mass to value; same positive mass to support.
- **Covered-zero**: `Δcdf_UV = 0` because evidence says zero, mask = 1. Contributes 0 to value and 0 to support — a 0-mass path; doesn't enter the value wavefront.
- **Absent**: `Δcdf_UV` model-imputed, mask = 0. Imputed mass to value; 0 to support. Path enters the wavefront with imputed mass; the support stream zeros its contribution. Ratio drops.

The value-weighted formulation alone cannot distinguish covered-zero from absent at terminal cells where `cumulative_value = 0` (the 0/0 case is epistemically ambiguous between "we know zero everywhere" and "we know nothing"). The engine therefore carries a **third parallel stream** — the **exposure stream** — propagated by the same DAG DP with a different per-edge kernel:

```
kernel_UV^value(s, age)     = p_UV × Δcdf_UV(s, age)
kernel_UV^support(s, age)   = kernel_UV^value(s, age) × 𝟙_observed^UV(s, age)
kernel_UV^exposure(s, age)  = Δcdf_UV(s, age)        × 𝟙_observed^UV(s, age)
```

The exposure kernel is the unit-reach PMF (the `Δcdf` shape **without** the `p` scaling) multiplied by the observation mask. It carries "did the wavefront reach observed cells" independent of conversion value. Same `_run_dp_density_trace`, same topology walk, third stream.

With three streams, all five §4.8 corner cases at terminal are distinguishable:

- `value > 0 ∧ support > 0`: paths through observed cells exist, conversion mass arrived (the typical positive case).
- `value > 0 ∧ support = 0 ∧ exposure > 0`: paths reached observed cells but every hop was covered-zero — "we observed zero everywhere".
- `value > 0 ∧ exposure = 0`: paths reached terminal only via absent cells (model imputation) — "we don't know".
- `value = 0 ∧ exposure > 0`: no conversion mass arrived but observation reached the upstream — "we know nothing arrived yet".
- `value = 0 ∧ exposure = 0`: no observation, no mass — "we know nothing".

The exposure stream is exposed end-to-end in the engine: `kernel^exposure` constructed in `_compose_draws` per edge ([subject_span_composer.py:475](graph-editor/lib/runner/subject_span_composer.py#L475)); propagated through `_run_dp_density_trace` ([timing_span.py:467-498](graph-editor/lib/runner/timing_span.py#L467-L498)); retained on `ComposedPrimitiveSpan.node_exposure_draws` ([subject_span_composer.py:178](graph-editor/lib/runner/subject_span_composer.py#L178)); read via `read_node_exposure_draws(span, node_id)` ([model_span_spine.py:635-641](graph-editor/lib/runner/model_span_spine.py#L635-L641)); projected by `project_cumulative_exposure_draws` ([model_span_spine.py:686-692](graph-editor/lib/runner/model_span_spine.py#L686-L692)).

The covered-zero/absent distinction at the per-edge level remains a load-bearing calibration: the implementation must compute `mask = 1` iff the row exists in the snapshot at the relevant retrieval window, regardless of `k = 0` vs `k > 0`; `mask = 0` iff the row does not exist. Conflating the two upstream would set the mask incorrectly and break the chain-composition algebra at every hop, not just at terminal-zero cells.

**Coverage is contract-discharged.** Three layers, three pinning sources:

- **Per-edge three-state trichotomy and visual semantics** — pinned by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) §3.1 and §4. Atom 1 landed.
- **Chain composition (this section §4.8)** — the masked-kernel parallel stream and `cumulative_support / cumulative_value` ratio. The new contribution.
- **Display consumption** — pinned by the design doc §4 and the existing FE implementation cited from §5.4.

Phase 7's algebra work has three parts, none free: (a) plumb the per-cell observation mask from evidence through `prepare_primitive` into the per-edge primitive (the mask does not exist in the kernel pipeline today; latent support is a placeholder `np.ones_like(increments)` at [span_operator_supply.py:57](graph-editor/lib/runner/span_operator_supply.py#L57)); (b) change the support-kernel construction to `value × mask`; (c) compute the projection ratio. The convolution machinery and two-stream operator shape are already in place; the load-bearing missing piece is (a). No new "coverage algorithm" to design; the algorithm is "the value algebra with a masked kernel", but the mask itself is upstream work.

---

## 5. How this maps to the new engine core

This section is the load-bearing one. The Phase 6 risk is that the algebra above sounds like new infrastructure when most of it is already implemented in `model_span_spine.py`. The mapping:

### 5.1 What the spine already does

The Phase 5.5 spine implements the propagation algebra in mode-blind form. Specifically:

- **Per-edge primitive conditioning** (in `prepare_primitive`) builds the conditioned per-edge primitive. The T1 parameter is selected per primitive by mode and role:
  - **Carrier primitives** (active cohort A → X): conditioned against the A-rooted carrier arrival map. T1 = A.
  - **Subject primitives, cohort mode**: conditioned against the X-rooted subject arrival map (whose X-day root weights are themselves the carrier's reach to X for active cohort, or identity for `A = X`). T1 = X. Implementation flag: `window_identity=False`.
  - **Subject primitives, window mode**: conditioned against a local-clock identity arrival map at the primitive's source. T1 = `source(prim)`. Implementation flag: `window_identity=True`.

  The carrier and subject arrival maps are constructed upstream of `prepare_primitive` and passed in as distinct objects (`carrier_arrival_map`, `subject_arrival_map` in `resolve_request_spans`). They are not derived from one another at the primitive-conditioning step; their roots are determined by the role they serve. This is rule §3.3's mode-and-role encoding, already in place in the spine.

- **Composition** (via `compose_primitive_span`) produces the per-draw composed CDF for the whole carrier-or-subject chain. The output `ComposedPrimitiveSpan.cdf_draws` is the multi-hop propagation kernel for that role.

- **Evaluation** (via `evaluate_with_operators`) takes a per-draw operator chain plus a `RuntimeRootMass` and produces per-(draw, cohort_id, τ) terminal values. The `RuntimeRootMass` is already shaped for the use case: cohort_ids identify cohorts, root_days and root_counts give per-cohort source-day mass.

- **Arrival map / propagation consistency** (§3.2) holds by construction in the spine: the arrival map at U is built from the same composed root→U timing object that the composer will use to propagate. They share one source of truth per draw.

The model overlay's existing surface (`evaluate_model_rate_draws`) uses this machinery with a degenerate root mass:

```
RuntimeRootMass(
    cohort_ids = ("model-curve",),
    root_days  = [0],
    root_counts= [1.0],
)
```

One synthetic "cohort", one day, count 1. The model overlay computes per-draw rate by evaluating numerator (full chain) and denominator (carrier only) against this impulse.

### 5.1.5 Term-by-term mapping into the engine

The §4 algebra is realised by the DAG forward DP in `timing_span._run_dp_density_trace` and the per-node / per-edge surfaces retained on `ComposedPrimitiveSpan`. Each §4 symbol maps to a concrete engine object:

| §4 symbol / rule | Engine object | Location |
|---|---|---|
| `m_root(C) = N_C` | `RuntimeRootMass(cohort_ids, root_days, root_counts, root_support)`; chain root carries δ(0) in `node_density_draws[root_node_id]` for the model overlay path | [model_span_spine.py:192-198](graph-editor/lib/runner/model_span_spine.py#L192-L198), [subject_span_composer.py:225-252](graph-editor/lib/runner/subject_span_composer.py#L225-L252) |
| `m_U(s)` at any DAG node U | `read_node_mass_draws(span, U)` → `node_density_draws[U]` of shape `(S, T)` keyed by node id (NOT by chain-position index) | [model_span_spine.py:613-623](graph-editor/lib/runner/model_span_spine.py#L613-L623), [subject_span_composer.py:174](graph-editor/lib/runner/subject_span_composer.py#L174) |
| Per-edge value kernel `p × Δk_UV(s, age) / n_UV(s)` (cohort case: ratio structurally 1; window case: structurally local) | `value_kernel = exposure_shape × p_draws` constructed per concrete edge in `_compose_draws`; coincident sibling edges keyed by `edge_key` | [subject_span_composer.py:468](graph-editor/lib/runner/subject_span_composer.py#L468) |
| Push-forward `m_V(t) = Σ_{(U,V) ∈ inflows(V)} Σ_s m_U(s) × kernel_UV(s, t−s)` | `_run_dp_density_trace` walks `topo.topo_order` and sums `np.convolve(node_density[U], kernel[e])` into `node_density[V]` for every `e ∈ incoming_concrete_edges[V]` | [timing_span.py:467-498](graph-editor/lib/runner/timing_span.py#L467-L498) |
| Δk-vs-k boundary (§3.4) | Internal hops carry per-day density (`node_density_draws[U]` is a density, not cumulative); terminal cumulative is `np.cumsum` at projection time | [timing_span.py:460-461](graph-editor/lib/runner/timing_span.py#L460-L461), [model_span_spine.py:677-678](graph-editor/lib/runner/model_span_spine.py#L677-L678) |
| Cohort cancellation (§4.4) | T1 = role-root in `prepare_primitive` produces the kernel value already as the cancelled form. `n_UV(s)` does not appear anywhere in the DP | structural — `prepare_primitive` upstream + absence of any divide-by-n in `_run_dp_density_trace` |
| Window non-cancellation (§4.5) | Identical DP; T1 = source(prim) yields locally-conditioned per-edge kernels. Engine is mode-blind; DAG composition produces §4.5 form by construction | structural — `prepare_primitive` upstream |
| Per-edge contribution (DAG sibling-aware) | `read_edge_contribution_draws(span, edge_key)` → `edge_contribution_draws[edge_key]`. Coincident siblings have distinct entries | [model_span_spine.py:644-649](graph-editor/lib/runner/model_span_spine.py#L644-L649), [span_kernel.py:55-64](graph-editor/lib/runner/span_kernel.py#L55-L64) |
| Support stream (§4.8 mass-weighted) | Parallel `node_support_draws[U]` populated by a second DP pass with kernel `value_kernel × mask`; read via `read_node_support_draws` | [subject_span_composer.py:531](graph-editor/lib/runner/subject_span_composer.py#L531), [model_span_spine.py:626-632](graph-editor/lib/runner/model_span_spine.py#L626-L632) |
| Exposure stream (§4.8 value-independent) | Parallel `node_exposure_draws[U]` populated by a third DP pass with kernel `exposure_shape × mask`; read via `read_node_exposure_draws`. Preserves covered-zero / absent at terminal-zero cells | [subject_span_composer.py:532](graph-editor/lib/runner/subject_span_composer.py#L532), [model_span_spine.py:635-641](graph-editor/lib/runner/model_span_spine.py#L635-L641) |
| `coverage(a, τ)` (§4.8 ratio) | `project_coverage_draws(value, support)` → `cumsum(support) / cumsum(value)` with 0/0 → 0 policy | [model_span_spine.py:666-683](graph-editor/lib/runner/model_span_spine.py#L666-L683) |
| Cumulative exposure (the 0/0 discriminator) | `project_cumulative_exposure_draws(exposure)` → `cumsum(exposure)`. Positive whenever the wavefront reached any observed cell, regardless of value | [model_span_spine.py:686-692](graph-editor/lib/runner/model_span_spine.py#L686-L692) |
| Active-cohort handoff (carrier output at X → subject seed) | `seed_subject_from_carrier(carrier, x_node_id, anchor_days, anchor_counts, days)` returns three seed surfaces (value, support, exposure) of shape `(S, days)` | [model_span_spine.py:695-737](graph-editor/lib/runner/model_span_spine.py#L695-L737) |

Three load-bearing facts the mapping pins, for any implementer who reads §4 and then opens the engine:

1. **Cohort cancellation is structural, not arithmetic.** Nowhere in the engine is `n_UV(s)` materialised; nowhere is the ratio `m_U(s) / n_UV(s)` computed. `prepare_primitive` constructs the per-edge kernel from the conditioned CDF, which under T1 = role-root already represents the cancelled form. An implementer who writes `m / n` is doing it wrong; the cancellation lives entirely in the kernel value built upstream.

2. **The Δk-vs-k boundary is structural.** The DAG DP carries per-node densities (not cumulatives) through every hop and cumulates once at projection. §3.4's boundary is realised by *where* in the pipeline the cumulative sum happens, not by per-hop conditional logic.

3. **Three parallel streams resolve the §4.8 contract.** The composer runs `_run_dp_density_trace` three times per draw — once on `value_kernel`, once on `support_kernel = value × mask`, once on `exposure_kernel = exposure_shape × mask`. The three streams together distinguish all five §4.8 corner cases at terminal: `value > 0 ∧ support > 0` (mass arrived through observed cells); `value > 0 ∧ support = 0 ∧ exposure > 0` (covered-zero everywhere); `value > 0 ∧ exposure = 0` (model imputation only); `value = 0 ∧ exposure > 0` (we know nothing arrived); `value = 0 ∧ exposure = 0` (we know nothing). The exposure stream is what carries the §4.7 "we observed zero" vs "we don't know" distinction at terminal-zero cells. Today the mask is hardcoded `np.ones((S, T))` at [subject_span_composer.py:473](graph-editor/lib/runner/subject_span_composer.py#L473) (so support and exposure collapse to value-weighted and unit-reach-PMF respectively); Phase 7 plumbs the real per-cell mask from per-row evidence state through `prepare_primitive` into the kernel construction, and the streams begin to diverge as the algebra prescribes.

### 5.2 What the reducer needs (Phase 7's actual scope)

Per §5.1.5, the engine now realises §3–§4 end-to-end via the DAG DP and three parallel streams on `ComposedPrimitiveSpan`. Phase 7's remaining scope is bounded:

**A. Per-cohort active handoff** — already implemented as `seed_subject_from_carrier(carrier, x_node_id, anchor_days, anchor_counts, days)` at [model_span_spine.py:695-737](graph-editor/lib/runner/model_span_spine.py#L695-L737). For each anchor `c` with observed cohort count `N_c`, shifts the carrier's per-(draw, day-since-A) arrival density at X by `c`, scales by `N_c`, and sums across anchors. Returns three seed surfaces (value, support, exposure) of shape `(S, days)` — the (draw, day-at-X) seed the subject DAG consumes.

**B. Top-level evidence-reducer wrapper** — *the Phase 7 glue still to be written*. It composes:
1. Resolve carrier and subject spans against the request (`resolve_request_spans`).
2. Hand off via `seed_subject_from_carrier`.
3. Read the subject DAG's per-node arrival surfaces (`read_node_mass_draws`, `read_node_support_draws`, `read_node_exposure_draws`) against the per-cohort seed, producing per-(draw, anchor, node, τ) value / support / exposure.
4. Project to coverage via `project_coverage_draws`; project cumulative exposure via `project_cumulative_exposure_draws`.
5. Reduce across anchors at each τ to produce the chart-row scalars.

In identity-carrier mode (window or cohort A=X), step 2 degenerates: the carrier's identity span carries δ(0) at the root, so `seed_subject_from_carrier` reduces to a per-anchor-day delta into the subject's seed surface — same code path, no branch.

**C. Real per-cell observation mask** — the composer's three-stream construction currently uses `mask = np.ones((S, T))` at [subject_span_composer.py:473](graph-editor/lib/runner/subject_span_composer.py#L473) with an explicit "Phase 7 plumbs real masks here" comment. Real per-cell masks must be threaded from the per-row evidence state through `prepare_primitive` into a per-edge mask surface that the composer consumes. Under unit mask, the support and exposure streams collapse to value-weighted and unit-reach-PMF respectively — algebraically consistent but the §4.8 covered-zero / absent discrimination only surfaces once real masks land.

**D. Legacy cutover** — the bespoke Pop C / Pop D reconstruction at [cohort_forecast_v3.py:4908-5256](graph-editor/lib/runner/cohort_forecast_v3.py#L4908-L5256) currently drives the conditioned E+F trajectory. Phase 7 replaces it with the wrapper from (B); the bespoke arithmetic deletes.

**What is unchanged.** The DAG forward DP (`_run_dp_density_trace`), the per-edge primitive conditioning (`prepare_primitive`, already role-parameterised per §3.3), the composer's topology walk (`compose_primitive_span`, `compose_timing_span_from_densities`), the F-mode model-overlay path (`evaluate_model_rate_draws`), and the algebraic invariants of §3–§4 are reused without modification.

### 5.3 What the existing prefix objects become

The four reducer prefix objects (`_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `SelectedAClockEvidence`) currently carry bespoke arithmetic for slices of the same physical algebra in `cohort_forecast_v3.py`. After Phase 7 migration they become **node-id-keyed reads on the per-draw `ComposedPrimitiveSpan` surfaces** plus the per-anchor seed handoff. No bespoke arithmetic; no per-edge ratio computation; no Δk derivation; no chain-position indexing.

The reads use the helpers exposed in §5.1.5. For a request with composed `carrier` (root A → X) and composed `subject` (X → terminal), and a per-cohort seed produced by `seed_subject_from_carrier`:

- `_SelectedSourceDayMass` at any node U — `read_node_mass_draws(span, U)` against the relevant span (carrier for U on A→...→X; subject for U on X→...→terminal). At the chain root A the carrier's `node_density_draws[A]` carries δ(0); on the carrier path A → ... → X it holds carrier-prefix propagation; on the subject path X → ... → terminal it holds the propagation of the carrier-handoff seed through the subject DAG. **The lookup is keyed by node id, not by chain-position index** — arbitrary DAG topology, any node accessible directly.

- `_CarrierOnlyDenominatorPrefix` — `read_node_mass_draws(carrier, x_node_id)`, the carrier's per-(draw, τ) arrival density at X. The cumulative-by-τ projection is `np.cumsum` along the τ axis.

- `_RateAttributedSubjectPrefix` at any subject node V — the per-(anchor, source-day-at-V) value surface obtained by convolving the per-cohort subject seed (from `seed_subject_from_carrier`) against `read_node_mass_draws(subject, V)`. The terminal layer's cumulative is `evaluate_request_cdf_draws` shape or directly `cumsum` along τ; intermediate-node reads keyed by V's node id work for **arbitrary subject topology** including parallel paths and joins, because the DAG DP populates `node_density_draws[V]` for every on-path V.

- `SelectedAClockEvidence.aggregate_by_tau` — the per-anchor terminal-node cumulative aggregated across anchor cohort ids, equivalent to `np.cumsum(read_node_mass_draws(subject, terminal_node_id), axis=-1)` against the propagated seed. The seam invariant (`cohort-1apr-falling-k-problem-statement.md §A.4`) holds because both row builder and selected-evidence consumer read the same per-node arrival surfaces.

Support and exposure propagate through the same node-id-keyed lookup via `read_node_support_draws(span, U)` and `read_node_exposure_draws(span, U)`. Coverage at any node is `project_coverage_draws(value, support)`; cumulative exposure at any node is `project_cumulative_exposure_draws(exposure)`. Both helpers operate at the spine level on `(S, T)` arrays — no special-casing per node type.

Coincident sibling edges (two parallel edges between the same endpoints) are addressable individually via `read_edge_contribution_draws(span, edge_key)` and its support / exposure counterparts; the composer assigns each concrete edge a stable `edge_key` ([span_kernel.py:55-64](graph-editor/lib/runner/span_kernel.py#L55-L64)) and the DP keeps siblings distinct throughout. This matters for any reducer arithmetic that needs per-edge attribution at a node where multiple incoming siblings merge.

The four prefix objects can be retained as thin adapter classes wrapping these index reads, or deleted at the call sites in favour of direct `value_ledgers[k]` reads. Either is a Phase 7 implementation choice **after** the §5.2 refactor; without it, only `_CarrierOnlyDenominatorPrefix` (single-hop carrier or A=X) and the single-hop-subject case fall out of the current `value_ledgers` shape.

### 5.4 Frontier display policy: pointer at the existing design doc

**Display semantics are not new.** They are specified in [`docs/current/cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) — coverage definition (§2), the three states load-bearing trichotomy (§3.1), the data-layer contract (§3.2–3.4), and the visual semantics including coverage→opacity composition (§4). Atom 1 of that plan landed in commit `4f5c96c2` per §5.1 of the doc. Phase 6 does not re-specify display behaviour; it points at the existing contract.

This section records the load-bearing pointers so the algebra in §3–§4 and the spine mapping in §5.1–§5.3 can be reasoned about against the known chart behaviour. For any display question, the design doc above is authoritative.

**The three modes (existing implementation)**:

- **F (`visibility_mode = 'f'`)** — unconditioned model overlay (`model_midpoint`) plus predictive dispersion bands (`model_bands`). No empirical series. Fan polygon at [cohortComparisonBuilders.ts:612-665](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L612-L665).

- **E (`visibility_mode = 'e'`)** — empirical bar (`evidence_y`) and the raw evidence rate line (`evidence_y / x`), segmented by `completeness ≥ 0.95` into solid (epoch A) and dashed (epoch B) at [cohortComparisonBuilders.ts:491-516](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L491-L516). The rate line is *not* coverage-adjusted — it shows strictly admissible evidence and falls naturally in epoch B as observation drops. Per-point markers on the evidence line carry `opacity = fade × coverage` per the design doc §4.2, implemented at [cohortComparisonBuilders.ts:702-711](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L702-L711) — alpha-on-blobs is in place, not aspirational.

- **E+F (`visibility_mode = 'f+e'`)** — empirical bar plus forecast bar (`forecast_residual`), the rate line (intended to be the coverage-blended `rate_blended` per design doc §4 — currently held back to raw `baseRate` by the TEMP DIAGNOSTIC at [cohortComparisonBuilders.ts:519-528](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L519-L528) while coverage/frontier semantics are validated), the coverage-blended overlay `rate_blended` as a hidden-from-legend dashed diagnostic at [cohortComparisonBuilders.ts:560-570](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L560-L570), the forecast midpoint (dotted, post-frontier) at [cohortComparisonBuilders.ts:573-580](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L573-L580), and the fan chart of conditioned dispersion bands at [cohortComparisonBuilders.ts:612-665](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L612-L665). The same per-point alpha-on-blobs rule applies to the evidence-line markers.

**Coverage adjustment (the carry-forward principle).** Carry-forward evidence in E+F is coverage-adjusted: `rate_blended = empirical × coverage + model_midpoint × (1 − coverage)` at [cohort_forecast_v3.py:5701-5704](graph-editor/lib/runner/cohort_forecast_v3.py#L5701-L5704). The blend naturally prevents the line from falling to 0 in epoch B (as coverage decays, weight shifts to the model) and addresses sparsity throughout (intermediate coverage smooths the empirical signal toward the model). E does *not* apply this blend; the falling-line behaviour in epoch B is the meaning of "strictly admissible evidence" — show what was observed, with no model-fill.

**Dashing.** Lines dash whenever the cohort is past its strict observation frontier — concretely, on the evidence-line path the split happens at `tau_solid_max` from `_observation_frontier` at [cohort_forecast_v3.py:416-467](graph-editor/lib/runner/cohort_forecast_v3.py#L416-L467); on the rate-line path the gate is `completeness ≥ 0.95` from the lognormal CDF at [forecast_application.py:35-52](graph-editor/lib/runner/forecast_application.py#L35-L52). Coverage and completeness both decay past the frontier; dashing happens naturally in epoch B by either criterion.

**Pop C / Pop D.** The conditioned model curve plotted in E+F past each cohort's frontier *is* the spine's composed subject + carrier evaluated against the cohort seed (mass-propagation algebra of §3–§4). The pre-spine reducer didn't have that path, so it reconstructed the same surface bespoke at [cohort_forecast_v3.py:4908-5256](graph-editor/lib/runner/cohort_forecast_v3.py#L4908-L5256) by splitting unconverted-at-frontier mass into Pop D (at X but not yet at terminal — subject-only residual) and Pop C (not yet at X — carrier residual then subject convolution), summing each pool's projection into `Y_total` and dividing by `X_total`. Under Phase 7 this reconstruction is **deleted outright**: feed the spine a `RuntimeRootMass` with the cohort count at the anchor day, let the operator chain convolve through the conditioned carrier+subject kernels, and the per-(anchor, τ) terminal cumulative is the conditioned model curve — Pop D and Pop C drop out of the convolution naturally, no enumeration of populations required. The F-mode unconditioned curve already runs through the spine via `_strict_span_model_rate_draws` ([cohort_forecast_v3.py:5398](graph-editor/lib/runner/cohort_forecast_v3.py#L5398)); the E+F conditioned curve is the remaining legacy path Phase 7 cuts over.

**Per-scenario isolation.** Each scenario carries its own row series indexed by `(anchor_day, τ)` from its own `asat`-bound snapshot retrieval. Two scenarios with the same anchor set but different `asat` produce different `completeness`, `tau_solid_max`, `rate_blended`, and fan-chart bands. Per-cohort `evidence_x_coverage` / `evidence_y_coverage` ([cohort_forecast_v3.py:375-387](graph-editor/lib/runner/cohort_forecast_v3.py#L375-L387)) reduce into the row's `coverage = min(...)` field ([cohort_forecast_v3.py:5564-5567](graph-editor/lib/runner/cohort_forecast_v3.py#L5564-L5567)) per design doc §2.3.

**What this section does NOT specify.** Display rendering, dashing thresholds, fan-chart styling, blend formulas, or admissibility criteria — all are pinned by the existing implementation at the citations above and by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md). Phase 6 records them; Phase 7 inherits them unchanged. Phase 7's only display-side responsibility is unblocking the E+F rate-line switch from `baseRate` to `rate_blended` once coverage/frontier semantics are signed off (per the TEMP DIAGNOSTIC comment).

### 5.5 The intuition summary

**The spine is already the engine core for both model and evidence sides.** The difference is the seed mass:

| Caller | Seed mass | What it produces |
|---|---|---|
| Model overlay (`evaluate_model_rate_draws`) | Unit impulse (1 day, count 1) | Per-draw rate trajectory (F-mode) |
| Conditioned forecast CDF (`evaluate_request_cdf_draws`) | Unit impulse with unit reach (no primitive probability) | Per-draw conditioned cumulative CDF |
| Reducer (Phase 7) | Per-anchor observed `N_A(anchor_day)` at chain root | Per-(draw, anchor, τ) terminal cumulative |
| Pop C residual | Same as reducer, restricted to the carrier chain | Per-(anchor, τ) cumulative at X |
| Pop D residual | Per-(anchor, source_day_at_X) carrier output (smeared) | Per-(anchor, τ) cumulative at terminal |

All five consume the same composition (`compose_primitive_span`), the same conditioned per-edge primitives, and the same per-draw operator chain evaluation (`evaluate_with_operators`). They differ only in the seed mass they hand to the evaluator and in how they aggregate the output.

This is the mapping the intuition needs to hold onto: **the spine is one machine that converts (per-edge conditioned primitives, seed mass) into per-(draw, cohort, τ) terminal values**. The model overlay, the conditioned forecast CDF, and the evidence reducer are three callers of one machine, distinguished only by what they hand in.

---

## 6. Closure criteria and test families

### 6.1 Cohort mass-conservation tests (algebraic, blind, prose specification)

These tests pass iff the algebra in §3–§5 is internally consistent and rules §3.2 (arrival-map / propagation consistency) and §3.3 (unified push-forward) hold.

1. **Saturation conservation.** For `cohort(A, A→Z)` with N users at A on a single anchor day, propagated through an arbitrary subject DAG, the terminal cumulative at τ→∞ equals `N × p_AZ` where `p_AZ = span_p_draws` is the composed-span topological reach. Tested with serial chains (1, 2, 3 edges deep), parallel-paths topologies (two paths X→Y→Z and X→Z), join topologies (A→B, A→C → D), and mixed with latent / non-latent / deterministic / zero-latency primitive families.

2. **Per-source-day decomposition consistency.** At any intermediate node U in the DAG, decomposing mass by source day s_U, propagating each (anchor, s_U) bucket independently through the downstream DAG, and re-aggregating at terminal yields the same numerics as direct end-to-end composition.

3. **Mass conservation at intermediate nodes.** At any on-path node U, `Σ_{s_U} mass_at_U(s_U)` at τ→∞ equals `N × reach_to_U` where `reach_to_U` is the composed reach from the root to U under the topology (single-path for serial, sum-over-paths for parallel, leakage-adjusted for ordinary leakage). Mass conserves at every checkpoint along the DAG, not only at terminal.

4. **Time-shift invariance.** Shifting the anchor day by k days produces output columns shifted by k days, numerically identical otherwise.

5. **Identity-carrier degeneracy.** `cohort(A, X→Z)` with A == X produces identical numerics to `cohort(X, X→Z)` (no carrier). The carrier collapses to a zero-edge identity composition with δ(0) at the root; the same `seed_subject_from_carrier` code path handles both.

6. **Single-edge limit.** A two-edge subject DAG with one edge's latency Dirac-at-zero gives identical numerics to a one-edge DAG with composed reach `p_1 × p_2`. The zero-latency edge degenerates to a rate multiplier with no time-shift contribution. (Natural degeneracy by data, not by branch.)

7. **Arrival-map / propagation invariant (direct).** Instrumenting the algebra to expose `arrival_map_at_U` and `propagation_density_at_U`, the two are pointwise equal per draw. The previous attempt's failure mode is caught at this boundary, not at integration.

8. **Cohort cancellation (direct).** Instrumenting the algebra to expose, at every concrete edge `(U, V)`, the bucket's `n_UV(s_U)` and our cohort's propagated `m_U(s_U)`, the two are pointwise equal per draw under cohort clocking. This is the load-bearing condition for §4.4. A failure here means clocking is broken upstream and the cohort algebra silently reverts to the window-style ratio arithmetic with non-1 ratios — symptom: terminal k still approximately equals `N × Π p_i` at saturation but rising-edge profiles drift.

9. **Cumulative-vs-incremental boundary (direct).** Instrumenting the DAG DP to expose the quantity flowing through every concrete edge, assert that it is a per-day arrival density at every node (not cumulative), and that the cumulative sum happens exactly once at the terminal readout. A failure here is the previous attempt's 1-day shift signature.

10. **Coverage as masked-kernel ratio (direct, §4.8).** With one per-cell mask zeroed (a single absent cell on one concrete edge), assert that `coverage(a, τ)` at every downstream `(anchor, τ)` cell whose wavefront passes through that cell strictly decreases below 1.0 by exactly the mass-weighted fraction routed through it, while `value(a, τ)` is unchanged. With *all* per-cell masks unit, assert `coverage(a, τ) = 1.0` wherever `value(a, τ) > 0`. With *no* observation anywhere (every mask zero), assert `coverage(a, τ) = 0.0` everywhere `value(a, τ) > 0`. These three corner conditions plus a partial-mask case (a single edge with mixed observed/absent source days, and a parallel-paths topology where one path is observed and the other absent) directly exercise the §4.8 ratio formulation and confirm support composition through the DAG.

11. **Covered-zero vs absent — three-stream discrimination (direct, §4.8).** Replace one per-cell entry with covered-zero (`Δcdf_UV(s, age) = 0`, mask = 1) and re-run; assert at every downstream `(anchor, τ)` cell whose wavefront passes through that cell: `value` unchanged from the unmodified-fixture baseline at cells whose wavefront depends on that source-day cell (covered-zero contributes 0 to value but only at the specific (s, age) and only along paths that route through it), `support` unchanged from the value-weighted baseline, and `exposure` carries positive mass through (because mask = 1, the unit-reach PMF kernel still contributes). Then replace the same per-cell entry with absent (mask = 0, model-imputed `Δcdf` > 0) and re-run; assert `value` carries imputed mass, `support` drops, AND `exposure` drops to 0 along paths that route through that cell. This is the load-bearing algebraic distinction: covered-zero leaves exposure positive (we observed); absent zeros exposure (we didn't). A failure indicates the mask is computed from value-positivity rather than row presence, or the exposure stream's kernel is conflated with the support stream's.

12. **Zero-value terminal discrimination (direct, §4.8 corner cases).** Construct a DAG fixture where: (a) every contributing path is covered-zero, and (b) every contributing path is absent. In case (a), `cumulative_value(a, τ) = 0` and `cumulative_exposure(a, τ) > 0` — "we observed zero everywhere". In case (b), `cumulative_value(a, τ) > 0` (model-imputed) and `cumulative_exposure(a, τ) = 0` — "we don't know". The two cases are distinguishable by the (value, support, exposure) triple even though value-weighted coverage is undefined at terminal-zero cells in case (a).

### 6.2 Window local-rate tests (algebraic, blind, prose specification)

**W1. Single-edge identity.** `window(X→Y)` on a single edge with no upstream — the cumulative at τ exactly matches the locally-observed `k_τ / n_τ` curve. Boundary case.

**W2. Multi-hop rate composition.** `window(X→Z)` over X→Y→Z — terminal rate at τ→∞ equals `p_XY × p_YZ` where each `p` is the locally-observed window-evidence rate at that edge.

**W3. Window-cohort divergence at finite τ.** `window(X→Z)` and `cohort(X, X→Z)` rise at different rates at finite τ but converge at τ→∞ if the same edges with same rates. Tests that the two regimes are algebraically distinct without requiring numeric equality at finite τ.

**W4. Local-rate reproduction.** Window's per-edge rate at saturation equals the locally observed `k/n` for that edge's window evidence — confirming no cross-cohort evidence is being folded in at intermediate hops.

### 6.3 Test harness shape

Synth-style graph fixtures covering the topology surface, not just serial chains. Parameterised over:

- N (anchor cohort size)
- p per concrete edge (including distinct values per sibling at the same endpoints)
- latency family per edge (deterministic, latent, non-latent)
- topology shape: serial 1/2/3-edge; parallel-paths (X→Y→Z + X→Z); join (multiple sources converging into one node); coincident siblings (two parallel edges between the same endpoint pair)
- per-cell mask state: all-observed, all-absent, mixed-along-an-edge, mixed-across-paths, single-cell covered-zero, single-cell absent

Numbers from closed-form algebra (no MC noise, no fitting). Tolerance: float-precision, not statistical.

Tests are blind: they specify what the algebra must do from first principles. They do not compare against current production code. A correct Phase 7 implementation passes the full set; the test set decomposes failure modes by which invariant fails.

### 6.4 Closure criteria for Phase 6

Phase 6 closes when:

- This document is reviewed and the four rules (§3), the unified DAG-level mass-propagation algebra with cohort cancellation (§4.3–§4.4), the pointer at the existing three-state contract (§4.7 → design doc §3.1), the three-stream masked-kernel chain-composition algebra (§4.8 — value + support + exposure, the new contribution), the pointer at the existing display contract (§5.4 → design doc §4 + code), and the spine mapping anchored in the extended engine (§5.1, §5.1.5 term-by-term, §5.2 reducer scope, §5.3 node-id-keyed prefix reads, §5.5) are accepted.
- The §6.1 and §6.2 test sets are specified (this document).
- The next plan iteration (Phase 7 implementation plan) can start, gated by §6 acceptance.

**The plan §6 closure criterion — "reviewers can point to one section for value, support, coverage, frontier, midpoint policy" — is discharged at the contract level by this document.** A pointer per axis:

- **Value policy** — §4.3 (the unified mass-propagation formula with DAG inflows sum), §4.4 (cohort cancellation), §4.5 (window non-cancellation). Engine: DAG forward DP at [timing_span.py:467-498](graph-editor/lib/runner/timing_span.py#L467-L498); per-node reads via `read_node_mass_draws`. Tested by §6.1 invariants 1–9 and §6.2.
- **Support policy** — pinned by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) §3.1 (the three states: Absent / Covered-zero / Covered-positive). Phase 6 adds DAG-level propagation in §4.8 (the masked-kernel parallel stream computing chain-cell support from per-edge masks via the same DAG DP that propagates mass). Engine: `node_support_draws[node_id]` via `read_node_support_draws`. Tested by §6.1 invariants 10–12.
- **Coverage policy** — pinned by the design doc §2 (per-role and per-row definition), §4 (visual semantics: `point_opacity = coverage × fadeOpacity`). Phase 6 adds DAG composition in §4.8 (coverage as `cumulative_support / cumulative_value`, the ratio of two streams). Engine: `project_coverage_draws(value, support)`. Used at display per §5.4's pointer at the design doc.
- **Exposure (the covered-zero / absent discriminator at terminal-zero cells)** — Phase 6 adds the third parallel stream in §4.8 (`kernel^exposure = Δcdf × mask`, propagated by the same DAG DP). Engine: `node_exposure_draws[node_id]` via `read_node_exposure_draws`; `project_cumulative_exposure_draws` for the cumulative. Tested by §6.1 invariants 11–12.
- **Frontier policy** — pinned by the design doc §4 and the existing implementation cited from §5.4. F / E / E+F semantics are the existing app behaviour; Phase 6 does not re-specify them. The F-mode unconditioned curve already runs through the spine ([cohort_forecast_v3.py:5398](graph-editor/lib/runner/cohort_forecast_v3.py#L5398)); the E+F conditioned curve still goes through legacy Pop C / Pop D reconstruction at [cohort_forecast_v3.py:4908-5256](graph-editor/lib/runner/cohort_forecast_v3.py#L4908-L5256). Phase 7 deletes the legacy path by feeding the spine a per-cohort seed via `seed_subject_from_carrier`; the conditioned curve falls out of the DAG DP without enumerating populations.
- **Midpoint policy** — derived from value: the chart's midpoint at τ is the median of the per-draw distribution of the value surface at τ, read directly off the spine's per-draw output without additional algebra. The midpoint inherits whatever coverage and support apply to the underlying value at that cell.

**What Phase 7 picks, *within* the contract**:

- The migration order that brings row evidence, reducer frontier, and selected A-clock cells into reading the same promoted prefix/support object — without altering the existing display contract pinned by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md).
- Unblocking the E+F rate-line switch from raw `baseRate` to coverage-blended `rate_blended` once coverage/frontier semantics are signed off — see the TEMP DIAGNOSTIC comment at [cohortComparisonBuilders.ts:519-528](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L519-L528).
- The per-edge data-availability fallback inside `Absent` cells: refuse-to-emit at the cell level vs propagate-only fallback at the wavefront level. Either is admissible under the algebra in §4.8; the choice trades off chart honesty against chart smoothness.

These are implementation choices, not contract gaps. The display semantics, three-state trichotomy, coverage definition, and visual encoding are pinned by the existing design doc and code; Phase 7 inherits them. The contract pins what the implementation must satisfy at the algebra level — not what it must look like (the design doc already pins that).

---

## 7. Out of scope for Phase 6

The following are deliberately not specified here. They belong to Phase 7's implementation plan. Items marked *(within-contract)* are policy choices inside the §3–§5 contract; items marked *(scope-orthogonal)* are engineering decisions not addressed by the algebra at all.

- *(within-contract)* **Per-edge `Absent`-state fallback.** The three states (Absent / Covered-zero / Covered-positive) are pinned by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) §3.1; §4.8 specifies the masked-kernel propagation. The implementation choice between refuse-to-emit at `Absent` cells vs propagate-only fallback at the wavefront level is Phase 7's.
- *(within-contract)* **E+F rate-line switch.** The intended target is `rate_blended` (coverage-adjusted); currently held back to raw `baseRate` by the TEMP DIAGNOSTIC at [cohortComparisonBuilders.ts:519-528](graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L519-L528). Phase 7 unblocks once coverage/frontier semantics are validated.
- *(scope-orthogonal)* **Concrete API signatures.** The wrapper function provisionally named `evaluate_observed_cohort_mass` is described in §5.2 but its signature, return type, and call-site placement are Phase 7.
- *(scope-orthogonal)* **Migration sequencing.** Which prefix object to migrate first, the A/B harness against the current reducer, the gate criteria per prefix.
- *(scope-orthogonal)* **Window per-source-day vs age-only data availability.** The kernel shape contract in §4.1 admits both; the policy for when each is used is data-availability-driven.
- *(scope-orthogonal)* **Multi-cohort batching ergonomics.** §5.2 describes the `RuntimeRootMass` shape; whether anchors batch together in one `evaluate_with_operators` call or are looped externally is engineering.

Display semantics, three-state trichotomy, coverage definition, alpha-on-blobs implementation, dashing thresholds, fan-chart styling, and freshness UI are *not* deferred to Phase 7 — they are pinned by [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) and the existing code, with Atom 1 already landed.

---

## 8. Related documents

- `model-first-strict-span-cutover-plan-13-May-26.md` — the main cutover plan; this doc discharges its §6.
- `multi-hop-rate-composition-y-deficit-investigation.md` — the rolled-back attempt's failure characterisation (1-day timing shift, never root-caused). Cited here as the failure mode the §3.1 τ-axis rule and §3.2 consistency rule together prevent.
- `cf-defensive-coding-audit.md` — independent audit converging on the same hotspots (`is_identity_carrier` branching, parallel `ΣY / ΣX` engines). The Phase 7 implementation must not reintroduce any of the 21 findings.
- `cohort-1apr-falling-k-problem-statement.md §A.4` — the seam invariant (reducer and row builder read the same prefix object per cohort). Preserved by §5.3's projection-of-spine factoring.
