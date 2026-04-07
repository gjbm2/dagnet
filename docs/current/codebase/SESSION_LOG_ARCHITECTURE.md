# Session Log Architecture

How the session log system works: levels, thresholds, hierarchical operations, viewer rendering, and the relationship between display threshold and diagnostic flags.

## Overview

The session log (`sessionLogService.ts`) provides hierarchical, user-facing logging for DagNet operations. It is **not** a console/debug log — it is designed for Business Analysts to understand what the app did with data, models, and graphs. System-level plumbing belongs at debug/trace levels, hidden from the default view.

## Log Levels

Six levels, ordered by severity:

```
trace < debug < info = success < warning < error
```

| Level | Purpose | Audience | Examples |
|---|---|---|---|
| **trace** | Raw payloads, per-call data | Deep debugging only | API request/response bodies, DB coverage preflight dumps |
| **debug** | Diagnostic detail | Developers | Cache analysis, signature filtering, fetch plans, per-item processing |
| **info** | Business events, operation boundaries | Business Analysts | "Retrieve All complete", "Committed 5 files", "Bayes fit submitted" |
| **success** | Positive outcomes (equivalent to info for threshold) | Business Analysts | "Pulled latest", "Created parameter X" |
| **warning** | Degraded but recoverable | Everyone | Rate limit hit, preflight fallback, data stale |
| **error** | Operation failed | Everyone | Fetch failed, commit failed |

`success` is treated as equivalent to `info` for threshold comparisons — it passes the info threshold and renders.

### Level assignment guidelines

- If a BA would find it useful to understand what happened → **info** or **success**
- If only a developer debugging internal logic would care → **debug**
- If it dumps a raw payload or API response body → **trace**
- Never change a **warning** or **error** to a lower level

## Display Threshold

The service maintains a `displayThreshold` (default: `info`). This controls:

1. **Which children trigger viewer re-renders**: `addChild()` only calls `notifyListeners()` if the child's level meets the threshold. Debug/trace children accumulate silently.
2. **Which children survive `endOperation()`**: when an operation ends, children below the threshold are stripped from `parent.children` and become eligible for GC.
3. **Which entries the viewer renders**: both top-level entries and children are filtered by threshold during render.
4. **Whether the diagnostic API flag is enabled**: `getDiagnosticLoggingEnabled()` returns `true` when the threshold is `trace`, `false` otherwise. This controls server-side diagnostic payloads (e.g. `batchAnchorCoverage` diagnostic flag).

### `isLevelEnabled(level)`

Use this at call sites to gate expensive object allocation:

```
if (sessionLogService.isLevelEnabled('trace')) {
  sessionLogService.addChild(opId, 'trace', 'PREFLIGHT_REQUEST',
    msg, JSON.stringify(heavyPayload, null, 2));
}
```

Without the gate, the `JSON.stringify` runs unconditionally even though the resulting entry would be stripped at `endOperation`. The gate prevents allocation when nobody will ever see the output.

## Hierarchical Operations

### startOperation / addChild / endOperation

Operations form a parent-child tree. The parent is created with `startOperation()`, children are added with `addChild()`, and `endOperation()` finalises the parent.

**During the operation**: all children (including debug/trace) are added to `parent.children`. Debug/trace children do NOT trigger `notifyListeners()` and are NOT registered in `entriesById`.

**At `endOperation()`**: children below the display threshold are stripped from `parent.children`. This is the cleanup step that prevents memory leaks and keeps `getEntries()` lean for downstream consumers (automation log persistence, git commit).

**Auto-expand**: if any child is warning/error, `endOperation` sets `expanded = true` on the parent.

### Why endOperation cleanup matters

Without cleanup, debug/trace children persist in `parent.children` forever — in memory, in `getEntries()`, and in `automationLogService.persistRunLog()` where they get serialised via `JSON.stringify`. For a 30-slice × 30-param retrieve-all, this could be 15-50 MB of debug/trace data. The `endOperation` strip is what prevents this.

If `endOperation` does not fire (e.g. due to an uncaught exception), children leak. All operation code paths must ensure `endOperation` is called in both success and error branches.

## Viewer

**File**: `SessionLogViewer.tsx`

### Level selector

A dropdown in the toolbar (Info / Debug / Trace) controls the display threshold via `sessionLogService.setDisplayThreshold()`. Changing it:
- Triggers `notifyListeners()` so the viewer re-renders
- Changes what `isLevelEnabled()` returns (affecting trace allocation gates)
- Changes what `getDiagnosticLoggingEnabled()` returns (trace = diagnostic on)

When set to trace, the viewer shows a note: "trace capture active" — because trace entries are only allocated when `isLevelEnabled('trace')` returns true.

### Rendering

Top-level entries are filtered by threshold before rendering. Children of expanded parents are also filtered by threshold. The viewer uses Lucide icons for level indicators:

| Level | Icon |
|---|---|
| trace | `Terminal` |
| debug | `Code` |
| info | `Info` |
| success | `CheckCircle2` |
| warning | `AlertTriangle` |
| error | `AlertCircle` |

### Copy

"Copy all" copies only entries at or above the current threshold — it copies what the user sees, not the raw internal data.

## Downstream Consumers

### automationLogService.persistRunLog()

Called by `dailyAutomationJob.ts` in the finally block after all operations end. By this point, all `endOperation` calls have stripped sub-threshold children. `getEntries()` returns lean entries. The serialised `AutomationRunLog` is small.

### Git-committed automation logs (planned)

The automation log commit feature (`.dagnet/automation-logs/`) will use the same `getEntries()` output. With debug/trace stripped, committed files are naturally lean.

## Legacy: Diagnostic Buffering (Removed)

The session log previously had a `{ diagnostic: true }` option on `startOperation` that buffered the entire operation in memory. If a warning/error child appeared, `promoteDiagnosticOperation()` flushed the entire buffer (parent + all children) into the log. This caused browser crashes on large runs (1500+ children materialised at once).

This mechanism has been replaced by level-based filtering. The `DiagnosticOptions` interface is retained for API compatibility but the flags are no-ops — `startOperation` accepts them and ignores them.

The `getDiagnosticLoggingEnabled()` method is retained but now derives from the display threshold (`true` when threshold is `trace`). External callers that use it to gate server-side API diagnostic flags continue to work.

## Key Files

| File | Role |
|---|---|
| `src/services/sessionLogService.ts` | Core service: levels, threshold, operations, entries |
| `src/components/editors/SessionLogViewer.tsx` | Viewer: level selector, threshold filtering, Lucide icons |
| `src/components/editors/SessionLogViewer.css` | Viewer styles: level-specific colours and borders |
| `src/services/automationLogService.ts` | IDB persistence of automation run logs |
| `src/services/dailyAutomationJob.ts` | Automation orchestrator (calls persistRunLog in finally block) |
| `src/services/__tests__/sessionLogService.test.ts` | 24 tests: level suppression, endOperation cleanup, threshold changes, parity |
