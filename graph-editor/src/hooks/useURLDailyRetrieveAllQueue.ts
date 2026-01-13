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
 *
 * Behaviour:
 * - Opens/loads each graph tab (if needed) then runs pull → retrieve → commit sequentially.
 * - Keeps Session Log as the primary UX for progress/diagnostics.
 * - Cleans URL params once after the whole queue completes.
 */

import { useEffect, useRef } from 'react';
import type { RepositoryItem } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { fileRegistry, useTabContext } from '../contexts/TabContext';
import { sessionLogService } from '../services/sessionLogService';
import { dailyRetrieveAllAutomationService } from '../services/dailyRetrieveAllAutomationService';
import { automationRunService } from '../services/automationRunService';
import { isShareMode } from '../lib/shareBootResolver';

interface URLDailyRetrieveAllQueueParams {
  retrieveAllValues: string[]; // raw values from ?retrieveall=... (can be empty strings)
  hasRetrieveAllFlag: boolean; // presence of ?retrieveall (even without value)
  graphParam: string | null; // value from ?graph=...
}

let urlDailyRetrieveAllQueueProcessed = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getURLDailyRetrieveAllStartDelayMs(): number {
  // Vitest should not spend 30 seconds waiting (and the "settling" problem is a real-app concern).
  if ((import.meta as any).env?.MODE === 'test') return 0;
  return 30_000;
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

    const targetGraphNames = resolveTargetGraphNames(params);
    if (targetGraphNames.length === 0) return;

    processedRef.current = true;
    urlDailyRetrieveAllQueueProcessed = true;

    void (async () => {
      const repository: string | undefined = navState.selectedRepo;
      const branch: string = navState.selectedBranch || 'main';
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
      const runId = `retrieveall-queue:${targetGraphNames.join(',')}:${waitStartedAt}`;

      try {
        setAutomationTitle('starting');
        automationRunService.start({
          runId,
          graphFileId: `graph-${targetGraphNames[0]}`,
          graphName: targetGraphNames[0],
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

          const repo = navState.selectedRepo;
          const hasTabOps = !!tabOps?.openTab;
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

        const repoFinal: string = navState.selectedRepo as string;

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
          for (let remaining = totalSeconds; remaining > 0; remaining--) {
            if (automationRunService.shouldStop(runId)) {
              sessionLogService.warning(
                'session',
                'DAILY_RETRIEVE_ALL_ABORTED',
                'Daily automation aborted by user (countdown phase)',
                undefined,
                { graphs: targetGraphNames, remainingSeconds: remaining }
              );
              return;
            }
            automationRunService.setCountdown(runId, remaining);
            await sleep(1000);
          }
        }

        // Open Session Log after countdown too (rc-dock can steal focus). Best-effort.
        const logTabId = await sessionLogService.openLogTab();
        if (logTabId) {
          reassertTabFocus(logTabId, [0, 50, 200, 750]);
        }

        setAutomationTitle('running');
        automationRunService.setPhase(runId, 'running');

        for (const graphName of targetGraphNames) {
          if (automationRunService.shouldStop(runId)) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_ABORTED',
              'Daily automation aborted by user',
              undefined,
              { graphs: targetGraphNames, stoppedAt: graphName }
            );
            return;
          }

          const graphFileId = `graph-${graphName}`;
          const graphItem: RepositoryItem = {
            id: graphName,
            name: graphName,
            type: 'graph',
            path: `graphs/${graphName}.json`,
          };

          // Ensure the graph is open (so it gets loaded into the registry).
          const existingTab = tabs.find((t) => t.fileId === graphFileId);
          if (!existingTab) {
            await tabOps.openTab(graphItem, 'interactive', false);
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
              'Daily automation skipped graph: graph did not load in time',
              undefined,
              { graph: graphName, fileId: graphFileId }
            );
            continue;
          }

          await dailyRetrieveAllAutomationService.run({
            repository: repoFinal,
            branch,
            graphFileId,
            getGraph: () => (fileRegistry.getFile(graphFileId) as any)?.data || null,
            setGraph: (g) => tabOps.updateTabData(graphFileId, g),
            shouldAbort: () => automationRunService.shouldStop(runId),
          });
        }
      } catch (e) {
        // Error already logged by deeper services; keep this as a guardrail.
        console.error('[useURLDailyRetrieveAllQueue] Automation failed:', e);
      } finally {
        document.title = originalTitle;
        cleanURLParams();
        automationRunService.finish(runId);
      }
    })();
  }, [navState.selectedRepo, navState.selectedBranch, tabOps, tabs]);
}

export function resetURLDailyRetrieveAllQueueProcessed(): void {
  urlDailyRetrieveAllQueueProcessed = false;
}

