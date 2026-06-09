# Rao-Blackwellised Primitive Conditioning — Proposal for Review

**Date:** 9-Jun-26 (supersedes the options-analysis revision of the same date; basis decision recorded 9-Jun-26)
**Status:** implemented and **default-on** (9-Jun-26). The request-only `norbcond` URL parameter is the kill switch restoring the legacy joint path; `essthreshold` still selects the legacy tempered branch and takes precedence over both. §7 records the implementation decisions. The §6 production validation items remain to be run against the live default.
**Scope:** the importance-sampling scheme inside the conditioned-forecast primitive conditioner (`graph-editor/lib/runner/primitive_conditioning.py`). The proposal (a) changes how the posterior is *approximated* — marginalising the probability dimension instead of guessing it — and (b) corrects the conditioning prior to the **basis prior**: epistemic dispersions for conditioning, predictive dispersions reserved for the forecasting (FC) surface (§3.5, decided 9-Jun-26). It does not change the latency model family, the evidence pipeline, or any downstream consumer contract.
**Relationship to other documents:** this proposal replaces the p-guided Stage 1 direction in `adaptive-full-likelihood-primitive-conditioning-proposal-30-May-26.md`. That plan's request/URL/cache plumbing pattern remains the rollout template; its statistical core is superseded by this note.

**Audience note.** Written to be engageable by a reviewer who does not know this codebase. Domain terms are defined as they appear; an appendix maps the mathematical objects onto code symbols for maintainers.

---

## 1. Problem Statement

### 1.1 What the conditioner does

The system models conversion funnels as DAGs. Each edge carries a conversion probability `p` (the fraction of users at the source who eventually convert) and, for **latent** edges, a latency distribution describing how long conversions take. The latency family is a shifted log-normal: parameters `θ = (μ, σ, δ)` where `δ` is an onset dead-time. The induced **completeness curve** `F_θ(τ)` is the fraction of eventual converters observed by cohort age `τ`.

An offline Bayesian fit supplies, per edge, an aggregate prior: a Beta distribution on `p` and Gaussian parameter uncertainty around `(μ, σ, δ)`.

At query time, the **primitive conditioner** updates that aggregate prior against query-scoped evidence: repeated observations of dated cohorts (a cohort of size `n`, observed at several ages, with cumulative conversion counts at each observation). The output is a set of `S` posterior particles — paired draws `(p_s, F_s)` of probability and completeness curve — consumed by downstream forecast composition. `S` is fixed per request (`mc_draws`, currently defaulting to 500; the graph-enrichment conditioned-forecast endpoint deliberately reduces it to `max(64, mc_draws / 10)` — 64 at current defaults). The pairing of `p` draws with timing draws at the same index is a load-bearing contract ("draw-family coherence").

One further fact about the probability prior matters throughout this note. The aggregate fit supplies **two** Beta pairs per edge: an epistemic pair `(α, β)` describing posterior uncertainty in the rate, and a wider predictive pair `(α_pred, β_pred)` inflated for observation noise. The conditioner is invoked per **dispersion basis**: the epistemic basis feeds the conditioned model surface, the predictive basis feeds the frontier-conditioned forecasting (FC) surface. We write the active basis's prior pair `(a₀, b₀)` and call it the **basis prior** — `(α, β)` under the epistemic basis, `(α_pred, β_pred)` under the predictive basis.

Today's latent path deviates from this in one place: under the epistemic basis it samples its probability candidates from the *predictive* pair when fitted — as a deliberately wide importance-sampling coverage envelope — and weights by **likelihood only**, with no proposal-correction term. The distribution it actually converges to is therefore `predictive pair × likelihood`, not `epistemic pair × likelihood`: the coverage envelope has silently become the de facto conditioning prior. The non-latent (instant-conversion) path has no such envelope and conjugates against the basis prior correctly — so latent and non-latent edges currently disagree about which prior they condition. This note treats the envelope-as-prior behaviour as a defect of the sampling scheme, and §3.5 records the decision to correct it: conditioning uses epistemic dispersions; predictive dispersions are reserved for the FC surface. The correction is *enabled* by the proposed scheme, because marginalisation removes the `p` proposal — and with it the only reason the envelope existed.

### 1.2 The likelihood (as implemented)

For one cohort `d` with weighted size `n_d`, observed at ages `τ_{d,1} < … < τ_{d,m}` with cumulative weighted counts `k_{d,1} ≤ … ≤ k_{d,m}`, the implemented likelihood for a candidate `(p, θ)` is the multinomial trajectory likelihood:

```
log L_d(p, θ) = Σᵢ Δk_{d,i} · log( p · ΔF_θ(τ_{d,i}) )
              + R_d · log( 1 − p · F_θ(τ_{d,m}) )
```

where `Δk_{d,i}` is the count increment between consecutive observations, `ΔF_θ` the matching completeness increment, and `R_d = n_d − k_{d,m}` the residual not-yet-converted mass at the final observed age. The full likelihood sums over cohorts. This scores the **whole observed trajectory shape**, not just the endpoint: each increment must land in the right age cell with the right mass.

### 1.3 The current sampler and its failure

The current scheme is importance sampling with prior-shaped proposals:

1. draw `S` probability candidates from the proposal envelope (the predictive pair where fitted — §1.1) and `S` timing candidates from the latency parameter prior;
2. score each joint pair with the full likelihood at temperature `λ = 1` (likelihood-only weights — no proposal correction, so the realised target is `envelope × likelihood` rather than `basis prior × likelihood`);
3. self-normalise the weights and resample `S` unweighted pairs by those weights.

Two production symptoms motivated this work:

- **Over-narrow, unstable bands.** After weighting, a handful of particles carry nearly all the mass. The resampled set is many duplicates of a few survivors: bands collapse to the spread of those few particles, and the midpoint is sensitive to which particles happened to be lucky.
- **Silent evidence discard.** With large counts, log-weight ranges exceed what normalisation can survive; the conditioner falls back to prior-only (`is_failed`), discarding all evidence.

A legacy mechanism — restored temporarily behind the `essthreshold` URL parameter — "fixed" this by searching for a likelihood temperature `λ < 1` that keeps the effective sample size (ESS) above a floor. That changes the posterior target: it weakens scoped evidence precisely when the evidence is sharp or surprising, biasing the answer toward the prior. It is agreed to be statistically distortive and is retained only as a comparison path.

### 1.4 Why the failure is structural, not a tuning problem

Two facts, from first principles:

**Particle demand grows exponentially with evidence sharpness.** Importance sampling from the prior requires the proposal to place particles inside the posterior's effective support. The number of particles needed scales like the exponential of the Kullback-Leibler divergence from prior to posterior. With counts in the hundreds across multiple cohorts, the joint posterior over `(p, μ, σ, δ)` occupies a vanishing fraction of the prior's support. No fixed particle budget survives this; raising `S` (or adding adaptive batches) fights an exponential with a linear budget.

**The probability axis dominates the collapse.** Counts enter the likelihood exponentially through `p`. A particle with an excellent timing curve but `p` a few percentage points off the evidence-compatible value is annihilated. Most of the particle budget therefore dies on the `p` axis regardless of timing quality. This is the dominant mechanism behind both symptoms.

There is also a confounded failure mode that any solution must respect: for **immature cohorts**, `p` and `F` are weakly identified — the data constrain roughly the product `p · F(τ)`. Since the log-normal family is itself a rough approximation, a scheme that aggressively "finds" the best `p` under a wrong-but-trusted `F` converts latency misspecification into confident probability error. An earlier draft of this work proposed an evidence-guided `p` proposal; it was rejected during internal review for exactly this reason — it guesses the posterior's shape using the least trustworthy part of the model.

---

## 2. The Key Structural Observation

One implementation fact must be carried into the notation before anything else: the evidence counts themselves are **draw-indexed**. Each timing particle induces its own arrival-weighting of the snapshot rows, so particle `s` sees its own weighted counts — increments `Δk_{d,i,s}`, cohort sizes `n_{d,s}`, residuals `R_{d,s}`. The counts are functions of the timing particle, `K_s ≡ K(θ_s)`, not request-level scalars. This is load-bearing for active-cohort and multi-hop requests, where arrival weights vary materially across particles; an implementation that substitutes scalar totals for the per-draw arrays changes the likelihood.

Write the full likelihood's dependence on `p`, for one **fixed** timing particle `θ_s`:

```
log L(p, θ_s) = K_s · log p  +  C(θ_s)  +  Σ_d R_{d,s} · log( 1 − p · F_{d,s} )
```

where:

- `K_s = Σ_d Σᵢ Δk_{d,i,s}` — particle `s`'s total observed conversion increments. Given the particle, it is a constant coefficient on `log p`.
- `C(θ_s) = Σ_d Σᵢ Δk_{d,i,s} · log ΔF_{θ_s}(τ_{d,i})` — the timing-shape term. It does not involve `p`.
- `F_{d,s} = F_{θ_s}(τ_{d,m})` — particle `s`'s completeness at cohort `d`'s final observed age. The residual terms couple `p` and the particle only through the products `p · F_{d,s}`.

Conditional on a timing particle, the likelihood in `p` is therefore a one-dimensional function:

```
L(p | θ_s) ∝ p^{K_s} · Π_d ( 1 − p · F_{d,s} )^{R_{d,s}}
```

Each factor is log-concave in `p`, so the product is log-concave. Multiplied by the basis prior `Beta(a₀, b₀)` (§1.1), the conditional posterior on `p` is a smooth, unimodal, one-dimensional density on `(0, 1)`.

This near-conjugate structure is currently ignored: the sampler treats `p` as just another coordinate to guess. The proposal is to stop guessing it.

---

## 3. Proposed Scheme

Marginalise what is tractable; sample only what is not. Throughout, `π` denotes the corrected target — `Beta(a₀, b₀) × likelihood`, normalised, with `(a₀, b₀)` the basis prior (§1.1, §3.5). The joint factorises as

```
π(θ, p | data) = π(θ | data) · π(p | θ, data)
```

and the scheme targets each factor with the appropriate tool:

**Step 1 — timing particles (unchanged).** Draw `S` timing particles `θ_s` from the latency parameter prior, exactly as today, from the same keyed random-number stream. (These particles are shared infrastructure: the same draws define evidence arrival-weighting elsewhere in the request. Not touching them is a hard constraint, and this scheme does not touch them.)

**Step 2 — marginal weight per timing particle.** For each `θ_s`, integrate `p` out of the likelihood against the basis prior — epistemic `(α, β)` on the epistemic basis, predictive `(α_pred, β_pred)` on the predictive/FC basis:

```
m_s = e^{C(θ_s)} · ∫₀¹ Beta(p; a₀, b₀) · p^{K_s} · Π_d (1 − p · F_{d,s})^{R_{d,s}} dp
```

Every exponent is particle-indexed (`K_s`, `R_{d,s}`, `F_{d,s}`): the integral consumes each particle's own arrival-weighted counts. This is a one-dimensional integral of a smooth log-concave integrand, evaluated by fixed-grid quadrature in log space (vectorised across all `S` particles simultaneously). `m_s` is the marginal likelihood of timing particle `s` — "how well can this timing curve explain the trajectory, letting `p` be anything the basis prior allows?"

**Step 3 — weight and resample timing particles.** Self-normalise `w_s ∝ m_s` and resample `S` timing indices. ESS is computed on these marginal weights — this becomes the meaningful particle-quality diagnostic. Low-variance resampling (systematic or residual) is preferred over multinomial to avoid adding resampling noise.

**Step 4 — exact conditional draw of `p`.** For each resampled timing particle, draw `p` from its one-dimensional conditional posterior `π(p | θ_s, data) ∝ Beta(p; a₀, b₀) · p^{K_s} · Π_d (1 − p·F_{d,s})^{R_{d,s}}` by inverse-CDF sampling on the same quadrature grid, using a dedicated keyed random-number derivation.

**Step 5 — emit.** The output is `S` coherent pairs `(p_s, F_s)` — the same shape, the same pairing contract, the same downstream consumers as today. The subsequent doc-52 compatibility blend and all composition/projection layers are untouched.

### 3.1 Correctness

Steps 2–3 are self-normalised importance sampling targeting the timing marginal of `Beta(a₀, b₀) × likelihood`, with the same timing proposal as today, scored with the exact `p`-marginalised likelihood. Step 4 samples the matching conditional exactly (up to quadrature grid resolution). There is no tempering, no proposal guessing, and no statistical tuning parameter. The only new constants are numerical-resolution choices (grid size, log-space shift), which belong to the same class as the existing floating-point clamps — accuracy knobs, not modelling assumptions.

Two distinct comparisons follow from the basis decision (§3.5), and they must not be conflated:

- **Algorithmic-correctness oracle.** A large-`S` joint IS run targeting the *corrected* posterior (probability candidates drawn from the basis prior, likelihood-only weights) must agree with this scheme at standard `S` within Monte-Carlo tolerance. Same target ⇒ agreement is required, not hoped for.
- **Deliberate-delta characterisation.** Against today's de facto behaviour (envelope-as-prior), results on epistemic-basis latent edges with a fitted predictive pair will differ — that difference is the intended correction and must be *measured and reported*, not hidden. On the predictive/FC basis, and on edges without a fitted predictive pair, the proposal and prior already coincide today, so behaviour there is preserved exactly.

### 3.2 Why ESS improves — guaranteed, not hoped

The marginal weight is the conditional expectation of the joint weight: `m(θ) = E_p[ L(p, θ) ]` under `p ~ Beta(a₀, b₀)`. By the law of total variance, the variance of the marginalised weights cannot exceed the variance of the joint weights — this is the Rao-Blackwell argument, and it holds regardless of the data. Since ESS is governed by relative weight variance, the marginal ESS is at least the joint ESS in expectation.

In practice the improvement is large, because the `p` axis is the dominant weight-killer: after integrating `p` out, many timing curves explain the data acceptably (each is allowed its own best-fitting `p` range), so the weight distribution over timing particles is far flatter than over joint particles. The exponential-in-counts sensitivity that destroyed the joint scheme now acts *inside* the integral, where it is handled analytically rather than by particle attrition.

### 3.3 Degeneracies — one formula, no case forks

The scheme degenerates algebraically across the cases that matter, in line with this codebase's engine discipline (cases are data degeneracies of one path, never code branches):

- **Mature evidence (`F_{d,s} → 1`).** The factors `(1 − p·F_{d,s})^{R_{d,s}}` become `(1 − p)^{R_{d,s}}`, the integrand becomes the kernel of `Beta(a₀ + K_s, b₀ + Σ_d R_{d,s})`, and the conditional draw reproduces the textbook conjugate update against the basis prior — now **exactly consistent with the non-latent path**, which already conjugates against the basis prior. The basis correction (§3.5) dissolves the latent/non-latent inconsistency rather than preserving it: maturity is genuinely the `F ≡ 1` degeneracy of one formula across both timing families.
- **No evidence (`K_s = 0, R_{d,s} = 0` for all draws).** The integrand reduces to the basis prior; all marginal weights are equal; the scheme returns prior particles — identical to today's prior-only outcome.
- **Immature, weakly identified evidence (`F_{d,s}` small).** The factors are nearly flat in `p`, so the conditional posterior on `p` is wide. The `p`/`F` trade-off appears as honest conditional width instead of as the current behaviour (collapse onto one lucky joint particle, or fake precision from duplicated survivors). This is the central improvement for the misspecification-adjacent failure mode: the scheme does not decide which of `p` or `F` is wrong; it carries the ambiguity.
- **Timing-shape conflict.** If no sampled timing curve can explain the observed trajectory (the log-normal family is genuinely wrong for this edge), the marginal weights themselves collapse. This residual collapse is now a *meaningful* signal — "no plausible latency curve fits" — rather than an artefact of `p`-axis attrition. Per the graceful-degradation decision (9-Jun-26), this surfaces as a **visible degraded state** in the primitive's status/provenance family — analogous to the existing prior-only statuses — not as a silent repair and not as provenance-only metadata.

### 3.4 What this deliberately does not fix

- **Latency-family misspecification.** The log-normal family stays. The scheme makes its failures visible (low marginal ESS, poor best-particle fit) instead of hiding them inside `p` distortion. A better latency family is separate work, and would slot into the same scheme unchanged.
- **Predictive dispersion structure.** How realised-rate variation enters forecast bands (the κ question) is governed by separate design work; this proposal neither helps nor harms it.
- **Posterior width when evidence is genuinely sharp and the model fits.** The true posterior is then genuinely narrow, and the scheme will report it faithfully — now with a stable midpoint and smooth (non-duplicated) draws. If product-level concern remains about narrow bands in that regime, that is a dispersion-modelling question, not a sampling question.

### 3.5 Probability-basis decision — epistemic conditions, predictive forecasts

Reviewers asked whether the end state preserves the implementation's current likelihood-only target under the existing proposal envelope, or corrects the statistical target to condition against the basis prior. The two are different posteriors wherever the predictive pair is fitted.

**Decision (9-Jun-26): correct the target.** Conditioning uses **epistemic dispersions**; predictive dispersions are reserved for the forecasting (FC) surface, which is exactly what the existing `dispersion_basis` parameter was designed to express. Concretely, the marginalisation integrand and the conditional draw use the basis prior `(a₀, b₀)` — `(α, β)` when the conditioner is invoked on the epistemic basis, `(α_pred, β_pred)` when invoked on the predictive basis for FC surfaces.

The rationale is threefold:

- **The quirk's only justification evaporates under this scheme.** The predictive pair entered the epistemic-basis path purely as a wide IS coverage envelope for `p`. Marginalisation removes the `p` proposal entirely, so there is nothing left for the envelope to do; keeping it would be preserving an accident.
- **It restores the textbook update.** Conditioning the κ-inflated predictive pair treats observation noise as prior belief width — evidence then has to fight inflated pseudo-counts that do not represent belief about the rate.
- **It dissolves the latent/non-latent inconsistency** (§3.3): both timing families now condition the same prior, and maturity becomes a genuine algebraic degeneracy across them.

**Consequences, stated honestly.** This is a deliberate numerical behaviour change on epistemic-basis latent edges where a predictive pair is fitted — typically a modest sharpening of the conditioned posterior, since the epistemic prior carries more pseudo-mass per unit width. The predictive/FC basis path and edges without a fitted predictive pair are unchanged (envelope and prior already coincide there). The validation plan therefore carries both an algorithmic-correctness oracle and a measured characterisation of this delta (§3.1, §6). The legacy `p`-proposal-envelope fields in the conditioner become dead and are removed with the cutover.

---

## 4. Alternatives Considered and Rejected or Deferred

**ESS-threshold tempering (`essthreshold`, the legacy path).** Keeps ESS up by flattening the likelihood (`λ < 1`). Changes the posterior target; biases toward the prior exactly when evidence disagrees with it. Retained only as a forensic comparison path; to be retired after this scheme is accepted.

**Evidence-guided `p` proposal (the superseded Stage 1).** Builds a guide distribution for `p` near the evidence-implied region, with importance correction. Preserves the target in principle, but guesses the posterior's location using the latency curve — the least reliable component — and so risks converting timing-shape error into confident `p` placement for immature cohorts. Also required guide-construction choices (centre, spread) that this scheme renders unnecessary. Superseded: the conditional posterior on `p` is tractable exactly, so approximating it with a guessed guide is strictly inferior.

**More particles / adaptive proposal pools.** Linear budget against exponential demand (§1.4). May still be useful someday as a cheap supplement for the residual timing-marginal collapse, but cannot be the core fix.

**Weighted-particle propagation.** Keep weights instead of resampling, through composition and projection. Statistically the most faithful representation, but it changes the draw-family contract across the entire conditioned-forecast substrate (composition, reduction, quantiles, blending). Deferred unless the marginalised scheme proves insufficient.

**Resampling hygiene alone (systematic/residual resampling).** Target-preserving and cheap, but cannot create missing support: with joint ESS near 1 it faithfully returns the same few survivors. Subsumed here: Step 3 adopts low-variance resampling as a component.

**Approximation-quality provenance / uncertainty inflation.** Surfacing ESS, top-weight share, and similar diagnostics remains valuable and is included in this proposal's provenance plan. Numerical *widening* driven by those diagnostics is deferred: under this scheme, residual collapse indicates timing-model conflict, where the honest first response is visibility, not a synthetic widening rule.

---

## 5. Engineering Mapping

All statistical changes are confined to the latent branch of the conditioner's evaluation stage in `graph-editor/lib/runner/primitive_conditioning.py`. Specifically:

- **Unchanged:** timing-particle sampling (and therefore the shared-particle invariant with prefix-arrival evidence weighting); the evidence plan construction; the non-latent conjugate path; the output draw shapes and pairing; the doc-52 blend; every downstream consumer; the public request draw count.
- **Changed:** the weight computation (joint likelihood → `p`-marginalised likelihood per timing particle against the basis prior, via vectorised log-space quadrature); the resampling step (multinomial → systematic/residual, over timing indices); the `p` draw (envelope sample → exact conditional inverse-CDF draw per resampled timing particle, under a new named keyed-RNG derivation); the conditioning prior on the epistemic-basis latent path (predictive envelope → epistemic basis prior, per §3.5 — the deliberate numerical delta). The now-dead predictive-envelope plumbing for the `p` proposal is deleted with the cutover, not left as an alternative path.
- **New degraded state:** marginal-weight collapse (timing-shape conflict) surfaces as a visible primitive degradation status alongside the existing prior-only family, per the graceful-degradation decision — readouts can distinguish "conditioned", "prior-only", and "no plausible timing curve fits".
- **Numerical requirements:** the quadrature and weight accumulation must run in double precision (the current joint log-likelihood accumulates in single precision, which is itself marginal at large counts); log-space max-shift normalisation as today; the quadrature grid must consume exactly the same per-particle completeness arrays the current likelihood loop consumes, so the integrand and the displayed timing surfaces cannot diverge.
- **Provenance:** marginal ESS, top-weight share, quadrature grid size, scheme label, and the existing tempering/flag fields. Low marginal ESS should be visible to forensic tooling as the "no plausible timing curve" diagnostic.
- **Rollout:** RB is **default-on** (9-Jun-26). The short-lived request-only `norbcond` URL parameter is the kill switch: it sends `is_rb_conditioning_enabled: 0`, restoring the legacy joint full-likelihood path for comparison/rollback. The flag is carried in request forecasting settings, excluded from persisted model signatures, and included in FE result-cache identity via `graphComputeClient.forecastFlagsCacheKeyPart()` and in primitive-cache identity via `_primitive_cache_key`. Flag precedence is pinned: `essthreshold` selects the whole legacy tempered branch regardless of the RB setting — it exists to reproduce the old tempered behaviour exactly as a comparison surface. Three modes are therefore reachable: default (RB marginal), `norbcond` (legacy joint, λ = 1), `essthreshold` (legacy tempered). On acceptance of the §6 production runs: delete the legacy joint branch with `norbcond`, and `essthreshold` one release later. End state is one production path.

Compute cost: the marginal integral adds, per particle, a grid-sized vector of residual-term evaluations; vectorised over `S` particles this is a small constant factor over the existing likelihood loop. Draw counts to design against: `mc_draws` defaults to 500 for analysis-runner paths, and the graph-enrichment conditioned-forecast endpoint deliberately runs at `max(64, mc_draws / 10)` — 64 particles at current defaults. The reduced-draw path is where the current scheme's collapse is most acute (64 joint particles against sharp evidence), and is also where this scheme's gain matters most; its absolute compute cost there is trivial.

---

## 6. Validation Plan

**Status (9-Jun-26):** the unit-level items below are landed in `test_primitive_conditioning.py` (conjugate degeneracy against `Beta(a₀+K, b₀+ΣR)`; dense-reference agreement on an immature `F ≈ 0.2` fixture; keyed-RNG determinism; flag precedence; primitive-cache mode separation; a realised marginal-vs-joint ESS inequality on a collapsing fixture) and `test_forecasting_settings.py` (flag defaults, round-trip, signature exclusion). Outstanding before default-on: the deliberate-delta characterisation, the reduced-draw graph-enrichment run, the known production case in three modes, and the timing-conflict degraded-state surfacing (the perimeter `is_failed` outcome exists; the graded visible status does not yet).

**Exactness degeneracy.** Mature-evidence fixture (`F ≈ 1`): posterior must match the analytic conjugate update against the basis prior `Beta(a₀ + K, b₀ + ΣR)` within quadrature tolerance — and must agree with the non-latent path's conjugate answer on the same evidence, proving the §3.3 consistency claim.

**Algorithmic oracle — corrected target.** On moderate-evidence cases where joint IS is feasible at very large `S`, the scheme at standard `S` must match a large-`S` joint oracle targeting the corrected posterior (probability candidates from the basis prior, likelihood-only weights) within Monte-Carlo tolerance. Same target ⇒ agreement is required, not hoped for.

**Deliberate-delta characterisation.** On epistemic-basis latent edges with a fitted predictive pair, run the legacy scheme (envelope-as-prior) and the corrected scheme side by side and report the posterior deltas. The delta is the intended §3.5 correction; the validation artefact exists so the change is measured, reviewable, and attributable — not discovered later as an unexplained regression. Edges without a fitted predictive pair, and the predictive/FC basis path, must show no delta beyond Monte-Carlo noise.

**Per-draw evidence preservation.** A fixture where arrival weighting varies materially across particles (active-cohort or multi-hop): the marginalisation must consume per-particle `K_s` / `R_{d,s}` arrays. A deliberate scalar-substitution mutation must fail this test.

**Reduced-draw graph-enrichment path.** The conditioned-forecast endpoint runs at `max(64, mc_draws / 10)` draws — 64 at current defaults — and is where collapse is most acute. The known production case must be validated at this actual draw count through the graph-mutating CF path, not only at analysis-runner defaults. Acceptance at `S = 500` with failure at `S = 64` is a failed validation.

**Weak-identification behaviour.** Immature-cohort fixture: the conditional `p` width must reflect the `p`/`F` trade-off — wider than the collapsed joint-IS result, and the marginal ESS must be healthy.

**Timing-conflict diagnostic.** A synthetic trajectory inconsistent with any log-normal draw must produce low marginal ESS and the visible degraded status (§3.3, §5), with no silent rescue.

**Stability.** Repeated runs under different scenario seeds: midpoint and band variance across runs must shrink materially versus the current scheme on the known collapsing cases.

**The known production case.** The forecaster query that motivated `essthreshold` must be compared in three modes — current default, this scheme, and `essthreshold`. Acceptance requires: sensible stable bands; a midpoint that does not exhibit the tempered path's prior-ward pull; and no dependence on `essthreshold` for usable output.

**Contract preservation.** Output shapes, draw pairing, determinism under the keyed RNG seam, cache-identity separation of flagged/unflagged runs, and unchanged behaviour of the non-latent path.

---

## 7. Recorded Decisions and Open Questions

### Recorded decisions (9-Jun-26)

1. **Conditioning basis: epistemic.** Conditioning uses epistemic dispersions; predictive dispersions are reserved for the FC surface (§3.5). The envelope-as-prior behaviour on the epistemic-basis latent path is a defect to be corrected with this scheme, with the delta measured per §6.
2. **Graceful degradation is in scope.** Timing-marginal collapse surfaces as a visible degraded primitive status, not provenance-only metadata (§3.3, §5).
3. **`essthreshold` retirement: one release after default-on.** The legacy path survives exactly one release as a comparison/rollback aid once this scheme is the default, then is deleted.
4. **Default-on with a kill switch, not opt-in (9-Jun-26).** RB is the production default; the request-only `norbcond` URL parameter disables it. The legacy joint path is retained only as the kill-switch target and is deleted with the flag after the §6 production runs are accepted.

### Implementation decisions (9-Jun-26, `_evaluate_latent_rb_marginal`)

The two numerical open questions were pinned at implementation; both choices are numerical-resolution policy, validated by the conjugate-degeneracy and dense-reference tests in `test_primitive_conditioning.py`:

1. **Quadrature: two-stage trapezoid in logit space.** Stage 1: a coarse 160-point window derived per particle from the bounding Betas — the conditional lies stochastically between `Beta(a₀+K_s, b₀+ΣR_{d,s})` and `Beta(a₀+K_s, b₀)` because `(1−p) ≤ (1−p·F) ≤ 1` — with ±12 logit-sd slack, clamped to `|logit(p)| ≤ −ln(10⁻¹²)`. Stage 2: a refined 160-point window centred on the coarse mode, sized ±10σ̂ from the local second-difference curvature (flat curvature degenerates to the coarse window). The logit substitution absorbs the Beta kernel's `(−1)` exponents into the Jacobian, so the grid integrand is `p^{a₀+K_s}(1−p)^{b₀}Π(1−p·F)^{R}` — no boundary clipping anywhere; boundedness comes from the window clamp.
2. **Conditional draw: inverse-CDF with within-cell linear interpolation** on the refined grid, under the new keyed-RNG derivation `primitive_p_conditional_draws`. Resampling reuses the `primitive_is_resampling` derivation with systematic positions.

### Open questions for review

3. **Per-draw evidence coupling.** Evidence counts are arrival-weighted per timing draw (each particle sees its own weighted counts — formally, the counts are part of the likelihood's `θ`-dependence). The marginalisation uses each particle's own counts (`K_s`, `R_{d,s}` from the plan's per-draw arrays), which is consistent; reviewer confirmation that no cross-particle coupling is lost would be valuable.

---

## Appendix — Code Surface for Maintainers

- `graph-editor/lib/runner/primitive_conditioning.py` — `_evaluate_likelihood_plan` (latent branch: lines ~1338–1506 at time of writing) is the implementation site. The basis prior `(a₀, b₀)` is the function's `prior_alpha` / `prior_beta` pair as resolved by `_condition_primitive_uncached` from `dispersion_basis` — the same pair the non-latent conjugate path uses. The `proposal_alpha` / `proposal_beta` envelope (and the `prior_alpha_pred_for_proposal` / `prior_beta_pred_for_proposal` plumbing feeding it) is the §3.5 defect surface: under this scheme it has no remaining consumer on the latent path and is deleted at cutover. `_build_cohort_likelihood_plan` already supplies the per-particle counts (`_CohortBucket.increments_draws`, `n_weighted_draws`, `last_k_weighted_draws` — all shape `(S,)`); no new evidence read path is required, and the scalar count fields are diagnostics only. `_weights_and_ess` / `_normalise_log_weights` are the normalisation seam. The single-precision accumulation of the joint log-likelihood is at the top of the latent branch.
- `graph-editor/lib/runner/timing_particles.py` — `sample_timing_particles_from_params` and the shared-particle invariant with prefix-arrival. Untouched by this proposal; the constraint it imposes is documented in §5.
- `graph-editor/lib/runner/primitives.py` — `DrawFamilyKey`, `make_rng`, and the named-derivation registry; the conditional `p` draw and the resampling step each need a named derivation.
- `graph-editor/lib/runner/forecasting_settings.py`, `graph-editor/src/constants/latency.ts`, `graph-editor/src/lib/graphComputeClient.ts` — the request-only flag, settings-signature exclusion, and cache-identity pattern to copy from the existing `essthreshold` plumbing during rollout.
- `graph-editor/lib/tests/test_primitive_conditioning.py` — the existing full-likelihood and `essthreshold` tests to extend with the §6 validation cases.
