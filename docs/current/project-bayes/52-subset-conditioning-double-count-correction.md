# 51 — Subset Conditioning Double-Counting: Generalised Pro-Rata Correction

**Status**: Problem statement + proposal — not yet implemented
**Created**: 20-Apr-26
**Related**: doc 49 (epistemic/predictive separation), doc 50 (CF generality gap), cohort-maturity-full-bayes

---

## TL;DR

The Bayes compiler fits one MCMC run across **all** observations and
exports aggregate model vars per edge (alpha, beta, mu, sigma, and
so on). Several downstream engines — cohort maturity v3, CF Class B,
cohort-mode forecast conditioning — then take those aggregate vars as
a *prior* and multiply by the likelihood of a **subset** of the same
data (a single cohort, a context slice, a windowed segment). The
subset is already inside the aggregate, so its contribution is counted
twice.

When the subset is a small fraction of the data the duplication is
invisible. As the subset approaches the full data, the aggregate prior
has no independent information left — it is essentially a second copy
of the subset likelihood — and the posterior over-concentrates.

**Proposal**: a single, centralised correction implemented once in
the doc-50 shared helper. Shrink the aggregate prior's equivalent
strength by the subset's share of total data mass before updating.
Discount goes to zero as the subset share goes to one; discount
vanishes as the subset share goes to zero.

Generality — i.e. every rate-conditioning engine in the app picking
up the correction — is not automatic. There is no established
migration path today from the existing engines onto the shared
helper. Making the correction general requires actively migrating
each legacy engine at a natural feature moment. The formula is
built once; coverage grows callsite by callsite as migrations land.
Unmigrated engines carry `correction: not_applied` in provenance so
the remaining debt stays visible.

This is a display-time shrinkage approximation to the correct
hierarchical fit. It is not a substitute for one.

---

## 1. The defect

The exported posterior is a summary: Beta(alpha, beta) for a rate, a
small tuple of moments for latency. The MCMC trace that produced it is
discarded. Every subset-conditioning engine then does, in effect:

> "Treat the exported posterior as a prior; multiply by the subset's
> likelihood; report the resulting posterior."

In Beta terms this is cohort-maturity-full-bayes §2.4:

> `r | data  ~  Beta(alpha_0 + k_i, beta_0 + n_eff_i - k_i)`

where `(alpha_0, beta_0)` is the edge's exported posterior and
`(k_i, n_eff_i)` is the subset's evidence. But `(alpha_0, beta_0)`
already absorbed `(k_i, n_eff_i)` as part of the aggregate fit. The
subset is therefore counted once in the prior and once in the
likelihood.

### 1.1 Why the limit case matters

For an edge whose aggregate posterior was built on N observations,
the equivalent strength of that posterior is roughly N. Adding a
subset of size n_S gives an effective posterior strength of N + n_S.
The honest answer is N. The overstatement is n_S / (N + n_S).

- Small subset (n_S = 0.05·N): overstatement ≈ 5 %. Imperceptible.
- Half subset (n_S = 0.5·N): overstatement ≈ 33 %. HDIs narrower
  than justified by a factor of sqrt(1.33) ≈ 1.15.
- Full subset (n_S = N): overstatement ≈ 50 %. HDIs narrower by
  sqrt(2) ≈ 1.41.

### 1.2 Where this happens in the system

- Cohort Maturity v3: the Beta update in the immature-cohort midpoint
  and fan.
- CF Class B (doc 50): the Beta-Binomial posterior update on lagless
  edges.
- Cohort-mode forecast conditioning (the 1-Apr-26 attempts now
  reverted; to be reinstated properly).
- Any future engine that says "condition this promoted posterior on
  a subset of data".

Each callsite currently resolves its prior from the promoted model
vars and applies its own update. There is no shared notion of "how
much of this prior is the subset I'm about to add".

### 1.3 Paths to large subset share

Three realistic routes make the subset share material:

- A context qualifier that happens to cover most of the data (a
  dominant experiment variant, a major geography).
- A short-lived graph where a single query window is nearly the
  whole history.
- A cohort on an edge whose traffic started recently, so one cohort
  is a large fraction of all observations on that edge.

In any of these the displayed HDI narrates a crispness the data can
not support.

---

## 2. The correction

Shrink the aggregate prior's equivalent strength by the subset's
share of total mass, then update with the subset likelihood.

Let the aggregate posterior be Beta(alpha_0, beta_0) with

- mean mu_0 = alpha_0 / (alpha_0 + beta_0)
- strength s_0 = alpha_0 + beta_0

Let the subset have mass m_S and the aggregate total mass m_G. Define
the subset share r = m_S / m_G.

The corrected prior has discounted strength but unchanged mean:

- s_0' = s_0 · (1 − r)
- alpha_0' = mu_0 · s_0'
- beta_0' = (1 − mu_0) · s_0'

The conditioned posterior is then the normal Beta-Binomial update on
the corrected prior:

- Beta(alpha_0' + k_S, beta_0' + n_S − k_S)

Limit behaviour is correct by inspection:

- r → 0 : s_0' → s_0. Standard update. Large queries, small cohorts
  look exactly as they do today.
- r → 1 : s_0' → 0. The aggregate prior vanishes; the subset
  likelihood alone drives the posterior. This is the honest answer
  when the subset *is* the data.

A cleaner intuition: when s_0 ≈ m_G (the usual case — the aggregate
had a weak original prior), s_0 · (1 − r) ≈ s_0 − m_S. We return m_S
pseudo-observations worth of strength to the likelihood before
adding them back. The aggregate no longer gets to count them twice.

One formula, one helper, one application site per callsite.

---

## 3. Which prior we shrink

Doc 49 separates every exported Beta pair into **epistemic**
(posterior on the true rate; alpha+beta is a clean pseudo-count) and
**predictive** (kappa-inflated; alpha+beta is smaller because
overdispersion is folded in).

Subset conditioning semantically updates a belief about the **true
rate**, not about future observations. It must read the epistemic
pair. Running the correction against the predictive pair will
over-discount: the same share `r` of a pre-inflated, smaller strength
removes more than the subset is worth, and the HDI widens beyond what
the discount alone intends.

This makes the correction sequence **after** doc 49. Before doc 49
ships, the minimum requirement is to source alpha, beta from the raw-
trace moment match rather than the predictive export.

---

## 4. Mass measurement

The correction is well-defined only when m_S and m_G are on the same
weighting scheme.

Recommended: use the epistemic strength s_0 = alpha_0 + beta_0 as
m_G. It is by construction the pseudo-observation count the exported
posterior was built from. It is exported already. It makes
`s_0 · (1 − r) ≈ s_0 − m_S` behave the way the intuition claims.

m_S comes from whatever evidence assembly the subset-conditioning
engine already does (raw counts, effective completeness-weighted
counts, half-life-weighted counts). The open question is what to do
when m_S is weighted and m_G is unweighted — see §10 (open
questions).

---

## 5. Centralisation

Doc 50 §3.3 proposes a shared per-edge helper,
`compute_edge_forecast_scalars`. The correction lives inside that
helper — one implementation, one site, no replication. Replication
will drift; the v3-chart-vs-CF divergence doc 50 already documents
is sufficient evidence.

The helper's responsibilities:

1. Resolve the edge's promoted epistemic (alpha_0, beta_0).
2. Compute r = m_S / m_G for the query's effective subset.
3. Apply the strength discount, then the subset likelihood.
4. Emit r, s_0 (pre-discount), and s_0' (post-discount) on the
   response as provenance.

### 5.1 Generality requires active migration

The helper is proposed, not built. Today, each subset-conditioning
engine (cohort maturity v3, cohort-mode forecast conditioning, the
forthcoming CF Class B path) resolves its own prior and applies its
own Beta update inline. There is no established migration path from
those engines onto a shared helper that generality could ride on.
Making this correction general therefore requires actively migrating
those engines onto the helper. Migration is part of this feature's
scope, not a side-benefit of work happening elsewhere.

Three principles for doing that without gratuitous deformation:

- **Greenfield first.** CF Class B is new code per doc 50. It lands
  on the helper natively — no migration cost, correction applied
  from day one. Start there.
- **Migrate at natural feature moments.** Cohort-mode forecast
  conditioning was reverted 1-Apr-26 and must be reinstated
  properly; reinstatement is the moment to land it on the helper
  rather than rebuild it standalone. Cohort maturity v3 migrates
  when its next substantive feature work is scheduled, not as a
  standalone refactor purely to pick up this correction.
- **Never retrofit the formula into an unmigrated engine.**
  Duplicating the discount into a legacy engine's inline Beta
  update is the deformation we are avoiding. It forks the
  statistical method we are trying to centralise. If a callsite
  is not yet migrated, its response carries
  `correction: not_applied` in provenance and its current
  approximation stands. The debt is visible, not hidden.

Generality is therefore a running score, not a binary. At any given
moment, some analyses resolve through the corrected helper and
some do not. The inspector surfaces which is which. As migrations
land, coverage rises. The feature ships correct behaviour to
specific callsites on a specific schedule; it does not claim
system-wide coverage until every callsite has been migrated.

---

## 6. Diagnostics first

Before the discount is applied anywhere, plumb `r` through the
response of every subset-conditioning callsite and render it in an
inspector or log it in fixtures. This is cheap, low-risk, and
valuable in three ways:

- It surfaces where r is actually material and where the correction
  will change nothing.
- It gives CI a concrete invariant (pick a fixture where r = 0.6,
  assert a specific post-correction HDI width) rather than a taste-
  dependent formula.
- It lets a user inspecting a cohort-maturity or CF display see how
  much of the posterior's tightness is model versus evidence.

This is a prerequisite, not an afterthought. Also valuable on its
own merits if the correction is never shipped — consumers learn how
much of any HDI came from the aggregate model vs the subset
evidence.

---

## 7. Calibration

The formula has one latent knob: the exponent on (1 − r). Linear
(exponent 1) is the direct analogue of "subtract m_S pseudo-
observations". Any other exponent is a taste choice unless
calibrated.

The honest calibration target is held-out cohort coverage:

- Take a production graph with enough history.
- For a suite of cohorts, re-fit the aggregate without that cohort,
  and run the corrected subset-conditioning engine on it.
- Measure the fraction of actual observed cohort outcomes that fall
  inside the stated 90 % HDI.

If coverage is systematically too narrow the correction is under-
discounting. If too wide, over-discounting. The exponent moves up or
down accordingly.

Without this study, any non-linear exponent is a per-caller override
and the centralisation benefit evaporates. Default until calibrated:
linear.

---

## 8. Scope and honest limits

- **Beta rate conditioning only.** The algebra is Beta-closed.
  Latency subset conditioning (mu, sigma, mu_sd) does not factor
  this way. Joint (p, mu, sigma) conditioning for lagged edges with
  cohort priors needs a separate derivation. "Generalised" means
  "one rule across every rate-subset-conditioning callsite in the
  system", not "across all subset conditioning".

- **No atypicality guardrail.** An earlier sketch proposed an extra
  term that discounts more when the subset rate disagrees sharply
  with the aggregate mean. Rejected: it conflates real cohort
  heterogeneity (which is a signal to fit hierarchically) with
  sparse-cohort sampling noise (which isn't). The discount is a pure
  function of mass; heterogeneity earns its own treatment elsewhere.

- **Display-time approximation.** The corrected posterior is not a
  principled Bayesian object. It approximates what a hierarchical
  fit with a cohort-specific latent would give. Every response
  carrying a corrected posterior must label it as such in
  provenance.

---

## 9. Relationship to the hierarchical fit

The compiler already emits a cohort-specific latent
(`p_cohort_{eid}`) when a non-latency edge has distinct window and
cohort evidence (doc 49 §B.6.4). For those edges the aggregate-then-
condition pattern is redundant — the hierarchical fit is the honest
answer and the correction should be a no-op.

Where the aggregate-then-condition pattern remains — latency edges,
edges without cohort-framing evidence — the correction is a
stopgap. If double counting turns out to be material on more than a
handful of displays, the structurally correct response is to extend
the compiler to fit cohort-specific latents in those regimes, not to
keep tuning exponents. The doc-50 shared helper should carry a
visible TODO pointing there so the debt is tracked.

---

## 10. Open questions

1. **m_G from what?** Epistemic strength s_0 is the cleanest
   default and avoids worker changes. The alternative — export a
   raw observation count from the worker alongside the posterior —
   is more explicit but adds surface area. Recommendation: s_0.

2. **Weighting consistency between m_S and m_G.** If the subset
   engine uses half-life weights or completeness weights and m_G
   comes from the unweighted aggregate strength, they are on
   different scales and r is meaningless. Needs a decision: either
   require both sides unweighted (simplest; may weaken recency
   behaviour in cohort maturity v3), or derive a weighted
   equivalent strength (non-trivial; risks reopening the
   calibration question).

3. **r > 1.** Possible via weighting mismatch or an export
   consistency bug. Proposed: clip r at 1, emit a provenance
   warning, treat it upstream as a data integrity issue.

4. **First implementation site.** CF Class B (doc 50) is the
   cleanest target: single closed-form update, no MC, one-line
   application of the discount. Recommendation: implement there
   first, validate on the topology fixtures in doc 50 §5, then
   generalise to cohort maturity v3 and the reinstated cohort-mode
   blend.

5. **Interaction with p_cohort_{eid}.** When the compiler already
   emitted a cohort latent, the correction must not be applied.
   The shared helper needs a clean way to detect this — either a
   flag on the promoted source, or a topology check, or both.
   Needs design.

---

## 11. Sequencing

Two tracks run in parallel: **formula and helper** (build once) and
**migration** (per-callsite, costed separately).

### 11.1 Formula and helper track

1. Doc 49 lands (epistemic/predictive separation). Hard prerequisite
   — correction sources alpha_0, beta_0 from the epistemic pair.
2. Doc 50 §3.3 shared helper is built (if not already in flight as
   part of the CF work). The helper exposes the discount plus
   provenance fields (r, s_0, s_0').
3. CF Class B is implemented on the helper natively (greenfield; no
   migration). Regression-gated on doc 50 §5 topology fixtures plus
   a new fixture where r is material by construction.
4. Calibration study (§7). Fix the exponent. Remove the per-caller
   override capability if calibration lands linear.

### 11.2 Migration track

Each migration is an independent, costed step, scheduled at a
natural feature moment for the callsite rather than as a standalone
refactor. Each step independently valuable: it improves coverage
by one callsite and leaves the others unchanged.

M1. **Cohort-mode forecast conditioning** — migrate when reinstating
    the reverted 1-Apr-26 work. The reinstatement is the migration;
    no separate deformation.

M2. **Cohort maturity v3** — migrate at its next substantive feature
    moment. Not before. Until then the v3 engine continues to
    apply its own Beta update inline and provenance on its response
    shows `correction: not_applied`.

M3. **Any future rate-subset-conditioning engine** — lands on the
    helper by default.

### 11.3 Diagnostic plumbing

Independent of both tracks, ship the `r` diagnostic on every
subset-conditioning response as early as possible — even on
unmigrated engines, computed and emitted alongside the (uncorrected)
posterior. This lets field data on material r values accumulate
during the migration window, informs the calibration study, and
makes coverage visible in the inspector from day one.

### 11.4 Revisit hierarchical

Re-evaluate whether cohort-specific latents in the compiler should
replace the correction on latency edges once migration coverage is
high enough to see where the correction is actually doing work. If
yes, open a doc.

Each step a separate PR with its own regression gate. No step
after (2) ships without r being visible in the response first.

---

## 12. Out of scope

- Latency dispersion subset conditioning.
- Joint (p, mu, sigma) subset conditioning.
- Any change to the compiler's aggregate fit itself.
- The decision to add compiler-side cohort latents on latency
  edges (deferred to §11 step 7).
- The "atypicality guardrail" variant (rejected; see §8).
