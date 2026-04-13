# Handover: Phase C Full Regression — Hash Resolution, Synth Gen Stabilisation, WSL Crash Recovery

**Date**: 11-Apr-26 (afternoon — reconstructed from conversation log after WSL crash)
**Branch**: `feature/snapshot-db-phase0`
**Prior handovers**: `11-Apr-26-contexted-regression-and-hash-alignment.md` (morning), `11-Apr-26-mu-dispersion-and-regression-tooling.md` (mid-session)

---

## Objective

Run the **first fully-audited regression** across all 21 synth graphs (11 uncontexted + 7 new contexted topologies + 3 pre-existing contexted) with the multi-layered audit (`_audit_harness_log`) active, `latency_dispersion=true`, and the `--clean` flag. This is the culmination of ~3 days of Phase C work: the audit catches false passes from hash mismatches or binding fallbacks, so a clean run here would certify that the full contexted Dirichlet model works end-to-end across all topologies.

The session resolved the **blocking hash mismatch** from the morning handover, stabilised the synth gen tooling (which was brittle and untested), verified evidence binding for all 18 regression graphs, bootstrapped 3 missing graphs, and launched the full regression. **WSL crashed during the regression run** — no results were captured.

### Scope boundaries

- **Uncontexted regression**: all 11 graphs, with `latency_dispersion=true` and multi-layered audit. kappa_lat active on 4 simple-chain graphs; 7 mixture-path graphs expected to show `kl=0` (mixture kappa_lat not yet implemented).
- **Contexted regression**: 7 new topology variants + 2 pre-existing (`synth-fanout-context`, `synth-context-solo`) + `synth-context-solo-mixed` (mixed-epoch, for R2d).
- **R2d (per-date regime routing)** is NOT STARTED — the regression must pass first.

---

## Current State

### RESOLVED — Hash mismatch (was BLOCKING in morning handover)

The morning handover identified that synth_gen's CLI call and the standalone CLI produced different `core_hash` values. The afternoon session proved this was **already fixed** by two changes from the prior session:
1. Absolute symlinks in temp dir (`synth_gen.py:2917` — `os.path.abspath(src)`)
2. Connection field alignment (`synth_gen.py:2352` — uses `graph.defaultConnection` not `"synthetic"`)

**Proof**: both CLI paths produce identical hashes for `synth-simple-abc` (`tO7LaG4K`, `gQ5ZaO6w`, `UiR0QGUo`, `hiUamUGu`). The DB has correct-hash rows (4872 each). The reason "3 regenerations didn't fix it" (morning handover) was that the DELETE in synth_gen only removes rows matching the NEW hash — old-hash rows from before the fixes persisted but are harmless (the harness queries by NEW hash and finds them).

### DONE — Evidence binding verification (all 18 regression graphs)

- **All 11 uncontexted graphs**: PASS — correct edge counts bound, zero fallbacks
- **All 7 new contexted graphs**: PASS — per-slice observations routed correctly, MECE aggregation working, exhaustiveness flags correct
- **`synth-fanout-context` and `synth-context-solo`**: 0 bound — no DB data (pre-existing graphs from earlier R2 work, never regenerated with synth_gen). Auto-bootstrapped during preflight.
- **`synth-context-solo-mixed`**: auto-bootstrapped during preflight.

### DONE — Synth gen Python hash reimplementation deleted (UNCOMMITTED)

The `compute_core_hashes()`, `_short_hash()`, and `_sha256_hex()` functions (~180 lines) have been deleted from `synth_gen.py`. These were the Python reimplementation of the FE hash pipeline (anti-pattern #28) that produced divergent hashes. The generator now relies solely on CLI-computed hashes stored in `.synth-meta.json`.

`verify_synth_data()` simplified: when no `.synth-meta.json` exists, it returns `status: "missing"` instead of falling back to the deleted Python hash functions.

### DONE — Synth gen tooling audit and fixes

The session exposed severe brittleness in the synth gen tooling:
- **Ordering dependency**: graph regeneration from truth (unconditional in `main()`) overwrites Step 1's DSL setting, producing a graph JSON without `dataInterestsDSL` for Step 2
- **Duplicate CLI calls**: old `_cli_hashes_for_dsl` calls co-existed with new single-call code, producing 4 CLI invocations instead of 2
- **No progress feedback**: CLI calls took 5-7s each with no logging, making it impossible to distinguish slow-but-working from hung
- **Excessive timeouts**: 30-45s waits on operations that should take 2-3s, masking real failures

These were identified and a problem statement was written up. The duplicate CLI call issue was fixed (old code removed). The ordering dependency and progress feedback issues remain.

### IN PROGRESS — Full regression run (CRASHED)

The regression was launched:
```
python bayes/run_regression.py --exclude context --feature latency_dispersion=true --clean
```
...then expanded to include all 21 graphs after evidence binding was verified for contexted graphs too. The run was configured with 5 parallel workers on 16 cores.

**Partial results before crash**:
- Several uncontexted graphs completed successfully (showed `====` final line in harness logs)
- `synth-3way-join-test` crashed with exit -9 (SIGKILL / OOM) — 5 parallel × 3 chains is aggressive for large graphs
- Contexted graphs were in compilation phase (~10% after 275s)
- Two duplicate `run_regression.py` processes were discovered and killed before the final run

**All regression logs (`/tmp/bayes_harness-*.log`, `/tmp/bayes_recovery-*.log`) were lost in the WSL crash.**

### DONE — Multi-layered audit (committed in `384f1af4`)

`_audit_harness_log()` in `run_regression.py` checks 6 layers per graph: completion, feature flags, data binding, priors, kappa_lat, parameter recovery. Tested by `bayes/tests/test_regression_audit.py` (20 blind tests). Documented in `docs/current/codebase/BAYES_REGRESSION_TOOLING.md`.

### DONE — kappa_lat (latency dispersion) implementation (committed in `384f1af4` and prior)

Per-interval BetaBinomial overdispersion via `kappa_lat` per edge, feature-flagged as `latency_dispersion`. Single-path trajectories only. Mixture-path kappa_lat deferred. See `11-Apr-26-mu-dispersion-and-regression-tooling.md` for full details.

### NOT STARTED — R2d (per-date regime routing)

Plan approved at `/home/reg/.claude/plans/vivid-waddling-ripple.md`. Core approach: partition rows by regime at bind time (in `_bind_from_snapshot_rows`), not model time. Requires: `regime_per_date` on `EdgeEvidence`, row-level filtering, synth generator epoch support, mixed-epoch test graphs.

### NOT STARTED — R2f (real data validation), R2g (multi-dimension)

---

## Key Decisions & Rationale

### 1. Delete Python hash reimplementation entirely, not fix it

**What**: Removed `compute_core_hashes()`, `_short_hash()`, `_sha256_hex()` from `synth_gen.py`. The generator now requires `.synth-meta.json` (written by CLI) — no fallback to Python hash computation.

**Why**: Three independent hash implementations (Python reimplementation, `compute_snapshot_subjects.mjs`, FE CLI) produced three different hashes. Each reimplementation drifted from the authoritative FE code in subtle ways (YAML date handling, event definition loading, visited/exclude arrays). The only safe path is ONE implementation — the FE CLI. Anti-pattern #28 documents the root causes.

**Where**: `bayes/synth_gen.py` — uncommitted deletion of ~180 lines. `verify_synth_data()` now returns `status: "missing"` when `.synth-meta.json` absent.

### 2. Hash mismatch was a red herring — already fixed, not a new problem

**What**: The morning handover described a blocking hash mismatch. The afternoon session proved the fixes from 10-Apr-26 (absolute symlinks + connection field) had already resolved it. The apparent persistence was because old-hash rows in the DB weren't cleaned up.

**Why**: The DELETE in synth_gen Step 3 only removes rows matching the NEW `(param_id, core_hash)` — old rows with stale hashes remain. This is harmless: the harness queries by NEW hash and finds the correct rows. No cleanup needed.

**Where**: No code change — this is a diagnostic insight. The DB has both old and new hash rows; only the new ones matter.

### 3. Reduce parallel workers for large graphs

**What**: 5 parallel × 3 chains caused OOM (SIGKILL) on `synth-3way-join-test`. The user wanted the full regression but performance constraints limited throughput.

**Why**: Large contexted graphs (3way-join, diamond, lattice) have significantly more parameters (per-slice Dirichlets + trajectory Potentials). The CDF convolution for per-slice latency is ~70x slower than uncontexted (965s vs 14s for simple-abc). Memory usage scales with `n_slices × n_edges × n_chains`.

**Where**: `run_regression.py` parallel pool. Consider reducing to 3 workers for runs including contexted graphs, or excluding the largest graphs from parallel batches.

### 4. synth_gen tooling must be properly tested before relying on it

**What**: The user repeatedly intervened to stop the session from wasting time on brittle, untested tooling. A problem statement was written up documenting the architectural flaws.

**Why**: The generator had: (a) ordering dependencies (graph regen before DSL setting), (b) duplicate CLI calls from incomplete refactoring, (c) no progress logging, (d) excessive timeouts masking failures. Each issue cost 15-30 minutes of debugging during the session.

**Where**: `bayes/synth_gen.py` — the problem is structural, not a single-line fix. The duplicate CLI call was fixed; other issues remain.

---

## Discoveries & Gotchas

### Old-hash DB rows are harmless but confusing

After hash computation fixes, the DB contains rows with BOTH old (wrong) and new (correct) hashes. The harness queries by new hash and finds correct data. The old rows are orphaned but don't interfere. A cleanup script could remove them but isn't blocking.

### synth_gen Step 2 timing is sensitive to param file existence

`computeQuerySignature` in the FE uses `selectPersistedProbabilityConfig` which merges latency config from param files when they exist. Step 2 runs before Step 4 writes param files. If param files from a PREVIOUS run exist on disk, Step 2 may see stale latency config. The current code works because the absolute-symlink fix ensures the temp dir has a clean environment, but this is fragile.

### OOM risk on parallel contexted regression

5 parallel workers with 3 MCMC chains each on 16 cores caused SIGKILL on `synth-3way-join-test`. Contexted graphs are much more memory-intensive than uncontexted. The session killed duplicate regression processes before the final run.

### WSL crash destroys all `/tmp` state

All harness logs, recovery logs, and lock files were lost. The regression must be re-run from scratch. No partial results were persisted.

### The `synth-fanout-context` and `synth-context-solo` graphs have no synth data

These pre-existing contexted graphs from earlier R2 work were never regenerated with the current pipeline. The preflight auto-bootstrapped them, but their truth files may not align with the current synth gen expectations. Verify they produce meaningful results.

### `has_window` detection in `_route_slices` depends on trajectory `obs_type`

Per-context window observations are stored as `CohortObservation` objects (with `slice_dsl=window(snapshot).context(...)`). The `has_window` flag on `SliceObservations` must check trajectory `obs_type`, not which list the observation came from. This was fixed on 10-Apr-26 (anti-pattern #30) but is easy to regress on if someone refactors the evidence binder.

---

## Relevant Files

### Backend (Python — Bayes)

- `bayes/synth_gen.py` — Synthetic data generator. **UNCOMMITTED**: ~180 lines deleted (Python hash reimplementation). `verify_synth_data()` simplified. Structural issues remain (ordering dependency, progress feedback).
- `bayes/run_regression.py` — Regression orchestrator. Multi-layered `_audit_harness_log()` (committed `384f1af4`). `--clean`, `--feature`, `--exclude`, `--job-label` flags.
- `bayes/param_recovery.py` — Per-graph param recovery. `--fe-payload` forwarded to test_harness.
- `bayes/test_harness.py` — MCMC harness. `--fe-payload` path uses CLI for payload construction. `--dump-evidence` for binding diagnostics.
- `bayes/compiler/model.py` — Model builder. `latency_dispersion` feature flag, `kappa_lat` via `pm.BetaBinomial`. Per-slice Dirichlet + Multinomial emissions.
- `bayes/compiler/evidence.py` — Evidence binder. `_bind_from_snapshot_rows` (row routing, MECE aggregation, commissioned slices), `_route_slices` (slice partitioning).
- `bayes/compiler/inference.py` — Posterior extraction including `kappa_lat`.
- `bayes/compiler/types.py` — `kappa_lat_mean/sd` on `LatencyPosteriorSummary`.
- `bayes/worker.py` — Orchestrator. `_build_unified_slices`, binding receipt, mece_dimensions.
- `bayes/tests/test_data_binding_adversarial.py` — **UNCOMMITTED**: `TestHashSpec` removed (tested deleted functions), `TestEndToEndRealPipeline` added.
- `bayes/tests/test_regression_audit.py` — 20 blind tests for `_audit_harness_log`.

### Frontend (TypeScript)

- `graph-editor/src/services/plannerQuerySignatureService.ts` — `candidateContextKeys` block disabled (anti-pattern #32). Prevents signature contamination from param file values.
- `graph-editor/src/services/candidateRegimeService.ts` — `computeMeceDimensions` scans all registry context keys.
- `graph-editor/src/cli/commands/bayes.ts` — CLI bayes command (same codepath as FE).
- `graph-editor/src/cli/diskLoader.ts` — `preloadContexts` workspace key fix.
- `graph-editor/src/services/posteriorSliceResolution.ts` — `_findSliceByMode` handles context-qualified keys.
- `graph-editor/src/services/bayesPatchService.ts` — Writes `posterior.slices` to param files.

### Docs

- `docs/current/codebase/BAYES_REGRESSION_TOOLING.md` — **UNCOMMITTED**: new doc describing full regression pipeline and multi-layered audit.
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` — **UNCOMMITTED**: anti-pattern #33 added (per-subject random effects on hazard parameters).
- `docs/current/project-bayes/34-latency-dispersion-background.md` — **UNCOMMITTED**: updated with BetaBinomial approach, failed random-effect approach, regression results.
- `docs/current/project-bayes/14-phase-c-slice-pooling-design.md` — R2 status updates (R1 complete, R2a-R2e complete, R2d not started).
- `docs/current/project-bayes/INDEX.md` — **UNCOMMITTED**: updated doc 34 row.

### Test data (in data repo)

- 7 new contexted truth files: `synth-simple-abc-context`, `synth-diamond-context`, `synth-3way-join-context`, `synth-join-branch-context`, `synth-lattice-context`, `synth-mirror-4step-context`, `synth-skip-context`
- Pre-existing: `synth-context-solo`, `synth-fanout-context`, `synth-context-solo-mixed`

---

## Next Steps

### 1. Re-run the full regression (IMMEDIATE — this was in flight when WSL crashed)

All prep work is done. Evidence binding is verified. 3 missing graphs were bootstrapped. The regression just needs to be re-run:

```
cd /home/reg/dev/dagnet && . graph-editor/venv/bin/activate
python bayes/run_regression.py --feature latency_dispersion=true --clean
```

**Watch for**:
- OOM on large contexted graphs — consider `--exclude 3way-join` or reducing parallel workers if SIGKILL recurs
- All graphs should show `data=Xsnap/0fb` (zero fallbacks) in the audit
- 4 simple-chain graphs should show `kl=1` or `kl=2` (kappa_lat active)
- 7 mixture-path graphs should show `kl=0` (expected — mixture kappa_lat deferred)
- Contexted graphs should show per-slice parameter recovery

### 2. Interpret results and update doc 14

If regression passes: mark the current phase as complete in doc 14, update the status line, note which graphs passed/failed and why.

If regression fails: diagnose per the multi-layered audit. The audit is designed to pinpoint which layer failed. Binding failures (hash mismatch) should be impossible after the verification — if they occur, something regressed.

### 3. Commit uncommitted changes

Once the regression confirms no breakage, commit the following:
- `bayes/synth_gen.py` — Python hash reimplementation deletion
- `bayes/tests/test_data_binding_adversarial.py` — test rewrite
- `bayes/test_hash_parity.py` + `bayes/tests/test_hash_parity.py` — deletions
- `docs/current/codebase/BAYES_REGRESSION_TOOLING.md` — new doc
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` — anti-pattern #33
- `docs/current/project-bayes/34-latency-dispersion-background.md` — status update
- `docs/current/project-bayes/INDEX.md` — doc 34 row update

### 4. Address synth gen structural issues (NON-BLOCKING but important)

The generator's ordering dependency (graph regen overwrites DSL before Step 2 reads it) and lack of progress logging cause repeated debugging sessions. Fix:
- Move DSL setting into the graph-from-truth generation, or gate graph regen on a flag
- Add per-step timing/progress output to stdout
- Add basic integration tests for the pipeline steps

### 5. Proceed to R2d (per-date regime routing)

After regression passes. Read the approved plan at `/home/reg/.claude/plans/vivid-waddling-ripple.md`. Core changes in `evidence.py` (`_bind_from_snapshot_rows` row-level partitioning), `types.py` (`regime_per_date` on `EdgeEvidence`), and synth gen (epoch support in truth files).

### 6. Address predictive latency uncertainty (NON-BLOCKING)

Current mu_sd/sigma_sd/onset_sd are raw MCMC posterior SDs which overstate certainty for prediction. Documented in `programme.md` as upstream blocker. Not blocking R2d.

---

## Open Questions

1. **Non-blocking**: Should `compute_snapshot_subjects.mjs` be deleted? It's bypassed by the CLI path but still exists. The test harness non-`--fe-payload` path still uses it. Low priority cleanup.

2. **Non-blocking**: The 10/11 regression result reported in doc 34 §9 — was it obtained with or without the multi-layered audit? If without, the first audited run may reveal previously-hidden binding failures. The audit was designed specifically because prior results couldn't be trusted.

3. **Non-blocking**: kappa_lat on mixture paths: one scalar per mixture, or one per alternative? Deferred until single-path validation is complete.

4. **Non-blocking**: Optimal parallel worker count for mixed (uncontexted + contexted) regression runs. 5 workers caused OOM. 3 may be safer. Could also split into two sequential batches (uncontexted at 5 workers, contexted at 2-3).

5. **Non-blocking**: `synth-fanout-context` and `synth-context-solo` were auto-bootstrapped but are pre-existing graphs from earlier R2 work. Verify their truth files are compatible with the current synth gen pipeline and produce meaningful recovery results.
