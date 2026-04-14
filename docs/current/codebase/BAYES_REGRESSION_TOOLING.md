# Bayes Regression Tooling

**Last updated**: 14-Apr-26

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

## Running synth graphs manually

When testing synth graphs outside the full regression pipeline, three rules apply:

1. **Always use `param_recovery.py`, not `test_harness.py` directly.** Synth graphs have `.truth.yaml` sidecars containing ground-truth parameters. `param_recovery.py` wraps the harness and compares posteriors against truth — it produces recovery z-scores, absolute errors, and per-edge comparison tables. Running `test_harness.py` directly discards the ground-truth comparison, which is the entire point of using synth graphs.

2. **Run one graph at a time.** JAX parallelises gradient evaluations across all available CPU cores internally (see §JAX backend below). Running multiple graphs concurrently causes them to contend for cores, slowing both down. Use `--timeout 0` for exploratory runs on heavy contexted graphs where sampling time is unpredictable.

3. **Use `python3 -u` for background runs.** Python buffers stdout when piped to a file. Without `-u`, no output appears until the process exits — making long-running background runs appear frozen. Always use unbuffered mode.

Example (single graph, no timeout):

```bash
. graph-editor/venv/bin/activate
python3 bayes/param_recovery.py \
  --graph synth-diamond-context \
  --tune 1000 --draws 1000 --chains 2 --timeout 0
```

The winning formula flags (`latency_reparam`, `centred_latency_slices`,
`centred_p_slices`) are all `True` by default since 14-Apr-26. No
`--feature` flags needed unless disabling them.

### Running a full regression

```bash
. graph-editor/venv/bin/activate
python3 -u bayes/run_regression.py --max-parallel 1 --tune 2000 --draws 2000
```

Key points:
- **`--max-parallel 1`** is required — JAX fans out across all CPU cores per graph.
- **`python3 -u`** for unbuffered output (see rule 3 above).
- **Do not use `--no-timeout`** — truth files have per-graph timeouts (updated 14-Apr-26). The stall detector catches stuck chains before timeout.
- **Incremental summary**: written to `/tmp/bayes_regression-{run_id}.summary` after each graph. Monitor with `tail -f`.
- **Per-graph harness logs**: `/tmp/bayes_harness-{graph}-{run_id}.log` — full diagnostic output for every run.
- **Editing truth files triggers STALE**: changing `expected_sample_seconds` or any other field in `.truth.yaml` causes all affected graphs to re-bootstrap (re-insert synth data into DB). This adds time but is harmless.

### Truth file timeouts (updated 14-Apr-26)

`expected_sample_seconds` in each `.truth.yaml` controls the hard
timeout for that graph. Values were updated for 2000/2000 runs:

| Category | Timeout | Graphs |
|----------|---------|--------|
| Heavy contexted | 2700s (45 min) | diamond-context, lattice-context, join-branch-context |
| Medium contexted | 1800s (30 min) | 3way-join-context, fanout-context, skip-context, mirror-4step-context, simple-abc-context, context-solo, context-solo-mixed |
| Uncontexted | 900s (15 min) | all `-test` graphs, mirror-4step, drift*, simple-abc, forecast-test |

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

### Winning formula defaults (14-Apr-26)

Three feature flags that together produce the best sampling geometry
for contexted graphs now default to `True`:

| Flag | Default | What it does |
|------|---------|-------------|
| `latency_reparam` | `True` | (m, a, r) quantile reparameterisation — decorrelates onset-mu-sigma ridge (doc 34 §11.8) |
| `centred_latency_slices` | `True` | Centred parameterisation for per-slice latency — 20x P1 speedup with strong data (§11.9) |
| `centred_p_slices` | `True` | Centred parameterisation for per-slice probability — fixes tau_slice ESS bottleneck (§11.11) |

No `--feature` flags needed for normal runs. To disable:
`--feature latency_reparam=false` etc.

### Chain stall detection and retry (14-Apr-26)

Heavy contexted graphs (diamond-context, lattice-context) stochastically
hit bad posterior regions where one NUTS chain's draw rate collapses
while others continue normally. This is geometry, not compute — the
same graph succeeds on re-run with a fresh seed.

**Detection** (`ChainStallDetector` in `compiler/inference.py`):
- Tracks per-chain velocity via exponentially weighted moving average (EMA)
- Each chain's peak EMA establishes its "cruising speed"
- A chain enters the **stall zone** when its EMA drops below 10% of peak
- A chain exits the stall zone only when EMA recovers above 30% of peak (hysteresis — small wobbles within the crawl don't count as recovery)
- After 30s in the stall zone without recovery → `ChainStallError` raised
- Stalls are not detected during warmup (before chains reach 5 draws/s cruising speed)

**Retry** (`worker.py`):
- `run_inference` calls are wrapped in a retry loop (max 3 attempts by default)
- On `ChainStallError`, the run is aborted and restarted with a fresh random seed
- After 3 consecutive stalls, `RuntimeError` propagates — the graph is marked FAILED
- Both Phase 1 and Phase 2 have independent retry loops

**Per-chain progress template**: the nutpie Jinja2 template
(`_NUTPIE_PROGRESS_TEMPLATE`) emits per-chain `finished_draws` every
500ms. The stall detector consumes this in `_throttled_on_progress`.

**Test coverage**: `bayes/tests/test_stall_detector.py` — 12 tests
covering healthy runs, stall detection, grace period, hysteresis,
warmup suppression, and edge cases. All use synthetic draw sequences
with controlled timing — no MCMC needed.

**Observed stall patterns** (14-Apr-26 regression):
- `synth-diamond-context`: Phase 1 completes fine, Phase 2 stalls at ~5% (600/12000 draws) on all 3 attempts. Different chains each time.
- `synth-lattice-context`: Phase 1 stalls at varying points (3%, 98%, 6%). One attempt was 168 draws from finishing when the chain died.
- All other contexted graphs (3way-join, join-branch, skip, mirror-4step, fanout, simple-abc) completed without stalls.

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
