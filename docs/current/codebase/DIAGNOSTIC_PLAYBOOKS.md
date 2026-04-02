# Diagnostic Playbooks

Structured checklists for common symptoms. When something's broken, find the matching symptom below and work through the checks in order. Stop when you find the cause — don't skip ahead.

## Symptom: UI state not updating after code change

**Most likely NOT**: HMR/code staleness (see DEV_ENVIRONMENT_AND_HMR.md 5-step checklist to confirm)

**Check in order**:
1. Did you call `setGraph()` with a **new object reference**? In-place mutation of the graph object does not trigger React re-render. `setGraph(structuredClone(graph))` or returning a new object from the mutation.
2. Is the value you changed on the **graph edge/node**, or only on the **parameter file**? Data lives in 4 layers (see SYNC_SYSTEM_OVERVIEW.md): param file → graph edge projected → stashed slices → React. Changing one layer doesn't cascade to others automatically.
3. Is the file→store sync **suppressed**? Check `suppressFileToStoreUntilRef` (500ms blanket) and `dagnet:suppressFileToStoreSync` event (1000ms MSMDC). If your update happens during the suppression window, it's silently dropped.
4. Is `isSyncingRef` true? This blocks RF→Graph sync. Check if a Graph→RF sync is in progress (100ms clear timeout on slow path).
5. Is the component reading from the right source? FileRegistry (in-memory cache) vs GraphStore (Zustand) vs ReactFlow state — each can be stale independently.

## Symptom: File shows dirty but shouldn't

**Check in order**:
1. Is `isInitializing` still true? If `completeInitialization()` never fired (500ms after load), the file absorbs all edits silently. Check if the 500ms timeout was scheduled.
2. Did editor normalisation change the content? JSON key ordering, default injection, whitespace changes all trigger dirty if they happen after `isInitializing` becomes false.
3. Compare `data` vs `originalData` — which field differs? `JSON.stringify` both and diff. The differing field tells you which edit wasn't absorbed during init.
4. Was the file loaded from IDB with stale `originalData`? Check if `originalData` matches the last committed version or a mid-edit snapshot.

## Symptom: File should be dirty but isn't

**Check in order**:
1. Is `isInitializing` still true? All edits are absorbed into `originalData` during this phase.
2. Did something call `markSaved()` or `revertFile()` unexpectedly? Grep for calls to these methods and check if they're firing at the wrong time.
3. Is the dual IDB write happening? Both unprefixed and prefixed records must be updated. If only one is written, the other may have stale `isDirty`.

## Symptom: Commit not including expected files

**Check in order**:
1. Are you using `db.getDirtyFiles()` (correct) or `fileRegistry.getDirtyFiles()` (wrong for git ops)?
2. Is the workspace prefix correct? Dirty files in IDB are prefixed (`repo-branch-fileId`). Filter must use the right prefix.
3. Is the file actually dirty in IDB? Check `db.files.get(prefixedId)` — inspect `isDirty` field.
4. Did the file get `markSaved()` by a previous operation in the same session?

## Symptom: Chart not refreshing / showing stale data

**Check in order**:
1. Is the chart in **linked** or **pinned** mode? Linked follows the parent tab; pinned uses the frozen recipe. Check `recipe.mode`.
2. Has the **deps signature** changed? Compare `storedDepsSignature` vs `chartDepsSignatureV1(currentStamp)`. If equal, the chart correctly thinks nothing changed.
3. Did the input that changed actually affect a **tracked dependency**? Check `ChartDepsStampV1` — only analysis_type, analytics_dsl, scenarios, inputs_signature, reference_day, and compute_display trigger recompute.
4. Is the parent tab still open? If parent tab closed, chart demotes to pinned. If `pinned_recompute_eligible` is false, it can't refresh standalone.
5. Is `graphRevision` incrementing? If `setGraph` isn't being called with a new reference, downstream effects don't fire.

## Symptom: Data fetch returned stale/wrong results

**Check in order**:
1. Is the **core_hash** correct? Check `coreHashService.computeHash()` with the current query signature. If an event or context was renamed, the hash may have changed without a hash-mapping entry.
2. Are **equivalent_hashes** being sent? If hash-mappings.json has entries linking old→new hashes, the FE should send the closure set. Check `hashMappingsService.getEquivalentHashes()`.
3. Is the **slice_key** correct? Contexted queries must use the right slice. Check `fetchPlanBuilderService` output.
4. Is the snapshot DB returning the right rows? Check `/api/snapshots/query` response directly.
5. Is the FE **caching** a previous result? `graphComputeClient` has a 5-minute TTL cache. Check if the cache key matches.

## Symptom: Canvas analysis not computing / stuck loading

**Check in order**:
1. Does the content item have an `analysis_type` set? If not, computation can't start.
2. Does the content item have an `analytics_dsl` set? Without a subject DSL, there's nothing to analyse.
3. Is the graph loaded? Check `graph !== undefined` — computation gates on this.
4. For snapshot-requiring analyses (time_series, histogram): has snapshot resolution completed? Computation blocks until snapshots are resolved.
5. Is the 2000ms debounce still pending? Rapid graph changes delay computation.
6. Check the backend: is the Python server running? Is `/api/runner/analyze` returning errors?

## Symptom: Test failing unexpectedly

**Check in order**:
1. **Read the failing test** — understand what invariant it protects.
2. **Check if your change affects the test's dependencies** — grep for the function/field you changed in the test file and its fixtures.
3. **Check if the test uses real IDB** — if so, is your change affecting the IDB prefix convention or file state shape?
4. **Check if the test uses mocks** — if so, does your change match the mock's assumptions? Mocks that return hardcoded shapes break when the real interface changes.
5. **Run the test in isolation** (`npm test -- --run path/to/test.ts`) — does it pass alone but fail in the suite? If so, it's a test ordering/state leak issue.

## Symptom: Field keeps coming back after deletion

This is the **4-layer propagation problem** (see SYNC_SYSTEM_OVERVIEW.md and KNOWN_ANTI_PATTERNS.md):

1. **Layer 1 (param file)**: did you clear it from `file.data`?
2. **Layer 2 (graph edge projected)**: did you clear it from `edge.p.<field>` (or `edge.p.latency.<field>`)? UpdateManager mapping configurations project param file fields onto graph edges — clearing the file doesn't clear the graph copy.
3. **Layer 3 (stashed slices)**: did you clear `edge.p._posteriorSlices` or equivalent stashed data? `reprojectPosteriorForDsl` reads from stashed slices to regenerate the projected value.
4. **Layer 4 (React render)**: did you call `setGraph()` with a new reference? In-place mutation doesn't trigger re-render.
5. **Idempotency**: does your cleanup run even when the source data is already absent? If gated behind `if (count > 0)` where count tracks source deletions, the edge-clearing may be skipped on second run.

## Meta-diagnostic: when you're stuck

If you've been debugging for more than 2 attempts without finding the root cause:

1. **Stop coding. Read the architecture doc.** Find the relevant doc in the task-type reading guide and read it in full. The answer is almost certainly documented.
2. **Trace the full data path.** Write down every system the data touches, from user action to persistence. Find which step diverges from expectation.
3. **Add console.log at each step** (temporarily). Don't guess — observe. Mark boundaries and use `scripts/extract-mark-logs.sh`.
4. **Check KNOWN_ANTI_PATTERNS.md.** Your bug may match a previously-seen pattern with a known fix.
5. **Ask the user.** If the architecture is unclear after reading docs + code, asking is faster than guessing.
