# 57 — CF eligibility: degraded output when Bayes fit is missing

**Status**: Design — problem statement plus proposed rule and output contract. Replaces the abandoned Phase 4.5 κ=20 band-aid in doc 56. Revised 21-Apr-26 after review: the original topological-contamination rule was wrong; eligibility collapses to per-edge.
**Created**: 21-Apr-26
**Updated**: 21-Apr-26 (second revision — eligibility predicate switched to `resolved.alpha_beta_query_scoped`, surprise gauge aligned with doc 55 "unavailable not fallback" rule, doc 52 references corrected).
**Relates to**: doc 50 (CF generality gap — laggy-edge undershoot symptom), doc 52 (subset-conditioning double-counting — same underlying incoherence; conditioning block exposed on CF responses), doc 55 (surprise gauge; uses the same eligibility predicate but emits "unavailable" rather than degrading), doc 56 (runtime-boundary refactor — structural scaffolding on which this rule lives), doc 29f D20 (weak-prior IS collapse — prior fix on a different code path).

## TL;DR

The conditioned forecast (CF) pass was designed around Bayesian MCMC-fit edges. On those edges, the pass is a principled conjugate update: a posterior fit from all historical data acts as the prior, per-cohort observations act as the likelihood, and the sweep produces an updated posterior plus fan bands. When the edge has no Bayesian fit — its p_mean came from an analytic_be or analytic estimator, or a manual override — the "prior" and the "likelihood" are built from the same observations, so conditioning double-counts the evidence.

The fix is per-edge: on an edge whose aggregate α/β already carries the query-window evidence, skip the conditioning step entirely and emit a degraded analytic view for rate-style consumers (CF whole-graph, v3 chart, daily conversions), or emit an "unavailable" result for the surprise gauge per doc 55. The eligibility predicate is the resolver's existing `alpha_beta_query_scoped` — False means "aggregate prior, safe to conjugate-update" (Bayesian fit or manual override), True means "already a query-scoped posterior, updating double-counts" (analytic / analytic_be Jeffreys). An earlier draft argued the problem propagates downstream through the arrival carrier; it does not, because the carrier is built from empirical upstream observations or parametric upstream latency, neither of which feeds an upstream epistemic posterior into the downstream sweep. The rule therefore collapses to per-edge with no topological walk required.

## Why the current behaviour is wrong

On an edge with a Bayesian MCMC fit (or a manual α/β override), the resolver's α/β is an aggregate prior: it was built from historical data but does not incorporate the user's current query-window evidence. CF's importance-sampling step then updates that aggregate prior with per-cohort observations from the query window, which is a principled conjugate update. For Bayesian edges the per-cohort evidence is technically a subset of the fit dataset, so the update double-counts a small share (doc 52 / P1.12 tracks the exact overstatement and the pro-rata shrinkage helper that would correct it); for manual edges the aggregate and the per-cohort evidence are independent by construction.

On an edge whose source is analytic or analytic_be, the resolver's α/β is already a query-scoped posterior: it was derived directly from observations inside the query window via a Jeffreys-style estimator. The resolver flags this explicitly with `alpha_beta_query_scoped == True`. Feeding such an α/β into CF's conjugate update counts those observations a second time as the "likelihood", which on a typical edge produces a ~100% double-count share — not the bounded ~5% that the Bayesian subset case tolerates.

This is the structural mistake the current pipeline makes: it runs CF conditioning uniformly across all edges without checking whether the resolved α/β is an aggregate prior or already a query-scoped posterior. The `alpha_beta_query_scoped` predicate is the correct branch point; today's code ignores it on the CF path.

## Why the problem does not propagate downstream

An earlier draft of this doc claimed that a single non-Bayesian edge anywhere upstream invalidates CF conditioning for the entire subgraph below it. That claim is wrong and has been removed. The reasoning:

The sweep for edge E consumes three inputs: a prior on E's own rate (Bayesian α/β), E's per-cohort cohort evidence, and an arrival carrier at E's from-node. The arrival carrier carries two pieces of information — a reach probability (how many anchor-cohort events arrived at E's from-node) and a CDF over arrival times (when they arrived).

The reach probability is a scalar: the product of upstream edges' point-estimate p_mean values, whichever source produced them. The sweep does not draw samples from upstream rate distributions; it treats reach as fixed. No upstream posterior on p is consumed.

The arrival CDF is built by one of three tiers already implemented in the runtime:

- **Tier 1 parametric**: plug in upstream edges' latency parameters (μ, σ, onset). These live on the edge as point estimates regardless of whether the edge has a Bayesian fit on p. Latency parameters and probability fits are independent of each other.
- **Tier 2 empirical**: use actual upstream cohort observations — raw event counts at each day from the snapshot DB. Purely empirical; no model is in the picture at all.
- **Tier 3 weak prior**: a weak-prior backstop used when nothing else is available.

None of these three tiers requires an upstream edge to have a Bayesian posterior on p. The arrival carrier is about when and how many events arrived, not about what rate we believe produced them. Upstream rate uncertainty does not enter E's sweep.

Consequence: a downstream edge with its own Bayesian fit can condition coherently even when an upstream edge has no Bayesian fit, provided the carrier is Tier 1 or Tier 2. The eligibility rule therefore collapses to per-edge — it does not need a topological walk.

Carrier quality is still a separate axis. An edge whose carrier degenerates to Tier 3 is running with less information than one with Tier 1 or Tier 2, and the response should probably flag that. But Tier-3 carrier degradation is orthogonal to CF-eligibility and is not addressed here; it is the existing carrier hierarchy's concern.

## The proposed rule

For each edge in the CF pass, compute a boolean `cf_eligible`:

- `cf_eligible(E)` is true if and only if `resolved(E).alpha_beta_query_scoped == False`.

That is the whole rule. It uses the resolver's existing predicate directly, so any future model source with aggregate-prior semantics is automatically in scope without touching this doc. Under today's resolver, `alpha_beta_query_scoped == False` covers the `bayesian` and `manual` sources; `alpha_beta_query_scoped == True` covers `analytic` and `analytic_be`.

No topological walk. No propagation. Per-edge only.

On an edge where `cf_eligible` is true, CF runs its existing sweep: prior from the resolver's α/β, IS conditioning on per-cohort evidence, fan bands from MC quantiles. The Phase 3 code path is unchanged for these edges.

On an edge where `cf_eligible` is false, CF skips the sweep entirely and emits a degraded analytic view (for the CF whole-graph handler, v3 chart handler, and daily conversions handler) or an "unavailable" result (for the surprise-gauge handler — see "Surprise gauge" below). The degradation is purely about conditioning — the arrival carrier for this edge is still built as today (Tier 1 / Tier 2 / Tier 3) because the carrier mechanism is unchanged and continues to feed downstream edges that do run the sweep.

## Output contract

Degraded edges return a response object of the same shape as today, with the following fields determined by the degradation:

- `p_mean`: the resolver's analytic p_mean (the same number that appears on the edge today).
- `p_sd`: the binomial standard error `sqrt(p_mean · (1 - p_mean) / n_effective)`, where `n_effective` comes from `resolved.n_effective` when available and otherwise from `p.evidence.n`. Exact band formula is deferred to open question 1; binomial SE is the default.
- `p_sd_epistemic`: on degraded edges there is no separate epistemic channel (no MC draws to decompose predictive from epistemic). Emit `p_sd_epistemic == p_sd` so the response shape stays consistent with the Bayesian path. Consumers that want to treat degraded edges differently can do so via the provenance fields below.
- Fan bands (the `_band_low` / `_band_high` channels, or equivalent per the existing schema): computed analytically from `p_sd` at the band level the request asks for. These will be visibly narrower and less structured than MC bands; that is the intended visual signal that the edge is running degraded.
- Completeness and timing fields come from the edge's latency block deterministically, with no MC drift applied. This matches what the legacy v1 carrier already does on non-Bayesian paths.
- `conditioning` block (doc 52 / P1.12 subset-conditioning output): **omitted**. This block is produced by the conditioning step that no longer runs on degraded edges. Its absence is meaningful — it signals that no subset-conditioning shrinkage is being applied because no conditioning happened.
- `_forensic`: a minimal stub `{ "cf_source": "analytic-degraded", "cf_degradation_reason": <string> }` and nothing else. The usual per-cohort IS diagnostics (`rate_draws_sha256`, `carrier_tier`, per-cohort weights) are absent because no sweep ran. `rate_draws_sha256` specifically is never present on degraded edges — this matters for the doc 56 §11.1 RNG-parity gate, which already ignores edges without a hash.

Additionally, each edge in the CF response carries explicit provenance at the top level (not buried in `_forensic`) so consumers can render degradation without having to parse diagnostics:

- A new field `cf_source` takes values `"bayesian"` or `"analytic-degraded"`.
- On `analytic-degraded` edges, a `cf_degradation_reason` field states why. Today the only reason is `"no-bayes-fit-on-edge"`. Future reasons (e.g. Tier-3-only carrier, missing evidence) can be added as additional values.

The chart FE treats `cf_source == "analytic-degraded"` edges as visually distinct — dashed stroke, muted colour, or an explicit legend entry. That is a frontend decision and is not specified here, but the backend must make degradation visible enough on the response that the frontend has the material.

## Surprise gauge: "unavailable", not degraded

Doc 55 explicitly specifies the surprise-gauge contract: "If the sweep cannot run for the current subject, the gauge reports itself unavailable with a reason, rather than substituting a second-class formula." That rule takes precedence for the surprise-gauge call site and this doc aligns with it.

Reasoning: the surprise gauge is inherently a comparison between an observed outcome and a predicted distribution. Without a predicted distribution — which is exactly what CF-ineligibility means — "surprise" is undefined. A point estimate with a binomial SE is a legitimate degraded *rate*, but it is not a degraded *prediction*: computing a surprise score against a binomial SE compares the observation to the null hypothesis that rates match exactly, which is not what the gauge means. Emitting any number in that situation would be misleading.

Therefore, on edges where `cf_eligible` is false, the surprise-gauge handler (`_compute_surprise_gauge`, doc 55) returns an "unavailable" envelope. The exact response shape follows doc 55's unavailable contract (reason code, no `z_score`, no band fields). `cf_source` is still emitted at the response level with value `"analytic-degraded"`; `cf_degradation_reason` states `"no-bayes-fit-on-edge"` just like the CF case. The difference is only that no degraded numerical substitute is produced — the gauge is absent, not weakened.

CF whole-graph, v3 chart, and daily conversions behave differently because they are rate-reporting surfaces, not prediction-comparison surfaces: a degraded rate is a legitimate fallback there; a degraded "surprise score" is not.

## Where the branching lives

The eligibility decision is a handler-level concern, not an engine-level concern. Both engine entry points — `compute_forecast_trajectory` and `compute_forecast_summary` — continue to do one thing: run a sweep given α, β, and carrier inputs. The handlers are responsible for deciding which edges to hand to the engine and which to short-circuit.

Concretely:

- A small helper in the runtime module (`forecast_runtime.py`) takes a resolved edge and returns `cf_eligible`. The helper is trivial under the per-edge rule — it reads `resolved.alpha_beta_query_scoped` and negates it — but is centralised so future refinements (e.g. flagging Tier-3-only carrier as a second degradation axis) all land in one place.
- The CF whole-graph handler (`handle_conditioned_forecast`) consults the helper per edge. Eligible edges go through the existing sweep path. Ineligible edges go through a new short-circuit path that assembles the degraded response from the resolver output plus a binomial-SE band calculation.
- The v3 chart handler (`_handle_cohort_maturity_v3`) applies the same rule. Its row builder (`compute_cohort_maturity_rows_v3`) calls `compute_forecast_trajectory`; the handler short-circuits before the row builder runs on a degraded edge and assembles a degraded row set analytically instead.
- The daily conversions handler applies the same rule on the same engine entry point.
- The surprise-gauge handler (`_compute_surprise_gauge`, doc 55) calls `compute_forecast_summary`, which is a different engine entry point but the same class of conditioning. It applies the same eligibility predicate but a different fallback: on a CF-ineligible edge, the gauge reports unavailable with reason rather than emitting a degraded analytic substitute, per doc 55's contract. See "Surprise gauge" above.

The rule is a property of the graph and the resolver, not of any single consumer; all four call sites share the helper.

## What this replaces in doc 56

Doc 56 §8 Phase 4.5 and §11.2 proposed a κ-fallback rewrite in `forecast_runtime.py` — change the non-Bayesian κ from 20 to an evidence-n-derived concentration. That approach was a band-aid. It would have pulled the doc 50 laggy-edge deltas back toward parity, because a stronger fake prior resists the per-cohort noise better. But it does not change the underlying fact that the pass is double-counting evidence on non-Bayesian edges: it just makes the double-count numerically invisible on a specific fixture set.

This doc supersedes that approach. The κ-fallback change is not made. Instead, the handlers learn to skip conditioning entirely for non-Bayesian edges. Doc 56's §8 Phase 4.5 and §11.2 will be updated to point here; the rest of doc 56 (structural refactor, Phases 0-3, runtime module) remains correct and in force.

## What this does not do

This design does not address the Bayesian-side subset-conditioning double-count described in doc 52 / P1.12. That issue — the aggregate Bayesian posterior already contains a small share of the per-cohort evidence, so conditioning overstates certainty by a bounded ~5%-of-subset-share margin — still applies to CF-eligible edges. The pro-rata shrinkage helper remains the right fix there. This doc only handles the coarse-grained case: edges where the whole premise of conditioning is absent rather than slightly overstated.

This design does not touch the carrier hierarchy. Tier 1 / Tier 2 / Tier 3 selection stays exactly as it is today for all edges, eligible or degraded. Carrier-tier quality is a separate concern from CF eligibility and is tracked independently.

This design does not remove non-Bayesian edges from graphs or force users to run Bayes on every edge. Degraded analytic output is a legitimate state — many graphs have edges that have not been Bayes-fit and may never be. The degradation is honest: we give the user the analytic numbers we have, labelled for what they are, and we do not invent a Bayesian posterior where none exists.

## Open questions

1. **Band formula on degraded edges**: binomial SE (`sqrt(p·(1-p)/n)`) assumes a normal approximation that is poor for small n or extreme p. Alternatives: Wilson score interval, Jeffreys interval, or Beta(k+1, n-k+1) quantiles. All three are mildly more principled and only marginally more complex to compute. Decision can wait until the chart FE has rendered a few real graphs; pick the one that looks least misleading at the edge cases.

2. **`n_effective` vs `evidence.n`**: the resolver populates `n_effective` for Bayesian-fit edges; on analytic edges it falls back to `evidence.n`. The degraded-edge band formula should use whichever is populated, with a deterministic preference order. The resolver is the right place to establish that preference; the handlers just read the resolved value.

3. **Tier-3-only carrier as a second degradation axis**: today a downstream edge whose carrier falls to Tier 3 runs the sweep with a weak-prior arrival CDF. That is a different kind of degradation from "no Bayes on this edge" but is arguably similar in spirit — the output is less principled than the response shape implies. The handler could flag Tier-3-only carrier as a secondary degradation state (`cf_source == "bayesian-tier3-carrier"` or similar). Out of scope for this doc but worth flagging as a follow-on once the per-edge rule lands.

4. **Surprise-gauge reason-code vocabulary**: doc 55's unavailable contract requires a reason code on the response. The only reason this doc currently produces is `"no-bayes-fit-on-edge"` (i.e. the edge's resolved source is analytic / analytic_be). Future eligibility refinements (e.g. Tier-3-only-carrier if open question 3 is taken up) would introduce additional reason codes. Doc 55 should own the vocabulary registry; this doc adds to it but does not define it.

## Sequencing

Before implementation, this doc needs sign-off on the per-edge rule, the output contract including the `p_sd_epistemic` / `conditioning` / `_forensic` handling, and the inclusion of `compute_forecast_summary` alongside `compute_forecast_trajectory` callers. After sign-off:

1. Implement the eligibility helper in `forecast_runtime.py`. Trivial under the per-edge rule; centralised for the future refinements in open question 3.
2. Add the short-circuit path to `handle_conditioned_forecast` (CF whole-graph), `_handle_cohort_maturity_v3` (v3 chart), the daily conversions handler, and `_compute_surprise_gauge`.
3. Extend the response schema with `cf_source` and `cf_degradation_reason` at the edge level. Coordinate with the chart FE on rendering.
4. Re-run `cf-truth-parity.sh` on the doc 50 fixtures. Expected outcome: CF-eligible edges remain at parity (they are unaffected by this change); previously-red non-Bayesian edges now emit degraded output and are compared against the degraded contract, not the sweep. The doc 50 truth-parity assertions will need revisiting — some "laggy-edge undershoot" failures will vanish because the pass stops attempting a coherent Bayesian forecast on those edges.
5. Re-capture the doc 56 oracle baselines in a dedicated commit with explicit before/after deltas, per doc 56 §11.1. The RNG-parity gate is retired at this point because the sweep no longer runs on degraded edges, so per-edge `rate_draws_sha256` is absent on some edges — the gate's single fixture either moves to an all-eligible fixture or is retired wholesale.
6. Update doc 56's Phase 4.5 and §11.2 sections to point here. Update doc 52 (subset-conditioning) to acknowledge this doc as the coarse-grained complement to its fine-grained pro-rata helper. Update doc 55 surprise-gauge to acknowledge this doc as the source of the `cf_eligible` predicate it branches on and to confirm that the "unavailable" envelope is the only surprise-gauge behaviour for ineligible edges.

Completion of these steps closes out the doc 56 migration on the CF side and the matching fix on the surprise-gauge side. Other consumers of the eligibility rule follow the same pattern.
