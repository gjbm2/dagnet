# Session Log Overhaul — Diagnostic Escalation Crash Fix + Level Reclassification

**Date**: 7-Apr-26
**Status**: Implemented (Phases 1-4 complete)
**Severity**: Critical (browser crash on automated runs)

---

## 1. The Bug

During automated retrieve-all runs on large graphs (e.g. 30 slices × 30 params), the browser crashes at the tail end of the process. The crash occurs when a warning or error triggers the session log's diagnostic escalation mechanism, which materialises hundreds of large log entries into the live log and forces the UI to render them all synchronously.

---

## 2. Root Cause

The `BATCH_ALL_SLICES` operation in `retrieveAllSlicesService.ts` (line 288-294) is started with `{ diagnostic: true }`. This means the entire operation — parent and all children — is buffered in memory, invisible to the session log viewer, until either:

- The operation ends cleanly → buffer is silently discarded (happy path)
- A warning/error child is added → `promoteDiagnosticOperation()` fires (crash path)

### What promotion does (sessionLogService.ts, lines 441-468)

1. Pushes the parent entry (with its entire `children[]` array) into `this.entries`
2. Registers every buffered child in `entriesById`
3. Sets `expanded = true` on the parent
4. Calls `notifyListeners()`, triggering a React re-render of the SessionLogViewer

### Why this crashes

For a 30×30 run, the buffer accumulates **~1500 child entries** across 30 slices. Many carry large payloads:

| Child operation | Payload location | Approx. size per slice |
|---|---|---|
| `DB_COVERAGE_PREFLIGHT_REQUEST` | `details` (pre-stringified JSON of up to 200 subjects with closure sets) | 100-200 KB |
| `DB_COVERAGE_PREFLIGHT_RESPONSE` | `details` (pre-stringified JSON of up to 200 results with missing ranges, equivalence resolution) | 200-400 KB |
| `DB_COVERAGE_ITEM_NOOP/MISSING` (×30, diagnostic only) | `details` (JSON of subject + result + plan_before per item) | 90 KB total |
| `DB_COVERAGE_ITEM_AFTER` (×N, diagnostic only) | `details` (JSON of db_windows_added + plan_after) | variable |
| `FETCH_PLAN_BUILT` | `details` (formatted table) + `context.diagnostics` (plan diagnostics object) | 5-50 KB |
| `WHAT_WE_DID` | `details` (formatted execution table) + `context.rows` (full executionRows array) | 10-20 KB |

**Per slice total**: 400-700 KB (without diagnostic logging) to 500-900 KB (with diagnostic logging).
**30 slices**: **12-27 MB of payload in the children array.**

But this is just the raw data size. The actual damage is worse:

1. **DOM materialisation**: `expanded = true` causes `SessionLogViewer` to render all 1500 children. Each child with a `context` object triggers `ContextField`, which calls `JSON.stringify(value, null, 2)` synchronously in the React render cycle (SessionLogViewer.tsx lines 467, 486). Each child with `details` renders a `<pre>` tag containing the full pre-stringified JSON.

2. **Double-stringification**: The `details` fields already contain `JSON.stringify`'d output. When `ContextField` renders the `context` objects, it stringifies them again. The raw 15 MB becomes 30-50 MB of text content injected into the DOM.

3. **Repeated re-renders**: After promotion, `buffered.promoted = true` causes all subsequent `addChild()` calls to go through the normal path (line 324), which calls `notifyListeners()` on **every single child add** (line 360). For a run where the warning fires on slice 5, the remaining 25 slices produce ~750 individual `addChild` calls, each triggering a full React re-render of the entire tree. The browser is asked to reconcile and render 1500+ children 750 times.

4. **The `endOperation` double-tap**: When `endOperation()` is called with warning level (line 381), it calls `promoteDiagnosticOperation()` again (idempotent), then at line 427 sets `expanded = true` again and calls `notifyListeners()` once more.

### What triggers promotion in practice

Any of these events during the retrieve-all run:

- A single item fetch fails (any API error) → `ITEM_ERROR` (error child, line 1009)
- Rate limit hit → `RATE_LIMIT_HIT` (warning child, line 946)
- DB coverage preflight fails → `DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK` (warning child, line 717)
- A slice completes with any errors → `WHAT_WE_DID` emits as warning (line 1046), `SLICE_COMPLETE` emits as warning (line 1068)
- The run ends with any errors → `BATCH_WHAT_WE_DID` emits as warning (line 1185), `endOperation` with warning (line 1211)

The most common trigger is a single item failure — one 429 rate limit or one API timeout in a 900-item run is enough to crash the browser.

### The early-warning trigger is the worst case

If the first warning fires early (e.g. slice 3 of 30), promotion happens early. All subsequent slices (27 × ~50 children = ~1350 entries) are added via the normal `addChild` path, each calling `notifyListeners()`. The browser re-renders the growing tree 1350 times, each render getting more expensive as the children array grows.

---

## 3. The Underlying Design Problem

The session log has only four levels: `info`, `success`, `warning`, `error`. Per industry convention (OpenTelemetry, Syslog/RFC 5424):

| Level | Purpose | What belongs here |
|---|---|---|
| **error** | Operation failed, requires attention | Unhandled exceptions, data loss, API 5xx |
| **warning** | Degraded but recoverable | Retry succeeded, fallback used, approaching limit |
| **info** | Significant business events, operation boundaries | "Retrieve All started", "Retrieve All complete", "Committed 5 files" |
| **debug** | Diagnostic detail for developers | Per-item processing, intermediate state, cache hits, fetch plan tables |
| **trace** | Extremely verbose, per-call granularity | API request/response bodies, serialised data structures |

The current codebase has no `debug` or `trace` levels. Everything that isn't warning/error is logged as `info`. The `{ diagnostic: true }` buffering system was bolted on as a workaround — it implements tail-based sampling (buffer everything, decide at operation end whether to surface it) but treats all buffered content as equally important. When promotion fires, it's all-or-nothing because there's no level granularity to filter by.

This means:
- The crash cannot be fixed by adjusting the promotion logic alone, because with diagnostic logging enabled, all entries bypass buffering entirely and go straight to the log — the same crash via a different path
- The `{ diagnostic: true }` option on `startOperation` is doing the job that `debug`/`trace` levels should be doing
- Callers currently use `info` for everything and rely on the diagnostic buffer to hide the noise

---

## 4. Proposal: Add `debug`/`trace` Levels + Reclassify Call Sites

### Phase 1: Add levels to the service

**File**: `sessionLogService.ts`

1. Extend `LogLevel`: `'info' | 'success' | 'warning' | 'error' | 'debug' | 'trace'`

2. **Level ordering** (explicit, used for all threshold comparisons):

   ```
   trace < debug < info = success < warning < error
   ```

   `success` is treated as equivalent to `info` for threshold purposes — it passes the info threshold and renders. It is a positive outcome marker, not a separate severity tier.

3. Add a **display level threshold** to the service. Default: `info` (debug/trace entries are below the threshold). Controlled by the viewer's level selector (replacing the diagnostic toggle).

4. `addChild()`: debug/trace children are added to `parent.children` during the operation (they may be needed for context if the user lowers the threshold mid-run), but `notifyListeners()` is **only called if the child's level meets the display threshold**. This eliminates the re-render storm — debug/trace children accumulate silently. Note: if a parent is expanded in the viewer and debug children are added silently, the viewer's child count will be momentarily stale until the next info+ entry triggers a re-render. This is acceptable — the alternative is the crash.

5. `endOperation()`: when an operation ends, **strip sub-threshold children from `parent.children`**. This is the cleanup step that prevents memory leaks. During the operation, debug/trace children accumulate in the array (in case the user lowers the threshold). When the operation completes, children below the display threshold are removed and become eligible for GC. This mirrors what the current buffer discard does in `endOperation` (lines 389, 392-397), just without the buffer indirection.

### Phase 2: Reclassify call sites in the hot path

The crash comes from two files. Reclassification is mechanical — change the level argument on `addChild` calls.

**File**: `retrieveAllSlicesService.ts` (26 call sites)

| Operation | Current level | New level | Rationale |
|---|---|---|---|
| `FETCH_PLAN_BUILT` | info | **debug** | Per-slice plan detail |
| `DB_COVERAGE_PREFLIGHT_START` | info | **debug** | Per-slice diagnostic step |
| `DB_COVERAGE_PREFLIGHT_SHAPE` | info | **debug** | Diagnostic metadata |
| `DB_COVERAGE_PREFLIGHT_REQUEST` | info | **trace** | Full API request dump |
| `DB_COVERAGE_PREFLIGHT_RESPONSE` | info | **trace** | Full API response dump |
| `DB_COVERAGE_PREFLIGHT_DETAIL` | info | **debug** | Per-item coverage summary |
| `DB_COVERAGE_ITEM_NOOP` | success | **trace** | Per-item diagnostic (currently gated by `diagnosticOn`) |
| `DB_COVERAGE_ITEM_MISSING` | info | **trace** | Per-item diagnostic (currently gated by `diagnosticOn`) |
| `DB_COVERAGE_ITEM_WIDENED` | info | **debug** | Per-item diagnostic |
| `DB_COVERAGE_ITEM_AFTER` | info | **trace** | Per-item plan mutation detail (currently gated by `diagnosticOn`) |
| `DB_COVERAGE_PREFLIGHT_RESULT` | info/success | **debug** | Per-slice preflight summary — noise on clean runs (see clean-run analysis below) |
| `DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK` | warning | **warning** | Unchanged — warnings stay |
| `DB_COVERAGE_PREFLIGHT_SKIP` | warning | **warning** | Unchanged |
| `SLICE_SKIPPED_NO_WINDOW` | warning | **warning** | Unchanged |
| `BATCH_HIGH_VOLUME` | warning (top-level) | **warning** | Unchanged (not a child of BATCH_ALL_SLICES) |
| `SKIP_NO_EVENT_ID` | info | **debug** | Per-item diagnostic |
| `RATE_LIMIT_HIT` | warning | **warning** | Unchanged |
| `RATE_LIMIT_ABORT` | error | **error** | Unchanged |
| `ITEM_ERROR` | error | **error** | Unchanged |
| `WHAT_WE_DID` | success/warning | **debug**/warning | Per-slice execution artefact — debug when successful (see note below), warning when errors |
| `SLICE_COMPLETE` | success/warning | **info**/warning | Slice completion — keep at info, stays warning on errors |
| `RETRIEVE_MARKER_STAMPED` | success | **info** | Meaningful state change |
| `BATCH_WHAT_WE_DID` | success/warning | **info**/warning | Run-level artefact — keep |
| `BATCH_SUMMARY` | success/warning | **info**/warning | Run-level summary — keep |

**Note on `WHAT_WE_DID`**: This entry carries both a formatted execution table in `details` and the full `executionRows` array in `context.rows`. At info level with 30 successful slices, that's 30 children each with ~9KB of `context.rows` data — all of which would render on auto-expand if a warning triggers. Reclassifying successful `WHAT_WE_DID` to **debug** means only the warning-level instances (slices with errors) appear at the default threshold. The `context.rows` field should also be removed from `WHAT_WE_DID` entries — it duplicates the information already in the formatted `details` table but in a less readable, heavier form.

**Trace-level allocation gating**: The entries marked as `trace` above that are currently gated by `diagnosticOn` checks (`DB_COVERAGE_ITEM_NOOP/MISSING`, `DB_COVERAGE_ITEM_AFTER`) should **retain their allocation gates**, reframed as threshold checks. Instead of:

```
if (diagnosticOn) { sessionLogService.addChild(logOpId, 'info', ...) }
```

Use:

```
if (sessionLogService.isLevelEnabled('trace')) { sessionLogService.addChild(logOpId, 'trace', ...) }
```

This avoids unconditional allocation of ~900 trace-level objects per run (~2.7 MB of `JSON.stringify` output) when nobody will ever see them. The `isLevelEnabled(level)` method checks against the current display threshold — it returns `true` only when the user has explicitly lowered the threshold to trace. At the default `info` threshold, these entries are never created.

**File**: `getFromSourceDirect.ts` (68 call sites)

This file currently uses `{ diagnosticChildren: true }` on its `startOperation`. With proper levels, the parent stays at `info` and children are reclassified:

| Pattern | Current level | New level |
|---|---|---|
| Per-item cache analysis, file read detail | info | **debug** |
| API call request/response detail | info | **trace** |
| Operation boundaries (start, complete, failed) | info/success/error | **unchanged** |

The exact reclassification of each of the 68 call sites is mechanical and should be done by reading each call in context — but the principle is simple: if it describes a per-item intermediate step, it's debug; if it dumps a request/response body, it's trace.

### Clean-run analysis: what survives at info threshold?

After Phase 4 removes the buffer, the `BATCH_ALL_SLICES` parent is always in `this.entries` (it's an info-level `startOperation`). On a clean 30-slice run, `endOperation` strips sub-threshold children. What remains:

| Operation | Level | Count | Size each |
|---|---|---|---|
| `SLICE_COMPLETE` | info (success) | 30 | ~200 bytes |
| `BATCH_WHAT_WE_DID` | info (success) | 1 | ~2 KB (sliceStats) |
| `BATCH_SUMMARY` | info (success) | 1 | ~1 KB |
| `RETRIEVE_MARKER_STAMPED` | info (success) | 1 | ~100 bytes |

**Total: 33 info-level children, ~10 KB.** This is manageable.

The parent is collapsed by default (no warning → no auto-expand). The user sees one line: "Retrieve All Slices: 30 slices — success". They can expand to see the 33 children if they want.

This is a **behaviour change from the current system**, which shows nothing on a clean run (the entire buffered operation is discarded). The new behaviour is arguably better — the user gets confirmation that the run completed. During the Phase 1+2 transitional state (buffer still in place), clean runs still show nothing; the change takes effect when Phase 4 removes the buffer.

Previously `DB_COVERAGE_PREFLIGHT_RESULT` was at info, which would have added 30 more children (total 63). Reclassifying it to debug keeps the clean-run children count at 33.

### Reclassification risk

The highest-risk element of this proposal is the reclassification judgements, not the service changes. Each of the ~50 call sites is a judgement call. Guidelines to minimise risk:

- **Never change warning/error levels** — these must always pass the threshold. Grep for `'warning'` and `'error'` in the reclassified files to verify none were changed.
- **Err on the side of info** — if unsure whether an entry is info or debug, leave it at info. A noisy info entry is harmless; a suppressed important entry is harmful.
- **Trace entries must have allocation gates** — any entry reclassified to trace that carries a `JSON.stringify`'d payload should be gated by `isLevelEnabled('trace')` to prevent unconditional allocation.

### Phase 3: Viewer changes

**File**: `SessionLogViewer.tsx`

1. `getLevelIcon`: add cases for `debug` (e.g. `🔍`) and `trace` (e.g. `📋`)
2. `log-level-debug` and `log-level-trace` CSS classes — muted styling with adequate contrast (e.g. grey-500 `#6b7280` meets WCAG AA)
3. **Filter children by display threshold when rendering.** When a parent is `expanded`, only render children at or above the threshold. This is the safety valve — even if someone expands a parent with 1500 children, only the info+ children render by default.
4. Add a level filter control to the viewer toolbar (dropdown: "info", "debug", "trace"). This replaces the current diagnostic logging toggle with a standard log level selector. Changing the level calls `sessionLogService.setDisplayThreshold(level)` and triggers a re-render.
5. When threshold is set to trace, show a note: "Trace entries are only captured while this threshold is active." This is because trace-level entries are gated by `isLevelEnabled('trace')` — they are not created retroactively.

### Phase 4: Remove diagnostic buffering

Once levels are in place:

1. Remove `DiagnosticOptions` interface and the `diagnostic`/`diagnosticChildren` flags
2. Remove `diagnosticBuffers` map and `promoteDiagnosticOperation()`
3. Remove the diagnostic logging toggle from the UI (replaced by level selector)
4. Remove `getDiagnosticLoggingEnabled()` / `setDiagnosticLoggingEnabled()` and all callers
5. Remove `DiagnosticBuffer` interface

The `startOperation` calls that currently pass `{ diagnostic: true }` just drop the option — they're info-level operations with debug/trace children, which is handled natively by the level system.

The `diagnosticOn` guards in `retrieveAllSlicesService.ts` (lines 461-463, 821) are replaced by `isLevelEnabled('trace')` checks (see Phase 2).

### Deployment ordering

The phases are **not independently deployable**. Phase 4 without Phase 2 makes the crash worse (removes the buffer safety net while everything is still at info level). The safe deployment order is:

1. **Phase 1 + Phase 2 together** — add levels and reclassify call sites. The diagnostic buffer still exists as a safety net, but debug/trace children no longer trigger re-renders.
2. **Phase 3** — viewer improvements. Display-only changes.
3. **Phase 4** — remove the buffer. Safe because levels now handle suppression.

Alternatively, all four phases can be deployed atomically in a single commit.

---

## 5. Why This Fixes the Crash (Both Paths)

**Path A: promotion path (current crash)**

After Phase 1+2, debug/trace children no longer trigger `notifyListeners()`. Even if promotion fires, the promoted tree contains only info+ children (debug/trace were stripped in `endOperation` or never rendered). After Phase 4, there is no promotion mechanism at all.

**Path B: diagnostic-logging-enabled path (secondary crash)**

No longer exists. The diagnostic logging toggle is replaced by a level selector. Setting the level to `debug` makes debug children visible, but trace children (the largest payloads) are still hidden. Setting to `trace` makes everything visible, but this is an explicit user choice and trace-level entries are only created when the threshold is at trace (via `isLevelEnabled('trace')` gates).

---

## 6. Data Lifecycle: How Children Flow Through the System

This section addresses the critical question of what happens to debug/trace children at each stage.

### During the operation

Debug/trace children are added to `parent.children` via `addChild()`. They exist as JS objects in the children array. `notifyListeners()` is NOT called, so the viewer doesn't re-render. Memory grows during the operation — for a 30×30 run at debug threshold, ~50 debug-level children per slice × 30 slices = ~1500 children. At the default info threshold with trace allocation gates, most of these are never created — only ~5 per slice (debug-level entries) accumulate.

### At `endOperation`

`endOperation` strips children below the display threshold from `parent.children`. The stripped children lose all references (they were never added to `entriesById` — only info+ children are registered there) and become eligible for GC. The parent entry in `this.entries` retains only its info+ children.

This mirrors what the current diagnostic buffer discard does — the buffer holds children during the operation and discards them at `endOperation`. The new model does the same thing without the buffer indirection.

### At `getEntries()`

`getEntries()` returns `[...this.entries]` — a shallow copy of the top-level entries array. Since `endOperation` already stripped sub-threshold children, the returned entries only contain info+ children. No deep filtering needed at this point.

**Important**: if `getEntries()` is called **during** an active operation (before `endOperation` strips children), the parent entry's `children` array still contains debug/trace children. Callers that serialise entries (like `automationLogService.persistRunLog()`) must only be called after the operation ends. This is already the case — `persistRunLog()` runs in the `finally` block of `dailyAutomationJob.ts`, after all retrieve-all operations have completed.

### At `persistRunLog()` / git commit

By this point, all operations have ended and `endOperation` has stripped sub-threshold children. `getEntries()` returns lean entries. `JSON.stringify` serialises only info+ data. The `AutomationRunLog` is small.

---

## 7. Implementation Summary

| Phase | Files | Changes | Effort |
|---|---|---|---|
| 1: Add levels | `sessionLogService.ts` | Add `debug`/`trace` to `LogLevel`. Add display threshold + `isLevelEnabled()`. Threshold check in `addChild` before `notifyListeners`. Strip sub-threshold children in `endOperation`. | Small |
| 2: Reclassify hot path | `retrieveAllSlicesService.ts`, `getFromSourceDirect.ts` | ~50 level changes. Replace `diagnosticOn` guards with `isLevelEnabled('trace')`. Remove `context.rows` from `WHAT_WE_DID`. | Mechanical — ~50 line changes across 2 files |
| 3: Viewer | `SessionLogViewer.tsx`, `SessionLogViewer.css` | Level icons, CSS classes, level selector dropdown, threshold-based child filtering in render | Small — UI additions |
| 4: Remove diagnostic buffering | `sessionLogService.ts` + 12 callers | Remove `DiagnosticOptions`, `diagnosticBuffers`, `promoteDiagnosticOperation`, diagnostic toggle, `DiagnosticBuffer`. Drop `{ diagnostic: true }` from callers. | Moderate — ~12 call sites + buffer infrastructure removal |

**Total**: ~100 line changes across ~8 files. ~100 lines of diagnostic buffering infrastructure deleted, replaced by ~20 lines of threshold logic.

---

## 8. Risk Assessment

**Risk: reclassifying entries to debug/trace hides useful information by default**

The info-level entries that remain are operation boundaries and summaries — the same information the user sees today on a clean run (where the diagnostic buffer is silently discarded). Debug/trace entries are one click away via the level selector. No information is lost.

**Risk: memory during a long-running operation**

Debug-level children accumulate in `parent.children` during the operation. At the default info threshold with trace allocation gates, this is ~5 debug entries per slice × 30 slices = ~150 entries, ~1-2 MB. At debug threshold, ~50 entries per slice × 30 slices = ~1500 entries, ~5-10 MB. At trace threshold, full allocation: ~15-50 MB. All are released at `endOperation`. This is bounded and acceptable.

**Risk: removing diagnostic buffering breaks existing behaviour**

The diagnostic buffering system has two behaviours: (1) suppress noise on clean runs, (2) surface detail on error runs. With levels: (1) is handled by the display threshold — debug/trace entries aren't rendered. (2) is no longer automatic — the user must lower the threshold manually. This is a deliberate trade-off: automatic escalation is the mechanism that causes the crash. The user can lower the threshold for a targeted re-run if they need diagnostic detail around a failure.

**Risk: the level selector exposes trace-level entries that could still be large**

If a user sets the level to `trace`, trace-level entries are created (via `isLevelEnabled` gates) and rendered. For a large run, this could be slow. This is an explicit user choice for targeted debugging. The automated run path never sets the level below info.

**Risk: `getFromSourceDirect.ts` has 68 call sites to reclassify**

Mechanical changes. Misclassifying an info entry as debug is harmless (slightly less noise). Misclassifying a warning/error as debug would suppress it — but warnings/errors are easy to audit and should never change level.

**Risk: `diagnosticChildren` mode (used by `getFromSourceDirect.ts`) has the same vulnerability**

At current scale (~42 children per individual fetch), `diagnosticChildren` is not a crash vector. Phase 4 removes it along with all other diagnostic buffering. The level system handles suppression natively.

---

## 9. Test Plan

There are **no existing tests** for `sessionLogService` — no tests for `startOperation`, `addChild`, `endOperation`, diagnostic buffering, or hierarchical logging. The one viewer test (`SessionLogViewer.tail.test.tsx`) covers tail-mode scrolling only. This is a code path replacement (diagnostic buffering → level-based filtering), so new tests are required.

**Test file**: `graph-editor/src/services/__tests__/sessionLogService.test.ts` (new — no existing suite for this service).

**What is real vs mocked**: Everything real. The session log service is self-contained — no external APIs, no filesystem, no network. Zero mocks.

**What would a false pass look like**: A test that asserts `getEntries().length` without checking the `children` arrays of returned entries. Top-level count could be correct while children arrays still contain debug/trace entries — the serialisation problem would persist undetected. Tests must assert on children array contents, not just entry counts.

### Group 1: Level-based suppression in `addChild`

- `should call notifyListeners when info child is added at info threshold`
- `should not call notifyListeners when debug child is added at info threshold` — the core crash fix
- `should not call notifyListeners when trace child is added at info threshold`
- `should call notifyListeners when debug child is added at debug threshold`
- `should always call notifyListeners for warning children regardless of threshold`
- `should always call notifyListeners for error children regardless of threshold`
- `should add debug/trace children to parent.children even when below threshold` — children exist in memory during the operation

### Group 2: `endOperation` cleanup

- `should strip debug children from parent.children when operation ends at info threshold` — the memory leak fix
- `should strip trace children from parent.children when operation ends at info threshold`
- `should retain info/warning/error children in parent.children after endOperation`
- `should retain debug children when threshold is at debug`
- `should not leave stripped children in entriesById` — no reference leak

### Group 3: `getEntries()` after `endOperation`

- `should return entries whose children contain only info+ entries after operation ends at info threshold` — assert on children array of returned parent, not just top-level count
- `should return entries whose children contain debug+ entries after operation ends at debug threshold`

### Group 4: `isLevelEnabled`

- `should return false for debug at info threshold`
- `should return false for trace at info threshold`
- `should return true for debug at debug threshold`
- `should return true for trace at trace threshold`
- `should always return true for info, warning, error regardless of threshold`

### Group 5: Threshold changes

- `should trigger notifyListeners when threshold is lowered` — viewer re-renders to show newly-visible entries
- `should strip to new threshold on next endOperation after threshold is raised`

### Group 6: Parity with current diagnostic buffering (regression)

- `should not include debug/trace children in getEntries on a clean run` — parity with current buffer discard: clean run produces lean entries
- `should surface warning/error children immediately via notifyListeners` — parity with current promotion: warnings are visible instantly
- `should not surface debug siblings when a warning child arrives` — the intentional behaviour change: current system promotes ALL siblings on warning, new system does NOT

### What is NOT tested

- Viewer rendering of level icons/CSS — visual, not behavioural
- The exact reclassification of each of the 50+ call sites — review task, not a test
- Integration with `automationLogService.persistRunLog` — downstream consumer; the service contract (`getEntries` returns lean data) is tested directly

---

## 10. Relationship to the Git Commit Feature

The git commit feature (committing automation logs to `.dagnet/automation-logs/`) was unblocked by this work and is now implemented. With debug/trace entries stripped at `endOperation`, committed logs are naturally lean. See AUTOMATION_PIPELINE.md § "Automation Logging" for details.

`automationLogService.commitLogToRepo()` commits periodic snapshots (every 10 min) and a final log at run completion. The periodic timer uses wall-clock deadlines (`sleepUntilDeadline`) to resist browser tab throttling.
