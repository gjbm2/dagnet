## Context

On 12-Feb-26 we observed **forecasting parity mismatches** in `tmp.log` during the FE↔BE parallel-run comparison. The project policy is that the FE is “right” by default unless we have compelling evidence of a real defect (the “i95 hypothesis”). This note documents what the logs actually show, how `t95`/`path_t95` are produced and persisted today, and why the observed `t95_days` parity mismatches are **not yet** evidence of a modelling defect.

This write-up is designed so the investigation can be resumed in a different dev environment without re-tracing the whole pipeline.


## What was seen in the log (symptoms)

In `tmp.log` there are multiple `FORECASTING_PARITY_*` runs. The important pattern was:

- For many edges, parity reported `t95_days` mismatches of the form:
  - **FE=0** vs **BE>0** (days-scale differences like ~5–23 days)
- Sigma (`sigma`) sometimes had real drift (e.g. ~1.5%–17% depending on edge/onset).
- Evidence diffs were small (typically 0–3 diverging anchor days out of 100), often consistent with retrieved-at timing differences rather than gross semantic disagreement.

Key point: the `t95_days` parity mismatches were systematic and always FE=0, which strongly suggests a **missing/incorrect FE field source** in the parity harness, not a genuine “FE model says t95=0”.


## The critical distinction: “computed t95” vs “persisted horizon t95”

There are two separate notions of “t95” in the FE:

- **Computed / fitted t95 (model output)**: derived during the Stage‑2 topo/LAG pass from evidence moments and fitted \(\mu,\sigma\) (plus onset shifting). This value is *used immediately* in internal computations (e.g. completeness and path logic).

- **Persisted horizon fields**: `edge.p.latency.t95` and `edge.p.latency.path_t95` stored on the graph and/or parameter file metadata. These are treated as “horizons” that:
  - can be overridden/locked via override flags
  - are intentionally not updated in ordinary fetch flows unless explicitly enabled
  - are persisted to parameter files only via explicit “persist horizons” flows

Parity currently reads the **persisted horizon** value, not the Stage‑2 computed value (details below). Therefore “FE=0” in parity can mean “`edge.p.latency.t95` missing → defaulted to 0”, not “computed t95 is 0”.


## How FE computes t95 today (stats engine)

The core model-fit path is in `graph-editor/src/services/statisticalEnhancementService.ts`, in `computeEdgeLatencyStats(...)`.

High-level behaviour:

- Fit a lognormal distribution in model space from (median, mean, effective K).
- Derive a moment-fit t95 from inverse CDF at the configured percentile (usually 0.95).
- Choose an “authoritative t95”:
  - If `edge.p.latency.t95` exists and is finite/positive, it is treated as authoritative.
  - Otherwise fall back to the derived fit t95 (or default horizon).
- Improve the fit using the authoritative t95 constraint (one-way tail pull: sigma may increase).
- Compute final t95 from the improved fit (or authoritative fallback if fit quality is low).

The key code fragment:

- `t95FromFitT` is derived from the moment fit.
- `authoritativeT95TDays` chooses edgeT95 if present, else derived t95.
- final `t95` is computed from improved fit if fit quality is OK.

Therefore, “computed t95” is not generally 0. It is intended to be a positive horizon unless evidence is degenerate.


## How Stage‑2 applies computed t95 to the graph (and when it does not)

Stage‑2 (topo/LAG pass) runs in `graph-editor/src/services/fetchDataService.ts` and applies its results via `UpdateManager.applyBatchLAGValues(...)`.

Important: writing horizons onto the graph is gated by a fetch option:

- `FetchOptions.writeLagHorizonsToGraph?: boolean`
  - default is false
  - explicit flows may set it true

In UpdateManager, `t95` and `path_t95` are only written when this option is enabled:

- When `writeHorizonsToGraph` is false:
  - computed values exist inside the Stage‑2 result, but `edge.p.latency.t95/path_t95` are not updated.
  - other fields (mu/sigma/completeness/etc.) may still be updated.

- When `writeHorizonsToGraph` is true:
  - horizons are written unless locked by override flags (`t95_overridden`, `path_t95_overridden`).

This is an intentional “anti-floatiness” policy: ordinary fetches shouldn’t silently move horizons; horizon movement is meant to be explicit and then persisted.


## How horizons are persisted to parameter files (and when it can be a no-op)

Explicit persistence is done via:

- `lagHorizonsService.recomputeHorizons(...)`:
  - runs Stage‑2 in `from-file` mode with `writeLagHorizonsToGraph: true`
  - then calls `persistGraphMasteredLatencyToParameterFiles(...)`

- `persistGraphMasteredLatencyToParameterFiles(...)` writes **metadata-only** back into parameter files via `dataOperationsService.putParameterToFile(...)`.

Important: persistence intentionally does nothing unless the graph currently has meaningful horizons:

- It only attempts to write t95 when:
  - `latency_parameter === true` AND `lat.t95` is finite and > 0
- It only attempts to write path_t95 when:
  - `lat.path_t95` is finite and > 0

So persistence can be a no-op if the graph doesn’t currently have horizons populated (or they are locked, or absent due to Stage‑2 gating).


## The “daily cycle” / automation path

There is a real “daily” cycle in the repo:

- `dailyRetrieveAllAutomationService` performs:
  - pull → Retrieve All Slices → commit
  - then (best-effort) triggers `lagHorizonsService.recomputeHorizons({ mode: 'global', ... })`

- `retrieveAllSlicesService` also triggers global horizon recompute after a successful run.

Therefore, in the intended operational workflow:

1. Retrieve All populates wide slice coverage
2. Global horizon recompute writes horizons to graph and persists to parameter files
3. Those file horizons then inform planning/staleness/bounding on subsequent runs


## What parity is actually comparing today (root cause of “FE t95=0” mismatches)

Parity uses:

- BE `t95_days`: produced by the backend recompute fitter from snapshot DB evidence.
- FE `t95`: currently sourced from `edge.p.latency.t95` in `lagRecomputeService`, defaulting to 0 when absent.

This means the parity `t95_days` comparison is not “computed FE t95 vs computed BE t95”.
It is “persisted graph horizon t95 (or missing→0) vs BE recompute t95_days”.

Therefore the systematic FE=0 mismatches are consistent with:

- Stage‑2 computed a meaningful t95 internally, but
- horizons were not written to `edge.p.latency.t95` for that run (policy gating), so
- parity read “missing horizon” and coerced it to 0.

This does not yet falsify the i95 hypothesis.


## What the log *does* support as “real drift” vs “instrumentation”

### t95_days mismatches

At present these are most likely **instrumentation / source-of-field** mismatches:

- parity reads `edge.p.latency.t95` (persisted horizon field)
- but FE computed horizons can exist without being written there

Until we confirm that, in the specific parity runs, `writeLagHorizonsToGraph` was true and horizons were not locked, we should not treat t95 mismatches as FE model defects.

### sigma mismatches

Sigma drift is more likely to be real, because sigma is written/used as a model parameter and is not purely a persisted-horizon field. The observed correlation with higher onset values suggests a potential onset-shift parity gap between FE and BE implementations, but this needs controlled evidence to test.


## Open questions / next steps (for resuming later)

1. **Confirm the exact runtime path for the parity runs that showed FE t95=0.**
   - Determine whether parity was triggered by:
     - `fetchDataService` (ordinary fetch) or
     - `lagHorizonsService.recomputeHorizons` (explicit horizons recompute)
   - For the latter, confirm `writeLagHorizonsToGraph` was true, and check whether overrides prevented writes.

2. **Audit whether horizons were actually present on the graph at parity time.**
   - If there is any log signal capturing `edge.p.latency.t95/path_t95` immediately before parity, use that.
   - If not, add instrumentation later (non-user-facing) in the parity harness to log:
     - “computed t95 (Stage‑2 result)” vs “graph horizon t95 (edge.p.latency.t95)”.

3. **Decide what parity should compare for t95.**
   - If parity is intended to validate the fitter, it should compare:
     - BE `t95_days` vs FE *computed* t95 from the same \(\mu,\sigma,\text{onset}\), not the persisted horizon field.
   - If parity is intended to validate persistence semantics, it should be explicit:
     - compare BE `t95_days` to **persisted** horizons only in workflows that promise horizons are written/persisted.

4. **If there is a persistence defect, isolate which condition prevents writes:**
   - `writeLagHorizonsToGraph` not enabled where expected
   - override flags locked (`t95_overridden/path_t95_overridden`)
   - conditional edge path (conditional_p) not handled consistently for horizon writes
   - Stage‑2 computations run but results dropped before UpdateManager write

5. **Re-run a controlled integration scenario (existing tests):**
   - `graph-editor/src/services/__tests__/lagHorizonsService.integration.test.ts` covers the intended contract:
     recompute horizons → write to graph → persist to file respecting overrides.
   - `graph-editor/src/services/__tests__/forecastingParity.queryFlow.snapshotDb.integration.test.ts` validates request shape + parity gating.
   - Extend these tests only after the target behaviour is agreed (avoid weakening; prefer adding assertions).


## Key file pointers

- Parity compare logic: `graph-editor/src/services/forecastingParityService.ts`
- Parity runner / FE model extraction: `graph-editor/src/services/lagRecomputeService.ts`
- Stage‑2 topo/LAG + writeHorizonsToGraph plumbing: `graph-editor/src/services/fetchDataService.ts`
- Horizon recompute + persistence orchestration: `graph-editor/src/services/lagHorizonsService.ts`
- Daily automation invoking global horizon recompute: `graph-editor/src/services/dailyRetrieveAllAutomationService.ts`
- Core t95 derivation: `graph-editor/src/services/statisticalEnhancementService.ts` (`computeEdgeLatencyStats`)
- File persistence plumbing (FileRegistry/IndexedDB): `graph-editor/src/contexts/TabContext.tsx` (`FileRegistry.updateFile`)

