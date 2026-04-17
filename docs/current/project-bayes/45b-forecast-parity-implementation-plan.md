# 45b — Forecast Parity: Implementation Plan

**Date**: 17-Apr-26
**Parent**: doc 45 (Forecast Parity Design)
**Status**: Plan — awaiting approval

## Current state of the branch

All changes are uncommitted on `feature/snapshot-db-phase0`. Two
sessions of work are interleaved:

### Previous session (valuable, keep)

These changes fix real defects in the v3 handler, regime selection,
and data repo. They are correct and tested.

- **`_apply_temporal_regime_selection`** in `api_handlers.py` (~70
  lines, line 1163): reorders candidate regimes by temporal mode
  preference, delegates to `select_regime_rows`. Used by both v2 and
  v3 handlers. Fixes the fundamental defect where window and cohort
  evidence were mixed.

- **Temporal mode on `CandidateRegime`** in
  `snapshot_regime_selection.py`: added `temporal_mode: str = ''`
  field. `analysis_subject_resolution.py` propagates it.

- **`candidateRegimeService.ts`** temporal mode separation: emits
  separate candidates per (key-set x temporal mode). Window and
  cohort never grouped as equivalents. `equivalent_hashes: []` on
  mode-specific candidates (prevents closure cross-contamination).

- **v3 handler** diagnostic output: regime selection trace, hash
  counts, `_emit_diagnostics` flag for BE-side diagnostics.

- **v3 tau_max fix** in `cohort_forecast_v3.py` (line ~207-237):
  2x t95 floor, hard minimum of 100, reads promoted_path_t95.

- **CLI diagnostic infrastructure**: `isDiagnostic()`, `log.diag()`,
  `_diagnostics` flag threading through graphComputeClient.

- **hash-mappings.json**: removed 8 cross-temporal mappings in the
  data repo.

- **`graphComputeClient.ts`**: `diagnosticsRequested` flag,
  `_diagnostics` preserved through normalisation.

### This session (partially revert)

- **`build_cohort_evidence_from_frames` / `FrameEvidence`** in
  `cohort_forecast_v3.py` (~200 lines): shared function extracted
  from v3. v3 now calls it. **KEEP** — clean refactoring, reduces
  duplication within v3, and will be needed by the BE conditioned
  forecast (Job B).

- **`_build_sweep_params_for_edge`** in `api_handlers.py` (~160
  lines): builds span kernel + carrier for the topo pass. **REVERT**
  — this is the wrong approach (parallel codepath).

- **Topo pass snapshot DB path** in `handle_stats_topo_pass` (~120
  lines): parses `snapshot_evidence`, queries DB, derives frames,
  builds CohortEvidence, runs sweep with span kernel. **REVERT** —
  forecasting doesn't belong in the topo pass.

- **Topo pass scope change**: `scope='edge'` (was `scope='edge' if
  is_window else 'path'`). **REVERT** — restore baseline behaviour.

- **CLI `topoPass.ts`**: added `workspace` param, candidate regime
  computation, `snapshot_evidence` in request body, snapshot count
  in log output. **REVERT** the snapshot evidence parts. Keep the
  `workspace` param (harmless, may be useful later).

- **CLI callers** (`paramPack.ts`, `analyse.ts`, `hydrate.ts`):
  added `workspace` to `runCliTopoPass` calls. **REVERT** to match.

## Implementation sequence

### Step 1: Revert topo pass to baseline

Restore `handle_stats_topo_pass` Phase 2 to its HEAD state. This
means:

**In `api_handlers.py`:**
- Remove `_build_sweep_params_for_edge` function entirely
- Remove all `snapshot_evidence` parsing (snap_ev, snap_regimes,
  snap_anchor_from/to, snap_sweep_from/to, `_has_snapshot_evidence`)
- Remove `build_cohort_evidence_from_frames` import
- Remove `derive_cohort_maturity` import
- Remove `query_snapshots_for_sweep` import
- Remove `from datetime import date as _date_cls` import
- Remove `_anchor_node_id` computation
- Restore the single-point CohortEvidence construction from baseline
  (reading from param file cohorts, `frontier_age=0 if is_window else
  age_i`, `eval_age=age_i`)
- Restore coordinate B read via `sweep.cohort_evals`
- Restore `scope='edge' if is_window else 'path'`
- Restore `max_tau=max_age` (remove 2×t95 floor — that belongs in
  v3, not the topo pass)
- Remove `_fs_snapshot_count` tracking and related log output

**In `topoPass.ts`:**
- Remove `workspace` parameter from `runCliTopoPass`
- Remove `buildCandidateRegimesByEdge` / `filterCandidatesByContext`
  imports and calls
- Remove `snapshotEvidence` construction
- Remove `snapshot_evidence` from request body
- Remove `snapCount` from log output
- Restore original log line

**In callers:**
- `paramPack.ts`: revert to `const { bundle, queryDsl, getKey,
  format, flags } = ctx` and `runCliTopoPass(populatedGraph,
  bundle.parameters, queryDsl)`
- `analyse.ts`: revert to `runCliTopoPass(baseGraph,
  bundle.parameters, queryDsl)`
- `hydrate.ts`: revert to `const { bundle, queryDsl, flags } = ctx`
  and `runCliTopoPass(populatedGraph, bundle.parameters, queryDsl)`

**Verification**: run `param-pack` and confirm the topo pass output
matches what HEAD produced (same p.mean values as before this
session). The numbers will be the degraded forecast (the known
defect) — that's intentional; the proper fix is Step 3.

### Step 2: Commit the valuable work

Commit everything that ISN'T the topo pass rewrite:
- Temporal regime selection (`_apply_temporal_regime_selection`)
- `CandidateRegime.temporal_mode`
- `candidateRegimeService.ts` temporal mode separation
- v3 handler diagnostics
- v3 tau_max fix
- `build_cohort_evidence_from_frames` / `FrameEvidence` extraction
- CLI diagnostic infrastructure
- `graphComputeClient.ts` diagnostics flag
- hash-mappings.json fix
- doc 45 design doc

### Step 3: Implement BE conditioned forecast (Job B)

This is the new work. The conditioned forecast is a **graph
enrichment endpoint** — not an analysis type. It produces per-edge
scalars written back to the graph, using the analysis contract's
data pipeline (snapshot subjects, scenarios, regime selection).

**3a. Register endpoint**

- New route: `POST /api/forecast/conditioned`
- Registered in the Flask/FastAPI router alongside
  `/api/lag/topo-pass`
- NOT routed through `handle_runner_analyze` — standalone handler
- Contract: receives scenarios with graphs, candidate regimes,
  temporal DSL. Returns per-edge per-scenario scalars.

**3b. Implement BE handler**

`handle_conditioned_forecast` in `api_handlers.py`. Per scenario:

1. Subject resolution: `resolve_analysis_subjects` +
   `synthesise_snapshot_subjects` (same as v3)
2. Per subject: `query_snapshots_for_sweep` → regime selection →
   `derive_cohort_maturity` (same as v3)
3. Frame composition: `compose_path_maturity_frames` (same as v3)
4. Evidence building: `build_cohort_evidence_from_frames` (shared
   function from Step 2)
5. Span kernel + carrier: same construction as v3 handler (lines
   2002-2180 of current api_handlers.py). Extract into a shared
   preparation function that both v3 and conditioned_forecast call.
6. Engine call: `compute_forecast_sweep` with full arguments (same
   14 parameters as v3)
7. Read per-edge scalars from sweep: p.mean = median(rate_draws[:,
   -1]), p_sd = std(rate_draws[:, -1]), completeness, completeness_sd.

Steps 1-6 are the v3 handler code. Step 7 reads scalars instead of
building chart rows — the only new logic.

The shared preparation function (step 5) should be extracted from
the v3 handler into a module-level function. Both v3 and the
conditioned forecast call it.

**3c. Wire FE trigger**

- The current BE topo pass trigger mechanism (~500ms after graph
  open, cancellation on navigation, update-on-arrival) moves to
  drive `/api/forecast/conditioned` instead
- BE topo pass retriggers to fire immediately alongside the FE topo
  pass (same commissioning event)
- When the conditioned forecast result arrives, overwrite p.mean
  (and p_sd, completeness) on each edge per scenario
- FE preparation reuses `analysisComputePreparationService` to
  build candidate regimes and scenario payloads — same preparation,
  different endpoint

**3d. Wire CLI**

- `param-pack` calls the topo pass (Job A) for model vars — no
  change from Step 1
- To get the conditioned p.mean, call `analyse --type graph_forecast`
  (Job B) — this is a new CLI invocation, not a modification of
  param-pack
- The `analyse` command already supports arbitrary `--type` values;
  it dispatches through the same `prepareAnalysisComputeInputs` →
  `runPreparedAnalysis` pipeline

### Step 4: Retire the topo pass forecast sweep

Once Step 3 is live and verified:
- Remove the entire Phase 2 section from `handle_stats_topo_pass`
  (the single-point CohortEvidence → sweep → coordinate B read)
- The topo pass returns stats engine output only: mu, sigma, t95,
  completeness (CDF-based), blended_mean (stats engine's own blend),
  p_infinity, p_evidence, dispersions
- Remove `compute_forecast_sweep` / `CohortEvidence` /
  `NodeArrivalState` / `build_node_arrival_cache` imports from the
  topo pass handler
- FE-displayed p.mean comes from the `graph_forecast` result

This is a clean removal — no new code, just deletion. The topo pass
becomes what it was always meant to be: a stats engine pass that
generates model vars.

## Sequencing constraints

- Step 1 before Step 2: revert first so the commit is clean
- Step 2 before Step 3: the shared function
  (`build_cohort_evidence_from_frames`) and temporal regime
  machinery must be committed before the BE forecast handler uses
  them
- Step 3 before Step 4: the BE forecast must be live before the
  topo pass forecast is removed, otherwise p.mean regresses to the
  stats engine's CDF-blend (less accurate)
- Steps 3a-3d can be done incrementally: register type, implement
  handler, wire FE, wire CLI

## What the user sees at each step

| Step | p.mean on graph | Quality |
|------|----------------|---------|
| After Step 1 | Topo pass degraded forecast (coordinate B, single-point, no span kernel) | Known defect — the number that prompted this investigation |
| After Step 2 | Same | No user-visible change |
| After Step 3 | BE conditioned forecast via `graph_forecast` (~500ms after graph open) | Full MC population model, same as v3 p@infinity. Design invariant met. |
| After Step 4 | Same as Step 3 | Topo pass no longer attempts to forecast. Clean separation. |

## Risk assessment

- **Step 1** (revert): low risk, restores known state
- **Step 2** (commit): low risk, tested changes
- **Step 3** (new handler): medium risk — new analysis type, new
  trigger wiring. Mitigated by reusing v3's tested pipeline almost
  entirely. The shared preparation function is the main new code.
- **Step 4** (retire): low risk, pure deletion — only safe once
  Step 3 is verified
