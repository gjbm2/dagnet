# Slice Dispersion Priors and Robust Hierarchies — Design Discussion

**Date**: 20-Apr-26
**Status**: Discussion only — no implementation proposed yet

## Note — 22-Apr-26 (post-discussion findings)

Three observations have been recorded since this discussion was
written and should be considered before any of the §10 sequencing is
acted on.

The §10 step zero is stale. Independent dimensions are already wired
end-to-end. The frontend computes the independent-dimension list from
`ctx.independent` in
[candidateRegimeService.ts:430-439](graph-editor/src/services/candidateRegimeService.ts#L430-L439),
passes it as `independent_dimensions` in the Bayes payload from
[useBayesTrigger.ts:498](graph-editor/src/hooks/useBayesTrigger.ts#L498),
and the compiler already skips the shared τ and gives each such slice
a direct prior in [model.py](bayes/compiler/model.py) — see the
`ev.slice_groups[_dk].independent` branches around lines 1514, 1558,
1585, 1617 and 1724, the explicit
`_tau_slice_by_dim[_dk] = None  # no tau for independent dims` at
line 1515, and the all-independent assembly path at lines 1746-1785.
The remaining work is adoption and audit of production context
definitions, not implementation.

Per-slice PPC is useful but it is not the rollout gate for the
problem this doc raises. The calibration path in
[calibration.py](bayes/compiler/calibration.py),
[worker.py](bayes/worker.py) and
[inference.py](bayes/compiler/inference.py) measures predictive
coverage — whether observations fall inside the predictive interval.
The concern in §1 is parameter-interval calibration under
exchangeability failure: whether the true `p_slice` lies inside the
reported posterior interval. The two are related but not identical,
and §11 already flags this distinction as the unresolved question.
Step one as written extends the wrong metric for the question being
asked.

Most of the experiment harness named in §10 step two already exists.
[param_recovery.py](bayes/param_recovery.py) reads a `.truth.yaml`
sidecar, parses per-slice posteriors via `_parse_slice_posteriors`,
and uses the `recovery_slices` module
(`build_slice_truth_baselines`, `match_truth_edge_key`) to compare
posteriors to ground truth on a per-slice basis.
[worker.py](bayes/worker.py) already accepts `calibration_truth` and
`slice_truth_baselines` from settings (see around lines 987-1004 and
1031-1036). The right move is to extend the existing
parameter-recovery sweep, not to build a new harness from scratch.

## 1. Problem Statement

When we fit per-context slices under partial pooling, the reported
posterior for each slice is a compromise between that slice's own
evidence and an edge-level base rate. The central estimate for each
slice is a shrunk version of its raw rate, pulled toward the base.
That shrinkage is normally a feature, not a bug — it stabilises
slices with thin evidence and reflects the prior belief that slices
are similar variations of a shared process.

The concern raised externally is not about the centre of the
posterior but about its width. Under the current design, a slice's
reported interval is computed directly from the MCMC samples of its
own `p_slice` parameter, and that parameter's posterior dispersion
is driven primarily by the between-slice scale τ. If τ ends up
small — either because the other slices happen to agree or because
the prior on τ is tight — then every slice, including genuinely
different ones, inherits a tight posterior. The model looks
confident about a slice when in reality it has learned little about
it beyond the base rate.

This is the exchangeability failure mode: the model assumes all
slices belong to the same population, so when one does not, the
output is not merely wrong but *confidently wrong*.

This document describes the current design, the failure mode, the
external proposal we received, and two concrete alternatives we
could pursue if we decide the dispersion is insufficient today.

## 2. Current Design

For each edge with contextual slices, the compiler builds a
non-centred hierarchical model in logit-probability space: a base
rate (`p_base`) with per-slice deviations parameterised by
independent standard-normal offsets scaled by a between-slice
standard deviation τ. The compiler constructs one τ per context
dimension. Context dimensions marked as `independent` — a design
documented in doc 14 §15A.5 but not yet implemented — would skip
this hierarchy entirely and give each slice its own direct prior.

The prior on τ is a half-normal with scale 0.5 for the probability
hierarchy (see `bayes/compiler/model.py` around line 1522). For the
reparameterised latency hierarchy, the equivalent scales τ_m and
τ_r are half-normal with scale 0.3 (lines 1565 and 1592), reflecting
a deliberate choice to keep per-slice latency offsets tighter than
per-slice probability offsets in order to preserve identifiability
of the latency reparameterisation (doc 34 §11.9.1). The per-slice
offsets ε themselves are standard normal in all cases.

Phase 2 per-slice cohort inference (`_phase2_has_slices` branch in
`model.py` around line 1455) does not re-use the τ hierarchy. It
freezes each slice's Phase 1 posterior as a direct Beta prior and
fits an independent cohort-denominated draw per slice. The τ
question therefore applies to Phase 1 and to path-level inference,
not to the Phase 2 cohort framing.

The practical effect of τ ∼ HalfNormal(0.5) on the logit scale is
asymmetric in absolute probability: at p=0.5 a one-standard-deviation
slice can sit between 0.40 and 0.60; at p=0.05 that same one σ on
logit translates to roughly 0.03 and 0.07; at p=0.01 to 0.007 and
0.015. The prior is permissive in the middle of the probability
range and structurally constraining at the extremes.

## 3. Where the Current Design is Adequate

Many of the graphs we fit look like this: three or four context
slices of broadly similar size, each with plenty of evidence, where
the data-generating process really does produce similar behaviour
across slices. In that regime, partial pooling is doing exactly
what it should. τ gets learned, ε is tight where slice evidence is
strong and loose where it is thin, and the posterior widths reflect
real uncertainty rather than artefacts of a bad prior.

Before proposing changes, it is worth stating plainly: we have no
evidence today that the current design is broken on typical
production graphs. The concern is specifically about the boundary
cases — sparse slices, genuinely different slices, slices with very
low base rates — and about making the calibration of those cases
explicit rather than implicit.

## 4. Where the Current Design Fails

The clearest failure in our own logs is the `email` slice in the
synth-simple-abc-context graph (see doc 37b, around line 532). That
slice has the lowest conversion probability, the fewest observations
(roughly one-third the sample size of the `google` slice on the
same edge), and more per-slice latency freedom than the other two
slices. LOO reports a pareto-k of 4.36 for it — a value which
formally indicates that the leave-one-out estimate is meaningless
and that the model cannot represent the observations of that slice
adequately. The other two slices on the same edge are only
marginally above the 0.7 threshold.

Doc 14 §15A.5 already documents this mode in prose. The relevant
passage is worth quoting because it pre-dates this discussion and
states the problem in exactly the terms the external reviewer used:

> With few slices (2–3), there is little information to estimate τ,
> so the HalfNormal(0.5) prior dominates. A small slice with
> genuinely different behaviour gets pulled toward `p_base`, which
> is dominated by the larger slice. The posterior will be
> overconfident and wrong — the worst kind of error.

We already believe this happens. What we do not have is a
systematic calibration check that tells us how often and how badly.

## 5. The External Proposal and Why We Should Not Adopt It As-Is

The external recommendation was to keep partial pooling for the
mean but to widen displayed intervals by adding a separate
"novelty variance" term to the posterior standard deviation — an
inflation applied after inference, intended to reflect the
possibility that the exchangeability assumption is wrong. The
argument is that posterior width under a correct model does not
capture uncertainty about the model itself, so an extrinsic hedge
is warranted.

The direction of this argument is sound. Posterior dispersion from
a hierarchical fit is uncertainty *given the hierarchy*. If the
hierarchy is misspecified — if one slice really does not belong in
the same population as the others — then the fitted interval can
be well-calibrated under the model and yet mislocated or
undersized in reality.

We should nevertheless resist adding an inflation term at the
display layer, for three reasons.

First, the same conservatism is available at the right layer. The
width we want comes from either a wider prior on τ, a heavier-tailed
distribution on the per-slice offsets, or a user-provided signal
that a given context is not exchangeable. All three of these are
principled, affect the mean as well as the interval, and leave the
posterior honest rather than cosmetically padded.

Second, an extrinsic inflation term has no natural calibration
rule. Any value we pick is arbitrary until we have a simulation or
backtest that tells us what value would produce 90% empirical
coverage at the 90% nominal level. Once we have that calibration
infrastructure, it can equally be used to choose among the model-
level alternatives, which are preferable for the first reason.

Third, a padded interval can mask a biased centre. If the pooled
mean is wrong — because one slice is genuinely different and has
been pulled toward the base — widening the interval around that
wrong mean does not produce a calibrated estimate of the true
parameter. It produces a wider interval that may still exclude
reality.

The rest of this document therefore concerns model-level
alternatives.

## 6. Proposal 1 — Widen the Prior on τ

The simplest change is to loosen the half-normal scale on τ_slice
from 0.5 to something meaningfully larger — 1.0 is the natural
candidate for probability, and a corresponding proportional
widening for the latency reparameterisation would move τ_m and τ_r
from 0.3 to somewhere around 0.6.

The mechanism is straightforward. With a tighter prior on τ, the
posterior on τ is pulled toward small values whenever the slices
roughly agree, even when the data is sparse. With a looser prior,
the posterior on τ stays closer to agnostic when data is thin, so
a new or under-evidenced slice inherits a wider prior-propagated
uncertainty rather than a confident pull toward the base.

The cost is symmetric. When the exchangeability assumption *is*
correct and the slices really are similar, a wider prior on τ
produces a looser fit and slightly wider intervals for all slices.
For graphs with many comparable slices and strong evidence, the
change is barely visible. For graphs with few sparse slices, the
change is larger and is in the conservative direction.

Latency needs separate consideration. The narrower 0.3 prior on
τ_m and τ_r was chosen deliberately to preserve identifiability of
the (m, a, r) reparameterisation introduced in doc 34. Widening
these priors risks degrading an already-fragile posterior geometry
— the Stage 3 per-slice latency experiments in doc 34 recorded
effective-sample-size values in the high tens and per-chain
divergence counts that were sensitive to parameter choices. Any
change to latency τ priors should be validated on those same synth
runs before being accepted.

For probability, the change is low-risk. For latency, the change
is not.

## 7. Proposal 2 — Heavy-Tailed Per-Slice Offsets

The second change is orthogonal to the first and addresses a
different problem. Widening τ is the right fix when most of our
real populations exhibit more between-slice variance than the
current prior allows. Heavy-tailed offsets are the right fix when
one slice is an outlier and the rest are exchangeable.

The mechanism is this. Under the current non-centred design, each
slice's offset ε is drawn from a standard normal. A normal
random-effect distribution dislikes outliers: a single slice whose
evidence wants to sit four standard deviations from the base will
either inflate τ for everybody (widening all other slices' fits)
or be shrunk back toward the base (hiding its genuine difference).
The sampler settles on a compromise, and both regimes suffer.

Replacing the normal offset with a Student-t offset at modest
degrees of freedom (four is the standard robust default) lets the
distribution accept a rare extreme value without inflating τ for
the others. Well-behaved slices see almost no change. The outlier
slice's own posterior widens because the heavy-tailed distribution
treats such a departure as unremarkable, which is the conservatism
the external reviewer was asking for — but generated by the model
rather than bolted on.

The risk is posterior geometry. Hierarchical models with
heavy-tailed random effects are known to exhibit harder sampling
than their normal counterparts, and this codebase already has
fragile convergence in the latency reparameterisation. A Student-t
change should be trialled on the existing synth regression set with
close attention to effective sample size, divergence counts, and
rhat, and should probably be gated behind a feature flag that
defaults off until we have calibration evidence it helps more than
it hurts.

Note that heavy-tailed offsets and widened τ priors are not
substitutes. They address different failure modes. It is entirely
plausible that we want both, one, or neither depending on what
calibration tells us.

## 8. An Alternative Route Already on the Roadmap

Doc 14 §15A.5 proposes an `independent` flag on context definitions
that would let the user mark a dimension as not exchangeable.
Slices within such a dimension would be fitted with direct priors
and no shared τ — effectively the no-pooling limit. This is a
complementary solution to proposals 1 and 2: rather than making
the pooled model more robust to the case where exchangeability is
wrong, it lets the user assert that exchangeability *is* wrong and
bypass pooling entirely.

Which route is preferable depends on who bears the responsibility
for recognising the exchangeability failure. The robust-model
route (proposals 1 and 2) puts it on the model — it tries to fail
gracefully when the assumption breaks. The independent-flag route
puts it on the user — it requires them to look at the data and
make a judgement call. In practice the two are not mutually
exclusive; independent slices handles dimensions where the user
has prior knowledge, and a robust pooled hierarchy handles
dimensions where they don't.

The independent-slices implementation should go first regardless
of what we decide about priors. It is a smaller change, already
designed, and it gives us a clean way to mark the slices we
*already know* break exchangeability while the prior debate runs.

## 9. Calibration — the Only Honest Way to Choose

Neither proposal can be adopted on taste. The correct value of the
half-normal scale on τ, and the correct choice between normal and
Student-t offsets, is whichever combination produces empirically
calibrated intervals under the kinds of graphs we actually fit.

We are partway to the infrastructure for this. Doc 36 and doc 38
describe posterior predictive calibration machinery that already
runs at the edge level, producing the `ppc_coverage_90` and
`ppc_traj_coverage_90` metrics on `PosteriorSummary`. This
infrastructure tells us whether the 90% nominal interval contains
90% of observations in aggregate. What it does not yet tell us —
and what we would need for this discussion — is per-slice
coverage. Doc 38 explicitly flags per-slice calibration as "not
yet validated."

Beyond per-slice posterior predictive checks, a true simulation-
based calibration harness does not exist in this codebase. We have
rich synth generators in `bayes/tests/synthetic.py`, but no
systematic loop that simulates many experiments spanning the
parameter regimes we care about (similar slices, moderately
different slices, strongly outlier slices) and records whether
reported intervals contain the truth at the nominal rate.

Building this loop is the prerequisite for either proposal. With
it we can answer the question the external reviewer correctly
identified: "across many simulated experiments, do my 90%
intervals actually miss too often when a slice is moderately or
strongly novel?" Without it, any change to priors is an aesthetic
choice.

## 10. Recommendation and Sequencing

Our judgement is that the existing design is probably adequate for
the well-behaved case and probably inadequate for the sparse
outlier case. We do not know how often production graphs hit the
sparse outlier case, and we should not make a change without
measuring.

A reasonable sequence is:

Step one is to extend the existing posterior predictive calibration
infrastructure from edge-level to per-slice, so that the
`ppc_coverage_90` style metrics are computed and reported
separately for each context slice. This is a mechanical extension
of existing machinery and should not be controversial.

Step two is to build a simulation-based calibration harness that
runs the existing synth generators across a parameter sweep
covering at least: slice count (two to six), slice size imbalance
(balanced through five-to-one), and the presence or absence of a
genuine outlier slice. The output is a coverage matrix — actual
90% coverage achieved under the current priors, broken down by
regime.

Step three, if and only if the coverage matrix shows a problem, is
to re-run the sweep with the two proposed changes applied
independently and in combination. We then choose the configuration
with the best calibration across the regimes we care about.

Step zero, before any of that, is to ship the independent-slices
flag from doc 14 §15A.5. That gives users an escape hatch for
known non-exchangeable dimensions regardless of what the prior
debate concludes, and it removes the easiest failure mode from the
calibration exercise before we measure.

No prior change should land without supporting calibration
evidence. The email-slice pareto-k=4.36 result is suggestive but
single-cased, and widening priors to solve one slice's problem
without measuring the effect on all the others would repeat the
external reviewer's own warning back at them.

## 11. Open Questions

Several questions are deliberately left unresolved here because
they require input before anyone writes code.

Is the `ppc_coverage_90` metric we already compute sufficient as a
diagnostic for the outlier case, or do we need a more targeted
slice-level score that captures "is the true parameter inside the
reported interval" rather than "do observations fall inside the
reported predictive interval"? The former is what this debate is
really about; the latter is what the PPC machinery currently
measures. The two are related but not identical.

Is there a principled argument for picking 1.0 over 0.8 or 1.5 for
the probability τ scale, independent of calibration? A
weakly-informative prior chosen on first principles would be a
cleaner starting point than a number picked by calibration alone.

For Student-t offsets, should the degrees-of-freedom parameter be
fixed at four, or put under a prior and estimated? The estimated
version is more principled but adds a parameter to sample, and in
this codebase that is not a free action.

Finally, does the discussion in this document change if we adopt
the independent-slices flag first? Specifically: if most of the
cases where we worry about over-shrinkage are cases the user can
mark as independent, is the residual pooled case benign enough that
no prior change is needed? The answer to this is empirical and
depends on how users actually use the flag once it ships.
