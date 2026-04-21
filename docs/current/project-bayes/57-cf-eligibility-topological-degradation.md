# 57 — CF sweep eligibility: degraded output for query-scoped posteriors

**Status**: Design — per-edge rule plus concrete degraded-output contract. Supersedes the abandoned Phase 4.5 κ=20 band-aid in doc 56. Revised 21-Apr-26 after review: the rule stays per-edge, the degraded path now reuses the existing closed-form Beta semantics, and the caller-facing provenance contract is explicit.
**Created**: 21-Apr-26
**Updated**: 21-Apr-26 (third revision — degraded contract fixed to Beta closed form; provenance renamed to `cf_mode` / `cf_reason`; `conditioning` / `conditioned` / `skipped_edges` invariants made explicit).
**Relates to**: doc 50 (CF generality gap — laggy-edge undershoot symptom), doc 52 (subset-conditioning double-counting — same underlying incoherence; conditioning block exposed on CF responses), doc 55 (`55-surprise-gauge-rework.md`; uses the same predicate but emits "unavailable" rather than degrading), doc 56 (`56-forecast-stack-residual-v1-v2-coupling.md`; runtime-boundary refactor that this rule sits on), doc 29f D20 (weak-prior IS collapse — prior fix on a different code path).

## TL;DR

The conditioned-forecast (CF) sweep is coherent only when the resolved α/β on the edge is an **aggregate prior**. That is exactly what the resolver's existing `alpha_beta_query_scoped` property tells us:

- `alpha_beta_query_scoped == False` → aggregate prior (`bayesian`, `manual`) → safe to run the sweep
- `alpha_beta_query_scoped == True` → already a query-scoped posterior (`analytic`, `analytic_be`) → sweeping would re-apply the same query-window evidence and double-count

The fix is therefore per-edge, not topological. On an edge whose resolved posterior is already query-scoped, skip the sweep. For rate-style consumers (CF whole-graph, v3 chart, daily conversions), emit a degraded analytic result built directly from the resolved α/β plus deterministic latency/completeness. For the surprise gauge, emit "unavailable" per doc 55. An earlier draft incorrectly claimed the problem propagated downstream through the arrival carrier; it does not.

## Why the current behaviour is wrong

On an edge with a Bayesian MCMC fit (or a manual α/β override), the resolver's α/β is an aggregate prior: it was built from historical data but does not incorporate the user's current query-window evidence. CF's importance-sampling step then updates that aggregate prior with per-cohort observations from the query window, which is a principled conjugate update. For Bayesian edges the per-cohort evidence is technically a subset of the fit dataset, so the update double-counts a small share (doc 52 / P1.12 tracks the exact overstatement and the pro-rata shrinkage helper that would correct it); for manual edges the aggregate and the per-cohort evidence are independent by construction.

On an edge whose source is `analytic` or `analytic_be`, the resolver's α/β is already a query-scoped posterior: it was derived directly from observations inside the query window via a Jeffreys-style estimator. The resolver flags this explicitly with `alpha_beta_query_scoped == True`. Feeding such an α/β into CF's conjugate update counts those observations a second time as the "likelihood", which on a typical edge produces a ~100% double-count share rather than the bounded ~5% that the Bayesian subset case tolerates.

This is the structural mistake the current pipeline makes: it runs CF conditioning uniformly across all edges without checking whether the resolved α/β is an aggregate prior or already a query-scoped posterior. The `alpha_beta_query_scoped` predicate is the correct branch point.

## Why the problem does not propagate downstream

An earlier draft of this doc claimed that a single non-Bayesian edge anywhere upstream invalidates CF conditioning for the entire subgraph below it. That claim was wrong and has been removed.

The sweep for edge E consumes three inputs: a prior on E's own rate, E's per-cohort evidence, and an arrival carrier at E's from-node. The arrival carrier carries reach and timing, not an upstream epistemic posterior on p:

- **Reach** is a scalar product of upstream point estimates. The sweep does not sample upstream rate posteriors.
- **Timing** comes from one of three existing carrier tiers:
  - **Tier 1 parametric**: upstream latency parameters
  - **Tier 2 empirical**: upstream cohort observations from the snapshot DB
  - **Tier 3 weak prior**: fallback when nothing richer exists

None of those carrier tiers requires an upstream Bayesian posterior on p. They govern when arrivals materialise, not whether E's own rate prior is aggregate or query-scoped. A downstream edge with its own aggregate prior can therefore still sweep coherently even if an upstream edge was degraded. The rule collapses to per-edge with no topological walk.

Carrier quality is still a separate axis. Tier-3-only carriers may warrant a second degradation flag later, but that is orthogonal to the present rule.

## The proposed rule

For each edge in the CF path, compute a boolean `sweep_eligible`:

- `sweep_eligible(E)` is true iff `resolved(E).alpha_beta_query_scoped == False`

That is the whole rule. It uses the resolver's semantic property directly, so any future model source with aggregate-prior semantics is automatically in scope without changing this doc. Under today's resolver:

- `sweep_eligible == True` covers `bayesian` and `manual`
- `sweep_eligible == False` covers `analytic` and `analytic_be`

No topological walk. No propagation. Per-edge only.

On an edge where `sweep_eligible` is true, CF runs the existing sweep unchanged: prior from the resolver's α/β, IS conditioning on per-cohort evidence, fan bands from MC quantiles.

On an edge where `sweep_eligible` is false, CF skips the sweep and emits degraded analytic output for rate-style consumers, or an "unavailable" result for surprise-gauge consumers.

## Relationship to the existing closed-form path

This doc does **not** introduce a second posterior model. The codebase already has a closed-form direct-read path for non-latency edges in `_non_latency_rows()`. That path already branches on the same semantic property, `alpha_beta_query_scoped`, and already knows the difference between:

- aggregate prior → conjugate update is valid
- query-scoped posterior → read directly, do not update again

Doc 57 is the latency-bearing analogue of that same rule. The implementation consequence is:

- non-latency edges keep `_non_latency_rows()` as their canonical closed-form implementation
- latency-bearing degraded edges reuse the **same rate-side formulas** as `_non_latency_rows()` — Beta mean, Beta SD, Beta quantile bands from the resolved α/β — and pair those with deterministic latency/completeness

The degraded path is therefore an extension of the existing closed-form semantics, not a new binomial-SE fallback invented alongside them.

## Output contract

Degraded edges stay in the normal per-edge `edges[]` response. They are **not** `skipped_edges`. They return the same outer shape as today's CF response, with the following field semantics:

- `p_mean`: `resolved.alpha / (resolved.alpha + resolved.beta)` — the mean of the already-query-scoped posterior
- `p_sd_epistemic`: closed-form Beta SD from the same resolved α/β
- `p_sd`: equal to `p_sd_epistemic`
  - there is no separate predictive channel when no sweep ran
  - this keeps the shape stable for consumers such as the funnel runner, which already reads both fields
- Fan bands (`fan_*` or the equivalent band fields in the consumer's schema): Beta quantiles from the same resolved α/β at the requested band level(s)
  - this matches the existing `_non_latency_rows()` semantics
  - it deliberately avoids introducing a second uncertainty model based on normal/binomial approximation
- Completeness and timing fields come from the deterministic latency path already available on the edge; no MC drift is added
- `conditioning`: keep the existing top-level block, but emit the explicit no-sweep verdict
  - `{ r: null, m_S: null, m_G: null, applied: false, skip_reason: "source_query_scoped" }`
  - the field stays present because the response contract already uses it as provenance
- `conditioned`: this remains a caller-facing verdict about whether the returned result reflects positive in-scope evidence
  - on degraded edges it is **true** when the resolved analytic posterior already incorporates positive query-window evidence
  - it is **false** only when the edge is returning a prior-only answer because no usable in-scope evidence existed
- `_forensic`: optional minimal stub `{ "cf_mode": "analytic_degraded", "cf_reason": "query_scoped_posterior" }`
  - no sweep diagnostics
  - no `rate_draws_sha256`
  - no carrier-weight internals
- `skipped_edges`: reserved for genuine no-result states such as "no prior and no evidence". Degraded edges do not belong there.

Additionally, every edge carries top-level provenance so consumers do not need to parse `_forensic`:

- `cf_mode`: `"sweep"` or `"analytic_degraded"`
- `cf_reason`: absent / null on `"sweep"` edges; `"query_scoped_posterior"` on degraded edges

The chart FE can then render degraded edges distinctly if desired (dashed stroke, muted colour, legend entry), but that visual treatment is a frontend concern rather than part of this contract.

## Surprise gauge: "unavailable", not degraded

Doc 55 explicitly specifies the surprise-gauge contract: if the sweep cannot run for the current subject, the gauge reports itself unavailable with a reason rather than substituting a second-class formula. That rule takes precedence here.

Reasoning: the surprise gauge is inherently a comparison between an observed outcome and a predicted distribution. Without a sweep-backed predictive distribution, "surprise" is undefined. A degraded rate is legitimate for rate-reporting surfaces; a degraded "surprise score" is not.

Therefore, on edges where `sweep_eligible` is false, the surprise-gauge handler returns an unavailable envelope. The exact shape follows doc 55's unavailable contract. The reason code contributed by this doc is `"query_scoped_posterior"`. `cf_mode` may still be surfaced as `"analytic_degraded"` for provenance, but no degraded numeric substitute is produced.

## Where the branching lives

The eligibility decision is a handler-level concern, not an engine-level concern. Both engine entry points — `compute_forecast_trajectory` and `compute_forecast_summary` — continue to do one thing: run a sweep given α, β, and carrier inputs. Handlers decide which edges to hand to the engine and which to short-circuit.

Concretely:

- A small helper in `forecast_runtime.py` returns `sweep_eligible = not resolved.alpha_beta_query_scoped`
- `handle_conditioned_forecast` consults that helper per edge
  - eligible edges go through the existing sweep path
  - degraded edges assemble their result from resolved α/β plus deterministic latency/completeness and the no-sweep provenance block
- `_handle_cohort_maturity_v3` applies the same rule
  - non-latency edges continue to route through `_non_latency_rows()`
  - latency-bearing degraded edges use a shared degraded helper that mirrors `_non_latency_rows()` on the rate side
- the daily-conversions handler applies the same per-edge rule on its own CF-backed branch
- `_compute_surprise_gauge` uses the same predicate but returns unavailable rather than degraded numeric output

The important invariant is that all four call sites share the predicate and the same degraded semantics. The repo must not grow one degraded formula for CF, another for v3, and a third for the gauge.

## What this replaces in doc 56

Doc 56 §8 Phase 4.5 and §11.2 proposed a κ-fallback rewrite in `forecast_runtime.py`: replace the non-Bayesian κ=20 weak prior with an evidence-n-derived concentration. That was a band-aid. It would have made the double-count less visible numerically on some fixtures, but it would not have changed the underlying incoherence: the CF sweep would still have been re-applying query-window evidence to a query-scoped posterior.

This doc supersedes that approach. The κ-fallback rewrite is not the fix. The fix is to skip the sweep entirely on query-scoped posteriors and emit an honestly degraded result instead. Doc 56's structural runtime refactor remains correct and in force.

## What this does not do

This design does not address the Bayesian-side subset-conditioning double-count from doc 52 / P1.12. That issue still applies to `sweep_eligible` edges and still needs the finer-grained correction described there.

This design does not change the carrier hierarchy. Tier 1 / Tier 2 / Tier 3 selection remains exactly as it is today for all edges, eligible or degraded.

This design does not require Bayes to have run everywhere. Degraded analytic output is a legitimate steady state for many graphs. The point is not to fake a Bayesian forecast where none exists; it is to report honestly what kind of answer the system actually has.

## Follow-on questions

1. **Tier-3-only carrier as a second degradation axis**: today an edge can still be `sweep_eligible` while running on a weak-prior carrier. That is a different degradation from "query-scoped posterior" but may deserve a second provenance state later.
2. **Surprise-gauge reason-code vocabulary**: doc 55 should remain the owner of the unavailable reason-code registry. This doc contributes `"query_scoped_posterior"` but should not become the global vocabulary source.

## Sequencing

Before implementation, this doc needs sign-off on the per-edge predicate, the degraded response contract (`cf_mode`, `cf_reason`, `conditioning`, `conditioned`, `_forensic`), and the inclusion of the surprise-gauge caller alongside the rate-style callers. After sign-off:

1. Implement the `sweep_eligible` helper in `forecast_runtime.py`
2. Factor a shared degraded-result builder that reuses the existing Beta closed-form semantics from `_non_latency_rows()` for the rate-side outputs; do **not** introduce a separate binomial-SE path
3. Add the short-circuit path to `handle_conditioned_forecast`, `_handle_cohort_maturity_v3`, the daily-conversions handler, and `_compute_surprise_gauge`
4. Extend the response schema with `cf_mode` and `cf_reason`, while keeping `conditioning` and `conditioned` defined on degraded edges and keeping degraded edges in `edges[]`, not `skipped_edges[]`
5. Re-run `cf-truth-parity.sh` on the doc 50 fixtures
   - `sweep_eligible` edges should remain unchanged
   - previously red analytic / analytic_be edges should now be compared against the degraded closed-form contract rather than against the sweep
6. Re-capture the doc 56 oracle baselines in a dedicated commit with explicit before/after deltas
   - degraded edges will no longer surface `rate_draws_sha256`
   - any RNG-parity gate must therefore move to an all-eligible fixture or be retired explicitly
7. Update doc 52 to mention this doc as the coarse-grained complement to its finer-grained correction, update doc 55 to note that `"query_scoped_posterior"` is now one of its unavailable reasons, and update doc 56 Phase 4.5 / §11.2 to point here

Completion of these steps closes out the doc 56 migration on the CF side and the matching surprise-gauge alignment. Other consumers of the same predicate follow the same pattern.
