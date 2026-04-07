# 28. Bayes Run Reconnect Design

**Status**: Implemented (7-Apr-26)
**Date**: 6-Apr-26
**Purpose**: Design for resuming in-flight Bayes runs after browser
close/reopen. Gates integration of Bayes into the retrieve-all automation
pipeline.

**Amendments (7-Apr-26)**:
- **`fitted_at_epoch` dropped.** The existing `fitted_at` field uses
  ISO 8601 format (`YYYY-MM-DDTHH:MM:SSZ`) with second precision —
  sufficient for staleness comparison (two fits within the same second
  is impossible). All references to `fitted_at_epoch` below should be
  read as `fitted_at` (ISO string, lexicographic comparison). No new
  field is needed; adding one would create a competing source of truth.
- **§8.5 fingerprint dedup deferred** to topology signatures work
  (doc 10). The per-graph mutex + `fitted_at` staleness check are
  sufficient. See §8.5 for detail.

## 1. Problem Statement

When a Bayes fit is submitted, the FE tracks the job entirely in React
`useState` (`useBayesTrigger`). If the browser tab closes:

- The `jobId` is lost (no IDB persistence).
- Polling stops.
- The worker continues running (Modal: until completion/timeout; local:
  until server restarts).
- The webhook commits `_bayes/patch-{job_id}.json` to git regardless.
- On browser reopen, there is no code path to discover or apply the
  orphaned patch.

This is the single blocker before Bayes can run as a follow-on step in
retrieve-all automation. Without reconnect, an automated Bayes fit that
outlives the browser session produces a patch file that sits in git
indefinitely, never applied.

## 2. Scenarios

**Scenario A — Run completes while browser is closed.**
Worker finishes, webhook commits the patch file to git, browser is not
there to poll or apply. On next browser open, the patch is sitting in
the repo.

**Scenario B — Browser reopens while run is still in progress.**
Modal job is still running. On browser open, we need to resume polling
and, once complete, apply the patch.

**Scenario C — Run fails while browser is closed.**
Worker errors, no patch file is written. On browser open, we need to
surface the failure rather than silently drop it.

**Scenario D — Multiple runs from different sessions.**
User triggers a fit, closes browser, opens browser, triggers another
fit. The first run's patch may arrive while the second is in-flight.
Must not conflict.

## 3. Existing Infrastructure

### 3.1 jobSchedulerService — persistent job support

The scheduler already supports exactly this pattern:

- **`persistent: true`** on a job definition causes state transitions
  (`submitted`, `running`, `complete`, `error`) to be written to IDB
  (`db.schedulerJobs`).
- **`reconcileFn(record)`** is called on boot for any persisted job
  found in `submitted` or `running` state. It returns a
  `ReconcileResult` with `status`, optional `pullAfter`, `result`, or
  `error`.
- **`pullAfter`** in `ReconcileResult` triggers an automatic
  `repositoryOperationsService.pullLatest()` after reconciliation — the
  scheduler already has pull-lock acquisition built in.
- **`PersistedJobRecord.params`** — an opaque `Record<string, unknown>`
  stored alongside the job, available to `reconcileFn` on boot.

The scheduler was designed with Bayes as a primary use case (the code
comments cite `bayes-fit:graph-x:1710720000000` as an example). It has
never been wired up.

### 3.2 Patch file model

The webhook writes `_bayes/patch-{job_id}.json` to git. This is durable:
it survives browser close, server restart, and local state loss. The
patch file contains everything needed to apply posteriors
(`BayesPatchFile` shape in `bayesPatchService.ts`).

`fetchAndApplyPatch` in `bayesPatchService.ts` already handles:
fetch-from-GitHub, `applyPatch` (upsert into param files + graph), and
delete-from-git (cleanup commit). This is the only apply path today.

### 3.3 Modal status endpoint

`GET /api/bayes/status?call_id={jobId}` returns the job's current state.
For Modal jobs, this survives browser close — Modal tracks the job
independently. For local dev, the in-memory `_jobs` dict is lost on
Python server restart but survives browser close if the server stays up.

## 4. Design

### 4.1 Overview

Wire `useBayesTrigger` into the scheduler as a `persistent` job. On
submit, persist the job to IDB with enough params to reconcile on boot.
On boot, the scheduler's existing reconciliation loop calls our
`reconcileFn`, which checks Modal status and/or scans for orphaned
patch files.

Additionally, after every git pull, scan for orphaned `_bayes/patch-*`
files as a belt-and-suspenders catch-all.

### 4.2 Persisted job params

When a Bayes job is submitted, persist these params alongside the job
record:

```
{
  modalCallId: string;        // The call_id returned by submit
  computeMode: 'local' | 'modal';
  graphId: string;            // e.g. 'graph-my-funnel'
  graphFilePath: string;      // e.g. 'graph-my-funnel.yaml'
  repo: string;               // e.g. 'owner/repo'
  branch: string;             // e.g. 'main'
  patchPath: string;          // e.g. '_bayes/patch-{jobId}.json'
  statusUrl?: string;         // Override for local dev
  webhookUrl: string;         // For diagnostic logging
  submittedAtIso: string;     // ISO timestamp for age checks
}
```

### 4.3 reconcileFn logic

Called on boot for each persisted Bayes job in `submitted`/`running`
state. Three-step probe:

**Step 1 — Probe Modal/local status.**
Call `pollBayesStatus(params.modalCallId, params.statusUrl)`.

- If response is `complete` with result payload → go to Step 2, carrying
  the result.
- If response is `running` → return `{ status: 'running' }`. The
  scheduler logs this; a follow-up mechanism (see §4.5) resumes polling.
- If response is `failed` → return `{ status: 'error', error }`.
- If the probe itself fails (network error, 404, local server not
  running) → go to Step 2 with no result payload (optimistic: maybe
  the job finished and the status endpoint is gone).

**Step 2 — Check for patch file in git.**
Call GitHub Contents API: `GET /repos/{owner}/{repo}/contents/{patchPath}?ref={branch}`.

- If found → return `{ status: 'complete', pullAfter: { repo, branch } }`.
  The scheduler pulls, then the on-pull scanner (§4.4) applies the patch.
- If 404 and Step 1 returned `complete` with a result payload →
  **fallback: extract posteriors from the status response.** The Modal
  status endpoint returns the full worker result (including posteriors
  and webhook response). Construct a `BayesPatchFile` from this data
  and apply directly via `applyPatchAndCascade`, bypassing git. This
  handles the case where the webhook fired but the git commit failed
  (GitHub outage, token expiry mid-webhook). Log prominently — this
  path means the git artefact was lost.
- If 404 and no result payload → the patch was never written and we
  cannot recover it. Check job age:
  - If < 60 minutes old and status probe failed → return
    `{ status: 'running' }` (assume still in flight, probe was flaky).
  - If >= 60 minutes old → return `{ status: 'error', error: 'Job lost:
    no patch file found and status endpoint unreachable' }`.

**Step 3 — Surface outcome.**
The scheduler handles `operationRegistryService` toasts and `pullAfter`
automatically. No custom UI needed beyond what the scheduler provides.

### 4.4 On-pull patch scanner

After every `repositoryOperationsService.pullLatest()` completes, scan
fileRegistry for `_bayes/patch-*.json` files that arrived in the pull.
(In production, files live in IDB — there is no local filesystem. The
pull path syncs git → IDB → fileRegistry, so the scanner reads from
fileRegistry regardless of environment. See §8.7.)

The scanner holds a module-level mutex to prevent concurrent invocations
(§8.4). It is gated on fileRegistry readiness (§8.3) — if fileRegistry
is not yet populated, defer to a post-workspace-load callback.

The scanner processes patches per-graph using a **staleness-discard
rule**: a patch is applied only if it is strictly newer than the
graph's current posteriors. Stale patches are deleted without applying.

**Per-graph processing:**

1. Group all `_bayes/patch-*.json` files by `graph_id`.
2. For each graph, read its current `_bayes.fitted_at_epoch` from
   fileRegistry (null if no prior fit).
3. Discard (delete from git) any patch where
   `patch.fitted_at_epoch <= graph._bayes.fitted_at_epoch`.
   Log as "superseded by current posteriors".
4. Of the remaining newer-than-current patches, take **only the most
   recent** (highest `fitted_at_epoch`). Discard the rest — they are
   superseded by the one we're about to apply.
5. Apply the selected patch via `applyPatchAndCascade(patch, graphId)`.
6. **Only after successful apply**: delete ALL patches for this graph
   from git (the applied one + any stale ones). If apply fails, leave
   everything in git — the poisoned-patch mechanism (§8.9) handles
   retry suppression.
7. Log via `sessionLogService`, including quality metadata for toast
   display (§8.11).

**Pre-apply checks** (per patch, before step 5):
- Parse the patch (`BayesPatchFile` shape). If parsing fails, add to
  a poisoned-patch skip-set and log prominently (§8.9).
- Verify the patch's branch matches the current workspace branch
  (§8.10). Skip with a log message if they differ.

**Headless graph load**: If the patch's `graph_id` is not currently
loaded in fileRegistry (the user has a different graph open, or no
graph open), restore it from IDB using `fileRegistry.restoreFile()`
— same pattern as `dailyAutomationJob`'s headless graph load. The
graph does not need to be open in a tab. If the graph is not in IDB
at all (e.g. it was deleted), skip with a log message.

**Why only the most recent?** Each fit runs against the full graph
topology. A later fit's posteriors completely supersede an earlier
one's. Applying intermediate patches would create phantom
`fit_history` entries for posteriors that were never actually "live"
as the current state.

**`fitted_at_epoch` field**: The existing `fitted_at` field uses
`d-MMM-yy` format (day granularity). Two fits on the same day
produce identical strings, and the `<=` check would discard the
second. `BayesPatchFile` must include a `fitted_at_epoch: number`
(ms since epoch) for sub-day comparison. The worker sets this at
fit completion time. The graph's `_bayes` block stores the same
field after successful apply (see §8.16).

**`fitted_at_epoch` parse safety**: If `fitted_at_epoch` is missing
from either the patch or the graph's `_bayes` block (e.g. patches
from older code), fall back to parsing `fitted_at` via
`parseUKDate`. If that also fails: on the *graph* side, treat as
null (no prior fit — apply the patch). On the *patch* side, apply
with a warning rather than discard — better to apply a possibly-stale
patch than silently lose valid posteriors.

This catches:
- Patches from reconciled jobs (scheduler pulled, patches now local).
- Patches from jobs that were never tracked (IDB cleared, old code
  version, manual webhook test).
- Patches from other users/sessions sharing the same branch.

### 4.5 Resume polling for still-running jobs

When `reconcileFn` returns `{ status: 'running' }`, the job is still
in-flight on Modal. The scheduler logs this but does not currently
resume active polling.

Two options:

**Option A — Re-trigger via scheduler `run()`.**
The `reconcileFn` returns `{ status: 'running' }`. A post-reconciliation
hook (or the job definition's `runFn` itself) detects that it has a
persisted `modalCallId` in params and resumes `pollUntilDone` instead of
submitting a new fit. When polling completes, fetch-and-apply as normal.

**Option B — Rely on the on-pull scanner.**
Do not resume polling. The job will complete, the webhook will commit the
patch, and either the next pull or the next boot reconciliation will find
and apply it. This is simpler but adds latency (up to the pull interval,
currently ~60s on focus).

**Recommendation: Option A.** The user experience of seeing a progress
toast resume on browser reopen is significantly better than a silent
patch application minutes later. Option B is an acceptable fallback for
edge cases where Option A fails.

Implementation for Option A: `reconcileFn` returns
`{ status: 'running' }` with `result: { resumePolling: true,
modalCallId, statusUrl, patchPath, ... }`. A service-level handler
(not a React component — see §8.6) detects this and starts
`pollUntilDone` directly, updating `operationRegistryService` for
toast display. When done, it calls `applyPatchAndCascade` (§8.2),
then updates the scheduler job to `complete`.

### 4.6 Credential availability on reconnect

The `fetchAndApplyPatch` path needs a GitHub token to read the patch
file from git and delete it after applying. On the happy path, the
token comes from `credentialsManager` in `useBayesTrigger`.

On reconnect, credentials must be available. Two considerations:

- `credentialsManager.loadCredentials()` reads from IDB — credentials
  persist across sessions. This should work without changes.
- If credentials have been rotated or expired between sessions, the
  patch fetch will fail. The on-pull scanner (§4.4) is the fallback:
  after a successful pull with the new credentials, the patch lands
  locally and is applied without needing a separate GitHub API call.

No token is stored in `PersistedJobRecord.params` — that would be a
security anti-pattern.

### 4.7 Concurrency and idempotency

**Multiple patch files.** The scanner applies only the most recent
patch per graph and discards the rest (§4.4). No ordering problem
arises because intermediate patches are never applied.

**Duplicate application.** Prevented by two mechanisms working
together: (1) the per-graph mutex in `applyPatchAndCascade` (§8.16
point 5) prevents concurrent application to the same graph, and
(2) the staleness check: after a patch is applied,
`_bayes.fitted_at_epoch` is updated on the graph. If the same patch
is seen again (e.g. delete failed, patch reappears on next pull),
`patch.fitted_at_epoch <= graph.fitted_at_epoch` → discarded. These
two mechanisms are sufficient — no additional `fit_history`
deduplication is needed at this stage. (Fingerprint-based dedup is
deferred to the topology signatures work, doc 10.)

**Happy-path vs scanner race.** The apply mutex must live inside
`applyPatchAndCascade` itself (§8.16), not in the scanner wrapper.
This ensures the happy path (via `useBayesTrigger`) and the scanner
never apply concurrently to the same graph.

**Concurrent fit + scan.** If a new fit is in-flight while the scanner
finds a patch from a previous fit, the staleness check governs: if
the old patch is newer than the graph's current `fitted_at_epoch`,
it's applied. When the new fit completes, its patch will be newer
still and will supersede it on the next scan.

**Write `fitted_at_epoch` last.** `applyPatchAndCascade` must write
`_bayes.fitted_at_epoch` to the graph as its final step, after all
param file writes and cascade steps succeed. This ensures the
staleness check only passes once the full apply is complete. If any
step fails mid-cascade, `fitted_at_epoch` is not updated, and the
patch remains eligible for retry on next scan.

### 4.8 User-facing patch discovery on boot

When the boot/pull path discovers pending patches, the user should
see what's about to happen and have a chance to intervene. This
applies in both manual and automation contexts — same code path,
same countdown, simpler to implement and test.

**Per-patch countdown banner:**

Patches are processed one at a time (serial). For each patch:

```
"Bayes posteriors found for graph-A (fitted 5-Apr-26).
 Applying in 15s…    [Apply now]  [Skip]"
```

- **Apply now**: apply immediately, skip the countdown.
- **Skip**: don't apply this patch. It remains in git. It'll be
  offered again on next browser open. This is "not now", not
  "discard forever".
- **Countdown expires**: apply automatically (same as "Apply now").

After apply (or skip), move to the next patch if there are more.
Each patch gets its own countdown. No batching — serial processing,
one banner at a time.

**Same logic in automation mode.** The `?retrieveall` Phase 0
(§10.2.1) uses the same countdown. It adds ~15 seconds per patch,
which is negligible relative to the retrieval pipeline. The benefit
is one code path to test and maintain. If the automation window is
unattended, the countdown simply expires and apply proceeds.

**Implementation:** The scanner detects patches, sorts by graph,
applies the staleness-discard rule (newest-only per graph, §4.4),
then for each surviving patch: shows a banner via
`bannerManagerService` with a 15-second countdown (same pattern as
`daily-automation`'s 30-second start countdown). On countdown expiry
or user action, calls `applyPatchAndCascade` then `commitFiles`.
Moves to next patch.

### 4.9 Local dev considerations

- **Python server restart**: `_jobs` dict is lost. `reconcileFn` status
  probe returns 404. Falls through to patch file check.
- **No git repo** (rare: local-only workspace): `fetchAndApplyPatch`
  fails. The on-pull scanner does not trigger. For local dev, this is
  acceptable — the user can re-run the fit.
- **Tunnel expiry**: If the cloudflared tunnel expired before the
  webhook fired, no patch file exists. `reconcileFn` correctly reports
  the job as lost after the age threshold.

## 5. Components Changed

| Component | Change |
|-----------|--------|
| `bayesPatchService.ts` | Extract `applyPatchAndCascade(patch, graphId)` — shared 5-step cascade function (§8.2). Add `scanAndApplyOrphanedPatches()` — scans fileRegistry for `_bayes/patch-*`, applies each via the shared function, cleans up. Includes mutex (§8.4), poisoned-patch skip-set (§8.9), branch check (§8.10). |
| `useBayesTrigger.ts` | Register `bayes-fit` job definition with `persistent: true`, `reconcileFn`, and `schedule: { type: 'reactive' }`. On submit, create job via `scheduler.run('bayes-fit', { params })` instead of raw `useState`. Two-phase IDB persist: placeholder on submit, update with `modalCallId` after response (§8.1). Replace inline cascade with `applyPatchAndCascade`. |
| `bayesReconnectService.ts` (new) | Service-level handler for resume-polling (§8.6). Called by scheduler when reconcileFn returns `{ status: 'running' }`. Runs `pollUntilDone`, then `applyPatchAndCascade`, updates operation toast with quality metadata. No React dependency. |
| `bayesService.ts` | No changes. `pollUntilDone` and `pollBayesStatus` are already standalone functions callable from both the hook and reconnect service. |
| `repositoryOperationsService.ts` | After `pullLatest` completes, call `scanAndApplyOrphanedPatches()` on fileRegistry. Gated on fileRegistry readiness (§8.3). |
| `jobSchedulerService.ts` | No changes needed — existing infrastructure is sufficient. |
| `appDatabase.ts` | No schema changes — `db.schedulerJobs` already has the needed shape. |

## 6. Sequence Diagrams

### 6.1 Happy path (browser stays open)

```
Browser                    Modal/Local         Git
  │                           │                  │
  ├─ scheduler.run('bayes-fit', params) ──────►  │
  │  (persists to IDB)        │                  │
  ├─ POST /submit ──────────► │                  │
  │  ◄── job_id ──────────────┤                  │
  │                           │                  │
  ├─ poll /status ──────────► │                  │
  │  ◄── running ─────────────┤                  │
  │  ...                      │                  │
  │  ◄── complete ────────────┤                  │
  │                           ├─ webhook ──────► │
  │                           │   commit patch   │
  │                           │                  │
  ├─ fetchAndApplyPatch ──────────────────────► │
  │  ◄── patch content ──────────────────────────┤
  ├─ applyPatch + cascade     │                  │
  ├─ delete patch ────────────────────────────► │
  ├─ scheduler.complete()     │                  │
  │  (update IDB)             │                  │
```

### 6.2 Browser closed, reopens after completion

```
Browser (session 1)        Modal              Git
  │                          │                  │
  ├─ scheduler.run() ──────► │                  │
  ├─ POST /submit ─────────► │                  │
  │  ◄── job_id ─────────────┤                  │
  │                          │                  │
  ╳ (browser closes)         │                  │
                             │                  │
                             ├─ (fit completes) │
                             ├─ webhook ──────► │
                             │   commit patch   │

Browser (session 2)        Modal              Git
  │                          │                  │
  ├─ boot                    │                  │
  ├─ scheduler.reconcile()   │                  │
  │  finds bayes-fit in IDB  │                  │
  ├─ reconcileFn:            │                  │
  │  GET /status ──────────► │                  │
  │  ◄── complete ───────────┤                  │
  │  check patch exists ──────────────────────► │
  │  ◄── 200 ────────────────────────────────────┤
  │  return { complete, pullAfter }              │
  │                          │                  │
  ├─ scheduler: pullLatest ──────────────────► │
  │  ◄── pull with patch ────────────────────────┤
  ├─ on-pull scanner:        │                  │
  │  applyPatch + cascade    │                  │
  │  delete patch ────────────────────────────► │
```

### 6.3 Browser reopens, run still in progress

```
Browser (session 2)        Modal              Git
  │                          │                  │
  ├─ boot                    │                  │
  ├─ scheduler.reconcile()   │                  │
  │  finds bayes-fit in IDB  │                  │
  ├─ reconcileFn:            │                  │
  │  GET /status ──────────► │                  │
  │  ◄── running ────────────┤                  │
  │  return { running }      │                  │
  │                          │                  │
  ├─ resume pollUntilDone ─► │                  │
  │  ...                     │                  │
  │  ◄── complete ───────────┤                  │
  │                          ├─ webhook ──────► │
  ├─ fetchAndApplyPatch ──────────────────────► │
  ├─ applyPatch + cascade    │                  │
```

## 7. Open Questions

**Q1. Should persisted params include the full payload for re-submission?**
No. The payload (graph snapshot, parameter files, settings) is large and
stale by the time we'd re-submit. If a job is truly lost, the user should
trigger a fresh fit with current data. Persisted params are for
*reconnecting to an existing job*, not re-submitting.

**Q2. How long should stale jobs persist in IDB?**
**Resolved: 24 hours.** Mark as `error:stale` after 24h. Modal's max
function timeout is ~60 minutes; any job older than 24h is definitively
lost. Note: this only affects the IDB job record (stop probing the
status endpoint). Patch files in git are independent — the on-pull
scanner applies them regardless of job record state.

**Q3. Should the on-pull scanner auto-apply patches for graphs not
currently open?**
Yes. The graph doesn't need to be open in a tab. The scanner loads it
from IDB via `fileRegistry.restoreFile()` (headless, same as the
automation job), applies the patch, writes back to IDB. The
GraphStore/render-tree cascade is deferred until the user opens the
graph — at which point GraphStore mounts, reads from fileRegistry,
and the posteriors are already there. See §8.2 for the two-tier
cascade design.

**Q4. What about the retrieve-all integration specifically?**
See §10.2. This design is a prerequisite for wiring Bayes into the
retrieve-all automation pipeline.

## 8. Adversarial Review Findings

The following issues were identified through adversarial review and must
be addressed during implementation.

### 8.1 CRITICAL: Two-phase IDB persist for modalCallId

**Problem**: The scheduler persists job state at the `running` transition,
which happens at the *start* of `runFn` — before `submitBayesFit`
returns the `modalCallId`. If the browser crashes between submit and
the params update, the IDB record has no `modalCallId` and cannot be
reconciled.

**Resolution**: Two-phase persist. (1) Persist with `status: submitted`
and placeholder params at `scheduler.run()` time. (2) After
`submitBayesFit` returns, explicitly update the persisted record with
`modalCallId` and `patchPath`. The reconcileFn must handle records
that have no `modalCallId` (treat as: skip status probe, go straight
to patch file check with a generous age threshold).

### 8.2 CRITICAL: Cascade fidelity — two-tier cascade

**Problem**: The happy path in `useBayesTrigger` performs a 5-step
cascade: (1) applyPatch, (2) fileRegistry → GraphStore sync,
(3) per-edge `getParameterFromFile`, (4) latency promotion via
`persistGraphMasteredLatencyToParameterFiles`, (5) write cascaded
graph back to fileRegistry. The scanner must replicate this, but the
graph may not be open (no GraphStore mounted).

**Resolution**: Extract into `applyPatchAndCascade(patch, graphId)`
in `bayesPatchService.ts`. The function operates in two tiers:

**Tier 1 — Immediate (always runs, no React dependency):**
1. Load graph from fileRegistry. If not loaded, restore from IDB
   via `fileRegistry.restoreFile(graphId)` (headless load).
2. `applyPatch(patch)` — write posteriors to param files + `_bayes`
   block on graph. Write back to fileRegistry/IDB. Mark dirty.
3. Write `_bayes.fitted_at_epoch` to graph as final step (§8.16).

This is sufficient for persistence. The posteriors are in IDB, the
files are dirty, they'll be committed. Any consumer that reads from
fileRegistry or IDB sees the posteriors.

**Tier 2 — Live cascade (only if GraphStore is mounted):**
4. Check `getGraphStore(graphId)` — module-level registry, not React
   context. If null (graph not open in a tab), skip tier 2 entirely.
5. If mounted: sync fileRegistry → GraphStore, run per-edge
   `getParameterFromFile`, run `persistGraphMasteredLatencyToParameterFiles`,
   write cascaded graph back to fileRegistry.

When the user later opens the graph, GraphStore mounts and reads
from fileRegistry — the tier-1 posteriors are already there. The
tier-2 cascade (param→edge propagation, latency promotion) happens
naturally as part of the normal graph-open flow, which already calls
`getParameterFromFile` per edge during initialisation.

**Both the happy path and the scanner call the same function.** When
the browser is open and the graph is active, both tiers run. When
the scanner applies a patch for an unopened graph, only tier 1 runs.
The end state is identical — tier 2 is just eager vs deferred.

### 8.3 HIGH: reconcileFn timing vs fileRegistry readiness

**Problem**: The scheduler runs reconciliation on `signalBootComplete()`,
which fires before workspace load completes. If fileRegistry is empty,
`applyPatch` silently skips all param file updates ("Parameter file
not found").

**Resolution**: The reconcileFn itself should NOT apply patches. Its
only job is to determine status and trigger `pullAfter` if needed.
Patch application happens exclusively in the on-pull scanner, which
fires after `pullLatest` — by which point workspace load has completed
and fileRegistry is populated. For the "still running" resume path
(§4.5), polling resumes immediately but application waits until the
poll completes and the patch lands.

Additionally: gate the on-pull scanner on a `fileRegistryReady` flag.
If fileRegistry is not yet populated when the pull completes, defer
the scan to a post-workspace-load callback.

### 8.4 HIGH: Concurrent scanner invocations

**Problem**: If reconcileFn's `pullAfter` and a periodic auto-pull
trigger simultaneously, two scanner invocations race on the same
patch files. `applyPatch` mutates graph/param documents via
`fileRegistry.updateFile` — concurrent calls corrupt data.

**Resolution**: The scanner must hold a mutex (simple module-level
`let _scanning: Promise<void> | null = null` guard). Second invocation
awaits the first. The pull lock in the scheduler helps but doesn't
cover the scanner's apply phase.

### 8.5 ~~HIGH~~ DEFERRED: fit_history idempotency gap

**Problem**: `mergePosteriorsIntoParam` appends to `fit_history` before
overwriting posteriors. If a patch is applied twice (scanner + reconcile
both trigger), the second application creates a duplicate history entry.

**Original resolution**: Deduplicate `fit_history` by `fingerprint`
before appending.

**Status**: **Deferred to topology signatures work (doc 10).** The
`fingerprint` field on `BayesPatchFile` is currently a placeholder
(empty string) — deduplicating on it would be meaningless. The
duplicate-application scenario is already prevented by the per-graph
mutex (§8.16 point 5) and the `fitted_at_epoch` staleness check
(§4.7). Fingerprint-based dedup becomes meaningful only when topology
signatures provide real per-fit-unit structural fingerprints. This
is a data integrity enhancement, not a correctness blocker for the
reconnect mechanism.

### 8.6 HIGH: Resume polling must be service-level, not React

**Problem**: Option A (§4.5) proposes a `useEffect` in the Bayes trigger
component to detect reconciled jobs and resume polling. But the Bayes
trigger component is inside a dev panel that may not be mounted on
browser reopen.

**Resolution**: Resume polling in the scheduler's own reconcile handler
or in a service-level callback, not in a React component. When
`reconcileFn` returns `{ status: 'running' }`, the scheduler (or a
`bayesReconnectService`) calls `pollUntilDone` directly, updating
`operationRegistryService` for toast display. No React mount required.

### 8.7 HIGH: On-pull scanner — IDB-based, not filesystem

**Problem**: In production (Vercel), there is no local filesystem. Files
live in IDB via fileRegistry. The doc's "scan the local working tree"
mental model only applies to local dev with a git clone.

**Resolution**: The scanner operates on fileRegistry after pull, not
on the filesystem. After `pullLatest` merges remote changes into IDB,
scan fileRegistry for files matching `_bayes/patch-*` pattern (or
check the pull diff for new files in `_bayes/`). In local dev, the
pull path already syncs git → IDB → fileRegistry, so the scanner
sees the same files either way.

### 8.8 HIGH: GitHub API rate limit handling

**Problem**: If the Contents API check in reconcileFn hits a 403 rate
limit, the current error handling would mark the job as failed. The
patch sits in git, never applied.

**Resolution**: reconcileFn must treat 403 as transient (same as
network error) — fall through to the age-based heuristic. The on-pull
scanner is the ultimate fallback and does not need the Contents API
(it reads from fileRegistry after pull).

### 8.9 HIGH: Poisoned patch infinite retry

**Problem**: If a patch file has corrupt JSON or a schema mismatch,
`applyPatch` throws. The scanner retries on every subsequent pull,
failing repeatedly, generating log noise indefinitely.

**Resolution**: Track failed patches in a module-level
`Set<string>` (by `job_id`). After first failure, log prominently
and skip on subsequent scans. Optionally move to `_bayes/failed/`
directory in git. Clear the skip-set on explicit user action (e.g.
re-trigger fit).

### 8.10 MEDIUM: Branch mismatch on reconnect

**Problem**: If the user switches branches between sessions, the
persisted job has `branch: 'main'` but the workspace is on `feature-x`.
The scanner might apply a `main`-branch patch to the `feature-x` graph.

**Resolution**: The scanner (and reconcileFn) must compare the patch's
`branch` (from persisted params or from the patch file metadata) against
the currently loaded workspace branch. Skip with a log message if they
differ.

### 8.11 MEDIUM: Quality gate toast on reconnect

**Problem**: The happy path computes quality tiers and shows a "See
Forecast Quality" action button on the completion toast. The reconnect
path uses the scheduler's generic toast with no quality information.

**Resolution**: `applyPatchAndCascade` (§8.2) should return quality
metadata. The reconcile completion handler (or on-pull scanner) uses
this to register a quality-aware toast via `operationRegistryService`,
matching the happy-path UX.

### 8.12 MEDIUM: Age threshold clarification

**Problem**: The doc has two age thresholds — 60 minutes (§4.3 Step 2:
"assume still in flight") and 24 hours (Q2: "mark as stale"). Their
interaction is unclear.

**Resolution**: These serve different purposes:
- **60 minutes**: In reconcileFn, if the status probe fails AND no
  patch file exists AND the job is < 60 min old → assume still running
  (transient probe failure). This is a grace period for probe flakiness.
- **24 hours**: IDB hygiene. Any persisted job older than 24h is pruned
  regardless of status. Modal's max function timeout is ~60 min, so a
  24h-old job is definitively dead.

Both apply, sequentially: reconcileFn checks 60-min first (decides
running vs error). The 24h threshold is a separate IDB cleanup pass.

### 8.13 MEDIUM: Credential types and reconnect

**Problem**: Only IDB-persisted (user-saved) credentials survive browser
close. URL-sourced credentials (share links) and system-secret
credentials are in-memory only. If the original session used URL
credentials, the reconnect path has no token.

**Resolution**: Document as a known limitation. Reconnect requires
user-saved credentials. If credentials are missing on reconnect,
surface an explicit error ("Bayes results are available but credentials
are needed to retrieve them — please configure git credentials") rather
than failing silently.

### 8.14 LOW: Patch file size and GitHub API limit

**Problem**: GitHub Contents API has a 1MB limit. Large graphs (100+
edges, multiple slices) could produce patches approaching this.

**Resolution**: The on-pull scanner reads from fileRegistry (post-pull),
not from the Contents API, so the 1MB limit only affects the
reconcileFn's patch-existence check (which only needs a HEAD request
or directory listing, not the full content). For the direct-fetch path,
if the patch exceeds 1MB, fall back to the Blobs API or trigger a full
pull instead.

### 8.15 LOW: Offline browser open

**Problem**: If the browser opens without network, reconcileFn cannot
probe Modal or check GitHub. The on-pull scanner cannot fire (no pull
without network).

**Resolution**: reconcileFn should treat network failure as transient
and leave the job in `running` state (not mark as error). On network
restoration (via `navigator.onLine` + `online` event), re-trigger
reconciliation. The scheduler currently only reconciles once on boot —
add a re-reconcile-on-online hook for persistent jobs still in
`running` state.

### 8.16 HIGH: Staleness-discard mechanism and apply atomicity

**Problem**: Multiple patches can accumulate for the same graph (e.g.
nightly fits while browser is closed for several days). Applying all
of them in order creates phantom `fit_history` entries for posteriors
that were never "live". Additionally, several failure modes arise
around the discard logic.

**Resolution**: The staleness-discard rule (§4.4) and several
invariants:

1. **Apply only the newest patch per graph.** Each fit fully supersedes
   the prior. Intermediate patches are discarded without application.

2. **`fitted_at_epoch` for sub-day comparison.** Add
   `fitted_at_epoch: number` (ms since epoch) to `BayesPatchFile`.
   The worker sets this at fit completion. The graph's `_bayes` block
   stores the same field after successful apply. Day-granularity
   `fitted_at` is insufficient — two fits on the same day would
   produce identical strings and the second would be discarded.

3. **Write `fitted_at_epoch` last.** `applyPatchAndCascade` writes
   param files and performs the full cascade first. Only after all
   steps succeed does it write `_bayes.fitted_at_epoch` to the graph.
   This is the atomic completion marker. If any step fails,
   `fitted_at_epoch` is not updated and the patch remains eligible
   for retry.

4. **Delete after successful apply only.** The scanner must not delete
   any patch (stale or otherwise) until the selected newest patch is
   successfully applied. If apply fails, all patches remain in git.
   Sequence: identify newest → apply newest → if success, delete ALL
   patches for this graph (applied + stale) → if failure, leave all.

5. **Mutex in `applyPatchAndCascade`.** The mutex lives inside the
   shared apply function, not in the scanner wrapper. This ensures
   the happy path (via `useBayesTrigger`) and the scanner never
   apply concurrently. The mutex is per-graph (keyed by `graphId`)
   to allow concurrent application to different graphs.

6. **Parse failure safety.** If `fitted_at_epoch` is missing (patches
   from older code), fall back to `parseUKDate(fitted_at)`. If that
   also fails: on the graph side, treat as null (no prior fit — apply
   the patch). On the patch side, apply with a warning rather than
   discard.

7. **Shared param files across graphs.** If two graphs reference the
   same parameter file, patches for each graph both write to that
   param file. Last-writer-wins is the correct semantic. Once topology
   signatures land (§10.1), patches will be scoped to a specific
   topology and this can be handled more precisely.

## 9. Non-Goals

- **Re-submission of failed jobs.** If a fit fails, the user must
  manually re-trigger. Automatic retry risks repeating the same failure
  (bad data, model divergence) indefinitely.
- **Cross-tab coordination.** If two tabs are open, both may attempt
  reconciliation. The idempotency guarantees (§4.7) make this harmless
  but noisy. Cross-tab locking (via `concurrency: { mode:
  'singleton:cross-tab' }`) prevents duplicate work.
- **Notification when browser is closed.** No push notifications or
  service workers. The patch sits in git until the browser reopens.
- **Local dev server persistence.** The in-memory `_jobs` dict is
  ephemeral by design. For local dev, if the Python server restarts,
  the job is lost and the user re-runs. This is acceptable for a dev
  workflow.

## 10. `runBayes` Graph Flag

### 10.1 Purpose

Not every graph should get a Bayes fit. The automation pipeline must
only commission fits for graphs that have opted in. This mirrors the
`dailyFetch` pattern: a boolean on the graph, default `false`, that
gates inclusion.

### 10.2 Schema addition

| Layer | File | Change |
|-------|------|--------|
| TypeScript type | `src/types/index.ts` | Add `runBayes?: boolean` to `GraphData` (next to `dailyFetch`) |
| Pydantic model | `lib/graph_types.py` | Add `runBayes: Optional[bool] = Field(None, ...)` to graph model |
| JSON schema | `public/schemas/conversion-graph-1.1.0.json` | Add `"runBayes": { "type": "boolean", "default": false, "description": "..." }` |
| Synth generators | `bayes/graph_from_truth.py`, `bayes/synth_gen.py` | Hardcode `"runBayes": False` |

### 10.3 UI

**PropertiesPanel** — Add a checkbox in the existing Automation
`CollapsibleSection`, below the `dailyFetch` checkbox:

```
☐ Daily fetch (dailyFetch)
☐ Run Bayes   (runBayes)
```

The Bayes checkbox is **disabled when `dailyFetch` is false** —
greyed out, not clickable, with a tooltip: "Enable daily fetch first."
This mirrors the modal's structural constraint (§10.3) in the
per-graph UI. Toggling `dailyFetch` off also clears `runBayes`
(same as moving a graph out of the Automated column in the modal).

```
☑ Daily fetch
  ☑ Run Bayes          ← enabled, indented to show dependency

☐ Daily fetch
  ☐ Run Bayes (greyed) ← disabled, tooltip: "Enable daily fetch first"
```

Warning banner if `runBayes === true` but no `dataInterestsDSL`:
"Bayes is enabled but no pinned query is set — the compiler needs
snapshot subjects derived from the DSL."

**DailyFetchManagerModal** — Extend the existing transfer-list with
a per-graph Bayes checkbox on the enabled side. Rename to
"Automation Manager" or similar.

```
┌─ Available ──────────┐     ┌─ Automated ─────────────────┐
│                      │     │                             │
│  graph-D             │ ──► │  graph-A          ☐ Bayes  │
│  graph-E             │     │  graph-B          ☑ Bayes  │
│                      │ ◄── │  graph-C          ☐ Bayes  │
│                      │     │                             │
└──────────────────────┘     └─────────────────────────────┘
```

Behaviour:
- Moving a graph left → right sets `dailyFetch: true`,
  `runBayes: false` (fetch only by default).
- Moving a graph right → left sets `dailyFetch: false`,
  `runBayes: false` (clears both).
- The Bayes checkbox is only interactive on the right side — you
  cannot enable Bayes without fetch. This makes the invalid state
  (`runBayes: true`, `dailyFetch: false`) structurally impossible
  in the modal.
- On save, `dailyFetchService.applyChanges()` is extended to write
  both `dailyFetch` and `runBayes` per graph.

The three valid states per graph are a natural progression:
off → fetch only → fetch + Bayes. The transfer list handles the
first transition, the checkbox handles the second.

### 10.4 Automation gate

In `dailyAutomationJob.ts`, Phase 1 (§11.2.1), the Bayes submission
is gated on `graph.data?.runBayes`:

```
for (const graph of graphs) {
  await dailyRetrieveAllAutomationService.run(graph, ...);
  // Only commission Bayes if the graph has opted in
  if (graph.data?.runBayes) {
    try {
      const jobId = await submitBayesFit(...);
      pendingFits.push({ graphId, jobId, ... });
    } catch (err) { ... }
  }
}
```

Graphs with `dailyFetch: true` but `runBayes: false` get retrieval
only. Graphs with both get retrieval + Bayes. Graphs with
`runBayes: true` but `dailyFetch: false` are a configuration error
— the integrity check warns (§10.3).

### 10.5 Integrity checks — configuration and operational health

Add to `integrityCheckService.ts`, using `category: 'operational'`
to distinguish from structural checks. All signals are derived from
fields already on the graph and param files — no new persistence.

#### Configuration checks (existing pattern, extended)

```
if (data.runBayes && !data.dailyFetch) → warning:
  "Bayes is enabled but daily fetch is not"
  (impossible via UI, but catches hand-edited YAML)

if (data.runBayes && !data.dataInterestsDSL?.trim()) → warning:
  "Bayes is enabled but no pinned data-interests DSL is set"
```

The UI enforces `runBayes` → `dailyFetch` by disabling the checkbox
(§10.3) and clearing `runBayes` when `dailyFetch` is toggled off.
The integrity check is a backstop for files edited outside the UI.

#### Retrieval health checks

All gated on `dailyFetch: true` — no point warning about staleness
on a graph that isn't meant to be automated.

| Condition | Severity | Message |
|-----------|----------|---------|
| `dailyFetch && !metadata.last_retrieve_all_slices_success_at_ms` | info | "Daily fetch enabled but no successful retrieval recorded" |
| `dailyFetch && retrieved_at > 48h ago` | warning | "Last successful retrieval was N days ago" |
| `dailyFetch && retrieved_at > 7d ago` | error | "Last successful retrieval was N days ago — data is likely stale" |

`retrieved_at` is derived from
`metadata.last_retrieve_all_slices_success_at_ms`. The 48h threshold
(not 24h) gives a one-day grace period — if the nightly run fails
once, it's not immediately alarming. Two missed nights is a warning.
A full week is an error.

#### Bayes quality checks

All gated on `runBayes: true`.

**Graph-level (from `_bayes` block):**

| Condition | Severity | Message |
|-----------|----------|---------|
| `runBayes && !data._bayes` | info | "Bayes enabled but no fit has been run" |
| `runBayes && _bayes.fitted_at > 7d ago` | warning | "Last Bayes fit was N days ago" |
| `_bayes.quality.max_rhat > 1.1` | warning | "Last fit has convergence issues (max rhat N)" |
| `_bayes.quality.min_ess < 100` | warning | "Last fit has low effective sample size (min ESS N)" |
| `_bayes.quality.converged_pct < 100` | warning | "Only N% of edges converged" |

**Per-edge (from `edge.p.posterior`):**

| Condition | Severity | Message |
|-----------|----------|---------|
| `posterior.rhat > 1.1` | warning | "Edge X: convergence issue (rhat N)" |
| `posterior.ess < 100` | warning | "Edge X: low ESS (N)" |
| `posterior.divergences > 0` | warning | "Edge X: N divergent transitions" |

Per-edge checks produce one issue each — they are scoped to the
edge so the user knows which part of the graph has problems. These
mirror the quality gate logic already in `bayesQualityTier.ts`
(`computeQualityTier`). The integrity check reuses the same
thresholds rather than defining its own.

#### Staleness interaction between retrieval and Bayes

If `dailyFetch` data is stale but `_bayes` posteriors are recent,
the posteriors were fitted on old data — they may not reflect current
reality. This cross-signal is worth flagging:

| Condition | Severity | Message |
|-----------|----------|---------|
| `retrieved_at > 48h ago && _bayes.fitted_at < 48h ago` | warning | "Bayes posteriors are recent but fitted on stale data — retrieval may have failed" |

This catches the case where retrieval breaks but Bayes keeps running
(e.g. retrieval hits persistent rate limits, but the Bayes fit still
runs against old snapshots). The posteriors look fresh but are based
on stale evidence.

### 10.6 Manual trigger (dev harness)

The existing `useBayesTrigger` dev harness does NOT check `runBayes`.
It's a manual action — the user explicitly clicked "Run Bayes", so
the flag is irrelevant. `runBayes` only gates automated runs.

## 11. Future Touchpoints

### 11.1 Topology signatures (doc 10)

Topology signatures are not yet implemented (listed as "not yet built"
in the programme). When they land, the reconnect mechanism needs two
updates:

1. **Stale-patch detection.** The scanner should compare the patch's
   `fingerprint` (topology signature at time of fit submission) against
   the current graph's topology signature. If they differ, the graph
   has been structurally modified since the fit was submitted — edges
   may have been added, removed, or rewired. The scanner should still
   apply the patch (posteriors for surviving edges are valid) but log
   a prominent warning: "Graph topology changed since this fit was
   submitted — posteriors may be incomplete or stale for modified
   edges." This gives the user visibility without blocking application.

2. **param_id reassignment guard.** A more dangerous case: if an edge
   was rewired to point at a different parameter file, the patch would
   write posteriors to the original `param_id`, which is now associated
   with a different edge. With topology signatures, we can detect this:
   if the signature changed AND a `param_id` in the patch no longer
   matches the same edge in the current graph, skip that edge with an
   error rather than silently writing wrong posteriors.

Until topology signatures exist, neither guard is possible. The current
`fingerprint` field in `BayesPatchFile` is a placeholder (empty string).
This is an acceptable risk for now — the user would need to both trigger
a fit AND restructure the graph topology while the browser is closed,
which is unlikely in practice.

### 11.2 Retrieve-all integration

#### 11.2.1 Three-phase pipeline

The daily automation pipeline gains two phases around the existing
retrieval loop:

```
Phase 0 — Apply pending patches (new):
  pull latest (existing upfront pull)
  scan fileRegistry for _bayes/patch-*.json
  for each patch (newest-only per graph, staleness-discard):
    15s countdown banner (same as manual boot, see §4.8)
    applyPatchAndCascade → commit

Phase 1 — Serial fetch + commission (existing loop, extended):
  for each graph:
    retrieve slices → recompute horizons → commit
    submit Bayes fit to Modal → record jobId
    (move immediately to next graph)

  Modal is now running all fits in parallel.

Phase 2 — Serial Bayes drain (new):
  while any fit is still pending:
    completedFit = await Promise.race(allPendingFits)
    remove completedFit from pending
    await applyPatchAndCascade(completedFit)
    await commitFiles(...)
```

**Why Phase 0 comes first:** Yesterday's Bayes fits may have completed
while the browser was closed. Their patches are sitting in git. Applying
them before today's retrieval means: (a) the graph starts Phase 1 with
the latest posteriors in place — the analytics topo pass sees Bayesian
model_vars, fetch planning benefits from posterior state; (b) no race
between scanner and retrieval — Phase 0 is fully complete before any
retrieval begins; (c) the commit is clean — yesterday's Bayes results
in one commit, today's retrieval in another.

**Why this structure:**

- **Fetch is sequential** — rate-limited by external APIs, must be
  serial. Each graph's retrieval commits before moving on.
- **Bayes submission is cheap** — one HTTP POST per graph, ~100ms.
  Fires immediately after each commit, doesn't block the next graph's
  retrieval.
- **Bayes computation is parallel** — all fits run concurrently on
  Modal. A 5-graph pipeline with 5-minute fits takes ~5 minutes total
  for Bayes, not 25.
- **Patch application is serial** — each apply mutates param files and
  graph files, then commits. Concurrent application risks half-written
  state visible to `commitFiles`. Serial drain eliminates this.
- **`Promise.race` not `Promise.all`** — apply each fit as soon as it
  completes rather than waiting for the slowest. Minimises total
  wall-clock time.

#### 11.2.2 Changes to dailyAutomationJob

All three phases run within the same `daily-automation` job execution.
The scheduler's `suppress: ['auto-pull', ...]` remains active
throughout, preventing interference from auto-pull or staleness nudges.

```
// Phase 0: apply pending patches from previous cycle
await pullLatestRemoteWins(repo, branch);
await loadWorkspaceFromIDB();
const patches = await scanForPendingPatches();  // staleness-discard
for (const patch of patches) {
  // Same countdown banner as manual boot (§4.8) — 15s per patch
  const userAction = await showPatchCountdownBanner(patch, 15);
  if (userAction === 'skip') continue;
  await applyPatchAndCascade(patch.data, patch.graphId);
  await commitFiles(..., `Bayes posteriors (${patch.graphName}) — …`);
}

// Phase 1: serial fetch + commission
const pendingFits: PendingBayesFit[] = [];
for (const graph of graphs) {
  await dailyRetrieveAllAutomationService.run(graph, ...);
  // Retrieval + horizons + commit done for this graph.
  // Fire Bayes fit immediately.
  try {
    const jobId = await submitBayesFit({ graphId, repo, branch, ... });
    pendingFits.push({ graphId, jobId, statusUrl, patchPath });
  } catch (err) {
    // Submit failed — log, skip Bayes for this graph, continue (F3)
    sessionLogService.warning('bayes', 'BAYES_SUBMIT_FAILED', ...);
  }
}

// Phase 2: drain Bayes results (serial application)
// Create all polling promises once — race on shrinking pool (F6)
const racePool = pendingFits.map(fit =>
  pollUntilDone(fit.jobId, onProgress, 5000, 30 * 60 * 1000,
                fit.statusUrl)
    .then(result => ({ fit, result }))
    .catch(err => ({ fit, result: { status: 'failed', error: err } }))
);
const remaining = [...racePool];

while (remaining.length > 0) {
  const settled = await Promise.race(remaining);
  remaining.splice(remaining.indexOf(settled), 1);  // remove resolved

  if (settled.result.status === 'failed') {
    // Log and continue — don't block other fits (F1)
    sessionLogService.warning('bayes', 'BAYES_FIT_FAILED', ...);
    continue;
  }
  await applyPatchAndCascade(settled.fit.patch, settled.fit.graphId);
  await commitBayesPatch(settled.fit.graphId, settled.fit.repo,
                         settled.fit.branch);
}
```

#### 11.2.3 Commit strategy

Each Bayes patch application gets its own commit:
`Bayes posteriors (graph-name) — d-MMM-yy`.

This is separate from the retrieval commit
(`Daily data refresh (graph-name) — d-MMM-yy`). Two commits per graph
per cycle when Bayes runs. This is cleaner than bundling retrieval and
Bayes into one commit — it makes the git history legible and allows
easy revert of Bayes without losing retrieval data.

#### 11.2.4 Browser close during pipeline

**During Phase 0 (patch apply):** Some patches may have been applied
and committed, others not yet. On browser reopen: the un-applied
patches are still in git. If `?retrieveall` is in the URL again,
Phase 0 runs again and picks them up. If manual session, the
countdown banner (§4.8) offers them.

**During Phase 1 (retrieval):** Retrieval results for completed graphs
are already committed. Bayes fits for those graphs are submitted and
running on Modal. Un-submitted graphs get nothing. On browser reopen:
scheduler reconciliation picks up the submitted fits (§4.3). Patches
land via webhook, applied by on-pull scanner or reconcileFn.

**During Phase 2 (drain):** Some fits may have completed and been
applied+committed. Others are still running on Modal. On browser
reopen: same reconciliation path. The serial drain does not resume —
the normal per-event application (scanner after pull) handles the
remaining patches. Serialisation is not critical outside the
automation run since operations are infrequent.

**Phase 1 complete, Phase 2 never starts (crash between phases):**
All fits are submitted and running. None have been applied. On browser
reopen: reconciliation picks up all of them. Patches arrive via pull,
applied by scanner. No data loss.

#### 11.2.5 Adversarial review of the two-phase pipeline

**F1. MEDIUM: One Bayes fit fails — does it block the drain?**

If `pollUntilDone` returns `status: 'failed'` for one fit, the drain
must handle it gracefully: log the error, remove from pending, continue
draining the rest. A single failed fit must not abort the entire Phase
2. The `Promise.race` pattern naturally supports this — the race
resolves for the failed fit, we log and skip, race again on the
remaining.

**F2. HIGH: Bayes fit hangs — `pollUntilDone` hits the 10-minute wall-clock timeout.**

One fit takes longer than expected (complex graph, Modal cold start).
`pollUntilDone` returns `{ status: 'failed', error: 'FE wall-clock
timeout' }`. But the fit is still running on Modal — it hasn't
actually failed. If we remove it from pending and move on, the patch
will eventually arrive via webhook and be picked up by the on-pull
scanner. So the timeout is non-destructive: we stop waiting, but the
work isn't lost.

However, the 10-minute timeout may be too short for production fits
with many edges. The drain's timeout should be longer than the
interactive trigger's — propose 30 minutes for the automation drain,
vs 10 minutes for the interactive trigger. If the fit still hasn't
completed after 30 minutes, log a warning and let the reconciliation
path handle it.

**F3. HIGH: `submitBayesFit` fails for one graph in Phase 1.**

Network error, config unavailable, credentials issue. Must not abort
the remaining graphs' retrieval. Catch the error, log it, skip the
Bayes commission for this graph, continue to next graph's retrieval.
The graph still gets its data refresh — it just doesn't get a Bayes
fit this cycle.

**F4. MEDIUM: Commit after patch apply fails (remote-ahead).**

Same as the existing retrieval commit retry logic: pull with
remote-wins, retry once. If it fails again, the dirty files remain
in IDB — they'll be committed on next cycle. The posteriors are not
lost, just uncommitted.

**F5. HIGH: Phase 2 drain interleaves with on-pull scanner.**

During the drain, `auto-pull` is suppressed by `daily-automation`.
But the drain itself calls `commitFiles`, which may trigger a push.
If another device pulls and pushes between our commits, the next
drain commit sees remote-ahead. Handled by the retry logic (F4).

More subtle: what if the drain's own commit triggers the on-pull
scanner? It shouldn't — we're committing *outbound*, not pulling
inbound. But if the commit includes a pull-then-retry step, the pull
could land OTHER patches (from a different device's Bayes run). The
on-pull scanner would try to apply those while the drain is also
applying. The per-graph mutex in `applyPatchAndCascade` (§8.16)
serialises these — the scanner's apply waits for the drain's apply
to finish. But if they're for different graphs, they run concurrently.
This is fine — different graphs don't share files (the shared-param
edge case is deferred to topology signatures per §10.1).

**F6. MEDIUM: `Promise.race` index tracking after splice.**

Classic bug: after splicing index `completedIdx` from
`pendingFits`, the remaining indices shift. The next `Promise.race`
creates new promises from the shifted array, which is correct (fresh
`.map` each iteration). But if a previous `pollUntilDone` promise is
still running from a prior iteration (it isn't — it resolved to
trigger the race), this could leak. In practice, `Promise.race`
creates fresh polling promises each iteration so there's no leak —
but the implementation must ensure that previous-iteration polls are
aborted (via `AbortController`) before starting the next race.
Otherwise N-1 redundant polling loops accumulate.

**Resolution**: Each `pollUntilDone` call gets an `AbortController`.
On each drain iteration, abort all controllers from the previous
iteration before creating new ones. Or simpler: create the polling
promises once outside the loop, and use `Promise.race` on a
shrinking array of the original promises (no re-creation needed).

```
// Create all polling promises once
const fitPromises = pendingFits.map((fit, i) => ({
  promise: pollUntilDone(fit.jobId, ...).then(() => i),
  fit,
}));

// Drain loop — race on remaining, remove completed
let remaining = [...fitPromises];
while (remaining.length > 0) {
  const completedIdx = await Promise.race(
    remaining.map(r => r.promise)
  );
  const completed = remaining.find(r =>
    r.promise === /* the one that resolved to completedIdx */
  );
  remaining = remaining.filter(r => r !== completed);
  await applyPatchAndCascade(...);
  await commitBayesPatch(...);
}
```

Actually, the cleaner pattern is to wrap each fit in a promise that
resolves to its own identity:

```
const racePool = pendingFits.map(fit =>
  pollUntilDone(fit.jobId, ...)
    .then(result => ({ fit, result }))
);

while (racePool.length > 0) {
  const { fit, result } = await Promise.race(racePool);
  // Remove the resolved promise from the pool
  racePool.splice(racePool.indexOf(/* the resolved one */), 1);
  // ... apply and commit
}
```

This avoids re-creating promises entirely. Each `pollUntilDone` runs
exactly once. The race pool shrinks as fits complete.

**F7. MEDIUM: Bayes needs fresh snapshot data — is it available?**

The Bayes worker queries the Neon snapshot DB for evidence. Retrieval
just fetched fresh data and committed it — but did the snapshot DB
get updated? The snapshot write path
(`snapshotWriteService.ts`) writes to Neon during retrieval, not at
commit time. So by the time we submit the Bayes fit, the snapshot DB
already has the fresh data. This is correct — no gap.

**F8. LOW: Automation window close during Phase 2.**

The automation job closes the browser window after completion. The
close delay is 12 hours for success. Phase 2 could take 30+ minutes
(5 graphs × 5 min fits, serial apply). The 12-hour delay is ample.
But if the close delay were shorter (e.g. in a future optimisation),
Phase 2 must complete before the window closes. The close logic
should wait for the `daily-automation` job to fully complete
(including Phase 2), not just Phase 1.

**F9. MEDIUM: Rate-limit cooldown in Phase 1 extends into Phase 2 timing.**

If retrieval hits a 45-minute rate-limit cooldown for one graph,
Phase 1 takes much longer. Bayes fits submitted before the cooldown
have been running on Modal for 45+ minutes by the time Phase 1
finishes. They may have already completed, and their patches are
sitting in git. Phase 2's `pollUntilDone` calls would return
immediately for those fits. The drain processes them instantly. This
is correct and efficient — no issue, just noting it.

**F10. HIGH: Credential token expiry during long pipeline.**

The callback token encrypted in Phase 1 has a 60-minute expiry
(§4.6, `encryptCallbackToken` sets `expires_at: Date.now() + 60min`).
If Phase 1 takes 2 hours (multiple graphs with rate-limit cooldowns),
fits submitted early have expired tokens by the time the webhook
fires. The webhook handler decrypts the token, checks expiry, and
rejects it. No patch file is created.

**Resolution**: Extend token expiry for automated runs. The automation
pipeline should set a longer expiry — propose 6 hours (covers even
worst-case rate-limit scenarios). Or: the webhook handler should
treat expired tokens from automated runs more leniently (the token
is encrypted, so it's still authenticated — expiry is a defence
against replay, not authentication).

Alternatively, encrypt the callback token just before submission
(not at the start of the pipeline). Since each graph's submission
happens immediately after its commit, the token is fresh. The 60-min
expiry then covers the fit computation time, not the pipeline time.
This is already the case if the token is encrypted per-graph inside
the loop — verify during implementation.
