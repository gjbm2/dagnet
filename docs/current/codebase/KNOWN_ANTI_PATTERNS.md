# Known Anti-Patterns

Failure patterns that have occurred in this codebase. If your current bug matches one of these signatures, apply the known fix — don't re-derive it.

## Anti-pattern 1: Clearing state from one layer only

**Signature**: you delete/clear a field, it appears to work, but the old value keeps coming back — or it works once but fails on the second run.

**Root cause**: data lives in 4 layers simultaneously:
1. Parameter file (FileRegistry/IDB) — `file.data.posterior`
2. Graph edge projected value — `edge.p.posterior` (probability) + `edge.p.latency.posterior` (latency)
3. Stashed slices — `edge.p._posteriorSlices` (raw data for re-projection)
4. React render tree — whatever reference React last saw via `setGraph`

Clearing layer 1 is useless unless you also handle layers 2-4. UpdateManager mapping configurations (`updateManager/mappingConfigurations.ts`) project param file fields onto graph edges — the file and the graph edge are separate copies, not references.

**Fix**: grep for ALL locations where the field is read or written. Clear all of them. Call `setGraph` with a new object reference to trigger re-render. Test the "already clean" case (field already absent).

**Example**: the 6-attempt posterior deletion failure — each attempt cleared a different layer but missed the others.

## Anti-pattern 2: Fixing one call site, missing others

**Signature**: you fix a bug, it works in the context menu, but the same bug persists in the properties panel / toolbar / inline picker / keyboard shortcut.

**Root cause**: the same operation is implemented in multiple places (context menu, toolbar, properties panel, inline picker, drag handler). Fixing one leaves the others broken.

**Fix**: before writing any fix, grep for ALL call sites that perform the same mutation. List every code path. Consolidate into ONE canonical function. Fix the function, not the call sites.

**Example**: changing analysis type was done in 4 places. Fix was `setContentItemAnalysisType()` — one function, all four call sites use it.

## Anti-pattern 3: In-place mutation without new reference

**Signature**: you mutate the graph object, but the UI doesn't update. Adding `console.log` shows the data is correct in memory.

**Root cause**: React's reconciliation requires a new object reference to trigger re-render. `graph.edges[0].p.mean = 0.5` mutates in place — React never sees the change. `setGraph(graph)` passes the same reference — React skips the update.

**Fix**: always return a new graph object. Use `structuredClone(graph)` or spread operators to create a new reference before calling `setGraph`. Better: use the UpdateManager methods which return new graph objects by design.

## Anti-pattern 4: Using FileRegistry for git operations

**Signature**: commit doesn't include all dirty files, or includes wrong files, or shows zero dirty files when there are clearly dirty tabs.

**Root cause**: `fileRegistry.getDirtyFiles()` queries the in-memory cache (unprefixed IDs, current session only). `db.getDirtyFiles()` queries IndexedDB (source of truth, prefixed + unprefixed, survives reload).

**Fix**: always use `db.getDirtyFiles()` for git operations. Filter by workspace prefix. See INDEXEDDB_PERSISTENCE_LAYER.md.

## Anti-pattern 5: Gating cleanup behind a count that can be zero

**Signature**: fix works the first time but fails on subsequent runs. Or works when data is present but fails when data was already cleaned.

**Root cause**: cleanup logic is inside `if (count > 0)` where `count` tracks how many items were found to clean. On second run, source is already clean → count=0 → derived state cleanup is skipped → derived copies persist.

**Fix**: always clean derived state unconditionally. The cleanup must be idempotent — it must work whether the source data is present, absent, or partially cleaned.

## Anti-pattern 6: Blaming HMR / code staleness

**Signature**: agent says "this might be a stale code issue" or "try refreshing the page" without evidence.

**Root cause**: HMR failures are rare and have obvious symptoms (console errors, yellow toast). The actual cause is almost always state propagation, IDB prefix mismatch, or sync suppression.

**Fix**: run the 5-step staleness diagnostic (DEV_ENVIRONMENT_AND_HMR.md) before blaming HMR. If all 5 pass, the issue is logic, not staleness.

## Anti-pattern 7: Patching the symptom, not tracing the root cause

**Signature**: fix addresses the visible symptom (e.g., "add a null check here") but the same class of bug keeps appearing in different forms.

**Root cause**: agent didn't trace the full data path to understand WHY the value was null/wrong. The null check masks the real issue.

**Fix**: apply the root-cause gate. Can you name the root cause in one sentence with a "because"? If not, keep investigating. Read the architecture doc for the subsystem. Trace from user action to persistence.

## Anti-pattern 8: Testing the mock, not the system

**Signature**: all tests pass, but the real feature is broken. Tests assert values that the mock was configured to return.

**Root cause**: test mocks IDB, mocks FileRegistry, mocks the service, then asserts against the mock's return value. The test is a closed loop — it proves the mock works, not the system.

**Fix**: use real IDB (fake-indexeddb), real FileRegistry, real GraphStore. Mock only external APIs (GitHub, Amplitude). Assert state in all affected subsystems, not just the return value. See Testing Standards in CLAUDE.md.

## Anti-pattern 9: Suppression window race during rapid mutations

**Signature**: state appears correct immediately after a change but reverts to a previous value after ~500ms.

**Root cause**: store→file sync sets a 500ms suppression window on file→store sync. If the suppression expires before all pending FileRegistry writes complete, a stale file notification can overwrite the store.

**Fix**: check `suppressFileToStoreUntilRef` timing. Check `writtenStoreContentsRef` for stale echo detection. See SYNC_SYSTEM_OVERVIEW.md for the full guard system.

## Anti-pattern 10: Assuming isInitializing is false

**Signature**: dirty detection doesn't work for a newly-loaded file. File appears clean despite real edits.

**Root cause**: `isInitializing` is true for 500ms after file load. During this phase, all edits are absorbed into `originalData` without marking dirty. If `completeInitialization()` doesn't fire (e.g., callback lost, file re-loaded), the phase never ends.

**Fix**: check `file.isInitializing` in the debugger. Verify `completeInitialization(fileId)` is scheduled and fires. See FILE_REGISTRY_LIFECYCLE.md.

## Anti-pattern 11: Computing signatures from graph config instead of stored state

**Signature**: a read-path surface (@ menu, planner, coverage UI) computes a signature independently and gets a different hash from what the write path (data fetch) stored. The surface shows "no data" despite data existing in the DB.

**Root cause**: the read path derives context keys from graph-level config (e.g., `dataInterestsDSL`) rather than examining what slices were actually stored in parameter files. The graph config may include ALL context dimensions (e.g., 3 MECE keys), while each individual fetch used just ONE context key per slice. Different context keys → different context definition hashes → different signature → different `core_hash` → no match in DB.

**Fix**: read paths must derive context keys from the **stored slice topology** (`parameterFile.data.values[].sliceDSL`), not from `dataInterestsDSL` or any other graph-level config. Enumerate all plausible context key-sets from stored slices, compute a signature for each, and query the DB with all of them. See `enumeratePlausibleContextKeySets` in `snapshotRetrievalsService.ts`.

**Example**: the @ menu showed no snapshots for `li-cohort-segmentation-v2` because `resolveContextKeys` fell back to `dataInterestsDSL` (3 context keys) while fetches stored snapshots under single-key signatures. Fixed by replacing the fallback with slice-topology-based enumeration.

## Anti-pattern 12: Unprefixed IDB key in file lookups

**Signature**: a function loads a file from `db.files.get(fileId)` using the FileRegistry-style unprefixed key (e.g., `event-myEvent`), but IDB stores files under workspace-prefixed keys (e.g., `nous-conversion-main-event-myEvent`). The lookup silently returns nothing.

**Root cause**: the FileRegistry uses unprefixed file IDs, but IDB uses `${repository}-${branch}-${fileId}` as the primary key. A direct `db.files.get(unprefixedId)` will never find a workspace-loaded file.

**Fix**: use `fileRegistry.restoreFile(fileId, workspaceScope)` which handles both unprefixed and prefixed key lookups. See `plannerQuerySignatureService.ts:152-168` for the correct pattern.

**Example**: `loadEventDefinition` in `snapshotRetrievalsService.ts` had `db.files.get(fileId)` as its IDB fallback — this always failed silently, causing event definitions to be missing from signature computation.

## Anti-pattern 13: Setup scripts that don't install all dependency sets

**Signature**: tests pass locally for weeks, then fail after `./dev-start.sh --clean` or a fresh `./setup.sh` run. The error is a missing module (`ModuleNotFoundError: No module named 'pymc'`) in a subsystem that was previously working.

**Root cause**: the repo has multiple `requirements*.txt` files for different subsystems (e.g., `graph-editor/requirements-local.txt` for the frontend Python backend, `bayes/requirements.txt` for the Bayesian compiler). Setup and dev-start scripts only installed the primary requirements file, not all of them. The missing deps only existed because someone had manually installed them in a previous venv session — a `--clean` rebuild wiped that implicit state.

**Fix**: ensure `setup.sh` and `dev-start.sh` install ALL requirement files into the shared venv. Both scripts must produce an identical, complete environment. Grep for all `requirements*.txt` files in the repo and verify each is referenced in both setup paths. When adding a new requirements file to the repo, add the install line to both scripts immediately.

**Broader principle**: any state that exists only because of manual one-off commands will eventually be lost. If the release script gates on it (e.g., bayes compiler tests), the setup script must produce it.

## When to add to this document

After completing a multi-attempt fix, check: does my bug match a generalisable pattern? If so, add it here following the format: Signature (how to recognise it), Root cause (why it happens), Fix (what to do), Example (optional, specific instance).
