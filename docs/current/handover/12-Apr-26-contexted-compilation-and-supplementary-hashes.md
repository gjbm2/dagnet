# Handover: Contexted Model Compilation Fix & Supplementary Hash Family Discovery

**Date**: 12-Apr-26
**Branch**: `feature/snapshot-db-phase0`

---

## Objective

Fix the crash that occurs when running the Phase C contexted regression suite. Every attempt to run contexted graphs (synth-simple-abc-context, synth-diamond-context, synth-lattice-context, etc.) via `run_regression.py` caused WSL to crash with `E_UNEXPECTED / Catastrophic failure`. The graphs never left the "compiling" stage — PyTensor C compilation of the per-slice trajectory Potentials exhausted memory, killing the entire WSL VM.

Secondary objective: close the design gap documented in programme.md lines 1310-1330 ("Historical DSL epoch hash discovery for Bayes") — the Bayes commissioning path only enumerated hash families from the current DSL, missing data stored under alternative context configurations.

---

## Current State

### Batched trajectory Potentials — DONE (uncommitted)

**Problem**: For contexted graphs, the model created S separate trajectory `pm.Potential` terms per edge (one per context slice), each with its own independent CDF symbolic subgraph. For synth-lattice-context (9 edges x 3 slices), that's ~54 Potentials with ~54 independent CDF computations. PyTensor C compilation cost is super-linear in graph width — this OOM'd the WSL VM.

**Fix**: New function `_emit_batched_slice_trajectories` in `model.py` vectorises the CDF computation across all slices of one edge. Per-slice `onset/mu/sigma/p` variables are stacked into `(S,)` tensors, per-interval values are expanded via index lookup, and one CDF + one `pm.Potential` is emitted per edge per obs_type. Mathematically identical posterior — same per-slice variables, same gradients, same log-likelihood sum. The PyTensor graph goes from O(E*S) CDF subgraphs to O(E).

**Files changed**:
- `bayes/compiler/model.py` — `_emit_batched_slice_trajectories` (new function, ~180 lines before `_emit_edge_likelihoods`), `skip_trajectory_potentials` parameter threaded through `_emit_edge_likelihoods` and `_emit_cohort_likelihoods`, emission loop in `build_model` Section 5 restructured to split per-slice and aggregate emission
- Per-slice emissions call `_emit_edge_likelihoods` with `skip_trajectory_potentials=True` (daily obs, window Binomials, endpoint BBs still emitted per-slice — they're cheap native PyMC distributions)
- Aggregate emission (when not all exhaustive) uses `skip_trajectory_potentials=False` (full emission)

**Test status**: 20/20 compiler phase tests pass (phase_a, phase_b, phase_s), 59/59 adversarial binding tests pass, 20/20 regression audit tests pass. These are all uncontexted — the batched path is NOT exercised by existing tests. A synthetic compilation test (1 edge x 3 slices) confirmed the batched path produces 1 Potential instead of 3 and compiles in 2.5s.

**NOT YET VERIFIED**: Full PyTensor C compilation + MCMC sampling on a real contexted graph. This is the critical next step.

### Supplementary hash family discovery — DONE (uncommitted)

**Problem**: When a bare (uncontexted) DSL is used on a graph with contexted snapshot data, the CLI generates subjects with bare core_hashes. These don't match the contexted core_hashes under which synth_gen stored the data. Result: 0 rows returned, evidence binding falls back to param files.

**Root cause**: `buildCandidateRegimesByEdge` only enumerated hash families from the current pinned DSL. The read path (`enumeratePlausibleContextKeySets` in `snapshotRetrievalsService.ts`) already solved this by scanning stored param file `values[]` entries — but this wasn't used in the Bayes commissioning path.

**Fix**: Added Step 5 to `buildCandidateRegimesByEdge` — after the current DSL-based enumeration (Step 3) and bare fallback (Step 4), scans param file `values[]` to discover additional context key-sets. For each new key-set, synthesises a contexted DSL slice, computes the signature + core_hash, and adds as a candidate regime. Supplementary snapshot subjects are also added in `bayes.ts` so the DB query fetches all relevant rows.

**Files changed**:
- `graph-editor/src/services/candidateRegimeService.ts` — `buildCandidateRegimesByEdge` now accepts optional `parameterFiles` parameter; Step 5 added (~60 lines) after Step 4
- `graph-editor/src/services/snapshotRetrievalsService.ts` — `enumeratePlausibleContextKeySets` exported (was module-private)
- `graph-editor/src/cli/commands/bayes.ts` — passes `parameterFiles` to `buildCandidateRegimesByEdge`; Section 6b adds supplementary snapshot subjects for new candidate regimes not covered by DSL-based subjects

**Verified**: `synth-simple-abc-context` with `--dsl-override "window(12-Dec-25:21-Mar-26);cohort(12-Dec-25:21-Mar-26)"` now fetches 29,250 context-qualified rows (previously 0), MECE-aggregates them into bare totals, builds 2 aggregate trajectory Potentials, compiles + samples in 61s, and recovers all parameters correctly (PASS — all within threshold).

### `--dsl-override` flag — DONE (uncommitted)

Threaded through all three levels: `run_regression.py` → `param_recovery.py` → `test_harness.py`. Temporarily patches the graph JSON's `pinnedDSL` before CLI payload construction, restores after (in a `finally` block).

**Files changed**:
- `bayes/test_harness.py` — `--dsl-override` argument added; patches graph JSON before `_build_payload_via_cli`, restores in `finally`
- `bayes/param_recovery.py` — `--dsl-override` argument forwarded to harness
- `bayes/run_regression.py` — `--dsl-override` argument forwarded to param_recovery; threaded through `_run_one_graph`

---

## Key Decisions & Rationale

### 1. Vectorise across slices, not restructure the model

**What**: Batch per-slice trajectory data into one Potential per edge per obs_type, rather than changing the model architecture (e.g., shared latency across slices).

**Why**: Lossless — mathematically identical posterior. The per-slice variables (eps_mu_slice, eps_sigma_slice, etc.) are still created individually. Only the trajectory Potential is batched. No model semantics change.

**Where**: `bayes/compiler/model.py`, `_emit_batched_slice_trajectories` function.

### 2. Skip trajectory Potentials via flag, not by restructuring emission functions

**What**: Added `skip_trajectory_potentials` parameter to `_emit_cohort_likelihoods` rather than splitting the function or removing the trajectory loop.

**Why**: Minimal change to existing code. The flag adds a `continue` at the top of the trajectory loop. All other emissions (daily BetaBinomial, window Binomial, endpoint BB) still run per-slice — they're cheap native PyMC distributions and don't cause compilation issues.

**Where**: `_emit_cohort_likelihoods` (line ~1693 `if not _do_trajectory_potentials: continue`), threaded through `_emit_edge_likelihoods` to all 4 call sites.

### 3. Supplementary hashes in `buildCandidateRegimesByEdge`, not in `bayes.ts`

**What**: The regime builder owns all hash family enumeration logic. Step 5 is co-located with Steps 3-4 rather than bolted onto the CLI.

**Why**: The regime builder already has the bare fallback (Step 4). The supplementary discovery generalises the same pattern. Both candidate regimes AND snapshot subjects benefit — the worker queries the DB with all known hash families.

**Where**: `candidateRegimeService.ts` Step 5. `bayes.ts` Section 6b only adds supplementary snapshot subjects for regimes not covered by DSL-based subjects.

### 4. The core_hash IS different between bare and contexted DSLs

**What**: Despite `normalizeOriginalQueryForSignature` stripping context from `original_query`, bare and contexted DSLs produce different core_hashes.

**Why**: The user confirmed this from experience. The exploration agent's analysis claimed they should be identical (because context is stripped from `original_query` before hashing), but empirically the hashes differ — the bare DSL returned 0 rows. The exact divergence point in the signature computation was not identified in this session. Candidates: `contextDefHashes` leaking into core hash, event definition loading differences, or `buildFetchPlanProduction` producing different `queryPayload` structures.

**Where**: `querySignature.ts` `computeQuerySignature` — needs further investigation to identify the exact field that differs.

### 5. BetaBinomial gammaln graph is the likely C compilation bottleneck

**What**: With `latency_dispersion=true`, each trajectory Potential uses `pm.BetaBinomial.dist()` + `pm.logp()` which expands to 9 gammaln evaluations per interval. For S slices × T trajectories × A ages, that's `9 * S * T * A` gammaln nodes in the symbolic graph, each requiring digamma (polygamma) for gradient computation.

**Why**: Uncontexted simple-abc (2 Potentials, no BetaBinomial per-slice) compiles in seconds. The contexted version (6+ Potentials with per-slice BetaBinomial) crashes WSL. The batched version reduces Potentials from 6 to 2 but each batched Potential still has a large BetaBinomial graph. Whether this is sufficient to prevent the OOM is the key unknown — the next step tests this.

**Where**: `model.py` `_emit_batched_slice_trajectories` lines where `_use_kappa_lat` creates BetaBinomial.

---

## Discoveries & Gotchas

### WSL crash is OOM during PyTensor C compilation, not during MCMC

The "compiling" stage in the harness log corresponds to PyTensor compiling the symbolic graph to C code for NUTS sampling. This happens inside `pm.sample()`, not `build_model()`. `build_model()` constructs the symbolic graph (fast — 2.5s). The C compilation of `dlogp` (gradient function) is what OOMs because each Potential's gradient must propagate through the full CDF + BetaBinomial symbolic subgraph w.r.t. all ~44 free variables.

### `has_slices` is an explicit bool field, not derived from `slice_groups`

`EdgeEvidence.has_slices` (types.py line 286) is a separate `bool = False` field. It's not auto-computed from `slice_groups`. The evidence binder sets it explicitly. Synthetic tests must set it manually or the per-slice code path won't be entered.

### `enumeratePlausibleContextKeySets` was module-private

The function existed and was tested on the read path but wasn't exported. Now exported from `snapshotRetrievalsService.ts` for use by `candidateRegimeService.ts`.

### The `--dsl-override` patches the graph JSON file on disk

The override modifies `nous-conversion/graphs/{name}.json` temporarily (writes, calls CLI, restores in `finally`). This is safe for single-process runs but not for parallel runs on the same graph. The data repo is git-excluded so uncommitted changes to the JSON are harmless.

### Bare DSL override produces correct aggregated recovery

`synth-simple-abc-context` with bare DSL override: 29,250 context-qualified rows fetched, MECE-aggregated into bare totals, 383+381 trajectories bound, 2 Potentials, 61s total, all parameters recovered within threshold. This confirms the MECE aggregation pipeline is correct end-to-end.

---

## Relevant Files

### Backend (Python — Bayes)

- `bayes/compiler/model.py` — Model builder. `_emit_batched_slice_trajectories` (new), `skip_trajectory_potentials` parameter added to `_emit_cohort_likelihoods` and `_emit_edge_likelihoods`, emission loop restructured in `build_model` Section 5. Core of the compilation fix.
- `bayes/compiler/types.py` — `EdgeEvidence.has_slices` field (line 286). Not changed but critical to understand — it's a bool, not derived.
- `bayes/compiler/evidence.py` — Evidence binder. Not changed. MECE aggregation (lines 516-605), `_route_slices` (lines 1571-1718). Already handles bare-on-contexted correctly.
- `bayes/run_regression.py` — `--dsl-override` argument added, threaded through `_run_one_graph`.
- `bayes/param_recovery.py` — `--dsl-override` argument forwarded to harness.
- `bayes/test_harness.py` — `--dsl-override` argument. Patches graph JSON's `pinnedDSL` before CLI call, restores in `finally`. Graph JSON found via `nous-conversion/graphs/{name}.json`.

### Frontend (TypeScript)

- `graph-editor/src/services/candidateRegimeService.ts` — `buildCandidateRegimesByEdge` now accepts `parameterFiles`. Step 5 discovers supplementary hash families from stored param file `values[]` entries.
- `graph-editor/src/services/snapshotRetrievalsService.ts` — `enumeratePlausibleContextKeySets` now exported (was module-private).
- `graph-editor/src/cli/commands/bayes.ts` — Passes `parameterFiles` to regime builder. Section 6b adds supplementary snapshot subjects for new candidate regimes.

### Tests

- `bayes/tests/test_compiler_phase_a.py` — 7 tests, all pass. Uncontexted only.
- `bayes/tests/test_compiler_phase_b.py` — 7 tests, all pass. Uncontexted only.
- `bayes/tests/test_compiler_phase_s.py` — 7 tests, all pass. Uncontexted only.
- `bayes/tests/test_data_binding_adversarial.py` — 59 tests, all pass. Includes MECE aggregation tests but none exercise `has_slices=False` assertion for bare-on-contexted scenario.
- `bayes/tests/test_regression_audit.py` — 20 tests, all pass.

### Docs

- `docs/current/project-bayes/programme.md` — Lines 1310-1330 document the design gap. Step 5 of `buildCandidateRegimesByEdge` closes it.

---

## Next Steps

### 1. Run contexted graph with full contexted DSL (IMMEDIATE — the critical test)

This is the test that determines whether the batched trajectory fix resolves the WSL crash. Run `synth-simple-abc-context` with its original contexted DSL (no override), `latency_dispersion=true`, minimal draws, single chain, 10-minute timeout:

```
python bayes/param_recovery.py --graph synth-simple-abc-context \
  --feature latency_dispersion=true --draws 500 --tune 250 --chains 1
```

**Watch for**: Does it leave "compiling" stage? If it compiles but is slow (>2 min), the batched Potential is still large. If it crashes, the BetaBinomial gammaln graph in the batched Potential is still too large and we need to disable `latency_dispersion` for per-slice Potentials.

**Fallback if still crashes**: Run without `latency_dispersion` (`--feature latency_dispersion=false`). This removes the BetaBinomial from trajectory Potentials, using plain Binomial logp instead (much smaller symbolic graph). If this compiles, the bottleneck is confirmed as BetaBinomial gammaln in per-slice Potentials.

### 2. If compilation succeeds: run full contexted regression

All 10 contexted graphs, 3 parallel, with auditing:

```
python bayes/run_regression.py --include context --max-parallel 3 \
  --feature latency_dispersion=true --clean
```

### 3. If compilation fails: disable latency_dispersion for per-slice Potentials

In `_emit_batched_slice_trajectories`, force `_use_kappa_lat = False` regardless of the feature flag. This makes per-slice trajectories use plain Binomial logp (cheap) while aggregate trajectories (uncontexted path) still use BetaBinomial. Test whether this compiles.

### 4. Commit all changes

Once the regression confirms no breakage:
- `bayes/compiler/model.py` — batched trajectory Potentials
- `bayes/test_harness.py`, `bayes/param_recovery.py`, `bayes/run_regression.py` — `--dsl-override`
- `graph-editor/src/services/candidateRegimeService.ts` — Step 5 supplementary hashes
- `graph-editor/src/services/snapshotRetrievalsService.ts` — export
- `graph-editor/src/cli/commands/bayes.ts` — parameterFiles passthrough + Section 6b

### 5. Update programme.md

Mark the "Historical DSL epoch hash discovery for Bayes" item (lines 1310-1330) as resolved. Reference Step 5 of `buildCandidateRegimesByEdge` and the `enumeratePlausibleContextKeySets` integration.

---

## Open Questions

1. **BLOCKING**: Does the batched trajectory Potential compile for contexted graphs? The batched version still has a large BetaBinomial symbolic subgraph (all slices' intervals in one array). If it still OOMs, the fix is to disable `latency_dispersion` for per-slice Potentials specifically.

2. **Non-blocking**: What exact field in `computeQuerySignature`'s canonical signature differs between bare and contexted DSLs? The `normalizeOriginalQueryForSignature` strips context from `original_query`, but the hashes empirically differ. The supplementary hash discovery sidesteps this question, but understanding it would help with future hash infrastructure work.

3. **Non-blocking**: Should `_emit_batched_slice_trajectories` handle cohort trajectories (Phase 2) in addition to window trajectories (Phase 1)? Currently it handles both obs_types in its loop, but Phase 1 per-slice emission skips cohort trajectories (`skip_cohort_trajectories=True`). Phase 2 per-slice emission is untested.

4. **Non-blocking**: The `--dsl-override` flag patches the graph JSON on disk, which is not safe for parallel runs on the same graph. Should it use a temp copy instead?
