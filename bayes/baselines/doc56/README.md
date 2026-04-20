# doc 56 oracle baselines

Frozen reference outputs used by Phase 3 cut-over verification of the
runtime-boundary migration described in
[`docs/current/project-bayes/56-forecast-stack-residual-v1-v2-coupling.md`](../../../docs/current/project-bayes/56-forecast-stack-residual-v1-v2-coupling.md).

Phases 1-3 must preserve these outputs under the tolerance stack in
§11.1 of doc 56. Any intentional baseline re-capture is its own commit
with an explicit before/after delta in the message.

## Files

- `capture-metadata.json` — git SHAs, capture time, published tolerances.
- `cf-whole-graph.json` — per-edge `(p_mean, p_sd, completeness,
  completeness_sd, rate_draws_sha256)` from the CF whole-graph endpoint
  on each topology fixture (doc 50 §5.1). Edges keyed by
  `from_id->to_id` (stable across synth_gen regens — UUIDs are not).
- `v3-chart.json` — per-edge `last_row` (midpoint, fan bands,
  p_infinity, completeness) from the v3 chart handler on each fixture.
  Edges keyed by `from_id->to_id`.
- `daily-conversions.json` — rows from `daily_conversions` on
  synth-mirror-4step's terminal edge.
- `rng-gate.json` — sha256 of `compute_forecast_trajectory`'s
  `rate_draws` on the named RNG gate fixture (doc 56 §11.1).

## Edge identity

Edges are keyed by **node IDs** (e.g. `simple-a->simple-b`, not
UUIDs). Per doc 17 §2.3, `synth_gen` regenerates graph UUIDs on every
run; node IDs are the stable identity enforced by integrity check #9
("edge DSL queries use node IDs, not UUIDs"). Baselines keyed by UUID
break silently after any synth regeneration.

## Tolerance

| Layer | Tolerance |
|---|---|
| RNG gate (`rng-gate.json::rate_draws_sha256`) | byte-identical |
| Deterministic scalars (p_mean, completeness, tau_days) | `|Δ| ≤ 1e-10` |
| MC quantiles (fan bands, p_sd) | `|Δ| / value ≤ 2%` |

Existing harnesses (`cf-topology-suite.sh`, `cf-truth-parity.sh`,
`v2-v3-parity-test.sh`, `conditioned-forecast-parity-test.sh`) keep
their published tolerances unchanged and remain authoritative for
their own invariants.

## Regenerating

```
bash graph-ops/scripts/capture-doc56-baselines.sh
```

Requires the Python BE running on localhost:9000 and the data repo
graphs present. The script is deterministic — re-running produces
byte-identical output for the RNG hash and numerically stable output
for the other fields (the engine seeds `rng=np.random.default_rng(42)`
at every entry point).
