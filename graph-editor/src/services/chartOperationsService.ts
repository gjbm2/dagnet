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

async function deriveScenarioDslFromDb(args: {
  analysisResult: AnalysisResult;
  parentFileId?: string;
}): Promise<Record<string, string>> {
  const parentFileId = args.parentFileId;
  if (!parentFileId) return {};

  const result: Record<string, string> = {};
  const analysis: any = args.analysisResult as any;
  const idsFromMetadata = [
    analysis?.metadata?.scenario_a?.scenario_id,
    analysis?.metadata?.scenario_b?.scenario_id,
  ].filter((x: any) => typeof x === 'string' && x.trim()) as string[];

  if (idsFromMetadata.length === 0) return {};

  try {
    // Prefer canonical fileId; if graph source implies a prefixed variant, also try that.
    const parentGraph: any = fileRegistry.getFile(parentFileId) || (await db.files.get(parentFileId));
    const repo = parentGraph?.source?.repository;
    const branch = parentGraph?.source?.branch;

    const canonical = await db.scenarios.where('fileId').equals(parentFileId).toArray();
    const prefixed =
      typeof repo === 'string' && typeof branch === 'string'
        ? await db.scenarios.where('fileId').equals(`${repo}-${branch}-${parentFileId}`).toArray()
        : [];
    const all = [...prefixed, ...canonical];
    const byId = new Map(all.map((s: any) => [String(s?.id), s]));

    for (const id of idsFromMetadata) {
      const s: any = byId.get(id);
      const isLive = Boolean(s?.meta?.isLive);
      const dsl: string | undefined = (s?.meta?.lastEffectiveDSL as string | undefined) || (s?.meta?.queryDSL as string | undefined);
      if (isLive && typeof dsl === 'string' && dsl.trim()) {
        result[id] = dsl.trim();
      }
    }
  } catch {
    // Best-effort only; if DB is unavailable, we just won't inject DSL.
    return {};
  }

  return result;
}

function injectScenarioDslIntoAnalysisResult(args: {
  analysisResult: AnalysisResult;
  scenarioDslSubtitleById?: Record<string, string>;
}): AnalysisResult {
  const { analysisResult, scenarioDslSubtitleById } = args;
  if (!scenarioDslSubtitleById || Object.keys(scenarioDslSubtitleById).length === 0) return analysisResult;

  // AnalysisResult is JSON-shaped; deep-clone to avoid mutating shared cached objects.
  const cloned: any = JSON.parse(JSON.stringify(analysisResult));
  const dslById = scenarioDslSubtitleById;

  // 1) Attach DSL to dimension_values.scenario_id (covers funnel-style results).
  if (!cloned.dimension_values) cloned.dimension_values = {};
  if (!cloned.dimension_values.scenario_id) cloned.dimension_values.scenario_id = {};
  for (const [scenarioId, dsl] of Object.entries(dslById)) {
    if (typeof dsl !== 'string' || !dsl.trim()) continue;
    if (!cloned.dimension_values.scenario_id[scenarioId]) cloned.dimension_values.scenario_id[scenarioId] = {};
    cloned.dimension_values.scenario_id[scenarioId].dsl = dsl;
  }

  // 2) Attach DSL to bridge-style metadata scenario_a / scenario_b when present.
  const meta = cloned.metadata || {};
  const a = meta.scenario_a;
  const b = meta.scenario_b;
  if (a?.scenario_id && typeof dslById[a.scenario_id] === 'string') {
    a.dsl = dslById[a.scenario_id];
  }
  if (b?.scenario_id && typeof dslById[b.scenario_id] === 'string') {
    b.dsl = dslById[b.scenario_id];
  }
  cloned.metadata = meta;

  return cloned as AnalysisResult;
}

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

      const derivedDslById = await deriveScenarioDslFromDb({
        analysisResult: args.analysisResult,
        parentFileId: args.source?.parent_file_id,
      });
      const scenarioDslSubtitleById: Record<string, string> | undefined = (() => {
        const passed = args.scenarioDslSubtitleById || {};
        const merged = { ...derivedDslById, ...passed };
        return Object.keys(merged).length > 0 ? merged : undefined;
      })();

      const analysisResultWithDsl = injectScenarioDslIntoAnalysisResult({
        analysisResult: args.analysisResult,
        scenarioDslSubtitleById,
      });

      const chartData: ChartFileDataV1 = {
        version: '1.0.0',
        chart_kind: args.chartKind,
        title,
        created_at_uk: formatDateUK(new Date(timestamp)),
        created_at_ms: timestamp,
        source: args.source,
        payload: {
          analysis_result: analysisResultWithDsl,
          scenario_ids: args.scenarioIds,
          scenario_dsl_subtitle_by_id: scenarioDslSubtitleById,
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


