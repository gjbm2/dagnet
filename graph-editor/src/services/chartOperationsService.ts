import { formatDateUK } from '../lib/dateFormat';
import type { AnalysisResult } from '../lib/graphComputeClient';
import type { TabState } from '../types';
import { fileRegistry } from '../contexts/TabContext';
import { sessionLogService } from './sessionLogService';
import { db } from '../db/appDatabase';

export type ChartKind = 'analysis_funnel' | 'analysis_bridge';

type ChartFileDataV1 = {
  version: '1.0.0';
  chart_kind: ChartKind;
  title: string;
  created_at_uk: string;
  created_at_ms: number;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  payload: {
    analysis_result: AnalysisResult;
    scenario_ids: string[];
    scenario_dsl_subtitle_by_id?: Record<string, string>;
  };
};

class ChartOperationsService {
  async openAnalysisChartTabFromAnalysis(args: {
    chartKind: ChartKind;
    analysisResult: AnalysisResult;
    scenarioIds: string[];
    title?: string;
    source?: ChartFileDataV1['source'];
    scenarioDslSubtitleById?: Record<string, string>;
    /** Optional: override the chart fileId (for share-scoped cached chart artefacts). */
    fileId?: string;
  }): Promise<{ fileId: string; tabId: string } | null> {
    if (args.fileId) {
      const stableFileId = args.fileId;
      const inFlight = this.inFlightOpenByFileId.get(stableFileId);
      if (inFlight) return await inFlight;

      const p = this.openAnalysisChartTabFromAnalysisImpl(args).finally(() => {
        this.inFlightOpenByFileId.delete(stableFileId);
      });
      this.inFlightOpenByFileId.set(stableFileId, p);

      const res = await p;
      if (res?.tabId) this.lastKnownTabIdByFileId.set(stableFileId, res.tabId);
      return res;
    }

    return await this.openAnalysisChartTabFromAnalysisImpl(args);
  }

  /**
   * In-memory guard against duplicate chart tab opens for stable fileIds (share/live).
   *
   * Why this exists:
   * - Share/live uses a stable chart fileId.
   * - In dev/StrictMode or rapid refresh triggers, the open flow can be invoked twice.
   * - The persisted `db.tabs` entry can lag behind the `dagnet:openTemporaryTab` event processing,
   *   so a naive "check db.tabs first" can race and open duplicates.
   */
  private inFlightOpenByFileId = new Map<string, Promise<{ fileId: string; tabId: string } | null>>();
  private lastKnownTabIdByFileId = new Map<string, string>();

  private async openAnalysisChartTabFromAnalysisImpl(args: {
    chartKind: ChartKind;
    analysisResult: AnalysisResult;
    scenarioIds: string[];
    title?: string;
    source?: ChartFileDataV1['source'];
    scenarioDslSubtitleById?: Record<string, string>;
    fileId?: string;
  }): Promise<{ fileId: string; tabId: string } | null> {
    try {
      const timestamp = Date.now();
      const fileId = args.fileId || `chart-${timestamp}`;
      const tabId = `tab-chart-${timestamp}`;

      const title = args.title?.trim() || args.analysisResult.analysis_name || 'Chart';

      sessionLogService.info(
        'session',
        'CHART_OPEN',
        `Opening chart tab: ${title}`,
        undefined,
        { fileId, tabId, chartKind: args.chartKind }
      );

      const chartData: ChartFileDataV1 = {
        version: '1.0.0',
        chart_kind: args.chartKind,
        title,
        created_at_uk: formatDateUK(new Date(timestamp)),
        created_at_ms: timestamp,
        source: args.source,
        payload: {
          analysis_result: args.analysisResult,
          scenario_ids: args.scenarioIds,
          scenario_dsl_subtitle_by_id: args.scenarioDslSubtitleById,
        },
      };

      // Stable fileId path: if we already observed an open tab for this chart in this session,
      // update it in place and focus it (avoids races where db.tabs hasn't persisted yet).
      if (args.fileId) {
        const knownTabId = this.lastKnownTabIdByFileId.get(fileId);
        if (knownTabId) {
          await (fileRegistry as any).upsertFileClean(
            fileId,
            'chart' as any,
            { repository: 'local', branch: 'main', path: `charts/${fileId}.json` },
            chartData
          );
          window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: knownTabId } }));
          return { fileId, tabId: knownTabId };
        }
      }

      // Share/live recompute uses a stable fileId. If that chart is already open, update in place
      // and focus the existing tab rather than opening duplicates.
      if (args.fileId) {
        // Prefer IndexedDB as the source of truth for whether a tab exists (FileRegistry viewTabs can be stale).
        const existingTab = await db.tabs.where('fileId').equals(fileId).first();
        const existingTabId = existingTab?.id || null;
        if (existingTabId) {
          sessionLogService.info(
            'session',
            'CHART_OPEN',
            `Updating chart tab in place: ${title}`,
            undefined,
            { fileId, tabId: existingTabId, chartKind: args.chartKind }
          );
          await (fileRegistry as any).upsertFileClean(
            fileId,
            'chart' as any,
            { repository: 'local', branch: 'main', path: `charts/${fileId}.json` },
            chartData
          );
          window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: existingTabId } }));
          this.lastKnownTabIdByFileId.set(fileId, existingTabId);
          return { fileId, tabId: existingTabId };
        }
      }
      
      sessionLogService.info(
        'session',
        'CHART_OPEN',
        `Opening chart tab: ${title}`,
        undefined,
        { fileId, tabId, chartKind: args.chartKind }
      );

      // Charts are derived/cached artefacts. Always seed/update them as "clean" data.
      await (fileRegistry as any).upsertFileClean(
        fileId,
        'chart' as any,
        { repository: 'local', branch: 'main', path: `charts/${fileId}.json` },
        chartData
      );

      const newTab: TabState = {
        id: tabId,
        fileId,
        viewMode: 'interactive',
        title,
        icon: '',
        closable: true,
        group: 'main-content',
      };

      await fileRegistry.addViewTab(fileId, tabId);
      if (args.fileId) this.lastKnownTabIdByFileId.set(fileId, tabId);

      window.dispatchEvent(
        new CustomEvent('dagnet:openTemporaryTab', {
          detail: { tab: newTab },
        })
      );

      sessionLogService.success(
        'session',
        'CHART_OPEN_SUCCESS',
        `Opened chart tab: ${title}`,
        undefined,
        { fileId, tabId, chartKind: args.chartKind }
      );

      return { fileId, tabId };
    } catch (error: any) {
      sessionLogService.error(
        'session',
        'CHART_OPEN_ERROR',
        `Failed to open chart tab: ${error?.message || String(error)}`,
        undefined
      );
      return null;
    }
  }

  async openExistingChartTab(args: { fileId: string; title?: string }): Promise<{ fileId: string; tabId: string } | null> {
    const stableFileId = args.fileId;
    const inFlight = this.inFlightOpenByFileId.get(stableFileId);
    if (inFlight) return await inFlight;

    try {
      const timestamp = Date.now();
      const fileId = args.fileId;
      const tabId = `tab-chart-${timestamp}`;

      const title = args.title?.trim() || 'Chart';

      // Prefer focusing an already-open chart tab if we know about it.
      const knownTabId = this.lastKnownTabIdByFileId.get(fileId);
      if (knownTabId) {
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: knownTabId } }));
        return { fileId, tabId: knownTabId };
      }

      await fileRegistry.addViewTab(fileId, tabId);
      this.lastKnownTabIdByFileId.set(fileId, tabId);

      const newTab: TabState = {
        id: tabId,
        fileId,
        viewMode: 'interactive',
        title,
        icon: '',
        closable: true,
        group: 'main-content',
      };

      window.dispatchEvent(
        new CustomEvent('dagnet:openTemporaryTab', {
          detail: { tab: newTab },
        })
      );

      return { fileId, tabId };
    } catch {
      return null;
    }
  }
}

export const chartOperationsService = new ChartOperationsService();


