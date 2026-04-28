import { graphComputeClient, type AnalysisResponse, type SnapshotSubjectPayload } from '../lib/graphComputeClient';
import { hasLocalCompute, computeLocalResultMultiScenario, mergeBackendAugmentation } from './localAnalysisComputeService';
import { buildGraphForAnalysisLayer, applyWhatIfToGraph, applyComposedParamsToGraph } from './CompositionService';
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
import {
  contextGraphForEffectiveDsl,
  type ParameterFileResolver,
} from './posteriorSliceContexting';
import { engorgeGraphEdges } from '../lib/bayesEngorge';
import { cloneGraphWithoutBayesRuntimeFields } from '../lib/bayesGraphRuntime';
import { collectConditionedForecastParameterFiles } from '../lib/conditionedForecastGraphSnapshot';
import {
  materialiseScenarioFeTopo,
  type MaterialisationFailureDetail,
} from './feTopoMaterialisationService';

// ── Per-scenario request-graph contexting + engorgement (doc 73b §3.2a) ────
// After building a per-scenario analysis graph, re-context it to that
// scenario's effective DSL: pick the matching slice from each edge's
// parameter file and project onto in-schema fields, then engorge the
// transient `_posteriorSlices` library and the bayes evidence/priors so
// BE consumers (`epistemic_bands.py`, CF) read the right material.
//
// Stage 4(a) replaces the previous "stash on the live edge" model. The
// shared helper in `posteriorSliceContexting.ts` is the single match-rule
// owner; this function is pure orchestration around it.
//
// When `resolveParameterFile` is absent the graph passes through unchanged
// (legacy behaviour for tests that exercise prepared shape without the
// per-scenario re-contexting concern).
function recontextScenarioGraph(
  graph: Graph,
  effectiveDsl: string,
  resolveParameterFile: ParameterFileResolver | undefined,
): void {
  if (!resolveParameterFile) return;

  // In-schema contexting: project the active slice onto p.posterior.* and
  // p.latency.posterior.* per scenario. Mirrors under each conditional_p[X].
  contextGraphForEffectiveDsl(graph, resolveParameterFile, effectiveDsl, {
    engorgeFitHistory: false,
  });

  // Out-of-schema engorgement on the request-graph copy: attach
  // `_posteriorSlices`, `_bayes_evidence`, `_bayes_priors` so BE consumers
  // (epistemic_bands.py, CF) see the file-sourced material that used to
  // live in the persistent Flow G stash.
  const parameterFiles = collectConditionedForecastParameterFiles(
    graph,
    resolveParameterFile,
  );
  engorgeGraphEdges(graph, parameterFiles);
}

interface RunScenarioMaterialisationResult {
  graph: Graph;
  notFullyMaterialised: boolean;
  failures?: MaterialisationFailureDetail[];
}

// ── Shared materialisation boundary (doc 73e §8.3 Stage 5) ─────────────────
// The single orchestration entry point for taking a built scenario graph
// to a transport-ready (materialised) scenario graph: in-schema posterior
// projection (Stage 4(a)) followed by FE topo materialisation (Stage 5
// item 7).
//
// Every caller-shape that does NOT already arrive with a materialised
// graph routes through here: custom recipes (params-only and graph-bearing),
// fixed recipes, and CLI `analyse`. Live, refresh-all/boot, and share
// restore arrive already-materialised via the fetch pipeline upstream and
// therefore do not call this function — they package their already-materialised
// scenarios directly. Direction of travel: those callers migrate to invoke
// this function as well, with idempotency on already-materialised state, so
// transport consumes a single uniform contract regardless of caller shape.
//
// No recipe-mode-specific logic, no opt-outs. If a caller has already done
// the work, the caller does not call this function.
async function runScenarioMaterialisation(
  scenarioGraph: Graph,
  effectiveQueryDsl: string,
  resolveParameterFile: ParameterFileResolver | undefined,
  workspace: { repository: string; branch: string } | undefined,
  meta: { scenarioId: string; scenarioName: string },
): Promise<RunScenarioMaterialisationResult> {
  // Stage 4(a) — in-schema posterior projection from parameter files.
  recontextScenarioGraph(scenarioGraph, effectiveQueryDsl, resolveParameterFile);

  // Stage 5 item 7 — FE topo materialisation via the shared fetch-pipeline
  // helper. When workspace is unset (legacy/test paths that exercise
  // prepared shape without file-backed state) there are no parameter files
  // to draw on, so materialisation is a no-op.
  if (!workspace) {
    return { graph: scenarioGraph, notFullyMaterialised: false };
  }

  const materialised = await materialiseScenarioFeTopo(
    scenarioGraph,
    effectiveQueryDsl,
    {
      scenarioId: meta.scenarioId,
      scenarioName: meta.scenarioName,
      workspace,
    },
  );
  return {
    graph: materialised.graph,
    notFullyMaterialised: materialised.notFullyMaterialised,
    failures: materialised.failures.length > 0 ? materialised.failures : undefined,
  };
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
  graph?: Graph | null;
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
  /**
   * Doc 73e §8.3 Stage 5 item 6 — materialisation observability.
   *
   * Set true when one or more fetchable items did not complete during
   * the FE topo materialisation step (parameter file absent, slice
   * missing for the effective DSL, etc.). Downstream surfacing reads
   * this signal: chart-side rendering shows a "data unavailable" badge,
   * share restore shows a "missing parameter files" banner, CLI exits
   * non-zero listing the affected scenarios. The session-log entry
   * (warning, MATERIALISATION_INCOMPLETE) is the contract; the visible
   * UI/CLI is its rendering.
   */
  not_fully_materialised?: boolean;
  /**
   * Doc 73e §8.3 Stage 5 item 6 — per-item failure details. Populated
   * alongside `not_fully_materialised`; omitted when the scenario
   * materialised cleanly.
   */
  materialisation_failures?: MaterialisationFailureDetail[];
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
  /** Parameter-file resolver for per-scenario request-graph contexting +
   *  engorgement (doc 73b §3.2a, Stage 4(a)/4(b)). Required after Stage 4(b)
   *  removes the persistent `_posteriorSlices` stash; without it scenario
   *  graphs lose their per-DSL posterior projection. Optional during
   *  migration so legacy callers and shape-only tests continue to compile. */
  resolveParameterFile?: ParameterFileResolver;
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
  /**
   * Doc 73e §8.3 Stage 5 item 1 — recipe-mode distinction within `mode: 'custom'`.
   *
   * Custom recipes (`'custom'`, default): `scenario.effective_dsl` is treated
   * as a delta over the current graph's DSL — the two are combined via
   * `augmentDSLWithConstraint`. Recipe overrides win for clauses it provides;
   * unmentioned clauses inherit from `currentDSL`.
   *
   * Fixed recipes (`'fixed'`): `scenario.effective_dsl` is BAKED ABSOLUTE.
   * It must not be rebased over `currentDSL`; the recipe's DSL is the whole
   * DSL at preparation time. This is the load-bearing fixed-recipe invariant.
   */
  analysisMode?: 'custom' | 'fixed';
};

export type PrepareAnalysisComputeInputsParams = LiveParams | CustomParams;

function hasGraphShape(graph: unknown): graph is Graph {
  const value = graph as any;
  return !!(value && Array.isArray(value.nodes) && Array.isArray(value.edges));
}

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
    customScenarioGraphIds: params.mode === 'custom'
      ? (params.customScenarios || [])
          .filter((scenario) => hasGraphShape(scenario.graph))
          .map((scenario) => scenario.scenario_id)
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
  if (!hasGraphShape(graph)) {
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
      );
      const effectiveQueryDsl = getQueryDslForScenario(scenarioId);

      // Live inputs arrive already-materialised: useDSLReaggregation drove
      // the fetch pipeline (file projection + FE topo + CF) upstream against
      // the live graph state before this call. The branch therefore performs
      // only the per-scenario in-schema re-context (Stage 4(a)) and packages
      // the result; it does NOT call `runScenarioMaterialisation`. Direction
      // of travel (§8.3 Stage 5): live should also flow through the shared
      // boundary once that helper is idempotent on already-materialised state.
      recontextScenarioGraph(scenarioGraph, effectiveQueryDsl, params.resolveParameterFile);

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

    // Doc 73e §8.3 Stage 5 item 1 — fixed recipes use scenario.effective_dsl
    // as ABSOLUTE; custom recipes (default) combine current + delta. This is
    // the only recipe-mode-specific decision in the custom branch — it lives
    // in the caller-shape adapter (here), not in the shared materialisation
    // orchestration (`runScenarioMaterialisation`).
    const isFixed = params.analysisMode === 'fixed';

    // Build prepared scenarios in recipe order, then reorder so 'current'
    // (the base reference) comes first. Bridge uses index 0 as start and
    // index 1 as end — "from base TO variation".
    const builtScenarios: PreparedAnalysisScenario[] = [];
    for (const scenario of customScenarios) {
      const visibilityMode = scenario.visibility_mode || 'f+e';
      const hasScenarioGraph = hasGraphShape(scenario.graph);
      // Caller-shape adapter — turn (recipe scenario) into (scenarioGraph,
      // effectiveQueryDsl). Recipe-specific composition lives here; the
      // post-build pipeline runs uniformly via `runScenarioMaterialisation`.
      let scenarioGraph: Graph = graph;
      if (hasScenarioGraph) {
        // Clone-and-strip so re-contexting and engorgement run on an isolated
        // copy. Without this, `recontextScenarioGraph` would engorge
        // `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors` onto the
        // caller's live graph (73e §8.3 Stage 1 / 73b §3.2). The clone also
        // drops any stale request-only runtime fields the input may already
        // carry, so engorgement always re-attaches fresh state.
        scenarioGraph = cloneGraphWithoutBayesRuntimeFields(scenario.graph as Graph);
      }
      // Prefer caller-provided scenario graph when present. Params remain
      // supported for legacy recipe callers that still pass overlay deltas.
      if (!hasScenarioGraph && scenario.params && (scenario.params.edges || scenario.params.nodes)) {
        scenarioGraph = applyComposedParamsToGraph(scenarioGraph, scenario.params as any);
      }
      if (!hasScenarioGraph && scenario.scenario_id === 'current' && params.frozenWhatIfDsl) {
        scenarioGraph = applyWhatIfToGraph(scenarioGraph, params.frozenWhatIfDsl) as Graph;
      }

      const recipeDsl = scenario.effective_dsl || '';
      const effectiveQueryDsl = isFixed
        // Fixed recipes: the recipe's DSL is the whole DSL. Do not rebase
        // over currentDSL. Apply only the per-chart current-layer constraint
        // if present — that's a local UI override, not the live graph DSL.
        ? composeScenarioDsl(recipeDsl, params.chartCurrentLayerDsl)
        : composeScenarioDsl(
            augmentDSLWithConstraint(params.currentDSL || '', recipeDsl),
            params.chartCurrentLayerDsl,
          );

      const scenarioName = scenario.name || scenario.scenario_id;

      // Shared materialisation: in-schema projection (Stage 4(a)) plus
      // FE topo materialisation (Stage 5 item 7). Custom/fixed/CLI recipes
      // run FE topo here because they did not run the fetch pipeline upstream
      // — that is the laggard-caller fix Stage 5 ships.
      const materialised = await runScenarioMaterialisation(
        scenarioGraph,
        effectiveQueryDsl,
        params.resolveParameterFile,
        params.workspace,
        { scenarioId: scenario.scenario_id, scenarioName },
      );

      builtScenarios.push({
        scenario_id: scenario.scenario_id,
        name: scenarioName,
        colour: scenario.colour || '#808080',
        visibility_mode: visibilityMode,
        graph: materialised.graph,
        effective_query_dsl: effectiveQueryDsl,
        ...(materialised.notFullyMaterialised ? { not_fully_materialised: true } : {}),
        ...(materialised.failures ? { materialisation_failures: materialised.failures } : {}),
      });
    }
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

  console.error(`[diag] needsSnapshots=${params.needsSnapshots} workspace=${!!params.workspace}`);
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
      // Diagnostic: regime inventory summary
      const _regimeEdgeCount = Object.keys(fullRegimeInventory).length;
      if (_regimeEdgeCount > 0) {
        console.error(`[diag] ── Regime inventory: ${_regimeEdgeCount} edges ──`);
        for (const [eid, cands] of Object.entries(fullRegimeInventory)) {
          for (const c of cands as any[]) {
            console.error(`[diag]   ${eid.slice(0, 12)}: hash=${c.core_hash?.slice(0, 16)} mode=${c.temporal_mode || '?'} eq=${(c.equivalent_hashes || []).length} ctx=${JSON.stringify(c.context_keys || [])}`);
          }
        }
      }
    } catch (regimeErr: any) {
      console.error('[diag] buildCandidateRegimesByEdge FAILED:', regimeErr?.message || regimeErr);
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
  // Read-only conditioned forecast: prepared dispatch through the shared CF
  // payload builder (doc 73e §8.3 Stage 2 / 73b §7.1). The prepared graph is
  // already engorged in prep; the dispatcher forwards display_settings,
  // scenario_id, effective_query_dsl, and candidate_regimes_by_edge unchanged.
  // Browser graph-mutating CF enrichment lives on its existing lifecycle in
  // conditionedForecastService.runConditionedForecast — that path is untouched.
  if (prepared.analysisType === 'conditioned_forecast') {
    return graphComputeClient.forecastConditionedScenarios({
      scenarios: prepared.scenarios.map((scenario) => ({
        scenario_id: scenario.scenario_id,
        graph: scenario.graph,
        effective_query_dsl: scenario.effective_query_dsl,
        candidate_regimes_by_edge: scenario.candidate_regimes_by_edge,
        analytics_dsl: scenario.analytics_dsl,
      })),
      analyticsDsl: prepared.analyticsDsl,
      displaySettings: prepared.displaySettings,
    });
  }

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
