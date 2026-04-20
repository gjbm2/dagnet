# 29g — Engine IS Conditioning and Sweep Evaluation

**Date**: 14-Apr-26
**Status**: Proposal — for review before implementation
**Depends on**: doc 29 (engine design), 29e Phase 5 (v3 consumer)

**Review context** (read before reviewing this proposal):
- `29-generalised-forecast-engine-design.md` — §Schema Change, §Two
  Modes, §Completeness with uncertainty, §Pipeline Injection
- `29d-phase-b-design.md` — IS conditioning maths (parameterisation B:
  `Bin(E_eff, p)`), frontier exposure, per-cohort drift
- `29e-forecast-engine-implementation-plan.md` — Phase 5 section,
  dependency diagram
- `29f-forecast-engine-implementation-status.md` — current status,
  defects D1-D6
- `RESERVED_QUERY_TERMS_GLOSSARY.md` — cohort() semantics,
  x-denominated completeness, path-level latency
- `cohort_forecast_v2.py` lines 710-890 — v2's MC + IS implementation
  (the reference to match)

---

## Problem

The forecast engine (Phase 3) computes per-edge completeness and rate
as point estimates with SD. It does not apply IS conditioning against
observed evidence, and does not return per-draw arrays for consumers
that need quantiles (fan bands).

v2's cohort maturity chart computes its own MC fan bands internally
(~250 lines), including per-cohort IS conditioning. This is the main
logic v3 cannot simply delegate to the engine today.

The goal: generalise IS conditioning into the engine so v3 (and any
future consumer) can get conditioned forecasts without reimplementing
the MC loop.

---

## What IS conditioning does

Each cohort i has observed (k_i conversions from n_i exposures) at
age τ_i. The model predicts that the effective number of trials at
that age is:

```
E_i = n_i × CDF(τ_i, mu_s, sigma_s, onset_s)
```

Where `CDF` is the completeness at that cohort's age for draw s.
Mature cohorts (high τ, CDF≈1) have E_i ≈ n_i — lots of effective
trials, so the observed k_i/n_i strongly constrains p. Young cohorts
(low τ, CDF≈0.3) have E_i ≈ 0.3×n_i — fewer effective trials, less
constraint.

The IS weight for draw s across all cohorts is:

```
log w_s = Σ_i [ k_i × log(p_s) + (E_i - k_i) × log(1 - p_s) ]
```

Draws where p_s is consistent with the observed evidence get high
weight; draws where p_s is too high or too low get downweighted.
Resampling by these weights gives a conditioned posterior that
reflects both the prior and the evidence.

This is not optional for accurate forecasting. Without it, the fan
bands reflect the prior only and ignore the evidence — producing
midpoints around p≈0.70 (prior) when the evidence says p≈0.45.

---

## What the engine already computes

`compute_forecast_state_cohort/window` (in `forecast_state.py`)
already:

1. Draws `(mu_s, sigma_s, onset_s)` from the joint posterior
   (using `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`)
2. Evaluates CDF at every cohort age for every draw (the MC loop
   at lines 434-461)
3. Computes `completeness_sd` as the std of the n-weighted per-draw
   completeness values

Step 2 produces exactly the `CDF_s(τ_i)` values needed for IS
conditioning. The engine computes them and throws them away after
taking the std.

---

## Proposed change

Add IS conditioning to the engine and expose conditioned draws.

### New engine function signature

```python
def compute_forecast_summary(
    edge_id: str,
    resolved: ResolvedModelParams,
    cohort_ages_and_weights: List[Tuple[float, int]],
    evidence: List[Tuple[float, int, int]],  # (τ_i, n_i, k_i)
    from_node_arrival: Optional[NodeArrivalState] = None,
    num_draws: int = 2000,
) -> ForecastSummary:
```

Where `ForecastSummary` contains:

```python
@dataclass
class ForecastSummary:
    # Point estimates (same as today's ForecastState)
    completeness: float
    completeness_sd: float
    rate_conditioned: float
    rate_conditioned_sd: float
    rate_unconditioned: float

    # Conditioned draws (for consumers that need quantiles)
    p_draws: np.ndarray          # (S,) resampled p values
    mu_draws: np.ndarray         # (S,) resampled mu values
    sigma_draws: np.ndarray      # (S,) resampled sigma values
    onset_draws: np.ndarray      # (S,) resampled onset values
```

### What the function does

1. Draw `p_s` from `Beta(alpha, beta)` — S draws
2. Draw `(mu_s, sigma_s, onset_s)` from joint posterior — S draws
3. For each draw s, for each cohort i:
   - `CDF_s(τ_i)` via `_compute_completeness_at_age` or
     `_convolve_completeness_at_age` (upstream-aware)
   - `E_i = n_i × CDF_s(τ_i)`
4. Compute IS weights: `log w_s = Σ_i [k_i log p_s + (E_i - k_i) log(1-p_s)]`
5. Resample all draw arrays by weights
6. Compute point estimates from resampled draws
7. Return both point estimates and resampled draws

### How consumers use it

**Topo pass** (per-edge, every fetch):
- Calls `compute_forecast_summary` with observed cohorts as both
  `cohort_ages_and_weights` and `evidence`
- Reads `completeness`, `completeness_sd`, `rate_conditioned` —
  writes to existing graph fields
- Ignores the draw arrays
- Cost: same as today (S × n_cohorts CDF evaluations, plus IS
  weighting which is O(S × n_cohorts) arithmetic — negligible)

**Cohort maturity chart v3** (per-edge, on demand):
- Calls `compute_forecast_summary` with observed cohorts
- Gets back conditioned draws `(p_s, mu_s, sigma_s, onset_s)`
- Evaluates CDF at each display τ using the conditioned draws:
  `rate_s(τ) = p_s × CDF(τ, mu_s, sigma_s, onset_s)`
- Takes quantiles per τ → fan bands
- No MC loop in v3 — just CDF evaluation on pre-conditioned draws

**Surprise gauge**:
- Calls `compute_forecast_summary`
- Reads `rate_unconditioned ± rate_unconditioned_sd` as the baseline
- Compares against observed rate
- Ignores draw arrays

### Cost analysis

The IS conditioning adds O(S × n_cohorts) arithmetic (log/exp) to
the existing MC loop that already does O(S × n_cohorts) CDF
evaluations. This roughly doubles the MC loop cost. For typical
values (S=2000, n_cohorts=20), this is ~80K operations — under 1ms.

The topo pass cost does not increase meaningfully. The chart cost
shifts from v3 reimplementing the MC loop to the engine doing it
once — net reduction.

The chart's **sweep evaluation** (CDF at 0..max_tau for conditioned
draws) is O(S × max_tau) ≈ 800K CDF evaluations. This is new work
that only the chart consumer triggers. The topo pass does not pay
this cost. Each CDF evaluation is ~100ns (erfc), so ~80ms — acceptable
for a chart that takes seconds for DB queries.

---

## What v3 becomes

With this engine function, `cohort_forecast_v3.py` does:

1. Resolve subjects and compose evidence frames (reused from handler)
2. Extract per-cohort evidence: `[(τ_i, n_i, k_i)]` from frames
3. Call `compute_forecast_summary(edge, resolved, cohorts, evidence, carrier)`
4. Sweep: for each display τ in 0..max_tau:
   `rate_draws[s] = forecast.p_draws[s] × CDF(τ, forecast.mu_draws[s], ...)`
5. Quantiles per τ → fan_bands, midpoint, fan_upper, fan_lower
6. Assemble rows (evidence + engine scalars + fan bands)

Steps 4-5 are ~30 lines. Step 6 is ~50 lines. Total v3: ~150 lines
including the handler. No reimplementation of CDF, carrier, model
resolution, or IS conditioning.

---

## Files touched

| File | Change |
|------|--------|
| `lib/runner/forecast_state.py` | New `compute_forecast_summary` function. Refactor existing MC loop to include IS conditioning and return draws. |
| `lib/runner/cohort_forecast_v3.py` | Rewrite to call `compute_forecast_summary` + sweep evaluation. |
| `lib/api_handlers.py` | `handle_stats_topo_pass`: optionally pass evidence to engine for IS-conditioned topo pass values. |
| `lib/tests/test_forecast_state_cohort.py` | Tests for IS conditioning: conditioned completeness < unconditioned when evidence says p < prior. |
| `lib/tests/test_v2_v3_parity.py` | Midpoint parity should tighten from 37% to <5% (MC variance). |

---

## Resolved questions

1. **Should the topo pass use IS conditioning?** Yes. The blend
   formula uses `p.forecast` for the immature portion of each cohort.
   Using the IS-conditioned (posterior) rate for this is the correct
   Bayesian update — it applies the evidence-updated population rate
   to unobserved trials. Using the unconditioned (prior) rate would
   ignore evidence when predicting future conversions. Not circular:
   the evidence constrains the rate, and the constrained rate is
   applied to the portion not yet observed.

2. **Draw count.** 2000 draws when evidence is provided. IS suffers
   from weight collapse (low ESS) with too few draws. 200 draws may
   collapse to ESS≈5 under strong evidence. 2000 is the standard
   minimum for IS to maintain healthy ESS.

3. **Evidence format.** Map `cohort_data[edge_uuid]` entries
   `{age, n, k}` directly to `[(τ_i, n_i, k_i)]`. Trivial.

4. **ESS collapse under strong evidence.** When aggregate evidence is
   large (k=5000, E=4500 across 18 cohorts), the likelihood is
   extremely peaked. Solutions explored:
   - *Hard cap* at 200 effective trials: pragmatic but loses
     information from large datasets.
   - *Sequential per-cohort IS*: over-conditions, ESS still erodes.
   - *Tempering* (implemented): binary search for λ ∈ [0,1] such that
     `Lik^λ` maintains ESS ≥ target (default 20). Preserves
     conditioning direction, bounds ESS, adapts to evidence strength.
     See `forecast_state.py` `_weights_and_ess`.

5. **Frontier-only vs trajectory conditioning.** The engine conditions
   on terminal (frontier) observations only — one (τ, n, k) per
   cohort at its maximum observed age. Rationale:
   - x and k are cumulative. For fixed CDF shape, the Fisher
     information about p from the full trajectory equals the endpoint
     information (doc 18 compiler-journal §2434).
   - The IS resampling is already joint over (p, mu, sigma, onset):
     E_s varies per latency draw, so frontier k already favours
     faster latency draws. Not p-only conditioning.
   - What is missing is only within-trajectory shape information
     (how k grows between age 0 and the frontier). A tractable
     extension would add a shape-only Multinomial weight on latency
     draws (interval increments Δk_j with π_j = ΔF_j/F(T)), keeping
     Bin(E_eff, p) for the p update. Not implemented — the Bayesian
     fit already conditions latency on the full trajectory via
     posterior SDs, so marginal gain is small for bayesian source.
   - v2 does the same: frontier-only IS (lines 840-861).
