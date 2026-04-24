# BE Topo Pass — Known Issues

**Date**: 17-Apr-26
**Status**: Historical — superseded by BE topo removal (see [project-bayes/73](project-bayes/73-be-topo-removal-and-forecast-state-separation-plan.md)). The quick BE topo pass was retired on `24-Apr-26`; the defects below no longer apply to the live runtime. Retained for context on the decisions that led to the retirement.

## Fixed: Dead slow-path branching (P0)

The `Promise.race` branching in `fetchDataService.ts` had a logic
error where the timeout sentinel was converted to `null` before the
three-way branch, making the slow path unreachable. When the BE took
> 500ms, results were silently discarded and FE analytic blend values
used instead. Session log showed 271 starts / 104 completions — 62%
silent FE fallback.

**Fix**: branch on `beResolvedFast` flag (which correctly distinguishes
timeout from BE-resolved-with-null) rather than on the nullity of
`beEntries`. Added session log entries for the FE-only fallback path.

## Open: `_sweep_max_tau` / resolved latency mismatch

In `api_handlers.py:handle_stats_topo_pass`, the forecast sweep's
`_sweep_max_tau` is sized from the current stats engine's `ev.t95`,
but the CDF is built from `resolved.latency` (which may come from a
different source — bayesian, stale analytic, etc.). When the resolved
latency has a larger effective t95 than the engine's, the CDF hasn't
converged at the horizon, producing a rate 2–15% lower than the true
posterior mean.

**Fix direction**: `_sweep_max_tau` should use `max(resolved_t95,
engine_t95)` to ensure convergence regardless of source.

## Open: FE / BE source preference inversion

FE `resolveActiveModelVars` prefers `analytic` over `analytic_be`
(crossover comment: "FE analytic is the trusted default"). BE
`_resolve_promoted_source` in `model_resolver.py` prefers `analytic_be`
over `analytic`. When no bayesian source is available, FE and BE
select different entries — producing different latency parameters and
potentially different probability values downstream.

**Fix direction**: align the preference order. The comment in the FE
says "Switch this to prefer analytic_be when parity is confirmed" — if
parity is now sufficient, flip the FE order.

## Open: async serialisation gap in beTopoPassService.ts

`runBeTopoPass` has `await forecastingSettingsService
.getForecastingModelSettings()` (line 192) between receiving the graph
reference and `JSON.stringify` (line 237). During this microtask yield,
if other async code mutates `finalGraph.edges[].p`, the serialised
graph could be inconsistent.

**Fix direction**: snapshot the graph before the await, or move the
settings fetch before the function call.

## Open: no stale-response guard for concurrent fetches

There is no fetch-generation counter or cancellation token in the topo
pass section of fetchDataService.ts. If a new fetch cycle starts while
the previous one's BE request is in-flight, the old BE response could
overwrite newer results when it arrives.

**Fix direction**: add a generation counter incremented at fetch start;
check it before `applyEdgeValues` in both fast and slow paths.
