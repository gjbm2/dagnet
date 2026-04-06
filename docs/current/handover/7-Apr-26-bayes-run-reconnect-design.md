# Handover: Bayes Run Reconnect Design & Implementation Plan

**Date**: 6-Apr-26
**Branch**: `feature/snapshot-db-phase0`

---

## Objective

Design and plan the implementation of a mechanism for **resuming in-flight Bayes runs after browser close/reopen**. This is the single blocker before Bayes fits can be integrated into the nightly retrieve-all automation pipeline. Without it, an automated Bayes fit that outlives the browser session produces a patch file in git that is never applied.

The scope covers: reconnect mechanism, patch staleness handling, a `runBayes` graph flag (gating automation), the three-phase automation pipeline (apply pending patches, fetch + commission, drain results), and operational integrity checks.

---

## Current State

| Item | Status |
|------|--------|
| Design doc (`docs/current/project-bayes/28-bayes-run-reconnect-design.md`) | **DONE** — comprehensive, adversarially reviewed, covers all scenarios |
| Implementation plan (`~/.claude/plans/starry-swinging-lovelace.md`) | **DONE** — 5 phases, file-level detail, verification steps |
| Phase 1: `runBayes` schema + UI | **NOT STARTED** |
| Phase 2: `fitted_at_epoch` + extract `applyPatchAndCascade` | **NOT STARTED** |
| Phase 3: Scheduler persistence + reconnect | **NOT STARTED** |
| Phase 4: Automation pipeline (Phase 0/1/2) | **NOT STARTED** |
| Phase 5: Integrity checks (operational health) | **NOT STARTED** |
| Code changes | **NONE** — this session was design and planning only |

The only file created is the design doc at `docs/current/project-bayes/28-bayes-run-reconnect-design.md`. No code was modified.

---

## Key Decisions & Rationale

### 1. Patch file in git is the durable artefact — not IDB, not Modal state

**What**: The webhook commits `_bayes/patch-{job_id}.json` to git regardless of browser state. All recovery paths converge on discovering and applying this file.

**Why**: Git survives everything — browser close, server restart, IDB clear, Modal retention expiry (~24h). Building around the patch file means we don't need complex distributed state tracking. The IDB job record is an optimisation (faster reconnect via status probing), not the source of truth.

**Where**: Design doc sections 3.2, 4.3, 4.4.

### 2. Two-tier cascade (tier 1: IDB/fileRegistry always, tier 2: GraphStore if mounted)

**What**: `applyPatchAndCascade` always writes posteriors to param files and graph `_bayes` block (tier 1). Only if GraphStore is mounted does it do the full cascade (param→edge propagation, latency promotion, GraphStore sync) (tier 2).

**Why**: The scanner must apply patches for graphs that aren't open in a tab. Loading a graph into fileRegistry from IDB is cheap; mounting a GraphStore requires React context. Tier 2 happens naturally when the user opens the graph — the normal graph-open flow calls `getParameterFromFile` per edge.

**Where**: Design doc section 8.2. Implementation plan Phase 2.

### 3. Staleness-discard rule with `fitted_at_epoch`

**What**: When multiple patches exist for the same graph, apply only the newest (highest `fitted_at_epoch`). Delete the rest. If a patch is older than the graph's current `_bayes.fitted_at_epoch`, discard without applying.

**Why**: Each Bayes fit fully supersedes the prior. Applying intermediate patches creates phantom `fit_history` entries. Day-granularity `fitted_at` (UK date format) is insufficient — two fits on the same day produce identical strings. `fitted_at_epoch` (ms since epoch) provides sub-day resolution.

**Where**: Design doc sections 4.4, 4.7, 8.16. Implementation plan Phase 2.

### 4. Write `fitted_at_epoch` last — atomic completion marker

**What**: `applyPatchAndCascade` writes `_bayes.fitted_at_epoch` to the graph as its very last step, after all param files and cascade steps succeed.

**Why**: If the apply crashes mid-cascade, the staleness check still sees the old `fitted_at_epoch` and the patch remains eligible for retry. Prevents partial-apply being marked as complete.

**Where**: Design doc section 8.16 point 3.

### 5. Scanner applies patches for unopened graphs (headless load from IDB)

**What**: The on-pull scanner does NOT skip patches for graphs that aren't open. It loads them from IDB via `fileRegistry.restoreFile()`.

**Why**: The user initially proposed skipping (Q3 in the design doc). After discussion, we agreed that patches represent completed work and should be applied regardless. The data is correct in IDB — the render-tree sync is deferred.

**Where**: Design doc sections Q3 (resolved), 4.4 (headless graph load), 8.2 (tier 1 only).

### 6. `runBayes` flag gates automation, not manual triggers

**What**: New `runBayes?: boolean` on the graph, default false. Only checked by the automation pipeline. The dev-mode manual trigger ignores it.

**Why**: The user explicitly said "I don't think we should assume that we always submit to bayes." The flag mirrors `dailyFetch` but adds a dependency: `runBayes` is disabled when `dailyFetch` is false (structurally impossible to enable Bayes without fetch).

**Where**: Design doc section 10.

### 7. Three-phase automation pipeline

**What**: Phase 0 applies yesterday's pending patches (with 15s countdown). Phase 1 fetches data + commissions Bayes fits per graph. Phase 2 drains results via `Promise.race` on a shrinking pool.

**Why**: The user specifically wanted Bayes commissioned per-graph (not batched after all graphs), but results applied serially at the end. Phase 0 ensures yesterday's posteriors are in place before today's retrieval — the analytics topo pass benefits from having posteriors.

**Where**: Design doc section 11.2.

### 8. Same countdown banner in both manual and automation contexts

**What**: 15-second countdown per patch ("Applying in 15s... [Apply now] [Skip]") in both manual boot and `?retrieveall` Phase 0. Same code path.

**Why**: The user explicitly said "no reason not to use same countdown logic in retrieveall mode. it's harmless. just adds 15s per patch & simpler to test if it's the same code in both places."

**Where**: Design doc section 4.8.

### 9. Automation Manager modal — Option B (extend existing transfer list)

**What**: Add a "Bayes" checkbox per graph on the right (enabled) side of the existing DailyFetchManagerModal. Moving right→left clears both flags.

**Why**: The user agreed Option B was fine. The transfer list handles the dailyFetch toggle, the checkbox handles the runBayes toggle. Invalid state (Bayes without fetch) is structurally impossible.

**Where**: Design doc section 10.3.

---

## Discoveries & Gotchas

- **`getGraphStore(fileId)` returns null for unopened graphs** — it's a module-level Map populated only when `GraphStoreProvider` mounts. You cannot get a live store for a headless graph. Tier 2 cascade must be conditional.

- **`persistJobToIDB` uses a generated jobId** unless `params.jobInstanceId` is set. Without a stable `jobInstanceId`, each status update creates a new IDB record. The `runFn` must set `jobInstanceId` before the first async step.

- **`updatePersistedJobStatus` is private** in jobSchedulerService. The `runFn` must call `db.schedulerJobs.update()` directly to add `modalCallId` after submit returns (the two-phase persist problem).

- **Modal status endpoint retention is ~24h** — after that, the status probe returns 404. The patch file in git is the real recovery mechanism for jobs older than 24h.

- **`fitted_at` in `worker.py` uses ISO format** (`datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")`), not UK date format. The conversion happens downstream. `fitted_at_epoch` should be `int(time.time() * 1000)` set alongside it in both the placeholder (line 339) and real (line 949) paths.

- **Callback token 60-minute expiry** could be exceeded if the automation pipeline hits rate-limit cooldowns (45 minutes). The token must be encrypted per-graph just before submission, not at pipeline start.

- **`fileRegistry.restoreFile(fileId)` tries both unprefixed and workspace-prefixed IDB keys** — pass a `workspace` arg for the prefixed fallback.

- **The `Promise.race` drain pattern** must create polling promises once outside the loop, not re-create per iteration (otherwise N-1 redundant polling loops accumulate). Race on a shrinking array of original promises.

---

## Relevant Files

### Design & Planning
- `docs/current/project-bayes/28-bayes-run-reconnect-design.md` — the full design doc (created this session)
- `~/.claude/plans/starry-swinging-lovelace.md` — the 5-phase implementation plan
- `docs/current/project-bayes/programme.md` — project Bayes status and open items

### Bayes Patch System (Phase 2 primary targets)
- `graph-editor/src/services/bayesPatchService.ts` — `applyPatch`, `fetchAndApplyPatch`, `BayesPatchFile` interface, `mergePosteriorsIntoParam`
- `graph-editor/src/hooks/useBayesTrigger.ts` — current trigger logic, inline cascade (lines 532–618 to be extracted)
- `graph-editor/src/services/bayesService.ts` — `pollUntilDone`, `submitBayesFit`, `pollBayesStatus`, `encryptCallbackToken`
- `graph-editor/api/bayes-webhook.ts` — Vercel webhook, constructs BayesPatchFile from worker result
- `bayes/worker.py` — `fit_graph`, sets `fitted_at` at lines 339 and 949

### Scheduler & Reconnect (Phase 3 primary targets)
- `graph-editor/src/services/jobSchedulerService.ts` — persistent job infrastructure, `reconcilePersistedJobs`, `PersistedJobRecord`, `ReconcileResult`
- `graph-editor/src/services/bannerManagerService.ts` — countdown banner API
- `graph-editor/src/services/operationRegistryService.ts` — toast/progress display
- `graph-editor/src/services/repositoryOperationsService.ts` — `pullLatest`, where on-pull scanner hooks in

### Schema & UI (Phase 1 primary targets)
- `graph-editor/src/types/index.ts` — `GraphData` interface (line 1356), `BayesRunMetadata` (line 822)
- `graph-editor/lib/graph_types.py` — Pydantic model (line 739)
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — JSON schema (line 52)
- `graph-editor/src/components/PropertiesPanel.tsx` — Automation section (lines 2076–2106)
- `graph-editor/src/components/modals/DailyFetchManagerModal.tsx` — transfer-list modal to extend
- `graph-editor/src/services/dailyFetchService.ts` — pattern to mirror for runBayes

### Automation Pipeline (Phase 4 primary targets)
- `graph-editor/src/services/dailyAutomationJob.ts` — `runDailyAutomation`, upfront pull (lines 259–281), per-graph loop (lines 347–399)
- `graph-editor/src/services/dailyRetrieveAllAutomationService.ts` — per-graph sub-service

### Integrity Checks (Phase 5 primary targets)
- `graph-editor/src/services/integrityCheckService.ts` — existing `dailyFetch` check at line 1100
- `graph-editor/src/utils/bayesQualityTier.ts` — thresholds to reuse

### Supporting Context
- `graph-editor/src/contexts/TabContext.tsx` — `fileRegistry` singleton, `restoreFile` (line 833)
- `graph-editor/src/contexts/GraphStoreContext.tsx` — `getGraphStore` module-level function (line 327)
- `graph-editor/src/services/dataOperations/fileToGraphSync.ts` — `getParameterFromFile` (line 65)
- `graph-editor/src/services/fetchDataService.ts` — `persistGraphMasteredLatencyToParameterFiles` (line 2141)
- `graph-editor/src/db/appDatabase.ts` — `db.schedulerJobs` table
- `graph-editor/lib/bayes_local.py` — local dev async transport (in-memory job store)

---

## Next Steps

1. **Start Phase 1** — add `runBayes` field to TypeScript types, Pydantic model, JSON schema, PropertiesPanel checkbox, DailyFetchManagerModal, dailyFetchService, integrity checks, and synth generators. This is small and standalone. Run `dailyFetchService.test.ts` to verify.

2. **Phase 2** — add `fitted_at_epoch` to worker, webhook, and `BayesPatchFile`. Extract `applyPatchAndCascade` from `useBayesTrigger`. Add `scanForPendingPatches`. Add fingerprint dedup in `mergePosteriorsIntoParam`. Write tests for staleness-discard and tier-1-only apply.

3. **Phase 3** — create `bayesReconnectService.ts` with job registration, `runFn` (fresh submit + resume modes), `reconcileFn` (three-step probe). Wire into `useBayesTrigger`. Hook scanner into `repositoryOperationsService` after pull.

4. **Phase 4** — add Phase 0/1/2 to `dailyAutomationJob.ts`. Gate Phase 1 commission on `graph.data?.runBayes`. Implement `Promise.race` drain with 30-minute timeout.

5. **Phase 5** — add operational health checks to `integrityCheckService.ts`.

---

## Open Questions

- **None blocking.** All design questions were resolved during the session. The implementation plan is ready to execute starting from Phase 1.
