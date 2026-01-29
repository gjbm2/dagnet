/**
 * Dev-only E2E hooks for Playwright.
 *
 * Rationale:
 * - Real browser E2E must be deterministic and must not rely on long timeouts
 *   or focus/visibility heuristics.
 * - These hooks are opt-in (query param) and do not run in production.
 *
 * IMPORTANT:
 * - This is not a public API. It is only for local/CI E2E automation.
 * - Keep surface area minimal.
 */

import { liveShareSyncService } from '../services/liveShareSyncService';
import { shareLinkService } from '../services/shareLinkService';
import { getShareBootConfig } from '../lib/shareBootResolver';
import { sessionLogService } from '../services/sessionLogService';
import { graphComputeClient } from '../lib/graphComputeClient';
import { db } from '../db/appDatabase';
import { fileRegistry } from '../contexts/TabContext';

export function installE2eHooks(): void {
  if (!import.meta.env.DEV) return;

  try {
    const url = new URL(window.location.href);
    // Always install minimal dev debug hooks (safe, tiny surface area).
    (window as any).dagnetDebug = {
      /**
       * Force a live-share "refetch from files" cycle WITHOUT reloading the page.
       *
       * This is intentionally cache-only:
       * - it does NOT fetch from external sources
       * - it simply re-triggers the in-app recompute listeners (chart tabs) so you can keep
       *   the Session Log panel open and observe the full "from-file" pipeline.
       */
      refetchFromFiles: async (label?: string) => {
        const cfg = getShareBootConfig();
        const isLive = cfg.mode === 'live' && !!cfg.repo && !!cfg.branch && !!cfg.graph;

        const markLabel = label?.trim()
          ? `refetch from files: ${label.trim()}`
          : 'refetch from files';

        // Ensure the next compute call cannot be satisfied by the in-memory cache.
        try {
          graphComputeClient.clearCache();
        } catch {
          // ignore
        }
        try {
          (window as any).__dagnetComputeNoCacheOnce = true;
        } catch {
          // ignore
        }

        // Mark in BOTH streams when console mirroring is enabled.
        try {
          (window as any).dagnetMark?.(markLabel, {
            mode: cfg.mode,
            repo: cfg.repo,
            branch: cfg.branch,
            graph: cfg.graph,
          });
        } catch {
          // ignore
        }
        sessionLogService.info('session', 'DEV_MARK', markLabel, undefined, {
          mode: cfg.mode,
          repository: cfg.repo,
          branch: cfg.branch,
          graph: cfg.graph,
        } as any);

        // Live share: trigger the share recompute listeners (chart boot hook).
        if (isLive) {
          try {
            window.dispatchEvent(
              new CustomEvent('dagnet:liveShareRefreshed', {
                detail: { repo: cfg.repo, branch: cfg.branch, graph: cfg.graph, remoteHeadSha: null, reason: 'manual_refetch_from_files', forceRecompute: true },
              })
            );
            return { success: true, mode: 'live' };
          } catch (e: any) {
            return { success: false, mode: 'live', error: e?.message || String(e) };
          }
        }

        // Workspace/static mode: trigger a dev-only "refetch-from-files" cycle for the active graph tab.
        try {
          const appState = await db.getAppState();
          const activeTabId = appState?.activeTabId || null;
          const tab = activeTabId ? await db.tabs.get(activeTabId) : null;
          const fileId = tab?.fileId || null;

          // If the active tab is a chart, try to target its parent graph (so ScenariosProvider can act).
          let graphFileId: string | null = null;
          if (typeof fileId === 'string' && fileId.startsWith('graph-')) {
            graphFileId = fileId;
          } else if (typeof fileId === 'string' && fileId.startsWith('chart-')) {
            const chartFile: any = (await db.files.get(fileId)) || null;
            const parent = chartFile?.data?.source?.parent_file_id;
            if (typeof parent === 'string' && parent.startsWith('graph-')) graphFileId = parent;
          }

          // IMPORTANT:
          // If the Session Log tab (or any non-graph tab) is active, activeTabId won't have scenarioState.
          // Prefer a real graph tab for the graphFileId so ScenariosProvider can pull visibleScenarioIds.
          const preferredTabId = (() => {
            if (typeof graphFileId === 'string' && graphFileId.startsWith('graph-')) return null;
            return null;
          })();
          const graphTab =
            (typeof graphFileId === 'string' && graphFileId.startsWith('graph-'))
              ? await db.tabs.where('fileId').equals(graphFileId).first()
              : null;
          const tabIdForScenarioState =
            (typeof graphTab?.id === 'string' && graphTab.id.trim())
              ? graphTab.id
              : (typeof activeTabId === 'string' ? activeTabId : null);

          window.dispatchEvent(
            new CustomEvent('dagnet:debugRefetchFromFiles', {
              detail: {
                reason: 'manual_refetch_from_files',
                requestedBy: 'window.dagnetDebug.refetchFromFiles',
                activeTabId: tabIdForScenarioState,
                fileId,
                graphFileId,
              },
            })
          );

          return { success: true, mode: cfg.mode, activeTabId: tabIdForScenarioState, fileId, graphFileId };
        } catch (e: any) {
          return { success: false, mode: cfg.mode, error: e?.message || String(e) };
        }
      },
    };

    // Install E2E-only hooks only when explicitly requested.
    if (!url.searchParams.has('e2e')) return;

    // Expose fileRegistry for E2E tests to seed data
    (window as any).fileRegistry = fileRegistry;

    (window as any).dagnetE2e = {
      /**
       * Select an edge by UUID (for E2E testing PropertiesPanel interactions).
       * Dispatches the proper events to update React state and show edge properties.
       */
      selectEdge: (edgeUuid: string) => {
        window.dispatchEvent(new CustomEvent('dagnet:e2e:selectEdge', { detail: { edgeUuid } }));
        return { success: true, edgeUuid };
      },
      /**
       * Select a node by UUID (for E2E testing PropertiesPanel interactions).
       */
      selectNode: (nodeUuid: string) => {
        window.dispatchEvent(new CustomEvent('dagnet:e2e:selectNode', { detail: { nodeUuid } }));
        return { success: true, nodeUuid };
      },
      /**
       * Clear selection (for E2E testing).
       */
      clearSelection: () => {
        window.dispatchEvent(new CustomEvent('dagnet:e2e:clearSelection'));
        return { success: true };
      },
      /**
       * Trigger share-live refresh immediately (no countdown / no modal).
       * This exercises the real refresh pipeline:
       * - minimal fetch
       * - overwrite seed
       * - dagnet:liveShareRefreshed dispatch (chart recompute listeners)
       */
      refreshLiveShareToLatest: async () => {
        return await liveShareSyncService.refreshToLatest();
      },
      /**
       * Generate a live chart share URL from an existing chart fileId.
       * Used by Playwright to exercise the real share-link generation path.
       */
      buildLiveChartShareUrlFromChartFile: async (args: { chartFileId: string; secretOverride: string; dashboardMode?: boolean }) => {
        const res = await shareLinkService.buildLiveChartShareUrlFromChartFile({
          chartFileId: args.chartFileId,
          secretOverride: args.secretOverride,
          dashboardMode: args.dashboardMode,
        });
        if (!res?.success || !res.url) return res;
        try {
          // E2E-only: inject URL creds so live share boot can proceed without env secrets.
          const u = new URL(res.url);
          u.searchParams.set(
            'creds',
            JSON.stringify({
              defaultGitRepo: 'repo-1',
              git: [
                {
                  name: 'repo-1',
                  owner: 'owner-1',
                  repo: 'repo-1',
                  token: 'test-token',
                  branch: 'main',
                  basePath: '',
                },
                {
                  name: 'repo-2',
                  owner: 'owner-1',
                  repo: 'repo-2',
                  token: 'test-token',
                  branch: 'main',
                  basePath: '',
                },
              ],
            })
          );
          return { ...res, url: u.toString() };
        } catch {
          return res;
        }
      },
      /**
       * Generate a live bundle share URL from a set of tabIds.
       * Used by Playwright to exercise the real bundle share-link generation path (including
       * scenario-state sourcing semantics).
       */
      buildLiveBundleShareUrlFromTabs: async (args: {
        tabIds: string[];
        secretOverride: string;
        dashboardMode?: boolean;
        includeScenarios?: boolean;
        activeTabId?: string;
      }) => {
        const res = await shareLinkService.buildLiveBundleShareUrlFromTabs({
          tabIds: args.tabIds,
          dashboardMode: args.dashboardMode,
          includeScenarios: args.includeScenarios,
          activeTabId: args.activeTabId,
          secretOverride: args.secretOverride,
        });
        if (!res?.success || !res.url) return res;
        try {
          // E2E-only: inject URL creds so live share boot can proceed without env secrets.
          const u = new URL(res.url);
          u.searchParams.set(
            'creds',
            JSON.stringify({
              defaultGitRepo: 'repo-1',
              git: [
                {
                  name: 'repo-1',
                  owner: 'owner-1',
                  repo: 'repo-1',
                  token: 'test-token',
                  branch: 'main',
                  basePath: '',
                },
                {
                  name: 'repo-2',
                  owner: 'owner-1',
                  repo: 'repo-2',
                  token: 'test-token',
                  branch: 'main',
                  basePath: '',
                },
              ],
            })
          );
          return { ...res, url: u.toString() };
        } catch {
          return res;
        }
      },
    };
  } catch {
    // Best-effort only.
  }
}

