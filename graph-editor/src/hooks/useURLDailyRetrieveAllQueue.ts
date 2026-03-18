/**
 * useURLDailyRetrieveAllQueue Hook
 *
 * Thin wrapper that parses URL params and triggers the daily-automation
 * scheduler job. All orchestration logic lives in dailyAutomationJob.ts.
 *
 * Supported URLs:
 * - `?retrieveall=<graph-name>` (single)
 * - `?retrieveall=<graph-a>,<graph-b>` (comma-separated)
 * - `?retrieveall=<graph-a>&retrieveall=<graph-b>` (repeated param)
 * - `?graph=<graph-name>&retrieveall` (boolean flag; single graph)
 * - `?retrieveall` (no value) — enumeration mode: all graphs with dailyFetch: true
 */

import { useEffect, useRef } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { isShareMode } from '../lib/shareBootResolver';
import { jobSchedulerService } from '../services/jobSchedulerService';
import { registerDailyAutomationJob, updateDailyAutomationContext } from '../services/dailyAutomationJob';

let urlDailyRetrieveAllQueueProcessed = false;

function parseURLParams() {
  const searchParams = new URLSearchParams(window.location.search);
  return {
    retrieveAllValues: searchParams.getAll('retrieveall'),
    hasRetrieveAllFlag: searchParams.has('retrieveall'),
    graphParam: searchParams.get('graph'),
  };
}

function normaliseGraphNames(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const parts = String(raw ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
    for (const name of parts) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function resolveTargetGraphNames(params: ReturnType<typeof parseURLParams>): string[] {
  const fromRetrieveAll = normaliseGraphNames(params.retrieveAllValues);
  if (fromRetrieveAll.length > 0) return fromRetrieveAll;
  if (params.hasRetrieveAllFlag && params.graphParam?.trim()) return [params.graphParam.trim()];
  return [];
}

export function useURLDailyRetrieveAllQueue(): void {
  const { state: navState } = useNavigatorContext();
  const { tabs, operations: tabOps } = useTabContext();

  const processedRef = useRef(false);
  const paramsRef = useRef<ReturnType<typeof parseURLParams> | null>(null);

  // Parse params on mount (before TabContext cleans them).
  useEffect(() => {
    if (!paramsRef.current) paramsRef.current = parseURLParams();
  }, []);

  // Keep automation context fresh every render.
  updateDailyAutomationContext({
    selectedRepo: navState.selectedRepo,
    selectedBranch: navState.selectedBranch,
    tabs,
    tabOps: tabOps?.openTab ? {
      openTab: tabOps.openTab,
      updateTabData: tabOps.updateTabData,
    } : null,
    fileRegistryGetFile: (fileId: string) => fileRegistry.getFile(fileId),
  });

  useEffect(() => {
    if (processedRef.current) return;
    if (urlDailyRetrieveAllQueueProcessed) {
      processedRef.current = true;
      return;
    }

    if (isShareMode()) {
      processedRef.current = true;
      return;
    }

    const params = paramsRef.current;
    if (!params?.hasRetrieveAllFlag) return;

    const explicitGraphNames = resolveTargetGraphNames(params);
    const isEnumerationMode = explicitGraphNames.length === 0;

    if (!isEnumerationMode && explicitGraphNames.length === 0) return;

    processedRef.current = true;
    urlDailyRetrieveAllQueueProcessed = true;

    // Register the job and trigger it.
    registerDailyAutomationJob();
    jobSchedulerService.run('daily-automation', {
      graphNames: explicitGraphNames,
      isEnumerationMode,
    });
  }, [navState.selectedRepo, navState.selectedBranch, tabOps, tabs]);
}

export function resetURLDailyRetrieveAllQueueProcessed(): void {
  urlDailyRetrieveAllQueueProcessed = false;
}
