# Doc 19 — BE Stats Engine Bugs and Prior Discrepancies

**Status**: Open
**Date**: 23-Mar-26
**Purpose**: Document known discrepancies between the BE stats engine
(`graph-editor/lib/runner/stats_engine.py`), the FE stats pass
(`statisticalEnhancementService.ts`), and the topology builder
(`compiler/topology.py derive_latency_prior`).

---

## 1. Three-Way Prior Discrepancy

For the production graph `bayes-test-gm-rebuild`, edge `delegated-to-registered`
(7bb83fbf), three different computations produce three different priors:

| Source | mu | sigma | Notes |
|--------|-----|-------|-------|
| FE stats pass (on graph) | 1.867 | 0.369 | Written to graph edge by FE topo pass |
| BE stats engine | 1.157 | 0.800 | From `enhance_graph_latencies` |
| topology `derive_latency_prior` | 1.502 | 0.574 | From `derive_latency_prior(median, mean, onset)` |

Only `derive_latency_prior` (mu=1.502) produces convergent MCMC (rhat=1.006).
The other two cause rhat > 1.5.

### Input data (same for all three)

From the graph edge's latency block:
```
median_lag_days: 9.992
mean_lag_days: 10.798
onset_delta_days: 5.5
```

### What each computes

**topology derive_latency_prior**:
```
model_median = median - onset = 9.992 - 5.5 = 4.492
model_mean = mean - onset = 10.798 - 5.5 = 5.298
mu = log(model_median) = log(4.492) = 1.502
sigma = sqrt(2 * log(model_mean / model_median)) = sqrt(2 * log(1.179)) = 0.574
```
Simple moment-matching after onset subtraction.

**FE stats pass (what's on graph: mu=1.867, sigma=0.369)**:
Uses `computeEdgeLatencyStats` which calls `fitLagDistribution` then
`improveFitWithT95`. The improvement step uses the authoritative t95 to
constrain sigma. The exact inputs to the improvement step are unknown
from the output alone — the FE aggregates cohort data differently from
the param file scalars.

**BE stats engine (mu=1.157, sigma=0.800)**:
Uses `enhance_graph_latencies` with empty cohort data (no param_lookup
passed from the harness). Falls back to... unclear. The engine was called
without proper CohortData, so it may be using defaults or deriving from
the graph edge differently.

### Known bugs

1. **BE stats engine receives wrong/empty CohortData**: The harness
   constructs CohortData from param file daily arrays but the age
   calculation may be wrong. With empty cohort data, the engine falls
   back to a different code path that produces different results.

2. **FE improvement step not ported to topology**: `derive_latency_prior`
   does basic moment-matching but doesn't apply the t95 improvement
   (`improveFitWithT95`) that the FE applies. This is why the topology
   value differs from the FE value.

3. **onset subtraction inconsistency**: Need to verify all three paths
   subtract onset from median/mean in the same way before fitting.

---

## 2. Impact on Compiler

The compiler reads priors from the topology builder (via `et.mu_prior`,
`et.sigma_prior`). The topology uses `derive_latency_prior(median, mean, onset)`
which is a crude moment-match — not the full FE stats pipeline.

When the topology priority was changed to prefer mu/sigma from the graph
edge directly (the FE values), the production graph STOPPED converging.
When the BE stats engine values were used, it also didn't converge.
Only the topology's own crude `derive_latency_prior` gives convergence.

This suggests the model is sensitive to the prior in a way that needs
investigation. The posterior mu≈5.7 is far from ALL three priors (1.2-1.9),
meaning the data strongly disagrees with the prior regardless of which
prior source is used. The question is why `derive_latency_prior`'s sigma=0.574
allows convergence but the others don't.

---

## 3. Resolution Plan

### Immediate (blocking Bayes development)

1. **Fix CohortData construction in harness**: Ensure the BE stats engine
   receives correct cohort data (proper age calculation, all daily arrays).
2. **Add parity test**: Run BE stats engine and FE stats pass on the same
   input data, compare outputs field by field. Discrepancies are bugs.
3. **Validate onset subtraction**: All three paths must agree on whether
   and how to subtract onset before fitting.

### Medium-term

4. **Unify prior computation**: One code path for priors, used by both
   the topology builder and the model. Either port the full FE pipeline
   to Python (the BE stats engine) and make the topology use it, or
   simplify to a single well-tested function.
5. **Investigate model prior sensitivity**: Why does the production edge
   diverge so far from the prior? Is the evidence binding producing
   data that's inconsistent with the model, or is the prior genuinely
   wrong?

### References

- `graph-editor/lib/runner/stats_engine.py` — BE stats engine
- `graph-editor/src/services/statisticalEnhancementService.ts` — FE stats pass
- `bayes/compiler/topology.py` lines 112-137 — `derive_latency_prior`
- `docs/current/project-bayes/18-compiler-journal.md` — session log
