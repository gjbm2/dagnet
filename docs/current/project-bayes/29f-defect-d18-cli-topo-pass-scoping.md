# D18: CLI topo pass does not scope cohorts to query DSL

**Date**: 16-Apr-26
**Status**: **Fixed 16-Apr-26.** Full relative date support (`-30d`, `-2w`, `-1m`, open-ended ranges).
**Severity**: High — all CLI topo pass outputs (param-pack, analyse
--topo-pass, hydrate) condition on the wrong cohort population.
**Affects**: `completeness`, `completeness_stdev`, `blended_mean`
(`p.mean`), `p_sd` for every edge.

---

## Problem

The CLI `runCliTopoPass` (topoPass.ts:149) sends the full param file
as `cohort_data` to the BE topo pass. It does not parse the query DSL
to extract a cohort window, and does not build `edge_contexts` with
`scoped_cohorts`.

The BE topo pass handler (api_handlers.py:4849) prefers
`scoped_cohorts` when available for IS conditioning:

```python
cohorts_raw = (
    (_ec.scoped_cohorts if _ec and _ec.scoped_cohorts else None)
    or param_lookup.get(ev.edge_uuid, [])
)
```

Because the CLI never sends `edge_contexts`, the BE falls back to the
full `param_lookup` — all cohorts in the param file, regardless of DSL.

## Design intent

- **Model vars** (mu, sigma, p posterior, t95) are fitted on all
  relevantly available evidence — the full param file is correct.
  `cohort_data` should contain ALL cohorts.

- **IS conditioning** (completeness, blended_mean, p_sd) uses only
  the cohorts selected by the user's query DSL.
  `edge_contexts.scoped_cohorts` should contain DSL-windowed cohorts.

The FE browser path does this correctly: `beTopoPassService.ts` builds
both `cohortsAll` (line 89, unwindowed) and `cohortsScoped` (line 91,
windowed), sending the latter as `edge_contexts[edgeId].scoped_cohorts`.

## Impact

On synth-mirror-4step with `cohort(7-Mar-26:21-Mar-26)`:

| | Topo pass (CLI, broken) | Chart (correct) |
|---|---|---|
| Cohorts | 92 (full param file, 12-Dec-25 to 21-Mar-26) | 15 (DSL-windowed, 7-Mar to 21-Mar) |
| Aggregate evidence rate | 69.1% (1212/1754) | 38.5% (145/377) |
| `p.mean` / `midpoint` | 0.723 | 0.404 |

The topo pass reports a blended rate of 72% when the user's selected
cohorts have a 38.5% evidence rate. The chart correctly conditions on
the selected cohorts and shows 40%.

## Fix

`runCliTopoPass` needs to:

1. Accept the query DSL as a parameter
2. Parse the cohort/window date range from the DSL
3. Filter each edge's param data to cohorts within that date range
   → `scoped_cohorts`
4. Build `edge_contexts` per edge with `scoped_cohorts`
5. Send `edge_contexts` in the POST body alongside `cohort_data`

The FE's `beTopoPassService.ts` lines 55–175 provide the reference
implementation.

## Files touched

- `graph-editor/src/cli/topoPass.ts` — add queryDsl param, parse
  dates, build edge_contexts with scoped_cohorts
- `graph-editor/src/cli/commands/analyse.ts` — pass queryDsl to
  runCliTopoPass
- `graph-editor/src/cli/commands/paramPack.ts` — pass queryDsl
- `graph-editor/src/cli/commands/hydrate.ts` — pass queryDsl

## Verification

After fix, the chart-graph agreement test
(`graph-ops/scripts/chart-graph-agreement-test.sh`) assertion [B]
should show a much smaller delta. The remaining delta will be the
genuine codepath divergence (aggregate vs sequential IS), not
a scoping error.
