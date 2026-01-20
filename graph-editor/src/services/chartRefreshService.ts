import { db } from '../db/appDatabase';
import { extractParamsFromGraph } from './GraphParamExtractor';
import { recomputeOpenChartsForGraph } from './chartRecomputeService';
import { sessionLogService } from './sessionLogService';

type RefreshResult =
  | { ok: true; mode: 'linked' | 'pinned'; updatedChartFileIds: string[]; skippedChartFileIds: string[] }
  | { ok: false; reason: string };

export async function refreshChartByFileId(args: { chartFileId: string }): Promise<RefreshResult> {
  const chartFileId = args.chartFileId;
  const opId = sessionLogService.startOperation('info', 'graph', 'CHART_REFRESH', `Refreshing chart ${chartFileId}`);

  try {
    const chartFile: any = await db.files.get(chartFileId);
    const chartData: any = chartFile?.data || null;
    if (!chartData) return { ok: false, reason: 'chart-not-found' };

    const parentFileId: string | undefined = chartData?.recipe?.parent?.parent_file_id ?? chartData?.source?.parent_file_id;
    const parentTabId: string | undefined = chartData?.recipe?.parent?.parent_tab_id ?? chartData?.source?.parent_tab_id;
    if (!parentFileId) return { ok: false, reason: 'missing-parent-graph' };

    // Linked refresh requires a resolvable parent tab (tab-scoped scenario state).
    const parentTabExists = parentTabId ? Boolean(await db.tabs.get(parentTabId)) : false;
    if (parentTabId && parentTabExists) {
      window.dispatchEvent(
        new CustomEvent('dagnet:chartRefreshRequested', { detail: { graphFileId: parentFileId, chartFileId } })
      );
      sessionLogService.endOperation(opId, 'success', 'Queued linked refresh');
      return { ok: true, mode: 'linked', updatedChartFileIds: [], skippedChartFileIds: [] };
    }

    // Pinned refresh: best-effort recompute using DB-only inputs.
    const eligible = chartData?.recipe?.pinned_recompute_eligible;
    if (eligible !== true) {
      sessionLogService.endOperation(opId, 'warning', 'Pinned refresh blocked (not eligible)');
      return { ok: false, reason: 'pinned-not-eligible' };
    }

    const graphFile: any = await db.files.get(parentFileId);
    const graph: any = graphFile?.data || null;
    if (!graph) return { ok: false, reason: 'parent-graph-not-found' };

    const baseParams = extractParamsFromGraph(graph);
    const currentParams = extractParamsFromGraph(graph);
    const scenarios: any[] = await db.scenarios.where('fileId').equals(parentFileId).toArray();

    const res = await recomputeOpenChartsForGraph({
      graphFileId: parentFileId,
      graph,
      baseParams,
      currentParams,
      scenarios,
      currentColour: '#3B82F6',
      baseColour: '#999999',
      authoritativeCurrentDsl: undefined, // pinned must not drift
    });

    // In pinned refresh we might recompute multiple open charts for the graph; report counts.
    sessionLogService.endOperation(opId, 'success', `Pinned refresh updated ${res.updatedChartFileIds.length} chart(s)`);
    return { ok: true, mode: 'pinned', ...res };
  } catch (e: any) {
    sessionLogService.endOperation(opId, 'error', e?.message || String(e));
    return { ok: false, reason: e?.message || String(e) };
  }
}






