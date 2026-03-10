import { graphComputeClient, type AnalysisResponse, type SnapshotSubjectPayload } from '../lib/graphComputeClient';
import { buildGraphForAnalysisLayer, applyProbabilityVisibilityModeToGraph, applyWhatIfToGraph } from './CompositionService';
import { computeInheritedDSL, computeEffectiveFetchDSL } from './scenarioRegenerationService';
import { augmentDSLWithConstraint } from '../lib/queryDSL';
import { logChartReadinessTrace } from '../lib/snapshotBootTrace';
import {
  getSnapshotPlannerInputsStatus,
  resolveSnapshotSubjectsForScenario,
  type SnapshotPlannerInputsStatusResult,
} from './snapshotSubjectResolutionService';
import type { Graph, ScenarioVisibilityMode } from '../types';

type ScenarioLike = {
  id: string;
  params: Record<string, any>;
  name?: string;
  colour?: string;
  meta?: {
    isLive?: boolean;
    queryDSL?: string;
    lastEffectiveDSL?: string;
  };
};

type ChartRecipeScenarioLike = {
  scenario_id: string;
  effective_dsl?: string;
  name?: string;
  colour?: string;
  visibility_mode?: ScenarioVisibilityMode;
};

type ScenarioContextLike = {
  scenarios?: ScenarioLike[];
  baseParams?: Record<string, any>;
  currentParams?: Record<string, any>;
  baseDSL?: string;
  currentColour?: string;
  baseColour?: string;
  scenariosReady?: boolean;
};

export type AnalysisComputeBlockedReason =
  | 'graph_not_ready'
  | 'analysis_type_missing'
  | 'live_scenario_state_missing'
  | 'live_scenarios_context_missing'
  | 'custom_scenarios_missing'
  | 'workspace_missing'
  | 'planner_inputs_pending_hydration'
  | 'planner_inputs_missing';

export interface PreparedAnalysisScenario {
  scenario_id: string;
  name: string;
  colour: string;
  visibility_mode: ScenarioVisibilityMode;
  graph: Graph;
  effective_query_dsl: string;
  snapshot_subjects?: SnapshotSubjectPayload[];
  snapshot_query_dsl?: string;
}

export interface PreparedAnalysisComputeReady {
  status: 'ready';
  analysisType: string;
  queryDsl: string;
  scenarios: PreparedAnalysisScenario[];
  signature: string;
}

export interface PreparedAnalysisComputeBlocked {
  status: 'blocked';
  reason: AnalysisComputeBlockedReason;
  requiredFileIds?: string[];
  missingFileIds?: string[];
  hydratableFileIds?: string[];
  unavailableFileIds?: string[];
}

export type PreparedAnalysisComputeState =
  | PreparedAnalysisComputeReady
  | PreparedAnalysisComputeBlocked;

type SharedParams = {
  graph: Graph | null | undefined;
  analysisType?: string | null;
  analyticsDsl?: string | null;
  currentDSL?: string | null;
  chartCurrentLayerDsl?: string | null;
  needsSnapshots: boolean;
  workspace?: { repository: string; branch: string };
};

type LiveParams = SharedParams & {
  mode: 'live' | 'panel';
  rawScenarioStateLoaded: boolean;
  visibleScenarioIds: string[];
  scenariosContext?: ScenarioContextLike | null;
  whatIfDSL?: string | null;
  getScenarioVisibilityMode: (scenarioId: string) => ScenarioVisibilityMode;
  getScenarioName: (scenarioId: string) => string;
  getScenarioColour: (scenarioId: string) => string;
};

type CustomParams = SharedParams & {
  mode: 'custom';
  customScenarios?: ChartRecipeScenarioLike[] | null;
  hiddenScenarioIds?: string[];
  frozenWhatIfDsl?: string | null;
};

export type PrepareAnalysisComputeInputsParams = LiveParams | CustomParams;

function summarisePrepareParams(params: PrepareAnalysisComputeInputsParams): Record<string, unknown> {
  return {
    mode: params.mode,
    analysisType: params.analysisType || null,
    needsSnapshots: params.needsSnapshots,
    hasWorkspace: !!params.workspace,
    analyticsDsl: params.analyticsDsl || '',
    currentDSL: params.currentDSL || '',
    chartCurrentLayerDsl: params.chartCurrentLayerDsl || '',
    rawScenarioStateLoaded: params.mode === 'live' || params.mode === 'panel'
      ? params.rawScenarioStateLoaded
      : undefined,
    visibleScenarioIds: params.mode === 'live' || params.mode === 'panel'
      ? params.visibleScenarioIds
      : undefined,
    scenariosReady: params.mode === 'live' || params.mode === 'panel'
      ? params.scenariosContext?.scenariosReady
      : undefined,
    customScenarioIds: params.mode === 'custom'
      ? (params.customScenarios || []).map((scenario) => scenario.scenario_id)
      : undefined,
  };
}

function logBlockedResult(
  params: PrepareAnalysisComputeInputsParams,
  blocked: PreparedAnalysisComputeBlocked,
): PreparedAnalysisComputeBlocked {
  logChartReadinessTrace('AnalysisPrepare:blocked', {
    ...summarisePrepareParams(params),
    reason: blocked.reason,
    requiredFileIds: blocked.requiredFileIds || [],
    missingFileIds: blocked.missingFileIds || [],
    hydratableFileIds: blocked.hydratableFileIds || [],
    unavailableFileIds: blocked.unavailableFileIds || [],
  });
  return blocked;
}

function graphSignature(graph: any): string {
  const nodeIds = (graph?.nodes || []).map((n: any) => n.id || n.uuid).sort().join(',');
  const edgeIds = (graph?.edges || []).map((e: any) => e.id || e.uuid).sort().join(',');
  const edgeProbs = (graph?.edges || [])
    .map((e: any) => `${e.id || e.uuid}:${(e.p?.mean ?? 0).toFixed(6)}`)
    .sort()
    .join(',');
  const caseWeights = (graph?.nodes || [])
    .filter((n: any) => n.type === 'case' && n.case?.variants)
    .map((n: any) => {
      const weights = (n.case.variants || [])
        .map((v: any) => `${v.name}:${(v.weight ?? 0).toFixed(4)}`)
        .join(';');
      return `${n.id || n.uuid}=[${weights}]`;
    })
    .sort()
    .join(',');
  return `nodes:${nodeIds}|edges:${edgeIds}|probs:${edgeProbs}|cases:${caseWeights}`;
}

function snapshotSubjectsSignature(subjects?: SnapshotSubjectPayload[]): string {
  const arr = Array.isArray(subjects) ? subjects : [];
  return arr
    .map((s) => [
      s.subject_id || '',
      s.core_hash || '',
      s.read_mode || '',
      s.anchor_from || '',
      s.anchor_to || '',
      s.as_at || '',
      s.sweep_from || '',
      s.sweep_to || '',
      Array.isArray(s.slice_keys) ? s.slice_keys.join(',') : '',
    ].join('|'))
    .sort()
    .join('||');
}

function createPreparedSignature(
  analysisType: string,
  queryDsl: string,
  scenarios: PreparedAnalysisScenario[],
): string {
  return [
    analysisType,
    queryDsl,
    ...scenarios.map((scenario) => [
      scenario.scenario_id,
      scenario.visibility_mode,
      scenario.effective_query_dsl,
      graphSignature(scenario.graph),
      snapshotSubjectsSignature(scenario.snapshot_subjects),
    ].join('|')),
  ].join('||');
}

function createBlockedPlannerState(
  status: SnapshotPlannerInputsStatusResult,
): PreparedAnalysisComputeBlocked {
  return {
    status: 'blocked',
    reason: status.hydratableFileIds.length > 0
      ? 'planner_inputs_pending_hydration'
      : 'planner_inputs_missing',
    requiredFileIds: status.requiredFileIds,
    missingFileIds: status.missingFileIds,
    hydratableFileIds: status.hydratableFileIds,
    unavailableFileIds: status.unavailableFileIds,
  };
}

function composeScenarioDsl(baseDsl: string, chartCurrentLayerDsl?: string | null): string {
  if (chartCurrentLayerDsl && chartCurrentLayerDsl.trim()) {
    return augmentDSLWithConstraint(baseDsl, chartCurrentLayerDsl);
  }
  return baseDsl;
}

export function buildLiveScenarioQueryDslResolver(args: {
  visibleScenarioIds: string[];
  currentDSL?: string | null;
  graph?: Graph | null;
  chartCurrentLayerDsl?: string | null;
  scenariosContext?: ScenarioContextLike | null;
}): (scenarioId: string) => string {
  const visibleLiveScenarios = (args.visibleScenarioIds || [])
    .map((scenarioId) => args.scenariosContext?.scenarios?.find((scenario) => scenario.id === scenarioId))
    .filter((scenario): scenario is ScenarioLike => Boolean(scenario));

  return (scenarioId: string): string => {
    let baseDslForScenario = args.currentDSL || '';
    if (scenarioId === 'base') {
      baseDslForScenario = args.scenariosContext?.baseDSL || (args.graph as any)?.baseDSL || args.currentDSL || '';
    } else if (scenarioId !== 'current') {
      const scenario = args.scenariosContext?.scenarios?.find((item) => item.id === scenarioId);
      const meta = scenario?.meta;
      if (meta?.isLive) {
        if (typeof meta.lastEffectiveDSL === 'string' && meta.lastEffectiveDSL.trim()) {
          baseDslForScenario = meta.lastEffectiveDSL;
        } else if (typeof meta.queryDSL === 'string') {
          const scenarioIndex = visibleLiveScenarios.findIndex((item) => item.id === scenarioId);
          if (scenarioIndex >= 0) {
            const inheritedDsl = computeInheritedDSL(
              scenarioIndex,
              visibleLiveScenarios,
              args.currentDSL || args.scenariosContext?.baseDSL || (args.graph as any)?.baseDSL || '',
            );
            baseDslForScenario = computeEffectiveFetchDSL(inheritedDsl, meta.queryDSL || '');
          }
        }
      }
    }
    return composeScenarioDsl(baseDslForScenario, args.chartCurrentLayerDsl);
  };
}

export async function prepareAnalysisComputeInputs(
  params: PrepareAnalysisComputeInputsParams,
): Promise<PreparedAnalysisComputeState> {
  logChartReadinessTrace('AnalysisPrepare:start', summarisePrepareParams(params));

  const graph = params.graph;
  if (!(graph && Array.isArray((graph as any).nodes) && Array.isArray((graph as any).edges))) {
    return logBlockedResult(params, { status: 'blocked', reason: 'graph_not_ready' });
  }

  const analysisType = typeof params.analysisType === 'string' ? params.analysisType.trim() : '';
  if (!analysisType) {
    return logBlockedResult(params, { status: 'blocked', reason: 'analysis_type_missing' });
  }

  const analyticsDsl = params.analyticsDsl || '';
  const queryDsl = analyticsDsl || params.currentDSL || '';

  let scenarios: PreparedAnalysisScenario[] = [];

  if (params.mode === 'live' || params.mode === 'panel') {
    if (!params.rawScenarioStateLoaded) {
      return logBlockedResult(params, { status: 'blocked', reason: 'live_scenario_state_missing' });
    }
    if (!params.scenariosContext?.scenariosReady) {
      return logBlockedResult(params, { status: 'blocked', reason: 'live_scenarios_context_missing' });
    }

    const visibleScenarioIds = params.visibleScenarioIds.length > 0
      ? params.visibleScenarioIds
      : ['current'];
    const getQueryDslForScenario = buildLiveScenarioQueryDslResolver({
      visibleScenarioIds,
      currentDSL: params.currentDSL,
      graph,
      chartCurrentLayerDsl: params.chartCurrentLayerDsl,
      scenariosContext: params.scenariosContext,
    });

    for (const scenarioId of visibleScenarioIds) {
      const visibilityMode = params.getScenarioVisibilityMode(scenarioId);
      const scenarioGraph = buildGraphForAnalysisLayer(
        scenarioId,
        graph,
        params.scenariosContext?.baseParams || {},
        params.scenariosContext?.currentParams || {},
        params.scenariosContext?.scenarios || [],
        scenarioId === 'current' ? params.whatIfDSL : undefined,
        visibilityMode,
      );

      const effectiveQueryDsl = getQueryDslForScenario(scenarioId);
      scenarios.push({
        scenario_id: scenarioId,
        name: params.getScenarioName(scenarioId),
        colour: params.getScenarioColour(scenarioId),
        visibility_mode: visibilityMode,
        graph: scenarioGraph,
        effective_query_dsl: effectiveQueryDsl,
      });
    }
  } else if (params.mode === 'custom') {
    const customScenariosAll = params.customScenarios || [];
    const hiddenScenarioIds = new Set(params.hiddenScenarioIds || []);
    const visibleCustomScenarios = customScenariosAll.filter(
      (scenario) => !hiddenScenarioIds.has(scenario.scenario_id),
    );
    const customScenarios = visibleCustomScenarios.length > 0
      ? visibleCustomScenarios
      : customScenariosAll;

    if (customScenarios.length === 0) {
      return logBlockedResult(params, { status: 'blocked', reason: 'custom_scenarios_missing' });
    }

    scenarios = customScenarios.map((scenario) => {
      const visibilityMode = scenario.visibility_mode || 'f+e';
      let scenarioGraph: Graph = graph;
      if (scenario.scenario_id === 'current' && params.frozenWhatIfDsl) {
        scenarioGraph = applyWhatIfToGraph(scenarioGraph, params.frozenWhatIfDsl) as Graph;
      }
      scenarioGraph = applyProbabilityVisibilityModeToGraph(scenarioGraph, visibilityMode);

      return {
        scenario_id: scenario.scenario_id,
        name: scenario.name || scenario.scenario_id,
        colour: scenario.colour || '#808080',
        visibility_mode: visibilityMode,
        graph: scenarioGraph,
        effective_query_dsl: composeScenarioDsl(scenario.effective_dsl || '', params.chartCurrentLayerDsl),
      };
    });
  }

  logChartReadinessTrace('AnalysisPrepare:scenarios-built', {
    mode: params.mode,
    analysisType,
    scenarioCount: scenarios.length,
    scenarios: scenarios.map((scenario) => ({
      scenarioId: scenario.scenario_id,
      visibilityMode: scenario.visibility_mode,
      effectiveQueryDsl: scenario.effective_query_dsl,
    })),
  });

  if (params.needsSnapshots) {
    if (!params.workspace) {
      return logBlockedResult(params, { status: 'blocked', reason: 'workspace_missing' });
    }

    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      const plannerStatus = await getSnapshotPlannerInputsStatus({
        scenarioGraph: scenario.graph,
        workspace: params.workspace,
        dslStrings: [analyticsDsl, scenario.effective_query_dsl].filter(Boolean),
      });
      if (!plannerStatus.ready) {
        return logBlockedResult(params, createBlockedPlannerState(plannerStatus));
      }

      const resolved = await resolveSnapshotSubjectsForScenario({
        scenarioGraph: scenario.graph,
        analyticsDsl,
        scenarioId: scenario.scenario_id,
        analysisType,
        workspace: params.workspace,
        getQueryDslForScenario: (scenarioId: string) => {
          const match = scenarios.find((item) => item.scenario_id === scenarioId);
          return match?.effective_query_dsl || '';
        },
      });

      scenarios[index] = {
        ...scenario,
        snapshot_subjects: resolved.subjects as SnapshotSubjectPayload[],
        snapshot_query_dsl: resolved.snapshotDsl,
      };

      logChartReadinessTrace('AnalysisPrepare:snapshot-subjects-ready', {
        mode: params.mode,
        analysisType,
        scenarioId: scenario.scenario_id,
        subjectCount: resolved.subjects.length,
        snapshotQueryDsl: resolved.snapshotDsl,
      });
    }
  }

  const ready: PreparedAnalysisComputeReady = {
    status: 'ready',
    analysisType,
    queryDsl,
    scenarios,
    signature: createPreparedSignature(analysisType, queryDsl, scenarios),
  };

  logChartReadinessTrace('AnalysisPrepare:ready', {
    ...summarisePrepareParams(params),
    signature: ready.signature,
    scenarioCount: ready.scenarios.length,
    scenarios: ready.scenarios.map((scenario) => ({
      scenarioId: scenario.scenario_id,
      visibilityMode: scenario.visibility_mode,
      subjectCount: Array.isArray(scenario.snapshot_subjects) ? scenario.snapshot_subjects.length : 0,
    })),
  });

  return ready;
}

export async function runPreparedAnalysis(
  prepared: PreparedAnalysisComputeReady,
): Promise<AnalysisResponse> {
  logChartReadinessTrace('AnalysisPrepare:dispatch-compute', {
    analysisType: prepared.analysisType,
    signature: prepared.signature,
    scenarioCount: prepared.scenarios.length,
    queryDsl: prepared.queryDsl,
    scenarios: prepared.scenarios.map((scenario) => ({
      scenarioId: scenario.scenario_id,
      visibilityMode: scenario.visibility_mode,
      subjectCount: Array.isArray(scenario.snapshot_subjects) ? scenario.snapshot_subjects.length : 0,
    })),
  });

  if (prepared.scenarios.length > 1) {
    return graphComputeClient.analyzeMultipleScenarios(
      prepared.scenarios.map((scenario) => ({
        scenario_id: scenario.scenario_id,
        name: scenario.name,
        graph: scenario.graph,
        colour: scenario.colour,
        visibility_mode: scenario.visibility_mode,
        snapshot_subjects: scenario.snapshot_subjects,
      })),
      prepared.queryDsl || undefined,
      prepared.analysisType,
    );
  }

  const scenario = prepared.scenarios[0];
  return graphComputeClient.analyzeSelection(
    scenario.graph,
    prepared.queryDsl || undefined,
    scenario.scenario_id,
    scenario.name,
    scenario.colour,
    prepared.analysisType,
    scenario.visibility_mode,
    scenario.snapshot_subjects,
  );
}
