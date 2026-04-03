/**
 * Daily Automation Job
 *
 * Registers the `daily-automation` reactive job with the scheduler.
 * This is the headless ?retrieveall automation:
 *   blank boot → pull (once) → enumerate/target → per-graph retrieve+commit
 *
 * The hook (useURLDailyRetrieveAllQueue) parses URL params, updates context,
 * and calls scheduler.run('daily-automation', { graphNames, isEnumerationMode }).
 * All orchestration lives here.
 */

import { jobSchedulerService } from './jobSchedulerService';
import type { JobContext } from './jobSchedulerService';
import { dailyRetrieveAllAutomationService } from './dailyRetrieveAllAutomationService';
import { sessionLogService } from './sessionLogService';
import { automationLogService } from './automationLogService';
import { repositoryOperationsService } from './repositoryOperationsService';
import { workspaceService } from './workspaceService';
import { APP_VERSION } from '../version';
import { db } from '../db/appDatabase';
import type { RepositoryItem, GraphData, ViewMode } from '../types';

// ---------------------------------------------------------------------------
// Context store — written by the hook, read by the job runFn
// ---------------------------------------------------------------------------

export interface DailyAutomationContext {
  selectedRepo?: string;
  selectedBranch?: string;
  navigatorReady: boolean;
  tabs: any[];
  tabOps: {
    openTab: (item: RepositoryItem, viewMode?: ViewMode, forceNew?: boolean) => Promise<any>;
    updateTabData: (fileId: string, data: any) => void;
  } | null;
  fileRegistryGetFile: (fileId: string) => any;
}

const automationCtx: DailyAutomationContext = {
  navigatorReady: false,
  tabs: [],
  tabOps: null,
  fileRegistryGetFile: () => null,
};

export function updateDailyAutomationContext(ctx: Partial<DailyAutomationContext>): void {
  Object.assign(automationCtx, ctx);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntilDeadline(durationMs: number, tickMs = 30_000): Promise<void> {
  if (durationMs <= 0) return;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(tickMs, Math.max(remaining, 0)));
  }
}

function inferGraphNameFromFileId(fileId: string): string {
  return fileId.startsWith('graph-') ? fileId.slice('graph-'.length) : fileId;
}

async function enumerateDailyFetchGraphsFromIDB(workspace: { repository: string; branch: string }): Promise<string[]> {
  const allGraphFiles = await db.files
    .where('type')
    .equals('graph')
    .toArray();

  const seenCanonical = new Set<string>();
  const candidates: Array<{ fileId: string; data: GraphData | null }> = [];

  for (const file of allGraphFiles) {
    if (file.source?.repository !== workspace.repository || file.source?.branch !== workspace.branch) continue;

    let canonicalName: string;
    if (file.fileId.includes('-graph-')) {
      const parts = file.fileId.split('-graph-');
      canonicalName = parts[parts.length - 1];
    } else if (file.fileId.startsWith('graph-')) {
      canonicalName = file.fileId.slice(6);
    } else {
      canonicalName = file.fileId;
    }

    if (seenCanonical.has(canonicalName)) {
      if (file.fileId.includes('-graph-')) {
        const idx = candidates.findIndex(c => {
          const prevName = c.fileId.startsWith('graph-') ? c.fileId.slice(6) : c.fileId;
          return prevName === canonicalName;
        });
        if (idx >= 0) {
          candidates[idx] = { fileId: file.fileId, data: file.data as GraphData | null };
        }
      }
      continue;
    }

    seenCanonical.add(canonicalName);
    candidates.push({ fileId: file.fileId, data: file.data as GraphData | null });
  }

  const names: string[] = [];
  for (const { fileId, data } of candidates) {
    if (data?.dailyFetch) {
      let name: string;
      if (fileId.includes('-graph-')) {
        const parts = fileId.split('-graph-');
        name = parts[parts.length - 1];
      } else if (fileId.startsWith('graph-')) {
        name = fileId.slice(6);
      } else {
        name = fileId;
      }
      names.push(name);
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
}

async function waitForGraphData(fileId: string, maxWaitMs: number, pollMs: number, shouldAbort: () => boolean): Promise<boolean> {
  const startedAt = Date.now();
  while (true) {
    if (shouldAbort()) return false;
    const file = automationCtx.fileRegistryGetFile(fileId) as any;
    if (file?.data && file?.type === 'graph') return true;
    if (Date.now() - startedAt > maxWaitMs) return false;
    await sleep(pollMs);
  }
}

function reassertTabFocus(tabId: string, delaysMs: number[]): void {
  void (async () => {
    for (const delay of delaysMs) {
      if (delay > 0) await sleep(delay);
      if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
      window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId } }));
    }
  })();
}

function getStartDelayMs(): number {
  if ((import.meta as any).env?.MODE === 'test') return 0;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('e2e') === '1') return 0;
  }
  return 30_000;
}

function getCloseDelayMs(outcome: string): number {
  if ((import.meta as any).env?.MODE === 'test') return 0;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.has('noclose')) return Infinity; // Check noclose BEFORE e2e
    if (params.get('e2e') === '1') return 500;
  }
  return 12 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Job registration
// ---------------------------------------------------------------------------

let registered = false;

export function registerDailyAutomationJob(): void {
  if (registered) return;
  registered = true;

  jobSchedulerService.registerJob({
    id: 'daily-automation',
    schedule: { type: 'reactive' },
    bootGated: false, // Job has its own waitForAppReady loop; boot-gating causes deadlocks in E2E
    presentation: 'banner:automation',
    concurrency: { mode: 'singleton:cross-tab', lockName: 'dagnet:daily-retrieveall', onDuplicate: 'skip' },
    suppress: ['auto-pull', 'retrieve-nudge'],
    suppressBannerFor: ['version-check'],
    runFn: runDailyAutomation,
  });
}

// ---------------------------------------------------------------------------
// The main runFn
// ---------------------------------------------------------------------------

async function runDailyAutomation(ctx: JobContext): Promise<void> {
  const params = ctx.params as { graphNames?: string[]; isEnumerationMode?: boolean } | undefined;
  let targetGraphNames = [...(params?.graphNames ?? [])];
  const isEnumerationMode = params?.isEnumerationMode ?? (targetGraphNames.length === 0);

  const originalTitle = document.title;
  const setAutomationTitle = (phase: string) => {
    const prefix = `[Automation: ${phase}] `;
    document.title = originalTitle.startsWith('[Automation:')
      ? `${prefix}${originalTitle.replace(/^\[Automation:[^\]]+\]\s*/, '')}`
      : `${prefix}${originalTitle}`;
  };

  const waitStartedAt = Date.now();
  const logStartIndex = sessionLogService.getEntries().length;
  let repoForLog = 'unknown';
  let branchForLog = 'unknown';

  try {
    setAutomationTitle('starting');
    ctx.showBanner({
      label: isEnumerationMode ? 'Automation running (enumerating graphs...)' : 'Automation running',
      detail: isEnumerationMode ? undefined : `Graphs: ${targetGraphNames.join(', ')}`,
      actionLabel: 'Stop',
      onAction: () => jobSchedulerService.cancel('daily-automation'),
    });

    // Wait for React context to provide repo/branch/tabOps AND NavigatorContext to finish init.
    const maxWaitMs = 60_000;
    const pollMs = 250;
    let loggedWaiting = false;

    while (true) {
      if (ctx.shouldAbort()) {
        sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_ABORTED', 'Daily automation aborted by user (waiting phase)');
        return;
      }

      const repo = automationCtx.selectedRepo;
      const navReady = automationCtx.navigatorReady;
      const hasTabOps = !!automationCtx.tabOps?.openTab;

      if (repo && navReady && hasTabOps) break;

      if (Date.now() - waitStartedAt > maxWaitMs) {
        sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_SKIPPED', 'Daily automation skipped: app did not become ready in time');
        return;
      }

      if (!loggedWaiting) {
        loggedWaiting = true;
        sessionLogService.info('session', 'DAILY_RETRIEVE_ALL_WAITING', 'Daily automation: waiting for app to initialise');
      }

      await sleep(pollMs);
    }

    const repoFinal = automationCtx.selectedRepo!;
    const branchFinal = automationCtx.selectedBranch || 'main';
    repoForLog = repoFinal;
    branchForLog = branchFinal;

    // -----------------------------------------------------------------------
    // Upfront pull (remote wins) — ALWAYS, both enumeration and explicit mode.
    // -----------------------------------------------------------------------
    sessionLogService.info('session', 'DAILY_RETRIEVE_ALL_PRE_PULL', 'Pulling latest from Git (remote wins)');

    try {
      const prePullResult = await repositoryOperationsService.pullLatestRemoteWins(repoFinal, branchFinal);
      if ((prePullResult.conflictsResolved ?? 0) > 0) {
        sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_PRE_PULL_CONFLICTS',
          `Pre-pull resolved ${prePullResult.conflictsResolved} conflict(s) by accepting remote`);
      }
    } catch (pullErr) {
      sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_PRE_PULL_FAILED',
        `Pre-pull failed (proceeding with cached data): ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`);
    }

    // Load workspace from IDB after pull so enumeration/file loading works.
    await workspaceService.loadWorkspaceFromIDB(repoFinal, branchFinal);

    if (ctx.shouldAbort()) {
      sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_ABORTED', 'Daily automation aborted by user (after pull)');
      return;
    }

    // -----------------------------------------------------------------------
    // Determine target graphs.
    // -----------------------------------------------------------------------
    if (isEnumerationMode) {
      targetGraphNames = await enumerateDailyFetchGraphsFromIDB({ repository: repoFinal, branch: branchFinal });

      if (targetGraphNames.length === 0) {
        sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_NO_GRAPHS', 'No graphs with dailyFetch=true found in workspace');
        return;
      }

      sessionLogService.info('session', 'DAILY_RETRIEVE_ALL_FOUND',
        `Found ${targetGraphNames.length} graph(s) with dailyFetch=true`, targetGraphNames.join(', '));
    }

    // Open Session Log early.
    let logTabId: string | undefined;
    try {
      logTabId = (await sessionLogService.openLogTab()) ?? undefined;
      if (logTabId) reassertTabFocus(logTabId, [0, 50, 200, 750]);
    } catch { /* best effort */ }

    // Start delay (countdown).
    const startDelayMs = getStartDelayMs();
    if (startDelayMs > 0) {
      setAutomationTitle('countdown');
      const totalSeconds = Math.ceil(startDelayMs / 1000);
      ctx.showBanner({
        label: `Automation starting in ${totalSeconds}s...`,
        detail: `Graphs: ${targetGraphNames.join(', ')}`,
        actionLabel: 'Stop',
        onAction: () => jobSchedulerService.cancel('daily-automation'),
      });

      const countdownDeadline = Date.now() + startDelayMs;
      while (Date.now() < countdownDeadline) {
        if (ctx.shouldAbort()) {
          sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_ABORTED', 'Daily automation aborted by user (countdown phase)');
          return;
        }
        const remaining = Math.ceil((countdownDeadline - Date.now()) / 1000);
        ctx.showBanner({
          label: `Automation starting in ${remaining}s...`,
          detail: `Graphs: ${targetGraphNames.join(', ')}`,
          actionLabel: 'Stop',
          onAction: () => jobSchedulerService.cancel('daily-automation'),
        });
        await sleep(1_000);
      }
    }

    // Re-open Session Log after countdown.
    if (logTabId) reassertTabFocus(logTabId, [0, 50, 200, 750]);

    setAutomationTitle('running');
    ctx.showBanner({
      label: 'Automation running',
      detail: `Graphs: ${targetGraphNames.join(', ')}`,
      actionLabel: 'Stop',
      onAction: () => jobSchedulerService.cancel('daily-automation'),
    });

    // Per-graph loop.
    const totalGraphs = targetGraphNames.length;
    for (let idx = 0; idx < totalGraphs; idx++) {
      const graphName = targetGraphNames[idx];
      const sequenceInfo = `[${idx + 1}/${totalGraphs}]`;

      if (ctx.shouldAbort()) {
        sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_ABORTED', `${sequenceInfo} Daily automation aborted by user`);
        return;
      }

      ctx.showBanner({
        label: `Automation running ${sequenceInfo}: ${graphName}`,
        detail: `Graphs: ${targetGraphNames.join(', ')}`,
        actionLabel: 'Stop',
        onAction: () => jobSchedulerService.cancel('daily-automation'),
      });

      sessionLogService.info('session', 'DAILY_RETRIEVE_ALL_GRAPH_START', `${sequenceInfo} Starting: ${graphName}`);

      const graphFileId = `graph-${graphName}`;
      const graphItem: RepositoryItem = {
        id: graphName,
        name: graphName,
        type: 'graph',
        path: `graphs/${graphName}.json`,
      };

      // Open tab (always fresh — boot was blank, nothing to reuse).
      if (automationCtx.tabOps) {
        await automationCtx.tabOps.openTab(graphItem, 'interactive', false);
      }

      if (logTabId) reassertTabFocus(logTabId, [0, 50, 200, 750]);

      const loaded = await waitForGraphData(graphFileId, 60_000, 250, () => ctx.shouldAbort());
      if (!loaded) {
        sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_SKIPPED', `${sequenceInfo} Daily automation skipped graph: graph did not load in time`);
        continue;
      }

      await dailyRetrieveAllAutomationService.run({
        repository: repoFinal,
        branch: branchFinal,
        graphFileId,
        getGraph: () => (automationCtx.fileRegistryGetFile(graphFileId) as any)?.data || null,
        setGraph: (g) => automationCtx.tabOps?.updateTabData(graphFileId, g),
        shouldAbort: () => ctx.shouldAbort(),
      });

      sessionLogService.info('session', 'DAILY_RETRIEVE_ALL_GRAPH_COMPLETE', `${sequenceInfo} Completed: ${graphName}`);
    }
  } catch (e) {
    console.error('[dailyAutomationJob] Automation failed:', e);
    throw e; // Let the scheduler handle error state.
  } finally {
    document.title = originalTitle;

    // Clean URL params.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('retrieveall');
      url.searchParams.delete('graph');
      window.history.replaceState({}, document.title, url.toString());
    } catch { /* best effort */ }

    // Persist automation run log and auto-close window.
    try {
      const allEntries = sessionLogService.getEntries();
      const runEntries = allEntries.slice(logStartIndex);

      const isBackgroundNoise = (op: string) =>
        op === 'PLANNER_ANALYSIS' || op === 'GRAPH_ISSUES_CHECK' || op === 'CHART_RECONCILE';

      const hasEntryLevel = (level: string) =>
        runEntries.some(e =>
          !isBackgroundNoise(e.operation) && (
            e.level === level || e.children?.some((c: any) => c.level === level)
          )
        );

      let outcome: 'success' | 'warning' | 'error' | 'aborted';
      if (ctx.shouldAbort()) {
        outcome = 'aborted';
      } else if (hasEntryLevel('error')) {
        outcome = 'error';
      } else if (hasEntryLevel('warning')) {
        outcome = 'warning';
      } else {
        outcome = 'success';
      }

      await automationLogService.persistRunLog({
        runId: `retrieveall:${waitStartedAt}`,
        timestamp: waitStartedAt,
        graphs: targetGraphNames,
        outcome,
        appVersion: APP_VERSION,
        repository: repoForLog,
        branch: branchForLog,
        durationMs: Date.now() - waitStartedAt,
        entries: runEntries,
      });

      const closeDelayMs = getCloseDelayMs(outcome);

      if (closeDelayMs === Infinity) {
        sessionLogService.info('session', 'AUTOMATION_WINDOW_KEPT_OPEN',
          '?noclose: window will remain open for inspection',
          'Logs have been persisted to IndexedDB. Run dagnetAutomationLogs() in the console to review past runs.');
      } else {
        const closeDelayLabel = outcome === 'success' ? '10 seconds' : `${Math.round(closeDelayMs / 60_000)} minutes`;

        sessionLogService.info('session', 'AUTOMATION_WINDOW_CLOSE',
          `Automation finished (${outcome}) — closing browser window in ${closeDelayLabel}`,
          'Logs have been persisted to IndexedDB. Run dagnetAutomationLogs() in the console to review past runs.');

        await sleepUntilDeadline(closeDelayMs);
        try { window.close(); } catch { /* best effort */ }
      }
    } catch (persistErr) {
      console.error('[dailyAutomationJob] Failed to persist automation log:', persistErr);
    }
  }
}

// Expose for E2E testing (dev mode only).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__dagnetEnumerateDailyFetchGraphs = enumerateDailyFetchGraphsFromIDB;
}

/** Reset for tests. */
export function _resetDailyAutomationJob(): void {
  registered = false;
  automationCtx.navigatorReady = false;
  automationCtx.tabs = [];
  automationCtx.tabOps = null;
  automationCtx.selectedRepo = undefined;
  automationCtx.selectedBranch = undefined;
  automationCtx.fileRegistryGetFile = () => null;
}
