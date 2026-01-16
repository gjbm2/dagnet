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
   - Add new graphs (single or multiple, run in sequence)
   - Remove specific graphs by number

The script will:
- Show status of all scheduled tasks
- Create one scheduled task per time slot (multiple graphs can run in sequence)
- Launch the browser directly (no long-running PowerShell wrapper)
- Optional app-window mode for single-tab runs (avoids session restore tab pile-ups)

## Script Details

### `setup-daily-retrieve.ps1`

Interactive management tool for DagNet daily scheduled retrievals.

**Features:**
- ✅ **View all scheduled graphs** - Numbered list with status, start time, last run
- ✅ **Add new graphs** - Single or multiple, run in sequence
- ✅ **Remove specific graphs** - By number from the list
- ✅ **Browser profile option** - Dedicated scheduler profile to keep credentials stable
- ✅ **Direct browser launch** - No hidden PowerShell window left running all day
- ✅ **No pile-ups** - Missed runs do not spawn multiple concurrent instances

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

# Adding multiple graphs (run in sequence):
Graph name(s): funnel-a, funnel-b, journey-map
Start time (HH:MM): 03:00

Creating scheduled task...
✓ Task created
```

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
The scheduled task sets an execution time limit that matches your chosen timeout. If the browser stays open:
- Check the task's **Stop the task if it runs longer than** setting
- Confirm the task action launches the browser directly (not PowerShell)
- Manually close the browser (won't affect next run)

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
If you run multiple graphs at the same time, they will open multiple windows. This is expected.

The scheduler is configured to **ignore overlapping instances**, so missed runs (for example after a weekend offline)
will not spawn multiple concurrent windows.

## Advanced Configuration

### Different Start Times for Different Graph Groups
You can have multiple groups running at different times:

```powershell
# Morning group
# Add: morning-funnel-a, morning-funnel-b
# Start: 06:00

# Afternoon group
# Add: afternoon-journey-a, afternoon-journey-b
# Start: 14:00

# Overnight group
# Add: nightly-sync-a, nightly-sync-b, nightly-sync-c
# Start: 02:00
```

Each group runs independently.

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

# Configure settings:
DagNet URL: https://dagnet.vercel.app
Graph name(s): conversion-funnel
Start time (HH:MM): 02:00
Minutes to stay open: 20
If PC was off: [1] Run as soon as PC wakes
Use dedicated profile? Y

✓ Created successfully
```

### Example 2: Add multiple graphs (run in sequence)
```powershell
.\setup-daily-retrieve.ps1

# Already have 1 schedule, add more
Scheduled Graphs:
  [1] conversion-funnel (starts at 02:00)

Choose an option: A

# Enter graphs and time:
Graph name(s): journey-a, journey-b, journey-c
Start time (HH:MM): 03:00

# Creates one task that runs the graphs in sequence
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
