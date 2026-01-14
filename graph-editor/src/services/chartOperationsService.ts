import { formatDateUK } from '../lib/dateFormat';
import type { AnalysisResult } from '../lib/graphComputeClient';
import type { TabState } from '../types';
import { fileRegistry } from '../contexts/TabContext';
import { sessionLogService } from './sessionLogService';

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
    try {
      const timestamp = Date.now();
      const fileId = args.fileId;
      const tabId = `tab-chart-${timestamp}`;

      const title = args.title?.trim() || 'Chart';

      await fileRegistry.addViewTab(fileId, tabId);

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


