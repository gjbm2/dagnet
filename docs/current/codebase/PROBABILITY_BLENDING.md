# Probability Blending Architecture

**Sources**: `docs/current/project-lag/implemented/forecast-fix.md`, `docs/current/deterministic.md`
**Last reviewed**: 29-Apr-26

---

## 1. The Blending Model

For every edge — latency-enabled or otherwise — DagNet's FE topo Step 2 produces a published rate `p.mean` by blending an evidence rate against a forecast rate. The same formula governs both the aggregate path (`computeBlendedMean`) and the per-cohort sweep path (`computePerDayBlendedMean`) in `statisticalEnhancementService.ts`.

### Inputs

| Input | Source | Meaning |
|---|---|---|
| `evidenceMean = k/n` | observed counts in the query scope | what we have actually measured |
| `forecastMean` | mature-window baseline (window slice or LAG p∞) | where the rate has historically settled |
| `completeness c ∈ [0,1]` | lognormal lag CDF evaluated at cohort age | fraction of eventual conversions already observed |
| `nQuery` | sample size in the query scope | size of the evidence set |
| `nBaseline` | sample size behind the forecast | strength of the historical baseline |
| `λ` (`FORECAST_BLEND_LAMBDA`) | global constant | calibrates prior strength relative to `nBaseline` |
| `η` (`LATENCY_BLEND_COMPLETENESS_POWER`) | global constant | shapes how completeness gates evidence |

### Formula (canonical conjugate blend)

The blend is a Beta-binomial conjugate update with a maturity discount applied to the evidence count:

- effective evidence count: **`nEff = c^η · nQuery`**
- prior pseudo-count: **`m₀ = λ · nBaseline`** (always present; not gated by completeness)
- evidence weight: **`w = nEff / (m₀ + nEff)`** (zero when `nEff = 0`)
- published rate: **`p.mean = w · evidenceMean + (1 - w) · forecastMean`**

The per-day variant computes `c_i`, `nEff_i`, `w_i` and blended rate per cohort, then n-weights the blended rates to the aggregate `p.mean`.

### Regime behaviour

- **Mature, evidence-rich** (`c → 1`, `n` large): `nEff ≫ m₀`, `w → 1`, `p.mean → evidenceMean`.
- **Mature, evidence-empty** (`c → 1`, `n = 0` or `k = 0`): `w → 0`, `p.mean → forecastMean`. The system has not been *given* data; the prior holds.
- **Immature** (`c` small): `nEff` shrinks proportionally to `c^η`, `w` is small, `p.mean` leans on the forecast.
- **No scope coverage** (`nQuery = 0`): falls out as the `nEff = 0` degenerate; `p.mean = forecastMean` with no special-case branch.
- **Non-latency edge**: treated as the degenerate `δ(0)` lag case (no waiting; any cohort with age > 0 is fully mature). Same formula, same code path.

Transitions across all of these are smooth — there are no `if` branches inside the blend that switch behaviour.

### The role of completeness

Completeness has **exactly one role** in the blend: it discounts the evidence count via `nEff = c^η · nQuery`. It does not modify the prior strength `m₀`, the prior mean, or the evidence rate `k/n` itself.

The numeric value of `c` is computed identically before and after the 29-Apr-26 revision: per-cohort `c_i = F(effective_age_i)` from the lognormal lag CDF (with optional one-way t95 tail constraint), then n-weighted aggregate `c = Σ(n_i · c_i) / Σn_i`. None of that pipeline has changed; only the consumer.

---

## 2. Why this formula (rationale)

The Beta-binomial conjugate update is the canonical Bayesian model for a binary-outcome rate:

- prior `Beta(α₀, β₀)` with `α₀ + β₀ = m₀` ("prior strength")
- evidence: `n` trials, `k` successes
- posterior mean: `(α₀ + k) / (m₀ + n) = w·(k/n) + (1-w)·prior_mean`, with `w = n / (m₀ + n)`

`m₀` is a property of the prior — by definition it does not depend on evidence. Evidence gains influence by accumulating `n`; it never gains influence by shrinking `m₀`. Replacing `n` with maturity-discounted `nEff = c·n` is the natural extension when only a fraction of the eventual signal has been observed; it maps cleanly onto "the evidence carries `nEff` worth of information". The prior strength is unaffected by maturity because maturity is a property of the *data*, not of the prior.

Two consequences this design embraces:

1. **"Absence of evidence is not evidence of absence."** A mature query window with `n=0` or `k=0` does not produce `p.mean = 0`. The system has not been shown a conversion-free outcome; it has been shown nothing in scope. The prior — the historical baseline — provides the answer.
2. **One code path for every edge.** Latency, non-latency, scope-with-evidence, scope-without-evidence, immature cohort sweeps, fully mature cohorts — all fall out of the same formula. Branches in `enhanceGraphLatencies` that switched behaviour by edge type or scope emptiness were workarounds for the rejected formula (see §3) and have been removed.

---

## 3. Historical formulas (on record)

The blend has gone through two rejected variants. Both are recorded here so future readers can recognise their shapes if they recur.

### 3a. Pre-forecast-fix: LAG `p_mean` overrides

Originally `dataOperationsService` persisted `latencyStats.p_mean` directly as the edge's `p.mean`. When LAG could not find mature cohorts in the scope it fell back to `p_mean = evidenceMean`, so `p.forecast.mean` was never blended in. Immature cohort windows with strong window-level forecasts collapsed silently to raw evidence.

**Replaced by**: `docs/current/project-lag/implemented/forecast-fix.md` — promoted the window-level forecast to a first-class participant via the conjugate blend formula above.

### 3b. Prior-fading variant (replaced 29-Apr-26)

For a period after `forecast-fix.md` shipped, the implementation drifted from its specification. The drifted formula was:

- `m₀Eff = m₀ · (1 - c^η)`     ← prior fades as completeness rises
- `w = nEff / (m₀Eff + nEff)`

At `c = 1` this gave `m₀Eff = 0` and `w = 1`, so the published rate became raw `k/n` regardless of how small `n` was, and it produced `p.mean = 0` for any mature scope with `k = 0` — reading "no observed conversions" as "proven zero conversion rate".

**Why it was added**: the doc this section replaces previously stated as a design constraint that "forecast influence must decay smoothly to near-zero as completeness → 1, because the forecast was meant only to compensate for right-censoring and small-sample uncertainty". Under that reading the prior-fading factor is the natural way to retire the forecast at full maturity.

**Why it was rejected**: that reading treats the forecast as a temporary scaffold rather than as a Bayesian prior. The forecast is built from the *mature window* — the most reliable historical signal — so abandoning it at full maturity inverts the value of evidence-strength. Empirically the formula manufactured "evidence of absence" from absence of evidence: a mature scope with no observed conversions read as `p.mean = 0`, suppressing edge widths and propagating zero downstream. This was the `goonthen3` reproducer in Apr-26.

The two-role conflation was the underlying error: the prior-fading variant gave completeness a second job (gate the prior strength) on top of its principled job (discount the evidence count). No standard inference framework — Bayesian or frequentist — couples prior strength to evidence maturity.

**Removed when this fix landed**:

- `Path A` short-circuit in `enhanceGraphLatencies` for `cohortsScoped.length === 0`. With the prior always present, the `nEff = 0` degenerate produces the same answer the special case used to compute, so the branch is redundant.
- Skip-no-latency branch in `enhanceGraphLatencies` for edges without `latency_parameter`. Non-latency edges are the `δ(0)` degenerate of the unified path.

### Calibration impact

Several test fixtures had been tuned to the prior-fading formula's behaviour ("evidence dominates exclusively at maturity" assertions held with modest `n` only because the prior was being faded out). Re-tuning under the corrected formula required:

- helper-function mirrors of the formula updated in `perDayBlendPooledRate.test.ts`, `lagStatsFlow.integration.test.ts`
- three hardcoded contract values updated in `statsParity.contract.test.ts`
- `n` fixture values bumped ~100× to keep evidence-dominated assertions in regime: `lagStatsFlow.integration.test.ts`, `abBcSmoothLag.paramPack.amplitude.e2e.test.ts`
- per-day vs aggregate gap tolerance widened in `windowCohortSemantics.paramPack.e2e.test.ts` (the gap is structurally larger under the conjugate blend)

`λ` and `η` were not retuned in the same change. Both currently sit at `FORECAST_BLEND_LAMBDA = 0.15` and `LATENCY_BLEND_COMPLETENESS_POWER = 2.25`. They were originally calibrated under prior-fading semantics — re-examining those numbers under the corrected formula is a follow-up worth scoping if downstream consumers report drift.

---

## 4. Deterministic Horizons (`t95` / `path_t95`)

### The determinism problem

`t95` and `path_t95` must be repeatable given identical inputs. Non-determinism arises from:

- Stage-2 using `new Date()` as reference (wall-clock coupling)
- `p.mean` feeding back into join weighting → `path_t95` → completeness → blend → `p.mean`
- Sequence dependence between boot paths (normal vs live share)

### Determinism contract

For a given graph topology + authored overrides, effective query DSL, effective slice set, and forecasting settings — `t95`, `path_t95`, completeness, and blended `p.mean` must be identical regardless of execution sequence.

### Policy decisions (adopted)

1. **Stage-2 as-of date**: pinned to resolved DSL end date (day resolution), NOT wall-clock `new Date()`.
2. **Stage-2 as pure function**: explicit input snapshot contract; no previously computed transient outputs used as inputs.
3. **Join weighting basis**: use `p.evidence.mean` (stable, not overwritten by Stage-2), NOT `p.mean` (which Stage-2 overwrites).
4. **Horizon rounding**: keep current 2 d.p. policy (`LATENCY_HORIZON_DECIMAL_PLACES = 2`).
5. **Gated persistence**: only persist horizons when as-of day or slice inputs change.

### Downstream impact

`path_t95` feeds:

- `windowFetchPlannerService.checkStaleness()` — determines which slices need refetching.
- `cohortRetrievalHorizon.computeCohortRetrievalHorizon()` — classifies cohorts as missing/stale/stable.

Changes to join weighting will change which cohorts are considered mature and therefore change fetch plans.

---

## 5. Key Invariants (Locked by Tests)

- **Prior pseudo-count is always present** — `m₀ = λ · nBaseline` is never gated by completeness. Empty or maturity-discounted evidence falls out as `w = 0` returning `forecastMean`. See `perDayBlendPooledRate.test.ts` ("keeps the prior present even at full maturity with sparse evidence").
- **One blend path for all edges** — non-latency edges flow through the unified blend as the `δ(0)` lag degenerate. No skip-no-latency branch. See `statisticalEnhancementService.test.ts` ("processes edges without latency_parameter as the degenerate δ(0) lag case").
- **Join-aware path horizons** use topological arriving mass (product from start), NOT local edge probability — `pathT95JoinWeightedConstraint.test.ts`.
- **Completeness must not be polluted by default-injected horizons** — `pathT95CompletenessConstraint.test.ts`.
- **Graph/file authority for cohort bounding** — covered by `cohortRetrievalHorizon.test.ts` (cohort bounding / classification suites). (The former `pathT95GraphIsAuthoritative.cohortBounding.test.ts` was removed; if no test still locks this invariant under the graph-authoritative framing, drop this bullet or re-add a dedicated test.)

---

## 6. Key Source Locations

- `src/services/statisticalEnhancementService.ts` — `computeBlendedMean()`, `computePerDayBlendedMean()`, `enhanceGraphLatencies()`, join weighting, path horizons.
- `src/services/fetchDataService.ts` — Stage-2 orchestration (`runStage2EnhancementsAndInboundN`).
- `src/services/UpdateManager.ts` — `applyBatchLAGValues()`, horizon rounding, graph↔file mappings.
- `src/constants/latency.ts` — `FORECAST_BLEND_LAMBDA`, `LATENCY_BLEND_COMPLETENESS_POWER`, `LATENCY_HORIZON_DECIMAL_PLACES`.
- `src/services/windowFetchPlannerService.ts` — `checkStaleness()`, `getPathT95ForEdge()`.
- `src/services/cohortRetrievalHorizon.ts` — cohort bounding.
