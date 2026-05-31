# CF Perimeter De-Fattening And Dead-Path Removal Proposal

**Date:** 31-May-26
**Status:** Proposal — companion to [MASTER-PLAN-cf-spine-detachment-and-analysis-standardisation.md](MASTER-PLAN-cf-spine-detachment-and-analysis-standardisation.md)
**Owns:** Master plan **Stage 9 — Perimeter De-Fattening And Dead-Path Removal** (the detailed item ledger and sequencing).
**Provenance:** Produced from a full, documentation-blind read of the back-end forecast-production code (`graph-editor/api/python-api.py` + `graph-editor/lib/**`, ~42k LOC) on 31-May-26. Every item below was confirmed against the live tree on that date.

## 1. Purpose

The master plan detaches the **numerical spine** (the `ResolvedCFRuntime` / `CFProjectionBundle` / reducer triple) out of `cohort_forecast_v3.py` and standardises the analyse dispatch. This proposal is the companion that catalogues the **structural, perimeter, and dead-path** cleanup the architecture read surfaced — the work the spine migration makes safe to do, but which the master plan's Stages 0–8 do not itemise.

It changes **no numerics and no invariants**. Nothing here touches conditioning, composition, evidence admission, clocking, or the bundle algebra. Every item is one of: deleting a path that already has no production caller, moving statistics or render out of the perimeter into a reducer/engine boundary, removing a hidden parameter channel, or retiring a shim the repo's own no-shims rule already forbids.

## 2. Relationship to the master plan and its principles

This proposal is subordinate to the master plan and respects its design principles verbatim:

- **One runtime object** owns conditioning/composition/projection. Nothing here adds a second.
- **Cases differ by degeneration, not fork.** No item reintroduces a mode branch.
- **Reducers MAY own display/accounting; the engine MUST NOT own statistical semantics.** This proposal uses that exact line as its test: render that lives in a *reducer* is allowed and is **not** flagged; render that lives in the *runtime/compute* layer or in the *HTTP handler* is flagged, because neither is a reducer.
- **No fallbacks in the engine; defense at the perimeter.** Items that remove engine-internal repair/clamps are deferred to the existing [cf-defensive-coding-audit.md](cf-defensive-coding-audit.md), which already owns them. This proposal does not duplicate that audit.

Where an item maps onto an existing stage, it is routed there rather than duplicated. Stage 9 owns only the cross-cutting remainder.

## 3. Explicit scope boundary (what this is NOT)

- **Not** a re-derivation of the span/bucket/clocking mathematics — that is owned by the evidence-discretisation, bucket-transition, and phase-6 contract docs.
- **Not** the predictive-dispersion / kappa work ([fc-kappa-predictive-dispersion-proposal-26-May-26.md](fc-kappa-predictive-dispersion-proposal-26-May-26.md)).
- **Not** the evidence-admission unification ([single-evidence-admission-binding-plan-29-May-26.md](single-evidence-admission-binding-plan-29-May-26.md), [cf-context-mece-evidence-admission-fix-plan-26-May-26.md](cf-context-mece-evidence-admission-fix-plan-26-May-26.md)).
- **Not** the engine-fallback/clamp removal ([cf-defensive-coding-audit.md](cf-defensive-coding-audit.md)).
- **Not** a wholesale god-module split beyond the v3 extraction the master plan already scopes (see §4 Group G — explicitly deferred).

## 4. The cleanup ledger

Severity reflects structural risk (a live inverted dependency is HIGH; an unreferenced dead constant is LOW), not effort. "Stage" is the master-plan stage that should carry the item.

### Group A — Dead-path deletion (safe now; no spine dependency)

These have **zero production callers** on the live tree (verified 31-May-26). They are pure deletions and can land independently of Stage 5.

| ID | Item | Location | Note | Stage |
|----|------|----------|------|-------|
| A1 | `span_adapter.py` — entire module dead | `graph-editor/lib/runner/span_adapter.py` | `span_kernel_to_edge_params` was inlined into `forecast_runtime.py:1025`; the only remaining reference is the comment `forecast_runtime.py:1021` ("ex span_adapter.py"). No production import. ~160 LOC. | 9 |
| A2 | `predicates.py` — entire module dead | `graph-editor/lib/runner/predicates.py` | `analyzer.py:20` states "not used"; analysis-type matching uses `compute_predicates_from_dsl`. ~250 LOC. | 9 |
| A3 | Dead second path-probability engine | `path_runner.py:151` `_calculate_path_probability_state_space` | Fully implemented, zero call sites; the live path deliberately refuses it (`path_runner.py:451`). `_effective_edge_probability` (`path_runner.py:101`) is reachable **only** from this dead function — delete both together. | 9 |
| A4 | `confidence_bands.py` — dead band system | `graph-editor/lib/runner/confidence_bands.py` | `compute_confidence_band` has no production caller; the live band system is `epistemic_bands.RateBand`. Carries a vestigial `MC_SAMPLES = 1000` (`:36`) and a "legacy callers" comment. | 9 |
| A5 | `span_operator_supply.py` — dead module | `graph-editor/lib/runner/span_operator_supply.py` | No production importer. | 9 |
| A6 | `compute_cohort_maturity_rows_v3` is test-only + a stale docstring | `cohort_forecast_v3.py:2404` | Now a thin `build_cf_projection_bundle` + `reduce_cohort_maturity_rows` wrapper called **only by tests**. The handler docstring at `api_handlers.py:878` still claims `_handle_cohort_maturity_v3` "calls compute_cohort_maturity_rows_v3" — it does not (it calls `reduce_cohort_maturity_rows` via `reducer_for`). Master-plan Stage 5 already lists this wrapper for "thin import wrapper or disappear"; this item adds the stale-docstring fix and the test-coupling note. | 5 (wrapper) / 9 (docstring) |

**Guardrail for Group A:** before each deletion, repeat the repo-wide live-caller search (excluding `tests/` and comments) at deletion time, not just at proposal time. A dead module is only safe to delete if a test does not import it as a parity oracle; A6's wrapper is the one case where a test dependency exists, so it follows Stage 5's repoint-then-delete order rather than a blind delete.

### Group B — Inverted dependency arrows (the load-bearing structural smell)

| ID | Item | Location | Why it deviates / clean target | Stage |
|----|------|----------|-------------------------------|-------|
| B1 | An engine runner reaches **up** into an HTTP handler | `runners.py:1488` `from api_handlers import handle_conditioned_forecast` | `run_conversion_funnel` calls the L1 request handler from inside the analyse engine — the worst layering inversion in the back end. The clean target is the master plan's own Stage 6/7 outcome: the conditioned-forecast scalar pipeline exposed as a shared reducer/client the funnel calls, instead of the funnel invoking the endpoint handler. This is the concrete reason Stage 7's "decide funnel integration" matters structurally, not just aesthetically. | 7 |
| B2 | The "prepare" boundary is the direct DB caller | `forecast_preparation.prepare_forecast_subject_entry` → `snapshot_service.query_snapshots_for_sweep` | Compute (L2) calls persistence (L7) with no repository seam. This is acknowledged elsewhere and is lower priority than B1; recorded so Stage 5/6 can decide whether the neutral spine takes an injected fetcher (it already threads `upstream_observation_fetcher`, so the seam half-exists) rather than importing `snapshot_service` directly. | 6 |

### Group C — Statistics and render in the perimeter handler

The master plan's Stage 6 stop condition is: "adding a forecast-backed analysis type means registering a reducer, not adding a bespoke handler with local preparation and projection logic." These are the specific bespoke-handler bodies that block that condition.

| ID | Item | Location | Clean target | Stage |
|----|------|----------|-------------|-------|
| C1 | The whole surprise statistic lives in the handler | `api_handlers.py:130` `_compute_surprise_gauge` (`norm_cdf`, zone classification, two-distribution combined-spread z-score) | Stage 3 already moved `surprise_gauge` off the trajectory engine; this finishes the job by making it the **diagnostic scalar reducer** Stage 6 describes, registered through `reducer_for`, not a handler function computing the z-score. | 6 |
| C2 | Forecast-tail synthesis maths in the handler | `api_handlers.py:1772` `_append_synthetic_frames_impl` (lognormal inverse-CDF sizing, per-day completeness, `projected_y`/`forecast_y`) | A display surface the **tau reducer** (or a post-reducer display step) should own, per the "reducers may own display" rule. Today it is perimeter code re-deriving completeness from `(mu,sigma,onset)` independently of `lag_fit_derivation`, so the two completeness constructions can diverge. | 6 |
| C3 | Multi-scenario chart-axis reduction + pad-out in the handler | `api_handlers.py:1134` (`chart_axis_tau_combined`, last-row replay, per-tau coverage recompute) | Display/accounting — allowed in a reducer, not in the handler. Move into the tau reducer or a thin display-composition step the handler merely calls. | 6 |

### Group D — Settings as a hidden parameter channel

| ID | Item | Location | Why it deviates / clean target | Stage |
|----|------|----------|-------------------------------|-------|
| D1 | `mc_draws` is ambient, not a parameter | `forecasting_settings.py` `ContextVar` read via `current_settings().mc_draws` / `current_mc_draws()` across `primitives`, `primitive_conditioning`, `forecast_runtime`, `funnel_engine`, `request_envelope`, `cohort_forecast_v3` | The draw count `S` never appears in any `prepare_*` / `build_*` signature; correctness of every MC site depends on the handler having bound the context. The conditioned-forecast handler must wrap **both** preparation and bundle build in a nested `use_request_settings` to stop the envelope plan and the bundle disagreeing on `S` ("broadcast collapse", `api_handlers.py:1535` comment). The clean target is to thread an explicit `num_draws` through the `cf_analysis` bundle-build boundary so the scalar callsite's reduced-draw policy is a parameter, not a context override. This directly subsumes the master plan's Stage 1 "scalar-callsite draw-count/performance cleanup" tail. | 5 / 6 |
| D2 | A hard-coded default that can disagree with the dataclass | `primitives.py:76` `DEFAULT_DRAW_COUNT = 1000` | A second source of truth for `mc_draws`'s default; remove once D1 makes draws explicit. | 9 |
| D3 | Cache-bypass is the same anti-pattern on the persistence side | `result_cache.py` `_bypass_var` | Recorded for symmetry; lower priority than D1. The `no_cache` request flag reaches every registered cache through a global. | 9 |

### Group E — Render / diagnostics inside the runtime/compute layer (not a reducer)

Flagged **only** where render lives below the reducer line. Reducer-owned display (`_project_runtime_rows` emitting `model_curve_*`, `_public_uk_date`) is **allowed by the plan and is not listed here.**

| ID | Item | Location | Clean target | Stage |
|----|------|----------|-------------|-------|
| E1 | A ~130-line forensic UI dict inside a compute module | `forecast_runtime.py:456` `serialise_runtime_bundle` (`horizon_status='inadequate'/'saturated'`, 6dp rounding, an embedded prose note) | Move to a diagnostics boundary the reducer/handler calls under `--diag`, so `forecast_runtime` stays compute-only. | 8 |
| E2 | Per-day raw/bound display buckets built every request | `model_span_spine.py` `_summarise_empirical_span` / `_summarise_density_trace` | Same: diagnostics behind the `_diagnostics` flag, not unconditional work in the spine. | 8 |

### Group F — Shims and vestigial code (violate the repo's stated no-shims rule)

| ID | Item | Location | Stage |
|----|------|----------|-------|
| F1 | Hard-`False` no-op gates and an `if False:` block | `forecast_runtime` (`should_use_anchor_relative_subject_cdf`, `should_enable_direct_cohort_p_conditioning`, the dead epistemic block, the documented no-op `include_epistemic_overlay` kwarg) | 9 |
| F2 | A symbol re-exported purely so a test's `monkeypatch.setattr` resolves | `forecast_runtime` `read_edge_cohort_params` re-export | 9 |
| F3 | Overdue dated-deletion shim | `msmdc.py:348` "Target deletion: After 2 weeks of production validation" (with sibling test files at `lib/algorithms/test_*.py`) | 9 |
| F4 | "DO NOT call from production" helper used as a production fallback | `snapshot_service.short_core_hash_from_canonical_signature`, fallen back to in `append_snapshots` | 9 |
| F5 | Global mutable correctness toggle | `bucket_transition.py:165` `_FORCE_ENDPOINT_READS_FOR_SENSITIVITY` ("PRODUCTION MUST KEEP THIS FALSE") — silently changes bucket-mass reads for all callers | 9 |
| F6 | Vestigial params/fields never read | `EdgeFetchEnvelope.role`, `SpanReadout.root_supports`, `run_conversion_funnel(from_node, to_node)`, `ResolvedModelParams.alpha_beta_query_scoped` (hardcoded False), `connection_capabilities.supports_native_exclude(connection_name)` | 9 |
| F7 | Stale in-code line cites and ~50 lines of commented-out "AP58 violation" source | `api_handlers.py:2251` cites ~3822 (file is 3637); `model_span_spine.py:2055`/`:2228` | 8 |

### Group G — God-module split beyond v3 (deferred, recorded only)

The master plan's Stage 5 splits `cohort_forecast_v3.py` (2848 LOC). The same read found four more god modules: `api_handlers.py` (3637), `snapshot_service.py` (2679), `model_span_spine.py` (2416), `runners.py` (2139), plus `timing_span.py` (1226) fusing the `TimingSpan` API with a generic `SpanDPTrace` DP core. **These are explicitly out of scope for this proposal** — splitting them now would collide with Stage 5 and inflate review risk. They are recorded here so a future plan can pick them up, with `timing_span` → API + DP-core as the single highest-value follow-on split.

## 5. Open question carried up to the master plan

`_compute_extent_for_scenario` / `_compose_subject_span_t95` (`api_handlers.py:705`/`:624`) compose a span kernel and take its t95 **in the handler** to size the engine horizon. The in-code comments frame this as deliberate "perimeter-owned render-calc policy," yet it is genuine engine arithmetic running above the engine boundary. This is contested by the code's own authorship and is **not** filed as a deviation here; it is surfaced as a decision for the master plan's Open Questions: is handler-side horizon sizing acceptable perimeter policy, or should `compute_extent` be an input the engine derives? Resolve it during Stage 6 rather than silently keeping the split.

## 6. Sequencing and priority

- **Do now, independent of the spine extraction:** Group A (dead-path deletion) and Group F (shims). These are the lowest-risk, highest-clarity wins and reduce the surface Stage 5 has to reason about.
- **Accompany Stage 5/6:** Group D (make draws explicit — folds the Stage 1 draw-count tail), Group C (relocate perimeter statistics/render into reducers as part of dispatch standardisation), B2.
- **At Stage 7:** B1 (the funnel inverted arrow is the structural payoff of the funnel-integration decision).
- **At Stage 8:** Group E (diagnostics out of the compute layer) and F7 (stale cites), alongside the doc rewrite.
- **Deferred:** Group G.

## 7. Acceptance criteria for Stage 9

- No module in `graph-editor/lib/runner/` is dead (zero non-test importers) without being deleted or explicitly retained with a dated reason.
- `mc_draws` (and the scalar-callsite reduced-draw policy) is passed as an explicit parameter through the `cf_analysis` bundle boundary; the nested `use_request_settings` broadcast-collapse workaround is removed.
- No statistics (`_compute_surprise_gauge` z-score) or forecast-tail/chart-axis maths remain in `api_handlers.py`; each is a registered reducer or a reducer-owned display step.
- No `if False:` blocks, hard-`False` capability gates, "DO NOT call from production" fallbacks, or overdue dated-deletion shims remain on the forecast path.
- All fixtures and oracles stay green with **bit-for-bit identical** numerical output — this proposal is structural only.
