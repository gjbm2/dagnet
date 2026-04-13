# Handover: Phase 2 JAX Backend, Diamond-Context, Devtooling

**Date**: 13-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Prior handover**: `12-Apr-26-jax-backend-contexted-compilation.md`

---

## Objective

Enable contexted Bayesian model fitting on join-node graphs (diamond, 3-way-join, lattice). The JAX backend (11.6x compilation speedup) was validated on simpler graphs in the prior session. This session: fix the debug artefact dump crash, run diamond-context end-to-end, diagnose Phase 2 init failure, build `--phase2-from-dump` devtooling for fast iteration.

---

## Current State

### Debug artefact dump — DONE
- **`NameError` fix**: `worker.py:1098` — `graph_name` replaced with `payload.get('graph_id', 'unknown')`.
- **try/except wrapper**: dump code wrapped so a serialisation failure doesn't crash the worker after 14 min of Phase 1 MCMC.
- **E2e test**: `bayes/tests/test_worker_phase2_dump.py` — calls `_fit_graph_compiler` end-to-end with fabricated contexted snapshot rows, mocking only MCMC. Verifies dump files exist, are loadable, and contain per-slice frozen priors.

### JAX gradient NaN — RESOLVED (fix not yet applied)
- **Root cause identified**: `gradient_backend='jax'` in `nutpie.compile_pymc_model()` uses `jax.value_and_grad()` on the pytensor-compiled forward pass. JAX's reverse-mode AD hits `0 × inf = NaN` in deep erfc/softplus/gather chains. See anti-pattern 36 in `KNOWN_ANTI_PATTERNS.md`.
- **Fix**: change `gradient_backend='jax'` to `gradient_backend='pytensor'` in `inference.py:1509`. Pytensor computes symbolic gradients first (handling numerical edge cases), then compiles both forward and gradient to JAX. One-line change. **NOT YET IMPLEMENTED** — the user identified this after the session's debugging work.
- **Workaround in place**: `worker.py` catches `RuntimeError` with "initialization" in the message during Phase 2 and retries with numba backend. This adds ~180s compile penalty.
- **Diagnostic detail**: doc 39 (`39-phase2-jax-gradient-nan.md`) has full problem statement, reproduction code, and investigation history.

### Z-clamp on erfc — DONE (retained as safeguard)
- `Z_ERFC_FLOOR = -25.0` added to `model.py:183`. Clamps z before `erfc(-z)` at three sites (trajectory CDF, two endpoint BetaBinomials). Did NOT fix the JAX NaN (which was in `gradient_backend`, not `erfc`), but is a legitimate numerical safeguard — prevents `erfc` underflow to exact 0.0 in float64.

### Interval index changes — DONE (semantically equivalent)
- Four sites in `model.py` changed from `prev_safe = np.where(idx >= 0, idx, 0)` + `is_first` mask to `prev_idx = np.where(idx >= 0, idx, curr_idx)` + `is_first_np` mask. Mathematically identical. Did not fix JAX NaN. Left in place (marginally cleaner, no functional difference).

### `--phase2-from-dump` flag — DONE (devtool quality issues remain)
- **`test_harness.py`**: `--phase2-from-dump PATH` argument. When set, `_skip_payload_construction = True` bypasses synth gate. Settings merged directly. `--phase2-from-dump` passed through to worker via `settings["phase2_from_dump"]`.
- **`param_recovery.py`**: `--phase2-from-dump PATH` argument. Builds minimal payload with graph JSON and param files (for analytic comparison), passes via `--payload` instead of `--fe-payload` (skips expensive CLI hash computation). Loads Phase 1 frozen posteriors from dump for the recovery comparison.
- **`worker.py`**: `phase2_from_dump` setting handler at top of `_fit_graph_compiler`. Loads topology, evidence, phase2_frozen, settings from dump dir. Builds Phase 2 model, runs MCMC (with JAX→numba fallback), extracts per-slice cohort posteriors from trace, logs `Phase 2 slice`, `Phase 2 p_cohort`, `Phase 2 path_latency` lines. Returns result via `_build_result`.
- **`db_conn` fix**: `db_conn = None` initialised at function top (line 422) to prevent `UnboundLocalError` in `finally` block when dump path returns early.
- **Early-abort fix**: `timeout_s > 0` guard on the sampling time estimate check (line 931). Prevents false abort when `--timeout 0` is used with `--phase2-from-dump` (which has `expected_sample_s = 0`).

### Phase 2 param recovery on diamond-context — DONE (model issues found)
- **Run completed**: 4 chains, 1000 draws, 2000 tune, numba backend. 486s total.
- **Convergence**: rhat=2.10, ESS=5, converged=40%. Chains stuck in different modes.
- **Phase 1 recovery** (from frozen dump): Excellent. p within 0.08, mu within 0.13, sigma within 0.06, onset within 0.10.
- **Phase 2 onset drift**: `onset_cohort` drifts 3-6 days above truth on path-B edges (truth=1-3d, Phase 2=5-7d). Causes p overestimate (join-to-outcome: truth=0.50, post=0.89).
- **Per-slice**: Google (60% weight) and direct (30%) mostly OK. Email (10%) has 2 MISSes (z > 9) — low traffic + onset drift.
- **Root cause**: onset-mu ridge. The t95 soft constraint allows onset and mu to trade off while keeping t95 constant. NOT a number-of-draws issue — multimodal posterior.
- **Documented**: compiler journal update 11, programme.md open issues.

### Documentation — DONE
- `docs/current/project-bayes/18-compiler-journal.md`: updates 10 (JAX NaN) and 11 (onset drift).
- `docs/current/project-bayes/39-phase2-jax-gradient-nan.md`: full problem statement.
- `docs/current/codebase/BAYES_REGRESSION_TOOLING.md`: debug dump, `--phase2-from-dump`, numba fallback sections.
- `bayes/TESTING_PLAYBOOK.md`: `--phase2-from-dump` usage example.
- `docs/current/project-bayes/programme.md`: three open issues added (JAX resolved, onset drift open, devtool quality open).
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md`: anti-pattern 36 (gradient_backend, added by user).

---

## Key Decisions & Rationale

1. **try/except on dump code**: The dump is diagnostic, not critical path. Losing the dump is bad; crashing the worker after 14 min MCMC is worse. `worker.py:1096-1110`.

2. **Z-clamp retained despite not fixing the NaN**: `Z_ERFC_FLOOR = -25` prevents a real numerical issue (erfc underflow to exact 0) even though the JAX NaN turned out to be from `gradient_backend`. Defence in depth. `model.py:183`.

3. **`--phase2-from-dump` skips CLI payload**: The `--fe-payload` CLI path takes ~30s for hash computation. When replaying from dump, the hashes aren't needed. `param_recovery.py` builds a minimal payload with just graph JSON + param files and passes via `--payload`. Saves 30s per iteration.

4. **Numba fallback is automatic, not manual**: `worker.py` catches the JAX init failure and retries with numba in the same run. The user doesn't need to re-invoke with different flags. But the 180s penalty is unacceptable long-term — the `gradient_backend='pytensor'` fix should eliminate it.

5. **`param_recovery.py` shows both `p` and `p_coh`**: Window p (Phase 1) and cohort p (Phase 2) are shown separately as `p` and `p_coh` in the recovery comparison. No fallback — both are always labelled explicitly. `param_recovery.py:551-553`.

---

## Discoveries & Gotchas

1. **`gradient_backend='jax'` vs `'pytensor'`**: The user identified (anti-pattern 36) that nutpie has two gradient modes. `'jax'` compiles only the forward pass to JAX, then uses `jax.value_and_grad()` — this hits NaN on deep computation chains. `'pytensor'` computes symbolic gradients first (handling numerical edge cases via pytensor rewrites), then compiles both forward and gradient to JAX. Same runtime performance, slightly longer compile, no NaN. This was NOT discovered during the debugging session — the session spent hours investigating erfc underflow and array indexing, which were red herrings.

2. **nutpie `PyFuncModel` internals**: `compiled._raw_logp_fn` is the JAX-callable forward function. `compiled._variables` lists variables with names and shapes. `compiled.benchmark_logp(x, num_evals, cores)` evaluates logp+grad. These are undocumented but useful for offline debugging.

3. **Stale `.pyc` bytecode**: Even with `sys.dont_write_bytecode = True`, Python still READS existing `.pyc` files. Must delete `__pycache__` dirs when iterating on `model.py` changes. `param_recovery.py` and `run_regression.py` set `PYTHONDONTWRITEBYTECODE=1` in the subprocess env, which only prevents WRITING new `.pyc`.

4. **`expected_sample_s = 0` triggers early abort**: When `--phase2-from-dump` builds a minimal payload without truth file data, `expected_sample_s` defaults to 0. The early-abort check `mins * 60 > expected_sample_s * 3` fires immediately because anything > 0. Fixed by guarding with `timeout_s > 0`.

5. **Monitor tool at 3s intervals floods the conversation**: Never use `tail -f | grep` as a monitor with high-frequency output. The 3s heartbeat from the harness compile phase generated hundreds of notifications that blocked the conversation thread. Use background tasks with completion notifications instead.

6. **Phase 2 onset drift is NOT a convergence issue**: 4 chains × 1000 draws with rhat=2.10 means multimodal posterior, not insufficient samples. The onset-mu ridge creates separated modes that NUTS can't traverse. More draws won't help — the model geometry needs fixing.

---

## Relevant Files

### Core changes
- `bayes/worker.py` — debug dump fix (line 1098), try/except wrapper (1096-1110), `db_conn` init (422), `phase2_from_dump` handler (428-590), Phase 2 numba fallback (1167-1180), per-slice extraction in dump path (526-559)
- `bayes/compiler/model.py` — `Z_ERFC_FLOOR` constant (183), z-clamp in `_compute_cdf_at_ages` (2140), z-clamp in endpoint BetaBinomials (3075, 3142), interval index pattern changes (4 sites)
- `bayes/compiler/inference.py` — `_sample_nutpie` line 1509: `gradient_backend='jax'` — **change to `'pytensor'` to fix NaN**
- `bayes/test_harness.py` — `--phase2-from-dump` arg, `_skip_payload_construction` flag, early-abort `timeout_s > 0` guard (line 931)
- `bayes/param_recovery.py` — `--phase2-from-dump` arg, minimal payload with param files, Phase 1 frozen loading, cohort p parsing, per-slice merge, `p_coh` display

### Tests
- `bayes/tests/test_worker_phase2_dump.py` — e2e test for dump creation (NOT replay). Fabricated snapshot rows with context slices.

### Docs
- `docs/current/project-bayes/39-phase2-jax-gradient-nan.md` — full JAX NaN problem statement
- `docs/current/project-bayes/18-compiler-journal.md` — updates 10 (JAX NaN) and 11 (onset drift)
- `docs/current/codebase/BAYES_REGRESSION_TOOLING.md` — debug dump, `--phase2-from-dump`, numba fallback
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` — anti-pattern 36 (gradient_backend)
- `docs/current/project-bayes/programme.md` — open issues updated

### Dump artefacts (on disk, not in repo)
- `/tmp/bayes_debug-graph-synth-diamond-context/` — Phase 1 artefacts from the 13-Apr-26 run. `phase2_frozen.json`, `evidence.pkl`, `topology.pkl`, `settings.json`. Valid for offline Phase 2 debugging.

---

## Next Steps

1. **Implement `gradient_backend='pytensor'` fix**: One-line change in `bayes/compiler/inference.py:1509`. Change `gradient_backend='jax'` to `gradient_backend='pytensor'`. This eliminates the JAX NaN and the 180s numba fallback. Test by running diamond-context Phase 2 from dump — should init without fallback.

2. **Remove numba fallback** (or keep as defence): Once `gradient_backend='pytensor'` is verified, the automatic numba fallback in `worker.py:1167-1180` becomes unnecessary. Could remove or keep as defence-in-depth.

3. **Fix Phase 2 onset drift**: The onset-mu ridge is the real model issue blocking diamond-context convergence. Three approaches identified in journal update 11:
   - (a) Derive `path_onset_sd` from Phase 1 posterior SD (currently fixed at 0.1)
   - (b) Reparameterise: `onset_cohort = composed × (1 + eps × small_sd)` (multiplicative, prevents additive drift)
   - (c) Joint onset+mu constraint penalising the ridge directly

4. **Devtool test coverage**: Four untested areas documented in programme.md:
   - E2e test for `--phase2-from-dump` replay path
   - `param_recovery.py` parsing regression test
   - Analytic comparison with param files in minimal payload
   - Early-abort timeout guard

5. **Re-run diamond-context with `gradient_backend='pytensor'`**: After step 1, run `python bayes/param_recovery.py --graph synth-diamond-context --phase2-from-dump /tmp/bayes_debug-graph-synth-diamond-context --feature jax_backend=true --chains 4 --draws 1000 --tune 2000 --timeout 0`. Should complete in ~2 min (15s JAX compile + ~90s sampling) instead of ~8 min (15s JAX fail + 210s numba compile + ~120s sampling).

6. **Run full contexted regression**: Once diamond-context Phase 2 converges (after onset drift fix), run the full suite: `python bayes/run_regression.py --include context --max-parallel 1 --feature jax_backend=true --no-timeout`.

---

## Open Questions

1. **Should `gradient_backend='pytensor'` be the default for all graphs, or only when `jax_backend=True`?** The anti-pattern 36 note says no performance penalty. Non-blocking — implement for JAX first, measure, then decide. The user has indicated this is resolved.

2. **Which onset drift fix to pursue first?** Three options in journal update 11. The multiplicative reparameterisation (b) is the simplest code change. Non-blocking for non-join graphs.

3. **Should the numba fallback be removed after the gradient_backend fix?** Defence-in-depth vs code complexity. Non-blocking.
