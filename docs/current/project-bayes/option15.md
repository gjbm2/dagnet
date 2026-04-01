# Document review for project Bayes
_Exported on 4/1/2026 at 23:32:23 GMT+1 from Cursor (2.6.22)_

---

**User**

_@docs/current/project-bayes/cohort-x-per-date-estimation.md 

review this in detail

does option 1 make sense

---

**Cursor**

I’m reviewing the estimation note closely and checking its assumptions against the propagation-engine design so I can judge whether option 1 is coherent rather than just plausible on paper.

I’ve got the proposal and the propagation design. Next I’m cross-checking the key claims against the existing Bayes formulas and the current `cohort_forecast.py` path, because the viability of option 1 depends on whether it preserves the meaning of `x` and the observation update.

I’ve found one likely semantic fault already: option 1 changes the subject-edge Bayes update to condition on model-implied arrivals instead of the observed `x_frozen`. I’m now checking whether its claimed “already on the graph” path inputs actually exist in the form the note assumes.

I’m checking whether option 1 is leaning on a path-probability field that doesn’t actually exist as a first-class graph input. If that assumption is wrong, the “no new plumbing” claim is overstated even if the idea is directionally right.

The more I compare the note to the existing model, the more it looks like option 1 is sensible as a better prior-predictive anchor, but some of the problem statement is overselling “per-date shape”. Under the stationary path model, the shape is mostly shared; what really changes is the anchor mass and the observation frontier.

## Findings
1. High — section 3.4 is the main semantic problem. It replaces the subject edge’s observed `x_frozen_s` with model-implied `x(s, tau_max_s)` inside the Bayes update:

```161:170:docs/current/project-bayes/cohort-x-per-date-estimation.md
c_s^(b) = CDF(tau_max_s; θ^(b))
n_eff_s = x(s, tau_max_s) × c_s^(b)
E[r | data, θ^(b)] = (α₀ + k_s) / (α₀ + β₀ + n_eff_s)
y_forecast_s^(b)(τ) = k_s + x(s, tau_max_s) × [CDF(τ; θ^(b)) − c_s^(b)] × E[r | data, θ^(b)]
```

That conflicts with the newer propagation-engine invariant that `y` forecasting stays edge-local and conditions on the edge’s own frozen evidence:

```255:260:docs/current/project-bayes/cohort-backend-propagation-engine-design.md
For each edge and Cohort, `y` forecasting remains local to that edge:
use the edge's own frozen `x` and `y`, its own posterior slice, and its
own maturity model to forecast conversions conditional on arrivals
already at the edge. The hard part is `x`, and the engine should resolve
that by deriving it from upstream incident-edge `y`, not from a direct
local ratio shortcut.
```

So option 1 as written is not just “better `x` shape”; it changes what the posterior is conditioned on. Because section 3.1 defines an absolute model curve rather than a curve calibrated back to `x_frozen_s`, it also drops the current anchor at `tau_max`.

2. Medium — option 1 does not actually give a cohort-date-specific shape in the way the note claims. Its formula only varies by `a_s`:

```106:113:docs/current/project-bayes/cohort-x-per-date-estimation.md
x(s, τ) = Σ_i  a_s × p_path_i × CDF_path_i(τ)
```

Under the stationary model already assumed elsewhere, that is one shared upstream shape scaled by anchor mass, not a different shape per cohort date. That is still useful, but the real win is better scaling, join summation, and removal of the ratio cliff, not true per-date shape.

3. Medium — section 2.1 overstates the current defect a bit. `graph-editor/lib/runner/cohort_forecast.py` already varies the ratio by each cohort’s own `tau_max_i` and `x_frozen_i`; it is not literally one uniform ratio across the whole group. The real problem is that it is still a local ratio shortcut with a hard guard and one compressed upstream summary, so I’d reframe the diagnosis that way.

4. Low/Medium — the implementation contract needs tightening. I think “no new snapshot plumbing” is plausible, because the graph already carries cohort-level probability and path-latency fields via `graph-editor/lib/api_handlers.py`. But the note should name the real inputs (`posterior_p_cohort` / `path_alpha,path_beta`, `path_mu`, `path_sigma`, `path_onset_delta_days`) instead of `p_path_i`, and section 3.5 should be less casual: coherent upstream MC draws are not fully “straightforward” once you respect the shared-draw rules in the propagation design.

## Verdict
Option 1 does make sense as a Stage 1 prior-predictive approximation. It is a sensible way to replace the brittle CDF-ratio shortcut and to sum all incoming edges, and it is directionally consistent with `docs/current/project-bayes/cohort-maturity-fan-chart-spec.md`.

I would not ship option 1 exactly as written. The version I’d support is:

- use model-derived upstream path priors to estimate future `x`
- calibrate them so `x_forecast(s, tau_max_s) = x_frozen_s`
- keep the subject-edge posterior update conditioned on observed `x_frozen_s`, not model-implied `x(s, tau_max_s)`

With that narrowing, option 1 is a good interim step. Without it, it is directionally right but semantically shaky, and option 2 remains the cleaner end-state.

If useful, I can turn this into a concrete redline for the doc.

---

**User**

I don't follow. How does your proposal differ from the doc, specifically?

---

**Cursor**

The difference is this:

**The doc’s option 1 uses the model to replace the observed `x` at the observation frontier.**  
**My version uses the model only to shape future growth, while keeping the observed `x_frozen` as the anchor at `tau_max`.**

## Side by side

### What the doc says
It defines a fully model-derived upstream arrival curve:

```104:113:docs/current/project-bayes/cohort-x-per-date-estimation.md
For each Cohort date `s` and each tau `τ`, compute:

```
x(s, τ) = Σ_i  a_s × p_path_i × CDF_path_i(τ)
```

where `a_s` is the anchor population for Cohort date `s`,
`p_path_i` is the path-level conversion rate from the anchor node
to the from-node via edge `e_i`, and `CDF_path_i(τ)` is the
path-level latency CDF evaluated at `τ`.
```

Then it explicitly says to use that model-derived value, even at the observation point, inside the subject-edge Bayes update:

```161:170:docs/current/project-bayes/cohort-x-per-date-estimation.md
c_s^(b) = CDF(tau_max_s; θ^(b))
n_eff_s = x(s, tau_max_s) × c_s^(b)
E[r | data, θ^(b)] = (α₀ + k_s) / (α₀ + β₀ + n_eff_s)
y_forecast_s^(b)(τ) = k_s + x(s, tau_max_s) × [CDF(τ; θ^(b)) − c_s^(b)] × E[r | data, θ^(b)]

Note that `n_eff` uses `x(s, tau_max_s)` — the model-derived
arrivals at the observation point for this Cohort date — rather
than `x_frozen_s`.
```

So the doc’s option 1 says: "trust the upstream model enough that it can redefine how many arrivals had reached the edge by `tau_max`."

### What I’m proposing instead
Use the same model curve as a **shape prior**, but renormalise it so it passes through the observed point:

```text
x_model(s, τ) = Σ_i a_s × p_path_i × CDF_path_i(τ)

x_proposed(s, τ) = x_frozen_s × x_model(s, τ) / x_model(s, tau_max_s)
```

That means:

- at `τ = tau_max_s`, `x_proposed = x_frozen_s` exactly
- for `τ > tau_max_s`, future `x` grows using the model’s shape
- the subject-edge posterior still conditions on the observed `x_frozen_s`, not the model-implied one

So I’m saying: **use the model to forecast beyond the frontier, not to rewrite the frontier itself**.

## Why I care about that distinction

The propagation design says `y` forecasting should condition on the edge’s own frozen evidence:

```255:260:docs/current/project-bayes/cohort-backend-propagation-engine-design.md
For each edge and Cohort, `y` forecasting remains local to that edge:
use the edge's own frozen `x` and `y`, its own posterior slice, and its
own maturity model to forecast conversions conditional on arrivals
already at the edge. The hard part is `x`, and the engine should resolve
that by deriving it from upstream incident-edge `y`, not from a direct
local ratio shortcut.
```

That is the principle I was trying to preserve.

## Concrete example

Suppose for one cohort:

- observed `x_frozen = 100`
- observed `y_frozen = 20`
- option 1’s upstream model says only `80` people should have arrived by `tau_max`

Then:

- **Doc option 1** uses `80` in `n_eff` and in the downstream forecast formula
- **My version** still treats `100` as the observed arrival count at `tau_max`, and only uses the model to say how `x` might grow after that, e.g. `100 -> 115 -> 130`

So the doc’s version lets the upstream model disagree with, and override, the observed denominator. Mine does not.

If you want, I can rewrite option 1 in the doc as a short “current wording vs anchored variant” diff.

---

**User**

I think renormalising it to pass through observed x is v. risky -- esp for immature cohorts. 

surely we would ideally properly condition the forecasted x on evidential x during epoch A, and then during epoch b take a sum over Cohort of max(forecasted_x, observed_x) for each tau

---

**Cursor**

I’m checking the epoch definitions and then I’ll answer directly against your suggested conditioning scheme, because the right answer depends on where the model is allowed to override observed `x`.

Yes, I think that is the safer direction than my renormalisation suggestion.

The main thing I’d change in your wording is this: the conditioning should happen at **each cohort’s own observation frontier** `tau_max_s`, not “during epoch A” in the chart-level sense. Chart epoch A is just the range where all cohorts are mature; the conditioning step is per-cohort and then feeds epochs B/C.

So I’d frame it like this:

- For each cohort `s`, infer a **conditioned upstream `x` tail** starting from its observed frontier `(x_frozen_s, tau_max_s)`.
- For `τ <= tau_max_s`, use observed `x_obs_s(τ)` directly.
- For `τ > tau_max_s`, use a conditioned forecast `x_cond_s(τ)`, with a floor such as `max(x_cond_s(τ), x_frozen_s)` so arrivals cannot “un-happen”.
- Then in epoch B aggregate cohortwise:
  - mature cohorts contribute observed `x_obs_s(τ)`
  - immature cohorts contribute conditioned/floored `x_cond_s(τ)`

In other words:

```text
X_s(τ) =
  observed_x_s(τ)                         if τ <= tau_max_s
  max(conditioned_forecast_x_s(τ), x_frozen_s)   if τ > tau_max_s

X_total(τ) = Σ_s X_s(τ)
```

That is better than my renormalisation idea for exactly the reason you gave: for immature cohorts, a blunt rescale-to-hit-`x_frozen` can be very unstable. If the model says only a tiny mass should have arrived by `tau_max`, forcing the whole curve through the observed `x_frozen` just reintroduces a small-denominator problem in a different form.

Two important nuances, though:

- If by “properly condition” you mean **using upstream per-edge cohort evidence**, that is basically the doc’s option 2 / the propagation-engine ideal. I agree that is the clean target.
- If you only have the subject edge’s own `x_frozen`, then you do **not** really have full conditioning of upstream `x`; you have a heuristic calibration/floor. Still useful, but not the same thing.

And one caution on `max(forecasted_x, observed_x)`: I would use that only on the **immature branch**. If a cohort is mature at `τ`, observed `x_obs_s(τ)` should win outright; otherwise the model can start overriding evidence even when you actually have it.

So my updated view is:

- your proposed posture is better than my renormalisation
- as an implementation shape, it should be “observed where mature, conditioned forecast where immature, with a one-sided floor”
- if the conditioning is truly evidence-based upstream, that is no longer option 1 in spirit; it is a hybrid leaning toward option 2

If you want, I can turn that into a precise rewrite of section 3.4 and the recommendation section.

---

**User**

the CHALLENGE however is that our distributoin over x is NOT unitary -- it's the sum of the upstream distribution set. So that makes it non-trivial mathematically as it's a SET of distributions which are jointly conditioned on mature subject_x

---

**Cursor**

Yes. I think that is exactly the hard part.

At a join, `subject_x_frozen` is only the **observed total arrival count at the node**. But the thing you actually need to reason about is a **vector** of latent upstream contributions, one per incoming edge, whose sum equals that observed total.

```211:214:docs/current/project-bayes/cohort-backend-propagation-engine-design.md
In `cohort()` mode, the downstream edge's `x` for a given Cohort is the sum
of forecast `y` from the incident upstream edges for that same Cohort
and draw. That transient node state is what the current code
approximates but does not model explicitly.
```

So the mathematical object is not:

```text
X_s(τ) | x_frozen_s
```

as one conditioned curve.

It is:

```text
(X_1,s(τ), ..., X_m,s(τ)) | Σ_i X_i,s(tau_max_s) = x_frozen_s
```

for the `m` incoming edges.

That is why this is non-trivial:

- the conditioning is on the **sum**, not on the components
- once you condition on the sum, the components become **jointly coupled**
- so you cannot condition each incoming edge independently and then sum them
- the posterior over the components lives on a simplex / integer partition, with negative dependence induced by the sum constraint

So yes: this is the join-side analogue of a partition problem.

## What that means in practice

If the immediate incoming edges are mutually exclusive final-hop routes into the node, then a coherent approximation is:

1. For each cohort `s` and incoming edge `i`, compute the prior arrived-by-`tau_max` mass:
   - `m_i = a_s × p_path_i × F_i(tau_max_s)`

2. Convert those to weights:
   - `w_i = m_i / Σ_j m_j`

3. Condition the observed total `x_frozen_s` on those weights:
   - latent mature arrivals by edge become a multinomial-style partition of `x_frozen_s`

4. For `τ > tau_max_s`, evolve each latent component with its own conditional tail:
   - not from zero
   - from its inferred mature count at `tau_max_s`

5. Sum the conditioned component forecasts back up:
   - `x_s(τ) = Σ_i X_i,s(τ)`

That is much closer to “properly conditioning forecasted `x` on evidential `x`” than either:
- pure option 1’s unconditioned model sum
- my earlier renormalise-the-total-curve suggestion

## Why `max(forecasted_x, observed_x)` is not the core fix

I think your `max(forecasted_x, observed_x)` idea is fine as a **guardrail**.

But if the conditioning is done properly, monotonicity should mostly fall out naturally:

- at `τ = tau_max_s`, total `x` matches observed `x_frozen_s`
- for `τ > tau_max_s`, each component only adds non-negative remaining mass
- so total `x_s(τ)` should already be `>= x_frozen_s`

So `max(...)` is a safety clip, not the real mathematics.

## Why this matters for option 1 vs option 2

This is also the clearest argument for why option 2 is qualitatively better.

- Option 1 avoids the inverse problem by never conditioning on upstream evidence. It just uses the prior expected sum.
- A “conditioned option 1” based only on `subject_x_frozen` has to solve this latent partition problem.
- Option 2 largely sidesteps it, because the immediate upstream edge-level evidence is observed directly. Then the join sum is not latent anymore; you forecast each upstream edge and sum them.

So I think your objection is right: once you want to condition `x` properly at a join, the problem stops being “fit one better `x(τ)` curve” and becomes “infer a joint posterior over incoming-edge contributions given only their observed sum”.

That is the real mathematical boundary.

If you want, I can sketch the cleanest “Option 1.5” wording for the doc:
- unconditioned option 1
- latent-partition conditioned variant from subject `x`
- full option 2 with upstream evidence.

---

**User**

One further thing to reason through though: whence the respective component weights? We don't have (until / unless option 2) daily snapshots for upstream. We only have frozen_y for upstrream (as at some arbitrary retrieved_at date -- likely today). I guess we could use that to aportion--I mean it's better than nothing. Or we could use proportionate incident probability pass...or some mix of the two..........

---

**Cursor**

Yes. I think the key is to separate two different things that are getting conflated:

- **eventual route share** into each incoming edge
- **maturity by the subject frontier** for that edge

The component weight at subject `tau_max_s` should not be taken straight from “today’s upstream `y` share”, and it should not be taken straight from bare incident probabilities either. It should be something like:

```text
w_i(s) ∝ π_i × F_i(tau_max_s)
```

where:

- `π_i` = eventual share of this cohort’s arrivals that come via incoming edge `i`
- `F_i(tau_max_s)` = fraction of that route expected to have arrived by the subject cohort’s current age

Then normalise across incoming edges.

## Why that helps
If you use latest upstream `frozen_y` directly as the component weights, you are using a proxy that mixes up:

- long-run route prevalence
- latency differences
- maturity differences across cohorts
- possible future leakage relative to `sweep_to` / `asat`

Whereas `π_i × F_i(tau_max_s)` keeps the story cleaner:

- `π_i` says “which route does mass eventually take?”
- `F_i(tau_max_s)` says “how much of that route should have shown up by now for this cohort?”

So I think your instinct to use upstream `frozen_y` is reasonable, but I would use it to estimate **`π_i`**, not the final frontier weight `w_i(s)` directly.

## Candidate sources for `π_i`

- **Model-only prior**: `π_model_i ∝ p_path_i`
  This is the cleanest option-1 source. It is slice-consistent and cohort-safe, but it ignores realised route-share drift.

- **Empirical prior from upstream `frozen_y`**: `π_emp_i ∝ y_i_latest`
  Better than nothing, but only as a weak proxy for long-run route share. It is not same-frontier cohort evidence.

- **Blend of the two**: probably the best practical compromise until option 2.

A clean version is:

```text
π_model_i = p_path_i / Σ_j p_path_j
π_emp_i   = y_i_latest / Σ_j y_j_latest

π_mix_i = (κ_model π_model_i + κ_emp π_emp_i) / (κ_model + κ_emp)

w_i(s) = π_mix_i F_i(tau_max_s) / Σ_j [π_mix_j F_j(tau_max_s)]
```

Then allocate the observed subject total with those weights:

```text
Z_s | x_frozen_s ~ Multinomial(x_frozen_s, w(s))
```

or deterministically:

```text
E[Z_i,s | x_frozen_s] = x_frozen_s w_i(s)
```

## Important caveat
If you use upstream `frozen_y`, I would **not** use raw counts as if they were real same-cohort evidence. They should act like a **small effective sample size**, otherwise mature historical volume will swamp the current cohort. In practice that means `κ_emp` should be a tuned shrinkage strength, not `Σ y_i_latest`.

And if `asat()` is in play, newer upstream evidence is simply not allowed:

```77:86:docs/current/project-bayes/cohort-backend-propagation-engine-design.md
If `asat()` is present, the engine must treat it as an explicit
point-in-time frontier. It must therefore affect both evidence and
posterior consumption:

- snapshot evidence must be read only from rows available on or before
  the requested `asat()` time
- sweep-based reads must cap their upper bound at `asat()`, not wall
  clock "now"
- posterior or fit-history selection must also resolve "on or before
  `asat()`", not silently use a newer fit
```

## Bottom line
I think:

- **pure incident probability pass** is too weak on its own
- **pure latest upstream `frozen_y` apportionment** is too risky on its own
- **a shrinkage blend for `π_i`, then multiply by cohort-age maturity `F_i(tau_max_s)`**, is the cleanest option-1.5 story

That gives you a principled latent-partition prior without pretending you have option-2-grade upstream evidence.

If you want, I can turn this into a compact paragraph you can drop straight into the doc under option 1 as “join-component weight resolution”.

---

**User**

Summarise this "1.5" build in a few crisp paras as a specific proposal.

---

**Cursor**

## Option 1.5
Option 1.5 is a join-aware, subject-conditioned approximation that sits between pure model-derived option 1 and snapshot-backed option 2. For each subject Cohort date `s`, treat the observed `x_frozen_s` on the subject edge not as one scalar to extrapolate directly, but as the sum of latent mature-arrival components from the immediate incoming edges to the subject edge’s from-node. The task is therefore to infer a plausible partition of that observed total across the incoming routes, then forecast each route’s remaining tail separately and sum them back up.

The partition is driven by prior route weights rather than direct upstream cohort evidence. For each incoming edge `i`, define an eventual route-share prior `π_i`, using a shrinkage blend of model path probability and a weak empirical proxy from the latest asat-safe upstream `frozen_y` share. Convert that into a frontier weight for cohort `s` by multiplying by that route’s maturity at the subject frontier: `w_i(s) ∝ π_i × F_i(tau_max_s)`, then normalise across incoming edges. Use those weights to apportion the observed subject `x_frozen_s` into conditioned component counts `z_i,s`. This makes the conditioning happen on the observed subject total, while still respecting that different incoming routes should have matured by different amounts by `tau_max_s`.

From there, forecast each component forward from its conditioned count `z_i,s` using that route’s own remaining-tail model, with a one-sided monotonicity floor so neither a component nor the aggregated total can fall below what has already been observed at the subject frontier. The subject-edge `x` forecast for cohort `s` is then `x_s(τ) = Σ_i x_i,s(τ)`. In epochs B and C, mature cohorts continue to contribute observed `x`; immature cohorts contribute this conditioned aggregate forecast. This preserves the key benefit of conditioning on real subject evidence at joins, avoids unstable whole-curve renormalisation, and requires no upstream per-cohort snapshots.

This is still an approximation, not a full evidence-backed solve. The latent partition across incoming edges is prior-driven because we do not yet have upstream per-cohort snapshot rows, so the empirical upstream `frozen_y` signal should be treated as weak shrinkage, not hard evidence. The response should therefore surface provenance clearly: option 1.5 is “conditioned on subject `x`, partitioned by route priors”, whereas option 2 would replace those priors with actual upstream cohort evidence.

---

**User**

your paras focus excessively on the partiioning question but do not well ground the proposal in the discussion we had about how to think about ensuring observed x conditions the joint upstream forecast distributions of x.

---

**Cursor**

The core of option 1.5 is not “how do we partition a count?”, but “how do we make the **observed subject `x` at the cohort frontier constrain the whole upstream forecast for `x`**?” For each subject cohort date `s`, start from a joint prior forecast over the immediate upstream arrival components `x_i,s(τ)` implied by the path models for the edges entering the subject edge’s from-node. Those component processes are not independent in the quantity we care about, because the subject denominator is their sum: `x_s(τ) = Σ_i x_i,s(τ)`. Option 1.5 says that before forecasting forward, we should condition this **joint upstream prior** on the fact that at the observation frontier we actually saw `x_s(tau_max_s) = x_frozen_s`. That turns the upstream forecast from an unconditional model sum into a posterior forecast constrained by real subject evidence.

After that conditioning step, future `x` for cohort `s` is obtained by propagating the **conditioned joint upstream distribution** forward beyond `tau_max_s` and summing the components back to the node total. So for `τ <= tau_max_s`, the cohort contributes observed `x`; for `τ > tau_max_s`, it contributes the posterior forecast total implied by the conditioned upstream joint distribution. In epoch B, mature cohorts therefore continue to contribute observed `x`, while immature cohorts contribute forecast `x` that is already anchored by the fact that this cohort had reached `x_frozen_s` by its own frontier. The important point is that the observed subject `x` is not merely used as a floor or cosmetic anchor: it is the conditioning datum that reshapes the upstream forecast family for that cohort.

The partitioning question then appears only as the practical approximation needed to carry out that conditioning without upstream per-cohort snapshots. Because we observe only the **sum** at the subject edge, not the per-edge upstream components, we need a prior over how that observed mature mass was likely distributed across the immediate incoming routes. In option 1.5, those allocation weights are just a device for approximating the posterior over the latent components at `tau_max_s`; they are not the main idea. A sensible approximation is to derive them from route priors based on incident path probability, optionally shrunk weakly toward asat-safe upstream `frozen_y` shares. That gives us a workable way to condition the joint upstream `x` forecast on observed subject `x` without pretending we have option-2-grade upstream evidence.

So the specific proposal is: build a joint prior over immediate-upstream component arrival curves; condition that joint prior on the observed subject `x_frozen_s` at each cohort’s frontier; propagate the conditioned joint distribution forward to obtain forecast `x` for immature cohorts; and aggregate observed mature cohorts with conditioned immature cohorts in epochs B and C. That is what distinguishes option 1.5 from option 1: option 1 is still an unconditional upstream model forecast, whereas option 1.5 is a **subject-evidence-conditioned upstream forecast**, albeit using prior-driven latent allocation because upstream cohort snapshots are not yet available.

---

**User**

right. so explain that properly in a clear and detailed statement of the proposal and rationale for option 1.5

---

**Cursor**

## Option 1.5

Option 1.5 should be framed as a **subject-evidence-conditioned upstream forecast for `x`**, not as a better unconditioned model curve and not as a simple rescaling trick. At a join, `x` is not a unitary distribution: for each subject cohort date `s`, it is the sum of a **set** of immediate-upstream arrival components, one per incoming edge to the subject edge’s from-node. So the object to reason about is a joint family `X_i,s(τ)` over those incoming routes, with total subject arrivals `X_s(τ) = Σ_i X_i,s(τ)`. The key proposal is that, for each cohort `s`, we first build a **joint prior** over those upstream component arrival curves from the existing path-level model variables already on the graph, and then we **condition that joint prior on the one hard datum we do have at the correct place**: the observed subject-edge arrival count at the cohort frontier, `X_s(tau_max_s) = x_frozen_s`.

This conditioning is cohort-local, not chart-global. It does not mean “do something special in chart epoch A”; it means that every cohort is anchored at its own observation frontier `tau_max_s` before any forward projection is done. Once that conditioning has happened, the cohort’s future `x` contribution is obtained by propagating the conditioned upstream component family forward beyond `tau_max_s` and summing it back to the node total. In the plotted chart, mature cohorts continue to contribute observed `x` at the requested `τ`, while immature cohorts contribute forecast `x` from this conditioned upstream solve. Epoch A remains pure evidence at the chart level because every cohort is mature there; epoch B becomes a mix of observed mature cohorts and conditioned immature cohorts; epoch C is fully the conditioned forecast.

Because we do not yet have upstream per-cohort snapshot rows, the conditioning cannot be exact. The practical approximation is to introduce latent frontier component counts `z_i,s` for the immediate incoming edges, constrained so that `Σ_i z_i,s = x_frozen_s`, and then infer a plausible prior allocation of that observed total across routes. The natural base prior for that allocation is the **incident probability / path-share pass**: which incoming routes would we expect this cohort’s eventual mass to use, according to the current slice’s modelled path probabilities. That route-share prior can then be adjusted by each route’s maturity at the subject frontier, so that the frontier weights are `w_i(s) ∝ π_i × F_i(tau_max_s)`, normalised across incoming edges. If available, an asat-safe share derived from the latest upstream `frozen_y` values can be used only as a **weak shrinkage term** on `π_i` to correct obvious route-share misalignment; it is not same-cohort evidence and must not be treated as hard conditioning.

Once the approximate conditioned frontier state `z_i,s` has been obtained, each upstream component is forecast forward from that state using its own remaining-tail model. This produces component forecasts `X̂_i,s(τ)` for `τ > tau_max_s`, and the subject forecast is then `x̂_s(τ) = Σ_i X̂_i,s(τ)`. A one-sided monotonicity guard can still be applied so that the total cannot fall below `x_frozen_s` after the observation frontier, but that guard is only a safety check; the substantive move is the conditioning of the joint upstream family on observed subject `x`. This is what makes option 1.5 different from option 1: the subject forecast for `x` is no longer an unconditional model sum, but a forecast that has already been constrained by what was actually observed at the subject edge.

## Rationale

The rationale for option 1.5 is that it uses the available evidence at the right semantic level. Pure option 1 gives a model-derived upstream sum for `x(s,τ)` and therefore allows the subject denominator forecast to float independently of the observed subject `x_frozen_s`. That is unsatisfying because the subject edge has already told us how much cumulative arrival mass had actually reached its from-node by `tau_max_s`; any upstream forecast used downstream should respect that fact. A blunt renormalisation of the total curve is not a good fix, especially for immature cohorts, because it forces a single aggregate path through the observed `x` without acknowledging that the total is the sum of multiple upstream component distributions with different maturities and different route shares. Option 1.5 addresses the real issue by conditioning the **joint upstream forecast family** on observed subject `x`, not by post-hoc stretching a single summed curve.

At the same time, option 1.5 is honest about what it still does not know. Without upstream per-cohort snapshots, the latent split of `x_frozen_s` across incoming routes is not identified by data; it must be prior-driven. That is why the allocation weights should come primarily from modelled incident path shares, with only weak empirical correction from asat-safe upstream `frozen_y` shares when useful. In other words, option 1.5 is not a full evidence-backed upstream solve. It is a **subject-conditioned, prior-partitioned approximation**. That is still a material improvement over option 1, because it ensures that observed subject `x` constrains the joint upstream `x` forecast in the correct mathematical place, while preserving the graph identity that subject `x` at a join is the sum of immediate-upstream arrivals. Option 2 remains the cleaner end-state, because it replaces prior-driven latent allocation with actual upstream cohort evidence, but option 1.5 is the strongest approximation available before that plumbing exists.

