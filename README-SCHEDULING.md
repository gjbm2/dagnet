# DagNet Daily Scheduling

Automated daily retrieval of graph data using Windows Task Scheduler.

## Overview

DagNet supports automated daily workflows via the `?retrieveall=<graph_name>` URL parameter. When opened with this parameter, DagNet will:

1. **Pull** latest changes from git (remote wins on conflicts)
2. **Retrieve** all data slices for the specified graph (headless, no UI prompts)
3. **Commit** any changes back to the repository

This is ideal for scheduled overnight data refreshes on a PC left running.

## Quick Start

### Manage Schedules

1. **Run the launcher**
   - Double-click `setup-daily-retrieve.cmd`, or run it from a terminal:

```powershell
cd path\to\dagnet
.\setup-daily-retrieve.cmd
```

This launcher runs PowerShell with an execution-policy bypass and the script will self-elevate when needed (UAC prompt).

3. **Interactive menu**
   - View all scheduled graphs (numbered list)
   - Add new graphs (one or multiple, automatically serialised)
   - Remove specific graphs by number
   - Clear all schedules

The script will:
- Remember your settings (URL, browser, timeout)
- Auto-serialise multiple graphs (e.g., 5-minute gaps)
- Show status of all scheduled tasks

## Script Details

### `setup-daily-retrieve.ps1`

Interactive management tool for DagNet daily scheduled retrievals.

**Features:**
- ✅ **View all scheduled graphs** - Numbered list with status, start time, last run
- ✅ **Add new graphs** - Single or multiple, automatically serialised
- ✅ **Remove specific graphs** - By number from the list
- ✅ **Clear all schedules** - Remove everything at once
- ✅ **Persistent configuration** - Remembers URL, browser, timeout between runs
- ✅ **Automatic serialisation** - Multiple graphs run in series with configurable gaps
- ✅ **Auto-detects browser** - Finds Chrome or Edge automatically
- ✅ **Full task management** - View, add, remove all in one interface

**Requirements:**
- Windows 10/11
- PowerShell 5.1+
- Administrator privileges (the script will self-elevate via UAC)

**Example Session:**
```powershell
.\setup-daily-retrieve.cmd

# Main menu shows:
========================================
  DagNet Daily Retrieve Management
========================================

Scheduled Graphs:

  [1] conversion-funnel
      Start time: 02:00 | State: Ready | Last run: 14-Jan-26 02:00
  [2] user-journey
      Start time: 02:05 | State: Ready | Last run: 14-Jan-26 02:05

Options:
  [A] Add new graph(s)
  [R] Remove graph (by number)
  [C] Clear all schedules
  [Q] Quit

Choose an option: A

# Adding multiple graphs with serialisation:
Graph name(s): funnel-a, funnel-b, journey-map
Start time (HH:MM): 03:00
Gap between graphs (minutes, default: 5): 5

Creating scheduled task(s)...
[1/3] Creating: funnel-a (Start time: 03:00) ✓
[2/3] Creating: funnel-b (Start time: 03:05) ✓
[3/3] Creating: journey-map (Start time: 03:10) ✓

Successfully created 3 of 3 task(s)
```

**Configuration File:**
Settings are saved in `dagnet-schedule-config.json`:
- DagNet URL
- Browser path
- Timeout minutes
- Missed trigger behavior
- Serialisation gap

This means you don't have to re-enter settings each time you add graphs.

### Removal

Removal is built in: use the script menu options **Remove** (by number) or **Clear all**.

## Managing Tasks

### View Tasks
1. Open **Task Scheduler** (`Win+R` → `taskschd.msc`)
2. Look for tasks named `DagNet_DailyRetrieve_*`

### Test a Task Manually
1. Open **Task Scheduler**
2. Find your task (e.g., `DagNet_DailyRetrieve_conversion-funnel`)
3. Right-click → **Run**
4. Monitor in browser (should open automatically)

### View Task History
1. Open **Task Scheduler**
2. Find your task
3. Click **History** tab (bottom panel)
4. Review execution logs

### Modify a Task
**Option 1: Re-run setup script** (recommended)
- Run `.\setup-daily-retrieve.ps1` again
- Existing tasks will be updated

**Option 2: Manual editing**
1. Open **Task Scheduler**
2. Right-click task → **Properties**
3. Modify settings as needed

## Troubleshooting

### Task doesn't run
**Check Task Scheduler History:**
1. Task Scheduler → Find your task
2. Enable history: **Action** → **Enable All Tasks History**
3. Check **History** tab for errors

**Common issues:**
- PC was off/asleep at scheduled time (check "If missed" setting)
- Browser path incorrect (verify in task properties)
- Permissions issue (task must run as administrator)

### Browser doesn't close
The script automatically closes the browser after the timeout period. If it doesn't close:
- Increase timeout in task properties
- Check Windows Event Viewer for errors
- Manually close browser (won't affect next run)

### Task runs but retrieval fails
**Check DagNet Session Log:**
1. Open DagNet manually
2. Session Log (bottom panel)
3. Look for errors from previous run

**Common issues:**
- Git credentials not saved in browser
- Network/internet connection issue
- Graph name misspelled

### Multiple browser windows open
**This is expected behavior when using serialisation.**

Each graph gets its own task with its own browser window, staggered by the gap you specified (default: 5 minutes).

**Example timeline with 5-minute gap:**
- 02:00 - Browser opens for graph A
- 02:05 - Browser opens for graph B (A still running)
- 02:10 - Browser opens for graph C (A and B still running)
- 02:20 - Browser A closes (20-min timeout)
- 02:25 - Browser B closes
- 02:30 - Browser C closes

**If this is a problem:**
1. Increase the gap between graphs (e.g., 10 or 15 minutes)
2. Use a shorter timeout (e.g., 15 minutes instead of 20)
3. Stagger graph groups to different hours (e.g., 02:00, 03:00, 04:00)

**Why serialisation matters:**
- Prevents overwhelming your computer with simultaneous operations
- Prevents GitHub API rate limiting
- Ensures each graph gets full attention
- Easier to debug issues (clear separation in session logs)

## Advanced Configuration

### Serialisation Gap Adjustment
When adding multiple graphs, you're prompted for the gap between them. The default is 5 minutes.

**Choosing the right gap:**
- **Small graphs (< 100 nodes):** 3-5 minutes
- **Medium graphs (100-500 nodes):** 5-10 minutes
- **Large graphs (> 500 nodes):** 10-20 minutes

The gap should account for:
1. Time for browser to open
2. Time for DagNet to load
3. Time for retrieve operation to complete
4. Small buffer for safety

**Adjusting existing schedules:**
If your graphs are finishing faster or slower than expected:
1. Remove the affected graphs
2. Re-add them with a different gap

### Different Start Times for Different Graph Groups
You can have multiple groups running at different times:

```powershell
# Morning group (serialised)
# Add: morning-funnel-a, morning-funnel-b
# Start: 06:00, Gap: 5

# Afternoon group (serialised)
# Add: afternoon-journey-a, afternoon-journey-b
# Start: 14:00, Gap: 5

# Overnight group (serialised)
# Add: nightly-sync-a, nightly-sync-b, nightly-sync-c
# Start: 02:00, Gap: 10
```

Each group runs independently, serialised within itself.

### Weekly Instead of Daily
1. Add graph(s) normally via script
2. Open Task Scheduler (`Win+R` → `taskschd.msc`)
3. Find task → Right-click → **Properties**
4. **Triggers** tab → **Edit**
5. Change from "Daily" to "Weekly"
6. Choose specific days (e.g., Mon, Wed, Fri)

### Email Notifications on Failure
1. Task Scheduler → Find task → Right-click → **Properties**
2. **Actions** tab → **New**
3. Action: "Send an e-mail" (requires SMTP configuration)
4. Configure email settings with failure details

### Configuration File Management
Settings are stored in `dagnet-schedule-config.json`:

```json
{
  "dagnetUrl": "https://dagnet.vercel.app",
  "browserPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "timeoutMinutes": 20,
  "runAfterMissed": true,
  "serializationGapMinutes": 5
}
```

**To reset configuration:**
1. Delete `dagnet-schedule-config.json`
2. Run script again - it will prompt for all settings

**To change a setting:**
1. Edit the JSON file directly, or
2. Run script → [A]dd → Script will prompt to change saved settings

## Security Notes

- Tasks run with your user account credentials
- Browser credentials (GitHub token) must be saved in browser
- Tasks require administrator privileges to create (not to run)
- Scheduled tasks persist across reboots
- Consider using dedicated "automation" account for production

## URL Parameter Reference

Full URL format:
```
https://dagnet.vercel.app/?retrieveall=<graph_name>
```

Optional parameters:
```
?retrieveall=<graph_name>&pullalllatest    # Explicit pull first
?graph=<graph_name>&retrieveall            # Alternative syntax
```

See `graph-editor/public/docs/dev/URL_PARAMS.md` for full URL parameter documentation.

## Files

- `setup-daily-retrieve.ps1` - Interactive management tool (view, add, remove)
- `remove-daily-retrieve.ps1` - Legacy removal script (superseded by main script)
- `dagnet-schedule-config.json` - Auto-generated configuration (URL, browser, settings)
- `README-SCHEDULING.md` - This documentation

## Examples

### Example 1: First-time setup (single graph)
```powershell
.\setup-daily-retrieve.ps1

# No existing schedules, choose [A] to add
Choose an option: A

# First time, configure everything:
DagNet URL: https://dagnet.vercel.app
Graph name(s): conversion-funnel
Start time (HH:MM): 02:00
Browser timeout (minutes): 20
If PC was off: [1] Run ASAP
Browser: C:\Program Files\Google\Chrome\Application\chrome.exe

✓ Created successfully
```

### Example 2: Add multiple graphs with serialisation
```powershell
.\setup-daily-retrieve.ps1

# Already have 1 schedule, add more
Scheduled Graphs:
  [1] conversion-funnel (starts at 02:00)

Choose an option: A

# Settings remembered, just enter graphs and time:
Graph name(s): journey-a, journey-b, journey-c
Start time (HH:MM): 03:00
Gap between graphs (minutes): 5

# Creates 3 tasks at 03:00, 03:05, 03:10 (serialised!)
```

### Example 3: Remove specific graph
```powershell
.\setup-daily-retrieve.ps1

Scheduled Graphs:
  [1] conversion-funnel (starts at 02:00)
  [2] journey-a (starts at 03:00)
  [3] journey-b (starts at 03:05)
  [4] journey-c (starts at 03:10)

Choose an option: R
Enter number to remove: 2
Remove 'journey-a'? [y/N]: y

✓ Removed: journey-a
```

### Example 4: View schedule status
```powershell
.\setup-daily-retrieve.ps1

Scheduled Graphs:
  [1] conversion-funnel
      Start time: 02:00 | State: Ready | Last run: 14-Jan-26 02:00
  [2] user-journey
      Start time: 03:00 | State: Ready | Last run: 14-Jan-26 03:00
      Last result: Success

# Quick overview of all scheduled tasks
```

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review Task Scheduler history logs
3. Check DagNet Session Log
4. Review `graph-editor/public/docs/dev/URL_PARAMS.md`
