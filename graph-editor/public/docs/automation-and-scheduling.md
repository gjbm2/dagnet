# Automation and Scheduled Updates

DagNet supports a simple "headless automation" mode designed for overnight refreshes: **pull latest → retrieve all slices → commit changes**.

This is intended for **local scheduling** (for example Windows Task Scheduler) on a machine left running. DagNet does not require a server-side cron for this workflow.

---

## What the automation run does

When launched in automation mode for a graph, DagNet will:

1. **Pull latest from git** using a **remote-wins** strategy (any merge conflicts are resolved by accepting the remote version)
2. **Retrieve All Slices** for the target graph (headless; no modal prompts)
3. **Commit** any committable changes back to the repository

Progress and errors are reported in the **Session Log**.

---

## How to trigger automation

### URL parameter: `retrieveall`

Open DagNet with:

- `?retrieveall=<graph-name>`

or:

- `?graph=<graph-name>&retrieveall`

Multiple graphs can be queued and are processed **one at a time** (serialised):

- `?retrieveall=graph-a,graph-b,graph-c`
- `?retrieveall=graph-a&retrieveall=graph-b&retrieveall=graph-c`

DagNet cleans these URL parameters after starting so that refresh does not re-trigger the run.

Reference: see `public/docs/dev/URL_PARAMS.md` (Developer Documentation).

---

## Daily-fetch mode (recommended for multiple graphs)

Instead of listing graphs explicitly in the URL, you can mark graphs for daily automation and let DagNet enumerate them automatically.

### Enabling daily-fetch for a graph

**Option A: Individual graph (via Pinned Data Interests)**

1. Open the graph you want to include in automation
2. Click the **gear icon** (⚙️) in the Context selector bar
3. Select **"Pinned Data Interests"**
4. Check the **"Fetch daily"** checkbox
5. Click **Save**

**Option B: Bulk management (via Data menu)**

1. Go to **Data** menu → **Automated Daily Fetches...**
2. In the modal, select graphs from the left panel ("Available Graphs")
3. Click **[>]** to move them to the right panel ("Daily Fetch Enabled")
4. Click **Save Changes**

This is useful for enabling/disabling multiple graphs at once without opening each one individually.

### Triggering daily-fetch mode

Use `?retrieveall` **without** a graph name:

```
https://dagnet.vercel.app/?retrieveall
```

DagNet will:
1. Wait for the workspace to initialise
2. Find all graphs with "Fetch daily" enabled
3. Process them one at a time in alphabetical order
4. Log progress with sequence indicators: `[1/3] Starting: graph-a`

### Benefits

- **Centralised control**: enable/disable graphs from the UI without editing scheduled task URLs
- **Self-documenting**: the graph itself records whether it's part of automation
- **Simpler scheduling**: one scheduled task covers all daily-fetch graphs

### Notes

- Graphs must be cloned/loaded into the workspace before automation runs
- If no graphs have "Fetch daily" enabled, the automation logs a warning and exits
- You can still use explicit `?retrieveall=graph-a,graph-b` if you prefer URL-based control

---

## Scheduling (Windows Task Scheduler)

This repo includes scripts to create and manage scheduled tasks:

- `graph-editor/scripts/scheduling/setup-daily-retrieve.cmd`
- `graph-editor/scripts/scheduling/setup-daily-retrieve.ps1`

High-level workflow:

- Run the setup script and add one or more graphs.
- The script creates a Task Scheduler task that opens DagNet with the correct `?retrieveall=` URL.
- For best reliability, use the **dedicated scheduler browser profile** option so credentials and IndexedDB state are stable.
- Launch once interactively to ensure your Git credentials are available in that profile.

**Daily-fetch mode option:**

When adding a new schedule, the setup script offers two modes:
1. **Specific graphs** — you specify which graphs to run (existing behaviour)
2. **Daily-fetch mode** — runs all graphs marked "Fetch daily" in DagNet

Daily-fetch mode uses `?retrieveall` (no graph names), so you can add/remove graphs from automation by toggling the "Fetch daily" checkbox in DagNet rather than editing the scheduled task.

For the full operational guide (including serialisation gaps, timeouts, and troubleshooting), see:

- `graph-editor/scripts/scheduling/README-SCHEDULING.md`

---

## Important behaviour and safety notes

### "Remote wins" on pull

The automation pull step resolves conflicts by accepting the remote version. This is deliberate: the scheduled job is designed to refresh from the canonical remote state before it performs retrieval and writes new data.

If you have local-only edits that must not be overwritten, do not run automation against that repository/branch until they are committed/pushed appropriately.

### Headless run (no prompts)

Automation is intended to run unattended:

- No "Retrieve All" modal prompts
- No interactive conflict resolution prompts
- Diagnostics and outcomes are recorded in the Session Log

### Share mode

Automation is disabled in share/embedded modes (it is intended for a normal authenticated workspace).

### Commit messages and dates

Automation commit messages include a UK date in `d-MMM-yy` format (for example `14-Jan-26`).

---

## Automation run logs (persistent)

Every automation run (whether triggered by the scheduler or manually via URL) persists a full diagnostic log to IndexedDB. These logs survive browser restarts, so you can review past runs at any time — even from a different browser session.

### Inspecting past runs

Open the browser console (F12 → Console) in any DagNet session that shares the same browser profile as the scheduled task, then run:

```js
// Summary of the last 10 runs (newest first)
await dagnetAutomationLogs()

// Summary of the last 30 runs
await dagnetAutomationLogs(30)
```

This prints a summary showing each run's date/time, outcome (success/warning/error/aborted), graphs processed, duration, app version, and run ID.

### Viewing full log entries for a specific run

Copy the **Run ID** from the summary and run:

```js
await dagnetAutomationLogEntries("retrieveall-enumerate:1770310825981")
```

This prints the complete session-log entries captured during that run, including all child operations (pull, retrieve, commit steps).

### Retention

The last 30 runs are kept. Older entries are pruned automatically.

### Auto-close behaviour

After an automation run completes:

- **Clean run** (no errors, no warnings): the browser window closes itself after a 10-second delay. The logs are already persisted to IndexedDB before closing.
- **Run with errors or warnings**: the browser window **stays open** so the operator can see the Session Log immediately. Logs are also persisted.

This means on a normal day the scheduled browser window opens, runs, and closes itself — leaving the next day's trigger free to fire. If something went wrong, the window stays open as a visible signal.

---

## Troubleshooting

- **Nothing happened**
  - Check the URL contained `?retrieveall=...`
  - Check the Session Log for "waiting for app to initialise" vs "skipped" messages
  - Confirm the repository and branch are selected/available (credentials loaded)
  - Check `dagnetAutomationLogs()` in the console for a persisted record of the run

- **Pull or commit failed**
  - Confirm Git credentials exist in the browser profile used by the scheduled task
  - Confirm network access during the run
  - Run `dagnetAutomationLogEntries("<runId>")` to see the detailed pull/commit steps

- **Retrieve All produced errors**
  - Review the Session Log details for the failing slice(s)
  - Run `dagnetAutomationLogEntries("<runId>")` for the full log
  - Consider running interactively once to reproduce with full UI context

- **Browser window stayed open and blocked the next scheduled run**
  - This happens when a run had errors/warnings (window stays open for review)
  - Close the window manually, or fix the underlying issue
  - Check `dagnetAutomationLogs()` to see why the previous run had issues
  - Consider setting `StartWhenAvailable` to `true` in Task Scheduler so missed runs catch up

- **Browser window didn't close despite a clean run**
  - `window.close()` may be blocked outside `--app` mode; use the `--app=` flag (the setup script does this by default)
  - Check the console for errors

---

## Related documentation

- **Developer**: `public/docs/dev/URL_PARAMS.md`
- **Data retrieval**: `data-connections.md`
- **Contexts and slicing**: `contexts.md`
