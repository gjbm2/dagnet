# Handover: JAX Backend for Contexted Model Compilation

**Date**: 12-Apr-26  
**Branch**: `feature/snapshot-db-phase0`  
**Session duration**: ~6 hours  
**State**: Multiple bugs fixed, tooling improved, but the work is NOT complete — diamond-context Phase 2 init failure is unresolved, full regression suite has not been run successfully, and the debug artefact dump has a `NameError` that must be fixed before it can be used.

---

## Objective

nutpie's numba backend takes 500s+ to compile contexted Bayesian models (3+ edges × 3 slices), making contexted Bayes unusable. The goal was to switch to JAX's XLA compiler as an alternative backend (`jax_backend` feature flag), validate it produces correct posteriors, and run the full contexted regression suite.

Secondary goals that emerged: fix multiple pre-existing bugs in the Phase 2 model build for contexted graphs with join nodes, improve the regression tooling (timeouts, log preservation, `--clean`/`--rebuild` split), and add debug artefact dumping to avoid expensive re-runs during investigation.

---

## Current State

### JAX Backend — DONE (working)
- **`jax_backend` feature flag**: wired through `SamplingConfig.jax_backend` → `run_inference` → `_sample_nutpie` → `nutpie.compile_pymc_model(model, backend='jax', gradient_backend='jax')`.
- **Files**: `compiler/types.py` (1 field), `compiler/inference.py` (backend selection + timing instrumentation), `worker.py` (feature flag wiring from `features` dict).
- **Dependency**: `jax[cpu]>=0.4.30` added to `bayes/requirements.txt`. Installed in venv.
- **Validated**: synth-simple-abc-context (125s, all p OK), synth-fanout-context (125s, all p OK), synth-skip-context (492s, 57/61 OK, onset misses only).
- **Compilation speedup**: 11.6× on synthetic benchmark (20.4s → 1.8s). Real graphs: ~5-13s vs 500s+ numba.

### Bug Fixes — DONE but ONE IS BROKEN
1. **`_p_slice_vec` UnboundLocalError** (`model.py:1343`): BG edges + batched trajectories. Fixed by using `bg_slice_p_vars[edge_id][ck]` directly instead of `.get(ck, _p_slice_vec[i])` fallback. — **DONE, tested.**
2. **`_resolve_path_latency` 3-tuple crash** (`model.py:2480`): `cohort_latency_vars` entries are `(onset, mu, sigma)` 3-tuples but `pt_fw_chain` expects `(mu, sigma)` 2-tuples. Fixed by extracting `(lv[1], lv[2])` when `len(lv) == 3`. — **DONE, tested.**
3. **`_ll_pointwise` UnboundLocalError in mixture path** (`model.py:2200`): The mixture CDF code path (join-node downstream edges) computed `logp` but never assigned `_ll_pointwise`. Line 2360 then crashed. Fixed by assigning `_ll_pointwise` in the mixture branch and adding `n_terms`. — **DONE, tested.**
4. **Debug artefact dump `NameError`** (`worker.py:~1094`): The dump code references `graph_name` which doesn't exist at that scope in the worker function `_fit_graph_compiler`. The variable should be `payload.get("graph_id", "unknown")` or similar — check what's in scope. — **BROKEN. This is the immediate blocker.** The diamond-context run wasted 14 minutes of Phase 1 MCMC and then crashed on this `NameError` instead of on the Phase 2 init failure it was supposed to capture. **Fix this first.**

### Tooling Changes — DONE
1. **`--clean`/`--rebuild` split**: `--clean` only clears `__pycache__`. `--rebuild` deletes `.synth-meta.json` (forces expensive DB re-insert). Changed in `test_harness.py`, `param_recovery.py`, `run_regression.py`.
2. **`--no-timeout`**: Disables all three timeout layers. `run_regression.py` passes `--timeout 0` through chain. Fixed `test_harness.py` to handle `args.timeout == 0` correctly (Python `0 or default` was treating 0 as falsy — changed to `args.timeout is not None and args.timeout > 0`).
3. **Timestamped archive logs**: Every harness run now writes to both `/tmp/bayes_harness-{label}.log` (overwritten, for monitoring) and `/tmp/bayes_harness-{label}-{YYYYMMDD-HHMMSS}.log` (preserved). `archive_file` opened and closed alongside `log_file` in all code paths.
4. **XLA thread env vars**: When `jax_backend=true`, `param_recovery.py` and `run_regression.py` set `XLA_FLAGS=--xla_cpu_multi_thread_eigen=true` and `OMP_NUM_THREADS={cpu_count}` instead of pinning to 1. JAX parallelises within each gradient evaluation.
5. **`run-param-recovery.sh`**: Removed harness log truncation (line 110).

### Unresolved: Diamond-Context Phase 2 Init Failure — BLOCKED
- Phase 1 completes fine (rhat=1.04, 3 divergences).
- Phase 2 model builds (74 free, 19 obs, 18 potentials after `_ll_pointwise` fix).
- nutpie crashes: `RuntimeError: All initialization points failed — Could not initialize state because of bad initial gradient: Invalid initial point`.
- Root cause unknown. Hypothesis: numerical instability in the mixture CDF hazard decomposition at the default init point — frozen latency values from Phase 1 combined with the 4-edge-deep join path may produce CDF values that create `log(0)` or `0/0` in the gradient.
- **Cannot investigate until debug artefact dump is fixed** (the `NameError`).
- This is NOT a JAX-specific issue — it's a Phase 2 model construction issue that would affect numba too.

### Tests — IN PROGRESS
- `TestPhase2ModelBuildWithJoinNodes` in `test_data_binding_adversarial.py`: tests Phase 1 and Phase 2 model build on diamond-context with fabricated frozen priors and param-file evidence. Passes (13s). **But does NOT catch the real init failure** because it uses param-file evidence (sparse) not snapshot evidence (dense), and fabricated frozen priors not real Phase 1 posteriors. The test proves the model builds; it doesn't prove the model is samplable.
- The user was deeply critical of test quality throughout the session. The core failure pattern: tests confirm the agent's assumptions about its own code rather than probing whether the code works with real data. See "Discoveries & Gotchas" below.

### Documentation — DONE
- `docs/current/codebase/BAYES_REGRESSION_TOOLING.md`: Updated with `--clean`/`--rebuild`, `--no-timeout`, JAX backend, timeout layers.
- `bayes/TESTING_PLAYBOOK.md`: Updated common commands with JAX examples.
- `docs/current/project-bayes/18-compiler-journal.md`: Added update 9 (JAX backend validation).
- `docs/current/project-bayes/jax-backend-skip-context-analysis.md`: Detailed analysis of skip-context run.

### Full Regression Suite — NOT STARTED
- Never completed successfully. Attempted multiple times, blocked by crashes (`_ll_pointwise`, `_p_slice_vec`, `NameError`), timeouts (`--no-timeout` not propagating), and the diamond-context Phase 2 init failure.

---

## Key Decisions & Rationale

1. **JAX in `bayes/requirements.txt` (not `requirements-local.txt`)**: JAX goes into the Modal image too, not just local dev. The user explicitly asked for this — the feature flag makes it safe (numba is still default). `bayes/requirements.txt:12`.

2. **Feature flag, not default**: `jax_backend=false` by default. Activated via `--feature jax_backend=true`. Allows A/B comparison and safe rollback. `compiler/types.py:541`.

3. **`gradient_backend='jax'` alongside `backend='jax'`**: Both are set together. Using JAX for compilation but pytensor for gradients would negate most of the benefit. `compiler/inference.py:~1500`.

4. **`--clean` split from `--rebuild`**: The user was furious that `--clean` was forcing expensive DB re-inserts on every run. `--clean` now only clears `__pycache__`. `--rebuild` (new flag) deletes synth-meta to force DB re-insert. User instruction: only use `--rebuild` after truth file or `synth_gen.py` changes.

5. **`try/except UnboundLocalError` was wrong**: I initially used `try: _ll_pointwise; except UnboundLocalError: pass` to "fix" the `_ll_pointwise` crash. This silently swallowed the real bug (mixture path not setting `_ll_pointwise`), causing Phase 2 models to have 0 potentials. The user didn't catch this directly but the diamond-context init failure was a downstream consequence. The proper fix was adding `_ll_pointwise =` assignment to the mixture branch at `model.py:2200`.

---

## Discoveries & Gotchas

1. **nutpie already supports `backend='jax'`**: No wrapper needed. `nutpie.compile_pymc_model(model, backend='jax', gradient_backend='jax')` is a first-class API. The signature also accepts `freeze_model`, `var_names`, etc.

2. **JAX CPU parallelism requires explicit XLA flags**: Just removing `OMP_NUM_THREADS=1` is insufficient. Need `XLA_FLAGS=--xla_cpu_multi_thread_eigen=true` and `OMP_NUM_THREADS={cpu_count}`. Even with these, JAX reaches ~50% CPU on this machine (16-core Ultra 9 285H) — the per-gradient computation may not be large enough to saturate all cores.

3. **JAX GPU was slower**: The user tested GPU JAX and found it much slower. Expected — the model has thousands of small scalar ops (per-interval CDF), and GPU kernel launch overhead dominates.

4. **Python `0 or default` treats 0 as falsy**: `args.timeout or truth.get(...)` when `args.timeout == 0` falls through to the default. This caused `--no-timeout` to silently not propagate through test_harness. Fixed with explicit `args.timeout is not None and args.timeout > 0` check.

5. **`graph_name` doesn't exist in worker scope**: The worker function `_fit_graph_compiler` doesn't have a `graph_name` variable. It has `payload.get("graph_id")` etc. The debug artefact dump code used `graph_name` and crashed with `NameError`. This is the **immediate blocker** for the next session.

6. **Agent test quality was severely criticised**: The user's core complaint: tests confirm the agent's mental model rather than probing real failure modes. Fabricated frozen priors pass because they avoid the numerical edge cases that real posteriors produce. The research (arxiv 2602.07900) confirms this is a known LLM testing anti-pattern — agent-written tests serve as "observational feedback channels" not bug detectors. The user wants tests that use real pipeline output, not fabricated inputs.

7. **pytensor `local_inline_composite_constants` rewrite errors**: Non-fatal `TypeError: Cannot convert Type Vector(bool, ...)` warnings appear during model compilation. These are pytensor graph optimiser failures — the graph stays unoptimised but still compiles. They appear on both numba and JAX backends.

---

## Relevant Files

### Core changes
- `bayes/compiler/types.py` — `SamplingConfig.jax_backend` field
- `bayes/compiler/inference.py` — `_sample_nutpie`: backend selection, timing instrumentation
- `bayes/compiler/model.py` — Three bug fixes: `_p_slice_vec` (line ~1343), `_resolve_path_latency` 3-tuple (line ~2480), mixture `_ll_pointwise` (line ~2200)
- `bayes/worker.py` — `jax_backend` wiring (line ~777), debug artefact dump (line ~1094, **BROKEN**)

### Tooling
- `bayes/test_harness.py` — `--clean`/`--rebuild` split, `--timeout 0` fix, archive log
- `bayes/param_recovery.py` — `--rebuild` passthrough, XLA env vars, timeout `None` fix
- `bayes/run_regression.py` — `--no-timeout`, `--rebuild`, XLA env vars
- `bayes/requirements.txt` — `jax[cpu]>=0.4.30` added
- `scripts/run-param-recovery.sh` — removed harness log truncation

### Tests
- `bayes/tests/test_data_binding_adversarial.py` — `TestPhase2ModelBuildWithJoinNodes` (new)

### Docs
- `docs/current/codebase/BAYES_REGRESSION_TOOLING.md` — updated
- `docs/current/project-bayes/18-compiler-journal.md` — update 9 added
- `docs/current/project-bayes/jax-backend-skip-context-analysis.md` — new

### Context (read, not changed)
- `docs/current/project-bayes/38-contexted-compilation-performance.md` — full compilation performance analysis
- `bayes/compiler/completeness.py` — `pt_fw_chain` (line ~141), `shifted_lognormal_cdf`
- `bayes/compiler/evidence.py` — `bind_evidence`, `bind_snapshot_evidence` signatures

---

## Next Steps

1. **Fix the `NameError` in debug artefact dump** (`worker.py:~1094`): Replace `graph_name` with the correct in-scope variable. Check what `_fit_graph_compiler`'s parameters provide — likely `payload.get("graph_id", "unknown")`. Then verify by running `--no-mcmc` on any graph and checking `/tmp/bayes_debug-*/` exists.

2. **Run diamond-context to capture artefacts**: Once the dump works, run diamond-context again. Phase 1 will take ~14 min. The Phase 2 init will fail, but the artefacts (topology.pkl, evidence.pkl, phase2_frozen.json) will be preserved.

3. **Debug Phase 2 init failure offline**: Load the pickled artefacts, call `build_model(topo, ev, phase2_frozen=frozen)`, then `model.compile_dlogp()(model.initial_point())` to find which gradient component is NaN. Trace back to the specific Potential/likelihood that produces the bad gradient. This should take seconds, not minutes.

4. **Fix Phase 2 init**: Likely a numerical floor/clip issue in the mixture CDF hazard decomposition for the join-downstream edge. The frozen latency values from Phase 1 may produce extreme CDF values at certain ages.

5. **Run full contexted regression**: `python bayes/run_regression.py --include context --exclude lattice --max-parallel 1 --chains 2 --tune 1000 --draws 500 --feature jax_backend=true --no-timeout`. Lattice is excluded because it's very large and slow; validate it separately once the smaller graphs pass.

6. **Produce the analysis file**: The user requested an exhaustive analysis of each graph with compute times, pass/fail, recovery details. This was never delivered. After the regression completes, produce it at `docs/current/project-bayes/jax-backend-regression-analysis.md`.

7. **Improve test quality**: The existing `TestPhase2ModelBuildWithJoinNodes` test uses fabricated data. It should be supplemented with a test that uses the real debug artefacts (once captured) to verify the Phase 2 model is samplable, not just buildable.

---

## Open Questions

1. **Should `jax_backend` become the default for contexted models?** Currently off by default. The user hasn't decided. Non-blocking — the feature flag works.

2. **Is the diamond Phase 2 init failure specific to diamond, or does it affect all join-node graphs?** Skip-context has a join and works. 3way-join-context timed out (1800s) before we could tell. Non-blocking for skip/fanout/abc/solo graphs, blocking for diamond/lattice/3way-join.

3. **Should the debug artefact dump be permanent or gated behind a flag?** Currently unconditional (always dumps). The pickle files are ~130KB. Could gate behind `--diag` or a setting. Non-blocking.

4. **Uncontexted regression with join nodes**: The `_ll_pointwise` mixture bug affects uncontexted graphs too (any graph with joins in Phase 2). The uncontexted regression suite should be re-run to verify. Non-blocking for contexted work but important.
