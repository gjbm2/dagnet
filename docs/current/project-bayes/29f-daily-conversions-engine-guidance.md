# Daily Conversions: Engine Integration Guidance

**Historical note (`27-Apr-26`)**: this guidance pre-dates the removal of the quick BE topo pass (24-Apr-26). References below to `handle_stats_topo_pass` describe the system as it stood when the note was written; the daily-conversions engine integration design itself is independent of that pipeline topology and remains applicable. See [project-bayes/73b](73b-be-topo-removal-and-forecast-state-separation-plan.md) for the current BE surface.

**Date**: 16-Apr-26
**Implemented**: 16-Apr-26 — G.1b landed. Daily conversions handler in `api_handlers.py` (lines ~3198-3450) calls `compute_forecast_trajectory` per edge, reads `cohort_evals` for per-cohort projected_y/completeness. Fallback to legacy `annotate_rows` if engine fails.
**Context**: doc 29f §Phase G, G.1b
**Audience**: maintainers of the daily conversions forecast integration

---

## Do not build a new codepath

The engine infrastructure for coordinate B (per-cohort at each
cohort's own age) already exists and is tested. The topo pass (G.1)
uses it in production. Daily conversions should call the same
function the same way.

## What exists (16-Apr-26)

### `CohortEvidence.eval_age`

`forecast_state.py`, `CohortEvidence` dataclass. When `eval_age` is
set on a cohort, `compute_forecast_trajectory` retains the per-cohort
`(S,)` Y/X draws at that τ column.

### `ForecastTrajectory.cohort_evals`

`forecast_state.py`, `ForecastTrajectory` dataclass. A list of
`CohortForecastAtEval` objects — one per cohort that had `eval_age`
set. Each contains:

- `y_draws: ndarray(S,)` — Y at eval_age per MC draw
- `x_draws: ndarray(S,)` — X at eval_age per MC draw  
- `eval_age: int` — the τᵢ this was evaluated at
- `conditioned: bool` — whether IS fired for this cohort

### `_evaluate_cohort`

`forecast_state.py`, module-level function. The shared per-cohort
population model primitive. Both the cohort maturity chart sweep and
the topo pass call this. It handles E_i, drift, IS conditioning,
Pop D, Pop C, evidence splice. Do not reimplement any of this.

### Working example: topo pass (G.1)

`api_handlers.py`, `handle_stats_topo_pass`, lines ~4860–4910.
Shows exactly how to:

1. Build `CohortEvidence` from `(date, age, n, k)` with `eval_age`
2. Call `compute_forecast_trajectory`
3. Read `sweep.cohort_evals`
4. Aggregate per-cohort draws into scalars

## What daily conversions should do

For each row (anchor_day):

1. Compute `eval_age = (asat_date - anchor_day).days`. If no
   `asat()` in DSL, use today.

2. Build one `CohortEvidence`. Pass `anchor_day` and `eval_date`
   as ISO date strings — the engine computes `eval_age` internally.
   Do not compute `eval_age` yourself:
   ```python
   CohortEvidence(
       obs_x=[float(x)],
       obs_y=[float(y)],
       x_frozen=float(x),
       y_frozen=float(y),
       frontier_age=age_at_last_snapshot,
       a_pop=float(x),
       anchor_day=anchor_day_iso,   # e.g. '2026-03-07'
       eval_date=asat_date_iso,     # e.g. '2026-04-16', or today
   )
   ```
   `eval_age` is computed in `__post_init__` from
   `(eval_date - anchor_day).days`. Consumers that work in τ
   coordinates (cohort maturity chart) set `eval_age` directly
   instead.

3. Collect all cohorts into a list and call `compute_forecast_trajectory`
   once per edge (not once per cohort):
   ```python
   sweep = compute_forecast_trajectory(
       resolved=resolved,
       cohorts=engine_cohorts,
       max_tau=max(c.eval_age for c in engine_cohorts),
   )
   ```

4. Read per-cohort results from `sweep.cohort_evals`. For each:
   ```python
   ce = sweep.cohort_evals[i]
   projected_y = float(np.median(ce.y_draws))
   forecast_y = projected_y - evidence_y
   # completeness from model CDF at eval_age (already available
   # from the resolved params):
   completeness = _compute_completeness_at_age(
       ce.eval_age, resolved.latency.mu,
       resolved.latency.sigma, resolved.latency.onset_delta_days)
   ```

## What daily conversions should NOT do

- **Do not compute eval_age yourself.** Pass `anchor_day` and
  `eval_date` on `CohortEvidence`. The engine computes the age.
  asat semantics belong in the engine, not in each consumer.

- **Do not call `annotate_rows` / `annotate_data_point`** for
  forecast fields. Those functions use a separate CDF evaluation
  that diverges from the engine. They are scheduled for retirement
  (doc 29f §G.4).

- **Do not call `compute_forecast_summary`.** That function
  uses aggregate tempered IS (different from the sweep's per-cohort
  sequential IS). It's only retained for the surprise gauge until
  that too is migrated.

- **Do not build a `compute_forecast_general` function.** The sweep
  already supports coordinate B via `eval_age`. A dedicated
  function would duplicate the orchestrator preamble and create a
  second codepath to maintain.

- **Do not reimplement E_i, drift, IS conditioning, or the
  population model.** All of that is inside `_evaluate_cohort`.

## Files to read

| File | What to look at |
|------|----------------|
| `lib/runner/forecast_state.py` | `CohortEvidence`, `CohortForecastAtEval`, `ForecastTrajectory`, `_evaluate_cohort`, `compute_forecast_trajectory` |
| `lib/api_handlers.py` | `handle_stats_topo_pass` lines ~4860–4910 — working coordinate B consumer |
| `docs/current/project-bayes/29f-forecast-engine-implementation-status.md` | §Phase G, §High-dimensional data and lossy collapse, §G.4 |

## Tests

The v2-v3 parity test (`v2-v3-parity-test.sh`, 17/17) gates
`_evaluate_cohort`. If daily conversions wiring changes anything in
`forecast_state.py`, run this test. If it regresses, the change is
wrong.
