# Automation and Scheduled Updates

DagNet supports a simple “headless automation” mode designed for overnight refreshes: **pull latest → retrieve all slices → commit changes**.

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

## Scheduling (Windows Task Scheduler)

This repo includes scripts to create and manage scheduled tasks:

- `graph-editor/scripts/scheduling/setup-daily-retrieve.cmd`
- `graph-editor/scripts/scheduling/setup-daily-retrieve.ps1`

High-level workflow:

- Run the setup script and add one or more graphs.
- The script creates a Task Scheduler task that opens DagNet with the correct `?retrieveall=` URL.
- For best reliability, use the **dedicated scheduler browser profile** option so credentials and IndexedDB state are stable.
- Launch once interactively to ensure your Git credentials are available in that profile.

For the full operational guide (including serialisation gaps, timeouts, and troubleshooting), see:

- `graph-editor/scripts/scheduling/README-SCHEDULING.md`

---

## Important behaviour and safety notes

### “Remote wins” on pull

The automation pull step resolves conflicts by accepting the remote version. This is deliberate: the scheduled job is designed to refresh from the canonical remote state before it performs retrieval and writes new data.

If you have local-only edits that must not be overwritten, do not run automation against that repository/branch until they are committed/pushed appropriately.

### Headless run (no prompts)

Automation is intended to run unattended:

- No “Retrieve All” modal prompts
- No interactive conflict resolution prompts
- Diagnostics and outcomes are recorded in the Session Log

### Share mode

Automation is disabled in share/embedded modes (it is intended for a normal authenticated workspace).

### Commit messages and dates

Automation commit messages include a UK date in `d-MMM-yy` format (for example `14-Jan-26`).

---

## Troubleshooting

- **Nothing happened**
  - Check the URL contained `?retrieveall=...`
  - Check the Session Log for “waiting for app to initialise” vs “skipped” messages
  - Confirm the repository and branch are selected/available (credentials loaded)

- **Pull or commit failed**
  - Confirm Git credentials exist in the browser profile used by the scheduled task
  - Confirm network access during the run

- **Retrieve All produced errors**
  - Review the Session Log details for the failing slice(s)
  - Consider running interactively once to reproduce with full UI context

---

## Related documentation

- **Developer**: `public/docs/dev/URL_PARAMS.md`
- **Data retrieval**: `data-connections.md`
- **Contexts and slicing**: `contexts.md`


