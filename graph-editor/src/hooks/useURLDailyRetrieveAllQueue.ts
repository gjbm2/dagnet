/**
 * useURLDailyRetrieveAllQueue Hook
 *
 * Headless daily automation trigger via URL params, supporting MULTIPLE graphs in one browser session.
 *
 * Supported URLs:
 * - `?retrieveall=<graph-name>` (single)
 * - `?retrieveall=<graph-a>,<graph-b>,<graph-c>` (comma-separated list)
 * - `?retrieveall=<graph-a>&retrieveall=<graph-b>` (repeated param)
 * - `?graph=<graph-name>&retrieveall` (boolean flag; single graph)
 * - `?retrieveall` (no value) — **enumeration mode**: processes all graphs with `dailyFetch: true` in the workspace
 *
 * Behaviour:
 * - Opens/loads each graph tab (if needed) then runs pull → retrieve → commit sequentially.
 * - In enumeration mode, queries IndexedDB for graphs with dailyFetch=true (workspace-scoped, deduped).
 * - Keeps Session Log as the primary UX for progress/diagnostics.
 * - Cleans URL params once after the whole queue completes.
 */

import { useEffect, useRef } from 'react';
import type { RepositoryItem, GraphData } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { fileRegistry, useTabContext } from '../contexts/TabContext';
import { sessionLogService } from '../services/sessionLogService';
import { dailyRetrieveAllAutomationService } from '../services/dailyRetrieveAllAutomationService';
import { automationRunService } from '../services/automationRunService';
import { automationLogService } from '../services/automationLogService';
import { isShareMode } from '../lib/shareBootResolver';
import { countdownService } from '../services/countdownService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { workspaceService } from '../services/workspaceService';
import { db } from '../db/appDatabase';
import { APP_VERSION } from '../version';

interface URLDailyRetrieveAllQueueParams {
  retrieveAllValues: string[]; // raw values from ?retrieveall=... (can be empty strings)
  hasRetrieveAllFlag: boolean; // presence of ?retrieveall (even without value)
  graphParam: string | null; // value from ?graph=...
}

let urlDailyRetrieveAllQueueProcessed = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wall-clock-aware sleep that is resilient to background-tab timer throttling.
 *
 * Browsers can clamp/suspend `setTimeout` in background tabs, so a single
 * `sleep(12h)` may overshoot by hours. This function polls every `tickMs`
 * (default 30 s) and re-checks `Date.now()` against a fixed deadline.
 * Even if a tick is delayed, the very next tick that fires after the deadline
 * will resolve immediately.
 */
async function sleepUntilDeadline(durationMs: number, tickMs = 30_000): Promise<void> {
  if (durationMs <= 0) return;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(tickMs, Math.max(remaining, 0)));
  }
}

async function runAutomationStartCountdown(opts: {
  runId: string;
  totalSeconds: number;
  shouldStop: () => boolean;
}): Promise<'expired' | 'aborted'> {
  const { runId, totalSeconds, shouldStop } = opts;
  if (totalSeconds <= 0) return 'expired';

  const key = `automation:retrieveall:start:${runId}`;
  let lastSeconds: number | undefined;

  const unsubscribe = countdownService.subscribe(() => {
    const st = countdownService.getState(key);
    if (!st) return;
    // Avoid spamming state updates for the same value.
    if (lastSeconds === st.secondsRemaining) return;
    lastSeconds = st.secondsRemaining;
    automationRunService.setCountdown(runId, st.secondsRemaining);
  });

  try {
    automationRunService.setCountdown(runId, totalSeconds);
    countdownService.startCountdown({
      key,
      durationSeconds: totalSeconds,
      onExpire: () => {
        // No-op here; we resolve by polling for removal below.
      },
      audit: {
        operationType: 'session',
        startCode: 'DAILY_RETRIEVE_ALL_COUNTDOWN_START',
        cancelCode: 'DAILY_RETRIEVE_ALL_COUNTDOWN_CANCEL',
        expireCode: 'DAILY_RETRIEVE_ALL_COUNTDOWN_EXPIRE',
        message: 'Daily automation start countdown',
        metadata: { runId, totalSeconds },
      },
    });

    // Wait until countdown disappears (expired or cancelled) or stop is requested.
    // We keep this loop small and deterministic (no user interaction expected during countdown).
    while (true) {
      if (shouldStop()) {
        countdownService.cancelCountdown(key);
        return 'aborted';
      }
      const st = countdownService.getState(key);
      if (!st) return 'expired';
      await sleep(50);
    }
  } finally {
    unsubscribe();
    countdownService.cancelCountdown(key);
  }
}

function getURLDailyRetrieveAllStartDelayMs(): number {
  // Vitest should not spend 30 seconds waiting (and the "settling" problem is a real-app concern).
  if ((import.meta as any).env?.MODE === 'test') return 0;

  // Playwright E2E: skip countdown to keep tests brisk.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('e2e') === '1') return 0;
  }

  return 30_000;
}

/**
 * How long to wait before auto-closing the browser window after automation.
 *
 * - Success: 10 seconds (quick close, nothing to review).
 * - Non-success (warning/error/aborted): 12 hours grace period so the operator
 *   can review logs, but the window still closes before the next day's
 *   scheduled run fires (preventing stale windows blocking future runs).
 *
 * In Vitest (`MODE === 'test'`) the delay is 0 to keep tests fast.
 * With `?e2e=1` (Playwright) the delay is 500 ms so E2E tests can assert the
 * close without waiting real-world durations.
 */
function getAutomationCloseDelayMs(outcome: string): number {
  // Vitest: instant close.
  if ((import.meta as any).env?.MODE === 'test') return 0;

  // Playwright E2E: very short delay so tests can assert without real waits.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('e2e') === '1') return 500;
  }

  // Production.
  if (outcome === 'success') return 10_000;          // 10 seconds
  return 12 * 60 * 60 * 1000;                        // 12 hours
}

function isTabContextInitDone(): boolean {
  // Unit tests don’t mount the full TabContext initialisation pipeline.
  if ((import.meta as any).env?.MODE === 'test') return true;
  try {
    const w = (typeof window !== 'undefined') ? (window as any) : null;
    return !!w?.__dagnetTabContextInitDone;
  } catch {
    return false;
  }
}

function reassertTabFocus(tabId: string, delaysMs: number[]): void {
  // Best-effort: rc-dock/layout initialisation sometimes steals focus after we open/switch tabs.
  // Reassert focus a few times to keep the Session Log visible during automation.
  void (async () => {
    for (const delay of delaysMs) {
      if (delay > 0) await sleep(delay);
      if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
      window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId } }));
    }
  })();
}

function parseURLParams(): URLDailyRetrieveAllQueueParams {
  const searchParams = new URLSearchParams(window.location.search);
  return {
    retrieveAllValues: searchParams.getAll('retrieveall'),
    hasRetrieveAllFlag: searchParams.has('retrieveall'),
    graphParam: searchParams.get('graph'),
  };
}

function cleanURLParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('retrieveall');
  // Note: `graph` is cleaned by TabContext after it opens the file, but keep this safe.
  url.searchParams.delete('graph');
  window.history.replaceState({}, document.title, url.toString());
}

function normaliseGraphNames(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const parts = String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const name of parts) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }

  return out;
}

function resolveTargetGraphNames(params: URLDailyRetrieveAllQueueParams): string[] {
  // Prefer explicit `?retrieveall=...` values (including repeated params and comma-separated lists).
  const fromRetrieveAll = normaliseGraphNames(params.retrieveAllValues);
  if (fromRetrieveAll.length > 0) return fromRetrieveAll;

  // Support boolean flag + separate `?graph=<graph-name>`
  if (params.hasRetrieveAllFlag && params.graphParam && params.graphParam.trim() !== '') {
    return [params.graphParam.trim()];
  }

  return [];
}

function inferGraphNameFromFileId(fileId: string): string {
  return fileId.startsWith('graph-') ? fileId.slice('graph-'.length) : fileId;
}

/**
 * Enumerate all graphs in IndexedDB that have `dailyFetch: true`.
 * Returns graph names (without 'graph-' prefix), sorted alphabetically for determinism.
 * 
 * Scoped to the specified workspace (repo/branch) and dedupes prefixed/unprefixed fileIds.
 */
async function enumerateDailyFetchGraphsFromIDB(workspace: { repository: string; branch: string }): Promise<string[]> {
  const allGraphFiles = await db.files
    .where('type')
    .equals('graph')
    .toArray();

  // Filter to workspace and dedupe prefixed vs unprefixed variants
  // IDB can have both 'graph-x' and 'repo-branch-graph-x' for the same file
  const seenCanonical = new Set<string>();
  const candidates: Array<{ fileId: string; data: GraphData | null }> = [];

  for (const file of allGraphFiles) {
    // Only files from this workspace
    if (file.source?.repository !== workspace.repository || file.source?.branch !== workspace.branch) {
      continue;
    }

    // Extract canonical name (handle both prefixed and unprefixed)
    let canonicalName: string;
    if (file.fileId.includes('-graph-')) {
      // Workspace-prefixed: 'repo-branch-graph-<name>'
      const parts = file.fileId.split('-graph-');
      canonicalName = parts[parts.length - 1];
    } else if (file.fileId.startsWith('graph-')) {
      // Unprefixed: 'graph-<name>'
      canonicalName = file.fileId.slice(6);
    } else {
      canonicalName = file.fileId;
    }

    // Dedupe: prefer workspace-prefixed variant if both exist
    if (seenCanonical.has(canonicalName)) {
      // If this one is prefixed and previous wasn't, replace
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

  // Filter to those with dailyFetch: true
  const names: string[] = [];
  for (const { fileId, data } of candidates) {
    if (data?.dailyFetch) {
      // Extract canonical name again for output
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

// Expose for E2E testing (dev mode only)
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__dagnetEnumerateDailyFetchGraphs = enumerateDailyFetchGraphsFromIDB;
}

async function waitForGraphData(fileId: string, maxWaitMs: number, pollMs: number, shouldAbort: () => boolean): Promise<boolean> {
  const startedAt = Date.now();
  while (true) {
    if (shouldAbort()) return false;

    const file = fileRegistry.getFile(fileId) as any;
    const hasGraphData = !!(file?.data && file?.type === 'graph');
    if (hasGraphData) return true;

    const elapsed = Date.now() - startedAt;
    if (elapsed > maxWaitMs) return false;
    await sleep(pollMs);
  }
}

export function useURLDailyRetrieveAllQueue(): void {
  const { state: navState } = useNavigatorContext();
  const { tabs, operations: tabOps } = useTabContext();

  const processedRef = useRef(false);
  const paramsRef = useRef<URLDailyRetrieveAllQueueParams | null>(null);
  const tabContextInitDoneRef = useRef(false);

  // IMPORTANT: This hook uses async loops. Never rely on render-captured values inside long-running
  // async loops, or you can get stuck reading stale state (e.g. repo becomes selected later but the
  // loop never sees it). Keep refs updated on every render.
  const latestNavStateRef = useRef(navState);
  latestNavStateRef.current = navState;

  const latestTabOpsRef = useRef(tabOps);
  latestTabOpsRef.current = tabOps;

  const latestTabsRef = useRef(tabs);
  latestTabsRef.current = tabs;

  // Parse params on mount (before TabContext cleans them).
  useEffect(() => {
    if (!paramsRef.current) paramsRef.current = parseURLParams();
  }, []);

  // Track TabContext initialisation completion (URL opening, tab restore, seeds).
  useEffect(() => {
    if (tabContextInitDoneRef.current) return;
    if (isTabContextInitDone()) {
      tabContextInitDoneRef.current = true;
      return;
    }

    const handler = () => {
      tabContextInitDoneRef.current = true;
    };
    window.addEventListener('dagnet:tabContextInitDone' as any, handler as any);
    return () => {
      window.removeEventListener('dagnet:tabContextInitDone' as any, handler as any);
    };
  }, []);

  useEffect(() => {
    if (processedRef.current) return;
    if (urlDailyRetrieveAllQueueProcessed) {
      processedRef.current = true;
      return;
    }
    
    // Disable automation in share mode - makes no sense for embedded views
    if (isShareMode()) {
      processedRef.current = true;
      return;
    }

    const params = paramsRef.current;
    if (!params?.hasRetrieveAllFlag) return;

    // Get explicit graph names from URL (may be empty for enumeration mode)
    const explicitGraphNames = resolveTargetGraphNames(params);
    
    // If no explicit graphs AND no retrieveall flag value, this is enumeration mode
    // We allow this case now (will enumerate from IDB after workspace is ready)
    const isEnumerationMode = explicitGraphNames.length === 0;
    
    // For explicit mode, we need at least one graph
    // For enumeration mode, we proceed and will enumerate after workspace ready
    if (!isEnumerationMode && explicitGraphNames.length === 0) return;

    processedRef.current = true;
    urlDailyRetrieveAllQueueProcessed = true;

    void (async () => {
      const originalTitle = document.title;
      const setAutomationTitle = (phase: string) => {
        const prefix = `[Automation: ${phase}] `;
        document.title = originalTitle.startsWith('[Automation:')
          ? `${prefix}${originalTitle.replace(/^\[Automation:[^\]]+\]\s*/, '')}`
          : `${prefix}${originalTitle}`;
      };

      const waitStartedAt = Date.now();
      const maxWaitMs = 60_000;
      const pollMs = 250;
      
      // Snapshot the current session-log length so we can capture only this run's entries later.
      const logStartIndex = sessionLogService.getEntries().length;

      // Track repo/branch outside try so the finally block can access them.
      let repoForLog = 'unknown';
      let branchForLog = 'unknown';

      // IMPORTANT: runId MUST remain stable for the lifetime of the run.
      // automationRunService ignores updates where runId mismatches, so mutating runId mid-run
      // causes the AutomationBanner to get stuck in "waiting" even while work proceeds.
      let runId = isEnumerationMode 
        ? `retrieveall-enumerate:${waitStartedAt}`
        : `retrieveall-queue:${explicitGraphNames.join(',')}:${waitStartedAt}`;
      let targetGraphNames = [...explicitGraphNames];

      try {
        setAutomationTitle('starting');
        automationRunService.start({
          runId,
          graphFileId: isEnumerationMode ? 'enumerate-pending' : `graph-${targetGraphNames[0]}`,
          graphName: isEnumerationMode ? '(enumerating...)' : targetGraphNames[0],
        });

        // Wait for app context to settle: repo selection, tabOps, and TabContext init.
        let loggedWaiting = false;
        while (true) {
          if (automationRunService.shouldStop(runId)) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_ABORTED',
              'Daily automation aborted by user (waiting phase)',
              undefined,
              { graphs: targetGraphNames }
            );
            return;
          }

          const repo = latestNavStateRef.current.selectedRepo;
          const hasTabOps = !!latestTabOpsRef.current?.openTab;
          const tabCtxReady = tabContextInitDoneRef.current || isTabContextInitDone();

          if (repo && hasTabOps && tabCtxReady) break;

          const elapsed = Date.now() - waitStartedAt;
          if (elapsed > maxWaitMs) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_SKIPPED',
              'Daily automation skipped: app did not become ready in time',
              undefined,
              { graphs: targetGraphNames, waitedMs: elapsed, hasRepository: !!repo, hasTabOps, tabCtxReady }
            );
            return;
          }

          if (!loggedWaiting) {
            loggedWaiting = true;
            sessionLogService.info(
              'session',
              'DAILY_RETRIEVE_ALL_WAITING',
              'Daily automation: waiting for app to initialise (repo selection, tab init)',
              undefined,
              { graphs: targetGraphNames, maxWaitMs, pollMs }
            );
          }

          await sleep(pollMs);
        }

        const repoFinal: string = latestNavStateRef.current.selectedRepo as string;
        const branchFinal: string = latestNavStateRef.current.selectedBranch || 'main';
        repoForLog = repoFinal;
        branchForLog = branchFinal;

        // If enumeration mode, pull latest from Git BEFORE enumerating so that
        // newly-added dailyFetch flags (committed remotely) are visible in IDB.
        if (isEnumerationMode) {
          sessionLogService.info(
            'session',
            'DAILY_RETRIEVE_ALL_PRE_PULL',
            'Pulling latest from Git before enumerating dailyFetch graphs',
            undefined,
            { repository: repoFinal, branch: branchFinal }
          );

          try {
            const prePullResult = await repositoryOperationsService.pullLatestRemoteWins(repoFinal, branchFinal);
            if ((prePullResult.conflictsResolved ?? 0) > 0) {
              sessionLogService.warning(
                'session',
                'DAILY_RETRIEVE_ALL_PRE_PULL_CONFLICTS',
                `Pre-enumeration pull resolved ${prePullResult.conflictsResolved} conflict(s) by accepting remote`,
                undefined,
                { repository: repoFinal, branch: branchFinal }
              );
            }

            // Ensure FileRegistry is fully reloaded from IDB after pull.
            // pullLatestRemoteWins triggers navigatorOps.refreshItems() which calls
            // loadWorkspaceFromIDB, but that can be silently dropped by a concurrent-
            // load guard. Explicitly reload here so the per-graph automation loop
            // (which reads FileRegistry) sees the freshly-pulled data.
            await workspaceService.loadWorkspaceFromIDB(repoFinal, branchFinal);
          } catch (pullErr) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_PRE_PULL_FAILED',
              `Pre-enumeration pull failed (proceeding with cached data): ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`,
              undefined,
              { repository: repoFinal, branch: branchFinal }
            );
          }

          sessionLogService.info(
            'session',
            'DAILY_RETRIEVE_ALL_ENUMERATE',
            'Enumerating graphs with dailyFetch=true from workspace',
            undefined,
            { repository: repoFinal, branch: branchFinal }
          );

          targetGraphNames = await enumerateDailyFetchGraphsFromIDB({
            repository: repoFinal,
            branch: branchFinal,
          });

          if (targetGraphNames.length === 0) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_NO_GRAPHS',
              'No graphs with dailyFetch=true found in workspace',
              undefined,
              { repository: repoFinal, branch: branchFinal }
            );
            return;
          }

          sessionLogService.info(
            'session',
            'DAILY_RETRIEVE_ALL_FOUND',
            `Found ${targetGraphNames.length} graph(s) with dailyFetch=true`,
            targetGraphNames.join(', '),
            { graphs: targetGraphNames }
          );
        }

        // Open Session Log early so the user sees progress immediately. Best-effort only.
        try {
          const logTabIdEarly = await sessionLogService.openLogTab();
          if (logTabIdEarly) {
            reassertTabFocus(logTabIdEarly, [0, 50, 200, 750]);
          }
        } catch {
          // Best-effort only
        }

        const startDelayMs = getURLDailyRetrieveAllStartDelayMs();
        if (startDelayMs > 0) {
          setAutomationTitle('countdown');
          const totalSeconds = Math.ceil(startDelayMs / 1000);
          const res = await runAutomationStartCountdown({
            runId,
            totalSeconds,
            shouldStop: () => automationRunService.shouldStop(runId),
          });
          if (res === 'aborted') {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_ABORTED',
              'Daily automation aborted by user (countdown phase)',
              undefined,
              { graphs: targetGraphNames }
            );
            return;
          }
        }

        // Open Session Log after countdown too (rc-dock can steal focus). Best-effort.
        const logTabId = await sessionLogService.openLogTab();
        if (logTabId) {
          reassertTabFocus(logTabId, [0, 50, 200, 750]);
        }

        setAutomationTitle('running');
        automationRunService.setPhase(runId, 'running');

        const totalGraphs = targetGraphNames.length;
        for (let idx = 0; idx < totalGraphs; idx++) {
          const graphName = targetGraphNames[idx];
          const sequenceInfo = `[${idx + 1}/${totalGraphs}]`;

          if (automationRunService.shouldStop(runId)) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_ABORTED',
              `${sequenceInfo} Daily automation aborted by user`,
              undefined,
              { graphs: targetGraphNames, stoppedAt: graphName, index: idx, total: totalGraphs }
            );
            return;
          }

          sessionLogService.info(
            'session',
            'DAILY_RETRIEVE_ALL_GRAPH_START',
            `${sequenceInfo} Starting: ${graphName}`,
            undefined,
            { graph: graphName, index: idx, total: totalGraphs }
          );

          const graphFileId = `graph-${graphName}`;
          const graphItem: RepositoryItem = {
            id: graphName,
            name: graphName,
            type: 'graph',
            path: `graphs/${graphName}.json`,
          };

          // Ensure the graph is open (so it gets loaded into the registry).
          const existingTab = latestTabsRef.current.find((t) => t.fileId === graphFileId);
          if (!existingTab) {
            await latestTabOpsRef.current.openTab(graphItem, 'interactive', false);
          }

          // Keep Session Log in view after tab operations.
          if (logTabId) reassertTabFocus(logTabId, [0, 50, 200, 750]);

          const loaded = await waitForGraphData(
            graphFileId,
            60_000,
            250,
            () => automationRunService.shouldStop(runId)
          );
          if (!loaded) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_SKIPPED',
              `${sequenceInfo} Daily automation skipped graph: graph did not load in time`,
              undefined,
              { graph: graphName, fileId: graphFileId, index: idx, total: totalGraphs }
            );
            continue;
          }

          await dailyRetrieveAllAutomationService.run({
            repository: repoFinal,
            branch: branchFinal,
            graphFileId,
            getGraph: () => (fileRegistry.getFile(graphFileId) as any)?.data || null,
            setGraph: (g) => latestTabOpsRef.current.updateTabData(graphFileId, g),
            shouldAbort: () => automationRunService.shouldStop(runId),
          });

          sessionLogService.info(
            'session',
            'DAILY_RETRIEVE_ALL_GRAPH_COMPLETE',
            `${sequenceInfo} Completed: ${graphName}`,
            undefined,
            { graph: graphName, index: idx, total: totalGraphs }
          );
        }
      } catch (e) {
        // Error already logged by deeper services; keep this as a guardrail.
        console.error('[useURLDailyRetrieveAllQueue] Automation failed:', e);
      } finally {
        document.title = originalTitle;
        cleanURLParams();
        automationRunService.finish(runId);

        // ------------------------------------------------------------------
        // Persist automation run log to IDB and conditionally close window
        // ------------------------------------------------------------------
        try {
          const allEntries = sessionLogService.getEntries();
          const runEntries = allEntries.slice(logStartIndex);

          // Determine outcome by scanning for errors/warnings (including children)
          const hasEntryLevel = (level: string) =>
            runEntries.some(
              (e) =>
                e.level === level ||
                e.children?.some((c) => c.level === level)
            );

          let outcome: 'success' | 'warning' | 'error' | 'aborted';
          if (automationRunService.shouldStop(runId)) {
            outcome = 'aborted';
          } else if (hasEntryLevel('error')) {
            outcome = 'error';
          } else if (hasEntryLevel('warning')) {
            outcome = 'warning';
          } else {
            outcome = 'success';
          }

          await automationLogService.persistRunLog({
            runId,
            timestamp: waitStartedAt,
            graphs: targetGraphNames,
            outcome,
            appVersion: APP_VERSION,
            repository: repoForLog,
            branch: branchForLog,
            durationMs: Date.now() - waitStartedAt,
            entries: runEntries,
          });

          // Auto-close the browser window after automation completes.
          // Success: close quickly (10 s). Non-success: 12-hour grace period so the
          // operator can review logs, but the window still closes before the next
          // day's scheduled run fires.
          const closeDelayMs = getAutomationCloseDelayMs(outcome);
          const closeDelayLabel = outcome === 'success'
            ? '10 seconds'
            : `${Math.round(closeDelayMs / 60_000)} minutes`;

          sessionLogService.info(
            'session',
            'AUTOMATION_WINDOW_CLOSE',
            `Automation finished (${outcome}) — closing browser window in ${closeDelayLabel}`,
            'Logs have been persisted to IndexedDB. Run dagnetAutomationLogs() in the console to review past runs.'
          );

          // Wall-clock wait: browsers aggressively throttle setTimeout in
          // background tabs, so a bare `sleep(12h)` could take far longer.
          // Instead, poll every 30 s and re-check Date.now() against a fixed
          // deadline. Even if individual ticks are delayed, the next tick that
          // fires will see the deadline has passed and break out immediately.
          await sleepUntilDeadline(closeDelayMs);
          try {
            window.close();
          } catch {
            // window.close() may be blocked outside --app mode; best-effort only.
          }
        } catch (persistErr) {
          console.error('[useURLDailyRetrieveAllQueue] Failed to persist automation log:', persistErr);
        }
      }
    })();
  }, [navState.selectedRepo, navState.selectedBranch, tabOps, tabs]);
}

export function resetURLDailyRetrieveAllQueueProcessed(): void {
  urlDailyRetrieveAllQueueProcessed = false;
}

