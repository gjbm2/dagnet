# Bayes Regression Tooling

**Last updated**: 13-Apr-26

How the parameter recovery regression pipeline works: discovery,
bootstrap, parallel execution, multi-layered audit, and known
pitfalls.

---

## Tool chain

```
run_regression.py
  → discover_and_preflight()     # find synth graphs, check DB rows
  → bootstrap_graph()            # synth_gen.py --write-files (if needed)
  → _run_one_graph()             # parallel pool, one per graph
    → param_recovery.py --graph X --job-label X-{run_id}
      → test_harness.py --graph X --fe-payload --job-label X-{run_id}
        → fit_graph()            # in-process MCMC
        → writes /tmp/bayes_harness-{job_label}.log
      → reads harness log for inference diagnostics
      → prints recovery comparison to stdout
    → captured by run_regression.py
  → _audit_harness_log()         # multi-layered audit from log
  → assert_recovery()            # z-score + threshold checks
  → verbose report (layers 0-8 per graph)
```

---

## Multi-layered audit

The regression report checks **nine layers** per graph in verbose mode.
Every layer is printed for every graph — pass or fail. This prevents
the false-pass problem where a terse summary hides a broken layer.

### Verbose report format

```
── synth-simple-abc ── PASS ──
  0. DSL:            window(12-Dec-25:21-Mar-26);cohort(12-Dec-25:21-Mar-26)
     Subjects:       4 snapshot, 4 candidate regimes
  1. Completion:     complete
  2. Feature flags:  latency_dispersion=True, phase1_sampled
  3. Data binding:   OK — 2 snapshot, 0 fallback, 2 bound, 0 failed
  4. Priors:         OK — 2 edges with mu_prior
       80844ce8… mu_prior=2.300
       69320810… mu_prior=2.500
  5. kappa_lat:      OK — 2 edges
  6. Convergence:    rhat=1.003 ess=4800 converged=100%
  7. Recovery:       2 edges
       simple-a-to-b:
         ok p      truth=0.700  post=0.703±0.126  Δ=0.003  z=0.0
         ok mu     truth=2.300  post=2.304±0.045  Δ=0.004  z=0.1
         ok sigma  truth=0.500  post=0.517±0.004  Δ=0.017  z=4.3
         ok onset  truth=1.000  post=1.000±0.010  Δ=0.000  z=0.0
       simple-b-to-c:
         ok p      truth=0.600  post=0.600±0.132  Δ=0.000  z=0.0
         ...
  8. LOO-ELPD:       2 edges scored, ΔELPD=1106.5, worst_pareto_k=0.23
  ** WARN: simple-a-to-b sigma: |z|=4.25 > 3.0 but Δ=0.017 < 0.2 (abs floor pass)
```

### Layer reference

| # | Layer | What it checks | Pass/fail effect |
|---|-------|---------------|------------------|
| 0 | **DSL** | Pinned DSL, subject count, candidate regime count | Informational |
| 1 | **Completion** | `Status: complete` in harness log | Warning if incomplete |
| 2 | **Feature flags** | `latency_dispersion`, `phase1_sampled`, `phase2_sampled` | Informational |
| 3 | **Data binding** | `fallback_edges > 0` or `total_failed > 0` | **FAIL** |
| 4 | **Priors** | mu_prior per edge (deduplicated across phases) | Warning if zero |
| 5 | **kappa_lat** | `latency_dispersion=True` but 0 kappa_lat variables | **FAIL** |
| 6 | **Convergence** | rhat, ESS, converged % | **FAIL** (via assert_recovery thresholds) |
| 7 | **Recovery** | Full truth-vs-posterior table per edge: p, mu, sigma, onset with z-scores and absolute errors | **FAIL** if z > threshold AND Δ > abs_floor |
| 8 | **LOO-ELPD** | Edges scored, ΔELPD (Bayesian vs null), worst Pareto k | Warning if failed or Pareto k > 0.7 |

### Per-edge binding detail

Layer 3 includes per-edge binding rows showing the data pipeline:

```
ok a2bdb15c… PASS  source=snapshot  rows: raw=4752 regime=4752 final=4872
~~ 273f7315… WARN  source=snapshot  rows: raw=4752 regime=4752 final=4200
!! c41a7e20… FAIL  source=mixed     rows: raw=4752 regime=0    final=9998
```

- `ok` = pass, `~~` = warning, `!!` = failure
- `raw` = rows from snapshot DB query
- `regime` = rows after regime selection (doc 30)
- `final` = rows after evidence binding (may include engorged fallback)

### LOO-ELPD null model

The LOO null model comes from:
1. **Production graphs**: `analytic` or `analytic_be` model_vars on graph edges
2. **Synth graphs (fallback)**: evidence priors from param files (Beta prior mean for p, topology mu/sigma/onset)

When no baseline is available for an edge, ΔELPD is set to 0 (no
comparison) and a diagnostic is logged. This prevents the spurious
large-negative ΔELPD that occurs when comparing against a null of 0.

**Known gap**: synth graphs don't go through the FE analytic stats pass,
so their null model uses param file priors rather than analytic
point estimates. The evidence-prior fallback is reasonable but not
identical to the production LOO comparison. See doc 35 for the
per-slice reporting plan that addresses this for contexted graphs.

### Trajectory pointwise log-likelihood

`pm.Potential` (used for trajectory likelihoods) doesn't produce
`log_likelihood` entries in the ArviZ trace. To enable LOO scoring:

1. `model.py` stores per-interval logp terms as `pm.Deterministic(f"ll_traj_{obs_type}_{safe_id}", ...)`
2. `inference.py` moves these from `trace.posterior` to `trace.log_likelihood` post-sampling
3. `loo.py` matches `traj_window_` and `traj_cohort_` prefixes in `_EDGE_RE`

### Audit implementation

`_audit_harness_log()` in `run_regression.py` parses the harness log
file and extracts structured data for each layer. Tested by
`bayes/tests/test_regression_audit.py` (20 blind tests against
synthetic harness logs).

---

## Key flags

| Flag | Tool | Purpose |
|------|------|---------|
| `--feature KEY=VALUE` | All three | Model feature flag (e.g. `latency_dispersion=true`). Forwarded through the full chain. `jax_backend` defaults to `true` since 13-Apr-26 — no flag needed. |
| `--clean` | All three | Clear `__pycache__` dirs under `bayes/` and `graph-editor/lib/`. Prevents stale bytecode from masking source edits. Does NOT touch synth data or DB rows. |
| `--rebuild` | All three | Delete `.synth-meta.json` for the target graph, forcing `verify_synth_data` to re-check DB with fresh hashes. Heavy — triggers full DB re-insert of synth rows. Only needed after truth file or `synth_gen.py` changes. |
| `--no-timeout` | `run_regression.py` | Disable all timeout layers (subprocess, harness watchdog). Passes `--timeout 0` through the chain. Useful for large contexted graphs where sampling time is unpredictable. |
| `--exclude SUBSTR` | `run_regression.py` | Skip graphs whose name contains the substring. |
| `--job-label LABEL` | `param_recovery.py`, `test_harness.py` | Unique label for log + lock files. `run_regression.py` auto-generates `{graph}-r{timestamp}` to prevent parallel runs from colliding. |
| `--diag` | `param_recovery.py`, `test_harness.py` | Enable PPC calibration (doc 38). Computes coverage@90% per edge per category (endpoint/daily, trajectory). On synth graphs, also computes true PIT from ground-truth parameters for machinery validation. Sets `settings.run_calibration=true`. |
| `--dsl-override DSL` | `param_recovery.py`, `test_harness.py` | Override the graph's pinnedDSL before payload construction. Used for bare-on-contexted isolation tests. |

---

## Candidate regime fix (11-Apr-26)

`candidateRegimeService.ts` grouped exploded DSL slices by context
key-set only. When both `window(...)` and `cohort(...)` appear in the
DSL, they share the same (empty) context keys but produce different
`core_hash` values (because `cohort_mode` is part of the signature).
Only the first temporal mode's hash was emitted as a candidate regime.

Regime selection then dropped all DB rows that had the other mode's
hash, causing 100% fallback to param files. **All synth graphs** were
affected (all have dual-mode DSLs).

Fix: included temporal mode in the grouping key so both modes generate
separate candidate regimes.

---

## Per-slice reporting gap (doc 35)

The current report iterates layers 3-8 once per graph. For contexted
graphs with per-slice model variables, this hides per-slice binding
failures, recovery misses, and LOO gaps. Doc 35 specifies the
per-slice verbose reporting plan.

---

## Synth data gate

`test_harness.py` checks whether snapshot data exists in the DB
before running MCMC on synth graphs. If data is missing or stale,
it automatically bootstraps via `synth_gen.py --write-files`.

The gate runs after graph loading and before hash computation. It
uses `verify_synth_data()` from `synth_gen.py`, which checks both
the `.synth-meta.json` sidecar and actual DB row counts.

---

## Parallel safety

`run_regression.py` runs graphs in parallel via `ProcessPoolExecutor`.
Each graph gets a unique `job_label = {name}-r{timestamp}` to
prevent cross-contamination between:

- **Harness log files**: `/tmp/bayes_harness-{job_label}.log`
- **Lock files**: `/tmp/bayes-harness-{job_label}.lock`
- **Recovery logs**: `/tmp/bayes_recovery-{name}-{run_id}.log`

**Known remaining risk**: if two regression runs bootstrap the same
graph simultaneously, the DB writes (DELETE + INSERT) could
interleave. This is rare (bootstrap only runs when data is missing)
and would require a per-graph bootstrap lock to fix fully.

---

## Known pitfalls

### Stale Python bytecode

Python caches compiled `.pyc` files in `__pycache__/` dirs. When
source files change (e.g. `model.py`, `inference.py`), subprocesses
may load stale bytecode. Symptoms: feature flags appear in the model
diagnostics but the model behaviour doesn't match the source code.

Fix: `--clean` flag (bytecode only), or `sys.dont_write_bytecode = True`
(set in `test_harness.py`), or `PYTHONDONTWRITEBYTECODE=1` in env (set
by `param_recovery.py` and `run_regression.py`).

### Harness log name mismatch

The `--fe-payload` path in `test_harness.py` derives `graph_name`
from `payload.get("graph_id")`, which has a `graph-` prefix (e.g.
`graph-synth-simple-abc`). The harness log is written to
`/tmp/bayes_harness-graph-synth-simple-abc.log`. But
`param_recovery.py` originally looked for
`/tmp/bayes_harness-synth-simple-abc.log` (without prefix).

Fix: `param_recovery.py` now checks both `{job_label}`,
`graph-{job_label}`, `graph-{graph_name}`, and `{graph_name}`
variants.

### Inference diagnostics not in stdout

The harness `_print()` writes to both stdout and the log file. But
`param_recovery.py` captures stdout via `capture_output=True`. The
inference diagnostic lines (mu posteriors, kappa_lat) are in the
harness log file but may not appear in stdout if they're printed
during the worker thread's execution.

Fix: `param_recovery.py` supplements its captured stdout with the
harness log file content before parsing.

### `--clean` race in parallel

Multiple parallel `--clean` runs try to delete the same `__pycache__`
dirs simultaneously. `shutil.rmtree` can fail if another process
already deleted a file.

Fix: `try/except OSError: pass` around the rmtree call.

### `.synth-meta.json` staleness

After a hash computation code change, the `.synth-meta.json` may
claim data is fresh (truth SHA matches, row count > 0) but the DB
rows have wrong hashes. `verify_synth_data()` queries the DB with
the hashes from the meta, which are now wrong.

Fix: `--rebuild` deletes the `.synth-meta.json`, forcing
`verify_synth_data()` to recompute hashes from the graph JSON and
query the DB with the new (correct) hashes. Note: `--clean` does NOT
delete synth-meta — use `--rebuild` specifically for this case.

### JAX backend is the default (13-Apr-26)

nutpie's numba backend has super-linear compilation time with respect
to pytensor graph size. For contexted models with advanced indexing
(vector RV gathers across thousands of trajectory intervals), numba
compilation can exceed 500s on a 3-edge graph — making contexted Bayes
unusable.

The JAX backend (`SamplingConfig.jax_backend`, default `True` since
13-Apr-26) switches nutpie to JAX's XLA compiler, which handles
gather/scatter operations natively. Measured speedups: 11.6x on a
synthetic 42-dimensional model, and compilation drops from 500s+
(timeout) to ~5-13s on real contexted graphs.

The gradient backend is fixed to `'pytensor'` (not `'jax'`). JAX's
reverse-mode AD hits `0 × inf = NaN` on deep erfc/softplus chains in
join-node graphs. Pytensor computes symbolic gradients first (handling
numerical edge cases), then compiles both forward and gradient to JAX.
Same runtime performance, slightly longer compile, no NaN. See
anti-pattern 36.

No `--feature` flag is needed — JAX is the default. To disable:
`--feature jax_backend=false`. Implementation: `SamplingConfig` in
`compiler/types.py:541`, wired through `run_inference` →
`_sample_nutpie` → `nutpie.compile_pymc_model(model, backend='jax',
gradient_backend='pytensor')`. Requires `jax[cpu]` (in
`bayes/requirements.txt`).

JAX parallelises gradient evaluations across cores internally, so
`--max-parallel 1` is appropriate when using the JAX backend — each
graph already utilises all available cores.

### Timeout layers (12-Apr-26)

Three independent timeout mechanisms exist in the pipeline:

1. `test_harness.py` — inner watchdog loop, kills process when
   `elapsed > timeout_s` (line ~961)
2. `param_recovery.py` — `subprocess.run(timeout=args.timeout + 60)`
3. `run_regression.py` — `subprocess.run(timeout=timeout + 120)`

When `--timeout 0` is passed (via `--no-timeout` on
`run_regression.py`), all three layers disable: the watchdog skips the
check, and subprocess timeouts are set to `None`.

Per-graph timeouts are read from the truth file's `testing.timeout` or
`simulation.expected_sample_seconds` fields. These were set for numba
compilation; JAX runs may complete faster than the budget, but the
budget should not be relied upon for large or novel graphs.

### Debug artefact dump and Phase 2 replay (13-Apr-26)

When Phase 2 runs, the worker dumps artefacts to
`/tmp/bayes_debug-{graph_id}/` before attempting Phase 2 MCMC:

| File | Contents |
|------|----------|
| `phase2_frozen.json` | Frozen Phase 1 posteriors (per-edge p, mu, sigma, onset, per-slice) |
| `evidence.pkl` | Full bound evidence (pickle) |
| `topology.pkl` | Graph topology (pickle) |
| `settings.json` | Feature flags and settings |

These enable **offline Phase 2 debugging** without re-running the
expensive Phase 1 MCMC (~13 min for diamond-context). Load with:

```python
import pickle, json
with open("/tmp/bayes_debug-.../topology.pkl", "rb") as f:
    topo = pickle.load(f)
with open("/tmp/bayes_debug-.../evidence.pkl", "rb") as f:
    evidence = pickle.load(f)
with open("/tmp/bayes_debug-.../phase2_frozen.json") as f:
    frozen = json.load(f)
from compiler.model import build_model
model2, meta2 = build_model(topo, evidence, phase2_frozen=frozen)
```

The dump is wrapped in try/except — if it fails, a warning is logged
but Phase 2 model build proceeds.

### `--phase2-from-dump` flag (13-Apr-26)

Skips Phase 1 entirely and runs Phase 2 from a dump directory:

```bash
python bayes/param_recovery.py --graph synth-diamond-context \
  --phase2-from-dump /tmp/bayes_debug-graph-synth-diamond-context \
  --chains 2 --draws 500 --tune 1000 --timeout 0
```

This bypasses graph loading, CLI hash computation, synth data gate,
and pre-flight checks — goes straight to Phase 2 model build + MCMC.
Enables rapid iteration on Phase 2 issues.

Available on both `param_recovery.py` and `test_harness.py`.

### Phase 2 numba fallback (13-Apr-26)

When `jax_backend=true` and Phase 2 init fails, the worker
automatically retries Phase 2 with the numba backend. The numba
compile adds ~180s but the model samples correctly.

This fallback is now defence-in-depth only. The root cause (JAX
gradient NaN from `gradient_backend='jax'`) is fixed —
`gradient_backend` is now always `'pytensor'` (see anti-pattern 36).
The fallback remains in `worker.py:1167-1180` for robustness.

### Zero-latency (instant) edges in recovery (13-Apr-26)

Edges with truth `mu=0, sigma=0, onset=0` are instant conversions —
the model correctly creates no latency random variables for them.
The recovery audit in `run_regression.py` now skips mu/sigma/onset
comparison for these edges, reporting only p recovery. Previously
these caused false FAIL results ("missing parsed recovery param").

Affected graphs: `synth-fanout-test` (1 instant edge),
`synth-mirror-4step` (2 instant edges), `synth-forecast-test`
(1 instant edge).

### Missing: execution timing in recovery output

`param_recovery.py` does not surface per-phase timing breakdown
(compile time, Phase 1 sampling, Phase 2 sampling, model size).
The worker tracks this internally in the `timings` dict, and
`[nutpie-compile]` lines are printed to stdout, but the recovery
comparison summary shows only total wall time. This is a known gap
— performance comparisons between parameterisations require manually
reading the harness log or worker output.
