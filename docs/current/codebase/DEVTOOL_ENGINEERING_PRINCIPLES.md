# Devtool Engineering Principles

**Date**: 14-Apr-26
**Status**: Active

Hard-won principles for building and maintaining diagnostic infrastructure (test harnesses, monitors, log pipelines, regression runners). These tools are the project's eyes — when broken or misleading, every diagnosis downstream is compromised.

---

## 1. The core problem

Devtools in this project have a history of being written quickly, patched incrementally, and never reviewed with the rigour applied to production code. Result: accumulated defects that silently degrade diagnostic capability across sessions. Nobody notices until catastrophic failure — by which time the tool has been broken for weeks.

Specific incidents:

- **Monitor log deletion** (14-Apr-26): `bayes-monitor.sh` bound `^b e` to a handler that deleted all finished harness log files. The user pressed it after a multi-hour regression run, destroying all diagnostic data. The keybinding was labelled "clear finished" — the user expected a display reset. See anti-patterns 37 and 38.

- **Hunt script timing extraction** (13-Apr-26): `hunt-phase2-pathology.sh` parsed the wrong log format for Phase 2 timing. Every hunt run reported "no pathology found" when pathology was present. Fixed mid-session but the broken script had been used for 40+ runs.

- **Feature flag parser** (13-Apr-26): `test_harness.py` only accepted boolean feature flags. `latency_reparam_slices=2` was silently rejected. Fixed to accept int/float.

- **Stdout buffering** (14-Apr-26): a new script was launched in background mode. Python buffered stdout because output was piped to a file. No output appeared for the entire multi-hour run. The user thought the script was frozen.

---

## 2. Principles

### 2.1 Devtools are production code

Devtools run in production-equivalent contexts (real data, real compute, real time pressure). A broken devtool wastes the same amount of human time as a broken production feature. Apply the same engineering standards: review, test, document.

### 2.2 Separate display state from diagnostic data

Devtools handle two categories of state:

- **Display state**: which panes are visible, what's scrolled, what's highlighted, what's hidden from a dashboard. Ephemeral. Can be reset freely.

- **Diagnostic data**: log files, trace dumps, recovery results, harness output, regression summaries. Durable. Primary evidence for understanding what happened.

These must be managed by completely separate code paths. A display operation must never call `rm` on a data file. A data cleanup operation must never be bound to a casual keybinding. Naming must be unambiguous: "hide from display" not "clear".

### 2.3 Read-only by default

Monitoring, status, and display scripts should only read state. If a script needs to modify state (kill processes, remove files, write config), the modification must be:

- Named explicitly (not bundled as a side effect of reading)
- Visible to the user (logged to stdout)
- Confined to its own script or flag

A "status" script should not also "clean up". A "monitor" should not also "delete".

### 2.4 No silent data loss

No devtool action — keybinding, script, cleanup function — may silently delete diagnostic data. If deletion is genuinely needed (freeing disk space), the action must:

- Be explicitly named ("delete all finished logs")
- Require confirmation
- Report what was deleted

### 2.5 Output must be visible

Long-running scripts must produce visible incremental output:

- **Background runs**: use `python3 -u` (unbuffered) or `PYTHONUNBUFFERED=1`. Python buffers stdout when piped to a file. Without this, the user sees nothing until the process exits.

- **Incremental summaries**: for multi-graph or multi-phase runs, write a summary file after each unit of work completes. Use `open(..., "a")` (append mode) with explicit `flush()` or file close-and-reopen, not accumulated in-memory writes.

- **Subprocess output**: when a script runs subprocesses with `capture_output=True`, the script's own `print()` calls are the only visible output. Ensure they report meaningful progress.

### 2.6 Processes must not orphan

When a parent script (e.g. `resilience-strategies.py`) is killed, its child subprocesses (e.g. `param_recovery.py` → `test_harness.py`) must also terminate. Use process groups (`kill -- -$PID`), signal handlers, or `atexit` cleanup to ensure child processes don't continue consuming CPU after the parent dies.

### 2.7 Format strings must handle mixed types

Summary formatting code frequently does `f"{value:<8s}"` where `value` might be a float, int, string, or `'?'` default. Always `str()` the value before applying string format codes, or use type-appropriate format codes with fallbacks. A `ValueError` in a summary formatter can crash an entire regression run after hours of compute.

### 2.8 Test devtools with their own output

Before launching a new or modified devtool for a real run:

1. Run it once with minimal input (1 graph, few iterations) in the **foreground**
2. Verify output is visible and correct
3. For background runs: confirm the output file has content before scaling up

This is the single most violated principle in this project. The agent repeatedly writes scripts, syntax-checks them, and launches multi-hour background runs without verifying output appears.

---

## 3. Audit checklist for devtool changes

Before committing changes to any file in the CLAUDE.md infrastructure list:

- [ ] Does any code path `rm`, `unlink`, or `truncate` a log file, trace file, or diagnostic output? If so: is it behind explicit confirmation? Is the naming unambiguous?
- [ ] Does any "display" or "monitor" function modify shared state (`/tmp` files, lock files, process signals) as a side effect?
- [ ] Will output be visible when run in background mode? (Check for stdout buffering.)
- [ ] If the script spawns subprocesses, are they cleaned up on parent exit?
- [ ] Have you run it once in foreground with minimal input to verify it works?
- [ ] Do format strings handle all possible value types without crashing?

---

## 4. Anti-patterns (cross-reference)

### Anti-pattern 37: Devtool "clear" action that destroys diagnostic data

**Signature**: a keybinding, script, or UI action labelled "clear" or "clean up" silently deletes primary diagnostic output (log files, trace files, recovery results). The user invokes it expecting a display reset and loses irreplaceable run data.

**Root cause**: developer conflates "clear the display" with "delete the underlying data". A function intended to tidy the UI uses `rm -f` on the source files instead of hiding them from the display layer. No confirmation prompt, no warning.

**Fix**: devtool "clear" actions must never delete diagnostic data — they operate on the display layer only. See §2.2 (separate display state from diagnostic data) and §2.4 (no silent data loss).

**Example**: `bayes-monitor.sh` bound `^b e` ("clear finished") to a handler that `rm -f`'d all harness log files for finished graphs. The user pressed it after a 3-hour regression run, deleting all 21 graphs' diagnostic logs. Fixed: `^b e` now writes hidden graph names to a display-only filter file; log files are untouched.

### Anti-pattern 38: Devtool script with unvalidated side effects on shared state

**Signature**: a helper script (monitor, status dashboard, cleanup tool) modifies shared state (`/tmp` files, lock files, process signals) as a side effect of a display or monitoring operation. The modification is not visible to the user and is not logged.

**Root cause**: devtool scripts written quickly as "just a helper" without the rigour applied to production code. Side effects added for convenience ("clean up stale locks while we're at it") without considering unexpected invocation contexts.

**Fix**: see §2.1 (devtools are production code), §2.3 (read-only by default). Status scripts read; cleanup scripts modify. Don't bundle the two.

**Example**: the bayes monitor status script removed stale lock files as a side effect of checking process status. Low-risk in isolation, but established the pattern that led directly to AP37.
