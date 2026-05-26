# Evidence Discretisation Investigation

**Date:** 21-May-26  
**Status:** active investigation note  
**Scope:** Stage 3 selected-cohort cutover follow-up: why removing midpoint correction repaired strict empirical mass conservation but exposed evidence/readout parity failures in active `cohort()` and multi-hop `window()` tests.

## 1. Starting Point

The immediate trigger was a set of outside-in failures after removing midpoint correction from strict empirical evidence readout.

The user-level goal is:

- preserve evidence integrity;
- restore model/evidence readout parity where that parity is semantically valid;
- avoid reintroducing an evidence-only midpoint hack that makes one fixture green while corrupting mass conservation elsewhere.

The known context from the handover:

- strict empirical readout now uses the age supplied by `EvidenceReadoutBinding`;
- the old hidden `source_index > 0` midpoint shift was removed from `empirical_evidence_operator.py`;
- a uniform-latency toy proved the old midpoint shift could create downstream evidence before mass should exist;
- outside-in failures remained in `test_cohort_factorised_outside_in.py`.

## 2. Failure Inventory

The focused failing set was:

1. `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
2. `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
3. `test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence`
4. `test_d1_parity_analytic_vs_bayes_mature_window`

After the model-side likelihood change and the approved window seam tolerance change:

- #3 passes with a 0.75% seam tolerance.
- #4 passes.
- #2 no longer has the model-order failures (`evidence rate > midpoint`).
- #1 and the evidence-count part of #2 still fail.

Those remaining failures compare:

- expected: cohort-family A-clock snapshot rows from the DB;
- actual: strict evidence emitted by the CF row machinery.

That comparison is valid and important. It is not merely a stale oracle if the test's contract is "strict evidence should match actual A-anchored observed reality".

## 3. Investigation Path

### 3.1 Evidence Midpoint Removal

The first confirmed fact was that removing the empirical midpoint shift fixed a real mass-conservation defect.

The toy test `test_uniform_latency_cohort_multihop_preserves_mass_conservation` constructs:

- A to B carrier density: 1/2 at tau 2, 1/2 at tau 3;
- B to C empirical probability: 1/5 over delays 4, 5, 6;
- C to D empirical probability: 1/7 over delays 1, 2.

Before the fix, D evidence appeared at tau 6 when the hand-computed mass flow said it could not appear until tau 7.

Conclusion: the old midpoint shift was not just a display convention. It moved evidence across the clock boundary in a way that could violate exact multi-hop mass conservation.

### 3.2 Model-Curve Failures

The next question was whether model/evidence gaps were evidence-side or model-side.

For `synth-simple-flat-abc` active single-hop at tau 17:

```text
strict evidence rate: 0.088224
truth integer curve:  0.088009
E+F midpoint:         0.081744
F-mode model_mid:     0.092961
```

This showed:

- strict evidence was close to the known truth curve;
- the conditioned E+F midpoint was low;
- the F-mode unconditioned overlay was not low.

The model-side issue was therefore in the conditioned likelihood/readout path.

### 3.3 Endpoint Versus Row-Average Likelihood

The synth generator emits rows by endpoint counting:

```python
_count_by_age(..., age)
y_window = bisect.bisect_right(conv_offsets, float(w_age))
```

That means a row labelled tau counts events with latency `<= tau`.

But the latent IS likelihood was using a row-averaged CDF:

```text
B(tau) = integral from tau to tau+1 of G(t) dt
```

On the rising flank of a lognormal CDF, `B(tau)` is ahead of endpoint `G(tau)`. Comparing endpoint-generated rows to a row-average likelihood makes evidence look late, so IS can select slower timing particles.

Experiment: switch the latent likelihood comparand from `proposal_cdf_draws_row_aligned` to endpoint `proposal_cdf_draws`.

Result:

- `test_d1_parity_analytic_vs_bayes_mature_window` passed.
- `test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence` passed after the approved 0.75% tolerance.
- model-order failures in `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` disappeared.

Conclusion: endpoint likelihood matches synth snapshot row semantics better than row-average likelihood for these rows.

### 3.4 Fresh Bayes Sidecar Check

The next concern was whether model vars were stale or badly recovered.

A fresh test-fixture sidecar was commissioned via:

```text
python3 -u -m bayes.test_harness \
  --graph synth-simple-flat-abc \
  --fe-payload --enrich --no-webhook \
  --sidecar-out bayes/fixtures/synth-simple-flat-abc.bayes-vars.json
```

The fresh fit recovered central parameters well:

```text
A->B truth: p=0.90, mu=2.3, sigma=0.5, onset=1
fit:        p=0.9004, mu=2.3030, sigma=0.4987, onset=0.98

B->C truth: p=0.90, mu=2.5, sigma=0.6, onset=2
fit:        p=0.9000, mu=2.4995, sigma=0.5996, onset=2.0
```

The fresh sidecar improved the curve only slightly. It did not remove the conditioned midpoint lag by itself.

Conclusion: stale central Bayes recovery was not the main cause. The likelihood/readout mismatch was real.

### 3.5 Runtime Timing Uncertainty Probe

There was also a probe that forced runtime timing SDs to zero.

Result:

- D1 passed;
- active multi-hop model-order failures disappeared;
- window seam improved but did not fully close.

This initially suggested "timing uncertainty" was causing the issue. After RTFM and the fresh Bayes run, the better interpretation is:

- timing SDs give IS room to select slower/faster timing particles;
- if the likelihood comparand is wrong, that room amplifies the problem;
- but central Bayes recovery itself is not the main defect for the lognormal flat fixture.

## 4. The Evidence-Count Failures Are More Serious

After fixing the model-side endpoint likelihood issue, the remaining active failures are evidence-count failures.

The test is engineered as follows:

- expected values come from `_selected_a_clock_snapshot_oracle()`;
- that helper fetches cohort-family snapshot rows whose `temporal_mode == "cohort"` and `cohort_anchor == A`;
- it sums raw `x` and `y` by A-clock tau;
- actual values come from `cohort_maturity` rows, through the CF row machinery.

The current primitive evidence path composes factorised helper rows. That is the representation this proposal keeps.

The remaining test is comparing:

```text
expected: actual cohort-family A-clock outcome from synth_gen / DB
actual:   factorised strict evidence composed from window/helper primitive rows
```

This is exactly the right outside-in test of whether factorised evidence algebra reproduces the actual A-anchored observed outcome under controlled conditions.

It is currently failing. That is a real issue, not merely a stale oracle. The intended strict evidence contract for this output path is:

```text
factorised selected-cohort evidence, under a consistent bucket algebra,
must reproduce the actual A-clock observed outcome in controlled fixtures.
```

The fix must therefore live in the shared discretisation/readout algebra used by the new CF output path, not in test-oracle weakening.

## 5. Why Midpoint Removal Helps One Test Class And Hurts Another

The confusion is real: if the algebra is right, why would midpoint help anywhere and hurt elsewhere?

The answer is that midpoint correction was compensating for one discretisation error while introducing another.

### 5.1 What midpoint helped

The cohort-family DB row is an A-clock outcome:

```text
For selected A-day C and age tau, how many reached E?
```

The factorised empirical path does not directly read that gross outcome. It composes:

```text
carrier A->X
subject X->E
```

When the subject-side lookup is evaluated on an integer bucket boundary, it can be behind the gross A-clock outcome on the rising flank. A midpoint read gives the subject edge about half a day more exposure and can bring the factorised curve closer to the gross cohort row.

So midpoint helped tests that expected factorised strict evidence to match the raw A-clock cohort-family outcome at finite tau.

### 5.2 What midpoint hurt

The same midpoint shift was applied only inside empirical readout after binding had already selected an evidence clock.

For a multi-hop cohort path, the cancellation invariant is:

```text
m_U(C, s) = n_UV(C, s)
m_U * k/n = k
```

That invariant is exact only if mass placement and evidence lookup use the same bucket boundary. If a later readout adds `+0.5` to the evidence age without moving the corresponding mass kernel and denominator in the same way, the cancellation no longer holds.

That is what the uniform toy exposed: downstream evidence appeared one day too early.

So midpoint helped a gross-row parity symptom but hurt algebraic mass conservation because it was applied asymmetrically.

### 5.3 The Correct Lesson

The lesson is not "midpoint good" or "midpoint bad".

The lesson is:

```text
discretisation must be part of the shared evidence operator,
not a post-hoc shift applied to one readout surface.
```

If a bucket-centred convention is needed, the carrier mass, subject rate, support/exposure masks, and denominator cancellation must all use the same bucket operator. Otherwise one invariant improves while another breaks.

## 6. Current Working Hypotheses

### 6.1 Model-side hypothesis

Synth snapshot rows are endpoint cumulative. The latent IS likelihood should use endpoint CDF `G(tau)`, not row-average `B(tau)`, for these rows.

Current evidence:

- endpoint likelihood makes the known model-side failures pass;
- row-average likelihood made the conditioned model curve lag evidence in flat fixtures.

### 6.2 Evidence-side hypothesis

The active strict evidence path composes factorised window/helper primitive rows. That remains the intended representation for this fix.

The failure is that the factorised composition does not yet use one coherent bucket placement convention across carrier mass, subject rates, support/coverage, and selected A-clock placement. When those surfaces use different implicit clock conventions, the composed strict evidence can lag or lead the actual A-clock cohort-family outcome on rising flanks.

The strict evidence contract is:

```text
strict active cohort evidence =
factorised selected-cohort reconstruction of the actual A-clock observed outcome
```

The implementation must make that reconstruction algebraically correct while keeping the factorised representation.

## 7. Known Code Changes In This Investigation

Current intended code changes:

- `primitive_conditioning.py`: latent IS likelihood uses endpoint `proposal_cdf_draws` instead of row-aligned `proposal_cdf_draws_row_aligned`.
- `test_cohort_factorised_outside_in.py`: window stepped-latency seam tolerance widened to 0.75%.

Not intended as a code change:

- `bayes/fixtures/synth-simple-flat-abc.bayes-vars.json`: a fresh sidecar was generated as a forensic check only. The investigation found that stale central Bayes recovery was not causal, so the sidecar should not change as part of this fix.

Temporary diagnostics/probes were reverted:

- forcing timing SDs to zero in runtime;
- dumping full primitive provenance into `cohort_forecast_v3.py`;
- adding timing CDF sample dumps to `primitives.py`;
- row-basis readout experiment.

## 8. Next Questions

1. What is the shared bucket/discretisation operator for the new CF output path?
2. How does that operator flow through model span composition, empirical evidence composition, prefix arrival / evidence binding, selected A-clock placement, support, and coverage?
3. How do we keep the factorised mass-conservation toy green while making flat active cohort evidence match the A-clock cohort-family outcome?
4. Which focused algebra tests prove the convention before the public row path is changed?

## 9. Practical Next Step

Do not rewrite the remaining evidence oracles yet.

The semantic contract is:

```text
strict active cohort evidence =
factorised selected-cohort reconstruction of the actual A-clock observed outcome
```

The current outside-in tests are doing useful work and should remain canaries. The next step is to define the shared bucket algebra, prove it in focused tests, and then apply it consistently across the new CF output path.

## 10. Proposal: Daily Bucket Transition Algebra — One Atomic Global Change

### 10.0 Atomicity statement

This proposal is **one atomic change** to the runtime's discretisation convention. It is **not** a sequence of staged steps with intermediate test gates, and it is **not** a defect-driven fix to a single surface.

The system today already corrects discretisation **at some surfaces** (subject-span composer's placement-shifted propagated kernel; cohort_forecast_v3's first-subject-layer midpoint shift; primitive_conditioning's endpoint vs row-aligned CDF) and **not at others** (empirical operator's source-day-keyed lookup; rate-attributed prefix's downstream subject layers; selected A-clock placement; prefix arrival weights; identity-ledger convolution path). The result is an inconsistent runtime where surfaces communicate in mixed conventions.

There is **no intermediate state** in which the runtime is internally consistent and worth testing. Until every site in §10.3 implements the §10.1 bucket-K algebra, every intermediate output reflects the friction between converted and unconverted surfaces, not the algebra. The "implementation order" in earlier drafts of this plan was wrong framing: each "stage" produced a runtime that mixed conventions worse than the starting state, and any tests in between would have measured noise.

**Consequences for implementation discipline:**

- The whole inventory in §10.3 must be converted in one coordinated commit (or one tightly-bounded short-lived branch). No single-file edit is meaningful in isolation.
- The completeness test suite in §10.5 is the **only** acceptance signal that the global change is internally consistent. Outside-in canaries (§10.6) are downstream consequences; they may pass for the wrong reasons under partial conversion, and may fail for the right reasons during the change window — neither tells you whether the algebra is consistent.

### 10.1 Goal

Replace the **mixed** placement convention currently in the runtime with **one** shared bucket-to-bucket transition algebra applied uniformly across model composition, empirical evidence, prefix arrival, support/coverage, and selected A-clock placement.

This is the intellectual core of the proposal. The fix must be general, algebraic, and naturally degenerating: `cohort()`, `window()`, identity carrier, single-hop, and multi-hop differ by supplied roots and bucket kernels, not by central mode branches.

The core object is:

```text
K_UV[source_bucket, output_bucket]
```

Meaning:

```text
given mass in source day bucket s,
what fraction reaches V in output day bucket t?
```

Then all span composition becomes:

```text
M_V[t] = sum_s M_U[s] * K_UV[s, t]
```

Public cumulative rows remain endpoint-labelled:

```text
Y(tau) = sum_{t <= tau} M_Y[t]
```

The important shift in mental model is: do not move point masses around the integer grid; move bucket mass through a bucket transition operator.

### 10.2 Why This Is Needed

The old midpoint correction treated some internally propagated mass as bucket-centred, but only at the subject evidence readout. It did not move carrier mass, denominators, support, coverage, or A-clock placement through the same operator.

That created two contradictory outcomes:

- It helped match gross A-clock cohort-family rows on rising flanks.
- It broke exact multi-hop mass conservation, as the uniform-latency toy demonstrated.

The current no-midpoint endpoint readout restores mass conservation, but it exposes that factorised strict evidence can lag actual cohort-family outcomes on rising flanks.

The resolution is not to add or remove midpoint locally. The resolution is to make bucket placement part of the shared algebra.

### 10.3 The Full Inventory: Every Site That Encodes Placement Convention

This inventory enumerates every site in the BE runtime where the placement convention is encoded — either by deciding how mass is placed into a bucket, by reading a rate at a particular age, by converting between cumulative and density representations, or by selecting between integer-aligned and bucket-centred reads. The §10.1 bucket-K algebra must be applied uniformly across every site below.

**Out-of-scope sites are listed in §10.4.**

The inventory is grouped by **kind of operation**, not by file.

#### 10.3.1 Edge-level density construction (mass placement at source)

These functions decide how a parametric or empirical edge produces per-day / per-bucket mass.

- **`graph-editor/lib/runner/span_kernel.py:108-154` `_edge_sub_probability_density`** — trapezoidal mid-interval mass `0.5 * (pdf_left + pdf_right)` for bucket `(τ-1, τ]`. The docstring explicitly states `cumsum(result)` at integer τ approximates `CDF_continuous(τ)`. **Convention encoded: right-endpoint cumulative, bucket = `(τ-1, τ]`, trapezoidal density.** This is the implicit baseline the rest of the runtime is meant to be consistent with. Used by both `timing_span` (model density) and shared by carrier composition.
- **`graph-editor/lib/runner/span_kernel.py:374`** `density = np.diff(K, prepend=0.0)` — cumulative→density via diff; pairs with the trapezoidal density above.
- **`graph-editor/lib/runner/span_kernel.py:352`** `np.convolve(g[from_id], f_edge)` — DAG forward DP composing per-edge density.
- **`graph-editor/lib/runner/span_kernel.py:360`** `np.cumsum(g[topo.y_node_id])` — terminal density → public CDF.

#### 10.3.2 Conditioned-model kernel construction (model-side placement)

- **`graph-editor/lib/runner/primitive_conditioning.py:1274-1285`** `_build_per_draw_cdf` (endpoint `G(τ)`) and `build_row_aligned_lognormal_cdf_from_draws` (row-average `B(τ) = ∫_τ^{τ+1} G(v) dv`) — both surfaces are constructed; only `proposal_cdf_draws` (endpoint) is consumed by `_evaluate_likelihood_plan`. The row-aligned surface is built and discarded. Decide: keep both, delete the row-aligned, or change which one is consumed.
- **`graph-editor/lib/runner/primitive_conditioning.py:1319, 1327`** `proposal_cdf_draws[:, tau_idx]` — the IS likelihood cell uses endpoint reads. This is the model-side analogue of the empirical operator's `_cumulative_rate_for_lookup`. Must agree with the convention chosen for empirical reads.
- **`graph-editor/lib/runner/subject_span_composer.py:502, 778, 832`** `pmf = np.diff(cdf_aligned, axis=1, prepend=0.0)` — converts conditioned primitive's `cdf_draws` to per-bucket pmf via right-difference. Used in three composition paths.
- **`graph-editor/lib/runner/subject_span_composer.py:537`** `density_cdf = np.cumsum(terminal_density, axis=1)` — composed-span terminal density → request CDF.
- **`graph-editor/lib/runner/subject_span_composer.py:723-797`** `_conditioned_kernel_maps` — builds **two parallel kernels per edge**: `native_kernels_by_edge` (integer-aligned, `np.diff(cdf_aligned)`) and `propagated_kernels_by_edge` (calls `_propagated_latent_timing_kernel`).
- **`graph-editor/lib/runner/subject_span_composer.py:800-837`** `_propagated_latent_timing_kernel` — reads `cdf_draws` at **fractional ages `τ + 0.5`** via `curvature_corrected_interp`, then `np.diff`. **This is the conditioned-side `+0.5` bucket-midpoint shift.** Compare with the `-0.5` shift at cohort_forecast_v3:4201 — they encode the same intent in opposite sign conventions and currently coexist.
- **`graph-editor/lib/runner/subject_span_composer.py:688-690, 716-720`** `provider(ce, source_index)` — selects `native_kernels[ce]` when `source_index == 0` and `propagated_kernels[ce]` otherwise. **This is the source-index-driven placement-aware selector** that violates "identity is data" — partial conversion already in place.
- **`graph-editor/lib/runner/numpy_stats.py:19-81`** `curvature_corrected_interp(lookup, fractional_index)` — the shared 4-point Simpson stencil. Reduces to direct lookup at integer indices, cubic-Lagrange at `w=0.5`. Used by `_propagated_latent_timing_kernel`, `_interpolated_rate_at`, and `_bound_age_cumulative_rate`. This is the only mechanism by which bucket-centred reads enter the algebra today.

#### 10.3.3 Empirical operator kernel construction (evidence-side placement)

- **`graph-editor/lib/runner/empirical_evidence_operator.py:205-316`** `_build_empirical_delta_kernel_draws` — produces per-source-day cumulative rate (`source_cumulative_rate`) then strict increment via `np.diff(..., prepend=0.0, axis=1)` (lines 291, 309). Right-endpoint convention.
- **`graph-editor/lib/runner/empirical_evidence_operator.py:319-326`** `_cumulative_kernels_by_source_day` — precomputes `np.cumsum(kernel, axis=1)` for lookup-bound evaluation.
- **`graph-editor/lib/runner/empirical_evidence_operator.py:393, 410`** `np.cumsum(terminal_density)` then `cdf_mean`/`cdf_draws` — composed-span CDF surfaces returned.
- **`graph-editor/lib/runner/empirical_evidence_operator.py:594-625`** `_build_empirical_flat_kernel_provider` — per-edge per-source-index kernel provider. Reads `cumulative[:, relative_offset] = _bound_age_cumulative_rate(...)` then `np.diff(cumulative, prepend=0.0, axis=1)` (line 623). **No placement-aware selector here — same path for source_index=0 and source_index>0.** This is inconsistent with `subject_span_composer._build_stream_kernel_provider` (model side), which does branch on source_index.
- **`graph-editor/lib/runner/empirical_evidence_operator.py:628-685`** `_run_empirical_lookup_bound_trace` — alternate flat-origins evaluator; same `_bound_age_cumulative_rate` calls (line 666) and same `np.diff` (line 676).
- **`graph-editor/lib/runner/empirical_evidence_operator.py:688-715`** `_bound_age_cumulative_rate` — wraps `curvature_corrected_interp(lookup, float(age))`. The docstring (lines 696-705) explicitly forbids "a hidden source-index shift after the binding has chosen `(source_day, age)`". So the empirical path is canonically **right-endpoint, no midpoint shift**. This is the surface that disagrees with `subject_span_composer._propagated_latent_timing_kernel`.
- **`graph-editor/lib/runner/empirical_evidence_operator.py:718-735`** `_cumulative_rate_for_lookup` — integer-age cumulative read with min-clamp at right boundary.

#### 10.3.4 EvidenceReadoutBinding (calendar offset rule)

- **`graph-editor/lib/runner/subject_span_composer.py:138-153`** `EvidenceLookup(source_offset, age_offset)` — computes `(evidence_source_day = origin + source_offset * source_index, evidence_age = tau_out + age_offset * source_index)`. The two integer offsets encode the binding rule.
- **`graph-editor/lib/runner/subject_span_composer.py:170-175`** `EvidenceReadoutBinding.cohort()` → `EvidenceLookup(1, -1)`; `.window()` → `EvidenceLookup(0, 0)`. Cohort binding: every source-day s ≠ anchor reads source-day-specific R at age `tau - s`. Window binding: every source-day reads R at `(origin, tau)` (rate factors out). Both produce **integer** ages — no half-day shift at this layer.
- **`graph-editor/lib/runner/subject_span_composer.py:617, 663`** `evidence_readout_binding.lookup(...)` invocation sites inside the empirical operator.

#### 10.3.5 Prefix arrival weights (calendar-day mass placement)

- **`graph-editor/lib/runner/prefix_arrival.py:131-191`** `NodeArrivalWeights` — `weight_on(calendar_day)` and `weight_draws_on(calendar_day)` are **calendar-day keyed** integer-granularity lookups. Returns 0 for absent days. No fractional-day support.
- **`graph-editor/lib/runner/prefix_arrival.py:180-191`** `root_day_shares_on(calendar_day)` — per-root-day attribution. Same integer-granularity.
- **`graph-editor/lib/runner/prefix_arrival.py:499`** `pmf = np.diff(np.asarray(cdf, dtype=float), prepend=0.0)` — CDF → per-day pmf.
- **`graph-editor/lib/runner/prefix_arrival.py:643-656`** `build_per_draw_edge_cdf(particles, T)` then `pmf_draws = np.diff(cdf_draws, prepend=0.0, axis=1)` — same conversion per-draw.
- **`graph-editor/lib/runner/prefix_arrival.py:68-104`** `PrefixArrivalIdentity.canonical_string()` — cache identity. **If the placement convention changes the support or read semantics, this canonical string must change so cached entries from the previous convention do not survive.**

#### 10.3.6 Cohort-forecast-v3 row pipeline

Sites in `cohort_forecast_v3.py` that participate in the bucket-K algebra and must be aligned with the §10.1 convention:

- **`graph-editor/lib/runner/cohort_forecast_v3.py:285-415`** `SelectedAClockEvidence.aggregate_by_tau` — uses `_cell_at_or_before` forward-fill across taus, then sums across anchors. Chart-emission aggregation step. Forward-fill convention must be aligned with §10.1's endpoint-cumulative row labelling.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:1242, 1285-1287, 1346`** `np.diff(...)`, `np.convolve(chain_pmf, np.diff(padded, prepend=0.0))`, `np.cumsum(chain_pmf)` — chain composition utility. Diff/cumsum convention must match §10.3.1 trapezoidal density.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:1840-1845`** `carrier_pdf = np.diff(car, axis=1, prepend=0.0)`, `np.convolve(carrier_pdf[s], subject_pdf[s])`, `np.cumsum(full)` — per-draw carrier × subject convolution.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:2728-2750`** placement-by-calendar-arithmetic: `source_offset = (x_d - anchor_d).days`, then `pmf[source_offset]` — integer-day placement.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:3574-3636`** `_interpolated_rate_at(nk_by_tau, tau_float)` — fractional rate read. **Docstring claims "midpoint read avoids giving the whole bucket a full extra day of subject exposure"** — encodes a within-bucket placement assumption that must be made uniform with §10.1. Calls `curvature_corrected_interp` when adjacent integer brackets and outer neighbours present.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:3744-3759`** `_mass_series_for_anchor` — places per-source-day mass at integer offset `(source_day - anchor_day).days`.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:3805-3929`** `_build_evidence_local_rate_attributed_subject_prefix` (identity-ledger path):
  - line 3862 `values = np.convolve(mass_series, edge_rates)[:horizon]` — terminal-edge K[s, t] integer-endpoint compose.
  - line 3863 `coverage = np.convolve(mass_series, support_kernel)[:horizon]` — coverage via convolution.
  - line 3892 `propagated = np.convolve(mass_series, inc_rates)` — non-terminal-edge density propagation.
  - lines 3949, 3973-3974 inner-loop path: `tau = int(offset) + int(age); anchor_cum[tau] += mass * rate` — integer-endpoint accumulation.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:4068-4338`** `_build_rate_attributed_subject_prefix` (active path):
  - **line 4201** `midpoint_shift = 0.5 if len(anchor_buckets) > 1 else 0.0` — the first-subject-layer midpoint hack that must be removed and replaced with the §10.1 uniform convention.
  - **lines 4212-4216** `rate_tau = float(tau) - midpoint_shift if from_id_str == str(denominator_node) else float(tau)` — applies the shift only at the first subject layer.
  - line 4223 `rate = _interpolated_rate_at(nk_by_tau, rate_tau)` — fractional lookup.
  - line 4244-4252 diagnostic dual-evaluation under midpoint/integer/ff_integer conventions.
  - line 4292 `'rate_tau_offset': -0.5 if from_id_str == str(denominator_node) else 0.0` — provenance reflecting the shift; must be updated.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:4998`** `car_pdf = np.clip(np.diff(F_car, axis=1, prepend=0.0), 0.0, 1.0)` — carrier density from cumulative.
- **`graph-editor/lib/runner/cohort_forecast_v3.py:5224-5232`** `np.diff(G_with_anchor, axis=1) * inv_denom_G[:, None]`, then per-draw `np.convolve(arr_inc[s], kernel[s])` — Pop C arithmetic.

#### 10.3.7 Model-span-spine (orchestrator)

- **`graph-editor/lib/runner/model_span_spine.py:804-814`** `_evaluate_chain_at_root_zero_per_draw` — applies kernel as column-offset shift on a cumulative ledger, then `np.cumsum`. The offset is the integer source-bucket index.
- **`graph-editor/lib/runner/model_span_spine.py:817-870`** `evaluate_model_rate_draws` — builds per-draw chains for carrier and carrier+subject, runs `_evaluate_chain_at_root_zero_per_draw` for each, divides.
- **`graph-editor/lib/runner/model_span_spine.py:873-...`** `evaluate_request_cdf_draws` — per-draw chain for conditioned request CDF (same offset-and-cumsum machinery).
- **`graph-editor/lib/runner/model_span_spine.py:1054-1082`** `_summarise_density_trace` — `np.cumsum(arr, axis=1)` for diagnostics.
- **`graph-editor/lib/runner/model_span_spine.py:1134-...`** `project_selected_cohort_rows` — calls `evaluate_empirical_span_from_seed_flat_origins` for empirical surfaces; lines 1246-1247 produce `x_draws_model = np.cumsum(x_value_by_anchor.sum(axis=0), axis=-1)` (and same for `y_draws_model`); lines 1261-1266 produce per-anchor `strict_x_a = np.cumsum(emp_x_value_by_anchor[cohort_idx], axis=-1).mean(axis=0)` (and same for `strict_y_a`). **Cumsum here is what makes `evidence_x_strict` / `evidence_y_strict` integer-endpoint cumulative on the public row.** Forward-fill at lines 1284-1289 (`clamped = np.minimum(tau_indices, last_tau_max)`).

#### 10.3.8 Cross-cutting: integer rounding at row admission

- **`graph-editor/lib/runner/primitive_conditioning.py:732-754`** `_row_age_days(row)` — returns `(retrieved_at[:10] - observed_date[:10]).days` as an integer. **Within-day time-of-event is discarded at admission.** Every row enters the system already integer-bucketed. Bucket-midpoint reads of empirical rate are arithmetic on this integer; the within-day time has already been lost.

#### 10.3.9 Out-of-scope sites (confirmed by inspection, not edited)

- **`graph-editor/src/services/statisticalEnhancementService.ts`** and **`graph-editor/src/services/analysisECharts/**`** — FE consumes `midpoint`, `evidence_x`, `evidence_y`, `model_midpoint` as already-published row fields. No FE-side midpoint arithmetic. The FE is render-only with respect to placement convention.
- **`graph-editor/lib/api_handlers.py`** — dispatch only. Routes `cohort_maturity` to `_handle_cohort_maturity_v3`. No placement decisions.
- **`graph-editor/lib/runner/forecast_runtime.py`**, **`forecast_preparation.py`**, **`request_envelope.py`** — preparation perimeter. Owns evidence-superset construction but does not encode placement convention on the read/compose side.
- **`bayes/`** compiler — fits posteriors offline; the runtime consumes them through `ResolvedModelParams`. Convention here is irrelevant to chart placement.

#### 10.3.10 Current inconsistencies the change must remove

Today the runtime is split:
- §10.3.1 (edge density), §10.3.3 (empirical kernel), §10.3.6 identity-ledger path (`np.convolve`), §10.3.4 (binding offsets) — **right-endpoint, no shift**.
- §10.3.2 propagated kernel (`+0.5`), §10.3.6 active rate-attributed path (`-0.5` at first subject layer) — **bucket-midpoint, two sign conventions**.
- §10.3.5 (prefix-arrival weights) — integer-day-keyed; no within-bucket position.
- §10.3.8 (row admission) — integer-bucketed at the perimeter; within-day data already gone.

The atomic change unifies all of these on the §10.1 bucket-K algebra. The split above is the cataloguing of what must agree afterwards.

### 10.4 Explicitly Out Of Scope For This Fix

Do not edit these for the current output-path fix:

- `api_handlers.py` dispatch / subject resolution
- Bayes compiler model structure
- test oracles for #1/#2 as the primary way to make failures green

Those surfaces are not part of this proposal. The current bug is a consistency problem in the factorised output path's bucket algebra, not a Bayes compiler problem.

### 10.5 Completeness-of-Correction Test Suite

The test file lives at `graph-editor/lib/tests/test_bucket_transition_algebra.py`.

Each test is end-to-end through `handle_runner_analyze` on a synthetic fixture, and asserts a property of the chart-level row output that is **only satisfied when every §10.3 site implements the §10.1 bucket-K algebra**.

**Critical design constraint:** the suite must avoid the trap that caught the earlier red tests — tests at an intermediate dataclass (`_RateAttributedSubjectPrefix.cumulative_by_anchor`) turned green from a single-site edit because downstream `aggregate_by_tau` forward-fill masked the change. **A test that can be made green by editing a single §10.3 site is worthless as a completeness test.** Every test in this suite must touch chart-published row fields because that is the only level at which downstream forward-fill cannot mask upstream inconsistencies.

**Suite-level acceptance contract:** every test below must be **red today**. The "green only when every §10.3 site is aligned" property is **a consequence of the reversion audit in §10.7 step 4**, not of the test list alone. Until the audit has been run and shown that **at least one** test fails under every individual §10.3-site reversion, suite completeness is **claimed, not proved**. Treat the suite as a starting point, not a finished gate.

The "no single-file edit may turn any test green" criterion is the design intent for each test, but it can only be verified by the mechanical reversion. If a test passes under any individual partial reversion, the test is mis-designed and must be replaced.

#### Test C1: Active single-hop chart matches analytic bucket-K compose

Name: `test_active_single_hop_chart_evidence_matches_bucket_K_compose`.

**Contract.** Construct an active single-hop fixture where the A→X carrier composes onto more than one X source bucket per anchor and the X→Y empirical rates are non-trivial across the resulting subject-age range. Call `handle_runner_analyze` end-to-end. Assert that chart `evidence_x` and `evidence_y` at every τ equal the analytic bucket-K compose derived from §10.1 applied to the fixture.

**Fixture must exercise non-Dirac carrier.** If the carrier is a δ at integer days the chart output agrees with the current integer-endpoint empirical compose at [`empirical_evidence_operator.py:603-623`](../../graph-editor/lib/runner/empirical_evidence_operator.py#L603-L623) and the test cannot distinguish current behaviour from a uniformly bucket-K-compliant runtime. The fixture must place carrier mass that **spans more than one source bucket per anchor** (e.g. uniform-conditional carrier with reach distributed across two adjacent buckets, or a wide-lognormal carrier whose composed `g_AX[u]` has visible mass on three or more `u` values).

**Numerical expectations are not pinned in the plan.** They derive from §10.1 applied to the fixture the test author chooses. The plan does NOT supply specific `Y_A(τ)` values — earlier drafts pinned `(0, 10, 30, 40)` for a particular fixture, but those numerics are the *current* integer-endpoint output and would not prove conversion. The test author derives expected values from §10.1 directly.

**Runtime surfaces exercised** (the assertion is sensitive to all of these):
- §10.3.1 [`_edge_sub_probability_density`](../../graph-editor/lib/runner/span_kernel.py#L108-L154) — produces the carrier density that fills the source buckets.
- §10.3.3 empirical operator chain ([`empirical_evidence_operator.py:594-735`](../../graph-editor/lib/runner/empirical_evidence_operator.py#L594-L735)) — composes carrier mass through per-edge K[s, t].
- §10.3.4 `EvidenceReadoutBinding.cohort()` ([`subject_span_composer.py:170-171`](../../graph-editor/lib/runner/subject_span_composer.py#L170-L171)) — applies the per-source-bucket offset.
- §10.3.7 spine cumulation ([`model_span_spine.py:1260-1289`](../../graph-editor/lib/runner/model_span_spine.py#L1260-L1289)) — `np.cumsum` of per-anchor `emp_y_value_by_anchor` into `evidence_y_strict`.
- §10.3.6 chart aggregation `SelectedAClockEvidence.aggregate_by_tau` — forward-fill across anchors before chart emission.

**Chart fields asserted**: `evidence_x`, `evidence_y`. (Empirical-side fields only. Model-side bugs are caught by C4.)

#### Tests C2a / C2b / C2c: Multi-hop chart matches analytic bucket-K, three independent fixtures

The existing `test_uniform_latency_cohort_multihop_preserves_mass_conservation` passes under the current half-converted runtime because its carrier is Dirac at integer days (right-endpoint and bucket-midpoint conventions agree on Dirac inputs). C2 strengthens it along three orthogonal axes. Each axis is its own fixture and its own oracle — they do NOT share assertions.

**Common contract for C2a/C2b/C2c.** Construct the named fixture. Call `handle_runner_analyze` end-to-end. For every τ on every intermediate node in the chain, assert that the chart's per-τ value (or the per-anchor strict cumulative emitted by the empirical span) equals the analytic bucket-K compose derived from §10.1 applied to that fixture. Expected values are not pinned in the plan; the test author derives them from §10.1 directly.

**C2a — non-Dirac carrier.** Name: `test_multihop_chart_matches_bucket_K_under_non_dirac_carrier`. A→B carrier density places mass on three or more buckets (e.g. uniform 1/3 on τ ∈ {2, 3, 4}). B→C and C→D empirical rates may stay uniform within support. Probes §10.3.1 / §10.3.3 / §10.3.7 interaction with multi-bucket source mass.

**C2b — non-uniform empirical rate.** Name: `test_multihop_chart_matches_bucket_K_under_non_uniform_empirical_rate`. A→B carrier may be Dirac. B→C empirical rate is non-uniform within its support (e.g. R(4)=0.1, R(5)=0.3, R(6)=0.5). Probes §10.3.3 / §10.3.4 / §10.3.6 sensitivity to within-support shape.

**C2c — chain depth ≥ 3.** Name: `test_multihop_chart_matches_bucket_K_under_chain_depth_three`. A→B→C→D→E or longer. Each edge can use a simple uniform empirical rate. Probes §10.3.1 / §10.3.3 / §10.3.7 propagation through multiple compose steps; specifically targets §10.3.6's chain composition utility at [`cohort_forecast_v3.py:1242, 1285-1287, 1346`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1242).

**Runtime surfaces exercised** (each fixture exercises the same surfaces; the surface combination they stress varies):
- §10.3.1 trapezoidal density.
- §10.3.3 empirical operator multi-edge compose.
- §10.3.4 cohort binding offsets per hop.
- §10.3.5 prefix-arrival weights for the cohort root.
- §10.3.7 spine cumulation.
- §10.3.6 chart aggregation.

**Chart fields asserted**: per-τ `evidence_y` (and per-intermediate-node mass if exposed by the chart's diagnostic surface; otherwise terminal-only).

**Cancellation invariant.** Each C2 variant must additionally check the cancellation identity at every empirical edge in its chain: when the source-bucket mass entering U at bucket s equals `n_UV(s)`, the contribution to V from that bucket at the empirical observation's tau must equal `k_UV(s)`. This is the multi-hop invariant the asymmetric midpoint shift broke (investigation §5.2). It is asserted **per fixture** — the test author derives the expected `k_UV(s)` from each fixture's snapshot rows.

#### Test C3: Identity carrier and window mode produce identical chart output

Name: `test_identity_carrier_cohort_equivalent_to_window_on_same_observations`.

**Contract.** For identical synthetic snapshot data, the chart produced by `cohort(A=X, X→Y)` must equal the chart produced by `window(X→Y)` field-by-field. Both reduce to identity-carrier degeneracies of the same algebra (CF invariant I-46); any difference proves the two paths use mixed conventions.

**Runtime surfaces exercised**:
- §10.3.4 cohort vs window binding ([`subject_span_composer.py:170-175`](../../graph-editor/lib/runner/subject_span_composer.py#L170-L175)).
- §10.3.3 empirical operator (consumes the binding).
- §10.3.6 active vs identity-ledger paths within `_build_rate_attributed_subject_prefix` and `_build_evidence_local_rate_attributed_subject_prefix`.

**Chart fields asserted**: all chart row fields published by the runtime — `evidence_x`, `evidence_y`, `rate`, `midpoint`, `model_midpoint`, `fan_*`. Bit-identical between the two queries.

#### Test C4: Model-side propagated kernel does not shift in window mode

Name: `test_window_model_surface_does_not_shift_by_source_index`.

**Contract.** Under `EvidenceReadoutBinding.window()` (`source_offset=0, age_offset=0`), every source bucket reads its rate at the same `tau_out` — the rate factors out of the source-bucket axis on both the empirical and model paths. For a synthetic fixture where the conditioned model timing is non-trivial, the chart's **model-side** fields at integer `tau_out` must equal the analytic full-root projection under window semantics.

**Why this test reads model-side fields, not `evidence_y`.** `evidence_y` flows from the empirical span composer only ([`model_span_spine.py:1230-1267`](../../graph-editor/lib/runner/model_span_spine.py#L1230-L1267)); a bug in [`subject_span_composer._propagated_latent_timing_kernel`](../../graph-editor/lib/runner/subject_span_composer.py#L800-L837) (the `+0.5` model-side shift at §10.3.2) does not propagate into `evidence_y`. To catch model-side propagated-kernel shifts the assertion must read chart fields produced by the conditioned model surface.

**Runtime surfaces exercised**:
- §10.3.2 conditioned-model kernel construction (`_conditioned_kernel_maps`, `_propagated_latent_timing_kernel`, the source-index-driven `provider` switch).
- §10.3.4 window binding offsets.
- §10.3.7 spine `evaluate_model_rate_draws` and `evaluate_request_cdf_draws`.

**Chart fields asserted**: `midpoint`, `model_midpoint`, and the corresponding fan widths. Specifically the model-side surfaces — not `evidence_y` / `evidence_x`.

#### Test C5: Empirical cancellation identity under non-Dirac source mass

Name: `test_empirical_cancellation_identity_when_source_mass_equals_empirical_n`.

**Contract.** For any edge U→V with empirical row `(n_UV, k_UV)` on source bucket s, when the source mass entering U at bucket s exactly equals `n_UV(s)`, the chart's contribution to V from that bucket must equal `k_UV(s)` at the empirical observation's tau. This is the multi-hop cancellation invariant `M_U(s) = n_UV(s) ⇒ m × k/n = k`. The fixture must place non-Dirac source mass at U.

**Runtime surfaces exercised**:
- §10.3.3 empirical operator per-source-day cumulative read.
- §10.3.4 cohort binding offset.
- §10.3.6 active vs identity-ledger compose path.

**Chart fields asserted**: `evidence_y` at the relevant tau equals `Σ_s k_UV(s)`. The cancellation is empirical-only; model surfaces are not asserted.

This test is the one that the asymmetric midpoint shift at §10.3.6 broke (per investigation §5.2 / §3.1). It must hold uniformly after the global change.

#### Tests C6 onward (placeholders)

The suite must be **complete with respect to the §10.3 inventory**. For every §10.3 subsection, there must be at least one test whose pass/fail outcome depends on that subsection. The suite owner is responsible for adding tests until that coverage is shown — by mechanical reversion of each §10.3 site to its current state and verification that at least one test fails.

If the suite reaches "all tests green" but mechanical reversion of any §10.3 site does not produce a red test, the suite is incomplete and the global change is not provably done.

### 10.6 Outside-In Gates

After the focused algebra tests:

- `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
- `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
- `test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence`
- `test_d1_parity_analytic_vs_bayes_mature_window`

The active cohort evidence tests should remain outside-in canaries. They encode the user-visible expectation that strict evidence tracks actual A-anchored observed reality under controlled fixtures.

### 10.7 Execution discipline (not "implementation order")

Earlier drafts of this section described an 8-step "implementation order" with intermediate completion conditions. **That framing is wrong and has been deleted.** It implied a staged conversion in which each step would leave the runtime in a meaningfully testable state; in practice every intermediate state mixes conventions and produces output that matches neither the source nor the target algebra.

The execution discipline for this change is:

1. **Write the completeness test suite** (§10.5). Each test must be red before any production code changes. If any test in the suite passes against the current half-converted runtime, the test is mis-designed and must be replaced before continuing (see §10.5's "single-file edit cannot turn it green" criterion).
2. **Convert every §10.3 site in a single atomic change.** The granularity is the whole inventory, not a file or a subsystem. A working branch may exist, but no intermediate commit is meaningful as a system state. If `git diff` against `main` partway through the work shows some §10.3 sites converted and others not, the system is in an undefined state.
3. **Re-run the completeness suite.** All tests in §10.5 must pass together; partial passage is failure.
4. **Mechanical reversion audit.** For each §10.3 site, revert that site alone to its current state and verify that **at least one** §10.5 test goes red. If any site can be reverted without any test failing, either the site was unnecessary (drop it from the inventory) or the suite is incomplete (add a test). Both outcomes update §10.3 / §10.5; neither permits the change to ship.
5. **Run outside-in gates** (§10.6) **after** the suite is green and the reversion audit is clean. The outside-in canaries are a consequence of the global change being correctly applied; they are not the acceptance signal. The acceptance signal is §10.5 plus the reversion audit.

The reversion audit in step 4 is the load-bearing discipline. It is what distinguishes a complete global change from a coincidentally-passing half-converted state.

### 10.8 Coverage Checklist

Before calling the implementation complete, explicitly check every row in this matrix:

- `window()` with identity carrier.
- `cohort(A = X)` identity carrier.
- active `cohort(A != X)` real carrier.
- single-hop subject span.
- multi-hop subject span.
- latent timing edge.
- non-latency / Dirac timing edge.
- conditioned model operator.
- empirical strict-evidence operator.
- carrier denominator prefix.
- subject numerator prefix.
- selected A-clock cell support.
- coverage / applicability.
- public endpoint cumulative row fields.

Each case should differ by supplied bucket kernels, roots, and supports. None should require a central branch on query mode, carrier identity, or hop count.

### 10.9 Non-Scope

- Do not change the meaning of DB rows. They remain endpoint cumulative observations.
- Do not weaken the active cohort evidence tests to match the current factorised helper output.
- Do not reintroduce evidence-only midpoint correction.
- Do not add mode branches to the reducer. `cohort()`, `window()`, and identity carrier should differ by supplied bucket kernels and roots, not by central control flow.
