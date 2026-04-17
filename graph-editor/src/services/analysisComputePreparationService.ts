import { graphComputeClient, type AnalysisResponse, type SnapshotSubjectPayload } from '../lib/graphComputeClient';
import { hasLocalCompute, computeLocalResultMultiScenario, mergeBackendAugmentation } from './localAnalysisComputeService';
import { buildGraphForAnalysisLayer, applyProbabilityVisibilityModeToGraph, applyWhatIfToGraph, applyComposedParamsToGraph } from './CompositionService';
import { computeInheritedDSL, computeEffectiveFetchDSL } from './scenarioRegenerationService';
import { augmentDSLWithConstraint } from '../lib/queryDSL';
import { logChartReadinessTrace } from '../lib/snapshotBootTrace';
import {
  getSnapshotPlannerInputsStatus,
  resolveSnapshotSubjectsForScenario,
  type SnapshotPlannerInputsStatusResult,
} from './snapshotSubjectResolutionService';
import type { Graph, ScenarioVisibilityMode } from '../types';
import { resolveComputeAffectingDisplay } from '../lib/analysisDisplaySettingsRegistry';
import { projectProbabilityPosterior, projectLatencyPosterior, resolveAsatPosterior } from './posteriorSliceResolution';
import { parseConstraints } from '../lib/queryDSL';

// ── Posterior re-projection (doc 25 §2.2, doc 27 §5.4) ─────────────────────
// After building a per-scenario analysis graph, re-project the posterior
// from the stashed _posteriorSlices using that scenario's effective DSL.
// This ensures each scenario graph carries the right posterior for its
// query context (window vs cohort, contexted vs aggregate).
//
// When the effective DSL contains asat(), the posterior is resolved from
// fit_history (doc 27 §5) before projection. If no historical fit exists
// on or before the asat date, the posterior is cleared (strict, no fallback).

function reprojectPosteriorForDsl(graph: Graph, effectiveDsl: string): void {
  const edges = (graph as any)?.edges;
  if (!Array.isArray(edges)) return;

  // Parse asat date from the effective DSL (if present)
  let asatDate: string | null = null;
  try {
    const parsed = parseConstraints(effectiveDsl);
    asatDate = parsed.asat;
  } catch { /* no asat */ }

  for (const edge of edges) {
    const stashed = edge?.p?._posteriorSlices;
    if (!stashed?.slices) continue;

    // If asat is active, resolve the historical posterior (doc 27 §5.2)
    const posteriorToProject = asatDate
      ? resolveAsatPosterior(stashed, asatDate)
      : stashed;

    if (!posteriorToProject) {
      // No fit exists on or before the asat date — clear posterior (strict)
      edge.p.posterior = undefined;
      if (edge.p.latency) edge.p.latency.posterior = undefined;
      continue;
    }

    const probResult = projectProbabilityPosterior(posteriorToProject, effectiveDsl);
    if (probResult) {
      edge.p.posterior = probResult;
    }

    const latResult = projectLatencyPosterior(posteriorToProject, effectiveDsl);
    if (latResult && edge.p.latency) {
      edge.p.latency.posterior = latResult;
    }
  }
}

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
  params?: Record<string, any>;
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
  /** Doc 31: analytics DSL for BE-side subject resolution. */
  analytics_dsl?: string;
  /** Doc 31: FE-computed candidate regimes for all edges in this scenario's graph. */
  candidate_regimes_by_edge?: Record<string, Array<{ core_hash: string; equivalent_hashes: string[] }>>;
}

export interface PreparedAnalysisComputeReady {
  status: 'ready';
  analysisType: string;
  /** Analysis subject DSL (from/to/visited). Constant across scenarios. */
  analyticsDsl: string;
  scenarios: PreparedAnalysisScenario[];
  signature: string;
  /** Compute-affecting display settings forwarded to the backend. */
  displaySettings?: Record<string, unknown>;
  /** MECE dimension names for regime selection aggregation safety (doc 30). */
  meceDimensions?: string[];
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
  /** Canvas analysis display bag — compute-affecting keys are forwarded to the backend. */
  display?: Record<string, unknown> | null;
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
    .map((e: any) => {
      const p = (e.p?.mean ?? 0).toFixed(6);
      // Include latency params so Bayes posterior updates invalidate the signature
      const lat = e.p?.latency;
      const l = lat ? `:mu=${(lat.mu_mean ?? 0).toFixed(4)}:σ=${(lat.sigma_mean ?? 0).toFixed(4)}:on=${(lat.onset_delta_days ?? 0).toFixed(2)}` : '';
      return `${e.id || e.uuid}:${p}${l}`;
    })
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
      Array.isArray(s.equivalent_hashes) ? s.equivalent_hashes.map(e => e.core_hash).sort().join(',') : '',
    ].join('|'))
    .sort()
    .join('||');
}

export function createPreparedSignature(
  analysisType: string,
  analyticsDsl: string,
  scenarios: PreparedAnalysisScenario[],
  displaySettings?: Record<string, unknown>,
): string {
  const parts = [
    analysisType,
    analyticsDsl,
    ...scenarios.map((scenario) => [
      scenario.scenario_id,
      scenario.visibility_mode,
      scenario.effective_query_dsl,
      graphSignature(scenario.graph),
      snapshotSubjectsSignature(scenario.snapshot_subjects),
    ].join('|')),
  ];
  if (displaySettings) {
    parts.push(`ds:${JSON.stringify(displaySettings)}`);
  }
  return parts.join('||');
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

  // analytics_dsl = the subject (from/to/visited). Constant across scenarios.
  // currentDSL = the graph's temporal clause. Used as base for scenario DSL composition.
  // These are SEPARATE concerns — never concatenated.
  const analyticsDsl = params.analyticsDsl || '';
  const currentDSL = params.currentDSL || '';

  let scenarios: PreparedAnalysisScenario[] = [];

  if (params.mode === 'live' || params.mode === 'panel') {
    if (!params.rawScenarioStateLoaded) {
      return logBlockedResult(params, { status: 'blocked', reason: 'live_scenario_state_missing' });
    }
    // FE-computed types (edge_info, node_info) don't need scenarios — skip the ready gate
    // to avoid blocking them during boot while ScenariosContext loads from IDB.
    const FE_ONLY_TYPES = new Set(['edge_info', 'node_info']);
    if (!FE_ONLY_TYPES.has(analysisType) && !params.scenariosContext?.scenariosReady) {
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
      reprojectPosteriorForDsl(scenarioGraph, effectiveQueryDsl);
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

    // Build prepared scenarios in recipe order, then reorder so 'current'
    // (the base reference) comes first.  Bridge uses index 0 as start and
    // index 1 as end — "from base TO variation".
    const builtScenarios = customScenarios.map((scenario) => {
      const visibilityMode = scenario.visibility_mode || 'f+e';
      let scenarioGraph: Graph = graph;
      // Apply captured graph parameter overrides (from Live-mode composition).
      // Without this, Custom mode would use the base graph and produce different
      // outcomes than Live mode for scenarios with parameter overlays.
      if (scenario.params && (scenario.params.edges || scenario.params.nodes)) {
        scenarioGraph = applyComposedParamsToGraph(scenarioGraph, scenario.params as any);
      }
      if (scenario.scenario_id === 'current' && params.frozenWhatIfDsl) {
        scenarioGraph = applyWhatIfToGraph(scenarioGraph, params.frozenWhatIfDsl) as Graph;
      }
      scenarioGraph = applyProbabilityVisibilityModeToGraph(scenarioGraph, visibilityMode);

      const effectiveQueryDsl = composeScenarioDsl(
        augmentDSLWithConstraint(params.currentDSL || '', scenario.effective_dsl || ''),
        params.chartCurrentLayerDsl,
      );
      reprojectPosteriorForDsl(scenarioGraph, effectiveQueryDsl);

      return {
        scenario_id: scenario.scenario_id,
        name: scenario.name || scenario.scenario_id,
        colour: scenario.colour || '#808080',
        visibility_mode: visibilityMode,
        graph: scenarioGraph,
        effective_query_dsl: effectiveQueryDsl,
      };
    });
    const currentIdx = builtScenarios.findIndex((s) => s.scenario_id === 'current');
    if (currentIdx > 0) {
      const [currentScenario] = builtScenarios.splice(currentIdx, 1);
      builtScenarios.unshift(currentScenario);
    }
    scenarios = builtScenarios;
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

    // Build full candidate regime inventory once (graph-level, not per-scenario).
    let fullRegimeInventory: Record<string, Array<{ core_hash: string; equivalent_hashes: string[]; context_keys?: string[] }>> = {};
    try {
      const { buildCandidateRegimesByEdge } = await import('./candidateRegimeService');
      fullRegimeInventory = await buildCandidateRegimesByEdge(
        scenarios[0]?.graph as any,
        params.workspace!,
      );
    } catch (regimeErr: any) {
      // Non-blocking: regime selection degrades to pass-through on the BE
      console.warn('[AnalysisPrepare] buildCandidateRegimesByEdge failed:', regimeErr?.message || regimeErr);
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

      // Filter the full inventory to this scenario's context dimensions (doc 30 §4.1).
      // If filtering produces empty results for all edges, fall back to the full
      // inventory — the BE's regime selection will pick the best available match.
      let candidateRegimesByEdge: Record<string, Array<{ core_hash: string; equivalent_hashes: string[] }>> | undefined;
      if (Object.keys(fullRegimeInventory).length > 0) {
        try {
          const { filterCandidatesByContext } = await import('./candidateRegimeService');
          const filtered = await filterCandidatesByContext(
            fullRegimeInventory,
            scenario.effective_query_dsl,
          );
          candidateRegimesByEdge = Object.keys(filtered).length > 0
            ? filtered
            : fullRegimeInventory;
        } catch {
          candidateRegimesByEdge = fullRegimeInventory;
        }
      }

      scenarios[index] = {
        ...scenario,
        ...(candidateRegimesByEdge ? { candidate_regimes_by_edge: candidateRegimesByEdge } : {}),
      };

      logChartReadinessTrace('AnalysisPrepare:snapshot-subjects-ready', {
        mode: params.mode,
        analysisType,
        scenarioId: scenario.scenario_id,
        analyticsDsl,
        candidateRegimeEdgeCount: candidateRegimesByEdge ? Object.keys(candidateRegimesByEdge).length : 0,
      });
    }
  }

  // Doc 30: compute MECE dimensions from the base graph's context registry.
  let meceDimensions: string[] | undefined;
  if (params.needsSnapshots && params.workspace) {
    try {
      const { computeMeceDimensions } = await import('./candidateRegimeService');
      const baseGraph = scenarios[0]?.graph;
      if (baseGraph) {
        meceDimensions = await computeMeceDimensions(baseGraph as any, params.workspace);
      }
    } catch {
      // Non-blocking
    }
  }

  const displaySettings = resolveComputeAffectingDisplay(analysisType, params.display ?? undefined);

  // Resolve tau_extent='auto' to the max sweep span across all scenarios.
  // Doc 31: snapshot_subjects are no longer populated on the FE — the BE
  // resolves subjects from the DSL.  Derive sweep span from the DSL's
  // window/cohort clause.  Check each scenario's effective_query_dsl (which
  // may override the base DSL) and take the widest span.
  if (displaySettings && String(displaySettings.tau_extent ?? '') === 'auto') {
    try {
      const { parseConstraints } = await import('../lib/queryDSL');
      const { resolveRelativeDate, normalizeToISO } = await import('../lib/dateFormat');
      const now = new Date();
      now.setUTCHours(0, 0, 0, 0);
      const nowMs = now.getTime();

      let maxSweep = 0;
      // Collect all DSL strings: base + each scenario's effective override
      const dslCandidates = [currentDSL, ...scenarios.map(sc => sc.effective_query_dsl)].filter(Boolean);
      for (const dsl of dslCandidates) {
        const parsed = parseConstraints(dsl);
        const startStr = parsed?.window?.start || parsed?.cohort?.start;
        if (!startStr) continue;
        const resolved = resolveRelativeDate(startStr);
        const isoStart = normalizeToISO(resolved);
        const startDate = new Date(isoStart);
        if (isNaN(startDate.getTime())) continue;
        const days = Math.round((nowMs - startDate.getTime()) / 86400000);
        if (days > maxSweep) maxSweep = days;
      }
      if (maxSweep > 0) {
        displaySettings.tau_extent = maxSweep;
      }
    } catch { /* ignore parse errors — tau_extent stays 'auto' */ }
  }

  const ready: PreparedAnalysisComputeReady = {
    status: 'ready',
    analysisType,
    analyticsDsl,
    scenarios,
    signature: createPreparedSignature(analysisType, analyticsDsl, scenarios, displaySettings),
    displaySettings,
    meceDimensions,
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

/**
 * Run a prepared analysis, with progressive FE-first compute for supported types.
 *
 * For types with local compute (node_info, edge_info):
 *   1. Return an FE-computed result immediately
 *   2. Fire a backend call in the background
 *   3. When BE responds, merge augmentation into the result via onAugment callback
 *
 * For all other types: delegate to the backend as before.
 */
export async function runPreparedAnalysis(
  prepared: PreparedAnalysisComputeReady,
  onAugment?: (merged: AnalysisResponse) => void,
): Promise<AnalysisResponse> {
  logChartReadinessTrace('AnalysisPrepare:dispatch-compute', {
    analysisType: prepared.analysisType,
    signature: prepared.signature,
    scenarioCount: prepared.scenarios.length,
    analyticsDsl: prepared.analyticsDsl,
    scenarios: prepared.scenarios.map((scenario) => ({
      scenarioId: scenario.scenario_id,
      visibilityMode: scenario.visibility_mode,
      subjectCount: Array.isArray(scenario.snapshot_subjects) ? scenario.snapshot_subjects.length : 0,
    })),
  });

  // Progressive FE-first compute for locally-computable types
  if (hasLocalCompute(prepared.analysisType) && prepared.scenarios.length >= 1) {
    const localScenarios = prepared.scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      name: s.name,
      colour: s.colour,
      graph: s.graph as any,
    }));
    const localResponse = computeLocalResultMultiScenario(localScenarios, prepared.analysisType, prepared.analyticsDsl);

    // For info-type analyses (node_info, edge_info), the FE result is authoritative
    // and complete. The backend computes a different analysis shape (funnel data)
    // that would overwrite the info-card-shaped data, so skip augmentation entirely.
    // For other locally-computable types, fire BE call in background and merge.
    const isInfoType = prepared.analysisType === 'node_info' || prepared.analysisType === 'edge_info';
    if (onAugment && !isInfoType) {
      runBackendAnalysis(prepared).then((beResponse) => {
        if (beResponse.success && beResponse.result && localResponse.result) {
          const merged = mergeBackendAugmentation(localResponse.result, beResponse.result);
          onAugment({ success: true, result: merged });
        }
      }).catch(() => {
        // BE unavailable — FE result stands on its own
      });
    }

    return localResponse;
  }

  return runBackendAnalysis(prepared);
}

/** Dispatch to backend (single or multi-scenario). */
async function runBackendAnalysis(
  prepared: PreparedAnalysisComputeReady,
): Promise<AnalysisResponse> {
  if (prepared.scenarios.length > 1) {
    return graphComputeClient.analyzeMultipleScenarios(
      prepared.scenarios.map((scenario) => ({
        scenario_id: scenario.scenario_id,
        name: scenario.name,
        graph: scenario.graph,
        colour: scenario.colour,
        visibility_mode: scenario.visibility_mode,
        candidate_regimes_by_edge: scenario.candidate_regimes_by_edge,
        effective_query_dsl: scenario.effective_query_dsl,
      })),
      prepared.analyticsDsl,
      prepared.analysisType,
      prepared.displaySettings,
      prepared.meceDimensions,
    );
  }

  const scenario = prepared.scenarios[0];
  return graphComputeClient.analyzeSelection(
    scenario.graph,
    prepared.analyticsDsl,
    scenario.effective_query_dsl,
    scenario.scenario_id,
    scenario.name,
    scenario.colour,
    prepared.analysisType,
    scenario.visibility_mode,
    scenario.candidate_regimes_by_edge,
    prepared.displaySettings,
    prepared.meceDimensions,
  );
}
