# `?retrieveall` Stale-IDB Defect — Investigation Log

**Status (12-May-26):** URGENT PATCH SHIPPED on dagnet `main` (commit `5964fad3`). Root cause **NOT** confirmed. The patch is a sledgehammer that masks the underlying defect; a stable fix needs further diagnosis.

**Triggering symptom:** `li-cohort-segmentation-v2.json/dailyFetch=false` repeatedly reverted to `true` within hours of being set, despite multiple commits from multiple authors via the GitHub GUI:

| Commit | Author | Date | Action |
|---|---|---|---|
| `b1c1da90` | Kevin | 6-May-26 17:32 | "Fix: disable daily fetch on li-cohort-segmentation-v2" — sets `false` |
| `1bb2c58b` | gjbm2 | 7-May-26 11:57 | Sets `false` again (auto-reverted overnight) |
| `f5c2f8c6` | gjbm2 | 12-May-26 00:36 | Sets `false` again |
| `01b3d8d9` | gjbm2 (auto) | 12-May-26 05:07 | "Daily data refresh (conversion-flow-v2-recs-collapsed)" — **flipped `false → true` on li-cohort despite naming a different graph** |
| `9543bdde` | gjbm2 | 12-May-26 19:06 | Sets `false` again, post-patch |

Kevin's commit message on `b1c1da90` already noted the cycle:

> "This was originally turned off on 2026-04-15 in commit `39b29de6`, but reverted the next morning by commit `4b0d47fa`"

So this has been recurring for ~1 month.

---

## How the patch landed (urgent + scoped)

Two commits, both direct to `main`:

| Repo | Commit | Scope |
|---|---|---|
| dagnet | `5964fad3` | Hard-delete graph IDB records + purge FileRegistry before the `?retrieveall` pull |
| nous-conversion | `9543bdde` | Set `dailyFetch: false` on `li-cohort-segmentation-v2.json` |

The dagnet commit was pushed direct to `main` because the user wanted Vercel to deploy without going via release branch. Working tree on `feature/snapshot-db-phase0` was preserved via stash-pop.

### What the patch actually changes

In [`pullLatestRemoteWins`](../../../graph-editor/src/services/repositoryOperationsService.ts) at `repositoryOperationsService.ts:252`, when called with `overwriteGraphs: true` (the upfront pull in `dailyAutomationJob.ts:550`):

**Before:** cleared `sha` on every graph IDB record for the workspace. Intent: make `workspaceService.pullLatest` classify them as new and route through the clean-overwrite branch.

**After:** deletes every graph IDB record entirely (`db.files.delete(fileId)` for both prefixed and unprefixed variants), and purges the FileRegistry in-memory state:
- `fileRegistry.files` Map
- `fileRegistry.pendingUpdates` Map
- `fileRegistry.updatingFiles` Set
- `fileRegistry.listeners` Map (without firing callbacks — this is a structural reset, not a user delete)
- `fileRegistry.fileGenerations` Map

Also invalidates `repositoryOperationsService.committableFilesCache`.

Defence-in-depth: after the targeted purge, iterates `fileRegistry.files` and removes any entry with `type === 'graph'` that wasn't covered by the IDB-derived id set.

Emits a `GIT_PULL_OVERWRITE_GRAPHS_HARD_RESET` session-log warning capturing `deletedFileIds`, `scrubbedRegistryIds`, repo, branch, and count — flows through `automationLogService` into both `db.automationRunLogs` (IDB) and `.dagnet/automation-logs/*.json` (committed to nous-conversion) so the next cron run is auditable.

### Scope guarantee

Only the `overwriteGraphs: true` path is affected (only ever passed from `dailyAutomationJob.ts:550`, the upfront ?retrieveall pull). In-flight retry pulls during commit (remote-ahead recovery), Phase 0 patch-apply pulls, and Bayes pulls retain the existing 3-way-merge behaviour.

---

## Why this is NOT a stable solution

1. **It treats the symptom, not the cause.** The pre-existing sha-clear pre-pass SHOULD have been sufficient: clearing `sha` makes the file invisible to `workspaceService.pullLatest`'s local-file maps, so the clean-update path runs and writes remote data. If that wasn't working, sha-clear-PLUS-delete will mask the underlying defect but not fix it. The same defect will reappear in any other code path that consults `localFileState` or `data.dailyFetch` between the pull and the next consumer read.
2. **It's coarse.** Deleting all graph IDB records on every `?retrieveall` invocation is heavyweight and discards potentially-useful local state (e.g. view tab assignments). Headless flow doesn't care, but the mechanism is now load-bearing in a way that's wrong by design.
3. **It doesn't constrain `getCommittableFiles`.** The per-graph daily refresh in `dailyRetrieveAllAutomationService.ts:138` still commits the entire workspace's dirty set under a single-graph commit message. Hard-reset reduces the chance of stale dirty state surviving, but doesn't fix the message-scope lie.
4. **The defect has been present and reproducing for at least a month.** Kevin's `b1c1da90` message references the original mid-April recurrence. We do not know how many other config fields drift the same way and we just haven't noticed because they don't show up in the daily-fetch enumerator.

---

## What is ruled out

| Hypothesis | Status |
|---|---|
| Pre-pass not running | **Ruled out** — `Cleared sha on 8 graph file(s)` appears in today's `.dagnet/automation-logs/retrieve-all-12-May-26.json` |
| Pull not seeing the file | **Ruled out** — same log: `GIT_PULL_SUCCESS ... +4 new: ..., li-cohort-segmentation-v2.json, ...` |
| Pull silently routing through 3-way merge | **Ruled out by file classification** — files in `newFiles` array, not `changedFiles` |
| Remote-side: user's GUI edit didn't push | **Ruled out** — `git show f5c2f8c6` on nous-conversion shows the exact `false`-write hitting `main` at 12-May 00:36 |
| dailyFetch is some special case | **Ruled out** — `REMOTE_WINS_KEYS` in `mergeService.ts:265` only contains `_bayes`. `dailyFetch` flows through the generic structural merge path |

---

## What is NOT ruled out (the real diagnostic surface)

After the pull's `+4 new` write to IDB, but BEFORE `enumerateDailyFetchGraphsFromIDB` reads IDB, **`data.dailyFetch` on `li-cohort-segmentation-v2` flips from the remote `false` value back to `true`**.

Today's log proves this empirically: enumeration reports

```
"Found 4 graph(s) with dailyFetch=true",
"details": "conversion-flow-v2-recs-collapsed, gm-rebuild-jan-26, li-cohort-segmentation-v2, li-energy-simple-v1"
```

— but the remote state from the pull was `false`. So something between [`repositoryOperationsService.pullLatestRemoteWins`](../../../graph-editor/src/services/repositoryOperationsService.ts) returning and [`enumerateDailyFetchGraphsFromIDB`](../../../graph-editor/src/services/dailyAutomationJob.ts) running ([`dailyAutomationJob.ts:550→615`](../../../graph-editor/src/services/dailyAutomationJob.ts#L550-L615)) is overwriting IDB with stale data.

### Candidate root causes (in suspicion order)

**(a) FileRegistry pending-replay race ([GRAPH_WRITE_SYNC_ARCHITECTURE.md §7](../codebase/GRAPH_WRITE_SYNC_ARCHITECTURE.md)).** Documented critical instability: `setTimeout(() => updateFile(fileId, pending))` can fire after a foreign update has landed, writing stale `data` back to IDB. If the timing happens to overlap with the upfront pull (e.g. a write from a prior session or open tab was still pending when the automation started), the pending replay clobbers the fresh remote payload.

- **Why this fits:** explains the silent revert with no log trace; the replay path at TabContext L354 calls `updateFile(fileId, pending)` *without* opts, bypassing `syncOrigin` checks; pending data is stored as raw object, not by reference to file state at write time, so it can be arbitrarily stale.
- **Why this fits less well in headless mode:** ?retrieveall starts cold (or near-cold) on the headless tab. Pending updates shouldn't normally accumulate before the pull. But the symptom recurs daily, so this requires inspection of pending state at run start.

**(b) `loadWorkspaceFromIDB` deduplication picks a stale variant ([`workspaceService.ts:1278-1378`](../../../graph-editor/src/services/workspaceService.ts#L1278-L1378)).** Iterates all files for the workspace, dedups by canonical fileId, prefers entry with highest `data.updated_at`. If a stale-but-newer-`updated_at` variant exists in IDB (e.g. orphan record from a migration or interrupted prior run), it wins over the pull's freshly-written record. Loader writes to FileRegistry only — does NOT write IDB back — so this can't directly cause the IDB revert. But it can corrupt FileRegistry, which is what subsequent `setGraph` calls in `dailyRetrieveAllAutomationService` echo back to IDB.

**(c) `lagHorizonsService.recomputeHorizons({ mode: 'global' })` ([`dailyRetrieveAllAutomationService.ts:111-119`](../../../graph-editor/src/services/dailyRetrieveAllAutomationService.ts#L111-L119)).** Runs per target graph but in `mode: 'global'`. Need to determine whether "global" walks every graph in the workspace and `setGraph`s it back — if so, it could be projecting a stale FileRegistry state (caused by (b)) into IDB for graphs that aren't the current target. The flip on `li-cohort` happens during the daily-refresh for `conversion-flow-v2-recs-collapsed`, which would be consistent with a cross-graph mutation.

**(d) Orphan/legacy IDB record variants with a non-canonical `fileId` shape.** The pre-pass query is `where('source.repository').equals(repository).and(f => f.source?.branch === branch && f.type === 'graph')`. Anything missing `source.repository` or with a malformed branch would not be sha-cleared but could be picked up by the enumerator's looser iteration (`db.files.where('type').equals('graph')`). The enumerator's "last prefixed wins" replacement at [`dailyAutomationJob.ts:277-288`](../../../graph-editor/src/services/dailyAutomationJob.ts#L277-L288) would then prefer the orphan over the freshly-written prefixed record. Hard-delete patch papers over this; the underlying schema-rot is real.

---

## Concrete diagnostic plan

Each step is intended to localise the defect to one of (a)–(d) above.

1. **Pre-patch baseline snapshot.** Revert the hard-delete locally (or run on a branch), trigger `?retrieveall` against a fresh IDB seeded to reproduce the cycle. Verify the symptom still reproduces with sha-clear-only.
2. **Per-step IDB dump.** Add temporary diagnostic logging at four points:
   - immediately after pre-pass returns
   - immediately after `workspaceService.pullLatest` returns
   - immediately after `loadWorkspaceFromIDB` returns
   - inside `enumerateDailyFetchGraphsFromIDB`, before reading `data.dailyFetch`

   At each point, dump `{ fileId, sha, data?.dailyFetch, data?.updated_at, isDirty }` for every `type='graph'` record in IDB, plus the FileRegistry entry for the same canonical id. Persist to a separate JSONL file under `.dagnet/automation-logs/` so it survives the run.

3. **FileRegistry pending audit.** At the start of `?retrieveall`, log the contents of `fileRegistry.pendingUpdates` and `fileRegistry.updatingFiles`. If non-empty for graphs at run start, hypothesis (a) is confirmed.

4. **Horizons-recompute mutation audit.** Wrap the `setGraph` callback passed to `recomputeHorizons` with a logging proxy that records `{ fileId, before.dailyFetch, after.dailyFetch }`. If `dailyFetch` mutates here for graphs *other* than the target, hypothesis (c) is confirmed.

5. **Orphan IDB record scan.** One-shot query: list every `type='graph'` record in IDB with their `source.repository`, `source.branch`, and canonical fileId. If duplicates or non-standard fileId shapes exist, hypothesis (d) is confirmed.

The hard-reset patch can stay in place during this work — it provides a safe floor while we figure out which of (a)–(d) is real.

---

## What we want from a stable fix

1. The upfront pull's contract — "remote is authoritative for graph config fields, locally-cached graph data MUST NOT override remote on `?retrieveall`" — is correct as designed. The sha-clear-only mechanism was correct in intent. The defect is that the *consumer side* (something between pull-end and enumeration-start) still reads or writes via a stale path.
2. Fix should be **at the defect site**, not at the pull. Hard-delete is global blast radius; the real fix is targeted at whichever of (a)–(d) is failing.
3. Once located, the hard-delete pre-pass can be reverted, restoring the gentler sha-clear-only behaviour as a backup, and the targeted fix carries the load.
4. While we're in this code path, the `getCommittableFiles` workspace-wide commit under a per-graph commit message is a separate defect ([`dailyRetrieveAllAutomationService.ts:138`](../../../graph-editor/src/services/dailyRetrieveAllAutomationService.ts#L138)). Constraining the commit to the target graph's files (graph + its parameters/nodes/cases) would prevent any future stale-state defect from leaking across graphs.

---

## Files modified by the patch

| File | Change |
|---|---|
| `graph-editor/src/services/repositoryOperationsService.ts` | Replaced sha-clear pre-pass with hard-delete + FileRegistry purge + cache invalidation |
| `graph-editor/src/services/dailyAutomationJob.ts` | Updated comment block above the `overwriteGraphs: true` call to describe the new HARD RESET semantics |
| `nous-conversion/graphs/li-cohort-segmentation-v2.json` | `dailyFetch: true → false` |

Tests run: 52 passed across `workspaceService.integration.test.ts`, `headlessRetrieveAllParity.integration.test.ts`, `nonBlockingPullService.test.ts`. None of these exercise the pending-replay race, the horizons-recompute cross-graph mutation, or the orphan-record case — they pass because the hard-delete behaves correctly under the conditions they DO cover. They do not prove the underlying defect is fixed because they don't reproduce it.
