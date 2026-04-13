# Handover: Contexted Regression Suite & Hash Alignment

**Date**: 11-Apr-26
**Branch**: feature/snapshot-db-phase0

---

## Objective

Build contexted variants of the full synth regression suite (7 new graphs) and run param recovery on them, to validate that the Phase C hierarchical Dirichlet/Beta model is stable across all topologies (chain, diamond, join, branch, lattice, skip, 4-step). This is a prerequisite for declaring Phase C complete — the model must not regress on any topology when context slices are added.

During this work, we discovered and partially fixed several defects in the synth_gen tooling, hash infrastructure, and evidence binding pipeline. The blocking issue at session end is a **hash mismatch between synth_gen's CLI call and the standalone CLI call** that prevents the harness from finding snapshot data.

---

## Current State

### Truth files & synth data generation
- **DONE**: 7 contexted truth files created in `nous-conversion/graphs/`:
  - `synth-simple-abc-context.truth.yaml` (2 edges, chain)
  - `synth-diamond-context.truth.yaml` (6 edges, branch+join)
  - `synth-3way-join-context.truth.yaml` (7 edges, 3-way branch+join)
  - `synth-join-branch-context.truth.yaml` (6 edges, join then branch)
  - `synth-lattice-context.truth.yaml` (9 edges, lattice with cross-connections)
  - `synth-mirror-4step-context.truth.yaml` (4 edges, mixed instant/latency)
  - `synth-skip-context.truth.yaml` (4 edges, skip connection)
- **DONE**: All 7 contexted graphs generated with synth_gen, data in DB, verified (all PASS)
- **DONE**: All 11 uncontexted graphs regenerated 3 times (still have hash mismatch — see below)

### Hash alignment
- **BLOCKED**: synth_gen's `_cli_call` (temp dir) and the standalone CLI (`graph-ops/scripts/bayes.sh`) produce **different `core_hash` values** for the same graph. The identity hash (`c` field) now matches after two fixes, but the `core_hash` in the DB (written by synth_gen) still differs from what the harness CLI computes. This means `--fe-payload` mode can't find snapshot data.

### Evidence binding
- **DONE**: `--fe-payload` added to `param_recovery.py` (line 98) so the harness uses the real CLI codepath for payload construction
- **DONE**: `_dump_evidence` in `worker.py` updated to include `slice_groups` and `regime_per_date` (previously only dumped aggregate-level observations)
- **DONE**: `dump_evidence` setting wired through `--fe-payload` path in `test_harness.py` (line 479)
- **IN PROGRESS**: Regime selection discards 100% of rows for uncontexted graphs because candidate regime hashes don't match DB hashes. This is a consequence of the hash mismatch, not a regime selection bug.

### Param recovery
- **DONE**: One successful contexted param recovery on `synth-simple-abc-context` (1047s, PARTIAL — one onset miss out of 24 per-slice params). Demonstrates the model works but is slow.
- **BLOCKED**: Can't run full regression until hash mismatch is resolved.

### Performance
- **DISCOVERED**: Contexted model sampling is ~70x slower than uncontexted for the same graph (965s vs 14s for simple-abc). Root cause: per-slice trajectory Potentials with CDF convolution (6 potentials x ~95 cohort days). Uncontexted model has 0 Potentials — trajectory likelihoods suppressed by branch group Multinomial. This is a pre-existing model architecture issue, not caused by Phase C.
- **DISCOVERED**: Branch group edges have NEVER had CDF-based latency inference. The Multinomial handles p but mu/sigma/onset float on priors. mu recovery has always been a MISS for branch group graphs (confirmed in diamond recovery logs). This predates Phase C.

---

## Key Decisions & Rationale

### 1. Disabled implicit-uncontexted MECE fulfilment in plannerQuerySignatureService.ts
- **What**: Commented out the `candidateContextKeys` block (~lines 258-310) that injected context keys from param file values into bare query signatures
- **Why**: It made bare and context queries produce IDENTICAL `core_hash` values, breaking regime selection which needs distinct hash families. The superset matching in `signatureMatchingService.ts` already handles bare-query-vs-contexted-cache matching.
- **Where**: `graph-editor/src/services/plannerQuerySignatureService.ts` — code is commented out with rationale, not deleted. Imports commented out with `// DISABLED 10-Apr-26` note. Dead variables (`dslTargetDims`, `dslHasAnyContext`, `dslIsCohort`) commented out.
- **Documented**: Anti-pattern #32 in `docs/current/codebase/KNOWN_ANTI_PATTERNS.md`
- **Risk**: If bare-query cache recognition regresses in the FE planner, this is the first place to check. The fix should be in the matching layer, not in signature contamination.

### 2. synth_gen param file connection changed from "synthetic" to graph's defaultConnection
- **What**: Line 2352 of `synth_gen.py` changed from `"connection": "synthetic"` to `"connection": graph_snapshot.get("defaultConnection", "amplitude")`
- **Why**: The `connection` field is included in the signature identity hash. When param files said `synthetic` but the graph said `amplitude`, `selectPersistedProbabilityConfig` would choose differently depending on whether param files were loaded, producing different hashes.
- **Where**: `bayes/synth_gen.py:2352`

### 3. synth_gen temp dir symlinks changed to absolute paths
- **What**: Line 2917 of `synth_gen.py` changed from `os.symlink(src, ...)` to `os.symlink(os.path.abspath(src), ...)`
- **Why**: Relative symlinks in a temp dir don't resolve — the target path is relative to the temp dir, not the CWD. This caused the disk loader to find 0 events, 0 params in the temp dir, producing different event definition hashes and therefore different identity hashes.
- **Where**: `bayes/synth_gen.py:2917`

### 4. --fe-payload is the correct path for param recovery
- **What**: `param_recovery.py` now always passes `--fe-payload` to `test_harness.py`
- **Why**: The old path used `compute_snapshot_subjects.mjs` (a hand-rolled reimplementation of hash computation, anti-pattern #28) which produced different hashes from the real FE code. `--fe-payload` uses the CLI which calls the real `computeQuerySignature`.
- **Where**: `bayes/param_recovery.py:98`
- **Consequence**: All existing uncontexted synth data has hashes from the old mjs script. Must be regenerated with CLI-computed hashes.

### 5. User rejected mece_dimensions guard on regime selection
- **What**: I proposed skipping regime selection when `mece_dimensions` is empty. User rejected this.
- **Why**: The uncontexted case must be handled as a natural degenerate instance of the general case. Regime selection should be a no-op for single-hash-family data, not bypassed. The bug is in hash mismatch, not in running regime selection.
- **Where**: The guard was added and removed in the same session. No residual code.

---

## Discoveries & Gotchas

### Hash mismatch root cause (STILL UNRESOLVED)
The synth_gen CLI call (in temp dir) and the standalone CLI produce different `core_hash` values despite loading the same events, params, and contexts. We proved the identity hash (`c`) now matches after the symlink and connection fixes. But the `core_hash` in the DB (from synth_gen) still differs from the standalone CLI's computation. The investigation showed:
- Both have identical canonical signature strings (`{"c":"0ef8...","x":{}}`)
- Both produce `LgS6UCAxB_VlSijZ` when run in the same test
- But synth_gen's actual DB writes use `gfZyylUNd5PDokof`
- The discrepancy may be a timing issue: synth_gen writes data BEFORE writing param files (Step 3 before Step 4). The CLI call in Step 2 computes hashes without param files loaded. Then Step 4 writes param files with `connection: amplitude`. On subsequent runs, the CLI picks up the updated param file but the hash was already computed without it.
- **Key insight**: the synth_gen pipeline order is Step 2 (compute hashes) → Step 3 (write to DB) → Step 4 (write param files). Step 2's hash doesn't include param file data because param files don't exist yet (or have stale data from a previous run). The standalone CLI reads param files that were written in Step 4 of a previous run.

### FE and CLI use the SAME subject construction code
Both `useBayesTrigger.ts` (FE) and `cli/commands/bayes.ts` (CLI) use identical logic: `explodeDSL` → `buildFetchPlanProduction` per slice → `mapFetchPlanToSnapshotSubjects`. The CLI is NOT a divergent path — it's the same code. The earlier audit finding about `computePlausibleSignaturesForEdge` was wrong — that function is only used on the read path (evidence tooltips, coverage), not the analysis commissioning path.

### Branch group trajectory potentials
Uncontexted graphs have 0 trajectory Potentials because `emit_window_binomial = False` for branch group edges. The Multinomial handles p but no CDF convolution constrains latency. mu recovery has always been a MISS. The contexted per-slice path correctly emits trajectory Potentials (CDF convolution) — which is why it's slow but produces better latency inference.

### synth_gen DB write performance
Bulk INSERT with `execute_values` in 25k-row chunks: ~10s per chunk to managed Postgres. This is network/bandwidth limited. Removing `RETURNING 1` + `fetch=True` was critical — it was causing psycopg2 to wait for 169k ack rows.

### bayes-monitor integration
synth_gen now writes progress to `/tmp/bayes_harness-{graph}.log` in the format the monitor expects: `[{pct:3d}%] {elapsed:6.1f}s {stage}: {detail}`. Lock file at `/tmp/bayes-harness-{graph}.lock` with PID. Monitor stage regex updated to include synth_gen stages.

---

## Relevant Files

### Backend (Python)
- `bayes/synth_gen.py` — Synthetic data generator. Multiple fixes: harness log integration, bulk DB writes, `--bust-cache` flag, absolute symlinks, connection field fix. Core of the hash mismatch issue.
- `bayes/worker.py` — Bayes worker. `_dump_evidence` updated for slice_groups. `mece_dimensions` extraction. Regime selection guard (added then removed per user direction).
- `bayes/param_recovery.py` — Param recovery wrapper. Now passes `--fe-payload` to test_harness.
- `bayes/test_harness.py` — Test harness. `dump_evidence` wired through `--fe-payload` path.
- `bayes/run_regression.py` — Regression orchestrator. Unchanged but affected by `--fe-payload` change.
- `bayes/compiler/model.py` — Model builder. Not changed this session, but investigated for trajectory Potential / Multinomial behaviour.
- `bayes/compiler/evidence.py` — Evidence binder. Not changed this session.
- `graph-editor/lib/snapshot_regime_selection.py` — Regime selection. Not changed; investigated.

### Frontend (TypeScript)
- `graph-editor/src/services/plannerQuerySignatureService.ts` — Signature computation for planner. Implicit-MECE-fulfilment block disabled.
- `graph-editor/src/services/candidateRegimeService.ts` — Candidate regime + MECE dimension construction. Bare regime fallback present (unstaged change from previous session).
- `graph-editor/src/cli/commands/bayes.ts` — CLI bayes command. Uses same codepath as FE (not divergent).
- `graph-editor/src/hooks/useBayesTrigger.ts` — FE bayes trigger. Read for comparison, not changed.
- `graph-editor/src/services/snapshotRetrievalsService.ts` — Read path signatures. `enumeratePlausibleContextKeySets` and `computePlausibleSignaturesForEdge` — read for investigation.

### Scripts
- `scripts/bayes-monitor.sh` — Monitor. Stage regex updated for synth_gen stages.

### Docs
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` — Anti-pattern #32 added (signature contamination from param file values)
- `docs/current/project-bayes/programme.md` — Historical DSL epoch hash discovery added as future work item

### Truth files (all new)
- `nous-conversion/graphs/synth-simple-abc-context.truth.yaml`
- `nous-conversion/graphs/synth-diamond-context.truth.yaml`
- `nous-conversion/graphs/synth-3way-join-context.truth.yaml`
- `nous-conversion/graphs/synth-join-branch-context.truth.yaml`
- `nous-conversion/graphs/synth-lattice-context.truth.yaml`
- `nous-conversion/graphs/synth-mirror-4step-context.truth.yaml`
- `nous-conversion/graphs/synth-skip-context.truth.yaml`

---

## Next Steps

### 1. Resolve the hash mismatch (BLOCKING)
The synth_gen CLI call produces hash X, the standalone CLI produces hash Y, despite identical canonical signatures when tested side-by-side. The most likely cause: **synth_gen Step 2 computes hashes before param files exist** (Step 4 writes them later). The standalone CLI reads param files from a previous run. Even with `connection: amplitude` fixed, some other param file field may affect signature computation.

**Investigation approach**:
1. Add temporary `console.error(JSON.stringify(coreCanonical))` logging to `computeQuerySignature` in `querySignature.ts` to see exactly what inputs differ between the two paths
2. Run synth_gen with this logging, capture coreCanonical from Step 2's CLI call
3. Run standalone CLI, capture coreCanonical
4. Diff the two — the differing field is the root cause

**Alternative approach**: Restructure synth_gen to write param files BEFORE computing hashes (swap Step 2 and Step 4). This ensures the CLI call in Step 2 sees the same param files as the standalone CLI. Risk: Step 4 needs hash_lookup from Step 2 to write `query_signature` into param files, so the ordering is constrained. May need to split Step 4 into "write param files without signatures" then "compute hashes" then "update param files with signatures".

### 2. Verify binding for all graphs after hash fix
Once hashes match, run `--no-mcmc --dump-evidence` on a few representative graphs (diamond, lattice, abc-context) and verify:
- `w_traj > 0` (trajectory data bound, not just aggregate)
- `regime_per_date` is empty or no-op for uniform-epoch graphs
- `slice_groups` populated for contexted graphs
- `endpoint_bb` present for latency edges

### 3. Run full param recovery regression
All 18 graphs (11 uncontexted + 7 contexted). Monitor via `scripts/bayes-monitor.sh --all`. Expected: uncontexted graphs pass as before; contexted graphs show per-slice parameter recovery.

### 4. Investigate trajectory Potential performance
The contexted simple-abc took 17 minutes (965s sampling). This needs investigation:
- Is the CDF convolution implementation efficient? Could it be vectorised across slices?
- Would sharing parent latency vars across slices (rather than independent per-slice latency) reduce model size while preserving p recovery?
- Are the `pt.maximum` clamps (sigma > 0.01, onset > 0) causing gradient discontinuities that inflate tree depth?

### 5. Regenerate contexted graphs after hash fix
The 7 contexted graphs also need regeneration if the hash fix changes their computation (likely since they use the same `_cli_call` code).

---

## Open Questions

1. **BLOCKING**: Why do synth_gen's Step 2 CLI call and the standalone CLI produce different `core_hash` despite identical canonical signatures? See Next Step #1.

2. **Non-blocking**: Should branch group edges have trajectory Potentials for latency inference? Currently they don't (Multinomial only). The per-slice path correctly adds them but makes sampling very slow. This is a model architecture decision.

3. **Non-blocking**: The `compute_snapshot_subjects.mjs` script is now obsolete (synth_gen uses CLI, param_recovery uses `--fe-payload`). Should it be deleted or kept for backward compat? The test harness normal path (non-`--fe-payload`) still uses it.

4. **Non-blocking**: Historical DSL epoch hash discovery — `buildCandidateRegimesByEdge` doesn't inspect stored param file values for historical hash families. Written up in `programme.md` as future work.
