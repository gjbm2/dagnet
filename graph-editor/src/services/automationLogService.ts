/**
 * Automation Log Service
 *
 * Persists automation run logs in two places:
 *   1. IndexedDB — survives browser restarts, accessible via console helpers
 *   2. Git repo  — committed to `.dagnet/automation-logs/` periodically during
 *                   the run and once at completion. Survives browser crashes and
 *                   is visible to anyone with repo access.
 *
 * Retrieval is via console helpers exposed on `window`:
 *   - `dagnetAutomationLogs(n?)` – summary of last N runs (default 10)
 *   - `dagnetAutomationLogEntries(runId)` – full session-log entries for one run
 *   - `dagnetExportLog(runId?)` – download a run as JSON file (most recent if no runId)
 */

import { db, type AutomationRunLog } from '../db/appDatabase';
import { downloadTextFile } from './downloadService';
import { gitService } from './gitService';
import { credentialsManager } from '../lib/credentials';

export type { AutomationRunLog };

const MAX_STORED_RUNS = 30;

class AutomationLogService {
  private static instance: AutomationLogService;

  static getInstance(): AutomationLogService {
    if (!AutomationLogService.instance) {
      AutomationLogService.instance = new AutomationLogService();
    }
    return AutomationLogService.instance;
  }

  /**
   * Persist a completed automation run to IDB.
   * Entries are deep-cloned via JSON round-trip so Date objects become ISO strings.
   */
  async persistRunLog(log: AutomationRunLog): Promise<void> {
    try {
      const serialised: AutomationRunLog = {
        ...log,
        entries: JSON.parse(JSON.stringify(log.entries)),
      };
      await db.automationRunLogs.put(serialised);
      await this.pruneOldLogs();
    } catch (e) {
      console.error('[AutomationLogService] Failed to persist run log:', e);
    }
  }

  /** Retrieve recent run logs, newest first. */
  async getRunLogs(limit: number = MAX_STORED_RUNS): Promise<AutomationRunLog[]> {
    try {
      return await db.automationRunLogs
        .orderBy('timestamp')
        .reverse()
        .limit(limit)
        .toArray();
    } catch (e) {
      console.error('[AutomationLogService] Failed to read run logs:', e);
      return [];
    }
  }

  /** Retrieve a single run by its runId. */
  async getRunLog(runId: string): Promise<AutomationRunLog | undefined> {
    try {
      return await db.automationRunLogs.get(runId);
    } catch (e) {
      console.error('[AutomationLogService] Failed to read run log:', e);
      return undefined;
    }
  }

  /** Keep only the most recent MAX_STORED_RUNS entries. */
  private async pruneOldLogs(): Promise<void> {
    try {
      const all = await db.automationRunLogs
        .orderBy('timestamp')
        .reverse()
        .toArray();

      if (all.length > MAX_STORED_RUNS) {
        const toDelete = all.slice(MAX_STORED_RUNS).map((r) => r.runId);
        await db.automationRunLogs.bulkDelete(toDelete);
      }
    } catch (e) {
      console.error('[AutomationLogService] Failed to prune old logs:', e);
    }
  }

  // -------------------------------------------------------------------------
  // Git-committed automation logs
  // -------------------------------------------------------------------------

  /**
   * Commit the current automation log snapshot to the data repo.
   *
   * Writes a single JSON file to `.dagnet/automation-logs/{filename}.json`.
   * The file is overwritten on each call (git tracks history). This is called
   * periodically during a run and once at completion.
   *
   * Best-effort: failures are logged but never thrown — the IDB persist is
   * the safety net.
   */
  async commitLogToRepo(options: {
    repository: string;
    branch: string;
    filename: string;
    log: Omit<AutomationRunLog, 'runId'> & { runId: string };
  }): Promise<boolean> {
    const { repository, branch, filename, log } = options;

    try {
      // Ensure credentials are loaded and set on gitService
      const credsResult = await credentialsManager.loadCredentials();
      if (!credsResult.success || !credsResult.credentials) {
        console.warn('[AutomationLogService] No credentials — skipping log commit');
        return false;
      }

      const gitCreds = credsResult.credentials.git.find(cred => cred.name === repository);
      if (!gitCreds) {
        console.warn(`[AutomationLogService] No credentials for ${repository} — skipping log commit`);
        return false;
      }

      gitService.setCredentials({
        ...credsResult.credentials,
        defaultGitRepo: repository,
      });

      const serialised = JSON.parse(JSON.stringify(log));
      const content = JSON.stringify(serialised, null, 2);
      const path = `.dagnet/automation-logs/${filename}`;

      const result = await gitService.commitAndPushFiles(
        [{ path, content }],
        `Automation log snapshot — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}`,
        branch,
      );

      if (result.success) {
        console.log(`[AutomationLogService] Log committed to ${path}`);
        return true;
      } else {
        console.warn(`[AutomationLogService] Log commit failed: ${result.error}`);
        return false;
      }
    } catch (e) {
      console.warn('[AutomationLogService] Log commit failed:', e instanceof Error ? e.message : e);
      return false;
    }
  }
}

export const automationLogService = AutomationLogService.getInstance();

// ---------------------------------------------------------------------------
// Console helpers – always available (useful even in prod for diagnosing
// scheduled-run issues from the dedicated browser profile).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  /**
   * Print a summary table of recent automation runs.
   * Usage:  dagnetAutomationLogs()        — last 10
   *         dagnetAutomationLogs(30)      — last 30
   */
  (window as any).dagnetAutomationLogs = async (limit?: number): Promise<AutomationRunLog[] | void> => {
    const logs = await automationLogService.getRunLogs(limit || 10);
    if (logs.length === 0) {
      console.log('No automation run logs found.');
      return;
    }

    console.log(`\n=== DagNet Automation Run Logs (${logs.length} run${logs.length === 1 ? '' : 's'}) ===\n`);

    for (const log of logs) {
      const date = new Date(log.timestamp);
      const outcomeIcon =
        log.outcome === 'success'  ? '✅' :
        log.outcome === 'warning'  ? '⚠️' :
        log.outcome === 'error'    ? '❌' : '⏹️';

      console.log(`${outcomeIcon} ${date.toLocaleString()} | ${log.outcome.toUpperCase()}`);
      console.log(`   Graphs: ${log.graphs.join(', ') || '(none)'}`);
      console.log(`   Duration: ${(log.durationMs / 1000).toFixed(1)}s | Version: ${log.appVersion}`);
      console.log(`   Repo: ${log.repository}/${log.branch}`);
      console.log(`   Log entries: ${log.entries.length}`);
      console.log(`   Run ID: ${log.runId}`);
      console.log('');
    }

    console.log('To view full log entries for a run:');
    console.log('  dagnetAutomationLogEntries("<runId>")');
    return logs;
  };

  /**
   * Print the full session-log entries captured during a specific automation run.
   * Usage:  dagnetAutomationLogEntries("retrieveall-enumerate:1770310825981")
   */
  (window as any).dagnetAutomationLogEntries = async (runId: string): Promise<any[] | void> => {
    const log = await automationLogService.getRunLog(runId);
    if (!log) {
      console.log(`No run log found for runId: ${runId}`);
      return;
    }

    const date = new Date(log.timestamp);
    console.log(`\n=== Entries for ${date.toLocaleString()} (${log.outcome}) ===`);
    console.log(`Graphs: ${log.graphs.join(', ')}`);
    console.log(`Duration: ${(log.durationMs / 1000).toFixed(1)}s\n`);
    console.log(JSON.stringify(log.entries, null, 2));
    return log.entries;
  };

  /**
   * Download an automation run log as a JSON file.
   * Usage:  dagnetExportLog()                                    — most recent run
   *         dagnetExportLog("retrieveall:1775620803910")         — specific run by ID
   */
  (window as any).dagnetExportLog = async (runId?: string): Promise<void> => {
    let log: AutomationRunLog | undefined;

    if (runId) {
      log = await automationLogService.getRunLog(runId);
    } else {
      const logs = await automationLogService.getRunLogs(1);
      log = logs[0];
    }

    if (!log) {
      console.log(runId ? `No run log found for runId: ${runId}` : 'No automation run logs found.');
      return;
    }

    const date = new Date(log.timestamp);
    const dateStr = `${date.getDate()}-${date.toLocaleString('en-GB', { month: 'short' })}-${String(date.getFullYear()).slice(2)}`;
    const safeRunId = log.runId.replace(/:/g, '-');
    const filename = `automation-${safeRunId}-${dateStr}.json`;

    downloadTextFile({ filename, content: JSON.stringify(log, null, 2), mimeType: 'application/json' });
    console.log(`Downloaded: ${filename} (${log.outcome}, ${log.entries.length} entries)`);
  };
}
