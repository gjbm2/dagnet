# Doc 34a — Reparam Regression Baseline (Config A)

**Date**: 14-Apr-26
**Run ID**: r1776128112
**Config**: baseline (no `latency_reparam` flag)
**Sampling**: 4 chains, 2000 draws, 2000 tune, JAX backend, max-parallel 1

---

## Uncontexted graphs (12/12 PASS)

```
Graph                            Time    rhat    ESS      conv%
─────────────────────────────── ────── ─────── ──────── ──────
synth-simple-abc                 220s   1.002   12131    100%
synth-mirror-4step               109s   1.002    9477    100%
synth-drift3d10d                  88s   1.002   11106    100%
synth-drift10d10d                102s   1.003   11326    100%
synth-forecast-test              248s   1.003    2166    100%
synth-skip-test                   82s   1.002    3780    100%
synth-fanout-test                119s   1.002    1440    100%
synth-join-branch-test           125s   1.002    3031    100%
synth-3way-join-test             124s   1.002    3229    100%
synth-diamond-test              9113s   1.002    7452    100%
synth-lattice-test               160s   1.002    1962    100%
synth-simple-abc-context         823s   1.008     751    100%
```

All PASS. synth-diamond-test is an outlier at 2.5 hours.
synth-simple-abc-context passes because its onset offsets are
small enough to fall within absolute tolerance.

## Contexted graphs (0/9 PASS — all FAIL)

```
Graph                            Time    rhat    ESS      conv%
─────────────────────────────── ────── ─────── ──────── ──────
synth-mirror-4step-context       313s   1.011     434    100%
synth-fanout-context             398s   1.041     129     87%
synth-context-solo-mixed         179s   1.008     589    100%
synth-context-solo               261s   1.015     325     94%
synth-skip-context              1272s   1.005     997    100%
synth-join-branch-context       2120s   1.009     560    100%
synth-3way-join-context         2492s   1.009     391     99%
synth-diamond-context           3117s   1.008     673    100%
synth-lattice-context           3739s   1.026     251     98%
```

All FAIL. Convergence is healthy (rhat < 1.05, most < 1.02).
The failures are all from the same root cause: **per-slice onset
pinned to edge value**.

## Failure pattern (contexted graphs)

Every contexted graph fails because per-slice onset is shared at
edge level. Slices with different true onset get z-scores of 20–31:

- `onset truth=0.800 post=0.990±0.010 z=19–21` (google slices)
- `onset truth=1.300 post=0.990±0.010 z=29–31` (email slices)
- `onset truth=1.000 post=1.000±0.010 z=0–1` (direct slices — match edge)

The model structurally cannot express per-slice onset variation.
This is the baseline weakness that the (m, a, r) reparameterisation
addresses.

Secondary failures on some graphs: email-slice p recovery (z=3.2–4.2)
and mu recovery (z=7–8) on edges where the onset pinning distorts
the latency fit.

## Summary

- **Uncontexted**: solid. 12/12 PASS, good convergence, good ESS.
- **Contexted**: 0/9 PASS, all due to pinned onset. Convergence
  itself is fine — the model converges to the wrong answer because
  onset can't vary per slice.
- **Performance**: synth-diamond-test (9113s) and the larger
  contexted graphs (1200–3700s) are slow. Better geometry from
  the reparam may help.

---

## Config B: reparam, 2 per-slice latency RVs (m + r offsets)

**Run ID**: r1776153333
**Result**: 0/21 completed. All failed instantly.

```
ERROR: --feature value must be true/false, got: 2
```

The harness feature flag parser rejects non-boolean values.
`latency_reparam_slices=2` was passed as a string "2" which
the harness does not accept. **No MCMC data produced.**

---

## Config C: reparam, 1 per-slice latency RV (m offset only)

**Run ID**: r1776153344
**Result**: 2/21 completed, 1 partial, 18 failed instantly.

`latency_reparam_slices=1` was parsed as truthy (Python treats
`int("1")` as boolean-like), so the harness accepted it. The
model activated per-slice **(m)** offsets — 1 latency RV per
slice. Graphs ran largest-first; only the first 2–3 completed
before the run was killed.

```
Graph                            Time    rhat    ESS      conv%   Result
─────────────────────────────── ────── ─────── ──────── ────── ──────
synth-lattice-context           5268s   1.039     145     89%   (*)
synth-lattice-test               190s   1.003    3067    100%
synth-3way-join-context         1705s   —         —       —     killed
```

(*) Compare to baseline: synth-lattice-context was 3739s,
rhat=1.026, ESS=251, conv=98%. The reparam was **slower** (5268s
vs 3739s) with **worse convergence** (ESS 145 vs 251, rhat 1.039
vs 1.026). This is consistent with the contexted geometry problem
documented in doc 34 §11.11 — the per-slice hierarchy introduces
new identification difficulties that offset the geometry benefit.

synth-lattice-test (uncontexted) improved slightly: 190s vs 160s
baseline, ESS 3067 vs 1962 — better ESS, comparable speed.

---

## Regression run post-mortem

The regression script (`run-reparam-regression.sh`) called
`run_regression.py` three times sequentially. Several issues:

1. **Feature flag type mismatch**: the harness only accepts
   boolean feature values. `latency_reparam_slices=2` was
   rejected; `=1` was accepted by accident (truthy). This
   killed all of config B and most of config C.

2. **Log loss**: config A's raw harness logs were mostly lost.
   Only 3 of 42 logs survive. The summary was extracted while
   logs existed and is preserved above. Root cause under
   investigation — likely the non-run-id symlink logs were
   overwritten by later configs.

3. **Audit path mismatch**: `run_regression.py`'s audit looked
   for `bayes_harness-{graph}-{run_id}.log` but the harness
   (via `--fe-payload`) writes to
   `bayes_harness-graph-{graph}-{run_id}.log`. This caused the
   audit to report "NO LOG FOUND" for all graphs, masking the
   actual results.

4. **No incremental summary**: `run_regression.py` holds all
   results in memory and writes a summary only at the end. A
   killed run produces no summary even though per-graph data
   exists on disk.

These tooling issues are tracked in doc 34 §11.10 item 6.
