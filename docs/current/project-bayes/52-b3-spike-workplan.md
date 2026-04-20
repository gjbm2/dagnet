# 52 — B3 Spike Workplan

**Status**: Proposed  
**Date**: 20-Apr-26  
**Relates to**: [51-model-curve-overlay-divergence.md](51-model-curve-overlay-divergence.md), [programme.md](programme.md), [44-synth-model-test-plan.md](44-synth-model-test-plan.md), [32-posterior-predictive-scoring-design.md](32-posterior-predictive-scoring-design.md), [36-posterior-predictive-calibration.md](36-posterior-predictive-calibration.md)

---

## 1. Purpose

Doc 51 established B3 as the determinative next question for the current
Phase 2 architecture. The purpose of this note is to turn that into a
near-term spike workplan with clear phases, deliverables, and decision
gates.

This is a **decision-making spike**, not an implementation plan. The goal
is to determine whether Phase 2 can use mature a-anchored evidence to
produce a useful structural correction over composed edge posteriors,
without confusing that structural question with the separate problem of
current-regime drift.

## 2. Governing principles

The spike should be run under four principles.

First, it must keep the two intellectual goals separate. The B3 question
is about **structural correction** over long or complex paths. It is not
the same as explicit drift modelling, and success on B3 must not be
presented as if it solved the drift problem.

Second, **frontier forecasting remains window-led throughout the spike**.
Recent `window()` evidence is still the earliest signal of the current
downstream regime. Mature `cohort()` evidence is lagging evidence. The
spike may show that cohort evidence improves structural composition, but
it must not assume that mature cohort fits should dominate forecasts for
the latest cohorts.

Third, the spike should start **aggregate, synthetic, and latency-first**.
Per-slice Phase 2 remains too unsettled to be the opening move, and the
current architectural waste is primarily in the path-latency story rather
than in the already-partial consumption of `cohort_alpha` and
`cohort_beta`.

Fourth, the spike must prefer **strong shrinkage back to Phase 1**. If B3
only appears to work when mature cohort evidence is allowed to move
multiple edges freely and compensate between them, the result is not
implementation-ready even if the composed path fit improves.

## 3. Scope and non-goals

The spike is in scope for aggregate synthetic graphs, mature cohort
timing evidence, Phase 1 versus Phase 2 posterior comparison, and
assessment of whether a structurally corrected edge-level result can be
consumed coherently by the forecast stack.

The spike is explicitly out of scope for production rollout, frontend
behaviour changes, schema removal, per-slice Phase 2, explicit drift
modelling, latency drift, or replacement of the current recency half-life
heuristic. Those are follow-on questions.

The spike should also avoid trying to answer probability, latency, and
slice questions all at once. The opening question is narrower: can mature
cohort evidence improve the **structural latency composition** story
without destroying identifiability or blurring the role of `window()`
data in frontier forecasting.

## 4. Phase 0 — spike contract and evaluation setup

The first phase is to freeze the spike contract before code changes
begin.

The evaluation should be based on three synthetic regimes. The first is a
null case where Phase 1 edge fits are already correct and FW composition
matches cohort evidence. The second is a drift-style case where mature
cohort evidence disagrees with the composed Phase 1 path, so the spike
should show a meaningful structural correction. The third is a topology
case, such as a branch or join, where a single path-level summary is
known to be weak and the question is whether edge-level refinement gives a
better composed answer.

The evaluation outputs should be agreed up front. They should include:
movement of refined edge posteriors relative to Phase 1, composed path-fit
quality on held-out evidence, posterior predictive calibration, Pareto-k,
and convergence diagnostics. `delta_elpd` may be recorded, but it should
be treated as supporting evidence rather than the primary gate while the
known null-model mismatch in the scoring stack remains open.

The deliverable for Phase 0 is a short evaluation spec naming the chosen
synthetic cases, the expected null and improvement behaviours, and the
exact pass-fail rubric.

**Gate 0**: agreement that the spike is asking one question only:
whether mature cohort evidence can provide a useful structural correction
to composed edge latents without taking over the role of current-regime
estimation.

## 5. Phase 1 — aggregate latency-only prototype

Phase 1 of the spike should build the smallest credible B3 prototype.

The prototype should replace the current free path-level cohort-latency
summary with a tightly regularised edge-level refinement pass on paths
that have mature cohort evidence. The existing cohort probability
contract should be left in place initially. The latency question is the
architecturally urgent one, and opening the probability contract at the
same time would make the spike harder to interpret.

The prototype should not try to refine every latency degree of freedom at
once. The recommended order is to begin with `mu` only, then extend to
`mu` plus `sigma`, and only include onset if the earlier variants leave a
clear residual that cannot be explained otherwise. Onset is the least
stable part of the current Phase 2 geometry, so it should not be allowed
to dominate the first verdict on B3.

The priors should be centred on the Phase 1 per-edge posteriors, with
widths derived from Phase 1 uncertainty and additional shrinkage toward
the Phase 1 solution. The prototype should be deliberately conservative.

The deliverable for Phase 1 is a working prototype and a first result set
on the null synthetic case.

**Gate 1**: on the null case, refined edge posteriors remain close to the
Phase 1 solution, composed path behaviour does not degrade, and chains do
not show obvious identifiability collapse. If the null case already
induces large unjustified edge motion, B3 should be treated as non-viable
for the near term.

## 6. Phase 2 — topology and disagreement stress

If the aggregate prototype clears the null gate, the next phase is to run
it on the disagreement and topology cases.

This phase should compare three objects for each synthetic regime: the
current Phase 1-only composed path, the current Phase 2 path-summary
posterior, and the B3 prototype. The question is not merely whether the
composed path fit improves, but whether the improvement comes from a
coherent edge-level refinement rather than from unstable compensating
shifts between edges.

The result should be read in two ways. First, does the B3 prototype
improve mature path behaviour where Phase 1 composition or current
Phase 2 path summaries are known to misrepresent the topology. Second,
does it preserve a believable edge decomposition under repeated runs and
small perturbations of the same case.

The deliverable for Phase 2 is a short result note with side-by-side
tables for the three synthetic regimes.

**Gate 2**: B3 must improve the disagreement or topology cases without
materially degrading the null case. If it only improves the composed path
while producing unstable or non-repeatable edge decompositions, it should
be recorded as an interesting research result but not promoted into an
implementation track.

## 7. Phase 3 — forecast-consumption viability

A spike that improves mature path fit is still not enough. The result must
also have a coherent consumer contract.

This phase should test whether any successful B3 result can be consumed
while preserving the forecasting principle that frontier cohorts should be
led by recent `window()` evidence. The preferred outcome is a contract in
which mature cohort evidence supplies structural correction over path
composition, while current-regime estimation for the latest cohorts stays
Phase 1 and `window()` led.

Any candidate contract that effectively allows older mature cohort
evidence to overwrite the fast `window()` signal for frontier forecasting
should be rejected, even if the structural fit looks attractive.

The deliverable for Phase 3 is a short consumption note choosing between a
structural-correction role, a full per-edge replacement role, or no viable
consumer contract.

**Gate 3**: if B3 cannot be consumed without blurring the distinction
between current-regime estimation and mature structural calibration, it
should not move from spike to implementation.

## 8. Phase 4 — decision and branch

After the three spike gates, the work should fork explicitly.

If all gates pass, the next output is a separate implementation plan
covering schema, resolver behaviour, rollout order, and test expansion.
That follow-on plan should remain aggregate-first and should not reopen
per-slice Phase 2 in the same move.

If Gate 1 or Gate 2 fails, B3 should be parked and the roadmap should
return to the more modest options from doc 51, including Position 1
retention or Position 2 style gating only if a specific user-visible gap
still requires it.

If Gates 1 and 2 pass but Gate 3 fails, B3 should be recorded as a valid
structural idea with no near-term forecast-consumer role. In that case it
may still become relevant later as part of a broader structural
calibration layer or as an input to a future explicit drift model.

## 9. Preconditions for any later implementation

Passing the spike does not automatically make B3 production-ready.

Before any implementation plan is actioned, the current onset bias and
Phase 2 onset-drift defects need to be rechecked against the chosen B3
variant. If the spike only works with onset fixed or nearly fixed, the
implementation plan should preserve that constraint rather than reopening
onset immediately.

Per-slice Phase 2 remains out of scope for the first implementation.
Aggregate-first is the only credible rollout order.

The known scoring caveat on the LOO null model means `delta_elpd` should
remain a supporting signal until that contract is corrected.

Golden synthetic fixtures and forecast-path parity coverage should be in
place before any production consumer starts reading a B3 output.

## 10. Expected outputs

If run correctly, this spike should produce four durable outputs: a spike
evaluation spec, a synthetic result note, a go or no-go decision, and a
follow-on implementation plan only if the spike passes all gates.

That is enough to make the B3 question concrete without forcing an
implementation before the architecture has proved it deserves one.
