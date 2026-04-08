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
import { fileRegistry } from '../contexts/TabContext';
import { formatDateUK } from '../lib/dateFormat';
import type { RepositoryItem, GraphData, ViewMode } from '../types';

/** Interval (ms) between periodic log commits to the data repo. */
const LOG_COMMIT_INTERVAL_MS = 10 * 60_000; // 10 minutes

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
  let logCommitAborted = false;
  const logFilename = `retrieve-all-${formatDateUK(new Date())}.json`;

  /** Snapshot current run entries and commit to repo. Best-effort. */
  const commitLogSnapshot = async () => {
    if (repoForLog === 'unknown') return;
    try {
      const allEntries = sessionLogService.getEntries();
      const runEntries = allEntries.slice(logStartIndex);
      await automationLogService.commitLogToRepo({
        repository: repoForLog,
        branch: branchForLog,
        filename: logFilename,
        log: {
          runId: `retrieveall:${waitStartedAt}`,
          timestamp: waitStartedAt,
          graphs: targetGraphNames,
          outcome: 'in-progress',
          appVersion: APP_VERSION,
          repository: repoForLog,
          branch: branchForLog,
          durationMs: Date.now() - waitStartedAt,
          entries: runEntries,
        },
      });
    } catch (e) {
      console.warn('[dailyAutomationJob] Periodic log commit failed:', e);
    }
  };

  // ---------------------------------------------------------------------------
  // Progressive flush — write log state to IDB every 60s so a crash/kill
  // doesn't lose hours of diagnostic context.  The timer is silent: no session
  // log entries on each tick.  Only writes when new entries have appeared.
  // ---------------------------------------------------------------------------
  const FLUSH_INTERVAL_MS = 60_000;
  const runId = `retrieveall:${waitStartedAt}`;
  let lastFlushedEntryCount = 0;
  let progressiveFlushTimer: ReturnType<typeof setInterval> | null = null;

  const countEntriesDeep = (entries: any[]): number =>
    entries.reduce((n, e) => n + 1 + (e.children?.length ?? 0), 0);

  const doProgressiveFlush = async () => {
    try {
      const allEntries = sessionLogService.getEntries();
      const runEntries = allEntries.slice(logStartIndex);
      const totalCount = countEntriesDeep(runEntries);
      if (totalCount === lastFlushedEntryCount) return; // no change
      lastFlushedEntryCount = totalCount;
      await automationLogService.progressiveFlush({
        runId,
        timestamp: waitStartedAt,
        graphs: targetGraphNames,
        outcome: 'running',
        appVersion: APP_VERSION,
        repository: repoForLog,
        branch: branchForLog,
        durationMs: Date.now() - waitStartedAt,
        entries: runEntries,
      });
    } catch { /* best effort — never let flush errors interrupt the run */ }
  };

  const startProgressiveFlush = () => {
    sessionLogService.info('session', 'PROGRESSIVE_LOG_FLUSH_ENABLED',
      `Progressive log writes enabled (every ${FLUSH_INTERVAL_MS / 1000}s) — runId: ${runId}`);
    // Initial flush: create the 'running' record in IDB immediately.
    void doProgressiveFlush();
    progressiveFlushTimer = setInterval(doProgressiveFlush, FLUSH_INTERVAL_MS);
  };

  const stopProgressiveFlush = () => {
    if (progressiveFlushTimer != null) {
      clearInterval(progressiveFlushTimer);
      progressiveFlushTimer = null;
    }
  };

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

    // Start periodic log commit loop (wall-clock based, not setInterval).
    // Uses absolute deadlines so browser throttling of background tabs can't
    // cause drift or missed commits.
    void (async () => {
      while (!logCommitAborted) {
        await sleepUntilDeadline(LOG_COMMIT_INTERVAL_MS);
        if (logCommitAborted) break;
        await commitLogSnapshot();
      }
    })();

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
    // Phase 0: Apply pending Bayes patches from previous cycle (doc 28 §11.2.1)
    // -----------------------------------------------------------------------
    try {
      const { scanForPendingPatches } = await import('./bayesPatchService');
      const scanResult = await scanForPendingPatches(branchFinal);

      if (scanResult.applied.length > 0 || scanResult.skipped.length > 0) {
        sessionLogService.info('session', 'DAILY_AUTOMATION_BAYES_PHASE0',
          `Phase 0: ${scanResult.applied.length} patch(es) applied, ${scanResult.skipped.length} skipped, ${scanResult.errors.length} errors`);

        // Commit applied patches so posteriors are in git before Phase 1 retrieval
        if (scanResult.applied.length > 0) {
          try {
            const committable = await repositoryOperationsService.getCommittableFiles(repoFinal, branchFinal);
            if (committable.length > 0) {
              await repositoryOperationsService.commitFiles(
                committable,
                `Bayes posteriors (Phase 0) — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}`,
                branchFinal,
                repoFinal,
                async () => 'primary',
                async () => {
                  await repositoryOperationsService.pullLatestRemoteWins(repoFinal, branchFinal);
                },
              );
            }
          } catch (commitErr) {
            sessionLogService.warning('session', 'DAILY_AUTOMATION_BAYES_PHASE0_COMMIT_FAILED',
              `Phase 0 commit failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`);
          }
        }
      }
    } catch (phase0Err) {
      sessionLogService.warning('session', 'DAILY_AUTOMATION_BAYES_PHASE0_FAILED',
        `Phase 0 failed (non-fatal): ${phase0Err instanceof Error ? phase0Err.message : String(phase0Err)}`);
    }

    if (ctx.shouldAbort()) {
      sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_ABORTED', 'Daily automation aborted by user (after Phase 0)');
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

    // Begin progressive log flushing now that we know the target graphs.
    startProgressiveFlush();

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

    // -----------------------------------------------------------------------
    // Phase 1: Serial fetch + commission Bayes (doc 28 §11.2.1)
    // -----------------------------------------------------------------------
    interface PendingBayesFit {
      graphId: string;
      graphName: string;
      jobId: string;
      statusUrl?: string;
      patchPath: string;
    }
    const pendingBayesFits: PendingBayesFit[] = [];

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

      try {
        const graphFileId = `graph-${graphName}`;

        // Headless: load graph from FileRegistry (already populated by loadWorkspaceFromIDB).
        // No tab opened — avoids mounting GraphEditor and all its expensive
        // rendering/compute cascades (ReactFlow, scenarios, charts, edge geometry).
        let graphFile = fileRegistry.getFile(graphFileId);
        if (!graphFile?.data) {
          // Fallback: try restoring from IDB directly (with workspace for prefixed key lookup).
          graphFile = await fileRegistry.restoreFile(graphFileId, { repository: repoFinal, branch: branchFinal }) ?? undefined;
        }
        if (!graphFile?.data || graphFile.type !== 'graph') {
          sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_SKIPPED',
            `${sequenceInfo} Skipped: graph data not found in workspace`);
          continue;
        }

        await dailyRetrieveAllAutomationService.run({
          repository: repoFinal,
          branch: branchFinal,
          graphFileId,
          getGraph: () => fileRegistry.getFile(graphFileId)?.data || null,
          setGraph: (g) => { if (g) void fileRegistry.updateFile(graphFileId, g); },
          shouldAbort: () => ctx.shouldAbort(),
        });
        sessionLogService.info('session', 'DAILY_RETRIEVE_ALL_GRAPH_COMPLETE', `${sequenceInfo} Completed: ${graphName}`);

        // Commission Bayes fit if graph has opted in (doc 28 §10.4)
        const graphData = fileRegistry.getFile(graphFileId)?.data as GraphData | null;
        if (graphData?.runBayes) {
          try {
            const { submitBayesFitForAutomation } = await import('./bayesReconnectService');
            const result = await submitBayesFitForAutomation({
              graphFileId,
              repo: repoFinal,
              branch: branchFinal,
            });
            pendingBayesFits.push({
              graphId: graphFileId,
              graphName,
              jobId: result.jobId,
              patchPath: result.patchPath,
            });
            sessionLogService.info('session', 'DAILY_AUTOMATION_BAYES_SUBMITTED',
              `${sequenceInfo} Bayes fit submitted for ${graphName}: ${result.jobId}`);
          } catch (bayesErr) {
            // Submit failed — log, skip Bayes for this graph, continue (doc 28 F3)
            const msg = bayesErr instanceof Error ? bayesErr.message : String(bayesErr);
            sessionLogService.warning('session', 'DAILY_AUTOMATION_BAYES_SUBMIT_FAILED',
              `${sequenceInfo} Bayes submit failed for ${graphName}: ${msg}`);
          }
        }
      } catch (graphErr) {
        const msg = graphErr instanceof Error ? graphErr.message : String(graphErr);
        const stack = graphErr instanceof Error ? graphErr.stack : undefined;
        sessionLogService.error('session', 'DAILY_RETRIEVE_ALL_GRAPH_FAILED',
          `${sequenceInfo} Failed: ${graphName} — ${msg}`, stack);
        console.error(`[dailyAutomationJob] Graph ${graphName} failed:`, graphErr);
        // Continue to next graph — don't abort the entire run for one graph failure.
      }
    }

    // -----------------------------------------------------------------------
    // Phase 2: Drain pending Bayes fits (doc 28 §11.2.1)
    // -----------------------------------------------------------------------
    if (pendingBayesFits.length > 0 && !ctx.shouldAbort()) {
      sessionLogService.info('session', 'DAILY_AUTOMATION_BAYES_DRAIN_START',
        `Phase 2: draining ${pendingBayesFits.length} pending Bayes fit(s)`);

      ctx.showBanner({
        label: `Automation: waiting for ${pendingBayesFits.length} Bayes fit(s)…`,
        detail: pendingBayesFits.map(f => f.graphName).join(', '),
        actionLabel: 'Stop',
        onAction: () => jobSchedulerService.cancel('daily-automation'),
      });

      // Create all polling promises once — race on a shrinking pool (doc 28 F6).
      // Each promise resolves to { fit, result, idx } — idx is used to find
      // and remove the resolved entry from the remaining array.
      const { pollUntilDone: poll } = await import('./bayesService');

      type DrainEntry = { promise: Promise<DrainResult>; fit: PendingBayesFit };
      type DrainResult = { fit: PendingBayesFit; result: { status: string; error?: string }; idx: number };

      const drainEntries: DrainEntry[] = pendingBayesFits.map((fit, idx) => {
        const promise = poll(fit.jobId, undefined, 5_000, 30 * 60 * 1000)
          .then(result => ({ fit, result, idx }))
          .catch(err => ({ fit, result: { status: 'failed' as const, error: err.message }, idx }));
        return { promise, fit };
      });

      let remaining = [...drainEntries];

      while (remaining.length > 0) {
        if (ctx.shouldAbort()) {
          sessionLogService.warning('session', 'DAILY_AUTOMATION_BAYES_DRAIN_ABORTED',
            `Phase 2 aborted — ${remaining.length} fit(s) still pending`);
          break;
        }

        const settled = await Promise.race(remaining.map(e => e.promise));
        remaining = remaining.filter(e => e.fit.jobId !== settled.fit.jobId);

        ctx.showBanner({
          label: `Automation: ${remaining.length} Bayes fit(s) remaining…`,
          detail: pendingBayesFits.map(f => f.graphName).join(', '),
          actionLabel: 'Stop',
          onAction: () => jobSchedulerService.cancel('daily-automation'),
        });

        if (settled.result.status === 'failed') {
          // Log and continue — don't block other fits (doc 28 F1)
          sessionLogService.warning('session', 'DAILY_AUTOMATION_BAYES_FIT_FAILED',
            `Bayes fit failed for ${settled.fit.graphName}: ${settled.result.error ?? 'unknown'}`);
          continue;
        }

        // Pull to get the patch file, then apply via on-pull scanner
        try {
          await repositoryOperationsService.pullLatestRemoteWins(repoFinal, branchFinal);
          await workspaceService.loadWorkspaceFromIDB(repoFinal, branchFinal);

          // The on-pull scanner (scanForPendingPatches, hooked into pullLatest)
          // applies the patch automatically. Commit the resulting dirty files.
          const committable = await repositoryOperationsService.getCommittableFiles(repoFinal, branchFinal);
          if (committable.length > 0) {
            await repositoryOperationsService.commitFiles(
              committable,
              `Bayes posteriors (${settled.fit.graphName}) — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}`,
              branchFinal,
              repoFinal,
              async () => 'primary',
              async () => {
                await repositoryOperationsService.pullLatestRemoteWins(repoFinal, branchFinal);
              },
            );
          }

          sessionLogService.success('session', 'DAILY_AUTOMATION_BAYES_FIT_APPLIED',
            `Bayes posteriors applied and committed for ${settled.fit.graphName}`);
        } catch (applyErr) {
          const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
          sessionLogService.warning('session', 'DAILY_AUTOMATION_BAYES_APPLY_FAILED',
            `Bayes apply/commit failed for ${settled.fit.graphName}: ${msg}`);
        }
      }

      sessionLogService.info('session', 'DAILY_AUTOMATION_BAYES_DRAIN_COMPLETE',
        `Phase 2 complete: ${pendingBayesFits.length - remaining.length} fit(s) processed`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error('[dailyAutomationJob] Automation failed:', e);
    sessionLogService.error('session', 'DAILY_RETRIEVE_ALL_FATAL',
      `Automation crashed: ${msg}`, stack);
    // Do NOT re-throw — let the finally block persist the log with the error.
  } finally {
    stopProgressiveFlush();
    logCommitAborted = true;
    document.title = originalTitle;

    // Clean URL params.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('retrieveall');
      url.searchParams.delete('graph');
      window.history.replaceState({}, document.title, url.toString());
    } catch { /* best effort */ }

    // Final persist — overwrites the progressive 'running' record with the
    // definitive outcome. This is the same record (same runId) so there is
    // no duplication.
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

      const runLog = {
        runId,
        timestamp: waitStartedAt,
        graphs: targetGraphNames,
        outcome,
        appVersion: APP_VERSION,
        repository: repoForLog,
        branch: branchForLog,
        durationMs: Date.now() - waitStartedAt,
        entries: runEntries,
      };

      // Persist to IDB (primary safety net).
      await automationLogService.persistRunLog(runLog);

      // Final commit to git repo (best-effort).
      if (repoForLog !== 'unknown') {
        await automationLogService.commitLogToRepo({
          repository: repoForLog,
          branch: branchForLog,
          filename: logFilename,
          log: runLog,
        });
      }

      const closeDelayMs = getCloseDelayMs(outcome);

      if (closeDelayMs === Infinity) {
        sessionLogService.info('session', 'AUTOMATION_WINDOW_KEPT_OPEN',
          '?noclose: window will remain open for inspection',
          'Logs persisted to IndexedDB and git repo.');
      } else {
        const closeDelayLabel = outcome === 'success' ? '10 seconds' : `${Math.round(closeDelayMs / 60_000)} minutes`;

        sessionLogService.info('session', 'AUTOMATION_WINDOW_CLOSE',
          `Automation finished (${outcome}) — closing browser window in ${closeDelayLabel}`,
          'Logs persisted to IndexedDB and git repo.');

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
