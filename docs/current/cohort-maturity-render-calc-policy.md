# Cohort Maturity and Daily Conversions: Render and Calculation Scope

What range cohort_maturity and daily_conversions **compute** and what they **draw**. Rendering / styling (epoch zones, solid vs dashed, evidence admission) is downstream of this and documented in [CF_ROW_PIPELINE.md](codebase/CF_ROW_PIPELINE.md) / [DATE_MODEL_COHORT_MATURITY.md](codebase/DATE_MODEL_COHORT_MATURITY.md).

## Inputs

| Input | Meaning |
|---|---|
| **cohort scope** | `cohort(date_range)` clause. Range of admitted anchor days `[anchor_from, anchor_to]`. |
| **asat** | `.asat(date)` or default (today, with semantic differences — [DATE_MODEL_COHORT_MATURITY.md §1.5](codebase/DATE_MODEL_COHORT_MATURITY.md)). |
| **frontier_date** | `min(latest_retrieved_at, asat)`. Latest admitted evidence date. |
| **saturation_τ** | t95 of the composed predictive request CDF (post-latency-map flow). **Latent on the engine's output** — derived by the engine's composition step, not a precomputed input. |
| **user_axis** | Optional FE chart-axis control (cohort_maturity: τ extent; daily_conversions: calendar date range). |
| **visibility_mode** | `e` (evidence only), `f` (forecast/model only), `f+e` (both). |

## Engine boundary

Conditional logic for span/calc scoping lives at the **perimeter** (the analysis handler). The **engine** runs per scenario, ignorant of how its output is consumed. The engine boundary takes **one** input bounding its work:

```
compute_extent  =  how far the engine should compose and project, in τ days
```

The engine:
1. Composes the predictive request CDF to `compute_extent`.
2. Derives `saturation_τ` as a latent output (t95 of the composed CDF).
3. Projects per-Cohort to `min(compute_extent, saturation_τ)`. Past saturation the math is flat — engine doesn't bother.
4. Returns rows + latent `saturation_τ`.

That's all. No mode awareness, no Auto-vs-Manual branch, no multi-scenario coordination, no chart-axis decision. Removing the `max(floor, t95, axis_tau_max)` blend in `_latent_chart_extent`, the extend-only ratchet in `build_cohort_evidence_from_frames`, and the hardcoded `saturation_tau = 400` ceiling is part of the perimeter lift.

## Handler picks `compute_extent`

```
Manual:            compute_extent  =  user_axis
Auto, F or F+E:    compute_extent  =  ceil(snapshot_observation_path_t95_multiplier × path_t95)
                                       (existing forecasting_settings; default multiplier 1.5)
                                       (fallback: snapshot_observation_t95_multiplier × edge_t95,
                                        then absolute fallback for unfitted edges)
Auto, E only:      compute_extent  =  tau_future_max  (frame-derived)
```

The multipliers exist already on `forecasting_settings` and are sent by the FE. They give the composition headroom past plateau needed for the t95 read to land inside the composed CDF.

## Handler decides what to render

Engine returned rows up to `min(compute_extent, saturation_τ)` plus the latent `saturation_τ`. Handler decides the chart axis:

```
cohort_maturity, Manual:    chart_axis_τ  =  compute_extent  (= user_axis)
cohort_maturity, Auto:      chart_axis_τ  =  natural_extent  per mode
                                              =  saturation_τ          if mode in {f, f+e}
                                              =  tau_future_max        if mode = e
```

When `chart_axis_τ > rows_returned` (Manual zoom-out past plateau), handler **pads with last-row replay** out to `chart_axis_τ`. Exact because CDF is flat past saturation.

For daily_conversions the chart axis is calendar, not τ:

```
daily_conversions:    chart_axis (calendar)  =  cohort scope date range
                                              =  [anchor_from, anchor_to]
```

τ is internal to each scenario's CDF. The handler doesn't expose it on the chart; it just uses it to read per-Cohort observed values (at `frontier_τ_i`) and projected values (at `saturation_τ`) from the engine's output.

---

## Cohort_maturity demonstration

Composed path `saturation_τ = 30` for illustration. Today is 28-May-26.

| # | Use case | cohort scope | user_axis | mode | compute_extent | rows returned | chart_axis_τ | pad? |
|---|---|---|---|---|---|---|---|---|
| 1 | Recent cohorts, F+E, Auto | `cohort(-7d:)` | Auto | f+e | ≈45 (1.5×30) | 30 | **30** | no |
| 2 | Recent cohorts, E only, Auto | `cohort(-7d:)` | Auto | e | 7 (tau_future_max) | 7 | **7** | no |
| 3 | Year-old cohorts, F+E, Auto | `cohort(1-Jan-25:31-Jan-25)` | Auto | f+e | ≈45 | 30 | **30** | no |
| 4 | Year-old cohorts, manual 7d | `cohort(1-Jan-25:31-Jan-25)` | 7d | f+e | 7 | 7 | **7** | no |
| 5 | Recent cohorts, manual 90d | `cohort(-7d:)` | 90d | f+e | 90 | 30 (capped at saturation) | **90** | yes (31..90 last-row replay) |
| 6 | Historical asat at anchor_to | `cohort(1-Jan-26:31-Jan-26)`.asat(31-Jan-26) | Auto | f+e | ≈45 | 30 | **30** | no |

Notes:
- **#1 vs #2:** Same cohort scope. F+E sizes compute_extent generously to find saturation; engine projects 30 rows. E mode sizes to tau_future_max = 7 (no need for saturation).
- **#4:** Manual zoom-in. compute_extent = 7. Engine composes only 7 (no plateau visible; irrelevant — Manual doesn't read saturation). 7 rows.
- **#5:** Manual zoom-out past plateau. compute_extent = 90. Engine composes 90, finds saturation = 30, projects only 30 (no work past plateau). Handler pads to 90 with last-row replay.

## Daily_conversions demonstration

| # | Use case | cohort scope | mode | compute_extent | per-Cohort projection reads | chart_axis (calendar) |
|---|---|---|---|---|---|---|
| A | Recent quarter, F+E | `cohort(-90d:)` | f+e | ≈45 | observed @ frontier_τ_i; projected @ saturation_τ | **-90d..today** |
| B | Recent quarter, E only | `cohort(-90d:)` | e | max(frontier_τ_i) | observed @ frontier_τ_i (projected fields null) | **-90d..today** |
| C | Historical asat | `cohort(1-Jan-26:31-Jan-26)`.asat(1-Mar-26) | f+e | ≈45 | as A | **1-Jan-26..31-Jan-26** |

Notes:
- The compute_extent in τ-space is independent of the calendar chart axis. The handler picks compute_extent for the engine's τ-space work and sets chart_axis from the cohort scope independently.
- E mode shrinks compute_extent to just-deep-enough for the deepest Cohort's evidence read; F+E mode sizes it for saturation discovery.

---

## Multiple scenarios

Each scenario's engine call is independent: handler picks `compute_extent_s` per the rules above; engine returns per-scenario rows + `saturation_τ_s`. Parallel-safe.

### Cohort_maturity

Shared τ axis. Handler reduces and pads:

```
chart_axis_τ_combined  =  user_axis                           (Manual)
                       =  max(natural_extent_s) across s      (Auto)

natural_extent_s       =  saturation_τ_s                       if mode_s in {f, f+e}
                       =  tau_future_max_s                     if mode_s = e

for each scenario s:
    rows_returned_s  =  count of rows engine returned for s
    if rows_returned_s < chart_axis_τ_combined  AND  mode_s in {f, f+e}:
        pad rows_returned_s..chart_axis_τ_combined with last-row replay
    else if rows_returned_s < chart_axis_τ_combined  AND  mode_s = e:
        leave as-is — scenario's curve ends naturally at its evidence frontier
```

E-mode scenarios don't pad because their curve has no forecast layer; rendering flat replay past evidence frontier would misrepresent "data we don't have" as "data that's saturated".

### Daily_conversions

Shared calendar axis. No τ-axis pad-out (τ is internal to each scenario):

```
chart_axis (calendar)  =  union of per-scenario cohort scopes
                       =  [min(anchor_from_s), max(anchor_to_s)]

per-Cohort rows         =  flat collection from all scenarios, plotted at their anchor dates
```

No cross-scenario reduction in τ. Each scenario's per-Cohort rows are independent on the calendar.

---

## Appendix: Implementation steps

The current code blends span/calc scoping policy into the engine in three places: `_compute_axis_tau_max` inside the shared `prepare_cf_projection_bundle` boundary; `max(floor, t95, axis_tau_max)` inside `_latent_chart_extent`; the `max(max_tau, tau_future_max)` extend-only ratchet and hardcoded `saturation_tau = 400` inside `build_cohort_evidence_from_frames`. The policy moves all of that to the analysis handlers and reduces the engine to a `compute_extent`-driven service.

**Now-work** — proper implementation of the policy:

1. Each handler (`_handle_cohort_maturity_v3`, `_handle_daily_conversions`) computes its own `compute_extent` per the rules above. Reads `visibility_mode`, `user_axis`, frame-derived `tau_future_max`, and `forecasting_settings` multipliers.
2. Engine accepts `compute_extent` as the single authoritative parameter for work extent. Internally composes to it, derives `saturation_τ` as latent, projects to `min(compute_extent, saturation_τ)`. Delete the policy blends inside `_latent_chart_extent` and `build_cohort_evidence_from_frames`. Delete the hardcoded 400 ceiling. Engine exposes `saturation_τ` as a latent runtime property.
3. The shared `prepare_cf_projection_bundle` boundary changes signature: it no longer takes `tau_extent_raw`; it takes explicit `compute_extent` from the handler.
4. Cohort_maturity row reducer: delete the `_runtime_completeness` call at `cohort_forecast_v3.py:1416` and the `completeness` / `completeness_sd` row fields. Retire the FE normaliser forward at `graphComputeClient.ts:500`. Rewrite the param-pack parity test (`test_cohort_factorised_outside_in.py:1429-1471`) to derive cohort_maturity's completeness scalar from per-Cohort row data via the ratio identity (`evidence rate at frontier_τ_i ÷ FC rate at saturation`, population-weighted). The failing IndexError test passes by deletion of the bad call path, not by adding a clip.
5. Multi-scenario pad-out at the cohort_maturity handler: after the per-scenario loop, compute `chart_axis_τ_combined` and extend each F+E scenario's row tail by repeated last-row emission. E-mode scenarios are not padded.

**73q-owned** — the dedicated scalar reducer (`73q Phase 5e`): a third CF client emitting `(p_at_saturation, completeness_at_frontier)` scalars from the shared projection bundle, owning its own CALC at the perimeter. Becomes the canonical source of `p.latency.completeness` writes; surprise_gauge (Phase 5a) consumes the same scalar pipeline. Independent of the now-work above.

The pre-DP / DP split or scenario-vectorised engine refactor is a non-73q future option. The policy here is implementable without it.
