/**
 * useURLDailyRetrieveAll Hook
 *
 * Headless daily automation trigger via URL params.
 *
 * Supported URLs:
 * - `?retrieveall=<graph-name>`: opens `graph-<graph-name>` (via TabContext) then runs pull→retrieve→commit
 * - `?graph=<graph-name>&retrieveall`: also supported (retrieveall flag is boolean)
 *
 * Design goal:
 * - No UI modals (Retrieve All modal / conflict modal) during automation runs
 * - All business logic centralised in service layer
 */

import { useEffect, useRef } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useFileRegistry, useTabContext } from '../contexts/TabContext';
import { sessionLogService } from '../services/sessionLogService';
import { dailyRetrieveAllAutomationService } from '../services/dailyRetrieveAllAutomationService';
import { automationRunService } from '../services/automationRunService';

interface URLDailyRetrieveAllParams {
  retrieveAllParam: string | null; // value from ?retrieveall=...
  hasRetrieveAllFlag: boolean; // presence of ?retrieveall (even without value)
  graphParam: string | null; // value from ?graph=...
}

let urlDailyRetrieveAllProcessed = false;

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

function parseURLDailyRetrieveAllParams(): URLDailyRetrieveAllParams {
  const searchParams = new URLSearchParams(window.location.search);
  return {
    retrieveAllParam: searchParams.get('retrieveall'),
    hasRetrieveAllFlag: searchParams.has('retrieveall'),
    graphParam: searchParams.get('graph'),
  };
}

function cleanURLDailyRetrieveAllParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('retrieveall');
  // Note: `graph` is cleaned by TabContext after it opens the file, but keep this safe.
  url.searchParams.delete('graph');
  window.history.replaceState({}, document.title, url.toString());
}

function resolveTargetGraphName(params: URLDailyRetrieveAllParams): string | null {
  // Prefer explicit `?retrieveall=<graph-name>`
  if (params.retrieveAllParam && params.retrieveAllParam.trim() !== '') return params.retrieveAllParam.trim();

  // Support boolean flag + separate `?graph=<graph-name>`
  if (params.hasRetrieveAllFlag && params.graphParam && params.graphParam.trim() !== '') return params.graphParam.trim();

  return null;
}

function inferGraphNameFromFileId(fileId: string): string {
  return fileId.startsWith('graph-') ? fileId.slice('graph-'.length) : fileId;
}

export function useURLDailyRetrieveAll(graphLoaded: boolean, fileId: string | undefined): void {
  const { state: navState } = useNavigatorContext();
  const { operations: tabOps } = useTabContext() as any;
  const fileRegistry = useFileRegistry();

  const processedRef = useRef(false);
  const paramsRef = useRef<URLDailyRetrieveAllParams | null>(null);
  const tabContextInitDoneRef = useRef(false);

  // Parse params on mount (before TabContext cleans them).
  useEffect(() => {
    if (!paramsRef.current) paramsRef.current = parseURLDailyRetrieveAllParams();
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
    if (!graphLoaded || !fileId) return;
    if (processedRef.current) return;
    if (urlDailyRetrieveAllProcessed) {
      processedRef.current = true;
      return;
    }

    const params = paramsRef.current;
    if (!params?.hasRetrieveAllFlag) return;

    const targetGraphName = resolveTargetGraphName(params);
    if (!targetGraphName) return;

    // Only run for the intended graph tab.
    const matchesExact = fileId === targetGraphName;
    const matchesPrefixed = fileId === `graph-${targetGraphName}`;
    if (!matchesExact && !matchesPrefixed) return;

    processedRef.current = true;
    urlDailyRetrieveAllProcessed = true;

    // Fire-and-forget so we don't block rendering; all visibility goes to session logs.
    void (async () => {
      const branch: string = navState.selectedBranch || 'main';
      const originalTitle = document.title;
      const setAutomationTitle = (phase: string) => {
        const prefix = `[Automation: ${phase}] `;
        document.title = originalTitle.startsWith('[Automation:') ? `${prefix}${originalTitle.replace(/^\[Automation:[^\]]+\]\s*/, '')}` : `${prefix}${originalTitle}`;
      };

      // Wait for app context to settle: repo selection, tabOps, and graph data in registry.
      // This avoids brittle "skip" behaviour on cold boot where Navigator state may not be ready yet.
      const waitStartedAt = Date.now();
      const maxWaitMs = 60_000;
      const pollMs = 250;
      let loggedWaiting = false;
      const runId = `retrieveall:${fileId}:${waitStartedAt}`;

      try {
        setAutomationTitle('starting');
        automationRunService.start({ runId, graphFileId: fileId, graphName: inferGraphNameFromFileId(fileId) });

        while (true) {
          if (automationRunService.shouldStop(runId)) {
            sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_ABORTED', 'Daily automation aborted by user (waiting phase)', undefined, { fileId });
            return;
          }

          const repository: string | undefined = navState.selectedRepo;
          const hasTabOps = !!tabOps?.updateTabData;
          const graphFile = fileRegistry.getFile(fileId) as any;
          const hasGraphData = !!(graphFile?.data && graphFile?.type === 'graph');
          const tabCtxReady = tabContextInitDoneRef.current || isTabContextInitDone();

          if (repository && hasTabOps && hasGraphData && tabCtxReady) break;

          const elapsed = Date.now() - waitStartedAt;
          if (elapsed > maxWaitMs) {
            sessionLogService.warning(
              'session',
              'DAILY_RETRIEVE_ALL_SKIPPED',
              'Daily automation skipped: app did not become ready in time',
              undefined,
              { fileId, waitedMs: elapsed, hasRepository: !!repository, hasTabOps, hasGraphData, tabCtxReady }
            );
            return;
          }

          if (!loggedWaiting) {
            loggedWaiting = true;
            sessionLogService.info(
              'session',
              'DAILY_RETRIEVE_ALL_WAITING',
              'Daily automation: waiting for app to initialise (repo selection, graph load)',
              undefined,
              { fileId, maxWaitMs, pollMs }
            );
          }

          await sleep(pollMs);
        }

        const repository: string = navState.selectedRepo as string;
        
        // Open Session Log as soon as the app is settled (before countdown) so users see *something* immediately,
        // and so the log is visible for the whole automation run.
        // Fire-and-forget: failures should never block the automation run.
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
                { fileId, remainingSeconds: remaining }
              );
              return;
            }
            automationRunService.setCountdown(runId, remaining);
            await sleep(1000);
          }
        }

        // In retrieveall mode, the session log is the primary UX for progress/diagnostics.
        // Open it *after* the app is settled (and after countdown) so it doesn't get immediately hidden by tab/layout initialisation.
        // Fire-and-forget: failures should never block the automation run.
        const logTabId = await sessionLogService.openLogTab();
        if (logTabId) {
          // Reassert focus because rc-dock can emit a layout change shortly after we open/switch tabs
          // (which can flip focus back to the graph tab).
          reassertTabFocus(logTabId, [0, 50, 200, 750]);
        }

        setAutomationTitle('running');
        automationRunService.setPhase(runId, 'running');

        await dailyRetrieveAllAutomationService.run({
          repository,
          branch,
          graphFileId: fileId,
          getGraph: () => (fileRegistry.getFile(fileId) as any)?.data || null,
          setGraph: (g) => tabOps.updateTabData(fileId, g),
          shouldAbort: () => automationRunService.shouldStop(runId),
        });
      } catch (e) {
        // Error already logged by service; keep this as a guardrail.
        console.error('[useURLDailyRetrieveAll] Automation failed:', e);
      } finally {
        document.title = originalTitle;
        cleanURLDailyRetrieveAllParams();
        automationRunService.finish(runId);
      }
    })();
  }, [graphLoaded, fileId, navState.selectedRepo, navState.selectedBranch, tabOps, fileRegistry]);
}

export function resetURLDailyRetrieveAllProcessed(): void {
  urlDailyRetrieveAllProcessed = false;
}


