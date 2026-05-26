# CF Hold-Out Engines

**Status**: Active reference, 12-May-26
**Scope**: the four `ΣY / ΣX` reducers that coexist in `graph-editor/lib/runner/` — the canonical mass-first selected-cohort reducer plus three "hold-out" analytic engines that haven't yet been migrated onto it. Plus the legacy trajectory engine and its two surviving callers.

This doc exists because an agent landing in `funnel_engine.py` or `daily_conversions_derivation.py` sees ad-hoc `or 0.0` cascades and case-fork schema handling that look like bugs but are actually a known architectural debt — the analytic engines predate the primitive substrate and run in parallel with it. The audit ([`cf-defensive-coding-audit.md`](../project-generalise/cf-defensive-coding-audit.md) F-1) names this as a unification opportunity. See [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) for the defensive-code findings these engines accumulate.

---

## ⚠️ STOP — read this before extending any of these engines

The `or 0.0` cascades, the `y`/`Y` case-forks, the `isinstance(anchor, str)` coercions, the `if n_0 <= 0: return all-zero-bars` early returns — these are all **debt being retired**, not the engine's contract.

**Do not add a fifth parallel `ΣY / ΣX` reducer.** If a new analytic needs cumulative-Y-over-cumulative-X, wire it into the canonical mass-first reducer (`_selected_cohort_group_rate_draws`) or, if that doesn't yet expose what you need, **fix the substrate**, don't fork.

**Do not extend the defensive patterns.** Missing CF scalars must propagate as NaN, not `0.0`. Schema normalisation belongs at the snapshot-service perimeter, not in the engine. Missing `n_0` is "unknown", not "zero conversions". The maintainer constantly polices these patterns and will revert new instances. See [INVARIANTS.md](INVARIANTS.md) I-47 and [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58.

The migration target is one mass-first reducer with four input adapters. Until then, **leave existing defensive patterns alone** (touching them risks behaviour drift) and **do not add new ones**.

---

## The four `ΣY / ΣX` reducers

Each computes a variant of cumulative `Y` over cumulative `X` from a different evidence shape. None call each other.

| Reducer | Module | Input shape | Output | Status |
|---|---|---|---|---|
| **Selected-cohort mass reducer** | `cohort_forecast_v3._selected_cohort_group_rate_draws` | `ResolvedCFRuntime` (composed primitives), `engine_cohorts`, `SelectedAClockEvidence`, projection bases | Per-particle `rate_draws (S, T)`; the E+F authority | **Canonical**, primitive-substrate-backed |
| Funnel engine | `funnel_engine.compute_bars_ef` (also `_e` and `_f`) | `cf_per_edge` (per-edge `p_mean`, `p_sd`, `p_sd_epistemic`, `completeness`) from scoped CF response | `FunnelStageBars` — per-stage bar + lo/hi, with `bar_e` / `bar_f_residual` striation | Hold-out |
| Daily-conversions reducer | `daily_conversions_derivation.derive_daily_conversions` | Snapshot rows (`anchor_day`, `retrieved_at`, `x`/`X`, `y`/`Y`, `slice_key`) | `{data: [{date, conversions}], rate_by_cohort: [{date, x, y, rate}], cohort_y_at_age: {ad: {age: y}}, ...}` | Hold-out |
| Cohort-maturity derivation | `cohort_maturity_derivation.derive_cohort_maturity` | Snapshot rows, `sweep_from`, `sweep_to` | `{frames: [{snapshot_date, data_points: [{anchor_day, y, x, a, rate, ...}], total_y}]}` | Hold-out |

The three hold-outs each implement their own evidence intake (snapshot rows or scoped CF response), their own monotonicity contract (forward-fill, none, or via the sweep grid), and their own NaN handling. Cumulative `ΣY / ΣX` is computed in three different ways.

---

## Why they're hold-outs (not bugs)

The substrate is post-73n; the analytic engines predate it. Each was originally built around a specific shape of input the substrate didn't yet produce:

- `funnel_engine` consumes a **scoped CF response** (one CF invocation per scenario) and walks per-edge `p_mean` × cumulative product. It runs **outside** the v3 row pipeline.
- `daily_conversions_derivation` consumes **raw snapshot rows** directly and produces per-(`anchor_day`, `age`, `slice`) Y trajectories via slice-aware carry-forward (`:92-111`). It does not go through `ResolvedCFRuntime`.
- `cohort_maturity_derivation` produces the **virtual-snapshot frame set** that the row pipeline consumes upstream of the substrate. It's evidence-display materialisation, not projection.

The v3 row pipeline uses `cohort_maturity_derivation`'s output as input to `build_cohort_evidence_from_frames` and then projects from the substrate. `funnel_engine` and `daily_conversions_derivation` produce **direct chart output** — they bypass the substrate entirely.

The audit's F-1 unification target is: extract a single mass-first reducer interface and feed it from all four shapes (carrier-projected mass for funnel, observed prefixes for daily, selected-cohort prefixes for maturity, runtime-projected E+F for the canonical path). Each engine then becomes a thin caller of one shared mathematical core.

---

## The canonical reducer in one paragraph

`_selected_cohort_group_rate_draws` is the mass-first E+F authority. It sums **mass** across selected cohorts first (per-particle `ΣX_total(s, τ)` and `ΣY_total(s, τ)`) and divides **once** at the end, with `NaN` cells where the denominator is zero. The denominator pool is `x_frozen` (observed prefix) + `(a_pop − x_frozen) × R_x` (Pop C future arrivals via conditional carrier residual). The numerator pool is `y_frozen` + Pop D residual (`(x_frozen − y_frozen) × R_subject_calibrated`) + Pop C convolution (`(a_pop − x_frozen) × Conv_PopC`). Identity carrier degenerates: no Pop C, denominator stays at `x_frozen`. See [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) §4 for the full algebra. The reducer reads composed primitives directly from `ResolvedCFRuntime.composed_subject` / `composed_carrier`; it does not re-condition.

The three hold-outs each re-implement pieces of this, with different defensive-code patterns:

---

## Funnel engine

`funnel_engine.py` (320 LOC). Pure-numpy Level-2 reducer for `conversion_funnel`. Three regimes on a linear path:

- **e**: raw observed ratios + Wilson CI. Walks per-edge `(k, n)` evidence.
- **f**: model-only. Per-edge predictive Beta draws (`alpha_pred`, `beta_pred`); cumprod; quantile bands.
- **e+f**: data-conditioned. Per-edge CF scalar (`p_mean`, `p_sd`, `p_sd_epistemic`, `completeness`); mixture-variance band per doc 52 §3.5 with `var_total = c · var_epi + (1 − c) · var_pred`; striation decomposition (`bar_e`, `bar_f_residual`).

Audit findings concentrated in this engine:

- **H-2** (HIGH): `or 0.0` substitution for missing `p_mean` truncates the entire funnel via `np.cumprod` → silent zero-conversion bar.
- **M-8**: `not isinstance(n_0, (int, float)) or n_0 <= 0` → all-zero bars, indistinguishable from real zero.
- **L-3**: Wilson CI returns `(0.0, 0.0)` at `n=0` instead of `(NaN, NaN)`.

The engine is invoked **outside** the v3 row pipeline — typically from an analysis runner that wraps a scoped CF call. The scoping logic and the `cf_per_edge` dict-shape contract are the engine's perimeter; that perimeter is loose.

---

## Daily-conversions reducer

`daily_conversions_derivation.py` (162 LOC). Computes per-day conversion attribution and per-cohort rate from snapshot rows. Two outputs:

- `data`: `ΔY` (new conversions) attributed to each retrieval date, computed per `(anchor_day, slice_key)` series with retrieval-time-ordered deltas.
- `rate_by_cohort`: latest cumulative `(x, y)` per `anchor_day` summed across slices, ratio = rate.
- `cohort_y_at_age`: cumulative Y at each age, building the trajectory chart series.

Audit findings:

- **H-3** (HIGH): `current_Y = snap.get('y') or snap.get('Y') or 0` is two defects: case-fork on schema shape plus zero-substitution. Schema normalisation belongs at the snapshot-service perimeter, not here.
- **M-7**: `isinstance(anchor, str)` engine-internal dispatch on `str`-vs-`date`.

The per-slice carry-forward algorithm (`:92-111`) is correct: at each cohort age, sum the latest-known Y for each slice that has observed any row at or before that age. Naturally monotonic because each slice's Y is cumulative. The defects are around schema normalisation at the input boundary, not in the algorithm.

---

## Cohort-maturity derivation

`cohort_maturity_derivation.py` (325 LOC). Builds the virtual-snapshot frame set: for each calendar day in `[sweep_from, sweep_to]`, compute the latest `(x, y, a, retrieved_at)` per `(anchor_day, slice_key)` as-of that day, and emit one frame per day with one data_point per anchor.

This is **upstream** of the v3 row pipeline. `build_cohort_evidence_from_frames` consumes these frames to derive `engine_cohorts`, `cohort_list`, epoch boundaries, and `cohort_at_tau` evidence buckets. It is not itself a reducer in the F-1 sense — it's evidence-display materialisation.

Audit findings:

- **M-7**: `isinstance(anchor, str)` (`:72-73, 107-108, 283, 287`) and `_parse_row` schema coercion. Same root cause as daily-conversions: schema normalisation should live at the perimeter.

The pervasive `_int_or_zero(row.get('a') or row.get('A'))` case-fork is the same shape as H-3 but tagged MEDIUM here because the engine's downstream consumer (`build_cohort_evidence_from_frames`) is tolerant of zeros via its own forward-fill — the silent corruption is bounded.

---

## The legacy trajectory engine

`forecast_state.compute_forecast_trajectory` (in `forecast_state.py`, 1,854 LOC total).

**Status post-73n: DO NOT ADD NEW CALLERS.** The module's own docstring at `:1048-1058`:

> "POST-73n STATUS — DO NOT ADD NEW CALLERS. The CF row/scalar path (`compute_cohort_maturity_rows_v3` / `handle_conditioned_forecast`) no longer reaches this function: those surfaces project from `ResolvedCFRuntime`'s composed primitive objects directly. The only surviving public-path callers are `daily_conversions` row annotation + latency bands and `surprise_gauge` (plus the v2 dev parity oracle, which is itself slated for retirement)."

The trajectory engine is the pre-substrate cohort-loop projector: builds per-particle `(p, μ, σ, onset)` draws from `ResolvedModelParams`, runs the v2-style cohort loop with Pop C / Pop D mass mixing, and returns `ForecastTrajectory` with `rate_draws`, `model_rate_draws`, `completeness_mean`, `completeness_unconditioned`, `pp_rate_unconditioned`.

Why it survives:

- **Surprise gauge** (doc 55) consumes its conditioned and unconditioned scalars (`completeness_*`, `pp_rate_unconditioned`) directly off the trajectory return.
- **Daily-conversions row annotation + latency bands** consume `compute_completeness_with_sd` and the trajectory's per-tau `rate_draws`.

Migrating these two surfaces onto the primitive runtime is the precondition for deleting the engine and its `XProvider` / `from_node_arrival` / `compose_timing_span_from_graph` plumbing. Tracked in `TODO.md` "73n follow-up".

Until then, `forecast_state.py` retains:

- `XProvider` and `build_x_provider_from_graph` — pre-substrate carrier representation.
- `NodeArrivalState` and `build_node_arrival_cache` — pre-substrate per-node arrival cache (used by surprise gauge per-node lookups).
- `CohortEvidence` and `compute_forecast_trajectory` — the engine itself.
- `compute_completeness_with_sd` — completeness with posterior uncertainty (200 MC draws), still called by daily-conversions row annotation.

The audit's M-1 (`try/except: pass` on `runtime.selected_y_prefix = y_prefix`) and L-1 (`/tmp/v3_forensic.json` writes) live partially in this file, partially in `cohort_forecast_v3.py`.

---

## What to do when a new analytic engine surfaces

Three rules:

1. **First check whether the substrate already produces what you need.** `ResolvedCFRuntime.composed_subject.span_p_draws` + `composed_carrier.cdf_draws` are the primitive-backed model surfaces. `_selected_cohort_group_rate_draws` is the mass-first reducer. If your analysis can read from these, do not start a new engine — wire into the substrate.
2. **Schema normalisation belongs at the snapshot-service perimeter.** Case-fork on `y`/`Y` is a perimeter bug. Don't replicate it in the engine.
3. **Missing values are NaN, not zero.** `np.cumprod` over a zero-substituted array silently renders a zero-conversion funnel; an array with NaN propagates correctly. The F-1 unification design specifies NaN at the reducer boundary.

The longer-term plan is one mass-first reducer with four input adapters. The shorter-term task is making sure no new analytic adds a fifth parallel implementation.

---

## Cross-references

- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — full audit findings (H-2, H-3, M-7, M-8, L-3) concentrated in these engines.
- [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) — the canonical mass-first reducer in detail.
- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) — the substrate they should be migrating onto.
- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58 — the structural pattern (forking by case instead of degenerating one path) behind the parallel implementations.
- [INVARIANTS.md](INVARIANTS.md) I-45 — "one resolution path; cases differ by degeneration, not branching" — the rule unification targets.
- [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md) — the directory umbrella for `lib/runner/`.
