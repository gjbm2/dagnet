# Doc 18: Compiler Development Journal

**Purpose**: Chronological record of what was tried, what worked, what
failed, and what was learned during Bayes compiler development. Prevents
re-exploring dead ends and preserves reasoning for future reference.

Entries are reverse-chronological (newest first).

---

## 30-Mar-26: Path dispersion investigation

### Changes made
- Replaced Williams moment estimator with BetaBinomial MLE
  (scipy.optimize L-BFGS-B on betaln log-likelihood). Same inputs,
  more efficient extraction of between-cohort signal when per-obs n
  is small. Williams subtracts two similar numbers (obs_var - binom_var);
  MLE uses full likelihood shape.
- Added recency weighting (halflife from settings) to dispersion
  estimation for consistency with model recency weighting.
- Tightened F threshold to named const DISPERSION_F_THRESHOLD (0.90).
- Reverted max(mcmc, williams) to use Williams/MLE only, keeping
  MCMC kappa_p visible for diagnostic comparison.

### Results on production (registered-to-success)

| Estimator | Window κ | Cohort κ | Mature-only baseline |
|---|---|---|---|
| Williams (before) | 14 | 459 | ~110 |
| Williams + recency | 11 | 248 | ~110 |
| BB-MLE + recency | **15** | **86** | ~110 |

Cohort improved dramatically (459 → 86) — MLE extracts signal that
Williams couldn't see. Window still stuck at 15 — confirmed as CDF
maturity contamination, not statistical power.

### Suspected production data / data-binding defect

Investigation of no-latency first edges (landing-to-created,
create-to-delegated) revealed:
- Window kappa=51, cohort kappa=28 for landing-to-created. These
  MUST be identical — same population, no path, a=x.
- Raw DB data: x values match exactly, y differs by 1-3 due to
  different retrieval dates (window fetched 2 days later). Not a
  data corruption issue — real trickle of late conversions.
- But kappa 51 vs 28 is a 2× difference from the same reality.
  Suggests MLE is sensitive to small input perturbations, AND/OR
  the evidence binder is constructing different trajectory structures
  from nearly-identical data (different retrieval density → different
  trajectory/daily split → different endpoints).

**Strong suspicion**: production snapshot data and/or the evidence
binder's trajectory construction has defects that corrupt the
dispersion signal. The data complexity (multiple overlapping
slice_keys, context aggregation, PLACEHOLDER hashes from synth
mirror coexisting in DB, different retrieval coverage per obs type)
makes it very difficult to reason about correctness forensically.

**Decision**: pivot to synth-mirror-4step with known kappa to
validate the full pipeline (synth gen → DB → evidence binder → MLE)
in a controlled setting before debugging production further.

---

## 29-Mar-26: Stable baseline established; two open model issues

### Current state

Synth regression: **8/10 pass** (simple-abc and drift3d10d fail on
pre-existing onset-mu correlation). Prod 4-step: **converges with
warm-start** (all edges bayesian, ESS 5k–15k, rhat ≤ 1.003).

Key changes this session:
- **Synth context data fix**: `emit_context_slices` flag in truth files
  (default false). Synth gen was emitting per-context rows with different
  p values; aggregation produced rate heterogeneity the model couldn't fit.
- **Warm-start quality guard**: `_warm_start_acceptable()` gates on
  rhat < 1.10 and ESS ≥ 100. Prevents poisoned posteriors from cascading.
- **Full warm-start wiring**: kappa, kappa_p, cohort latency (mu, sigma,
  onset) now read from previous posterior `_model_state` and `cohort()`
  slice. Previously only p, mu_lat, sigma_lat, onset were warm-started.
- **Endpoint BetaBinomial**: replaces per-trajectory p_i hierarchy.
  y_final ~ BB(n, p×F(age), kappa_p) with latent CDF gradients.
- **run_regression.py fix**: parses param_recovery output before checking
  exit code (was misclassifying PARTIAL as HARNESS FAIL).

### Open issue 1: Path dispersion estimation is broken

**Symptom**: registered-to-success on prod 4-step:
- Edge (window) Williams kappa = 14 → **stdev ≈ 10%**
- Path (cohort) Williams kappa = 459 → **stdev ≈ 2%**

Path dispersion should be ≥ edge dispersion (paths accumulate upstream
uncertainty). Currently it's 5× tighter — inverted.

**Root cause**: cohort trajectories have small denominators (median n=19).
The Binomial sampling variance (binom_var = p(1-p)/n) is large at small n,
nearly equalling the observed variance. Williams bc_var = obs_var - binom_var
≈ 0, so kappa → ∞. The real between-cohort variation is present but
invisible beneath the sampling noise floor.

This is the doc 25 kappa discrepancy. The `max(mcmc, williams)` rule
(inference.py:424) was NOT requested — it should be reverted to side-by-side
comparison. But the underlying estimation problem remains: Williams breaks
down when denominators are small relative to the between-cohort signal.

**Potential approaches** (not yet attempted):
- Use only mature, large-denominator observations for Williams
- Derive path kappa analytically from edge kappa (κ_path ≤ κ_edge)
- Use a hierarchical model for cohort p instead of post-hoc Williams

### Open issue 2: Path latency posteriors too tight

**Symptom**: registered-to-success cohort latency on prod 4-step:
- onset = 16.5 ± 0.2 (±1.2% — implausibly tight for 4-edge path)
- sigma = 2.87 ± 0.047 (±1.6%)
- For comparison, edge onset = 4.3 ± 0.15 (±3.5%)

Path onset should have ≥ RSS of edge onset uncertainties. Currently
tighter than any individual edge.

**Root cause**: same as issue 1 — the cohort trajectory likelihood with
small-denominator observations over-constrains path-level parameters.
Each trajectory with n=19 is treated as an independent observation, but
the information content per trajectory is low. With 85 such trajectories,
the model infers falsely precise path latency.

### Open issue 3: Onset-mu correlation

corr(onset, mu) ≈ -0.99 on short-latency first edges (onset ≈ 1d).
Causes 2/10 synth failures and required warm-start for
delegated-to-registered to converge on prod.

Structural identifiability issue: shifting onset left while increasing mu
(or vice versa) produces nearly identical CDFs. The shifted-lognormal
parameterisation has an inherent ridge when onset is small relative to
the lognormal body.

Not yet addressed. Potential approaches: reparameterisation (e.g. t50
instead of onset+mu), stronger onset prior, or marginalising onset.

---

## 29-Mar-26: Kappa discrepancy investigation (doc 25)

### Root cause 1: synth_gen per-user kappa produces no between-day overdispersion

synth_gen drew per-user p from `Beta(p×kappa, (1-p)×kappa)` — each
of 5000 users/day got an independent draw. Law of large numbers:
the day-level rate y/n converges to p with only Binomial-level
noise (SD ≈ 0.006), not BetaBinomial (SD ≈ 0.064 for kappa=50).
The model's kappa (which measures between-day variation) sees
effectively infinite kappa — no overdispersion to recover.

**Fix**: per-day draws. One `p_day ~ Beta(p×kappa, (1-p)×kappa)`
per (day, edge, context-combo). All users on that day share the
same p. Produces genuine between-day variation visible in aggregate
data.

Verified: after fix, synth-simple-abc edge A→B shows
`std(p_implied)=0.038` (was 0.007), `kappa_williams=150` (was
50000+). Expected effective aggregate kappa ≈ 120 (reduced from
truth 50 by context-mixing: organic p_mult=1.2, paid p_mult=0.7).

### Root cause 2: synth_gen emitting both aggregate and context rows

synth_gen emitted both bare `window()`/`cohort()` rows (x=5000) and
context-prefixed rows like `context(channel:organic).window()` (x=2997).
Production only has context rows for contexted edges. The evidence
binder's first-wins dedup on `retrieved_at` could pick a context row
over the aggregate row, halving the denominator and suppressing
between-day variance.

**Fix**: synth_gen emits context-only rows when `context_dimensions`
exist; bare aggregate rows when no contexts. Matches prod behaviour.

Evidence binder extended with MECE context aggregation: sums x and y
across context rows for the same (anchor_day, retrieved_at) to recover
the aggregate. Bare aggregate rows take precedence where they exist.

### Root cause 3 (harness-specific): missing warm-start priors

The test harness reads param files from the data repo working tree.
After FE Bayes runs commit posteriors to git, the local checkout
doesn't have them until pulled. Without warm-start:

- Harness uses topology latency priors (onset=5.5, mu=1.607, sigma=0.527)
- FE uses warm-start priors (onset=9.6, mu=-1.244, sigma=2.813)
- del-to-reg with topology priors hits onset-mu ridge: corr=-0.999, ess=3
- del-to-reg with warm-start converges cleanly: corr=-0.836, ess=5922

Confirmed: harness with `--warmstart` (two-pass) or `neutral_prior=true`
converges. Posteriors match FE within 1% on p, latency params in same
region. The failure was prior-dependent sampler initialisation, not a
model regression.

**Key finding**: the k/n-derived p prior + topology latency prior
combination creates a tight p-latency ridge for del-to-reg that the
sampler can't cross in 500 tune steps. Neutral p priors (Beta(1,1))
give enough freedom; warm-start priors start near the mode. Both
converge.

### Maturity filter (F ≥ 0.9) on endpoint BB and Williams

Added to both estimators (model.py and inference.py). Excludes
immature endpoints where CDF error amplifies apparent variance.
Not yet validated on regenerated synth data.

### Remaining work

- Regenerate all 8 synth graphs (per-day kappa + context-only)
- Full regression suite on regenerated data
- Validate maturity filter on synth kappa recovery
- Harness: pull data repo or add warm-start fallback

---

## 29-Mar-26: Phase 2 join-node CDF fix (applied)

The `phase2_cohort_use_x` branch entered before the join-detection code
ran, so join-downstream edges resolved latency from `trajs[0].path_edge_ids`
(one arbitrary path) and ignored the other incident paths entirely.

**Fix**: inside the `phase2_cohort_use_x` block, check `path_alternatives`
first. If 2+ alternatives exist, build the mixture CDF (same components as
Phase 1's `else` branch: path-product p, FW-composed latency per
alternative) and keep the original anchor-denominator trajectories. Only
apply the x-denominator rewrite when the edge is NOT a join-downstream
mixture.

This is a structural/topological fix, independent of the Phase 2
parameterisation approach (approach 3, drift constraints, etc.). Affects
diamond, lattice, join-branch graphs and any production graph with joins.

---

## 29-Mar-26: Phase 2 drift constraint — ESS decay with empirical drift rate

### The physical constraint on drift

The ONLY reason 2.edge.p can differ from 1.edge.p is temporal
drift — the true conversion rate at edge x→y changed between the
window observation period and the cohort observation period. The
amount of possible drift is bounded by the ELAPSED TIME between
window and cohort observations of this edge, which equals the
median path latency from anchor a to this edge's from-node x.

- If median(a→x) = 0 (first edge): no time elapsed, no drift
  possible. 2.edge.p must equal 1.edge.p.
- If median(a→x) = 30d: ~30 days for rate to change. Some drift
  is possible.

Same logic applies to 2.path.latency: the path CDF can only
diverge from FW-composed 1.edge latencies to the extent that time
has passed (plus the structural FW approximation error).

### ESS decay mechanism

Phase 1 posterior Beta(α, β) → Phase 2 prior Beta(α×s, β×s) where
the scale factor s depends on elapsed time and drift rate:

```
s = 1 / (1 + elapsed × σ²_drift / V_phase1)
```

- V_phase1 = p(1-p) / (α+β) — Phase 1 posterior variance
- elapsed = median path latency a→x (from topology)
- σ²_drift = daily drift variance (estimated from Phase 1 data)

Properties:
- elapsed=0 → s=1 → full Phase 1 precision (frozen)
- elapsed→∞ → s→0 → uninformative (cohort data dominates)
- σ²_drift=0 → s=1 for all edges (no drift, all frozen)
- Rational decay 1/(1+t/τ), not exponential — this is the exact
  formula for adding drift variance to the prior

### Estimating σ²_drift from Phase 1 data

Model: p_obs(t) = p_true(t) + ε(t), where p_true follows a
random walk with daily increment variance σ²_drift and ε is
observation noise with variance σ²_noise.

For observations k days apart:
```
Var(Δ^(k)) = k × σ²_drift + 2 × σ²_noise
```

Linear in k. The slope is σ²_drift. Using lag 1 and lag 7:
```
σ²_drift = max(0, (Var(Δ⁷) - Var(Δ¹)) / 6)
```

If Var(Δ⁷) ≤ Var(Δ¹): no detectable drift → σ²_drift = 0.

Data source: per-anchor-day implied rates from Phase 1 evidence.
For each anchor day's trajectory endpoint:
`p_day = y_final / (n × F(age_final))`.

### Conservative defaults

- σ²_drift = 0 when: no detectable drift, fewer than 25 anchor
  days, or no per-day rates available. Default = no drift = prior
  stays at full Phase 1 precision = essentially frozen.
- The conservative direction is correct: assuming no drift when
  uncertain is safer than assuming drift (which creates p-CDF
  ridge vulnerability).

### Phase 2 model structure summary

| Variable | Level | Type | Prior |
|---|---|---|---|
| 2.edge.p | edge | free Beta | 1.edge.p posterior, ESS-decayed by elapsed time |
| 2.path.p | path | derived | product of 2.edge.p |
| 2.edge.latency | edge | frozen | 1.edge.latency posterior means |
| 2.path.latency | path | free | FW-composed 1.edge, width from propagated 1.edge posterior SDs |
| 2.path.CDF | path | derived | from 2.path.latency |

Branch groups: Dirichlet on 2.edge.p values with Phase 1
posterior-derived concentrations (ESS-decayed).

### Empirical between-cohort kappa (post-model)

Williams (1982) moment estimator on maturity-adjusted trajectory
residuals. Independent of the model — measures actual between-
cohort variation for honest alpha/beta in the cohort posterior.
Already implemented in inference.py.

### Implementation and results

**Step 1** (drift=0 baseline): confirmed. p_cohort ≈ 0.50 on both
synth drift graphs (truth=0.50). Full regression: 6/10 pass, 4
pre-existing onset misses. Zero new regressions. Production:
registered-to-success p_cohort = 0.802 (was 0.950 with old
approach).

**Step 2** (drift estimation + ESS decay):
- F²-weighted lag-variance estimator: no thresholds, naturally
  downweights immature trajectories. Correctly returns σ²_drift=0
  for synth with no drift.
- ESS decay: scale = 1/(1 + elapsed × σ²_drift / V₁). Elapsed =
  upstream path latency (a→x), excluding this edge. First edges
  always get elapsed=0 → no decay.
- Deterministic drift test (drift_rate=-0.01/day on logit):
  Phase 2 p_cohort moves in the correct direction for the second
  edge (elapsed≈11d). Phase 1=0.352, Phase 2=0.338, expected
  shifted truth=0.302. Direction correct; magnitude partial (prior
  still pulls). Consistent with calibrated ESS decay.
- synth_gen extended with `--drift-rate` for deterministic linear
  drift testing (alongside existing `--drift` for random walk).
- Full regression with drift changes: same 6/10 pass, 4 onset
  misses. No regressions.

---

## 28-Mar-26: Phase 2 redesign — posterior-as-prior (approach 3)

### Motivation

The current Phase 2 freezes Phase 1 edge parameters to point
estimates and uses hardcoded leashes (tau_drift=0.1 for p,
max(1.0, |mu|×0.5) for cohort latency). This discards Phase 1's
posterior precision — the "weight" of window evidence doesn't
influence Phase 2's freedom. The result:

1. p-CDF ridge: cohort latency priors are too wide, enabling the
   cure model identifiability problem (p inflates, CDF compensates)
2. Arbitrary drift: tau_drift=0.1 regardless of whether Phase 1
   determined p to ±0.002 or ±0.05
3. Option A (per-cohort random effects) failed: the hierarchy's
   degrees of freedom create a spurious mode that traps the sampler
4. Branch group Dirichlet gave p too much freedom (replaced with
   drift+simplex, but that's a workaround)

Root cause: the phase boundary collapses posterior → point estimate,
losing precision. This is approach 1 ("freeze and condition") from
the staged estimation taxonomy. We need approach 3 ("propagate the
edge posterior into pass 2").

### Proposed design

**Phase 1** — unchanged. Fits edge parameters from window data.
Produces full posteriors on p, mu, sigma, onset, kappa_p per edge.

**Phase 2** — each edge gets free variables whose priors ARE
Phase 1's posteriors (moment-matched to parametric distributions):

```
p_cohort ~ Beta(α_phase1, β_phase1)
mu_cohort ~ Normal(mu_mean_phase1, mu_sd_phase1)
sigma_cohort ~ Gamma(fitted from Phase 1 posterior)
onset_cohort ~ fitted from Phase 1 posterior
```

Key properties:
- Prior widths = Phase 1 posterior SDs → evidence weight flows
  through automatically
- No eps_drift, no tau_drift, no hardcoded prior widths
- Cohort likelihood updates these naturally — drift emerges from
  data, not from explicit parameterisation
- p-CDF ridge eliminated: latency priors are tight (proportional
  to Phase 1 precision), CDF can't reshape freely
- Branch groups: Dirichlet on p_cohort values, with concentrations
  from Phase 1 posterior (inherently calibrated)
- No phase2_cohort_use_x rewrite needed: use path p (product of
  edge p_cohort) with anchor denominator — the natural
  parameterisation for cohort observations
- Path CDF: FW-compose Phase 2's edge latency variables along path
  (variables, not frozen constants — but pulled tight by Phase 1
  posterior priors)

**Extraction** — Williams method for empirical between-cohort kappa
on trajectory residuals (already implemented). If Phase 2's posterior
uncertainty is already honest (from proper uncertainty propagation),
may not need Williams — to be evaluated empirically.

### What this eliminates

- eps_drift / tau_drift mechanism
- Hardcoded cohort_latency prior widths (max(1.0, ...))
- phase2_cohort_use_x denominator rewrite
- drift+simplex workaround for branch groups
- The entire Option A / kappa_cohort / per-cohort z_i apparatus

### What remains independent

- ~~Join-node CDF fix~~: done 29-Mar-26. phase2_cohort_use_x now
  detects join-downstream edges and builds mixture CDF.
- Williams method for between-cohort kappa: post-model residual
  estimation. Keep for now; evaluate whether Phase 2's posterior
  width is sufficient after approach 3 is implemented.

### Implementation plan

1. In worker.py: after Phase 1, extract posterior distributions per
   edge (moment-match p→Beta, mu→Normal, sigma→Gamma, onset→fitted)
2. In model.py build_model: when phase2_frozen is provided, create
   free variables with Phase 1 posterior-derived priors instead of
   frozen constants + drift
3. Remove phase2_cohort_use_x: use path p (product via
   _resolve_path_probability) with anchor denominator
4. FW-compose Phase 2's latency variables (not frozen tensors) for
   path CDF
5. Branch groups: standard Dirichlet with Phase 1 posterior-derived
   concentrations
6. Test on synth drift graphs, standard regression suite, production

---

## 27-Mar-26 (cont.): Phase 2 cohort predictive alpha/beta — design analysis

### Problem statement

Phase 1 has honest between-cohort uncertainty via hierarchical Beta on p
(kappa_p learned from window trajectories) and BetaBinomial for
no-latency daily obs. The 2×2 grid:

| | window() | cohort() |
|---|---|---|
| latency | hierarchical Beta p_i ✓ | NOT YET ADDRESSED |
| no-latency | BetaBinomial daily obs ✓ | NOT YET ADDRESSED |

Phase 2 cohort posteriors use moment-matched alpha/beta from the
p_cohort MCMC samples — too tight because they only capture estimation
precision, not between-cohort variation. The surprise gauge and
confidence bands for cohort queries are therefore overconfident.

### The ideal (unrealisable) joint model

If we could fit everything in a single Hamiltonian:

```
mu_p ~ Beta(prior)
kappa_window ~ Gamma(prior)        # window between-cohort dispersion
kappa_cohort ~ Gamma(prior)        # cohort between-cohort dispersion

Window cohort i:  p_w_i ~ Beta(mu_p · kappa_window, (1-mu_p) · kappa_window)
                  y_w_i ~ Binomial(n, p_w_i · F(t))

Cohort cohort j:  mu_cohort = g(mu_p, drift)
                  p_c_j ~ Beta(mu_cohort · kappa_cohort, (1-mu_cohort) · kappa_cohort)
                  y_c_j ~ Binomial(n, p_c_j · F(t))
```

We can't fit this — doc 23 §1 explains why (inconsistent Hamiltonian
when window and cohort likelihoods share parameters). The two-phase
design is an approximation. The question is which phase-split
approximation best recovers the predictive of the joint model.

### Option A: learn kappa_cohort inside Phase 2

Add hierarchical Beta to the Phase 2 model:

```
mu_cohort = sigmoid(logit(p_frozen) + eps · tau)      # as now
kappa_cohort ~ Gamma(prior)                            # NEW
p_c_j ~ Beta(mu_cohort · kappa_cohort, ...)            # NEW: one per cohort traj
y_c_j ~ Binomial(n_j, p_c_j · F(t))                   # uses p_c_j not mu_cohort
```

Predictive: for each MCMC sample (mu_s, kappa_s), draw
p_new ~ Beta(mu_s · kappa_s, (1-mu_s) · kappa_s).

**Pros:**
- Structurally correct generative model
- kappa_cohort estimated from cohort data — measures the right thing
- Consistent with Phase 1 approach

**Cons:**
- **Sparse data**: typically 5-15 cohort trajectories (vs 30-60 window).
  kappa_cohort likely prior-dominated.
- **Path-level identifiability**: cohort trajectories observe path p
  (= ∏ edge p_i), not individual edge p. Per-edge kappa_cohort is
  unidentifiable from path-level observations. Must use either:
  (a) single shared kappa across all edges (loses edge decomposition), or
  (b) path-level kappa (not decomposable to edges for reporting).
- **Phase 2 fragility**: adding per-cohort p_i increases dimensionality
  of an already-fragile model (ess=7 on some runs).

**Key risk**: with sparse data, the posterior on kappa_cohort is
dominated by the prior. The "learned" kappa is effectively chosen by
the analyst via the prior, not by the data. This is no better — and
arguably more opaque — than explicitly substituting a data-informed
kappa from another source.

### Option C: inference-time predictive using Phase 1 kappa_p

No Phase 2 model changes. At extraction time in inference.py:

```
p_cohort_s  ← Phase 2 posterior sample
kappa_p_s   ← Phase 1 posterior sample (from window data)
p_new_s ~ Beta(p_cohort_s · kappa_p_s, (1 - p_cohort_s) · kappa_p_s)
```

For path-level: compound edge-level predictive draws through the path
product, then moment-match.

**Pros:**
- Zero Phase 2 model changes — no destabilisation risk
- kappa_p well-identified from rich window data (30-60 trajectories)
- Edge-level kappa correctly compounds through path products
- Conservative: overestimates cohort variation (safe direction for
  surprise gauge — wider bands, fewer false alarms)

**Cons:**
- Substitutes kappa_window for kappa_cohort. Correct only if they're
  approximately equal.
- Requires plumbing Phase 1 kappa_p samples through to Phase 2
  extraction.
- For edges without Phase 1 kappa_p (too few window trajectories):
  falls back to moment-matching (tight but no worse than today).

### Mathematical comparison

Both produce predictive of the form p_new ~ Beta(mu · kappa, ...).
The difference is entirely in where kappa comes from:

| | mu_cohort | kappa |
|---|---|---|
| Option A | Phase 2 posterior | Phase 2 posterior (from cohort data) |
| Option C | Phase 2 posterior | Phase 1 posterior (from window data) |

Are kappa_window and kappa_cohort the same quantity? Strictly no —
window measures daily snapshot variation, cohort measures entry-period
variation. Same underlying drivers (user heterogeneity, campaigns,
seasonality) but different aggregation grain. Cohorts formed over a
week average ~7 days of traffic, so kappa_cohort ≥ kappa_window
(higher concentration = less dispersed). Using kappa_window is
therefore conservative.

Option C has a structural advantage at path level: edge-level kappa_p
from Phase 1 was identified from edge-level window data. It compounds
through the path product naturally. Option A can only identify a
path-level kappa from path-level cohort data — losing edge
decomposition.

### Decision: try Option A first

Option A is the structurally correct model. Test whether it's robust
despite sparse cohort data and potential identifiability issues. If
kappa_cohort is prior-dominated or Phase 2 convergence degrades, fall
back to Option C.

### Option A implementation (27-Mar-26)

**model.py changes:**
- Phase 2 block: count cohort trajectories (matching phase2_cohort_use_x
  rewrite filter), create kappa_cohort ~ Gamma(3, 0.05) and
  p_cohort_i via non-centred logit-normal, shape=N, if N ≥ 3.
- No-latency edges with n_cohort_trajs=0: kappa_cohort for BetaBinomial
  on daily obs (first-edge only).
- _emit_cohort_likelihoods: _use_p_cohort_vec enabled for Phase 2
  cohort trajectories via phase2_cohort_use_x path.

**inference.py changes:**
- Top-level predictive: prefers kappa_cohort (Phase 2) over kappa_p
  (Phase 1).
- Per-slice: _predictive_alpha_beta takes kappa_var_name parameter.
  Window slice uses kappa_p; cohort slice uses kappa_cohort (falls
  back to kappa_p if kappa_cohort absent).

### Convergence investigation (27-Mar-26)

Initial centred Beta parameterisation failed badly:

| Parameterisation | p_cohort_i | Phase 2 ESS | rhat | Diverg. |
|---|---|---|---|---|
| Centred Beta (2ch/500d) | 159 | 89 | 1.025 | 0 |
| Centred Beta (3ch/1000d) | 159 | 59 | 1.035 | 7 |
| Baseline (no kappa) | 0 | 404 | 1.004 | 0 |

**Root cause**: funnel geometry. Phase 2's p_cohort is nearly fixed
(small drift from frozen Phase 1), creating a tight parent / dispersed
children hierarchy. Phase 1 doesn't have this problem because its p
is a free Beta RV.

**Fix**: non-centred logit-normal parameterisation:
```
z_i ~ Normal(0, 1), shape=N
logit(p_i) = logit(p_cohort) + z_i / sqrt(kappa_cohort)
p_i = sigmoid(logit(p_i))
```
z_i has unit variance regardless of kappa — breaks the funnel.

| Non-centred | p_cohort_i | Phase 2 ESS | rhat | Diverg. |
|---|---|---|---|---|
| Latency edges only | 159 | 311 | 1.026 | 0 |
| All edges | 214 | 228 | 1.020 | 0 |

ESS 59→228 with zero divergences. The centred parameterisation was
an implementation defect, not a structural problem with Option A.

### No-latency edges on latency paths (27-Mar-26)

For path a→x→y where a→x has latency and x→y is instant:
- Cohort trajectory for x→y shows maturation (driven by upstream
  a→x latency)
- BetaBinomial on daily obs would be WRONG: observations are
  cumulative, not independent
- The trajectory Binomial with path CDF is correct: latency
  resolution in _emit_cohort_likelihoods resolves path latency
  (from _resolve_path_latency) even for no-latency edges
- q_j = p_xy × ΔF_ax(t_j) / (1 − p_xy × F_ax(t_{j-1}))

Three sub-cases for no-latency edges in Phase 2:
1. **First-edge** (path_edge_ids ≤ 1): flat trajectory → n_cohort_trajs=0
   → BetaBinomial on daily obs (observations genuinely independent)
2. **Downstream, no-latency path**: flat trajectory → n_cohort_trajs=0
   → same as case 1 or absent
3. **Downstream, latency path**: meaningful trajectory with path CDF
   → n_cohort_trajs > 0 → per-cohort p_i (non-centred)

Removed edge_has_lat guard from trajectory counting — all edges
with ≥3 cohort trajectories get per-cohort p_i. The natural filters
route each sub-case correctly.

### Option A results — final (27-Mar-26)

**Production (bayes-test-gm-rebuild)** with non-centred, all edges:

| Edge | p_cohort_i | kappa_cohort | Type |
|---|---|---|---|
| del-to-reg (7bb83fbf) | 76 | learned | latency |
| reg-to-success (97b11265) | 83 | learned | latency |
| landing-to-created (b91c2820) | 33 | learned | no-lat, no-lat path |
| create-to-delegated (c64ddc4d) | 22 | learned | no-lat, no-lat path |

Phase 2: ESS=228, rhat=1.020, 0 divergences. 214 per-cohort random
effects handled by non-centred parameterisation.

Cohort slice posteriors:
- reg-to-success cohort: α=34.8, β=1.9 (honest width)
- Honest alpha/beta flow through to path_alpha/path_beta → surprise
  gauge and confidence bands

**2×2 grid status (final)**:

| | window() | cohort() |
|---|---|---|
| latency | hierarchical Beta p_i ✓ | non-centred p_cohort_i ✓ |
| no-latency | BetaBinomial daily obs ✓ | per-cohort p_i or BB ✓ |

All four quadrants have honest between-cohort uncertainty. No-latency
edges on latency paths correctly use trajectory Binomials with path
CDF and per-cohort p_i. No-latency edges on no-latency paths
naturally collapse to BetaBinomial or absent.

### Full regression (27-Mar-26)

8 synth graphs, 2 chains, 500 draws, 500 tune:

| Graph | Result | Notes |
|---|---|---|
| synth-simple-abc | PASS | |
| synth-mirror-4step | PASS | |
| synth-fanout-test | PASS | |
| synth-3way-join-test | PASS | |
| synth-join-branch-test | PASS | |
| synth-diamond-test | PARTIAL | 2 onset misses (pre-existing corr) |
| synth-lattice-test | PARTIAL | 1 onset miss (pre-existing corr) |
| synth-skip-test | PARTIAL | 1 onset miss (pre-existing corr) |

5/8 clean pass. 3 failures are ALL onset-mu correlation misses
(corr ≈ -0.95 to -0.99), pre-existing and documented. Zero p
recovery failures. Zero new regressions from kappa_cohort changes.

### Option A failure: per-cohort p_cohort_i breaks Phase 2 (28-Mar-26)

**Root cause investigation**: Phase 2 p_cohort drifts far from truth
on synth data (0.50 → 0.835). Systematic investigation:

1. **Not the Dirichlet**: replaced Dirichlet with drift + soft simplex
   for branch group edges. eps_drift still reached 16σ.

2. **Not the cohort_latency_vars**: disabled free cohort latency,
   forced FW-composed frozen path CDF. Still drifts.

3. **IS the per-cohort p_cohort_i hierarchy**: with overdispersion=false
   (no kappa_cohort, no p_cohort_i), p_cohort = 0.509, eps_drift = 0.3.
   Perfect recovery. ESS=200.

**Mechanism**: the non-centred logit-normal p_cohort_i (96 z_i
variables) provides enough degrees of freedom to create a spurious
mode. The model sets p_cohort high (0.835), compensates each z_i
to pull individual p_cohort_i back toward ~0.50, and the per-cohort
heterogeneity provides a small per-point likelihood improvement that,
compounded across 96 trajectories × ~49 ages ≈ 4700 data points,
overcomes the 128-nat eps_drift prior penalty.

This is NOT a convergence issue (the sampler consistently finds the
spurious mode). It's a structural interaction between the hierarchical
random effects and the drift parameterisation.

**Conclusion**: Option A (per-cohort p_cohort_i in Phase 2) is
structurally incompatible with the Phase 2 drift model. The
hierarchy's degrees of freedom overwhelm the drift constraint.
Must use Option C (inference-time predictive from Phase 1 kappa_p).

### Option C superseded by empirical variance approach (28-Mar-26)

Option C proposed plumbing Phase 1's kappa_p samples through to
Phase 2 extraction — using window between-cohort variation as a
proxy for cohort between-cohort variation. This was the fallback
after Option A failed. However:

1. Plumbing is awkward (Phase 1 trace not available during Phase 2
   summarisation — needs new parameter or state passing)
2. Window kappa_p measures the wrong thing (daily snapshot variation
   includes compositional mixing; entry-cohort variation does not)
3. The approximation is conservative but imprecise — overestimates
   variation for slow-maturing edges

### Empirical variance approach (28-Mar-26)

Instead of estimating between-cohort variation within the MCMC
(Option A, failed) or proxying from Phase 1 (Option C, imprecise),
compute it directly from the cohort trajectory residuals after the
model runs.

**Method**: Williams (1982) / Crowder (1978) moment estimator.

1. Phase 2 fits scalar p_cohort per edge (no per-cohort effects)
2. For each cohort trajectory i, compute maturity-adjusted implied p:
   `p_implied_i = y_final_i / (x_final_i × F(age_final_i))`
   where F is the frozen Phase 1 CDF
3. Observed variance: `s² = var(p_implied_i)`
4. Subtract expected Binomial sampling variance:
   `binomial_var = mean(p_hat × F_i × (1-p_hat×F_i) / n_i)`
5. Between-cohort variance: `σ²_bc = max(s² - binomial_var, 0) / mean(F_i²)`
6. Moment-match to Beta: `kappa = p_bar(1-p_bar) / σ²_bc - 1`
7. Predictive: `alpha = p_bar × kappa, beta = (1-p_bar) × kappa`

**Advantages over Option A and C**:
- Uses actual cohort data (not a window proxy)
- No model changes (post-processing only in inference.py)
- Can't create spurious modes or trap the sampler
- Works with frozen Phase 1 CDF (already available)
- The same residuals serve double duty: kappa estimation AND model
  fit quality diagnostic (are residuals well-behaved, centred on
  zero, any systematic pattern by age or cohort date?)

**Theoretical cost of two-step vs joint estimation**: negligible
at our data sizes. The efficiency loss is O(1/n²) for the mean and
O(1/n) for the variance (n = number of cohorts). With n ≈ 96, this
is dominated by the between-cohort term. REML (restricted maximum
likelihood) is the classical analogue — standard practice for
variance estimation in mixed models.

**Implementation**: entirely in `summarise_posteriors` in
inference.py. For each edge with cohort trajectories:
- Access trajectory data from `evidence.edges[edge_id].cohort_obs`
- Compute F(age) from frozen Phase 1 latency (already in topology
  or latency_posteriors)
- Compute kappa_empirical from Williams method
- Use for cohort predictive alpha/beta

### Phase 2 join-node CDF defect (28-Mar-26) — **FIXED 29-Mar-26**

For join-downstream edges (e.g. c→d where c has incident paths
a→b→c and a→e→c), Phase 1's likelihood correctly builds a mixture:
`p_cdf_sum(t) = Σ_alt p_path_alt × CDF_path_alt(t)`.

Phase 2 with `phase2_cohort_use_x` does NOT build this mixture. It
enters the phase2_cohort_use_x branch before the join-detection
code runs, resolves latency from `trajs[0].path_edge_ids` (one
arbitrary path), and uses that single FW-composed CDF. Other
incident paths are ignored.

This is a concrete bug for join-node graphs (diamond, lattice,
join-branch synth graphs and any production graph with joins).
Does not affect linear graphs (simple-abc, mirror-4step, drift
variants).

Fix: phase2_cohort_use_x needs to detect join-downstream edges
(via `path_alternatives`) and build the mixture CDF, same as
Phase 1's `else` branch does.

### Phase 2 should use Phase 1 evidence weight (28-Mar-26)

Currently Phase 2 freezes Phase 1 edge params to point values,
losing the posterior precision. The drift tau and cohort latency
prior widths are hardcoded, not derived from Phase 1's posterior
uncertainty. This means the "weight" of window evidence does not
influence how much freedom Phase 2's drift/latency have.

Proposed fix: set drift tau and cohort latency prior widths
proportional to Phase 1's posterior SDs. This carries the window
evidence weight through the phase boundary without sharing
variables (preserving Hamiltonian consistency).

### Remaining concerns

1. Prior Gamma(3, 0.05) is ad hoc for Phase 1 kappa_p. Needs
   principled derivation.
2. Phase 1 centred Beta parameterisation (ESS=223 for 117 p_i).
   Could benefit from non-centred if ESS degrades on larger graphs.
3. Phase 2 drift+simplex fix (replacing Dirichlet for branch group
   edges) should be kept — the Dirichlet was the original source of
   the production p_cohort drift (0.77→0.95).
4. Residual diagnostics (model fit quality check) should be
   implemented alongside the variance estimation — same data,
   different question. Track as future work.

### Phase 2 cohort p drift experiment (27-Mar-26)

**Question**: is the Phase 2 p_cohort drift (0.77→0.95 on production)
a structural logic error or a data quality issue?

**Method**: created two synth variants with 2 consecutive latency
edges, p=0.5 for both, varying upstream latency:
- Variant A: a→b 3d median, b→c 10d median
- Variant B: a→b 10d median, b→c 10d median

If cohort p differs from window p, it should ONLY be because of
elapsed time between edge and path conversions (a→x latency). With
constant synth p (no temporal drift), cohort p should equal window p.

**Results**:

| Variant | Edge | Truth p | Phase 1 p | Phase 2 p_cohort | Ph2 drift |
|---|---|---|---|---|---|
| A (3d+10d) | a→b | 0.500 | 0.699 | 0.699 | +0.0% |
| A (3d+10d) | b→c | 0.500 | 0.607 | 0.613 | +0.6% |
| B (10d+10d) | a→b | 0.500 | 0.699 | 0.700 | +0.1% |
| B (10d+10d) | b→c | 0.500 | 0.607 | 0.613 | +0.6% |

**Findings**:
1. **Phase 2 drift is negligible on clean synth** (< 1%). The
   variants are identical — upstream latency duration makes no
   difference. The Phase 2 p-latency tradeoff is NOT triggering.
2. **The production 0.77→0.95 drift is a data/sparsity phenomenon**,
   not a structural logic error. Clean synth data constrains the
   CDF well enough to prevent the degenerate mode.
3. **BUT: Phase 1 is massively inflated** — truth p=0.500, Phase 1
   recovers 0.699 and 0.607 (40% and 21% inflation). This is a
   Phase 1 p inflation issue that has not been seen on the standard
   synth suite. Needs investigation — possibly specific to p=0.5
   with these latency params, or a new regression.

### Cohort maturity curve wiring defect (27-Mar-26)

The BE analysis handler (`api_handlers.py`) reads `p.forecast.mean`
for the model CDF curve. This is always the window/promoted p,
regardless of query type. For cohort queries, the curve should use
the cohort posterior p.

The `model_vars[bayesian].probability.mean` is also always derived
from window alpha/beta (bayesPatchService.ts line 326). No cohort
probability is carried in model_vars.

Tracked in programme.md as a wiring defect, independent of the
Phase 2 p_cohort drift issue.

---

## 27-Mar-26 (cont.): Overdispersion needed for honest uncertainty

### The problem

After replacing DM→Binomial and BB→Binomial, the posterior is
unrealistically tight. For registered-to-success: α=1629, β=377
gives posterior SD = ±0.87%. The surprise gauge shows ±0.8%
confidence interval — implying ~2006 independent observations.
We don't have that. We have ~50 trajectories and ~95 daily obs.

The Binomial likelihood treats each observation as independent.
Within a trajectory, interval observations are correlated (same
cohort, sequential). Across trajectories, there's real
between-cohort variation (traffic quality, seasonality, etc.)
that the Binomial doesn't capture. The posterior is too confident.

This matters critically: the surprise gauge and cohort maturity
confidence bands are high-value outputs of the Bayes engine. With
unrealistically tight uncertainty, the surprise gauge flags
everything as "alarming" and confidence bands are sub-pixel.

### Root cause

We removed BetaBinomial (which modelled overdispersion via kappa)
to eliminate the concentration-dependent p bias. But we also
eliminated the overdispersion — the posterior lost its honest
uncertainty.

The DM had the same bias problem AND modelled overdispersion. The
Binomial has no bias AND no overdispersion. We need the
overdispersion back without the bias.

### Solution: endpoint-only BetaBinomial for rate

The K-fold concentration bias comes from having K interval-level
alpha terms all depending on p. The fix: use BetaBinomial on
trajectory **endpoints only** (one observation per trajectory).
One α, one β — no K-fold amplification.

**Model structure**:
- **Shape (latency)**: product-of-conditional-Binomials on
  trajectory intervals. Constrains CDF shape (onset, mu, sigma).
  No overdispersion needed — the CDF shape is well-determined.
- **Rate (p)**: BetaBinomial on trajectory endpoints.
  y_final ~ BB(n, p × F(age_final), kappa). Constrains p with
  honest uncertainty. kappa captures between-cohort variation.

For mature trajectories (F ≈ 1): BB(n, p, kappa) directly
constrains p. Low kappa = high between-cohort variation = wide
posteriors = honest uncertainty.

This is the shape+rate decomposition done right:
- Binomial intervals for shape (no bias, no overdispersion needed)
- BetaBinomial endpoints for rate (no K-fold bias, overdispersion
  for honest uncertainty)

### Consequences

With honest kappa and realistic α/β:
- Surprise gauge shows meaningful ±3-5% intervals (not ±0.8%)
- Cohort maturity confidence bands become visible and informative
- Surprise detection correctly identifies genuinely unusual
  behaviour rather than flagging normal variation

### Deeper problem: systematic overweighting of evidence (27-Mar-26)

The overconfident posterior is a symptom of a more fundamental issue.
A trajectory with n=300 subjects observed at 6 ages is **one
experiment**, not 6 × 300 independent trials. The product-of-
conditional-Binomials treats it as sequential independent experiments
where each interval claims n_j independent Bernoulli trials.

But n=300 people in one cohort share a context (same day, same
traffic, same product state). The cohort's aggregate conversion rate
is ONE draw from the distribution of rates. We have ~50 such draws
(trajectories), not ~15,000 independent trials.

This overweighting affects:
1. **Point estimates** — the likelihood is so strong that priors,
   onset observations, and t95 constraints can't compete (we saw
   this: onset obs provide 65 nats but trajectories provide hundreds)
2. **Posterior width** — unrealistically tight (±0.8% when real
   uncertainty is ±3-5%)
3. **Surprise gauge and confidence bands** — meaningless because
   posteriors are too confident
4. **Overfitting risk** — when evidence is rich (many large cohorts),
   the model will over-fit to noise in individual cohorts

The per-cohort frailty (shared random effect) does NOT fix this. It
makes intervals within a trajectory correlated, but each interval
still claims n=300 independent trials. The frailty shifts q_j for
the whole trajectory but evaluates each shifted q_j against n trials.

This is not unique to our model — it's endemic to any grouped
survival / CDF modelling exercise that uses product-of-conditional-
Binomials with large cohort denominators. Needs thorough literature
research on how this is properly handled.

### Resolution: the Binomial is correctly specified (27-Mar-26)

Three literature reviews established:

1. **The product-of-conditional-Binomials is algebraically identical
   to the Multinomial** (Feller 1968; Kalbfleisch & Prentice 2002;
   Cox & Oakes 1984). This is an exact identity, not an approximation.
   n subjects make n independent allocations into K+1 bins. The Fisher
   information scales as n, not K×n. No overcounting.

2. **The Fisher information about p from the full trajectory equals
   the endpoint Fisher information.** Intermediate observations add
   zero information about the conversion rate — they only add
   information about CDF shape. p and CDF shape are informationally
   orthogonal.

3. **The within-cohort likelihood is correctly specified.** The
   posterior is correctly calibrated for n independent subjects
   within each cohort. No modification needed to the interval
   Binomials.

### The real problem: between-cohort variation

The posterior is too tight because we assume all ~50 cohorts share
exactly the same p. In reality, different cohorts have different
true conversion rates (traffic quality, day-of-week, seasonality).
This is a **modelling choice** about the population of cohorts,
not a flaw in the within-cohort likelihood.

### Solution: hierarchical Beta on p (27-Mar-26)

The cure model literature (Seppa et al. 2014; Yu et al. 2011;
Peng & Taylor 2014) consistently puts random effects on the cure
fraction directly, not on the hazard:

```
p_i ~ Beta(mu_p × kappa, (1 - mu_p) × kappa)   [per cohort]
q_ij = p_i × ΔF_j / (1 - p_i × F_{j-1})         [uses p_i]
d_ij ~ Binomial(n_ij, q_ij)                       [correct]
```

Why this and not shared frailty on the hazard:

- **Standard in literature**: Seppa et al. 2014, Yu et al. 2011
  all use random effects on cure fraction, not hazard.
- **Identifiability**: shared frailty on hazard in cure models
  creates confounds (Price & Manatunga 2001) — frailty and cure
  fraction compete to explain tail behaviour.
- **Respects information geometry**: p and CDF shape are
  informationally orthogonal. Variation lives in p (between-cohort
  rate differences), not in shape (funnel mechanics are stable).
- **Better MCMC geometry**: avoids funnel pathology (Neal 2003).

**What this surfaces**: mu_p and kappa populate the existing
posterior schema fields. alpha = mu_p × kappa, beta = (1-mu_p) ×
kappa. No schema changes needed. The alpha/beta now encode honest
uncertainty — both statistical precision AND between-cohort
variation. Surprise gauge and confidence bands automatically
become meaningful.

### Implementation plan

1. Per latency edge: `mu_p = pm.Beta(...)`, `kappa_p = pm.Gamma(...)`,
   `p_i = pm.Beta(mu_p × kappa_p, (1-mu_p) × kappa_p, shape=M)`
2. Trajectory interval Binomials use `p_i[traj_index]`
3. Daily Binomials use `mu_p` (each day is its own cohort)
4. Dirichlet branch groups use `mu_p` (mass conservation)
5. Onset obs and t95 constraint unchanged (shared latency)
6. Posterior extraction: moment-match from mu_p samples
7. kappa_p to `_model_state`

No schema, FE, or webhook changes required.

### First results (27-Mar-26)

Implemented and tested. kappa_p is estimated from data:

| Edge | mu_p | kappa_p | pred SD | old SD |
|---|---|---|---|---|
| del-to-reg | 0.109 | 110.6 | ±3.1% | ±0.87% |
| reg-to-success | 0.774 | 5.2 | ±17% | ±0.87% |

reg-to-success has very low kappa_p (5.2) — high between-cohort
variation. This matches the bimodal latency observation: different
cohorts behave very differently on this edge. del-to-reg has higher
kappa_p (110.6) — more consistent across cohorts.

The predictive alpha/beta are computed in inference by drawing
p_new ~ Beta(mu_p_s × kappa_p_s, (1-mu_p_s) × kappa_p_s) for
each MCMC sample, then moment-matching. This automatically combines
estimation uncertainty + between-cohort variation.

**Per-slice predictive alpha/beta**: fixed. All slices (top-level,
window, cohort) now use predictive samples. p.mean and p.stdev
derived from predictive alpha/beta for consistency. FE consumer
chain traced and verified: inference → webhook → bayesPatchService
→ ModelVarsCards / PosteriorIndicator / surprise gauge all derive
from alpha/beta. No FE code changes needed.

### Outstanding issues (27-Mar-26)

1. **No-latency edges**: FIXED (27-Mar-26). BetaBinomial on daily
   obs with learned kappa_p. One observation per cohort (one day),
   no K-fold amplification. kappa_p estimated from day-to-day
   variation in k/n. Synth regression passes (all 41 edges ≤1.08x).
   Synth kappa_p values are high (197-334) because synth has no
   genuine between-cohort variation — correct behaviour.
   Predictive SD now realistic: landing-to-created ±2.2% (was
   ±0.14%), created-to-delegated ±3.6% (was ±0.4%).
   Caveat: gammaln bias present when alpha = mu_p × kappa_p < 5.
   For our no-latency edges (p ≥ 0.15) this requires kappa_p < 28,
   which would indicate very high between-cohort variation.

2. **kappa_p prior**: Gamma(3, 0.05) — mode=40, mean=60. Ad hoc.
   Needs validation or principled derivation.

3. **edge_kappa vs kappa_p**: two coexisting kappa variables per
   latency edge. edge_kappa is used by branch group DM and Phase 2
   cohort daily obs. kappa_p is used by hierarchical Beta on
   window trajectories. They serve different purposes but the
   relationship is not documented or validated. Do NOT remove
   edge_kappa — it has active consumers.

4. **Full regression**: the hierarchical Beta has only been tested
   on synth-simple-abc, synth-mirror-4step, and production. Full
   8-graph suite not yet run.

5. **Phase 2 interaction**: RESOLVED (27-Mar-26). Phase 2 now has
   its own kappa_cohort per edge with per-cohort p_cohort_i.
   Extraction uses kappa_cohort for cohort predictive alpha/beta.
   See "Option A implementation" section above.

### References

- Feller (1968), Introduction to Probability Theory, Vol 1
- Kalbfleisch & Prentice (2002), Statistical Analysis of Failure
  Time Data, 2nd ed — §2.4: Multinomial equivalence
- Cox & Oakes (1984), Analysis of Survival Data — §2.5
- Seppa, Hakulinen & Laara (2014), Cure fraction model with
  random effects, Stat Med 29:2781
- Yu, Tiwari & Zou (2011), Mixture cure models with random
  effects for clustered data
- Price & Manatunga (2001), identifiability of frailty in cure
  models
- Sy & Taylor (2000), EM factorisation exploiting p/latency
  orthogonality
- Harrison (2015), OLRE vs BetaBinomial, PeerJ 3:e1114

---

## 27-Mar-26: Per-retrieval onset observations + t95 constraint

### Diagnosis: why production latency drifts to nonsense

After replacing DM→Binomial and BB→Binomial, synth p recovery is
excellent (≤1.08x across all 8 graphs). But production del-to-reg
remains at 1.24x with latency drifting to sigma=2.98, onset=10.0,
giving t95≈250d — completely unphysical.

Investigation revealed:

1. **Production trajectories don't span the full maturation curve.**
   Only 2/64 window trajectories go from start (age ≤5) to plateau
   (age ≥20), vs 10/37 in synth. The model can't simultaneously
   observe onset, peak slope, and plateau in the same trajectory.

2. **The model's trajectory CDF and daily completeness use different
   onsets.** Trajectory Binomials use the latent onset (drifts to
   10d). Daily Binomials use precomputed completeness from the
   analytics engine's fixed onset (5.5d). Inconsistent CDFs
   constraining the same p.

3. **Per-retrieval onset data from Amplitude is available but unused.**
   Each snapshot retrieval derives `onset_delta_days` from the
   Amplitude lag histogram (1% mass point — see
   `onsetDerivationService.ts`). One observation per retrieval date
   per edge. The model ignores these and uses a single aggregate
   onset from the topology (5.5d).

4. **The per-retrieval onsets tell a different story.** For del-to-reg
   (50 distinct retrieval-date observations): mean=4.44d, median=5.6d,
   std=2.07d. 16% of retrievals show onset 0.0-0.1d (fast early
   conversions). The topology value of 5.5d is the mode of the upper
   peak, not the central tendency.

5. **Early conversions are real.** 8/64 window trajectories show
   non-zero cumulative_y before age 6. With the topology onset of
   5.5d, the model CDF at these ages is ~0. The model inflates sigma
   to 2.98 (spreading the CDF via softplus) to accommodate them,
   then inflates p to compensate for the flatter CDF.

### Onset also affects completeness derivation

The precomputed completeness for daily observations uses
`CDF(age, onset=5.5, mu, sigma)`. If the real onset is ~4d and the
model's latent onset drifts to 10d, completeness is wrong in both
places — the precomputed values assume 5.5d, the trajectory CDF
uses 10d. Everything downstream of CDF is contaminated.

### Proposal: feed per-retrieval onset as observed data

Each snapshot retrieval already computes `onset_delta_days` from
the Amplitude lag histogram (1% mass point, via
`deriveOnsetDeltaDaysFromLagHistogram(histogram, alpha=0.01)`).
This is analytically derived from the source data — no user input
needed.

**Important**: onset is derived once per retrieval date per edge.
Each DB row carries the same onset for convenience — the rows are
NOT independent observations. For del-to-reg, ~50 distinct
retrieval-date observations, not 1345 rows.

**Implementation**:
1. During evidence binding (`_bind_from_snapshot_rows`), collect
   distinct `onset_delta_days` values per retrieval date.
2. Store on `LatencyPrior.onset_observations: list[float]`.
3. In `build_model`, emit:
   `pm.Normal("onset_obs_{id}", mu=onset_var, sigma=std(obs),
              observed=onset_array)`
4. sigma_obs = std of the observations (≈2.0d for del-to-reg).
   This absorbs both measurement noise and the systematic gap
   between histogram onset (1% mass point) and model onset
   (CDF shift parameter). 50 observations at sigma=2.0 gives
   posterior precision ±0.3d — enough to prevent onset=10 drift.
5. This is edge-level onset, used in the window() pass. Path
   onset for the cohort() pass is derived from edge onsets.

**Expected outcome**: onset anchored near 4.0-4.5d rather than
drifting to 10d. Sigma constrained to reasonable values (CDF
doesn't need to spread to accommodate early conversions). p
inflation reduced further from 1.24x.

### t95 soft constraint from analytics pass (27-Mar-26)

Onset observations alone weren't sufficient — they constrain one end
of the CDF (when conversions start) but sigma remains free to inflate,
giving t95=250d tails. Added a t95 soft constraint:

```
t95_model = onset + exp(mu + 1.645 × sigma)
pm.Normal("t95_obs", mu=t95_model, sigma=sigma_t95, observed=t95_analytic)
```

**Where t95 comes from**: the BE stats pass computes
`t95 = onset + exp(mu + 1.645 × sigma)` where mu and sigma are fitted
from Amplitude's median_lag and mean_lag (via `fitLagDistribution`).
User horizon overrides take priority via `computeT95`. This is the
edge-level `p.latency.t95` field, NOT `promoted_t95` (Bayesian
output) and NOT `path_t95` (cumulative from anchor).

**sigma_t95 = max(t95 × 0.2, 2.0)**: ~20% relative uncertainty, floor
2 days. For del-to-reg with t95=17.4d, sigma_t95=3.5d.

### Results: onset observations + t95 constraint (27-Mar-26)

**Production (bayes-test-gm-rebuild, k/n priors):**

| Edge | DM+BB (start) | Binomial only | +onset+t95 |
|---|---|---|---|
| landing-to-created | 1.94x | 1.03x | 1.14x ⚠ |
| create-to-delegated | 1.01x | 0.99x | 0.99x |
| delegated-to-registered | 1.94x | 1.25x | **1.19x** |
| registered-to-success | 1.15x | 1.17x | 1.14x |

Del-to-reg latency: onset=8.2d, sigma=1.96, t95_model≈39d (was
onset=10, sigma=2.98, t95≈250d). Still inflated vs analytic
(onset=5.5, sigma=0.53, t95=17d) but much more reasonable.

**Synth (both graphs PASS, no regression):**

| Edge | Ratio |
|---|---|
| synth del-to-reg | 1.04x |
| synth reg-to-success | 1.02x |
| synth simple-a-to-b | 1.00x |
| synth simple-b-to-c | 0.98x |

**landing-to-created 1.03x → 1.14x**: investigated, NOT a code
regression. The window daily obs for this no-latency edge have
weighted k/n = 0.194, genuinely higher than the all-time analytic
of 0.175. The model correctly fits its window data. The discrepancy
is in the benchmark (comparing window posterior to all-time k/n),
not in the model. Anchor range also shifts by 1 day between runs.

**Bimodal latency (registered-to-success)**: the Cohort Maturity
chart shows clearly bimodal conversion timing — fast cluster of
early conversions, lull, then slow bulk. The shifted log-normal
can't represent this. The model compensates by starting early and
rising too gradually, overstating completeness at 10-30d. p and
onset converge acceptably. Mixture of two log-normals documented
as future work in doc 23 §12.

### Summary of changes in this session (27-Mar-26)

**Code changes (not yet committed):**

1. `model.py`: trajectory DM → textbook product-of-conditional-
   Binomials (Gamel et al. 2000). Both latent-latency and
   fixed-latency paths.
2. `model.py`: daily BetaBinomial → plain Binomial (same
   concentration-dependent bias as DM).
3. `model.py`: `_emit_window_likelihoods` BetaBinomial → Binomial.
4. `evidence.py`: collect per-retrieval-date `onset_delta_days`
   from snapshot rows, store on `LatencyPrior.onset_observations`.
5. `model.py`: emit `pm.Normal("onset_obs_...")` from onset
   observations (sigma_obs = std of observations, floor 1.0d).
6. `types.py`: `LatencyPrior.onset_observations` field.
   `EdgeTopology.t95_days` field.
7. `topology.py`: capture `t95` from stats pass onto EdgeTopology.
8. `model.py`: emit `pm.Normal("t95_obs_...")` soft constraint
   (sigma_t95 = max(t95 × 0.2, 2.0d)).

**Full synth param recovery**: all 8 graphs pass, all 41 edges
within 1.04x of truth. No regression from any change.

**Production del-to-reg**: 1.94x → 1.19x (k/n priors).

**TODO (noted for future)**:
- Context slices: when contexts are added, each context slice will
  provide its own onset observation per retrieval.
- Synth already writes constant onset to DB (truth value), so param
  recovery gets onset observations automatically.
- Mixture latency models for bimodal edges (doc 23 §12).

---

## 26-Mar-26 (cont.): Replace DM with textbook Binomial likelihood

### The problem

The Phase 1 window-only model uses Dirichlet-Multinomial (DM) for
trajectory likelihoods, with concentrations α_j = κ × p × ΔF_j. This
creates systematic upward bias on p for low-conversion edges: the K
interval concentration terms (each monotonically increasing in p via
gammaln(y_j + α_j) − gammaln(α_j)) collectively outweigh the single
remainder term. Result: 1.30x on delegated-to-registered (p=0.110)
even with neutral priors.

### Literature review findings

A thorough literature review established:

1. **Nobody uses DM for grouped survival / cure models.** The DM
   appears in ecology, microbiome, and NLP. It does not appear in
   survival analysis or cure model literature — not in textbooks
   (Maller & Zhou 1996; Ibrahim, Chen & Sinha 2001), not in software
   (smcure, flexsurvcure, cuRe, lifelines, CanSurv,
   bayesCureRateModel), not in methodological papers (Farewell 1982;
   Sy & Taylor 2000; Peng & Dear 2000; Chen et al. 1999; Yu et al.
   2004; Gamel et al. 2000).

2. **The textbook likelihood is a product of conditional Binomials**
   (Gamel et al. 2000; Yu et al. 2004; CanSurv software):

   L = ∏_j Binomial(d_j | n_j, q_j)

   where d_j = new events in interval j, n_j = at-risk at start of
   interval j, q_j = conditional hazard:

   q_j = p × ΔF_j / (1 − p × F_{j−1})

   Plain Binomial. No concentration parameters. No DM.

3. **The Binomial has no artificial bias mechanism.** Each interval
   contributes d_j × log(q_j) + (n_j − d_j) × log(1 − q_j). The
   conversion and survival terms naturally oppose each other. There
   are no pseudocounts that depend on p.

4. **For overdispersion, BetaBinomial is standard** — but on the
   cumulative endpoint, not on intervals. BetaBinomial on intervals
   reintroduces the same concentration-dependent bias as DM. The
   textbook default is plain Binomial; BB is added only if empirical
   overdispersion is observed.

5. **The grouped survival log-likelihood factorises cleanly** (Yu et
   al. 2004):

   log L = [Multinomial shape term (p-free)] + [Binomial rate term]

   Shape constrains latency. Rate constrains p. This decomposition
   is exact for Binomial/Multinomial. It breaks for DM because the
   DM conditional has concentrations depending on p.

6. **Dirichlet split constraints are unaffected.** The Dirichlet
   constrains the joint prior on sibling p values (mass conservation).
   This is a parameter-space constraint, orthogonal to the likelihood
   choice. Works identically with Binomial, BB, or DM.

### Why the DM bias exists (mechanism)

In the DM, concentrations α_j = κ × p × ΔF_j act as pseudocounts.
When a bin has observed conversions (d_j > 0), gammaln(d_j + α_j) −
gammaln(α_j) is monotonically increasing in α_j, hence in p. There
are K such terms (one per interval) all pulling p upward, vs one
remainder term pulling p downward. For low-p edges, the K-to-1
asymmetry creates systematic upward bias.

In the Binomial, there are no pseudocounts. The log(q_j) and
log(1 − q_j) terms balance through the data counts. No artificial
bias mechanism exists.

### Previous approaches tried and their results

| Approach | del-to-reg ratio | Notes |
|---|---|---|
| Full DM (baseline) | 1.30x | K-to-1 concentration bias |
| DM shape+rate, κ_shape = κ (ad hoc) | 1.17x | Wrong κ_shape, not principled |
| DM shape+rate, κ_shape = κ×p×CDF (exact) | 1.30x | Reproduces original DM |
| Multinomial shape + BB rate | 1.21x | Multinomial too rigid |
| Sequential BetaBinomial | 1.30x | Same bias (K small-α terms) |

All DM-based and BB-interval-based approaches share the same
structural problem: K concentration/alpha parameters that depend on p.

### Plan: implement textbook Binomial

Replace the DM trajectory likelihood with the textbook product of
conditional Binomials. This eliminates the bias mechanism entirely.

For each trajectory:
- Compute conditional hazard q_j = p × ΔF_j / (1 − p × F_{j−1})
- Emit d_j ~ Binomial(n_j, q_j) for each interval
- No κ parameter needed (Binomial has no dispersion)

If overdispersion proves necessary (empirical check after Binomial):
- Add BetaBinomial on the **cumulative endpoint only** (one α, one β)
- NOT on intervals (which reintroduces the K-fold bias)

Dirichlet branch group constraints unchanged.

### Results (26-Mar-26)

Implemented and tested with neutral priors (Beta(1,1)).

**2-step (synth-simple-abc):**

| Edge | Analytic | Bayes | Ratio |
|---|---|---|---|
| simple-a-to-b | 0.700 | 0.701 | 1.00x |
| simple-b-to-c | 0.618 | 0.603 | 0.98x |

**4-step (synth-mirror-4step):**

| Edge | Analytic | Bayes | Ratio | DM (before) |
|---|---|---|---|---|
| landing-to-created | 0.180 | 0.180 | 1.00x | 1.00x |
| created-to-delegated | 0.551 | 0.558 | 1.01x | 1.01x |
| delegated-to-registered | 0.110 | 0.118 | **1.08x** | **1.30x** |
| registered-to-success | 0.697 | 0.730 | 1.05x | 1.06x |

The critical delegated-to-registered edge improved from **1.30x to
1.08x** — eliminating 73% of the DM bias. The remaining 8% is the
genuine p-latency identifiability issue (p=0.110 with sigma slightly
inflated at 0.82 vs truth 0.57).

Sampling quality: 0 divergences, rhat ≤ 1.004, ESS ≥ 1006.

**Production results (bayes-test-gm-rebuild):**

| Edge | Analytic | Neutral (Beta(1,1)) | k/n prior |
|---|---|---|---|
| landing-to-created | 0.175 | 1.03x | 1.02x |
| create-to-delegated | 0.55 | 1.01x | 1.01x |
| delegated-to-registered | 0.095 | 1.56x (ess=7!) | 1.49x |
| registered-to-success | 0.695 | 1.23x | 1.15x |

No-latency edges excellent (1.01-1.03x). Latency edges still badly
inflated on production. The frozen Phase 1 latency for del-to-reg
shows sigma=3.12, onset=9.8 — completely unphysical (prior: sigma=0.53,
onset=5.5). The sampler finds a degenerate mode where sigma is huge.
With neutral priors the sampler can't even converge (ess=7, rhat=1.53).
k/n priors anchor it but don't fix the wrong mode.

**Key finding**: The Binomial likelihood eliminated the artificial DM
bias (synth 1.30x → 1.08x) but production has a structural data issue
that creates a much flatter likelihood ridge for p-latency. The
production trajectories evidently lack the mature-endpoint information
needed to pin p independently of latency. Investigation needed.

### Full synth param recovery (all 8 graphs, k/n priors)

Ran via `scripts/run-param-recovery.sh` with 2 chains. **p recovery
is excellent across all 8 graphs — every edge within 1.03x:**

| Graph | Edges | Max p ratio | p verdict |
|---|---|---|---|
| synth-simple-abc | 2 | 0.98x | PASS |
| synth-mirror-4step | 4 | 1.08x | PASS |
| synth-3way-join-test | 7 | 1.01x | PASS |
| synth-diamond-test | 6 | 1.01x | PASS |
| synth-fanout-test | 3 | 1.02x | PASS |
| synth-join-branch-test | 6 | 1.01x | PASS |
| synth-lattice-test | 9 | 1.02x | PASS |
| synth-skip-test | 4 | 1.03x | PASS |

Latency parameter recovery: 2/8 PASS, 6/8 PARTIAL. All failures are
onset/mu misses — onset overestimated, mu underestimated, with
corr(onset,mu) ≈ −0.99. This is the known onset-mu tradeoff for
small onset values (0.5–2.0d). Not a Binomial vs DM issue — the
latency posterior has a ridge that small onset values fall into.

### Daily BetaBinomial → Binomial fix (26-Mar-26)

**Root cause of remaining production p inflation**: the daily
BetaBinomial observations had the SAME concentration-dependent bias
as the DM. With kappa=3, alpha = kappa × p ≈ 0.285 for low-p edges.
The gammaln(k + alpha) − gammaln(alpha) term is monotonically
increasing in alpha (in p), creating upward pressure.

Numerical proof on production del-to-reg daily data (57 obs, total
n=10295, k=983, true k/n=0.0955):

| kappa | BB prefers p=? | Δ(p=.095 vs .141) |
|---|---|---|
| 3 | 0.141 (WRONG) | −9.5 nats (BB prefers inflated p!) |
| 10 | 0.141 (WRONG) | −4.9 nats |
| 50 | 0.095 (correct) | +5.5 nats |
| Binomial | 0.095 (correct) | **+59.0 nats** (strong correct signal) |

With kappa ≤ 10, the BetaBinomial actively pushes p in the wrong
direction. Binomial provides 59 nats of correct signal.

**Fix**: replaced pm.BetaBinomial with pm.Binomial for all daily
observation terms. Same rationale as trajectory DM → Binomial: no
concentration parameters, no artificial p bias.

**Production results after fix (neutral priors):**

| Edge | Before fix | After fix |
|---|---|---|
| landing-to-created | 1.03x | 1.03x |
| create-to-delegated | 1.01x | 0.99x |
| delegated-to-registered | 1.56x (ess=7!) | **1.25x** (ess=4098) |
| registered-to-success | 1.23x | **1.17x** |

**Production results after fix (k/n priors):**

| Edge | Before fix | After fix |
|---|---|---|
| landing-to-created | 1.02x | 1.03x |
| create-to-delegated | 1.01x | 0.99x |
| delegated-to-registered | 1.49x | **1.24x** |
| registered-to-success | 1.15x | **1.14x** |

Latency for del-to-reg remains unphysical (sigma=2.98, onset=10.0).
The production trajectories don't span the full maturation curve:
only 2/64 go from start (age ≤ 5) to plateau (age ≥ 20), vs 10/37
in synth. The remaining p inflation (1.24x) is from the genuine
p-latency identifiability issue, not artificial bias.

### References

- Gamel, Weller, Wesley & Feuer (2000), "Parametric cure models of
  relative and cause-specific survival for grouped survival times",
  Comput Methods Programs Biomed 61:99-110
- Yu, Tiwari, Cronin & Feuer (2004), "Cure fraction estimation from
  the mixture cure models for grouped survival data", Stat Med
  23:1733-1747
- Maller & Zhou (1996), Survival Analysis with Long Term Survivors,
  Wiley
- Ibrahim, Chen & Sinha (2001), Bayesian Survival Analysis, Springer
- Chen, Ibrahim & Sinha (1999), "A new Bayesian model for survival
  data with a surviving fraction", JASA 94:909-919
- Sy & Taylor (2000), "Estimation in a Cox proportional hazards cure
  model", Biometrics 56:227-236
- Harrison (2015), "A comparison of observation-level random effects
  and BetaBinomial models for modelling overdispersion", PeerJ 3:e1114

---

## 26-Mar-26 (cont.): Phase 1 implementation — window-only pass

### Context

The root cause of p inflation is the `p_base` sharing mechanism. Both
window and cohort likelihoods constrain `p_base` through the
`p_window`/`p_cohort` non-centred perturbation hierarchy. The cohort
path uses `stop_p_gradient`, which blocks gradient but not logp value,
creating an inconsistent Hamiltonian (see 25-Mar-26 entry). This was
established earlier but the implementation was abandoned after a false
positive (window-only mode was returning priors, not fitting data).

### Additional findings (forensic session)

1. **Post-maturation trajectory degeneracy**: production has 57/119
   window trajectories for delegated-to-registered sitting entirely
   above t95. These flat trajectories are compatible with both
   (low p, fast latency) and (high p, slow latency). With neutral
   priors, NUTS finds the wrong mode → p=0.95 (10x). Fix: improved
   zero-count dedup to collapse flat trajectories to daily obs
   (removed `len >= 4` guard, removed unconditional `keep[-1]`).

2. **No-latency DM routing**: no-latency edge trajectories were going
   through DM with fallback sigma=0.01, giving CDF(1d)=0.5 — wrong
   for instantaneous conversion. Fix: route no-latency window
   trajectories to BetaBinomial instead.

3. **Neutral prior canary**: with Beta(1,1) priors, synth recovers
   p correctly (1.09-1.17x) but production blows up (10x before
   dedup fix, 1.6x after). The k/n priors were masking the broken
   model. A correct model should work with neutral priors given the
   data volume.

### Phase 1 plan

Remove the `p_base`/`p_window`/`p_cohort` hierarchy. Replace with
single `p = pm.Beta(alpha, beta)` per edge. Remove `sigma_temporal`.

Emit only window likelihoods:
- Window trajectories (latency edges) → DM potential with `p`
- Window daily obs (no-latency edges) → BetaBinomial with `p`
- No cohort trajectories in Phase 1

Topology constraints preserved:
- **Splits**: Dirichlet/Multinomial for branch groups (unchanged)
- **Joins**: window trajectories at join-downstream edges use
  path products of upstream edge p values — gradient flows freely
  (no `stop_p_gradient` needed since this is all window data)

Implementation: pass `skip_cohort_trajectories=True` to
`_emit_cohort_likelihoods`, pass single `p` as both `p_var` and
`p_window_var`.

### Phase 1 results (26-Mar-26)

Phase 1 implemented and tested with neutral priors (Beta(1,1)).

| Edge | Synth | Production |
|---|---|---|
| landing-to-created | 1.00x | 1.03x |
| created-to-delegated | 1.01x | 1.01x |
| delegated-to-registered | 1.30x | 1.34x |
| registered-to-success | 1.06x | 1.16x |

The catastrophic synth/prod divergence is gone — both graphs behave
similarly. The p_base hierarchy was the root cause of production's
10x blowup. No-latency edges now recover correctly (1.00-1.03x).

**Residual issue — 3rd-hop p inflation (~1.3x)**: both graphs
overstate delegated-to-registered at ~1.3x with neutral priors. This
is symmetric between synth and prod, so it's a model geometry issue
(p-latency tradeoff in the window DM), not a data binding or
hierarchy issue. The window trajectories alone don't fully break the
p-latency degeneracy for this low-p edge. This is a SEPARATE problem
from the cohort pass and needs its own investigation. Likely related
to the post-maturation trajectory issue identified earlier (flat
trajectories compatible with both fast/slow latency modes).

**Phase 2 (cohort pass) is still needed** — it provides path-level
latency, drift, and dispersion estimates. It also requires full
topology sophistication (joins provide path-level constraints, splits
provide flow conservation). Phase 2 uses frozen Phase 1 p values as
`pm.Data` constants — it does NOT adjust edge p. The 1.3x issue must
be solved in Phase 1's window-only geometry.

### Phase 2 design (revised after first-principles reasoning)

Phase 2 is NOT "frozen p + free cohort p." The relationship is:

```
edge.p  ──(convolved path, drift in p)──→  path.p
  ↕                                           ↕
edge.latency ──(convolved path, drift)──→  path.latency
```

- **edge.p** and **edge.latency**: frozen constants from Phase 1
- **path.p**: derived from ∏(edge.p_i) along the path, with drift
- **path.latency**: derived from convolution of edge latencies, with drift
- **Drift** and **dispersion** (kappa): the FREE parameters. These
  define how the cohort-level quantities differ from the window-level
  quantities. The cohort DM constrains them.

Path.p and path.latency are NOT free variables. They are distributions
derived from Phase 1 frozen values, characterised by their drift and
dispersion. The cohort data tells us about drift and dispersion.

**Dirichlet IS needed in Phase 2**: drift can shift split ratios at
branch groups, and mass conservation must still hold for the derived
cohort-level quantities.

**Topology in Phase 2**:
- **Splits**: Dirichlet constrains cohort-level sibling ratios
  (which may differ from Phase 1 due to drift)
- **Joins**: path products use frozen edge p with drift → mixture
  at join nodes. Gradient flows to drift parameters, not to edge p.

### Previous failure to avoid

Last time (25-Mar-26), `feat_window_only=True` skipped the ENTIRE
call to `_emit_cohort_likelihoods`, meaning no data touched p at all.
The "perfect" recovery was just the prior. `skip_cohort_trajectories`
is different — it skips cohort trajectories but KEEPS window
trajectories and window daily BetaBinomials within the function.

Must verify: after the change, the model has >0 potentials AND the
window data actually constrains p (not just the prior).

---

## 26-Mar-26 (cont.): Progressive degradation results

### No-latency edge routing fix

**Problem found**: the evidence binder routes data based on retrieval
count (1 → daily obs → BetaBinomial, ≥2 → trajectory → DM potential).
For no-latency edges this is an artefact of fetch frequency — there is
no maturation curve, so all observations are logically (n, k) binomial
draws. Worse, the DM fallback uses sigma=0.01, giving CDF(1d)=0.5,
which is numerically wrong for an instantaneous edge.

**Fix**: in `_emit_cohort_likelihoods`, check `edge_has_latency`.
No-latency window trajectories are converted to `CohortDailyObs` and
routed to BetaBinomial. Latency trajectories still go through DM.

### Neutral prior as diagnostic canary

Added `neutral_prior` feature flag (Beta(1,1) instead of k/n-derived).
Results reveal that the production model is fundamentally broken:

| Config | deleg-to-reg ratio |
|---|---|
| Synth, full coverage, neutral prior | 1.09x |
| Synth, partial coverage (50/50), neutral prior | 1.14x |
| Synth, partial + high traffic CV, neutral prior | 1.17x |
| **Production, k/n priors** | **1.94x** |
| **Production, neutral prior** | **10.03x** |

The k/n-derived priors are masking the problem. Without them, the
production data completely fails to constrain p — the p-latency
tradeoff runs away. With neutral priors, the synth data still
constrains p fine (1.09-1.17x). Something about the production data
shape creates a degeneracy that synth doesn't have.

### Vectors tested so far

| Vector | Synth result (neutral prior) | Verdict |
|---|---|---|
| Baseline (full coverage, uniform traffic) | 1.09x | OK |
| Partial snapshot coverage (50/50) | 1.14x | Mild effect |
| Partial + high traffic CV (1.0) | 1.17x | Mild effect |

Neither partial coverage nor traffic variability triggers the 10x
blowup seen on production. The cause is elsewhere.

### Next steps

Need to identify what production data characteristic causes the
p-latency degeneracy. Candidates still to test:
- More extreme coverage split (matching prod's ~70/30)
- Anchor range (165 days vs 100)
- Something about the data shape itself (not yet identified)

---

## 26-Mar-26: Forensic synth-vs-production data comparison

### Context

The committed model recovers parameters correctly on synth data
(synth-mirror-4step PASS, 1.04x on the low-p edge) but inflates p on
production data (delegated-to-registered: 0.184 vs analytic 0.095,
1.94x). Same code path, same compiler. The difference must be in the
data characteristics, not the code.

### Forensic comparison: synth-mirror-4step vs bayes-test-gm-rebuild

Both graphs are 4-step linear chains with the same edge structure
(2 no-latency + 2 latency). After deduplication, trajectory depth is
comparable (6-12 distinct y values per active anchor day). The
meaningful differences are:

| Dimension | Synth | Production | Ratio |
|---|---|---|---|
| Anchor days | 100 | 165 | 1.7x |
| Snapshot fetch window | full 100d | last 45-60d | partial |
| Anchors with trajectories | ~97 (all) | ~50 (recent only) | 0.5x |
| Anchors as param-file daily obs | ~3 | 90-179 per edge | 30-60x |
| BetaBinomial observed RVs | 0 | 2 (no-latency edges) | structural |
| Denominator (x) variability | 130-190 | 1-945 | ~5x range |
| Daily traffic | fixed ~1600 | variable (34-25679) | high variance |

### Key structural difference: partial snapshot coverage

In production, snapshot fetching started ~60 days ago. Older anchor
days (Oct-Jan) have no snapshot rows — only the FE's param file daily
arrays. The evidence binder supplements these as `CohortDailyObs`
(single-point observations with completeness).

In synth, the snapshot DB covers the entire simulation period with
nightly fetches. Every anchor day has a rich trajectory. The param
file supplementation path is never exercised.

This means production runs a fundamentally different evidence mix:
trajectories for recent anchors + param-file daily obs for older ones.
The model was validated only against pure-trajectory evidence.

### The obs_daily BetaBinomial (model.py line 1033-1060)

Inside `_emit_cohort_likelihoods`, window daily obs (>3 points) emit
a `pm.BetaBinomial` observed RV to anchor p and prevent the p-latency
tradeoff from drifting. In production, no-latency edges accumulate 39
window daily obs each → BetaBinomial with shape=(39,). In synth, only
1 window daily obs → below the threshold, no BetaBinomial emitted.

These BetaBinomial terms constrain p through a different mechanism
than trajectory DM potentials, and share `sigma_temporal` with
latency edges. This is a candidate coupling path.

### Approach: progressive synth degradation

Rather than guessing which difference causes the p inflation, we will
degrade synth data progressively along each vector until the failure
emerges. This isolates the causal factor.

**Vector 1 — partial snapshot coverage**: Add `snapshot_start_offset`
to the truth file. The synth generator writes snapshot DB rows only
for the last N days of fetches. Param file daily arrays still cover
the full anchor range. The evidence binder will supplement older
anchor days from the param file, matching production's evidence mix.

**Vector 2 — traffic variability**: Replace fixed daily traffic with
high-variance draws (matching production's 1-945 denominator range).

**Vector 3 — daily traffic volume**: Reduce mean traffic to match
production's typical daily counts per edge.

**Vector 4 — anchor range**: Extend to 165 days to match production's
observation window.

Test each vector independently. The first one that breaks param
recovery is the culprit.

---

## 25-Mar-26 (cont.): Two-phase sampling design

### Why disconnected_grad failed

`disconnected_grad` blocks gradient but not the log-probability value.
This creates an inconsistent Hamiltonian: the gradient says "p is
prior-only" but the energy surface includes cohort potential terms that
depend on p's value. NUTS requires consistent (logp, dlogp) pairs.
The result is a corrupted posterior — p drifts away from both the prior
and the data. This is the well-known "cutting feedback" problem
(Plummer 2015, Carmona & Nicholls 2025).

### Two-phase design

**Phase 1: Window data + full graph topology**
- Edge p constrained by window trajectory DMs (with latent latency)
- Splits: Dirichlet/Multinomial (branch groups)
- Joins: path products of edge p × convolved edge latencies
- All gradient flows freely — consistent Hamiltonian
- Output: posterior means for edge.p and edge.latency

**Phase 2: Cohort data + frozen Phase 1 results**
- edge.p and edge.latency as `pm.Data` constants from Phase 1
- Path p = product of frozen edge p values
- Path latency = convolution of frozen edge latencies
- Free parameters: drift (cohort vs window deviation), dispersion
- Cohort trajectory DMs constrain drift/dispersion against frozen
  baseline — consistent Hamiltonian

### Why joins matter in Phase 1

At a join node c with inbound b→c and e→c: the total arrivals at c
constrain upstream splits (e.g. a→b vs a→g) conjointly with latency.
The graph's flow conservation creates cross-edge constraints even for
window data. Phase 1 needs full topology awareness, not just
independent edge estimation.

### Implementation approach

Phase 1: call `_emit_cohort_likelihoods` with `skip_cohort_trajectories`
flag — emits window trajectory potentials and window daily BetaBinomials
but skips cohort trajectories. Uses live p (no gradient tricks).

Phase 2: separate model with p as constants. To be implemented after
Phase 1 is validated.

---

## 25-Mar-26 (cont.): Implementing one-directional p constraint

### What we're doing

Removing the p_base/p_window/p_cohort hierarchy. The shared `p_base`
with non-centred perturbations (eps_window, eps_cohort) allows cohort
likelihoods to constrain edge p through `p_base`, violating the
one-directional invariant established below.

### Changes

**model.py** — the `has_window and has_cohort` block (lines 285–336):
- Remove: `p_base`, `logit_p_base`, `eps_window`, `tau_window`,
  `logit_p_window`, `p_window` (Deterministic), `eps_cohort`,
  `tau_cohort`, `logit_p_cohort`, `p_cohort` (Deterministic)
- Remove: `sigma_temporal` hyperprior (line 74) — no longer needed
- Replace with: single `p = pm.Beta(...)` constrained by window DM only
- Pass `disconnected_grad(p)` to `_emit_cohort_likelihoods` as both
  `p_var` and `p_window_var` — cohort DM constrains latency and
  dispersion only, cannot influence edge p

**inference.py** — posterior extraction:
- Update to look for `p_{id}` instead of `p_window_{id}` / `p_cohort_{id}`
  / `p_base_{id}`
- Window and cohort slices both report from the same `p` variable
  (they share a ground truth; the distinction was artificial)
- Remove model_state extraction for `p_base_alpha/beta` (replaced by
  `p_alpha/beta`)

### Expected outcome

- Window DM is sole authority on edge p → delegated-to-registered should
  converge near analytic 0.095
- Cohort DM constrains latency (mu, sigma, onset) and dispersion (kappa)
  using frozen p values
- Simpler model with fewer parameters → faster sampling, cleaner traces

---

## 25-Mar-26 (cont.): Fundamental model design — window/cohort relationship

### Observation

Even after the gradient-coupling fix (disconnected_grad on upstream path
products), the model still over-estimates p for delegated-to-registered:
analytic p≈0.095, model returns ≈0.184. With ~2800 snapshot rows, priors
should not dominate — yet they appear to. This points to a structural
issue in the model, not just a gradient leak.

### Root cause analysis: what does each observation type measure?

**Window observation for edge X→Y**: "Of N users at X, how many reached
Y within R days?" The denominator is ALL users at X, regardless of how
they arrived. This directly measures P(Y|X) for the general population.

**Cohort observation for path A→…→X→Y**: "Of N₀ users entering at anchor
A, how many completed A→…→X→Y within R days?" The population at X has
been filtered — only users who cleared every upstream step. This is a
selected subpopulation, not a random sample of users at X.

### Key insight: cohort supervenes on window

Cohort cannot meaningfully constrain window. It is strictly downstream.
A cohort observation of X→Y is still looking at X→Y, but only AFTER
A→…→X has happened. The relationship is:

- **p_window** is the ground truth — the edge conversion rate P(Y|X)
- **p_cohort(path)** is derived FROM the window p values along the path,
  subject to:
  (a) Possible drift (selection effects from the filtered population)
  (b) Temporal dispersion from the **convolution product** of
      intervening edge latency distributions along the path

The expected cohort path rate at retrieval age R is:

```
E[rate] ≈ ∏(p_window_i) × CDF_path(R)
```

where `CDF_path` is the convolution of individual edge latency CDFs.
Deviations from this are explained by dispersion (kappa) and drift —
NOT by adjusting edge p values.

### What this means for model construction

1. **Window DM is the sole authority on edge p.** Window observations
   constrain p_window directly. Nothing else should.

2. **Cohort DM constrains latency and dispersion.** It uses window p
   values as fixed inputs (via disconnected_grad or equivalent), combined
   through the path product, convolved with latency. It should never
   push back on edge p.

3. **The dependency is strictly one-directional.** Window p → cohort
   predictions, never cohort observations → window p.

### Why the current model violates this

The current model shares `p_base` between window and cohort:

```
p_base  ← shared Beta RV (BOTH observation types constrain this)
p_window = sigmoid(logit(p_base) + eps_w × tau_w)
p_cohort = sigmoid(logit(p_base) + eps_c × tau_c)
```

Even with disconnected_grad on the path product, cohort likelihoods
still constrain p_base through:
- The shared p_base parameter itself
- Window trajectories within `_emit_cohort_likelihoods` that use
  p_window directly (these have latent latency, creating a
  higher-p/slower-latency coupling)

Result: cohort data pulls p_base upward (from 0.097 to 0.184 for
delegated-to-registered), violating the one-directional constraint.

### Required change

Remove the p_base sharing mechanism. Window p must be an independent
variable constrained only by window DM. Cohort DM receives window p
as a frozen input and constrains only latency, onset, and dispersion
parameters.

### Status

Confirmed reasoning. Implementation plan to follow.

---

## 25-Mar-26: Production graph p inflation — OPEN INVESTIGATION

### Problem

The 4-step production graph (`bayes-test-gm-rebuild`) produces wildly
inflated probability posteriors on low-conversion edges. The model
converges (rhat=1.01, ess=313, 0 divergences) but the answers are wrong.

| Edge | Analytic p (k/n) | Bayes p | Ratio |
|---|---|---|---|
| landing-to-created | 0.175 (50900/290060) | 0.7397 | **4.23x** |
| delegated-to-registered | 0.095 (3880/40679) | 0.2878 | **3.03x** |
| create-to-delegated | 0.55 (38598/70193) | 0.7157 | **1.30x** |
| registered-to-success | 0.695 (3597/5172) | 0.6980 | **1.00x** |

Pattern: edges with low true p get inflated. High-p edge is fine.

The simplest case to investigate is `landing-to-created`: no latency,
high traffic (n=290K), simple branch group (1 evented + 1 dropout sibling).
The trajectory data clearly shows y/n ≈ 0.17 across 83 window and 77
cohort trajectories. Yet the model returns p=0.74.

### Evidence verified

- Snapshot DB: 438 window rows + 316 cohort rows for this edge. Average
  y/x=0.162 (window), y/a=0.163 (cohort). Consistent with analytic p.
- Evidence binder: 83 window trajectories (mean final y/n=0.170), 77
  cohort trajectories (mean final y/n=0.165). Data is clean.
- No-latency edge: CDF=1.0 at all ages. DM reduces to BetaBinomial.
- Kappa posterior: 1.8±0.3 (heavy overdispersion).
- Branch group `bg_1fed6ae1-a86`: non-exhaustive, 1 evented + 1 dropout
  (dropout has no data).
- Uninformative prior: Beta(1,1).

The data entering the model is correct. The model converges. But the
answer is wrong by 4x.

### Candidate hypotheses

**H1: Branch group Dirichlet coupling.** The Dirichlet constraint couples
this edge's p with its dropout sibling. If the dropout sibling has no data
and no constraint, the model may be free to assign probability between
them in a way that satisfies the DM likelihood but not reality. The
Dirichlet parameterisation might be allocating mass differently from what
the BetaBinomial on its own would.

Test: run landing-to-created as a solo edge (no branch group) and compare.
If p≈0.17 in isolation, the Dirichlet coupling is the problem.

**H2: Window vs cohort p confusion.** The model fits `p_window` and
`p_cohort` as deviations from `p_base`. The harness reports `p_window`
in the `window()` slice. But `p_base` is the hierarchical anchor — if
`p_window` and `p_cohort` are both present and pulling in different
directions, `p_base` might compromise at a value that satisfies neither
observation type well.

Test: check the posterior values of `p_base`, `p_window`, and `p_cohort`
for this edge. If `p_base` is inflated and `p_window`/`p_cohort` are
closer to 0.17, the hierarchy is the issue, not the likelihood.

**H3: Trajectory denominator mismatch.** For window trajectories, `n` is
the count of users arriving at the from-node on a given day. For a
no-latency edge, all of them should convert (or not) instantly. But
`n` varies enormously across trajectories (600 to 25,000). If the
denominator `n` represents something different from what the model
assumes (e.g. cumulative arrivals rather than daily), the BetaBinomial
would see the wrong effective sample size.

Test: inspect a few trajectories in detail — verify that `n` is a
daily count and `cum_y` is the correct cumulative conversion count for
that day's cohort.

**H4: Recency weighting distortion.** Trajectories are weighted by
`exp(-ln2 * age/half_life)` with half_life=30d. If recent trajectories
(high weight) have systematically higher y/n than older ones, the model's
weighted estimate would be pulled up. This would be a data feature, not
a model bug — but it would explain why the unweighted analytic mean
(0.175) differs from the model's estimate.

Test: compare weighted mean of y/n across trajectories against unweighted
mean. If the weighted mean is much higher, recency weighting is the
explanation (and may be correct, not a bug).

**H5: DM interval structure for no-latency edges.** With CDF=1.0 at all
ages, all CDF coefficients except the first are 1e-15 (near-zero). The
DM has many near-zero alpha terms. These shouldn't affect logp (zero
count with zero alpha = zero contribution), but `_soft_floor` or clip
floors might interact unexpectedly, creating a gradient landscape that
favours high p.

Test: manually compute the DM logp at p=0.17 and p=0.74 for the actual
trajectory data. If logp is higher at p=0.74, the DM formulation has a
bug. If logp is higher at p=0.17, the sampler is finding the wrong mode.

### Root cause (FOUND)

**`_append_single_obs` in evidence.py (line 552) applies latency
completeness to ALL daily obs, including no-latency edges.** It calls
`_compute_cohort_completeness(age, onset=0, mu=0, sigma=0.5, has_latency)`
using the topology defaults (mu=0, sigma=0.5) for no-latency edges. At
age=1 day, CDF(1, 0, 0, 0.5) = 0.5. At age=0, CDF=0.0.

The BetaBinomial likelihood multiplies `p * completeness`. With
completeness=0.5 and observed k/n≈0.21, the model infers p≈0.42. With
26/39 daily obs at age=1d (completeness=0.5) and 1 at age=0
(completeness=0.0), the effective completeness penalty pushes p from 0.17
to 0.74.

This is NOT hypothesis H1-H5. It's a simpler bug: the completeness guard
`has_latency` is checked in `_compute_window_completeness` but NOT in the
snapshot evidence path's `_append_single_obs`.

**Fix**: in `_append_single_obs`, if `not et.has_latency`, set
completeness=1.0 directly. Don't call the CDF computation.

**Update**: Fix applied but model still returns p=0.71. The completeness
bug was real and is fixed, but it's not the primary cause.

### Actual root cause: kappa-p non-identifiability

With kappa=1.8 (heavy overdispersion), the BetaBinomial likelihood is
nearly flat across p. Difference between logp at p=0.21 and p=0.70 is
only 0.9 per observation (vs 26 at kappa=50). The likelihood cannot
distinguish the correct p from a wrong one.

The Dirichlet branch group prior (alpha=[2,2] for a 2-component group
with uninformative edge priors) pulls p toward 0.5. Since the likelihood
can't push back, the posterior lands near the prior — explaining p≈0.7.

The kappa=1.8 is plausible for this data (daily k/n ranges 0.005–0.28),
but it makes p unidentifiable via the BetaBinomial. This is a structural
model problem, not a bug.

**Candidate fixes (to investigate)**:

1. **Separate kappa for daily BB vs trajectory DM**: the daily BB uses
   per-day overdispersion, but the trajectory DM uses per-trajectory
   overdispersion. These measure different things. A separate (higher)
   kappa for the daily BB would let it constrain p while the DM's low
   kappa handles trajectory-level variation.

2. **Stronger informative prior on p from evidence**: replace the
   uninformative Beta(1,1) with a data-derived prior (e.g. from the
   param file k/n). This prevents the Dirichlet from dominating when
   kappa is low.

3. **Dirichlet concentration from data**: derive alpha_vec from the
   actual observed rates, not from the (uninformative) probability
   prior. The current code uses the prior means, which are 0.5 for
   uninformative priors.

4. **Floor on kappa for the daily BB**: enforce kappa ≥ K_min (e.g. 10)
   for the daily BetaBinomial to ensure p is identifiable. The DM can
   still use its own learned kappa.

### Update: logp probe DISPROVES model construction bug

Evaluated model logp at fixed p_base values for landing-to-created
(all other params at initial point):

| p    | total logp | traj_w   | traj_c   | obs_daily |
|------|-----------|----------|----------|-----------|
| 0.10 | -64046    | -14937   | -10769   | -622      |
| 0.17 | -63732    | -14923   | -10761   | -519      |
| 0.21 | -63657    | -14923   | -10762   | -506      |
| 0.50 | -64283    | -15048   | -10868   | -1039     |
| 0.70 | -65560    | -15234   | -11019   | -1930     |

The logp is **1900 units better** at p=0.21 vs p=0.70. All three
likelihood components (window DM, cohort DM, daily BB) prefer p≈0.21.
The model IS correctly specified.

**The problem is the sampler.** NUTS converges to a wrong mode near
p≈0.7 despite the global optimum being at p≈0.2. Reports rhat=1.003
and 0 divergences — chains are all in the same wrong basin.

This is a joint-parameter landscape issue: p and kappa (and possibly
latency params on other edges) create a mode where high p + low kappa
has comparable logp to low p + high kappa when ALL parameters are
optimised jointly, even though varying p alone strongly favours the
correct value.

**Next steps**: investigate the joint landscape.

### Update: data-derived priors and feature ablation

**k/n-derived priors** (Beta(87.7, 412.3) for landing-to-created):
improved from p=0.74 to p=0.55, but still 3x wrong. Data-derived
priors are correct and needed, but don't fix the fundamental issue.

**Feature ablation** (all with data-derived priors):

| Features disabled | landing-to-created p | Ratio |
|---|---|---|
| None (full model) | 0.55 | 3.1x |
| cohort_latency=false | 0.54 | 3.1x |
| + latent_latency=false + latent_onset=false | 0.52 | 3.0x |

Even the **simplest model** (no latent latency, no cohort latency,
no latent onset — only kappa + p_base + eps + sigma_temporal) gives
p=0.52 for an edge where the data clearly shows p≈0.17. The logp
probe confirms the model prefers p=0.21 when p is varied alone.

### Root cause identified: cohort path product coupling

**Definitive ablation test**: stripped all cohort trajectories, kept
window DM + daily BetaBinomial. Result:

| Edge | Analytic | Window-only | Full model |
|---|---|---|---|
| landing-to-created | 0.175 | **0.196** (1.12x) | 0.52–0.74 (3–4x) |
| create-to-delegated | 0.550 | **0.560** (1.02x) | 0.72 (1.3x) |
| delegated-to-registered | 0.095 | **0.109** (1.15x) | 0.26–0.29 (3x) |
| registered-to-success | 0.695 | **0.694** (1.00x) | 0.70 (1.0x) |

Window-only: all edges recover correctly (within 12%).
Full model: upstream edges inflated by 1.3–4x.

The cohort DM trajectory Potentials use `p_path = Π p_edge` along the
path from anchor. This couples every upstream edge's p into every
downstream edge's cohort likelihood. The cohort path data is
**inconsistent** with the product of per-edge window conversion rates:

| Path | Window product | Cohort y/n | Ratio |
|---|---|---|---|
| [landing] | 0.175 | 0.128 | 0.73x |
| [landing, create] | 0.096 | 0.115 | 1.20x |
| [landing, create, deleg] | 0.009 | 0.010 | 1.09x |
| [landing, create, deleg, reg] | 0.006 | 0.026 | 4.09x |

The final path implies p_reg > 1.0 (0.026/0.010 = 2.6), which is
impossible. The cohort path data is internally inconsistent — likely
because cohort and window observations measure different populations
(cohort groups by anchor entry day, window groups by from-node arrival
day), and latency maturation affects the cohort y/n differently at
each path depth.

The model cannot satisfy both window and cohort constraints
simultaneously. Because the cohort path product multiplies all
upstream p values, the tension is resolved by inflating upstream edges
(which improves downstream cohort fit at the expense of upstream
edge-level fit). The window-only model has no such coupling and
recovers correctly.

**Standalone BetaBinomial test**: a minimal PyMC model with just
BetaBinomial(n, p*κ, (1-p)*κ) on the daily obs for landing-to-created
recovers p=0.205±0.005 perfectly (kappa=97). The sampler is fine;
the model construction is fine; the issue is purely the cohort path
product coupling.

**Also fixed**: completeness bug in `_append_single_obs` (no-latency
edges were getting CDF-derived completeness instead of 1.0). And
k/n-derived priors added to `_resolve_prior` (was falling through to
uninformative Beta(1,1) when param file stdev was missing).

### Two contamination pathways found

**Pathway 1: Daily BetaBinomial.** `all_daily` included both window
and cohort daily obs. Cohort daily obs have anchor denominators
(path-level: k/n = p_path for downstream edges), but the BetaBinomial
uses per-edge `p_cohort`. For `create-to-delegated`: window daily
k/n=0.555 (edge rate) but cohort daily k/n=0.094 (path rate). The
BB compromises between them, inflating p.

**Fix**: only use window daily obs in the BetaBinomial (line 647:
filter by `"window" in c_obs.slice_dsl`). Implemented and verified —
partially effective.

**Pathway 2: Cohort DM Potential logp.** Even with `disconnected_grad`
on p_path (gradient = 0), the cohort DM Potential's logp STILL varies
with p (because `disconnected_grad` only affects gradient, not forward
evaluation). NUTS uses logp for Hamiltonian acceptance, so the sampler
can still drift toward high-p regions where the cohort DM logp is
better. The `disconnected_grad` prevents gradient-based proposals but
not logp-based acceptance.

**Fix needed**: remove p from the cohort DM entirely. Use a CONSTANT
p_path (from edge priors or observed k/n) in the cohort DM alpha
computation: `alpha = kappa * p_path_constant * cdf_coeff`. This makes
the cohort DM logp invariant to p — it constrains only latency CDF
and kappa. The constant p_path gives the DM the correct scale for
modeling the conversion-vs-remainder split.

### Design principle (confirmed by investigation)

**Cohort/path observations should never constrain edge p.** Their
unique value is path-level latency (maturation CDF). Edge p comes
from window observations (direct, per-edge, no coupling).

The correct architecture:
- Window DM → constrains per-edge p + per-edge latency CDF
- Daily BetaBinomial (window obs only) → constrains per-edge p
- Cohort DM → constrains path-level latency CDF + kappa ONLY
  (uses constant p_path, no free p variable)

### Resolution: cohort path used p_window for upstream edges

The bug was in `_resolve_path_probability` line 1151:

```python
for prefix in ("p_window_", "p_base_", "p_"):
```

When building the cohort DM's path product, the function searched for
`p_window_` first for upstream edges. This wired the cohort DM's
gradient directly into upstream edges' `p_window` variables — the
same variables constrained by the window DM. The cohort DM and window
DM were pulling on the same variable in opposite directions.

**Fix**: when building a cohort path (`stop_p_gradient=True`), search
for `p_cohort_` first. This keeps cohort DM gradient on the cohort
side of the hierarchy, preventing cross-contamination of window p.

**Result** (full model, all features enabled):

| Edge | Before | After | Analytic |
|---|---|---|---|
| landing-to-created | 0.74 (4.2x) | 0.218 (1.25x) | 0.175 |
| create-to-delegated | 0.72 (1.3x) | 0.570 (1.04x) | 0.550 |
| delegated-to-registered | 0.29 (3.0x) | 0.184 (1.94x) | 0.095 |
| registered-to-success | 0.70 (1.0x) | 0.682 (0.98x) | 0.695 |

rhat=1.005, ess=1147, 100% converged, 0 divergences.

`delegated-to-registered` at 1.94x is expected — strong p-latency
coupling (mu moves from prior 1.6 to 2.4, high onset-mu correlation).
Not a wiring issue.

### Diagnostic playbook (lessons from this investigation)

This bug took extended investigation to find. The following heuristics
were each differently valuable and should be part of the standard
diagnostic approach for future model quality issues.

**A. Verify the data end-to-end.** Query the snapshot DB directly.
Inspect the raw rows. Check that trajectory n, y, and y/n values
match expectations. Check for duplicates. Check denominators (anchor
count vs from-node count). This was the FIRST thing we did and ruled
out data corruption quickly. Cheap and essential.

**B. Ablation: remove components until it starts working.** Disable
features one at a time (`--feature latent_latency=false`, etc.). Then
remove entire likelihood components (cohort DM, daily BB, cohort daily
obs). Each ablation narrows the search space. The critical finding was:
window-only model works, adding cohort DM breaks it. This pointed to
the cohort DM as the source but not the mechanism.

**C. Manual model construction.** Build the model by hand (raw PyMC,
no compiler) using the SAME data arrays. Start with 1 edge, then 2,
then 4. Compare results against the compiler model. If the manual
model works and the compiler doesn't, the bug is in the compiler logic.
This was the decisive test — the manual 4-edge model recovered all
p values correctly, proving the compiler was constructing something
different.

**D. Graph ancestry inspection.** Use `pytensor.graph.ancestors()` to
trace which variables each likelihood depends on. This revealed that
the cohort DM for downstream edges used `p_window_` (not `p_cohort_`)
for upstream edges — the actual wiring bug.

**E. Logp probes.** Evaluate `model.point_logps()` at different fixed
parameter values to check whether the model's likelihood surface is
correct. This proved the model PREFERRED the correct p values (ruling
out model specification errors) and pointed to the sampler finding a
wrong mode — which turned out to be caused by the cross-wired gradient.

**F. Standalone BetaBinomial test.** Build the simplest possible model
(just BetaBinomial with the edge's data) to verify the sampler works
correctly in isolation. This ruled out PyMC/NUTS issues.

**Ordering**: A first (cheapest), then B (narrow the search), then C
(decisive). D and E are targeted follow-ups once C identifies the
compiler as the source. F is a quick sanity check early on.

**Fallback architecture** (if constant p_path is insufficient): two-pass
fitting. Pass 1 fits window data only → per-edge p and latency. Pass 2
uses pass-1 posteriors as fixed priors and fits cohort data for
path-level quantities. This decouples the path product from the
per-edge estimation. Matches the insight that cohort observations
supervene on edge probabilities and latencies, not vice versa.

### Investigation strategy

1. **H3 first** (cheapest): inspect 3-5 trajectories end-to-end from
   snapshot DB row through evidence binder to verify `n` and `cum_y`
   mean what we think they mean. This rules out data plumbing issues.

2. **H1 second** (quick model change): run the edge in isolation (skip
   Dirichlet, use solo Beta). If p recovers correctly, we know the
   Dirichlet coupling is the problem and can investigate that
   specifically.

3. **H2 third**: extract `p_base`, `p_window`, `p_cohort` from the
   trace for this edge and compare. This tells us whether the hierarchy
   is distorting the estimate.

4. **H4**: compute weighted vs unweighted mean — one line of code.

5. **H5 last** (most expensive): manual logp evaluation. Only needed if
   H1-H4 don't explain the result.

---

## 25-Mar-26: Param recovery regression pipeline — PARTIAL, NEEDS CLEANUP

### What was attempted

Built a self-bootstrapping param recovery regression pipeline:
- Orchestrator (`bayes/run_regression.py`) that discovers synth graphs
  from truth files, checks data integrity via checksums, bootstraps
  missing data, runs MCMC in parallel with core-aware scheduling, and
  asserts recovery quality using z-score thresholds.
- Upgraded `synth_gen.py` with importable API: `discover_synth_graphs()`,
  `verify_synth_data()`, `save_synth_meta()`.
- Created 5 new truth files for Structural Canon shapes 3, 5-8
  (fanout, skip, 3way-join, join-branch, lattice).
- Rewrote `test_param_recovery.py` as a thin pytest wrapper around the
  orchestrator.

### What works

- **inference.py fix**: `import os` moved above the conditional at
  line ~679. Commit `83a96405` introduced a bug where `os.cpu_count()`
  was referenced outside the branch that imported `os`. Fix is valid.
- **Discovery + preflight**: All 8 synth graphs discovered, data
  integrity verified via DB row counts and truth file hashes.
- **synth-fanout-test**: New graph, validates end-to-end. Dirichlet
  branch group, 2 edges with asymmetric latency, MCMC converges in
  ~80s with good recovery (rhat=1.006, ess=1429, 0 divergences).
- **Orchestrator core-aware parallelism**: Correctly computes
  `available_cores // chains_per_run` for max parallel workers.
- **Two-gate assertion**: z-score OR absolute error floor, following
  SBC best practice. Prevents false failures from precise posteriors
  with tiny systematic biases.

### What failed / is unvalidated

- **4 new truth files created without validation**: synth-skip-test,
  synth-3way-join-test, synth-join-branch-test, synth-lattice-test.
  Parameters were chosen without running even `--no-mcmc` to verify
  model structure. Results: 3way-join and lattice stuck compiling
  (436s+), skip and join-branch running very slow. Likely causes:
  too many edges with latency, trajectory density too high, or
  graph structure issues from `graph_from_truth.py`.
- **Original test_param_recovery.py deleted**: The 3 working hardcoded
  tests (test_2step_synth, test_4step_mirror_recovery,
  test_diamond_recovery) were replaced. The new pytest wrapper is
  functional but the original tests were proven and should not have
  been discarded without confirming the replacement works.
- **param_recovery.py name matching**: New-format truth files use short
  edge keys (e.g. `anchor-to-fast`) while graph edges use prefixed
  param_ids (e.g. `synth-fanout-anchor-to-fast`). Added reverse lookup
  but only validated on fanout.
- **bayes-monitor auto-rebuild**: Added logic to detect new graphs and
  rebuild tmux layout. Had a `local` keyword bug (used outside
  function). Fixed but untested.

### Key lesson

**Do not create multiple untested artefacts and launch them all at
once.** Each new synth graph should be validated individually:
1. Create truth file
2. `--no-mcmc` to verify model compiles and evidence binds
3. Short MCMC (100 draws) to verify convergence
4. Full MCMC to verify recovery
5. Only then add to the regression suite

### Files changed (cleanup needed)

**dagnet repo**:
- `bayes/compiler/inference.py` — valid fix, keep
- `bayes/synth_gen.py` — new API functions, needs review
- `bayes/run_regression.py` — new file, functional but assertion
  parsing is fragile (regex on param_recovery.py stdout)
- `bayes/tests/test_param_recovery.py` — rewritten, original deleted
- `bayes/param_recovery.py` — name matching fix, needs broader testing
- `scripts/bayes-monitor.sh` — auto-rebuild logic, needs testing
- `bayes/TESTING_PLAYBOOK.md` — updated, describes intent not reality

**data repo**:
- 5 new truth files (only fanout validated)
- 7 `.synth-meta.json` sidecars
- Generated graph JSON + entity files for 5 new graphs
- DB rows for 5 new graphs (persist in snapshot DB)

### Next steps

1. Validate each new truth file individually (no-mcmc → short MCMC)
2. Fix or remove truth files that cause pathological compilation
3. Restore original test_param_recovery.py tests as fallback
4. Test the full pipeline end-to-end on proven graphs only

---

## 24-Mar-26: Zero-count trajectory filter — BLOCKING DEFECT

### Problem

The Bayes compiler needs to compress CDF trajectory data to avoid
feeding redundant frames to NUTS. A trajectory of cumulative
conversions at 30+ retrieval ages contains many consecutive frames
where no new conversions occurred. These frames are informationally
redundant — the CDF hasn't moved, so there is no new data.

Without compression, large graphs with many edges produce massive
PyTensor symbolic graphs (each age → CDF evaluation → gammaln pair),
causing compilation times of 100+ seconds and slow sampling.

### What we tried

**Zero-count bin dropping**: Remove ages where neither y nor x
changed. Keep first/last ages and predecessors of change points to
preserve non-zero interval CDF coefficients exactly.

**Result**: The filter is provably likelihood-lossless:
- Zero-count DM terms: `gammaln(0+α) - gammaln(α) = 0` always
- Kept CDF coefficients telescope: `Σ(cdf_coeffs) = CDF_final`
  regardless of which intermediate ages are dropped
- Remainder alpha `κ·(1 - p·CDF_final)` is unchanged
- Total `Σα = κ` is preserved

Yet it **breaks NUTS** on production data. Reproducible: rhat=1.53
every run with filter, rhat=1.002 every run without. Not stochastic.
Confirmed with `--asat` (same data, same result). The synth 4-step
regression test passes with the filter — the issue is specific to
production data with marginal posterior geometry (edge 7bb83fbf's
onset-mu ridge).

### Why likelihood-lossless ≠ NUTS-lossless

The research (Tran & Kleppe 2024, Stan HMC documentation) identifies
the mechanism: NUTS adapts its mass matrix and step size during warmup
based on the gradient landscape. Zero-count DM terms contribute zero
logp AND zero gradient — but the CDF evaluation points at those ages
provide **gradient anchor points** that NUTS uses to navigate the
posterior geometry. Removing those evaluation points changes the
curvature landscape that NUTS adapts to, even though the logp surface
is mathematically identical.

This is analogous to removing data points from a regression that lie
exactly on the fitted line — they don't change the loss, but they
stabilise the optimiser.

### Correct approach from the literature

The standard lossless CDF compression uses a **grouped survival /
mixture-cure likelihood** formulation:

```
ℓ = Σ_{j: y>0} y_j · [log(p) + log(F(t_j) - F(t_{j-1}))]
  + (N - Σy) · log(1 - p·F(H))
```

Zero-count bins don't appear at all. The sufficient data per
trajectory is:
- `(t_j, y_j)` pairs where `y_j > 0` (non-zero event bins only)
- `N` (total at risk)
- `H` (horizon / last observation age)

For the DM with overdispersion (κ):
```
ℓ = Σ_{j: y>0} [gammaln(y_j + α_j) - gammaln(α_j)]
  + gammaln(R + α_R) - gammaln(α_R)
  + gammaln(κ) - gammaln(N + κ)
```

The problem: this is algebraically identical to our current filter
(the zero-count terms are 0 either way). The gradient information
loss is the same.

**Approach B — Poisson exposure penalty**: Replace the identically-
zero DM terms for zero-count intervals with Poisson exposure terms
that carry non-zero gradient:

```
logp_zero_block = -κ · p · (CDF(t_end) - CDF(t_start))
```

This is the piecewise-exponential / counting-process formulation from
the survival literature. A zero-event interval over CDF span ΔF
contributes `-κ·p·ΔF` — a penalty proportional to the expected
events. This:
- Is non-zero (preserves gradient flow through zero-event regions)
- Is mergeable: `-Σ(κpΔF_i) = -κp·Σ(ΔF_i)` (lossless compression)
- Provides "nothing happened here" signal to NUTS
- Approaches 0 as ΔF→0 (consistent with DM in the limit)

The hybrid model: DM for intervals with events (preserves
overdispersion), Poisson penalty for intervals without events
(preserves gradient signal). Consecutive zero-event intervals are
merged into exposure blocks.

### References

- DM aggregation property: Frigyik, Kapila, Gupta (Introduction to
  the Dirichlet Distribution)
- Grouped mixture-cure likelihood: OUP Academic (mixture cure models
  for grouped survival data)
- Stan sufficient statistics: Stan User's Guide §25.9
- Piecewise exponential / exposure blocks: Rodríguez (GLM notes §7.4)
- NUTS mass matrix sensitivity: Tran & Kleppe (2024), Stan HMC docs
- Interval censoring NPMLE: Turnbull (1976), PMC 3684949

### Status

**RESOLVED.** Root cause: hard `pt.clip`/`pt.maximum` at 1e-12
created dead-gradient regions (Stan §3.7). Replaced with smooth
`_soft_floor` (softplus-based, sharpness=1e6). Filter re-enabled.

Results with filter ON + smooth clips:
- Production (today): rhat=1.002, ess=2655, 0 divergences
- Synth 4-step: PASS
- Synth 2-step: PASS

Full briefing and external review in doc 20. Further recommended:
dense mass matrix for high onset-μ correlation edges (not yet tested).

---

## 24-Mar-26: Structural topology canon — 8 shapes proven

### Summary

Systematically tested every fundamental DAG shape with parameter
recovery. All converge with 0 divergences. The mixture CDF fix from
23-Mar-26 enables all join-containing topologies.

| # | Shape | Graph | rhat | Time | Recovery |
|---|---|---|---|---|---|
| 1 | Chain (all-latency) | synth-simple-abc | 1.002 | 267s | mu ✓ |
| 2 | Chain (mixed) | synth-mirror-4step | 1.003 | 130s | all ✓ |
| 3 | Fan-out | synth-fanout-test | 1.001 | 72s | mu ✓, Dirichlet ✓ |
| 4 | Diamond | synth-diamond-test | 1.001 | 935s | mu ✓, join ±drift |
| 5 | Skip edge | synth-skip-test | 1.003 | 296s | mu ✓, unequal paths ✓ |
| 6 | Join→branch | synth-join-branch-test | 1.005 | 567s | mixture→Dirichlet ✓ |
| 7 | 3-way join | synth-3way-join-test | 1.003 | 603s | 3-component mixture ✓ |
| 8 | Lattice | synth-lattice-test | 1.003 | 930s | 4-component nested ✓ |

### Key observations

**What works well**: upstream edges (directly from anchor) recover
mu within 0.01-0.02 of truth across all topologies. The Dirichlet
branch group, per-sibling completeness, and mixture CDF all function
correctly.

**Onset-mu drift at joins**: join-adjacent edges consistently show
onset-mu correlation > 0.95, causing parameter drift (onset trades
with mu). This is a precision limitation, not a convergence failure.
The model finds a consistent solution but not the exact truth values.
May improve with more data or stronger priors.

**Not tested**: asymmetric diamond (95/5 weight split — identifiability
stress test), case node (exhaustive Dirichlet). These are deferred to
when needed.

### Tooling improvements

**Truth-driven graph generation** (`graph_from_truth.py`): truth files
now define graph STRUCTURE (nodes, edges, topology) in addition to
statistical parameters. `synth_gen` generates graph JSON, entity files,
dropout nodes, and complement edges from the truth file alone. No more
manual graph construction. Tested on diamond and lattice.

**Edge name resolution** (`_resolve_truth_edge`): handles the mapping
between short truth names (`anchor-to-gate`) and generated prefixed
param_ids (`synth-diamond-anchor-to-gate`). Replaces the scattered
`truth.get("edges", {}).get(pid)` pattern throughout synth_gen.

**Context-aware synth_gen**: three-layer noise model infrastructure
(contexts + per-user variation + drift) implemented. Truth files can
define `context_dimensions` with per-edge overrides. Observations
emitted with context-qualified slice_keys. Param files include
per-context values[] entries. Graph pinnedDSL uses cartesian product
form. Ready for Phase C compiler work.

---

## 23-Mar-26: Mixture CDF at joins — FIXES diamond convergence

### The bug

The topology pass selected ONE path (highest weight) at join nodes and
discarded all others. For the diamond's join→outcome edge, `path_edge_ids`
contained only path A — path B's parameters got zero gradient from the
cohort observation. The model was structurally misspecified: trying to fit
mixture data (arrivals from both paths) with a single component.

### The fix

**Topology**: Added `path_alternatives` field to EdgeTopology. At join
nodes, ALL inbound paths are stored as alternatives (not just the best).
Alternatives propagate recursively through downstream edges — handles
nested joins (combinatorial: 2 joins × 2 paths = 4 alternatives).

**Model builder**: For cohort trajectories on join-downstream edges with
multiple path alternatives, the DM likelihood uses a mixture CDF:

```
prob_interval_i = Σ_alt [p_alt × ΔCDF_alt(t_i)]
```

where p_alt = product of p's along the alternative path, CDF_alt =
FW-composed latency along that path. Gradients flow to ALL path
parameters through the sum. Single-path edges are unchanged.

### Result

**Diamond (easy: 1 no-latency + 5 latency edges, 500 draws, 2 chains)**:
- Before fix: early abort at 1%, estimated 17+ min. FAIL.
- After fix: rhat=1.017, ess=301, **0 divergences**, 178s. PASS.

Parameter recovery (quick run, wider tolerances expected):

| Edge | Truth mu | Post mu | Truth onset | Post onset |
|------|----------|---------|-------------|------------|
| gate→path-a | 1.500 | 1.511±0.005 | 1.0 | 1.13±0.03 |
| gate→path-b | 1.800 | 1.813±0.006 | 2.0 | 2.11±0.04 |
| path-a→join | 1.300 | 1.127±0.035 | 1.0 | 1.64±0.11 |
| path-b→join | 1.500 | 1.302±0.032 | 1.0 | 1.84±0.11 |
| join→outcome | 1.300 | 1.166±0.033 | 1.0 | 1.51±0.11 |

Upstream edges recover accurately. Join-adjacent edges show onset-mu
ridge (corr ≈ -0.99) causing some drift — but the model converges with
0 divergences, which it categorically could not do before.

### Key insight

The join problem was NOT inherent NUTS geometry — it was a **model
misspecification**. The single-path approximation discarded ~43% of the
traffic at the join. Fixing the model to represent the actual mixture
resolved the convergence failure immediately.

### Files changed

- `compiler/types.py` — added `path_alternatives` field to EdgeTopology
- `compiler/topology.py` — propagate all inbound paths at joins, store
  alternatives recursively through downstream edges
- `compiler/model.py` — mixture CDF in `_emit_cohort_likelihoods` when
  `path_alternatives` has >1 entry

---

## 23-Mar-26: Diamond graph confirms join-node convergence is a model issue

### What was tested

Ran `synth-diamond-test` (6 all-latency edges: anchor → branch (path-a,
path-b) → join → outcome) through the full pipeline: integrity check →
synth_gen → param recovery.

Structural integrity: PASS (after adding missing `defaultConnection`).
Data generation: PASS (56,004 rows, all 12 hashes verified).
Stats engine priors: accurate (mu within 0.002 of truth for all edges).

### Result

**EARLY ABORT** at 1% sampling — estimated 17+ minutes (3x limit).
PyTensor compilation alone took 117s (vs 3s for 4-step linear, 19s for
2-step). The symbolic graph is massive: 6 latency edges × 45-82 ages
per trajectory.

This is the join-node convergence problem. The diamond has a branch
(gate → path-a, gate → path-b) merging at a join node, creating the
p-latency identifiability coupling the journal has documented since
20-Mar-26.

### Significance

**This is NOT a data issue — it's a model structure issue.** We hoped
the production branch graph's convergence problems were data quality,
but the diamond uses clean synthetic data with known ground truth and
still fails. The join-node geometry is fundamentally difficult for NUTS.

The linear chains (2-step, 4-step) converge perfectly with accurate
parameter recovery. The diamond fails. The structural differentiator
is the join node.

### Known approaches not yet tried (from journal 21-Mar-26)

1. **Window-first two-phase**: fit window data per-edge first (always
   well-conditioned), use posteriors as strong priors for cohort fitting.
   Most promising — eliminates p-latency ambiguity at joins by pinning
   latency from window data.
2. **Softmax reparameterisation at joins**: parameterise join-node path
   shares on unconstrained logits.
3. **SMC (Sequential Monte Carlo)**: tempering from prior to posterior.
   Diagnostic tool for multimodality.

### Outstanding issues

- **Kappa discrepancy explained — noise model redesign needed (Phase C)**:
  posterior κ is 10-45x truth because synth_gen's noise model is wrong.
  It applies overdispersion as per-DAY p draws (one Beta per day, everyone
  on that day uses it). This creates between-day total variance but NO
  within-trajectory overdispersion — the time allocation within each
  trajectory IS pure multinomial, so the model correctly finds large κ.

  Real overdispersion comes from three layers:
  1. **Contexts** (discrete user types) — different {p, mu, sigma} per
     edge per context. Creates mixture CDFs → DM overdispersion in
     trajectory shapes. This is the dominant source.
  2. **Per-user variation within context** — individual propensity/speed
     drawn from a distribution centred on the context's values. Creates
     residual BetaBinomial variance even after conditioning on context.
     This is what κ should capture.
  3. **Day effects** — temporal drift in rates (already modelled via
     drift_sigma, minor contribution).

  The fix: replace kappa_sim with context-based population heterogeneity
  in synth_gen. Contexts define per-edge overrides; users are assigned
  to contexts; per-user Beta draws within context create residual
  overdispersion. κ recovery becomes testable when the noise model
  reflects real population structure. This work is Phase C for synth_gen.
- **Trajectory density on slow-latency edges**: truth mu=2.3 (median
  ~10 days) produces 59-83 ages after dedup vs 17-23 for mu=1.5.
  Causes 267s sampling on 2-step (vs 130s for 4-step mirror).
  Compilation time scales badly: 117s for diamond's 6 edges.

---

## 23-Mar-26: Tooling hardening and parameter recovery baseline

### What was done

**Model inspection** (`compiler/inspect_model.py`): Structured dump of the
compiled pm.Model that runs AFTER `build_model()`, BEFORE MCMC — always,
every run. Shows all free RVs with distributions, deterministics, potentials,
observed RVs, per-edge evidence binding confirmation, feature flags, and
variable→edge mapping. Harness flag `--no-mcmc` stops before sampling.

**Feature flags via settings** (`--feature KEY=VALUE`): Model features
(latent_latency, cohort_latency, overdispersion, latent_onset) are now
passed through harness CLI → payload settings → `build_model(features=...)`.
No code changes needed for parallel A/B runs:
```
python bayes/test_harness.py --graph X --feature latent_onset=false
python bayes/test_harness.py --graph X --feature latent_onset=true
```

**Parameter recovery shim** (`bayes/param_recovery.py`): Wraps the harness
for synth graphs. Reads .truth.yaml sidecar, runs MCMC, compares posteriors
to ground truth with z-scores and PASS/MISS per parameter. NOT for production
data — production has no ground truth.

**synth_gen hardened**:
- FAILS if no .truth.yaml sidecar exists (no silent fallback to defaults —
  the old fallback to `derive_truth_from_graph` wasted hours producing data
  from wrong parameters)
- `write_parameter_files` now derives `latency_parameter` from the truth
  config, not from the stale topology object (which was built before
  `update_graph_edge_metadata` ran)
- `--write-files` flag required to update param files on disk

### Bugs found and fixed

**param files had wrong `latency_parameter`**: `write_parameter_files` read
`et.has_latency` from the topology, which was built from the graph BEFORE
`update_graph_edge_metadata` wrote `latency_parameter: true`. Result: edges
with latency in truth had `latency_parameter: false` in param files. The
stats engine and topology then treated them as no-latency edges, producing
wildly wrong priors (mu=0.518 instead of mu=2.3 for the 2-step a-to-b edge).
Fixed to derive `latency_parameter` from the truth config directly.

**4-step regression no longer reproduces**: The rhat=1.530 regression
reported earlier in this journal (onset hierarchy removal) does not reproduce
with current code. The production 4-step now converges: rhat=1.002,
ess=2780, 0 divergences, 59s. Likely caused by stale param files or
topology.py state at the time of the original regression runs.

### Parameter recovery results

**2-step synth** (`synth-simple-abc`, all-latency, 267s):

| Edge | Param | Truth | Posterior | z-score |
|------|-------|-------|-----------|---------|
| a-to-b | mu | 2.300 | 2.309±0.003 | 3.00 |
| a-to-b | sigma | 0.500 | 0.511±0.002 | 5.50 |
| a-to-b | onset | 1.000 | 1.050±0.030 | 1.67 |
| b-to-c | mu | 2.500 | 2.496±0.011 | 0.36 |
| b-to-c | sigma | 0.600 | 0.617±0.008 | 2.13 |
| b-to-c | onset | 2.000 | 2.200±0.100 | 2.00 |

Posteriors extremely close to truth (0.4% error on mu). High z-scores
are precision artefacts — posteriors are so tight (±0.003) that sub-percent
deviations register as >2σ. Recovery is accurate.

**4-step synth mirror** (`synth-mirror-4step`, 2 no-latency + 2 latency, 130s):

| Edge | Param | Truth | Posterior | z-score |
|------|-------|-------|-----------|---------|
| deleg-to-reg | mu | 1.500 | 1.477±0.032 | 0.72 |
| deleg-to-reg | sigma | 0.570 | 0.599±0.021 | 1.38 |
| deleg-to-reg | onset | 5.500 | 5.670±0.150 | 1.13 |
| reg-to-success | mu | 1.300 | 1.042±0.234 | 1.10 |
| reg-to-success | sigma | 0.190 | 0.234±0.044 | 1.00 |
| reg-to-success | onset | 3.200 | 4.000±0.700 | 1.14 |

All within 2 SD. PASS.

**4-step production** (`bayes-test-gm-rebuild`, 59s):
rhat=1.002, ess=2780, 0 divergences. Converges cleanly. Edge 7bb83fbf
posterior mu=5.389 (prior=1.607) — data strongly disagrees with prior
but the model converges to a consistent answer.

### Systematic kappa issue

Kappa (BetaBinomial overdispersion) is consistently 10-45x too high
across both synth graphs:

| Graph | Edge | Truth κ | Posterior κ |
|-------|------|---------|------------|
| 2-step | a-to-b | 50 | 1321±54 |
| 2-step | b-to-c | 50 | 2250±98 |
| 4-step | deleg-to-reg | 50 | 556±58 |
| 4-step | reg-to-success | 50 | 478±57 |

The model sees near-zero overdispersion (large κ → Binomial limit) when
the data was generated with moderate overdispersion (κ=50). Either:
1. synth_gen's overdispersion simulation doesn't produce BetaBinomial-style
   variation (wrong noise model), or
2. The DM likelihood's κ parameterisation doesn't match synth_gen's κ_sim
   definition, or
3. The trajectory-based DM likelihood averages over enough days that
   per-day overdispersion is smoothed away

**Not blocking** — mu/sigma/onset recovery works. But κ recovery failure
means the model can't correctly estimate uncertainty bounds on conversion
rates (overconfident posteriors).

### Current state

All three graphs converge with correct parameter recovery on mu/sigma/onset.
The tooling pipeline (truth file → synth_gen → DB → harness → model inspect
→ MCMC → param recovery comparison) is end-to-end functional. Remaining:
- κ discrepancy investigation
- p recovery (not yet extracted by param_recovery.py)
- Playbook update for param recovery vs production run workflows

---

## 22-Mar-26: Synthetic data generator → parameter recovery attempt

### What was done

Built the `synth-simple-abc` graph: A → B → C linear chain with dropout
nodes, realistic latencies (onset 1–2d, median 10–14d), complement edges
for mass conservation. Ground truth: p(A→B)=0.7, p(B→C)=0.6.

**synth_gen.py restructured**: simulation and observation phases fully
separated. Window and cohort observations now represent genuinely different
populations — window groups by from-node arrival day (cross-day mixture
due to upstream latency), cohort groups by anchor entry day. Verified by
4 new pytest tests (`TestWindowVsCohortSemantics`), 27/27 pass.

**Data pipeline working**: 19,220 DB rows (9,610 window + 9,610 cohort),
real FE-computed core hashes (vitest parity verified), param files with
both window and cohort values[] entries. FE renders the graph and shows
cohort maturity S-curves.

**graph-ops moved to dagnet**: Generic playbooks, scripts, reference docs
scrubbed of proprietary content and moved to `dagnet/graph-ops/`. Data
repo retains only proprietary reference docs. Merged to
`nous-conversion/main`.

### Sampling performance problem — investigation log

**Symptom**: 2-edge synth graph takes 15 minutes to sample (887s,
252 divergences, kappa=728/868). The 4-edge production graph
(`bayes-test-gm-rebuild`) samples in ~4 minutes (241s, 151 divergences,
kappa=1.7-24.8). Despite the synth graph being simpler.

**Parameter recovery works**: When sampling completes, the posteriors
recover truth values accurately (mu, sigma, onset all within 1-2%).
The issue is purely sampling efficiency, not model correctness.

**What was ruled out**:

- **Data volume (total rows)**: Synth has fewer total rows (19K) than
  production (76K via hash equivalences). Not the issue.
- **Trajectory density (retrieval ages per anchor_day)**: Synth has 94
  retrieval ages vs production 5-27. The DM interval model decomposes
  into independent intervals — thin vs fat intervals contain identical
  statistical information. Extra density costs ~5-7x more gammaln calls
  per step but should NOT change posterior geometry.
- **Traffic per day**: Tried 5000/day and 300/day — same result.
- **PyTensor type bug**: Found `bool→float64` composite rewrite failure
  in `obs_daily_` path with small arrays. Fixed but didn't help — issue
  is in the trajectory Potentials.

**Key structural difference (NOT YET TESTED)**:

Production graph: 2 edges `latent_latency=False` (simple Binomial) +
2 edges `latent_latency=True` (CDF-based DM potentials).

Synth graph (`synth-simple-abc`): ALL edges `latent_latency=True`.
The `update_graph_edge_metadata` in synth_gen was hardcoding
`latency_parameter: True` on all fetchable edges — fixed to respect
the truth config.

**Hypothesis**: ALL-CDF models have worse geometry than mixed models.
The Binomial potentials provide well-conditioned probability anchors.
Without them, onset↔mu correlations (corr=-0.88) create narrow ridges.

**Next step**: Build `synth-mirror-4step` matching production structure
exactly (2 no-latency + 2 latency edges, similar traffic/p values).
Compare sampling performance. If it samples in ~4 minutes, the
hypothesis is confirmed.

**Also documented**: Bayes compiler uses `query_snapshots_for_sweep`
(all raw rows) while FE uses `query_virtual_snapshot` (latest-wins).
See `docs/current/codebase/snapshot-db-data-paths.md`.

### 23-Mar-26: Removed onset hierarchy — fixed 2-step, regressed 4-step (OPEN)

**Hierarchy removed**: `onset_hyper_mu` and `tau_onset` shared across
latency edges. No intellectual justification for sharing onset across
edges with different business processes. Replaced with independent
per-edge onset: `softplus(onset_prior + eps × uncertainty)`.

**2-step synth (FIXED)**:
- Before: rhat=1.661, 679 divergences, 300s. Degenerate hierarchy
  (4 hyper-params for 2 onset values).
- After: rhat=1.008, **0 divergences**, 50s. Clean convergence.

**4-step production (REGRESSED)**:
- Before (with hierarchy): rhat=1.006, 22 divergences, 89s.
- After (independent onset): rhat=1.529-1.605, ess=7, 62s.
- Same priors (mu_prior=1.502, sigma_prior=0.574 from derive_latency_prior).
- Same data, same filter.
- Edge 7bb83fbf posterior mu=5.7 (far from prior 1.5) regardless.

**Unexplained**: A prior shape change (hierarchical → independent) with
the SAME effective prior centre and similar spread should not cause
catastrophic convergence failure. The old hierarchy had 2 extra free
parameters (hyper_mu, tau) which should make sampling HARDER, not easier.
Yet the old version converged and the new doesn't.

**Possible explanations to investigate**:
1. The hierarchical parameterisation accidentally provided a better
   mass matrix initialisation (shared params smooth the geometry).
2. The softplus(constant + eps × sigma) creates a different gradient
   landscape than softplus(free_param + eps × free_param).
3. The path-level onset (`onset_cohort`) changed parameterisation too
   (uses eps × 1.0 fixed dispersion instead of eps × tau × sqrt(n)).
   This may be too tight for the production edge.

**Next step**: Compare PyTensor computational graphs between old and
new. Check nutpie step size and mass matrix diagnostics. The issue is
in the sampling geometry, not in the statistical model.

### 23-Mar-26: Removed graph-level onset hierarchy (onset_hyper_mu, tau_onset)

**What was removed**: Graph-level `onset_hyper_mu` and `tau_onset` shared
across all latency edges (Phase D.O, doc 18). These created a hierarchical
model where each edge's onset was drawn from a shared distribution.

**Why**: No intellectual justification for sharing onset across edges.
Onset is a property of a specific business process (how long before a
specific conversion begins). Edges in different regions of the funnel
have genuinely different onset characteristics — there is no reason to
assume they come from a shared distribution.

The topological constraints (branch group Dirichlet, FW path composition,
join node mixing) are the correct inter-edge structure. These are
structural properties of the graph, not statistical assumptions.

**Immediate trigger**: The hierarchy made 2-edge all-latency graphs
degenerate. 4 hierarchical parameters (hyper_mu, tau, eps_1, eps_2)
estimated from 2 onset values — underdetermined, creating a posterior
ridge that NUTS couldn't traverse (rhat=1.661, 679 divergences).

**Fix**: Each latency edge gets an independent onset prior from its
own histogram data. No shared parameters across edges.

### 23-Mar-26: Zero-count bin merging — corrected implementation

**First attempt (broken)**: Dropped ages where `cumulative_y[i] != kept_y[-1]`
(comparison against last KEPT value, not previous consecutive value). This
widened non-zero interval CDF coefficients → changed DM likelihood → rhat
regressed from 1.004 to 1.530.

**Corrected**: Keep ages where `y(t) != y(t-1)` OR `x(t) != x(t-1)`
(consecutive comparison), plus the age before each change point (to preserve
non-zero interval boundaries), plus first/last. Zero-count bins are merged
but non-zero interval CDF coefficients are preserved exactly.

**Literature confirms**: Zero-count DM bins contribute `gammaln(0+α) - gammaln(α) = 0`
regardless of α. Merging them is provably lossless. But the previous filter
inadvertently changed non-zero interval boundaries, which IS lossy.

**Results with corrected filter**:
- Production graph: rhat=1.006, ess=996, 22 divergences (IMPROVED from 49)
- Synth mirror 4-step: 94 ages → 3-23 ages. rhat=1.014, 264s. Converges.
- Synth simple 2-step: 94 ages → 6-22 ages. rhat=1.661. Doesn't converge
  (all-latency geometry issue, not filter issue).

### 23-Mar-26: BE stats engine and topology prior priority

**BE stats engine** (`graph-editor/lib/runner/stats_engine.py`): Full port
of FE `enhanceGraphLatencies` — topo pass, FW composition, t95 improvement,
p_infinity estimation. Wired into harness via `handle_stats_topo_pass`.

**Problem**: The topology builder (`topology.py`) reads priors from
`derive_latency_prior(median_lag, mean_lag, onset)` which produces different
values from both the FE stats pass and the BE stats engine. Three different
computations of the same quantity:

| Source | Edge 3 mu | Edge 3 sigma |
|--------|-----------|-------------|
| FE (on graph) | 1.867 | 0.369 |
| BE stats engine | 1.157 | 0.800 |
| topology derive_latency_prior | 1.502 | 0.574 |

**Only derive_latency_prior gives convergence** on the production graph
(rhat=1.006). The BE engine values (mu=1.157) cause rhat=1.735. The FE
values (mu=1.867 via direct read) also fail.

**Root cause**: The model posterior wants mu≈5-7 for this edge (production
data). All three priors are < 2. The model is very sensitive to sigma_prior —
derive_latency_prior gives sigma=0.574 which is wide enough for the sampler
to explore. The BE engine gives sigma=0.800 (wider) but mu=1.157 (lower),
creating a different posterior geometry that traps the sampler.

**Decision**: Reverted topology to original priority (median/mean first,
mu/sigma fallback). The BE stats engine needs parity validation against the
FE before it can be trusted for priors. The topology's derive_latency_prior
is a crude but WORKING approximation.

**TODO**: Validate BE stats engine against FE output on production data.
The three-way discrepancy must be resolved — all paths should produce
identical mu/sigma for the same input data.

### 23-Mar-26: Zero-increment filter — WRONG, reverted

**Attempted**: Drop trajectory ages where neither x nor y changed, on the
theory that zero-count DM intervals contribute `gammaln(0+α) - gammaln(α) = 0`.

**Result**: rhat regressed from 1.004 to 1.530 on the production graph.

**Why it's wrong**: The DM logp for a zero-count interval is NOT zero.
It's `gammaln(0 + κ·p·cdf_coeff) - gammaln(κ·p·cdf_coeff)` which equals
zero only when `cdf_coeff` is zero. When `cdf_coeff > 0` (model predicts
conversions should happen), zero observed conversions is a PENALTY. This
is how the model learns where the CDF rises — ages with zero conversions
but positive CDF prediction constrain the CDF shape.

**Correct approach for data density reduction**: The filter was wrong
because it assumed "no change = no information." In fact, "no change"
= "the model's predicted CDF increment here was wrong if it's non-zero."
The correct way to reduce density is to MERGE adjacent intervals into
wider bins (e.g. merge ages [5,6,7,8] into one interval [5,8] with
total count = sum of increments). This preserves the statistical content
(same total count, same CDF span) but reduces the number of evaluation
points. The bin boundaries should be chosen to give roughly equal CDF
increments, not equal age spacing.

Alternatively, synth_gen should match the production fetch model (window-
limited observations) rather than writing the full triangular matrix.

### 23-Mar-26: Trajectory x(t) data and redundant-frame filtering

**Problem**: Synth data has 94 retrieval ages per anchor_day (full
triangular matrix from nightly fetch simulation). Most ages show no
change in y — the CDF plateau means 80+ ages are redundant. 94-point
trajectories cause 18K+ CDF evaluations per gradient step, making
sampling take 27 minutes for a 4-edge graph.

**Fix (evidence binder)**: Added zero-increment filtering in
`_build_trajectories_for_obs_type`. Ages where NEITHER x nor y changed
are dropped. Always keeps first and last ages. Reduces trajectory
density from 94 to 2-21 ages depending on edge latency.

**Key insight on x vs y**: Window observations have fixed x (from-node
arrivals on anchor_day don't change). Cohort observations have GROWING
x(t) as upstream arrivals accumulate. The filter checks both — ages
where x changed but y didn't are informative about upstream latency
timing and must be retained.

Added `cumulative_x` field to `CohortDailyTrajectory` to store per-age
from-node arrival counts alongside cumulative_y.

### 23-Mar-26: Per-age x(t) — future model consumption (DESIGN NOTE)

The model currently uses a fixed denominator per trajectory:
- Window: n = x (fixed, from-node arrivals on that day)
- Cohort: n = a (fixed, anchor entrants)

For cohort trajectories, x(t) provides a direct observation of the
upstream CDF: `x(t)/a ≈ p_upstream × CDF_upstream(t)`. This data is
now preserved on the trajectory but NOT yet consumed by the model.

**Options for consuming x(t)**:

**A. Second Potential per cohort trajectory**: Score x(t) against the
upstream CDF (FW-composed from edges above the from_node). Directly
constrains upstream latency parameters from downstream observations.
Clean and additive — doesn't change the existing y(t) Potential, just
adds a new one. Doubles the cohort Potential count.

**B. Per-age effective denominator**: Use x(t) as the at-risk population
for the edge conversion at each age. Doesn't work cleanly because y(t)
is a convolution — includes conversions from people who arrived at
from_node at various earlier times, not just those present at age t.

**C. Joint upstream+edge decomposition**: Simultaneously fit x(t) and
y(t) to decompose the path into upstream arrival CDF × edge CDF. Most
statistically correct but significantly more complex.

**Recommendation**: Option A when ready. It's additive (no changes to
existing likelihood terms), provides upstream parameter identification
from cohort data, and the FW-composed upstream CDF is already computed
by the topology pass. Implementation: one additional `pm.Potential` per
cohort trajectory scoring x(t) increments against upstream CDF intervals.

**For join nodes**: x(t) at a join is the TOTAL arrivals from ALL
incoming edges. The upstream CDF for a join is the mixture/sum of the
incoming path CDFs, weighted by their respective p values. This is
already handled by the topology's path composition.

### 23-Mar-26: Tooling hardened

**Pre-flight checks** added to `test_harness.py`:
1. DB connectivity check
2. Per-subject row count verification (FAIL if any subject has 0 rows)
3. Evidence binding via worker's actual query path (catches env/hash
   mismatches)
4. Trajectory summary (count, max ages, data source)

**`--preflight-only` mode**: Runs all checks in <10s without MCMC.
Must pass before any compiler run.

**Early abort**: If sampling estimate exceeds 3× `expected_sample_seconds`
(from truth file) within the first 10% of sampling, the harness aborts
automatically with a geometry-problem diagnostic.

**Hash consolidation**: Single source of truth for hashes — Node.js
`compute_snapshot_subjects.mjs` calls the real FE `computeQuerySignature`
pipeline. Used by both `synth_gen.py` (DB writes) and `test_harness.py`
(DB reads). No Python hash reimplementation in the critical path.

**synth_gen verification**: After DB write, synth_gen queries back with
the same FE hashes and prints PASS/FAIL per subject. Pipeline aborts
if any subject has 0 rows.

**Stats pass**: Python port of FE `fitLagDistribution` in
`graph-editor/lib/stats_enhancement.py`. Derives mu/sigma/onset/t95
from parameter file lag data. Runs in memory (doesn't write to disk).
Called by harness before building payload.

### Blocked: FE stats pass not available in Python

The Bayes compiler needs priors (mu, sigma, onset, t95, forecast.mean)
on graph edges. These come from the FE "stats pass" which fits a
lognormal CDF to the maturation trajectories. Currently only implemented
in TypeScript (`statisticalEnhancementService.ts`).

For synthetic data graphs, we either:
1. Fake priors from the truth config (current hack)
2. Port the stats pass to Python (overdue, enables automated compiler
   development iteration)

Option 2 is next — the stats pass is conceptually simple (scipy
curve_fit on lognormal CDF, ~50–100 lines) and unblocks the full
generate → stats → compile → evaluate loop.

---

## 22-Mar-26: path_onset_delta_days — analytic model onset separation

### Problem statement

The analytic model (FE stats pass in `statisticalEnhancementService.ts`)
computes `path_mu`/`path_sigma` (FW-composed A→Y lognormal params) but
had no path-level onset field. The Bayes compiler has `PathLatency.
path_delta` (Σ edge onsets along path), but this was never parameterised
in the analytic model. Consumers (completeness calculations, Cohort
Maturity charts) either used edge-level onset as a fallback or had no
onset at all.

### What was implemented

Added `path_onset_delta_days` as a DP accumulator in the topo traversal,
mirroring the existing `nodePathMu`/`nodePathSigma` pattern:

- **Stats pass**: `nodePathOnset` map, initialised to 0 at anchor,
  accumulated as `upstream + edgeOnsetDeltaDays` at each edge. Propagated
  through all four skip/main paths. Written to `EdgeLAGValues.latency.
  path_onset_delta_days`.
- **Persistence**: `UpdateManager.applyBatchLAGValues` writes to graph
  edge. `mappingConfigurations.ts` syncs graph↔file bidirectionally.
- **Types**: Added to `Latency` interface (TS), `LatencyConfig` and
  `ModelVarsLatency` (Pydantic), `EdgeLAGValues` (stats pass internal).
- **Consumers**: `api_handlers.py` reads `path_onset_delta_days` (was
  `path_delta` which never existed on graph). `localAnalysis
  ComputeService.ts` falls through `posterior.path_onset_delta_days →
  lat.path_onset_delta_days → edgeOnset`.

### The onset separation problem

Attempted to make the system mathematically clean: path_onset = Σδ
carries the deterministic shift, path_mu/sigma carry onset-free
lognormal shape. This requires the anchor fit (A→X empirical data) to
subtract upstream onset before fitting.

**The anchor fit** (`fitLagDistribution(anchorMedian, anchorMean, ...)`)
takes raw `anchor_median_lag_days` from 3-step funnel data. These are
empirical observations in calendar time, including any A→X onset.

**Attempted fix**: subtract `nodePathOnset.get(nodeId)` (DP-accumulated
upstream onset) from anchor median/mean before fitting.

**Result**: curves looked worse. The DP-accumulated onset is a sum of
statistical estimates (weighted quantiles from window slice data), not
a direct measurement. Subtracting this noisy estimate from clean
empirical data distorted the fit.

### Why the old approach worked

Before this change, the system was internally consistent in an
approximate way:

1. Anchor fit uses raw empirical A→X data — onset absorbed into μ
2. FW composes this with onset-free X→Y edge fit → `path_mu`,
   `path_sigma` (A→X onset baked into lognormal shape)
3. Consumer shifts CDF by edge onset only (δ_xy)
4. Net effect: A→X onset handled implicitly through μ shape, X→Y
   onset handled via explicit shift

The lognormal has enough shape flexibility to approximate a shifted
lognormal. The anchor fit captures the real empirical distribution
directly — no estimated quantity subtracted, no noise introduced.

### Two approaches to compare

**Approach A (status quo + field)**: Keep anchor fit raw (onset absorbed
into μ). Write `path_onset_delta_days = Σδ` to graph for informational
purposes, but consumers continue using edge onset when paired with
analytic `path_mu`/`path_sigma`. The field exists for Bayes and other
consumers that have onset-free μ/σ.

**Approach B (clean separation)**: Subtract upstream onset from anchor
moments before fitting, so path_mu/sigma are onset-free. Consumers use
`path_onset_delta_days = Σδ` as the CDF shift. Mathematically cleaner
but depends on onset estimate quality.

### Decision: empirical comparison needed

Rather than guessing which approach produces better fits, we should
measure it. Plan: use `synth_gen.py` to generate datasets with known
ground-truth parameters (including known onset per edge), run both
approaches on the same data, and compare fit accuracy using a
well-defined metric (e.g. integrated CDF error against the true
distribution). This parallels the parameter recovery testing approach
already planned for Bayes model validation (doc 17).

### Current state

Both approaches implemented: `path_onset_delta_days` DP accumulator,
onset-adjusted anchor fit (Approach B), and consumers using path onset.
Empirical comparison via synth_gen needed to validate whether Approach B
produces better or worse fits than Approach A (raw anchor + edge onset).

### Key invariant discovered

**Empirical anchor data should not be adjusted by estimated quantities
without validation.** The anchor_median_lag_days is a direct observation;
the DP onset sum is a derived estimate. Subtracting derived from observed
can only improve things if the derived quantity is accurate. This must be
verified, not assumed.

---

## 21-Mar-26: Diagnostic instrumentation reveals real problem

### What we did
Built `diag_run.py` — a diagnostic MCMC runner that dumps per-variable
rhat/ESS, per-chain step sizes, energy stats, tree depth, and per-chain
means for problematic variables. Output to `/tmp/bayes_diagnostics.txt`.

### Critical discovery: data wasn't binding
First two diagnostic runs showed **0 potentials, 0 observed** — the
model was sampling from priors. Root cause: the diag script called
`bind_evidence()` (param-file path) instead of `bind_snapshot_evidence()`
(snapshot DB path). Also had wrong DB connection string (hardcoded
localhost instead of reading from `graph-editor/.env.local`). Both bugs
masked the real model behaviour for hours.

**Lesson**: Always check potentials/observed count before interpreting
MCMC results. A model with 0 likelihood terms will converge perfectly
and tell you nothing.

### Real diagnostic result (with data)
Once evidence was binding correctly (49 free vars, 20 potentials,
2 observed):

- **0 divergences** — the sampler is NOT struggling with geometry
- **Max rhat: 1.53, Min ESS: 7, 65.7% converged**
- **The problem is ONE edge**: `delegation-straight-to-energy-rec`
  (`8c23ea34`). Chain 0 found a completely different posterior mode:
  - Chain 0: p=0.575, mu=5.43, sigma=3.01, kappa=6.0
  - Chains 1-3: p=0.157, mu=0.52, sigma=0.67, kappa=0.95
- Chain 0 energy: 108,608 vs chains 1-3: ~108,529 (chain 0 in higher-
  energy / worse mode)
- The bimodality drags along the sibling edge `delegated-to-non-energy-
  rec` (`10e37cc7`) via the shared Dirichlet

**Diagnosis**: Classic p-latency identifiability — high-p/slow-latency
and low-p/fast-latency both explain the arrival curve. NOT a join-node
geometry problem. NOT a gradient scale catastrophe.

### Excluded-edge confirmation
Ran with `--exclude delegation-straight`:
- **0 divergences, max rhat 1.027, 97.1% converged**
- Removing that single edge fixed convergence completely

### Compilation time concern
Both runs took ~155s for PyTensor compilation (nutpie
`compile_pymc_model`). The simple 4-edge graph compiles in ~3s. For
49 vars and 18-20 potentials this seems excessive. Investigated data
volumes: some edges have 10,000-12,000 age points flattened into
Potentials. May be a representation issue (each age point → symbolic
gammaln/erfc node in the gradient graph) rather than a data volume
issue. Open question.

---

## 21-Mar-26: Window/cohort independence insight

### Reasoning
Window observations (edge-level: "of people at X, how many reached Y
by age t?") are fundamentally independent of graph structure:
- Window p is an edge-level quantity — doesn't depend on how people
  reached the source node
- Window latency CDF uses only the edge's own (onset, mu, sigma)
- No upstream path composition, no join-node mixture, no Dirichlet
  coupling

Cohort observations (anchor-level: "of people at the anchor, how many
reached Y by age t?") depend on full graph structure:
- p_path = product of p's along the path
- CDF = FW-composed latency of all edges on the path
- At joins: mixture of path CDFs weighted by path probabilities

### Implication
All convergence problems we've encountered are in cohort likelihoods,
specifically at join-downstream edges. Window fitting is well-conditioned
and always converges. This suggests a natural two-phase decomposition:

**Phase 1**: Fit all window observations per-edge (no graph structure).
Produces well-estimated p_window and (mu, sigma) per edge.

**Phase 2**: Fit cohort observations using Phase 1 posteriors as strong
priors on latency. The p-latency bimodality at joins disappears because
latency is already pinned from window data.

**Status**: Not yet implemented. Under consideration.

---

## 21-Mar-26: Mixture-path DP reverted

### What we did
Removed the mixture-path dynamic programming code from `model.py`
(lines 105-232) and all `node_components` / `mixture_components`
references. Reverted to the simpler approach where topology handles
join collapse at analysis time and the model builder does linear FW
composition along pre-selected `path_edge_ids`.

### Why
The mixture-path approach (carrying all path components forward as
separate CDFs) timed out at 900s on the branch graph — stuck at 52%
with 2 chains permanently stalled. Also doubled PyTensor compilation
time (60s → 125s). Wanted a simpler starting point for diagnostic
instrumentation.

---

## 20-Mar-26: External review of join-node convergence

### What we did
Wrote comprehensive briefing note (`bayes-join-node-convergence-
briefing.md`) documenting the join-node convergence problem, shared
for external review.

### Reviewer feedback
1. **Diagnosis agreed**: posterior geometry / identifiability problem,
   not a graph-DP bug. Low-weight paths at joins have weakly identified
   mu/sigma.
2. **Recommended**: two-stage model (fit latency first, then p with
   fixed latency at joins).
3. **Alternative**: softmax reparameterisation of join-node path shares
   + stronger non-exchangeable priors.
4. **Against**: mean-field ADVI (too weak for ridged/multimodal
   posteriors). PyMC SMC better for diagnosing multimodality.
5. **Ranking**: fixed/drawn join latencies > softmax repar > SMC
   diagnostic > more moment matching.

### Our counter-argument
The two-stage approach has a fundamental flaw for immature cohorts:
`E[count] = n × p × CDF(t)`. If CDF < 1, you can't separate p from
latency without fitting the trajectory shape jointly. Fixing latency
and fitting p introduces bias precisely when it matters most (immature
cohorts where completeness correction is large).

The window/cohort independence insight (above) offers a better version
of the two-stage idea: Phase 1 pins latency from window data (which
IS edge-level and well-conditioned), then Phase 2 uses those strong
priors for cohort fitting at joins.

---

## 20-Mar-26: Mixture-path CDF approach (failed)

### What we tried
Instead of collapsing to a single lognormal at joins, carry all path
components forward as separate CDFs:
```
node_components[node_id] = [(weight_i, onset_i, mu_i, sigma_i), ...]
```
At joins: concatenate component lists from all inbound edges. CDF at
any point: `Σ w_i × CDF_LN(t, onset_i, mu_i, sigma_i) / Σ w_i`.

### Result
Timed out at 900s, stuck at 52%. Two of four chains completed; two
permanently stalled. Compilation time doubled (60s → 125s).

### Why it failed
Even without the `exp()` blowup of moment-matching, the weight-CDF
coupling remains: changing one path's weight (by adjusting constituent
p values) while component CDF shapes also change creates ridges and
funnels. Low-weight paths are weakly identified. The fundamental
identifiability issue isn't the parameterisation — it's that the
data can't decompose the mixture into per-path components.

---

## 20-Mar-26: Moment-matched collapse at joins (failed)

### What we tried
At each join node, collapse the mixture of inbound path latencies into
a single shifted lognormal by matching first two moments. Implemented
in PyTensor for differentiability (`pt_moment_matched_collapse`).

### Result
rhat=2.83, ESS=5, massive divergences.

### Why it failed: gradient scale catastrophe
The moment computation requires `exp(mu + sigma²/2)`:
- Direct path (1 hop): mu~0.7 → exp(0.82) ≈ 2.3
- BDS path (3 hops): mu~3.5 → exp(4.0) ≈ 55

25x gradient scale mismatch across components. NUTS uses a single
(diagonal) mass matrix and cannot simultaneously take appropriate
step sizes for both.

### Attempted fixes
1. **Log-sum-exp version**: Rewrote moment computation in log-space.
   Same failure — the problem is the nonlinear coupling, not numerical
   overflow.
2. **Warm-start from previous posteriors**: rhat=1.53, ESS=7. The
   problem is geometry, not starting point.

---

## 20-Mar-26: Per-edge overdispersion (succeeded)

### What we tried
Replace Binomial with BetaBinomial, Multinomial with Dirichlet-
Multinomial. Per-edge latent κ ~ Gamma(3, 0.1) controls overdispersion.

### Result
0 divergences on both test graphs. Per-edge κ values range from 1.5
(heavily overdispersed, early funnel) to 23.7 (nearly Binomial, late
funnel). Matches expectation: traffic-dependent edges have more day-to-
day jitter.

### Key: per-edge, not global
Initially considered a single global κ. User questioned why κ=4.1
would be appropriate throughout the graph. Switched to per-edge κ.
This was the right call — κ varies 15x across edges.

---

## 19-Mar-26: Snapshot evidence pipeline aligned

### What we tried
Rewrote `worker._query_snapshot_subjects` to use `snapshot_service.
query_snapshots_for_sweep()` instead of hand-rolled SQL.

### Why
The FE sends `equivalent_hashes` as ClosureEntry objects (`{core_hash,
operation, weight}`). The hand-rolled SQL passed these dicts into
`ANY(%s)`, causing `can't adapt type 'dict'` errors. All snapshot
queries were failing silently, so the model ran with zero trajectory
data and latency fell back to priors with huge uncertainty.

### Result
FE roundtrip confirmed working. Snapshot data flowing correctly.

---

## 19-Mar-26: Latency prior source debate

### Question
Where should first-run latency priors come from? Options:
1. `median_lag_days` / `mean_lag_days` from param file values[]
2. t95 from graph edge latency block
3. Uninformative defaults (mu=0, sigma=0.5)

### Problem
Window-type values[] entries have zero `median_lag_days` / `mean_lag_
days` (doc 16 defect). So option 1 produces pathological priors.

### Resolution
Uninformative priors (mu=1.5, sigma=1.5) tried first: rhat=1.734,
ESS=6 — too diffuse for NUTS.

Then t95 fallback implemented: `mu = log(t95 - onset) - 1.645 × 0.7`,
`sigma = 0.7`. User initially questioned this but accepted after
confirming t95 comes from a manually-operated lag fit process (not raw
data). Produces sensible priors. 17 divergences → 0 with t95 priors.

### Future
Warm-start from previous posteriors is the proper solution. t95 fallback
is a pragmatic bridge for first runs.

---

## 19-Mar-26: Second test graph added

### What we did
Created the branch test graph (complex topology) in the data repo
with all dependencies (10 params, 8 events, 1 context, 12 nodes).
Branch groups, join nodes, diamond patterns.

### Why
Phase D join-node handling needs a graph with non-trivial joins. The
simple 4-edge linear chain doesn't exercise branch groups or joins.

---

## 18-Mar-26: Dirichlet-Multinomial for branch groups with trajectories

### Problem
`_identify_branch_group_window_edges` only checked `ev.window_obs`
(the old param-file path). With snapshot data, window evidence lives
in trajectories inside `ev.cohort_obs[].trajectories` where
`obs_type == "window"`. Branch groups were silently not emitting DM
likelihoods.

### Fix
Updated the check to also inspect trajectory data in cohort_obs.

---

## Phase S: Potential vectorisation (delivered)

### What we tried
Replace per-day `pm.Multinomial` observed nodes with a single
`pm.Potential` per obs_type per edge, flattening all trajectory
intervals into vectorised array operations.

### Why
PyTensor compilation was taking 5+ minutes with per-day observed
nodes (hundreds of small symbolic subgraphs). A single Potential with
vectorised numpy arrays + PyTensor ops compiles in seconds.

### Result
Compilation time dropped from 5 minutes to <3 seconds (simple graph).
Branch graph still takes ~155s — under investigation.

---

## Approaches NOT yet tried

For reference, these remain in the possibility space:

1. **Window-first two-phase decomposition** (21-Mar-26 insight):
   fit window data per-edge first, use posteriors as priors for
   cohort fitting. Most promising next step.

2. **Softmax reparameterisation at joins**: parameterise join-node
   path shares on unconstrained logits instead of products of upstream
   p's. Reviewer-recommended. Concern: creates over-parameterisation
   (path shares must agree with edge-level p values).

3. **Synthetic data generator** (doc 17): Monte Carlo simulator for
   parameter recovery tests. Would definitively separate model issues
   from data issues. High priority.

4. **SMC (Sequential Monte Carlo)**: PyMC's SMC sampler uses tempering
   from prior to posterior. Better probe for multimodality than ADVI.
   Diagnostic tool, not primary inference.

5. **Non-centred reparameterisation of path latency**: parameterise
   path-level latency directly instead of composing from edge-level.

6. **Per-sibling completeness in branch group DM**: each sibling's
   CDF may differ (different latency). Currently uses a single
   completeness for the group.

7. **Variational inference (ADVI / normalising flows)**: rejected by
   reviewer as primary method (mean-field too weak for ridged
   posteriors). May have role as initialiser.

---

## Feature flags added (21-Mar-26)

`build_model()` now accepts a `features` dict for controlled A/B
testing:

- `latent_latency`: if False, skip latent mu/sigma (Phase S behaviour)
- `cohort_latency`: if False, skip cohort latency hierarchy
- `overdispersion`: if False, use Binomial/Multinomial (no per-edge κ)

`diag_run.py` exposes these as `--no-latency`, `--no-cohort-latency`,
`--no-overdispersion` flags.

---

## Key invariants discovered

1. **Window observations are edge-local**: never depend on graph
   structure, upstream paths, cohort slices, or join-node behaviour.
   Window fitting is always well-conditioned.

2. **Convergence problems come from cohort likelihoods at joins**:
   specifically from the p-latency coupling in the mixture CDF.
   Window-only models converge perfectly.

3. **Per-edge κ matters**: overdispersion varies 15x across edges.
   A single global κ would be wrong.

4. **The bimodality on `delegation-straight-to-energy-rec` is the
   sole convergence blocker**: excluding it gives rhat=1.03. May be
   a data quality issue rather than a model structure issue.

5. **155s compilation time for 49 vars is suspicious**: the simple
   graph (24 vars) compiles in 3s. Likely a representation issue in
   the PyTensor graph, not inherent model complexity.
