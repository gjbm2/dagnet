# Debugging Discipline

## No "Not My Problem" Dismissals (APPLIES TO EVERYTHING)

**CRITICAL**: "This isn't caused by my changes" is **never** an acceptable reason to stop investigating. Applies to test failures, unexpected behaviour, broken UI, stale state, console errors — anything you encounter while working.

You may note provenance (*"This doesn't appear related to edits in this thread"*), but that's the **start** of the investigation, not the end. The user hired you to solve problems, not assign blame.

**Required response to any issue:**
1. **Investigate** — trace the cause with the same rigour as your own bugs.
2. **Report** — explain what's wrong and why, with file paths and line numbers.
3. **Propose action** — fix it (if in scope and low risk), or flag it with enough context for the user to act.

If you found it, you own the investigation.

## Root-Cause Gate (MANDATORY before writing any fix)

**Can you name the root cause in one sentence?** If not, keep investigating.

A root cause is not "X is wrong" — it's "X is wrong **because** Y writes to Z without updating W". No **because** = symptom, not cause; your fix will be a patch. Consult `DIAGNOSTIC_PLAYBOOKS.md` for symptom checklists; `KNOWN_ANTI_PATTERNS.md` for prior failure patterns.

## Recurring Defect = Multiple Code Paths

Same defect reported twice after a "fix" → most likely cause: **multiple code paths performing the same operation**. Before debugging further:

1. **Grep ALL call sites** that perform the same mutation/operation
2. **List every code path** that can trigger it (context menus, toolbars, properties panels, inline pickers, keyboard shortcuts, drag-and-drop)
3. **Verify your fix applies to ALL paths**, not just the first one found
4. **Consolidate into ONE canonical function** that all paths call — do not fix each path independently

Example: changing analysis type was done in 4 places (inline picker, chart toolbar, properties panel, context menu). Fixing one left three broken. Fix was `setContentItemAnalysisType()` — one function, four call sites.

**Same defect twice = assume multiple code paths until proven otherwise.**

## Post-Debugging: Update Codebase Docs (MANDATORY after non-trivial fixes)

After a fix that took >1 attempt or required understanding non-obvious behaviour, **proactively propose a doc update** before moving on. Don't wait to be asked.

**Capture (generalisable insights, not the specific bug):**
- **How the subsystem actually works** — undocumented data flow, guard mechanism, invariant → add to relevant doc
- **Diagnostic procedures** — sequence of checks that would help next agent diagnose similar issues → add as "Diagnostic checklist" section
- **Heuristics** — "always check X before assuming Y" rules that would have saved attempts

**Don't capture**: the specific bug (commit message), or anything derivable from current code.

**Propose**: *"This fix revealed [subsystem] works differently than documented — I'd like to update [doc] with [brief description]. OK?"* Then edit if approved. Prefer small targeted updates to existing docs over new docs.

## Server Freshness Verification (HARD BLOCK — before blaming staleness)

**NEVER say "the server may not have restarted"** without first running:

```bash
scripts/dev-server-check.sh <file-you-edited>
```

- **FRESH** → problem is your code. Investigate logic.
- **STALE** → check server terminal pane for syntax/import errors blocking reload. Fix and re-run.
- **UNREACHABLE** → server isn't running. Start with `./dev-start.sh`.

Both dev servers expose `GET /__dagnet/server-info` (boot timestamp + PID). The script compares file mtime to server boot time and retries up to 5s for Python (uvicorn reload takes 1–2s). Full details: `DEV_ENVIRONMENT_AND_HMR.md`.

## Devtool and Logging Integrity (BLOCKING — no workarounds)

**CRITICAL**: Devtools and logging are the agent's eyes. A broken devtool degrades every future session that depends on it. A broken logging pipeline blinds the agent — and *it won't know it's blind* because the tool runs without error, producing incomplete or wrong output.

**What counts as infrastructure** (non-exhaustive):

- **Server freshness endpoints**: `/__dagnet/server-info` on Vite + Python; `scripts/dev-server-check.sh` wrapper
- **Log streaming pipeline**: `debug/tmp.browser-console.jsonl`, `debug/tmp.session-log.jsonl`, `debug/tmp.python-server.jsonl`, mirroring code, mark injection into all three
- **Log extraction and diagnostics**: `scripts/extract-mark-logs.sh`, graph snapshot capture (`debug/graph-snapshots/`)
- **Session log service**: `sessionLogService.ts` — levels, thresholds, `startOperation`/`endOperation` lifecycle, viewer rendering
- **Test harnesses**: `bayes/test_harness.py`, `bayes/param_recovery.py`, `bayes/synth_gen.py`, synthetic builders in `bayes/tests/synthetic.py`
- **Regression and monitoring**: `bayes/run_regression.py`, `scripts/bayes-monitor.sh`, `scripts/resilience-strategies.py`, `scripts/hunt-phase2-pathology.sh`
- **Sampling infrastructure**: `ChainStallDetector` in `bayes/compiler/inference.py` (EMA-based stall detection, retry logic in `bayes/worker.py`)
- **Graph-ops scripts**: `graph-ops/scripts/*.sh` (parity, validation, param-pack, analyse)
- **Any script the agent is told to run** as part of a diagnostic or verification step

**Rule 1 — Broken infrastructure is a blocking issue.** A defective devtool — producing wrong results, missing data, failing — is a **blocking issue**. Do not work around it. Do not patch the symptom. Fix properly or escalate immediately. A workaround that makes a broken tool *look* like it works is worse than a hard failure: it silently corrupts every downstream diagnosis.

**Rule 2 — Correctness, not minimality.** For feature code: smallest change. For infrastructure: **full correctness**. A minimal patch on a broken diagnostic tool means the tool looks fixed but still lies. If proper fix is larger than a patch, do the proper fix. If you can only patch, say so explicitly: *"This is a patch, not a proper fix. The tool is still broken because [reason]. Proper fix requires [scope]."*

**Rule 3 — No silent workarounds.** If you find yourself working around an infrastructure limitation — manually parsing what a script should handle, skipping verification because a tool crashes, reading raw JSONL because extraction returns wrong results — **immediately flag it**: *"I'm working around a defect in [tool]. This should be fixed properly — root cause: [X]. Fix the tool now?"* Workarounds must be visible. Silent ones accumulate and corrupt sessions.

**Rule 4 — Logging fidelity is non-negotiable.** Log streams and session logs are the primary evidence source for sync, state, and data-flow issues. A stream missing entries, writing to wrong file, dropping marks, producing malformed JSONL, or swallowing errors is equivalent to a test harness that passes broken code. Same urgency.

**Rule 5 — Devtools must NEVER silently delete diagnostic data.** Log files, trace outputs, recovery results, harness logs are primary evidence. No devtool action — keybinding, "clear" function, "cleanup" script, monitor helper — may delete these files. Display-layer ops (hiding entries, clearing terminal, scroll reset) operate on display state only, never underlying data files. Genuinely destructive actions (freeing disk space) must be a separate, explicitly-named command with confirmation. See anti-patterns 37 and 38 for the incident: a `^b e` keybinding labelled "clear finished" that `rm -f`'d all harness log files, destroying an entire regression run.

**Why this section exists**: agents repeatedly encounter broken devtools and treat them as background friction — minimal patch or workaround. This accumulates: each session leaves the tool more broken, each workaround invisible to the next, until the tool actively misleads. Pattern: patch, patch, patch, catastrophic misdiagnosis. Treat infrastructure breakage as urgent, not incidental.

## Cursor Debugging Workflow (Mirrored Logs + Marks)

For flaky sync issues (Graph ↔ FileRegistry ↔ store), **do not paste console output into chat**. Use the dev-only mirroring workflow:

- **Console stream**: `debug/tmp.browser-console.jsonl`
- **Session log stream**: `debug/tmp.session-log.jsonl`
- **Python server stream**: `debug/tmp.python-server.jsonl`
- **Graph snapshots (per mark)**: `debug/graph-snapshots/*.json`

All three streams support **MARK** boundaries:
- Top-right dev UI (Console toggle + mark input), or `window.dagnetMark('your label')` in DevTools.
- Marks written to **all three** streams.
- Python server stream captured automatically when dev server runs — no opt-in.

### How to analyse logs

**CRITICAL**: When the user mentions a mark — **any phrasing**: "see mark X", "inspect mark X", "check mark X", "review mark X", "look at mark X", or just a message containing "mark 'X'" — run the extraction script **immediately as your first tool call**. Do not search. Do not reason without logs. Do not Glob/Grep `debug/`. Just run the script.

**Primary tool** — `scripts/extract-mark-logs.sh`:

```bash
# Extract LAST mark matching label (substring, case-insensitive)
scripts/extract-mark-logs.sh "bug-20"

# Flags
scripts/extract-mark-logs.sh "bug-20" --all            # every matching mark, not just last
scripts/extract-mark-logs.sh "bug-20" --console-only    # skip session + python
scripts/extract-mark-logs.sh "bug-20" --session-only    # skip console + python
scripts/extract-mark-logs.sh "bug-20" --python-only     # skip console + session
```

The script:
1. Searches all three streams.
2. Extracts window from matched mark to next mark (or EOF).
3. Lists matching graph snapshots from `debug/graph-snapshots/`.

**Trimming** — log files grow unboundedly; trim proactively past ~20K lines or on user request:

```bash
scripts/extract-mark-logs.sh --trim          # keep last 20K lines (default)
scripts/extract-mark-logs.sh --trim 10000    # keep last 10K lines
```

Trim snaps to nearest mark boundary so partial windows aren't left behind.

**Manual fallback**: if script unavailable, `grep -n` for mark boundaries (`"kind":"mark"` in console/python streams, `"operation":"DEV_MARK"` in session stream), then `sed -n 'N,$p'` from that line onwards.

Reference: `docs/current/codebase/DEV_LOG_STREAMING.md`
