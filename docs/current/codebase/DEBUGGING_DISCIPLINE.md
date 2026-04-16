# Debugging Discipline

## No "Not My Problem" Dismissals (APPLIES TO EVERYTHING)

**CRITICAL**: "This isn't caused by my changes" is **never** an acceptable reason to stop investigating. It applies to test failures, unexpected behaviour, broken UI, stale state, console errors — anything you encounter while working.

You may (and should) note provenance: *"This doesn't appear related to edits made in this thread."* But that observation is the **start** of the investigation, not the end. The user hired you to solve problems, not to assign blame.

**Required response to any issue you encounter:**
1. **Investigate** — trace the cause with the same rigour you'd apply to your own bugs.
2. **Report** — explain what's wrong and why, with file paths and line numbers.
3. **Propose action** — fix it (if in scope and low risk), or flag it with enough context for the user to act.

"Not invented here" is never an acceptable pattern. The user sees a broken system, not a clean division of responsibility between you and prior commits. If you found it, you own the investigation.

## Root-Cause Gate (MANDATORY before writing any fix)

**Can you name the root cause in one sentence?** If not, you are not ready to write code. Continue investigating.

A root cause is not "X is wrong" — it's "X is wrong **because** Y writes to Z without updating W". If your explanation doesn't include the **because**, you're describing a symptom and your fix will be a patch. Consult `DIAGNOSTIC_PLAYBOOKS.md` for structured checklists by symptom type. Consult `KNOWN_ANTI_PATTERNS.md` for failure patterns that have happened before.

## Recurring Defect = Multiple Code Paths

When the user reports the same defect a second time after you "fixed" it, the most likely cause is **multiple code paths performing the same operation**. Before debugging further:

1. **Grep for ALL call sites** that perform the same mutation/operation
2. **List every code path** that can trigger it (context menus, toolbars, properties panels, inline pickers, keyboard shortcuts, drag-and-drop handlers)
3. **Verify your fix applies to ALL paths**, not just the one you found first
4. **Consolidate into ONE canonical function** that all paths call — do not fix each path independently

Example: changing an analysis type was done in 4 places (inline picker, chart toolbar, properties panel, context menu). Fixing one left three broken. The fix was `setContentItemAnalysisType()` — one function, all four call sites use it.

**If the user raises the same defect twice, assume multiple code paths until proven otherwise.**

## Post-Debugging: Update Codebase Docs (MANDATORY after non-trivial fixes)

After completing a fix that required more than one attempt, or that required understanding non-obvious system behaviour, **proactively propose a codebase doc update** before moving on. Do not wait for the user to ask.

**What to capture** (generalisable insights only, not the specific bug):
- **How the subsystem actually works** — if you discovered a data flow, guard mechanism, or invariant that isn't documented, add it to the relevant codebase doc
- **Diagnostic procedures** — if you developed a sequence of checks that would help the next agent diagnose similar issues faster, add it as a "Diagnostic checklist" section
- **Heuristics** — if "always check X before assuming Y" would have saved attempts, write it down

**What NOT to capture**: the specific bug itself (that belongs in the commit message), or anything derivable from reading the current code.

**How to propose**: tell the user *"This fix revealed that [subsystem] works differently than documented — I'd like to update [doc name] with [brief description]. OK?"* Then make the edit if approved. Small, targeted updates to existing docs are preferred over new docs.

## Devtool and Logging Integrity (BLOCKING — no workarounds)

**CRITICAL**: Devtools and logging machinery are the agent's eyes. A broken devtool doesn't just affect one task — it degrades every future session that depends on it. A broken logging pipeline means the agent is blind to everything and *won't know it's blind* because the tool runs without error, producing incomplete or wrong output.

**What counts as infrastructure** (not an exhaustive list):

- **Log streaming pipeline**: `debug/tmp.browser-console.jsonl`, `debug/tmp.session-log.jsonl`, `debug/tmp.python-server.jsonl`, the mirroring code that writes to them, mark injection into all three streams
- **Log extraction and diagnostics**: `scripts/extract-mark-logs.sh`, graph snapshot capture (`debug/graph-snapshots/`)
- **Session log service**: `sessionLogService.ts` — levels, thresholds, `startOperation`/`endOperation` lifecycle, viewer rendering
- **Test harnesses**: `bayes/test_harness.py`, `bayes/param_recovery.py`, `bayes/synth_gen.py`, synthetic builders in `bayes/tests/synthetic.py`
- **Regression and monitoring**: `bayes/run_regression.py`, `scripts/bayes-monitor.sh`, `scripts/resilience-strategies.py`, `scripts/hunt-phase2-pathology.sh`
- **Sampling infrastructure**: `ChainStallDetector` in `bayes/compiler/inference.py` (EMA-based stall detection, retry logic in `bayes/worker.py`)
- **Graph-ops scripts**: `graph-ops/scripts/*.sh` (parity, validation, param-pack, analyse)
- **Any script the agent is told to run** as part of a diagnostic or verification step

**Rule 1 — Broken infrastructure is a blocking issue.** If you discover that a devtool or logging component is defective — not just inconvenient, but producing wrong results, missing data, or failing — treat it as a **blocking issue**. Do not work around it. Do not patch over the symptom. Fix it properly or escalate to the user immediately. A workaround that makes a broken tool *look* like it works is worse than a hard failure, because it silently corrupts every downstream diagnosis.

**Rule 2 — Correctness, not minimality.** For feature code, the rule is "smallest change that accomplishes the intent." For infrastructure, the standard is **full correctness**. A minimal patch to a broken diagnostic tool means the tool looks like it works but still lies to you. If the proper fix is larger than a patch, do the proper fix. If you can only patch, say so explicitly: *"This is a patch, not a proper fix. The tool is still broken because [reason]. A proper fix requires [scope]."*

**Rule 3 — No silent workarounds.** If you find yourself working around an infrastructure limitation — manually parsing output that a script should handle, skipping a verification step because a tool crashes, reading raw JSONL because the extraction script returns wrong results — you must **immediately flag it**: *"I'm working around a defect in [tool]. This should be fixed properly — here's what's wrong: [root cause]. Shall I fix the tool now?"* The workaround must be visible, not silent. Silent workarounds accumulate across sessions and nobody notices until the tool is deeply broken.

**Rule 4 — Logging fidelity is non-negotiable.** Log streams and session logs are the primary evidence source for debugging sync, state, and data-flow issues. If a log stream is missing entries, writing to the wrong file, dropping marks, producing malformed JSONL, or silently swallowing errors, that is not a minor issue — it is equivalent to a test harness that passes broken code. Fix it with the same urgency you would fix a test that produces false passes.

**Rule 5 — Devtools must NEVER silently delete diagnostic data.** Log files, trace outputs, recovery results, and harness logs are primary evidence. No devtool action — keybinding, "clear" function, "cleanup" script, monitor helper — may delete these files. Display-layer operations (hiding entries from a dashboard, clearing a terminal, resetting a scroll position) must operate on display state only, never on the underlying data files. If a genuinely destructive action is needed (freeing disk space), it must be a separate, explicitly-named command with a confirmation prompt. See anti-patterns 37 and 38 for the incident that prompted this rule: a `^b e` keybinding labelled "clear finished" that `rm -f`'d all harness log files, destroying an entire regression run's results.

**Why this section exists**: agents repeatedly encounter broken devtools and treat them as background friction — applying a minimal patch or simply working around the breakage. This accumulates: each session leaves the tool slightly more broken, each workaround is invisible to the next session, and eventually the tool is so degraded that it actively misleads. The pattern is: patch, patch, patch, catastrophic misdiagnosis. The fix is: treat infrastructure breakage as urgent, not incidental.

## Cursor Debugging Workflow (Mirrored Logs + Marks)

For flaky sync issues (Graph ↔ FileRegistry ↔ store), **do not paste console output into chat**.
Instead, use the dev-only mirroring workflow:

- **Console stream file**: `debug/tmp.browser-console.jsonl`
- **Session log stream file**: `debug/tmp.session-log.jsonl`
- **Python server stream file**: `debug/tmp.python-server.jsonl`
- **Graph snapshots (per mark)**: `debug/graph-snapshots/*.json`

All three streams support **MARK** boundaries:
- Use the top-right dev UI (Console toggle + mark input), or run `window.dagnetMark('your label')` in DevTools.
- Marks are written to **all three** streams (console, session log, and Python server).
- The Python server stream is captured automatically when the dev server runs — no opt-in needed.

### How the agent should analyse logs

**CRITICAL**: When the user mentions a mark — **any phrasing**: "see mark X", "inspect mark X", "check mark X", "review mark X", "look at mark X", or just a message containing "mark 'X'" — run the extraction script **immediately as your first tool call**. Do not search for files. Do not try to reason without the logs. Do not use Glob/Grep on the debug directory. Just run the script.

**Primary tool** — `scripts/extract-mark-logs.sh`:

```bash
# Extract the LAST mark matching the label (substring, case-insensitive)
scripts/extract-mark-logs.sh "bug-20"

# Flags
scripts/extract-mark-logs.sh "bug-20" --all            # every matching mark, not just the last
scripts/extract-mark-logs.sh "bug-20" --console-only    # skip session + python streams
scripts/extract-mark-logs.sh "bug-20" --session-only    # skip console + python streams
scripts/extract-mark-logs.sh "bug-20" --python-only     # skip console + session streams
```

The script:
1. Searches all three streams: `debug/tmp.browser-console.jsonl`, `debug/tmp.session-log.jsonl`, and `debug/tmp.python-server.jsonl`.
2. Extracts the window from the matched mark to the next mark (or EOF).
3. Lists matching graph snapshots from `debug/graph-snapshots/`.

**Trimming** — the log files grow unboundedly; trim them proactively when they exceed ~20K lines, or when the user asks:

```bash
scripts/extract-mark-logs.sh --trim          # keep last 20K lines (default)
scripts/extract-mark-logs.sh --trim 10000    # keep last 10K lines
```

Trim snaps the cut point to the nearest mark boundary so partial windows aren't left behind.

**Manual fallback**: if the script is unavailable, `grep -n` for mark boundaries (`"kind":"mark"` in console/python streams, `"operation":"DEV_MARK"` in session stream), then `sed -n 'N,$p'` to extract from that line onwards.

Reference: `docs/current/codebase/DEV_LOG_STREAMING.md`
