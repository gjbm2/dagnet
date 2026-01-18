import { formatDateUK } from '../lib/dateFormat';
import type { AnalysisResult } from '../lib/graphComputeClient';
import type { TabState } from '../types';
import { fileRegistry } from '../contexts/TabContext';
import { sessionLogService } from './sessionLogService';
import { db } from '../db/appDatabase';
import type { ChartDepsStampV1, ChartVisibilityMode } from '../lib/chartDeps';
import { chartDepsSignatureV1 } from '../lib/chartDeps';
import { dslDependsOnReferenceDay } from '../lib/dslDynamics';
import { ukReferenceDayService } from './ukReferenceDayService';
import { computeGraphInputsSignatureV1 } from './graphInputSignatureService';

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
  recipe: {
    parent?: {
      parent_file_id?: string;
      parent_tab_id?: string;
    };
    analysis?: {
      analysis_type?: string;
      query_dsl?: string;
      what_if_dsl?: string;
    };
    /**
     * Ordered list of scenarios that participate in the compute.
     * Includes `current` / `base` when they participate.
     */
    scenarios: Array<{
      scenario_id: string;
      name?: string;
      colour?: string;
      visibility_mode?: ChartVisibilityMode;
      effective_dsl?: string;
      is_live?: boolean;
    }>;
    display?: {
      hide_current?: boolean;
    };
    pinned_recompute_eligible: boolean;
  };
  deps: ChartDepsStampV1;
  deps_signature: string;
  payload: {
    analysis_result: AnalysisResult;
    scenario_ids: string[];
  };
};

async function deriveScenarioDslFromDb(args: {
  scenarioIds: string[];
  parentFileId?: string;
}): Promise<Record<string, string>> {
  const parentFileId = args.parentFileId;
  if (!parentFileId) return {};

  const result: Record<string, string> = {};
  const ids = (Array.isArray(args.scenarioIds) ? args.scenarioIds : []).filter(Boolean);
  if (ids.length === 0) return {};

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

    for (const id of ids) {
      const s: any = byId.get(id);
      const isLive = Boolean(s?.meta?.isLive);
      const dsl: string | undefined = (s?.meta?.lastEffectiveDSL as string | undefined) || (s?.meta?.queryDSL as string | undefined);
      if (isLive && typeof dsl === 'string' && dsl.trim()) {
        result[id] = dsl.trim();
      }
    }
  } catch {
    // Best-effort only; if DB is unavailable, we just won't derive DSL.
    return {};
  }

  return result;
}

function inferScenarioIdsForRecipe(args: { analysisResult: AnalysisResult; scenarioIds: string[] }): string[] {
  const provided = Array.isArray(args.scenarioIds) ? args.scenarioIds.filter(Boolean) : [];
  if (provided.length > 0) return provided;

  const analysis: any = args.analysisResult as any;
  const a = analysis?.metadata?.scenario_a?.scenario_id;
  const b = analysis?.metadata?.scenario_b?.scenario_id;
  const ids: string[] = [];
  if (typeof a === 'string' && a.trim()) ids.push(a.trim());
  if (typeof b === 'string' && b.trim() && b.trim() !== a?.trim()) ids.push(b.trim());
  return ids;
}

class ChartOperationsService {
  async disconnectChart(args: { chartFileId: string }): Promise<void> {
    const chartFileId = args.chartFileId;
    const opId = sessionLogService.startOperation('info', 'graph', 'CHART_DISCONNECT', `Disconnecting chart ${chartFileId}`);
    try {
      const existing: any = await db.files.get(chartFileId);
      const existingData: any = existing?.data || null;
      if (!existingData) {
        sessionLogService.endOperation(opId, 'warning', 'Chart not found');
        return;
      }

      const recipe = existingData?.recipe || {};
      const source = existingData?.source || {};

      const nextRecipe = {
        ...recipe,
        parent: {
          ...(recipe.parent || {}),
          parent_tab_id: undefined,
        },
      };

      const nextSource = {
        ...source,
        parent_tab_id: undefined,
      };

      const nextDeps: ChartDepsStampV1 = {
        ...(existingData.deps as ChartDepsStampV1),
        mode: 'pinned',
        parent: {
          ...(existingData?.deps?.parent || {}),
          parent_tab_id: undefined,
        },
      };
      const deps_signature = chartDepsSignatureV1(nextDeps);

      const nextData = {
        ...existingData,
        source: nextSource,
        recipe: nextRecipe,
        deps: nextDeps,
        deps_signature,
      };

      // Persist via fileRegistry to keep tab state consistent (update-in-place).
      await (fileRegistry as any).upsertFileClean(
        chartFileId,
        'chart' as any,
        existing?.source || { repository: 'local', branch: 'main', path: `charts/${chartFileId}.json` },
        nextData
      );

      sessionLogService.endOperation(opId, 'success', 'Chart disconnected (pinned)');
    } catch (e: any) {
      sessionLogService.endOperation(opId, 'error', e?.message || String(e));
    }
  }
  async openAnalysisChartTabFromAnalysis(args: {
    chartKind: ChartKind;
    analysisResult: AnalysisResult;
    scenarioIds: string[];
    title?: string;
    source?: ChartFileDataV1['source'];
    scenarioDslSubtitleById?: Record<string, string>;
    hideCurrent?: boolean;
    whatIfDsl?: string;
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
    hideCurrent?: boolean;
    whatIfDsl?: string;
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

      const recipeScenarioIds = inferScenarioIdsForRecipe({ analysisResult: args.analysisResult, scenarioIds: args.scenarioIds });

      const derivedDslById = await deriveScenarioDslFromDb({
        scenarioIds: recipeScenarioIds,
        parentFileId: args.source?.parent_file_id,
      });
      const dslById: Record<string, string> = { ...(derivedDslById || {}), ...(args.scenarioDslSubtitleById || {}) };

      const analysis: any = args.analysisResult as any;
      const meta: any = analysis?.metadata || {};
      const metaA: any = meta?.scenario_a || null;
      const metaB: any = meta?.scenario_b || null;

      const recipeScenarios = await Promise.all(
        recipeScenarioIds.map(async (scenarioId: string) => {
          const scenarioMeta = metaA?.scenario_id === scenarioId ? metaA : metaB?.scenario_id === scenarioId ? metaB : null;

          // Best-effort load of scenario record for name/colour/isLive.
          const scenarioRecord: any = (() => {
            try {
              return db.scenarios.get(scenarioId) as any;
            } catch {
              return null;
            }
          })();

          const s = await scenarioRecord;
          const isLive = scenarioId === 'current' || scenarioId === 'base' ? true : Boolean(s?.meta?.isLive);
          const effectiveDsl = dslById[scenarioId];

          const name =
            typeof scenarioMeta?.name === 'string' && scenarioMeta.name.trim()
              ? scenarioMeta.name.trim()
              : scenarioId === 'current'
                ? 'Current'
                : scenarioId === 'base'
                  ? 'Base'
                  : typeof s?.name === 'string'
                    ? s.name
                    : scenarioId;

          const colour =
            typeof scenarioMeta?.colour === 'string' && scenarioMeta.colour.trim()
              ? scenarioMeta.colour.trim()
              : scenarioId === 'current'
                ? '#3B82F6'
                : scenarioId === 'base'
                  ? '#999999'
                  : typeof s?.colour === 'string'
                    ? s.colour
                    : undefined;

          const visibilityMode: ChartVisibilityMode | undefined =
            (scenarioMeta?.visibility_mode as ChartVisibilityMode | undefined) || 'f+e';

          return {
            scenario_id: scenarioId,
            name,
            colour,
            visibility_mode: visibilityMode,
            effective_dsl: typeof effectiveDsl === 'string' && effectiveDsl.trim() ? effectiveDsl.trim() : undefined,
            is_live: isLive,
          };
        })
      );

      const pinnedRecomputeEligible = recipeScenarios.every(s => {
        const id = s.scenario_id;
        if (id === 'current' || id === 'base') return true;
        if (s.is_live !== true) return false;
        return typeof s.effective_dsl === 'string' && s.effective_dsl.trim().length > 0;
      });

      const reference_day_uk =
        recipeScenarios.some(s => dslDependsOnReferenceDay(s.effective_dsl))
          ? ukReferenceDayService.getReferenceDayUK()
          : undefined;

      const inputs_signature = await (async () => {
        try {
          const parentFileId = args.source?.parent_file_id;
          if (!parentFileId) return undefined;
          const graphFile: any = await db.files.get(parentFileId);
          const graph: any = graphFile?.data || null;
          if (!graph) return undefined;
          const dsls = recipeScenarios.map(s => (typeof s?.effective_dsl === 'string' ? s.effective_dsl : '')).filter(Boolean);
          return await computeGraphInputsSignatureV1({ graphFileId: parentFileId, graph, scenarioEffectiveDsls: dsls });
        } catch {
          return undefined;
        }
      })();

      const recipe = {
        parent: {
          parent_file_id: args.source?.parent_file_id,
          parent_tab_id: args.source?.parent_tab_id,
        },
        analysis: {
          analysis_type: args.source?.analysis_type || (args.analysisResult as any)?.analysis_type,
          query_dsl: args.source?.query_dsl,
          what_if_dsl: typeof args.whatIfDsl === 'string' && args.whatIfDsl.trim() ? args.whatIfDsl.trim() : undefined,
        },
        scenarios: recipeScenarios,
        display: typeof args.hideCurrent === 'boolean' ? { hide_current: args.hideCurrent } : undefined,
        pinned_recompute_eligible: pinnedRecomputeEligible,
      } satisfies ChartFileDataV1['recipe'];

      const deps: ChartDepsStampV1 = {
        v: 1,
        mode: args.source?.parent_tab_id ? 'linked' : 'pinned',
        chart_kind: args.chartKind,
        parent: {
          parent_file_id: args.source?.parent_file_id,
          parent_tab_id: args.source?.parent_tab_id,
        },
        analysis: {
          analysis_type: recipe.analysis?.analysis_type,
          query_dsl: recipe.analysis?.query_dsl,
          what_if_dsl: recipe.analysis?.what_if_dsl,
        },
        scenarios: recipe.scenarios.map(s => ({
          scenario_id: s.scenario_id,
          effective_dsl: s.effective_dsl,
          visibility_mode: s.visibility_mode,
          is_live: s.is_live,
        })),
        inputs_signature,
        reference_day_uk,
      };
      const deps_signature = chartDepsSignatureV1(deps);

      const chartData: ChartFileDataV1 = {
        version: '1.0.0',
        chart_kind: args.chartKind,
        title,
        created_at_uk: formatDateUK(new Date(timestamp)),
        created_at_ms: timestamp,
        source: args.source,
        recipe,
        deps,
        deps_signature,
        payload: {
          analysis_result: args.analysisResult,
          scenario_ids: recipeScenarioIds,
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


