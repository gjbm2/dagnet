import { db } from '../db/appDatabase';
import { graphComputeClient } from '../lib/graphComputeClient';
import { buildGraphForAnalysisLayer } from './CompositionService';
import { chartOperationsService } from './chartOperationsService';
import { isChartStaleV1, type ChartDepsStampV1, type ChartVisibilityMode } from '../lib/chartDeps';
import { dslDependsOnReferenceDay } from '../lib/dslDynamics';
import { ukReferenceDayService } from './ukReferenceDayService';
import { chartDepsSignatureV1 } from '../lib/chartDeps';
import { computeGraphInputsSignatureV1 } from './graphInputSignatureService';

type AnyScenario = {
  id: string;
  name?: string;
  colour?: string;
  meta?: { isLive?: boolean };
};

type RecomputeOpenChartsForGraphArgs = {
  graphFileId: string;
  graph: any;
  baseParams: any;
  currentParams: any;
  scenarios: AnyScenario[];
  currentColour?: string;
  baseColour?: string;
  authoritativeCurrentDsl?: string;
};

async function deriveCurrentDepsStamp(args: {
  chartData: any;
  authoritativeCurrentDsl?: string;
  graph?: any;
}): Promise<ChartDepsStampV1 | null> {
  const chartData = args.chartData;
  const chartKind = chartData?.chart_kind;
  if (chartKind !== 'analysis_funnel' && chartKind !== 'analysis_bridge' && chartKind !== 'analysis_daily_conversions' && chartKind !== 'analysis_cohort_maturity') return null;

  const parent_file_id: string | undefined = chartData?.recipe?.parent?.parent_file_id ?? chartData?.source?.parent_file_id;
  const parent_tab_id: string | undefined = chartData?.recipe?.parent?.parent_tab_id ?? chartData?.source?.parent_tab_id;

  const analysis_type: string | undefined =
    chartData?.recipe?.analysis?.analysis_type ||
    chartData?.source?.analysis_type ||
    chartData?.payload?.analysis_result?.analysis_type ||
    undefined;
  const query_dsl: string | undefined = chartData?.recipe?.analysis?.query_dsl || chartData?.source?.query_dsl || undefined;
  const what_if_dsl: string | undefined = chartData?.recipe?.analysis?.what_if_dsl || undefined;

  const recipeScenarios: any[] = Array.isArray(chartData?.recipe?.scenarios) ? chartData.recipe.scenarios : [];
  const recipeScenarioIds: string[] = recipeScenarios.map(s => String(s?.scenario_id || '')).filter((x: string) => x.trim());
  if (recipeScenarioIds.length === 0) return null;

  // Linked charts are tab-scoped. Only treat as linked when the specific parent tab is resolvable.
  // If the tab is missing (closed), treat as orphaned and fall back to pinned semantics.
  let orderedScenarioIds = recipeScenarioIds;
  let visibilityModeByScenarioId: Record<string, ChartVisibilityMode> | null = null;
  let parentTabResolved = false;

  if (parent_tab_id) {
    try {
      const parentTab: any = await db.tabs.get(parent_tab_id);
      parentTabResolved = Boolean(parentTab);
      const state: any = parentTab?.editorState?.scenarioState || null;
      const visible: string[] = Array.isArray(state?.visibleScenarioIds) ? state.visibleScenarioIds : [];
      const vm: any = state?.visibilityMode || null;
      visibilityModeByScenarioId = vm && typeof vm === 'object' ? (vm as any) : null;

      if (visible.length > 0) {
        const pos = new Map<string, number>();
        for (let i = 0; i < visible.length; i++) pos.set(String(visible[i]), i);
        orderedScenarioIds = [...recipeScenarioIds].sort((a, b) => {
          const ia = pos.has(a) ? (pos.get(a) as number) : Number.MAX_SAFE_INTEGER;
          const ib = pos.has(b) ? (pos.get(b) as number) : Number.MAX_SAFE_INTEGER;
          if (ia !== ib) return ia - ib;
          return 0;
        });
      }
    } catch {
      // best-effort only
    }
  }

  // Ordering semantics:
  // - We allow linked charts to follow the parent tab’s scenario order (tab-scoped view state).
  // - HOWEVER: some analyses have intrinsic ordering semantics that must be preserved regardless of
  //   tab ordering. We already apply this during share materialisation; refresh must match.
  //   In particular: bridge_view requires "Current last" (scenario_a = explicit, scenario_b = Current).
  if (analysis_type === 'bridge_view' && orderedScenarioIds.includes('current')) {
    orderedScenarioIds = [...orderedScenarioIds.filter(x => x !== 'current'), 'current'];
  }

  const mode = parent_tab_id && parentTabResolved ? 'linked' : 'pinned';

  const scenarios = orderedScenarioIds.map((sid: string) => {
    const def = recipeScenarios.find(s => s?.scenario_id === sid) || null;
    const visibility_mode: ChartVisibilityMode | undefined =
      (visibilityModeByScenarioId && typeof (visibilityModeByScenarioId as any)[sid] === 'string'
        ? (visibilityModeByScenarioId as any)[sid]
        : undefined) ||
      (def?.visibility_mode as any) ||
      'f+e';
    // Current handling:
    // - linked mode: use authoritative current DSL from GraphStore when available
    // - pinned mode: do NOT drift; use pinned recipe DSL only
    const effective_dsl =
      mode === 'linked' && sid === 'current' && typeof args.authoritativeCurrentDsl === 'string' && args.authoritativeCurrentDsl.trim()
        ? args.authoritativeCurrentDsl.trim()
        : (typeof def?.effective_dsl === 'string' && def.effective_dsl.trim() ? def.effective_dsl.trim() : undefined);
    const is_live = typeof def?.is_live === 'boolean' ? def.is_live : undefined;
    return { scenario_id: sid, effective_dsl, visibility_mode, is_live };
  });

  const reference_day_uk =
    scenarios.some(s => dslDependsOnReferenceDay(s.effective_dsl))
      ? ukReferenceDayService.getReferenceDayUK()
      : undefined;

  const inputs_signature = await (async () => {
    try {
      const graphFileId = parent_file_id;
      if (!graphFileId) return undefined;
      const graph = args.graph || (await db.files.get(graphFileId))?.data;
      if (!graph) return undefined;
      const dsls = scenarios.map(s => (typeof (s as any)?.effective_dsl === 'string' ? String((s as any).effective_dsl) : '')).filter(Boolean);
      return await computeGraphInputsSignatureV1({ graphFileId, graph, scenarioEffectiveDsls: dsls });
    } catch {
      return undefined;
    }
  })();

  return {
    v: 1,
    mode,
    chart_kind: chartKind,
    parent: { parent_file_id, parent_tab_id },
    analysis: { analysis_type, query_dsl, what_if_dsl },
    scenarios,
    inputs_signature,
    reference_day_uk,
  };
}

export async function recomputeOpenChartsForGraph(args: RecomputeOpenChartsForGraphArgs): Promise<{
  updatedChartFileIds: string[];
  skippedChartFileIds: string[];
  updatedDetails: Array<{ chartFileId: string; prevDepsSignature: string; nextDepsSignature: string; reason: 'stale' }>;
}> {
  const { graphFileId } = args;

  // 1) Find open chart tabs (dedup by fileId).
  const tabs = await db.tabs.toArray();
  const chartFileIds: string[] = [];
  for (const t of tabs as any[]) {
    const fileId = String(t?.fileId || '');
    if (!fileId) continue;
    try {
      const f: any = await db.files.get(fileId);
      if (f?.type === 'chart') chartFileIds.push(fileId);
    } catch {
      // ignore
    }
  }
  const uniqueChartFileIds = Array.from(new Set(chartFileIds));

  const updated: string[] = [];
  const skipped: string[] = [];
  const updatedDetails: Array<{ chartFileId: string; prevDepsSignature: string; nextDepsSignature: string; reason: 'stale' }> = [];

  for (const chartFileId of uniqueChartFileIds) {
    try {
      const chartFile: any = await db.files.get(chartFileId);
      const chartData: any = chartFile?.data || null;
      if (!chartData) {
        skipped.push(chartFileId);
        continue;
      }

      // No migration/backfill: require deps_signature and a pinned recipe if we are going to refresh.
      // Charts are derived artefacts; if they predate the recipe/signature work, they must be recreated.
      if (typeof chartData?.deps_signature !== 'string' || !chartData.deps_signature.trim()) {
        skipped.push(chartFileId);
        continue;
      }

      const parent = chartData?.recipe?.parent?.parent_file_id ?? chartData?.source?.parent_file_id;
      if (parent !== graphFileId) {
        skipped.push(chartFileId);
        continue;
      }

      const recipeScenarios: any[] = Array.isArray(chartData?.recipe?.scenarios) ? chartData.recipe.scenarios : [];
      const scenarioIdsFromRecipeOrPayload: string[] =
        recipeScenarios.length > 0
          ? recipeScenarios.map(s => String(s?.scenario_id || '')).filter((x: string) => x.trim())
          : Array.isArray(chartData?.payload?.scenario_ids)
            ? chartData.payload.scenario_ids
            : [];

      if (scenarioIdsFromRecipeOrPayload.length === 0) {
        skipped.push(chartFileId);
        continue;
      }

      const currentStamp = await deriveCurrentDepsStamp({
        chartData,
        authoritativeCurrentDsl: args.authoritativeCurrentDsl,
        graph: args.graph,
      });
      const scenarioIds: string[] =
        currentStamp?.scenarios?.length
          ? currentStamp.scenarios.map(s => String((s as any)?.scenario_id || '')).filter((x: string) => x.trim())
          : scenarioIdsFromRecipeOrPayload;
      if (currentStamp) {
        // Pinned refresh eligibility: if the chart is orphaned/pinned and the recipe is not eligible,
        // do not attempt to refresh (snapshot overlays cannot be regenerated from DSL).
        if (currentStamp.mode === 'pinned') {
          const eligible = chartData?.recipe?.pinned_recompute_eligible;
          if (eligible !== true) {
            skipped.push(chartFileId);
            continue;
          }
        }

        const prevSig = typeof chartData?.deps_signature === 'string' ? chartData.deps_signature : '';
        const nextSig = chartDepsSignatureV1(currentStamp);
        const shouldRecompute = isChartStaleV1({
          storedDepsSignature: chartData?.deps_signature,
          currentStamp,
        });
        if (!shouldRecompute) {
          skipped.push(chartFileId);
          continue;
        }
        updatedDetails.push({ chartFileId, prevDepsSignature: prevSig, nextDepsSignature: nextSig, reason: 'stale' });
      }

      const analysisType: string | undefined =
        chartData?.recipe?.analysis?.analysis_type ||
        chartData?.source?.analysis_type ||
        chartData?.payload?.analysis_result?.analysis_type ||
        undefined;
      const queryDsl: string | undefined =
        chartData?.recipe?.analysis?.query_dsl || chartData?.source?.query_dsl || undefined;

      const whatIfDsl: string | undefined =
        typeof chartData?.recipe?.analysis?.what_if_dsl === 'string' && chartData.recipe.analysis.what_if_dsl.trim()
          ? chartData.recipe.analysis.what_if_dsl.trim()
          : undefined;

      const scenarioDslSubtitleById: Record<string, string> = {};
      for (const s of recipeScenarios) {
        const sid = typeof s?.scenario_id === 'string' ? s.scenario_id : null;
        const dsl = typeof s?.effective_dsl === 'string' ? s.effective_dsl.trim() : '';
        if (sid && dsl) scenarioDslSubtitleById[sid] = dsl;
      }

      const scenarioGraphs = scenarioIds.map((sid: string) => {
        const def = recipeScenarios.find(s => s?.scenario_id === sid) || null;
        const visibilityMode = (def?.visibility_mode as any) || 'f+e';

        const colour =
          typeof def?.colour === 'string' && def.colour.trim()
            ? def.colour.trim()
            : sid === 'current'
              ? (args.currentColour || '#3B82F6')
              : sid === 'base'
                ? (args.baseColour || '#999999')
                : (args.scenarios.find(s => s.id === sid)?.colour || '#999999');

        const name =
          typeof def?.name === 'string' && def.name.trim()
            ? def.name.trim()
            : sid === 'current'
              ? 'Current'
              : sid === 'base'
                ? 'Base'
                : (args.scenarios.find(s => s.id === sid)?.name || sid);

        const scenarioGraph = buildGraphForAnalysisLayer(
          sid,
          JSON.parse(JSON.stringify(args.graph)),
          args.baseParams,
          args.currentParams,
          args.scenarios as any,
          sid === 'current' ? whatIfDsl : undefined,
          visibilityMode
        );

        return { scenario_id: sid, name, colour, visibility_mode: visibilityMode, graph: scenarioGraph };
      });

      const resp = await graphComputeClient.analyzeMultipleScenarios(scenarioGraphs as any, queryDsl, analysisType);
      if (!resp?.success || !resp?.result) {
        skipped.push(chartFileId);
        continue;
      }

      await chartOperationsService.openAnalysisChartTabFromAnalysis({
        chartKind: chartData?.chart_kind,
        analysisResult: resp.result,
        scenarioIds,
        title: chartData?.title,
        source: chartData?.source,
        fileId: chartFileId,
        scenarioDslSubtitleById: Object.keys(scenarioDslSubtitleById).length ? scenarioDslSubtitleById : undefined,
        hideCurrent: typeof chartData?.recipe?.display?.hide_current === 'boolean' ? chartData.recipe.display.hide_current : undefined,
        whatIfDsl,
      } as any);

      updated.push(chartFileId);
    } catch {
      skipped.push(chartFileId);
    }
  }

  return { updatedChartFileIds: updated, skippedChartFileIds: skipped, updatedDetails };
}
