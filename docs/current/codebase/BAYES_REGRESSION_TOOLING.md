# Bayes Regression Tooling

**Last updated**: 22-Apr-26 (fixture-side sidecar contract/signposting clarified; raw patch replay via TS apply-patch)

How the parameter recovery regression pipeline works: discovery,
bootstrap, parallel execution, multi-layered audit, structured
results, and known pitfalls.

---

## Truth files

Canonical source: `bayes/truth/` in the dagnet repo. Every
`synth-*.truth.yaml` fully specifies a synthetic graph. Everything
else (graph JSON, DB rows, param files) is derived by `synth_gen.py`.

Discovery (`discover_synth_graphs`) scans `bayes/truth/` first, then
falls back to `DATA_REPO_DIR/graphs/` for any not yet migrated.
Generated artefacts are written to the data repo path.

A fresh deployment needs only: clone dagnet, configure
`.private-repos.conf` + DB connection, run a plan. Bootstrap handles
graph generation and DB population.

See doc 44 for the full graph inventory (53 truth files).

---

## Tool chain

```
regression_plans.py --plan <name>              # config-driven entry point
  → load_plan() + filter_graphs()              # JSON plan → graph selection
  → run_regression.py (per variant if A/B)
    → discover_and_preflight()                 # scan bayes/truth/, check DB
    → bootstrap_graph()                        # synth_gen.py --write-files
    → _run_one_graph()                         # parallel pool
      → param_recovery.py --graph X
        → test_harness.py --graph X --fe-payload
          → fit_graph()                        # in-process MCMC
          → writes /tmp/bayes_harness-{job_label}.log
    → _audit_harness_log()                     # parse harness log
    → assert_recovery()                        # structured failures
    → _write_structured_results()              # JSON via results_schema.py
  → write_results_json()                       # plan-level JSON envelope
```

---

## Investigation tracker (`bayes-tracker`)

Defect-isolation and diagnostic runs are tracked via the `bayes-tracker`
MCP server in `bayes/tracker/` (registered in `.mcp.json` at repo root).
It enforces the run-reason discipline — why this run exists, what it is
meant to prove, what it is not meant to prove — that markdown-only run
logs fail to enforce under agent impatience.

Structured source of truth: `docs/current/project-bayes/20-open-issues-register.tracker.yaml`.
Human-facing view: `docs/current/project-bayes/20-open-issues-register.md`
(marker-fenced regions are rewritten by the server's `render_register`
tool; narrative outside the markers is preserved).

Twelve tools, stdio transport. Five reads (`get_overview`,
`list_blockers`, `get_next_run`, `get_issue`, `get_run`) and seven writes
(`set_current_line`, `create_run`, `start_run`, `complete_run`,
`upsert_issue`, `link_run_and_issue`, `render_register`). The run
state machine is `planned → running → {blocked | answered | abandoned}`;
`complete_run` with `status="blocked"` requires a `blocker_category`
(§14 of doc 63) — blocked runs are first-class evidence that completion
work isn't done, not failures to hide.

**Workflow**: `get_overview` first to orient; `create_run` with required
reason fields before launch; `start_run` at launch; attach the returned
`tracker_run_id` to the regression run; `complete_run` on return;
`upsert_issue` + `render_register` to refresh the view.

**Runner-side enforcement is not live yet** (Phase 2 of doc 63). Until
then, the tracker is advisory: `run_regression.py` and
`regression_plans.py` do not refuse without a tracker id, and the
`tracker_run_id → result_json` link must be attached manually. When
Phase 2 lands, `BAYES_REQUIRE_TRACKER=1` (default for interactive
shells) will make the runners refuse without `--tracker-run-id`.

Full spec: `docs/current/project-bayes/63-investigation-tracker-mcp-spec.md`.
Agent-facing workflow and operations reference:
`docs/current/project-bayes/20-open-issues-register.md` (top of doc,
"How to use this register" + "Tracker operations reference").

---

## Running synth graphs manually

When testing synth graphs outside the full regression pipeline, three rules apply:

1. **Always use `param_recovery.py`, not `test_harness.py` directly.** Synth graphs have `.truth.yaml` sidecars containing ground-truth parameters. `param_recovery.py` wraps the harness and compares posteriors against truth — it produces recovery z-scores, absolute errors, and per-edge comparison tables. Running `test_harness.py` directly discards the ground-truth comparison, which is the entire point of using synth graphs.

2. **Concurrency cap is 2.** JAX parallelises gradient evaluations across all available CPU cores internally (see §JAX backend below). One graph already saturates the box; **two concurrent fits is the safe ceiling** — `bayes/run_regression.py` hard-caps `--max-parallel` at 2 for this reason. Going higher causes scheduler thrash and OOM. Use `--timeout 0` for exploratory runs on heavy contexted graphs where sampling time is unpredictable.

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

### Pytest fixture-side Bayes commissioning

The "always use `param_recovery.py`" rule above applies to **manual
investigation and recovery analysis**. Pytest synth fixtures are a
different case: they sometimes need a cached Bayes fit result so the
test loader can materialise the same posterior-bearing graph shape that
the FE would produce, without rewriting the shared synth graph on disk.
The sanctioned fixture path is the cached sidecar flow in
`graph-editor/lib/tests/conftest.py`.

`bayesian=True` is the only sanctioned pytest mode. It computes the
sidecar fingerprint from the synth truth YAML and the per-parameter YAML
files, then loads `bayes/fixtures/<graph>.bayes-vars.json` when the
stored fingerprint matches. If the sidecar is absent or stale, the
fixture runs `bayes/test_harness.py` once via the FE payload path with
`--sidecar-out` so the raw worker/apply-patch payload is written to the
sidecar rather than patched into the graph file.

The returned graph is then produced by replaying that cached payload
through the existing TS CLI `--apply-patch` path with
`--print-enriched-graph`, which applies the production
`bayesPatchService.applyPatch()` logic in memory and prints the enriched
graph JSON to stdout without writing any files back to disk. The synth
graph JSON on disk is never used as the storage location for Bayes
posteriors/model vars, and routine pytest loads must not rewrite it.

Two caching layers make the steady-state path cheap:

1. the sidecar file itself is keyed by the truth/parameter fingerprint,
   so fresh sidecars are reused across sessions;
2. `conftest.py` keeps a per-process `_SIDECAR_CACHE`, so repeated
   `load_graph_json(..., bayesian=True)` calls in one pytest session do
   not re-run MCMC for the same fingerprint.

There is intentionally no fixture-level "force fresh Bayes commission"
switch. If a human explicitly wants a new sidecar, do it as a separate
manual step outside the shared pytest loader. Do not widen
`load_graph_json()` or `requires_synth()` with a refit flag: that
defeats the sidecar's purpose, dirties checked-in fixture sidecars, and
makes routine synth tests pay the MCMC cost on every run.

If you touch this path, the signposts are:

- shared pytest entrypoint: `graph-editor/lib/tests/conftest.py`
- harness sidecar writer path: `bayes/test_harness.py --sidecar-out`
- contract tests: `graph-editor/lib/tests/test_bayes_sidecar_conftest.py`
  and `bayes/tests/test_test_harness_sidecar.py`

If you think you need a pytest-level "force refit" flag, stop. That is a
manual commissioning workflow, not a widening of the shared fixture API.

### Running a full regression

```bash
. graph-editor/venv/bin/activate
python3 -u bayes/run_regression.py --max-parallel 2 --tune 2000 --draws 2000
```

Key points:
- **`--max-parallel 2`** is the ceiling (hard-capped in `run_regression.py`). JAX fans out across CPU cores per graph, so two concurrent fits already saturate the box; `--max-parallel 1` is safer for heavy contexted graphs.
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

## Config-driven plans

`regression_plans.py` wraps `run_regression.py` with JSON plan files
in `bayes/plans/`. Plans define graph selection (glob patterns),
sampling, feature flags, worker settings, and optional variants for
A/B model comparison.

```bash
python bayes/regression_plans.py --list              # show available plans
python bayes/regression_plans.py --plan smoke         # quick sanity (3 graphs)
python bayes/regression_plans.py --plan overnight-full --max-parallel 2
python bayes/regression_plans.py --plan overnight-full --dry-run
python bayes/regression_plans.py --plan model-ab-latdisp  # A/B with variants
```

CLI flags (`--chains`, `--draws`, `--max-parallel`, etc.) override
plan values. `--dry-run` shows what would run without MCMC.

Variants run the same graphs multiple times with different features
or settings, producing a cross-variant comparison table.

Plan discovery scans `bayes/plans/` (built-in) plus any directory
passed via `--plan-dir`. See doc 44 for the full plan inventory.

---

## Structured JSON results

Every run produces machine-readable JSON. `run_regression.py` writes
`/tmp/bayes_regression-{run_id}.json`. `regression_plans.py` writes
`/tmp/bayes_results-plan-{name}-{timestamp}.json` (wrapped in a
plan/variant envelope).

Per graph, the JSON includes structured failures (typed, queryable),
rounded floats, per-parameter bias profiles, audit data (binding,
LOO, model flags), and experimental design metadata (topology,
sparsity parameters, context dimensions with lifecycle windows).

Schema is defined in `bayes/results_schema.py`:
`serialise_result()` for per-graph data, `serialise_design()` for
experimental design extraction from truth config, `make_failure()`
for structured failure construction.

Example query:
```bash
jq '.variants.default.graphs[].failures[] | select(.param == "onset")'
jq '[.graphs[] | {topo: .design.topology, rhat: .quality.rhat, passed}]'
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
1. **Production graphs**: `analytic` model_vars on graph edges
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
| `--rebuild` | All three | Delete `.synth-meta.json` for the target graph, forcing `verify_synth_data` to re-check DB with fresh hashes. Heavy — triggers full DB re-insert of synth rows. Only needed after truth file or `synth_gen.py` changes. **Does NOT work with `--no-mcmc`** — see pitfall below. |
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

### Direct rebuild

To force synth data regeneration without running MCMC:

```
synth_gen.py --graph synth-X --write-files --bust-cache
```

This runs the full pipeline (simulate, hash, write to DB, write
param files, write synth-meta) in ~10s. The output includes an
onset observation summary showing per-edge and per-slice onset
means — use this to verify per-slice onset values are correct
before running recovery tests.

### Onset observation noise (15-Apr-26)

Onset observations use log-normal noise (`onset * lognormal(0,
log_sigma)` where `log_sigma` defaults to 0.3). This replaced
clipped Gaussian noise which introduced systematic upward bias
on small-onset edges via `max(0, ...)` clipping. The
`log_sigma` is configurable per edge via `onset_obs_log_sigma`
in the truth file.

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

### Anti-pattern 40: `--rebuild --no-mcmc` is a no-op for synth data (15-Apr-26)

`--rebuild` deletes `.synth-meta.json`. But `--no-mcmc` skips
payload construction, which skips the synth data gate
(`test_harness.py` line 769: `if graph_name.startswith("synth-")
and not _skip_payload_construction`). So `verify_synth_data` never
runs and the DB rows are never re-inserted.

The rebuild only takes effect on the NEXT run that does NOT use
`--no-mcmc`. To force immediate re-bootstrap, use `--rebuild`
with minimal MCMC (`--tune 10 --draws 10 --chains 1`) instead of
`--no-mcmc`.

### Persistent recovery logs (15-Apr-26)

`param_recovery.py` tees all output to a persistent log file at
`/tmp/bayes_recovery-{job_label}.log`. This survives parent
process death — if a comparison script is killed mid-run,
completed graphs' results are on disk. Each run should use a
unique `--job-label` (e.g. with a timestamp suffix) to prevent
log collisions across runs.

### Stall detector: laggard chains (15-Apr-26)

The `ChainStallDetector` has a `min_peak` threshold (10 draws/s)
— chains that never reach this peak rate are not checked for
stalls. This misses chains that are slow from the start (they
never establish a peak rate). The `check_laggard()` method
(added 15-Apr-26) performs a cross-chain comparison: if a chain
has completed <10% of the median draws across siblings AND its
rate is below `crawl_floor` for `grace_s`, it is flagged as a
laggard stall. This catches the case where one chain is
pathologically slow from initialisation while siblings run
normally.

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

A stall is detected when a chain's draw rate drops to a sustained crawl.
Two conditions must BOTH hold:

1. **Entry**: the chain's rate (draws over the last 5s) drops below
   `crawl_floor` (3 draws/s) AND below `crawl_ratio` (10%) of the
   chain's established peak rate. Both conditions are required —
   a chain doing 4 draws/s is never flagged regardless of peak, and
   a slow model with peak 8 draws/s won't flag at 2 draws/s (since
   2 > 10% of 8 = 0.8).

2. **Sustained**: the chain remains in crawl state for a full
   `grace_s` (30s) consecutive seconds. If the rate rises above
   the crawl thresholds at ANY point, the timer resets entirely.

Detection does not activate until a chain reaches `min_peak`
(10 draws/s) cruising speed, preventing false positives during
warmup.

**Design history**: the first implementation used an EMA with
hysteresis thresholds. This was too sensitive — the EMA decayed
fast on brief pauses (normal NUTS tree-depth variation), causing
false positives that killed healthy runs at 98% completion. The
current implementation uses raw draws-in-window rate measurement
with no smoothing. A chain must genuinely crawl (< 3 draws/s)
for a full 30 consecutive seconds to trigger.

**Logging**: three log lines trace the detector's decisions:
- `CRAWL ENTERED: chain X rate=Y (peak=Z)` — entry into crawl state
- `CRAWL RECOVERED: chain X` — rate recovered, timer reset
- `STALL CONFIRMED: chain X rate=Y ... crawling for Zs, per_chain=[...]` — 30s sustained, abort triggered

**Retry** (`worker.py`):
- `run_inference` calls are wrapped in a retry loop (max 20 attempts)
- On `ChainStallError`, the run is aborted and restarted with a fresh random seed
- After all retries exhausted, `RuntimeError` propagates — the graph is marked FAILED
- Both Phase 1 and Phase 2 have independent retry loops

**Per-chain progress template**: the nutpie Jinja2 template
(`_NUTPIE_PROGRESS_TEMPLATE`) emits per-chain `finished_draws` every
500ms. Every throttled progress line now includes `chains=[N,M,...]`
showing per-chain draw counts.

**Test coverage**: `bayes/tests/test_stall_detector.py` — 15 tests
covering: no false positives (steady, brief dip, moderate slowdown,
5 draws/s, end-of-run, intermittent), real stalls (sustained crawl,
near-zero, 2 draws/s, grace timing, chain identification), and edge
cases (warmup, dual-condition gate, low-peak models).

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

### Anti-pattern 39: Graph JSON regeneration strips critical metadata

**Signature**: a synth graph that previously worked (data binding succeeded, MCMC ran with full evidence) suddenly produces zero snapshot rows. The harness reports `all expected hashes returned no data` for every edge. The DB has data (verified by querying with synth-meta hashes), but the FE CLI produces zero snapshot subjects.

**Root cause**: the graph JSON was regenerated by a code path that doesn't set `pinnedDSL` / `dataInterestsDSL`. Without the DSL, the FE CLI cannot build snapshot subjects, cannot compute `core_hash`es, and falls back to param files only — losing all trajectory data, context slices, and `kappa_lat` evidence. The graph looks structurally valid (correct nodes, edges, UUIDs) but is functionally broken for Bayes.

Multiple code paths can regenerate the graph JSON: `graph_from_truth.py` (truth-based generation), `synth_gen.py --write-files` (which calls `set_simulation_guard`), and `synth_gen.py --bust-cache`. Historically only `set_simulation_guard` set the DSL — if it wasn't called, the DSL was silently stripped.

**Fix**: `graph_from_truth.py` now sets `pinnedDSL`, `dataInterestsDSL`, and `currentQueryDSL` directly during graph generation, using the simulation config and context dimensions from the truth file. Every code path that generates a graph JSON produces a complete, functional graph.

**Broader principle**: when a file is regenerated, ALL required fields must be set by the generator — not split across multiple tools invoked in a specific order. If field X is required for the file to function, the generator must set field X unconditionally.

### Anti-pattern 46: Synth graph hash divergence from connection-string inconsistency

**Signature**: synth graph tests return zero snapshot rows. `candidate_regimes_by_edge` is empty or `core_hash` is `''`. DB has rows but they're under a different hash than what the FE computes at runtime.

**Root cause**: the connection name is part of the canonical signature used to compute `core_hash`. If the graph JSON says one connection name (e.g. `defaultConnection: "amplitude-prod"`) but the FE hash computation path uses a different name (e.g. hardcoded `'amplitude'` fallback), the hashes diverge. The CLI (called by `synth_gen.py` Step 2) and the FE runtime must resolve the same connection name for the same graph.

Three specific failure modes:

1. `graph_from_truth.py` writes a connection name that doesn't match what the FE expects.
2. FE call sites don't read `graph.defaultConnection` and fall back to a hardcoded default.
3. Synth graphs use a real connection name (`amplitude-prod`) instead of a fake one (`amplitude`), risking accidental live fetches.

**Fix**: ensure all FE connection-resolution paths follow the `edge.p.connection → graph.defaultConnection → 'amplitude'` chain (`fetchPlanBuilderService.ts` is the reference implementation). Synth graphs must use a fake connection name that can't trigger real fetches. The freshness checker (`verify_synth_data`) validates connection-string consistency between the graph JSON and the meta sidecar.

**How to spot**: `verify_synth_data(graph_name, data_repo)` returns `"stale"` with reason mentioning "Connection string changed". Or DB query `SELECT COUNT(*) FROM snapshots WHERE core_hash = '' AND param_id LIKE '%synth%'` returns non-zero.

---

## Sparsity and lifecycle calibration (doc 40, doc 44)

### Random sparsity layer in synth_gen.py

Three simulation parameters gate snapshot row emission without
affecting the underlying population simulation or param file data:

| Parameter | What it does |
|-----------|-------------|
| `frame_drop_rate` | Per-row random drop probability (independent per edge×slice×date) |
| `toggle_rate` | Per fetch-night probability that an edge×slice flips emitting on/off |
| `initial_absent_pct` | Fraction of edge×slice combos that start not-emitting |

All three default to 0.0 (no sparsity). Set in the `simulation`
block of truth YAML files, same level as `failure_rate`.

### Structured lifecycle (18-Apr-26)

Per-value `active_from_day` / `active_to_day` in truth YAML context
dimension values control deterministic temporal coverage. This models
treatment switching: treatment A active throughout, treatment B
withdrawn at day 65, treatment C introduced at day 33.

```yaml
context_dimensions:
  - id: treatment
    mece: true
    values:
      - id: baseline
        weight: 0.50
      - id: treatment-b
        weight: 0.30
        active_to_day: 65
      - id: treatment-c
        weight: 0.20
        active_from_day: 33
```

The population simulation zeros out weights for inactive values per
day and renormalises — inactive treatments receive no new entrants.
Row emission is also gated per value per day. Both effects compose
with random sparsity.

### Sparsity sweep infrastructure

`bayes/plans/generate_sparsity_sweep.py` generates truth YAMLs for
the cartesian product of 3 topologies (solo/chain/diamond) × 6
sparsity configs (4 random levels + lifecycle + lifecycle-sparse) =
18 graphs. Output goes directly to `bayes/truth/`.

Three regression plans target this matrix:

- `sparsity-sweep-quick` — solo topology only (6 graphs)
- `sparsity-sweep-full` — all 18 graphs, deep sampling
- `sparsity-lifecycle` — lifecycle configs only, all topologies

The structured JSON output includes `design.sparsity` and
`design.context_dimensions[].lifecycles`, enabling cartesian analysis
of recovery degradation without parsing graph names.

### Existing sparse truth files

- `synth-skip-context-sparse` — skip topology, 15%/0.02/25%
- `synth-diamond-context-sparse` — diamond topology, same defaults
- 18 sweep graphs (solo/abc/diamond × sparse-1 through sparse-4 + lifecycle variants)

All auto-discovered. Wider z-score thresholds (3.0–4.5) for sparser
graphs.

### Test coverage

9 blind tests in `bayes/tests/test_synth_gen.py::TestSparsityLayer`
covering: zero-sparsity baseline parity, frame drop magnitude,
initial absence, toggle gaps, edge_daily integrity, context row
gating, heavy sparsity survival, stats recording, full absence
boundary.
