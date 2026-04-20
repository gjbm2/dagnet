# Model-Curve Overlay Divergence: Forensics, Architectural Gap, and B3 Spike Proposal

**Status**: Investigation complete; architectural question identified; B3 spike proposed before further fix work
**Date**: 20-Apr-26
**Relates to**: [doc 8 — Compiler Implementation Phases](8-compiler-implementation-phases.md), [doc 29b — Span Kernel Operator Algebra](29b-span-kernel-operator-algebra.md), [doc 32 — Posterior-Predictive Scoring](32-posterior-predictive-scoring-design.md), [doc 36 — PP Calibration](36-posterior-predictive-calibration.md), [doc 49 — Epistemic Uncertainty Bars](49-epistemic-uncertainty-bars-design.md), [programme.md](programme.md)

---

## 1. Context

What started as a narrow defect — the cohort-maturity main-chart midline and the promoted model-curve overlay don't coincide when they ought to — opened into a larger architectural question: **are we using the Bayes model's Phase 2 insights at all?**

The investigation ran in two layers:
- A **surface layer**: three independent numerical/statistical effects that cause the two curves to diverge. These are each understandable, tractable, and partly already fixable.
- A **deeper layer**: the realisation that the cohort-level single-lognormal posterior emitted by Phase 2 of the Bayes engine (`path_mu_mean`, `path_sigma_mean`, `path_onset_delta_days`) is not consumed anywhere in the forecast stack — only in the overlay branch we were about to eliminate. This means the entire daily cohort() fetch cost, the entire Phase 2 Bayes fit cost, and the entire "a-anchored evidence" design intent were being discarded by the forecast layer. The narrow bug was masking a strategic gap.

This note documents the investigation, decomposes the semantic tension, lays out four possible sophistication extensions to Phase 2, and proposes a workplan that sequences a **B3 spike** (convolution-aware Phase 2) as the determinative next step — on the basis that if B3 works, the other questions dissolve.

## 2. The user-visible symptom

A blind invariant test was added at [graph-ops/scripts/cohort-maturity-model-parity-test.sh](../../../graph-ops/scripts/cohort-maturity-model-parity-test.sh) running four queries on synth-mirror-4step. The invariant: at each τ, `overlay.model_rate[τ] == main.model_midpoint[τ]` within an acceptable tolerance.

| Case | Worst τ divergence | Where |
|---|---|---|
| window_single_hop | 12.88% | τ=10 (near PDF peak) |
| cohort_single_hop_widened | **77.46%** | τ=10 |
| cohort_multi_hop | 3.71% | τ=15 |
| window_multi_hop | 3.71% | τ=15 |

All cases also show a ~0.8% drift at saturation. Three effects stack.

## 3. Three drift sources

### 3.1 Beta median-vs-mean skew (asymptote, <1%, acceptable)

The main chart draws `p_s ~ Beta(α_pred, β_pred)` for S=2000 samples and takes `model_midpoint[τ] = median(p_s × cdf_arr[:, τ])`. At saturation `cdf_arr ≈ 1`, so this reduces to `median(Beta draws)`. The overlay plots `p_mean × CDF_point(τ) = mean(Beta) × 1 = mean(Beta)`.

For skewed Beta distributions — right-skewed when edge rate p < 0.5, left-skewed when p > 0.5 — the mean and median differ. Right-skewed → mean > median → **main midline sits below overlay at asymptote** by 0.5–5% depending on concentration κ. Observed drift (~0.8%) brackets the effective κ to roughly 500–1000.

> **Sidebar — Beta distribution shape.** A Beta distribution describes uncertainty about a proportion (a conversion rate). It's parameterised by two positive numbers α and β; loosely α represents "successes", β represents "failures". The **mean** is α/(α+β) — the simple success rate. The **median** is where the probability density is split 50/50 by cumulative mass. When the mean is below 0.5, the distribution leans toward zero: the long right tail pulls the mean above the median. The effect shrinks as concentration κ = α+β grows. Lots of evidence → tight distribution → mean and median indistinguishable. Little evidence → meaningful skew.

> **Sidebar — Mean vs median as summary statistics.** A distribution has many possible "central" values. The mean is the balance point (where probability mass balances on a see-saw). The median is the 50/50 split point (half the mass sits either side). For symmetric distributions these coincide. For skewed ones they separate. Median is the natural choice when summarising a sample by quantiles (which is how fan bands are constructed — "the 90% fan is the gap between the 5th and 95th percentiles"). Mean is the natural choice for closed-form posterior summaries.

This is sampling math, not a bug. It vanishes as evidence accumulates. For fan-band-centred charts, median is the right summary for both overlay and main — so the fix is not to "reduce the drift" but to align overlay and main on **median** as the universal midline. Drift at <1% then becomes cosmetic rather than semantic. This is accepted.

### 3.2 Discrete cumsum CDF vs analytic CDF (inflection, 12–13% window, 77% cohort widened)

The overlay uses `compute_completeness(τ, μ, σ, onset)` ([forecast_state.py:95](../../../graph-editor/lib/runner/forecast_state.py#L95)) — the continuous analytic lognormal CDF `0.5 · erfc(-(ln(τ−onset)−μ)/σ/√2)`.

The main chart uses `mc_span_cdfs`, which internally delegates to `_run_dp` ([span_kernel.py:290](../../../graph-editor/lib/runner/span_kernel.py#L290)):
1. Evaluate the continuous PDF on the integer grid `{0, 1, ..., max_tau}`
2. Normalise so `Σ pdf[i] = 1`
3. Convolve along graph topology
4. Return `CDF_discrete[τ] = cumsum(pdf)[τ]`

The discrete cumsum is a **rectangle-rule integral** of the PDF, biased by half a grid step:

```
CDF_discrete[τ] = Σ_{k=0..τ} pdf(k) · 1
               ≈ ∫_{-0.5}^{τ+0.5} pdf(x) dx
               = CDF_analytic(τ + 0.5)
```

> **Sidebar — Discretising a continuous distribution.** On a computer we usually store distributions on integer grids. Two natural ways: (a) CDF sampling — evaluate the analytic CDF at integer points; (b) PDF sampling + cumsum — evaluate the analytic PDF at integer points, cumulatively sum. Method (b) gives you a discrete PDF you can convolve (essential for multi-step composition), but it's effectively a rectangle-rule integral, which is `CDF_analytic(τ + 0.5)`, not `CDF_analytic(τ)`. The half-bin shift matters only where the PDF is large (near the peak). For a lognormal peaking near τ = 9 with peak value ~0.18, the rectangle-rule CDF at τ = 10 is ahead of the continuous CDF at τ = 10 by roughly 0.5 × 0.18 = 0.09 — exactly the gap we observe.

> **Sidebar — Why convolve to compose a multi-step path.** If a user traverses two edges sequentially, spending time T₁ on the first and T₂ on the second, the total time is T₁ + T₂. If T₁ and T₂ have known PDFs, the PDF of their sum is the convolution of their PDFs. Discretely on an integer grid this becomes `pdf_total[t] = Σ_s pdf_1[s] · pdf_2[t-s]`. It's how multi-edge path CDFs are built.

This is a deterministic construction mismatch — not MC noise. Both sides evaluate the same lognormal parameters and disagree by construction. The original framing suggested two independent fix directions: (a) unify overlay with main (both use discrete DP) and (b) upgrade main's discretisation to reduce its half-bin bias. The 20-Apr-26 spike on (b) showed it is not a drop-in improvement — see the sidebar below — so the practical path is (a) alone: unify overlay and main on the same discrete construction, and accept the rectangle-rule convention as our definition of "the discrete CDF". The underlying half-bin bias becomes a shared convention rather than a divergence source.

> **Sidebar — Is the rectangle-rule cumsum a defect or just a choice?** It has a measurable bias of half a bin near sharp peaks, but that bias is **constant with depth**. A natural-looking "fix" is to use CDF-differences (`f[k] = CDF(k) − CDF(k−1)`, i.e. mass in interval (k−1, k]). This gives `cumsum[τ] = CDF(τ)` exactly for a single edge, but under convolution it compounds badly: for two edges, the atom-sum interpretation means `cumsum(conv)[τ] ≈ CDF_sum(τ − 1)`, because `⌈X_A⌉ + ⌈X_B⌉` is on average 1 greater than `X_A + X_B`. For N edges the shift grows linearly. The rectangle rule's half-bin bias stays constant at 0.5 regardless of depth, because integer rounding is unbiased. A P0 spike (20-Apr-26) confirmed this empirically: replacing rectangle with CDF-differences improved single-edge window case from 12.88% to 4.63% at τ=10, but regressed 2-edge multi-hop from 3.71% to 20.27% at τ=15. The spike was reverted.
>
> A genuinely unbiased fix requires either a finer grid (expensive) or a scheme that stays exact under convolution — neither is a drop-in replacement. For now, the rectangle-rule convention is kept and its half-bin lead is accepted as the definition of "the discrete CDF at τ".

### 3.3 path_mu_mean scalar fit vs FW composition (cohort widened, extra ~65%)

In cohort mode with `anchor ≠ from_node` (widened span), the main chart composes a genuine anchor-to-Y path CDF by FW-convolving **per-edge** lognormal posteriors. Each MC draw picks fresh (p, μ, σ, onset) for every upstream edge from A to Y, convolves them, cumsums. The resulting shape reflects the composed per-edge distributions — generally not itself a lognormal.

The overlay reads scalar `path_mu_mean`, `path_sigma_mean`, `path_onset_delta_days` from the target edge's `posterior.latency` block and draws `compute_completeness(τ, path_mu_mean, path_sigma_mean, path_onset)` — a **single** analytic lognormal CDF. These scalars come from Phase 2 of the Bayes engine, which fits a single lognormal to observed anchor-to-Y timings (see §4 below).

> **Sidebar — Fenton-Wilkinson and why a sum of lognormals isn't a lognormal.** If X₁ and X₂ are independent lognormal, X₁ + X₂ is **not** lognormal — it has a different shape, usually with heavier tails and a delayed start. The Fenton-Wilkinson (FW) approximation matches the first two moments of the true sum with a single lognormal, accepting a shape error. The error is biggest near the inflection point (where the CDF rises fastest) and vanishes at asymptote. For compound paths with many edges or large per-edge dispersions, the FW approximation degrades.

These are two independent objects computed from independent evidence and they can differ substantially. The overlay effect stacks with 3.2, giving the 77% divergence.

## 4. The architectural discovery

Investigating where `path_mu_mean` comes from and where it's consumed produced a surprise.

### 4.1 Where it comes from

Phase 2 of the Bayes compiler ([bayes/compiler/model.py:1116-1253](../../../bayes/compiler/model.py#L1116-L1253), supported by `_resolve_path_latency` at [line 3180](../../../bayes/compiler/model.py#L3180)):

1. **FW-compose Phase 1 edge-level posteriors** into path-level `(onset_path, mu_path, sigma_path)`. This is used as the Phase 2 **prior centre**.
2. **Create cohort-level latent variables** `onset_cohort`, `mu_cohort`, `sigma_cohort` — a single-lognormal parameterisation of path latency.
3. **Fit those cohort latents to cohort-level observation data** (anchor-to-Y timings). The posterior can pull away from the FW prior centre toward a different single lognormal.
4. **Emit `path_mu_mean`, `path_sigma_mean`, `path_onset_delta_days`** as posterior means of the cohort-level latents.

So `path_mu_mean` is **a single-lognormal summary of a-anchored path timings** — explicitly designed to capture what FW composition of edge-level window() fits cannot see (temporal drift, population composition changes, upstream-path mixture effects).

### 4.2 Where it's consumed

Phase 2 emits two distinct cohort-level posteriors that need to be tracked separately:

**(a) Cohort-level probability posterior (`cohort_alpha`, `cohort_beta`)** — partially consumed.

- `resolve_model_params` at [model_resolver.py:302-308](../../../graph-editor/lib/runner/model_resolver.py#L302-L308) reads `cohort_alpha`/`cohort_beta` when called with `temporal_mode='cohort'` and populates `resolved.alpha`, `resolved.alpha_pred`, `resolved.p_mean`. These flow into `compute_forecast_trajectory` as `_p_mean`, `_p_sd`, and the `_drift_alpha`/`_drift_beta` used for IS conditioning drift priors — so the cohort-mode p posterior does influence the conditioning machinery.
- **However**, in the hot forecast path where `mc_cdf_arr` is provided, the actual MC draws of p used for `rate_model` (and therefore for the midline at asymptote) come from `mc_p_s`, which is emitted by `mc_span_cdfs`. `mc_span_cdfs` reads **window-mode** `alpha`/`beta` via `_extract_edge_params` ([span_kernel.py:142-148](../../../graph-editor/lib/runner/span_kernel.py#L142-L148)); it does not look at `cohort_alpha`/`cohort_beta`. So the MC midline at saturation reflects the window-mode Beta posterior, not the cohort-mode one.
- Net effect: `cohort_alpha`/`cohort_beta` are partially plumbed through — they alter IS conditioning priors and scalar summaries like `edge_results.p_mean`, but they don't drive the MC draws that produce the chart's visible midline or fan.

**(b) Cohort-level path latency posterior (`path_mu_mean`, `path_sigma_mean`, `path_onset_delta_days` + SDs)** — completely unused by the forecast stack.

- `cohort_forecast_v3.py:340` calls `resolve_model_params(..., scope='edge')` — scope=`edge` means `path_latency` is never populated on the resolved object.
- `compute_forecast_trajectory` consumes `mc_cdf_arr` from `mc_span_cdfs`, which does FW composition of per-edge posteriors. `mc_span_cdfs` doesn't look at `path_mu_mean` either.
- `handle_conditioned_forecast` ([api_handlers.py:2609](../../../graph-editor/lib/api_handlers.py#L2609)) uses the same v3 pipeline and reads `p_infinity_mean` from the last row. It never touches `path_mu_mean`.

The only place `path_mu_mean` is read for a user-visible purpose is [api_handlers.py:2413](../../../graph-editor/lib/api_handlers.py#L2413), in the cohort-overlay branch. Eliminating that branch (the natural conclusion of §3's overlay-main parity fix) would complete the disconnection: Phase 2's fitted **path latency** posterior would be emitted, stored, and ignored.

The cohort probability posterior has a partial story — used for conditioning priors but not for the visible midline's asymptote. The cohort latency posterior has no story at all.

### 4.3 Why this matters

The stated rationale for collecting cohort() data in the daily fetch pipeline is that in deep graphs, a-anchored empirical evidence is higher-quality than FW composition of window()-mode edge fits. Reasons:

- **Temporal drift**: if path latency is days or weeks, the population entering anchor A in window T0..T1 may differ meaningfully from the population seen by downstream edges during T1..T2 (the conversion window). Per-edge window() fits average over both populations; cohort() fits are restricted to A's entrants and so preserve the distinction.
- **Composition drift**: regime changes, marketing campaign shifts, seasonality — all of these can mean the anchor cohort's journey through the path isn't well-represented by per-edge fits done on different time windows.
- **Approximations multiply in deep graphs**. FW composition of per-edge posteriors stacks multiple sources of approximation error — each edge's own lognormal family assumption, then the FW assumption that their sum is itself lognormal, then the discretisation rule used to convolve PDFs, then MC sampling. None of these is individually large, but they compound multiplicatively along long paths. Direct a-anchored fitting collapses the chain into a single approximation (one family assumption at path level, fit to the real observable), trading compound error for a single measurable error.

The fact that the forecast pipeline ignores `path_mu_mean` (and only partially consumes `cohort_alpha`/`cohort_beta`) means:
1. We're paying daily cohort() fetch cost for the a-anchored timing signal that feeds Phase 2's path-latency fit, but the latency output isn't used in forecasts.
2. We're paying Phase 2 Bayes fit cost for path-latency posteriors that are emitted and stored but never drive a visible output.
3. Deep-graph latency forecasts carry the stacked compound approximation error that cohort() evidence was meant to correct.
4. Temporal and composition drift affecting path-level latency shape are unaddressed in forecasts, even though cohort() evidence would reveal them.

The partial consumption of `cohort_alpha`/`cohort_beta` for IS drift and scalar summaries softens (1) and (2) somewhat — the cohort-level rate posterior isn't *wholly* wasted. But the path-latency posterior, which is the Phase 2 output specifically designed to carry path-level shape information (composition and drift effects) is entirely absent from forecast construction.

### 4.4 Inadequacy of single-lognormal cohort fit is a modelling problem, not a reason to abandon cohort fits

One natural-sounding argument for discarding `path_mu_mean` would be: "the single-lognormal family isn't adequate for genuinely branching or long-path timing distributions, so the cohort fit is poorly calibrated, so we're right to prefer FW composition instead." This argument is wrong in a specific and important way.

When cohort-level single-lognormal fit is inadequate for a topology (say, a branch-point join where true path timing is bimodal), we have two options:

- **Swap to FW composition of per-edge posteriors** (what the pipeline does today): this hides the problem. FW also fits a single lognormal at path level, just via a different route (moment-matching of the convolution sum). It has its own shape error for the same topological reason — sums of lognormals aren't lognormal. The two bad approximations produce different numbers, but neither accurately represents a bimodal distribution. Choosing the FW route lets us tell ourselves we're avoiding the cohort-fit problem while silently inheriting an equivalent structural failure.

- **Upgrade the cohort-level model** (B1, B2, B3 in §5): this surfaces the problem. If single-lognormal fit is inadequate, fit a mixture (B1) or a different family (B2) or restructure the fit as edge-level refinement (B3). The path-level fit quality becomes a first-class diagnostic — visible via PPC, posterior k-hat, coverage. We find out which topologies need more sophistication rather than masking the failure.

So the right response to "cohort single-lognormal fit is inadequate for this topology" is **"extend Phase 2"**, not "fall back to FW". Otherwise we're paying Phase 2's cost to fit a model whose limitations we then route around rather than learn from. This is the strategic motivation for putting the B3 spike ahead of any overlay refactor: the spike decides whether we extend Phase 2 (in which case path_mu_mean becomes obsolete but cohort evidence genuinely flows into forecasts) or accept Phase 2's current form with PPC-gated fallback (in which case we carry the limitation knowingly and diagnostically).

### 4.5 Two coherent positions

**Position 1 — graph-structural construction (current CF behaviour)**. Every curve and every forecast value composes from per-edge posteriors via FW. `path_mu_mean` is dead weight: emitted by the Bayes compiler, never consumed by forecast. Clean, unified, loses Phase 2's insights.

**Position 2 — a-anchored path posterior (what the overlay partially does)**. When available (bayesian source, cohort mode, Phase 2 fit present, PPC gate passed), draw path latency from `path_mu_mean`/`path_sigma_mean` posterior directly. FW composition as fallback. Honours Phase 2's insights; introduces branching by source into the sweep; still has the single-lognormal limitation (§3.3).

Neither is ideal. Position 1 systematically discards Phase 2's evidence. Position 2 introduces branching and still fits a family (single lognormal) that may not be right for compound paths.

## 5. Phase 2 sophistication extensions

The Position 1/2 tension is only a tension because Phase 2's output is a scalar summary that doesn't compose. Four extensions to Phase 2 could dissolve this — the first three by upgrading the path-level fit, the fourth by replacing it.

### B1. Mixture of lognormals (per-branch)

Where single-lognormal fails: **graphs with branch-point joins upstream of the target**. Two alternative paths from A to X contribute two-modal timing; a single lognormal averages them, losing modality. Fit `path_timing ~ Σ_k w_k · LogNormal(μ_k, σ_k) + onset_k` with K determined by topology.

Cost: adds mixture weights (slow-mixing sampling without strong priors). Moderate. Value: large for wide topologies.

### B2. Non-lognormal path latency family

Where single-lognormal fails: **long sequential paths**. The sum-of-N-lognormals has heavier tails and later rise than any single lognormal; error grows with N. Fit a family that captures sum-shape better — shifted Gamma, Pearson IV, spline CDF.

Cost: moderate. Value: moderate. A diagnostic-driven decision once we know whether residuals are systematic or random.

### B3. Convolution-aware Phase 2 (edge-level refinement)

The deepest reframe. Instead of fitting a single-lognormal at path level, redesign Phase 2 as an **edge-level refinement pass** conditioned on a-anchored observations. The Bayes compiler still composes Phase 1 edge posteriors into a path-level prior (as it does now), but Phase 2's latents are per-edge: refined `(μ_e, σ_e, onset_e)` per edge on the path, fitted against cohort-level timing evidence.

The output is **improved per-edge posteriors**, not a path-level summary. FW composition of these improved per-edge posteriors is then no longer a crude approximation — it's the correct construction, backed by both per-edge window() evidence (Phase 1) and a-anchored path() evidence (Phase 2).

Consequences:
- `path_mu_mean` and friends **disappear** from the emitted posterior. They were a summary, not a source of truth.
- Position 1 becomes genuinely good: the main chart's FW composition now uses per-edge posteriors that have been informed by a-anchored evidence. No Position 2 fallback needed.
- Overlay-main parity becomes trivial: both use the same FW construction, from the same (now improved) per-edge posteriors.
- Temporal drift effects propagate through per-edge parameters naturally — if A's cohort sees different edge timings downstream than the general edge population, Phase 2 absorbs that into edge-specific posterior shifts.
- No single-lognormal family constraint at path level because we don't fit at path level.

Cost: high — restructures Phase 2 fundamentally. Value: highest — resolves the architectural tension without introducing branching in the forecast stack.

**The key question for B3 is identifiability**: can per-edge latents be recovered from aggregate A→Y timing observations? The path timing is a sum of edge timings; separating it into components requires either additional per-edge evidence (which Phase 1 provides via window() fits) or structural prior constraints. If the edge-level priors from Phase 1 are informative enough, the path-level observations can refine them while preserving per-edge identifiability. If not, the posterior on per-edge latents may be poorly constrained and the "refinement" is illusory.

### B4. Non-parametric path latency

Abandon parametric families entirely: fit a piecewise-linear or spline-based path CDF from a-anchored observations. Dirichlet Process prior. Large-scale research direction. Produces path-level summaries that don't compose across further edges — so it's terminal, not a building block. Probably last-resort.

### Why B3 is determinative

If B3 works, the entire Position 1 vs Position 2 question dissolves. Per-edge posteriors become a-anchored-informed; FW composition of them is correct; `path_mu_mean` is obsolete; overlay-main parity becomes trivial. The whole forecast pipeline converges on a single, principled construction.

If B3 doesn't work (identifiability fails, or the per-edge refinement is too weak to be worth the complexity), we fall back to a choice between: Position 1 with PPC-gated Position 2 fallback for cohort widened/multi-hop modes, or accepting the information loss of Position 1 universally while pursuing B1/B2 to improve the path-level fit family.

Either way, **the answer to B3 determines the scope of every downstream decision**. It should be spiked before we invest in overlay refactors or forecast-pipeline changes driven by the current architectural mismatch.

## 6. Workplan

### Phase 0 — Tightening the invariant and staging (concurrent with B3 spike)

These are safe to do regardless of B3 outcome; they improve correctness independently.

**P0.1**. Attempted on 20-Apr-26: switch main chart's discrete PDF from rectangle rule to CDF-differences in `_edge_sub_probability_density`. **Reverted.** The spike showed that CDF-differences reduce single-edge bias but regress multi-edge convolution (depth-linear shift instead of rectangle rule's constant half-bin bias). See §3.2 sidebar. Upshot: the rectangle rule is the right convention and its half-bin lead is accepted as the discrete CDF semantic. Reducing the underlying half-bin bias vs the true continuous CDF remains an open question — would need a finer grid or a convolution-preserving scheme. Parked as longer-term.

**P0.2 + P0.4 (combined)**. Completed 20-Apr-26. Overlay refactored to route through the span kernel for all modes/hops, using the main chart's own `_mc_cdf_v3` / `_mc_p_v3` arrays for the promoted curve and `mc_span_cdfs_for_source` for per-source curves. Midline is MC median across those draws at each τ; bands are MC quantiles. Span topology matches the main chart's `_span_x` decision (widened anchor→to_node in single-hop cohort with anchor ≠ from_node; edge-span otherwise). The overlay no longer reads `path_mu_mean`/`path_sigma_mean`/`path_onset_delta_days`; `compute_completeness` is no longer called from overlay construction.

Initial parity test result: 0.00% divergence at every sampled τ across all four synthetic cases. Tolerance tightened from 1.0% to 0.1% and still passes.

Follow-up fix (same day): production probe revealed per-source curves were drawn with widened-span cumulative p (`_src_span_p`), not target-edge p. The promoted curve was fine because it already combined widened-CDF with separately-computed edge-p (`_mc_p_v3` overwritten by the second `mc_span_cdfs` call on edge topology). Per-source curves now do two `mc_span_cdfs_for_source` calls when the span is widened — one on widened topology for the CDF shape, one on edge topology for the p scalar — mirroring the promoted-curve pattern. For non-widened cases, one call suffices. The parity test was extended with a sanity check that each per-source curve's peak approaches its own `forecast_mean` (within at least 10% — a coarse but effective gate against p-scaling bugs). Would have caught the bug had the synthetic test graphs had bayesian posteriors; the synth-mirror-4step graph used in tests only has analytic model_vars, so the bayesian-specific path was exercised only on production data.

**P0.3**. Parity test `cohort-maturity-model-parity-test.sh` remains in place as the durable guard. Tolerance tightened to 0.1% post-P0.2+P0.4. Tolerance interpretation: measures overlay-main parity on the rectangle-rule-convention discrete CDF. It does not measure correctness against the true continuous CDF — that's a separate concern documented in §3.2.

### Phase 1 — B3 spike (determinative)

The spike should be scoped tightly to answer one question: **can Phase 2 be restructured as edge-level refinement, and do the refined per-edge posteriors meaningfully differ from Phase 1 edge posteriors on synthetic data where the true cohort-level timing differs from FW composition?**

**P1.1**. Design the convolution-aware Phase 2 model structure. Per-edge latents for each edge on the path, prior centred on Phase 1 edge posteriors, likelihood on observed anchor-to-Y timings through FW composition of the per-edge lognormals. Document the identifiability analysis — under what conditions can per-edge params be recovered from aggregate path timings.

**P1.2**. Build synth test cases designed to exercise the regime where B3 should add value:
- **Synth-A**: path where Phase 1 edge fits are accurate; FW composition matches cohort evidence. B3 should not meaningfully change per-edge posteriors (null case — does it leave them alone?).
- **Synth-B**: path where cohort evidence has drifted from Phase 1 edge fits (simulate a temporal-drift scenario). B3 should pull per-edge posteriors toward the drift. Can we detect this?
- **Synth-C**: branching path where single-lognormal fit at path level is visibly wrong. B3 should produce per-edge posteriors that reflect the mixture when composed.

**P1.3**. Evaluate B3 quality via existing tooling:
- ΔELPD comparing B3 per-edge fits vs Phase 1-only edge fits on held-out data.
- `pareto_k_max` for B3 posteriors.
- PPC coverage on predicted path timing against observed.
- Posterior parameter SDs: do B3 refined fits have tighter SDs (more information) or wider (identifiability problem)?

**P1.4**. Decision gate. Does B3 meaningfully refine per-edge posteriors in the Synth-B/C scenarios without degrading the Synth-A null? Is posterior quality (ΔELPD, Pareto k, PPC) acceptable?

- **If yes**: proceed to Phase 2A (B3 implementation).
- **If no**: proceed to Phase 2B (Position 1/2 reconciliation).

### Phase 2A — B3 implementation (if spike passes)

**P2A.1**. Extend the Bayes compiler's Phase 2 to emit refined per-edge posteriors (`alpha_refined`, `beta_refined`, `mu_refined`, `sigma_refined`, `onset_refined` with SDs) on edges that participated in cohort-level observations. Retire `path_mu_mean` / `path_sigma_mean` / `path_onset_delta_days` from the posterior schema. Add a schema-drift migration (the field goes away; FE/BE/tests all adapt).

**P2A.2**. Update `resolve_model_params` to consume refined per-edge posteriors when available, falling back to Phase 1 edge posteriors otherwise. `mc_span_cdfs` inherits these automatically — it reads per-edge posterior fields, so improving the values automatically improves the composition.

**P2A.3**. Overlay construction: remove the path_mu_mean branch entirely; all overlays compose via `compose_span_kernel_for_source` or equivalent using the refined per-edge posteriors. Main chart and overlay now coincide by construction.

**P2A.4**. Tighten the parity test tolerance. With P0.1 (trapezoidal) and P0.2 (median) done, and B3 giving unified per-edge construction, the parity test should pass at tolerance near MC noise floor (~0.5% or tighter).

**P2A.5**. Documentation and schema updates across docs 8, 29, 49 to reflect the unified construction.

### Phase 2B — Position 1/2 reconciliation (if B3 spike fails)

Fall back to the more modest plan. Less architecturally clean but deliverable.

**P2B.1**. PPC gating: compute a per-edge diagnostic on cohort-level fit quality (`pareto_k_max < 0.7`, `delta_elpd > 0`, PPC PIT uniformity). Flag per-edge in posterior whether cohort fit is "trusted" for forecast consumption.

**P2B.2**. Extend `compute_forecast_trajectory` to accept a cohort-level CDF source. When bayesian source is promoted, cohort widened/multi-hop mode, and edge is flagged "trusted", draw `(path_μ, path_σ, path_onset)` from cohort posterior and use analytic CDF per draw. Otherwise fall back to `mc_span_cdfs` (current behaviour).

**P2B.3**. Overlay construction follows the same logic as the sweep: use cohort fit where it's trusted and available, FW composition otherwise. Main chart and overlay coincide by using the same source selection rule.

**P2B.4**. Diagnostic surfacing: users toggling between sources see which regime each edge is in (cohort-fit trusted, FW fallback, Phase 1 only). This makes the information loss vs B3 visible.

**P2B.5**. Consider B1 / B2 as longer-term improvements to the path-level fit family. Diagnostic data from PPC gating in P2B.1 informs which extension is most valuable.

## 7. Decisions independent of B3 outcome

These improvements are valuable and safe regardless of which path Phase 1 leads us down. Stage them in P0 and don't block on the B3 spike.

- **Trapezoidal PDF discretisation** (P0.1). Upgrading `_edge_sub_probability_density` reduces main-chart CDF bias independently of everything else. If B3 lands, the improvement carries through to the refined posterior's own CDFs.
- **Median as universal midline** (P0.2). Aligns summary statistic choice across chart elements. Makes the Beta-skew residual invisible.
- **Contract test in place** (P0.3). Durable guard against regressions in either direction.
- **Audit of `mc_cdf_arr` consumers at fine τ** (no P0 number). If anything else downstream reads `CDF_at(τ)` for small τ, the half-bin shift may matter there too. Worth spotting before P0.1 lands.

## 8. Residual questions

Flagged for future work but not gating anything current.

- **Should p summaries (forecast_mean, p_infinity_mean) be mean or median?** Current is a mix: `forecast_mean` is the posterior mean, `p_infinity_mean` is MC median from the sweep. These diverge for skewed Betas. Worth aligning.
- **Do asymptote-level p reports (the converged conversion rate) need both mean and median exposed?** For decision-making, one value needs to win. Median is more robust to the mean-vs-median skew; mean is more additive-consistent. Not urgent but worth documenting the choice.
- **What's the long-term story for Phase 3 sophistication?** B1/B2/B4 don't disappear even if B3 lands. For graphs where B3 delivers but can't fully capture (e.g. very wide branching with mixture modes), B1 may still add value layered on top. No need to decide now.

## 9. Summary

The narrow overlay-main divergence is a user-visible symptom of a deeper architectural issue: Phase 2 of the Bayes compiler emits a path-level **latency** posterior that the forecast stack doesn't consume, and a path-level **probability** posterior whose consumption is partial (used for IS conditioning drift priors and scalar summaries, not for the MC midline draws). Resolving the narrow issue in the obvious way (eliminate the overlay's use of `path_mu_mean`, converge both sides on FW composition) would make the disconnection of path latency permanent.

The B3 extension — restructuring Phase 2 as edge-level refinement — potentially dissolves the architectural tension entirely by making FW composition correct, backed by both per-edge and a-anchored evidence. If it works, path_mu_mean becomes obsolete and the whole pipeline converges on a single construction. If it doesn't, we fall back to a Position 1/2 reconciliation with explicit PPC gating.

The right sequencing is: B3 spike first, as a focused investigation answering one determinative question. Safe improvements (trapezoidal, median-alignment, contract test) proceed in parallel. Only after the B3 outcome is clear do we invest in overlay or forecast-pipeline refactors.
