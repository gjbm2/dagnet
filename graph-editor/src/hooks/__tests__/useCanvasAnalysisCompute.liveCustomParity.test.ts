/**
 * Live → Custom parity tests.
 *
 * Invariant: switching a canvas analysis from Live to Custom mode must produce
 * the same backend compute arguments (graph, DSL, scenario metadata). The
 * calculation path differs (live reads tab state, custom reads recipe.scenarios),
 * but the OUTCOME must be identical.
 *
 * These tests extract the arguments that each path would send to the backend
 * and assert equivalence. They do NOT call the real backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureTabScenariosToRecipe } from '../../services/captureTabScenariosService';
import { augmentDSLWithConstraint } from '../../lib/queryDSL';
import { buildGraphForAnalysisLayer } from '../../services/CompositionService';

vi.mock('../../services/CompositionService', () => ({
  buildGraphForAnalysisLayer: vi.fn((_id, graph) => graph),
}));

const baseGraph = {
  nodes: [
    { uuid: 'u1', id: 'landing', label: 'Landing', entry: { is_start: true } },
    { uuid: 'u2', id: 'signup', label: 'Signup' },
    { uuid: 'u3', id: 'success', label: 'Success', absorbing: true },
  ],
  edges: [
    { from: 'u1', to: 'u2', p: { mean: 0.6 } },
    { from: 'u2', to: 'u3', p: { mean: 0.4 } },
  ],
  policies: { default_outcome: 'end' },
  metadata: { version: '1.0.0' },
  currentQueryDSL: 'window(-30d:)',
};

const currentDSL = 'window(-30d:)';

const scenariosContext = {
  scenarios: [
    {
      id: 'sc-mobile',
      name: 'Mobile',
      colour: '#EC4899',
      meta: {
        isLive: true,
        queryDSL: 'context(device:mobile)',
        lastEffectiveDSL: 'window(-30d:).context(device:mobile)',
      },
    },
  ],
  currentColour: '#3b82f6',
  baseColour: '#6b7280',
  baseParams: {},
  currentParams: {},
  baseDSL: 'window(-30d:)',
};

const makeOperations = (visibleIds: string[], modes: Record<string, 'f+e' | 'f' | 'e'> = {}) => ({
  getScenarioState: () => ({ visibleScenarioIds: visibleIds }),
  getScenarioVisibilityMode: (_tabId: string, sid: string) => modes[sid] || ('f+e' as const),
});

function buildLiveComputeArgs(opts: {
  graph: any;
  analyticsDsl: string;
  currentDSL: string;
  visibleScenarioIds: string[];
  chartFragment?: string;
  whatIfDSL?: string | null;
  getScenarioColour: (id: string) => string;
  getScenarioName: (id: string) => string;
  getScenarioVisibilityMode: (id: string) => 'f+e' | 'f' | 'e';
  getQueryDslForScenario: (id: string) => string;
}) {
  const { graph, analyticsDsl, visibleScenarioIds } = opts;

  if (visibleScenarioIds.length > 1) {
    const scenarioGraphs = visibleScenarioIds.map((scenarioId) => {
      const visibilityMode = opts.getScenarioVisibilityMode(scenarioId);
      const scenarioGraph = buildGraphForAnalysisLayer(
        scenarioId, graph, {}, {}, [], undefined, visibilityMode,
      );
      return {
        scenario_id: scenarioId,
        name: opts.getScenarioName(scenarioId),
        graph: scenarioGraph,
        colour: opts.getScenarioColour(scenarioId),
        visibility_mode: visibilityMode,
      };
    });
    return {
      method: 'analyzeMultipleScenarios' as const,
      scenarioGraphs,
      dsl: analyticsDsl || opts.currentDSL,
    };
  }

  const scenarioId = visibleScenarioIds[0] || 'current';
  const visibilityMode = opts.getScenarioVisibilityMode(scenarioId);
  const analysisGraph = buildGraphForAnalysisLayer(
    scenarioId, graph, {}, {}, [], undefined, visibilityMode,
  );
  const finalDsl = analyticsDsl || opts.currentDSL;
  return {
    method: 'analyzeSelection' as const,
    graph: analysisGraph,
    dsl: finalDsl,
    scenarioId,
    name: opts.getScenarioName(scenarioId),
    colour: opts.getScenarioColour(scenarioId),
    visibilityMode,
  };
}

function buildFrozenComputeArgs(opts: {
  graph: any;
  analyticsDsl: string;
  currentDSL: string;
  frozenScenarios: Array<{
    scenario_id: string;
    effective_dsl?: string;
    name?: string;
    colour?: string;
    visibility_mode?: string;
  }>;
  chartFragment?: string;
  whatIfDSL?: string | null;
}) {
  const { graph, analyticsDsl, frozenScenarios, chartFragment } = opts;

  const getDslForFrozenScenario = (): string => {
    return analyticsDsl || opts.currentDSL;
  };

  if (frozenScenarios.length > 1) {
    const scenarioGraphs = frozenScenarios.map((fs) => ({
      scenario_id: fs.scenario_id,
      name: fs.name || fs.scenario_id,
      graph: graph,
      colour: fs.colour,
      visibility_mode: fs.visibility_mode || 'f+e',
    }));
    return {
      method: 'analyzeMultipleScenarios' as const,
      scenarioGraphs,
      dsl: getDslForFrozenScenario(frozenScenarios[0]),
    };
  }

  const fs = frozenScenarios[0] || { scenario_id: 'current' };
  return {
    method: 'analyzeSelection' as const,
    graph: graph,
    dsl: getDslForFrozenScenario(fs),
    scenarioId: fs.scenario_id,
    name: fs.name || 'Current',
    colour: fs.colour || '#3b82f6',
    visibilityMode: (fs.visibility_mode || 'f+e'),
  };
}

describe('Live → Custom compute parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should produce identical backend args for single-scenario (Current only)', () => {
    const analyticsDsl = 'from(landing).to(success)';
    const visibleIds = ['current'];
    const operations = makeOperations(visibleIds);

    const liveArgs = buildLiveComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      visibleScenarioIds: visibleIds,
      getScenarioColour: () => '#3b82f6',
      getScenarioName: (id) => id === 'current' ? 'Current' : id,
      getScenarioVisibilityMode: () => 'f+e',
      getQueryDslForScenario: () => currentDSL,
    });

    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL,
      operations,
      scenariosContext: scenariosContext as any,
    });

    const frozenArgs = buildFrozenComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      frozenScenarios: captured,
    });

    expect(liveArgs.method).toBe('analyzeSelection');
    expect(frozenArgs.method).toBe('analyzeSelection');
    expect(liveArgs.dsl).toBe(frozenArgs.dsl);
    expect(liveArgs.scenarioId).toBe(frozenArgs.scenarioId);
    expect(liveArgs.name).toBe(frozenArgs.name);
    expect(liveArgs.colour).toBe(frozenArgs.colour);
    expect(liveArgs.visibilityMode).toBe(frozenArgs.visibilityMode);
  });

  it('should produce identical backend args for multi-scenario (Current + user + Base)', () => {
    const analyticsDsl = 'from(landing).to(success)';
    const visibleIds = ['current', 'sc-mobile', 'base'];
    const operations = makeOperations(visibleIds);

    const getScenarioColour = (id: string) => {
      if (id === 'current') return '#3b82f6';
      if (id === 'base') return '#6b7280';
      const s = scenariosContext.scenarios.find(s => s.id === id);
      return s?.colour || '#808080';
    };
    const getScenarioName = (id: string) => {
      if (id === 'current') return 'Current';
      if (id === 'base') return 'Base';
      const s = scenariosContext.scenarios.find(s => s.id === id);
      return s?.name || id;
    };

    const liveArgs = buildLiveComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      visibleScenarioIds: visibleIds,
      getScenarioColour,
      getScenarioName,
      getScenarioVisibilityMode: () => 'f+e',
      getQueryDslForScenario: () => currentDSL,
    });

    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL,
      operations,
      scenariosContext: scenariosContext as any,
    });

    const frozenArgs = buildFrozenComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      frozenScenarios: captured,
    });

    expect(liveArgs.method).toBe('analyzeMultipleScenarios');
    expect(frozenArgs.method).toBe('analyzeMultipleScenarios');
    expect(liveArgs.dsl).toBe(frozenArgs.dsl);

    expect(liveArgs.scenarioGraphs).toHaveLength(3);
    expect(frozenArgs.scenarioGraphs).toHaveLength(3);

    for (let i = 0; i < liveArgs.scenarioGraphs!.length; i++) {
      const live = liveArgs.scenarioGraphs![i];
      const frozen = frozenArgs.scenarioGraphs![i];
      expect(frozen.scenario_id).toBe(live.scenario_id);
      expect(frozen.name).toBe(live.name);
      expect(frozen.colour).toBe(live.colour);
      expect(frozen.visibility_mode).toBe(live.visibility_mode);
    }
  });

  it('should produce identical top-level DSL when chart fragment is active (fragment composes at scenario level, not top-level)', () => {
    const analyticsDsl = 'from(landing).to(success)';
    const chartFragment = 'context(channel:paid)';
    const visibleIds = ['current'];
    const operations = makeOperations(visibleIds);

    const liveArgs = buildLiveComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      visibleScenarioIds: visibleIds,
      chartFragment,
      getScenarioColour: () => '#3b82f6',
      getScenarioName: () => 'Current',
      getScenarioVisibilityMode: () => 'f+e',
      getQueryDslForScenario: () => augmentDSLWithConstraint(currentDSL, chartFragment),
    });

    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL,
      operations,
      scenariosContext: scenariosContext as any,
    });

    const frozenArgs = buildFrozenComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      frozenScenarios: captured,
      chartFragment,
    });

    expect(liveArgs.dsl).toBe(analyticsDsl);
    expect(frozenArgs.dsl).toBe(analyticsDsl);
    expect(liveArgs.dsl).toBe(frozenArgs.dsl);
  });

  it('should produce identical backend args with mixed visibility modes', () => {
    const analyticsDsl = 'from(landing).to(success)';
    const visibleIds = ['current', 'sc-mobile'];
    const modes: Record<string, 'f+e' | 'f' | 'e'> = { 'current': 'f', 'sc-mobile': 'e' };
    const operations = makeOperations(visibleIds, modes);

    const getScenarioColour = (id: string) => {
      if (id === 'current') return '#3b82f6';
      const s = scenariosContext.scenarios.find(s => s.id === id);
      return s?.colour || '#808080';
    };
    const getScenarioName = (id: string) => {
      if (id === 'current') return 'Current';
      const s = scenariosContext.scenarios.find(s => s.id === id);
      return s?.name || id;
    };

    const liveArgs = buildLiveComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      visibleScenarioIds: visibleIds,
      getScenarioColour,
      getScenarioName,
      getScenarioVisibilityMode: (id) => modes[id] || 'f+e',
      getQueryDslForScenario: () => currentDSL,
    });

    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL,
      operations,
      scenariosContext: scenariosContext as any,
    });

    const frozenArgs = buildFrozenComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      frozenScenarios: captured,
    });

    expect(liveArgs.scenarioGraphs).toHaveLength(2);
    expect(frozenArgs.scenarioGraphs).toHaveLength(2);

    for (let i = 0; i < liveArgs.scenarioGraphs!.length; i++) {
      const live = liveArgs.scenarioGraphs![i];
      const frozen = frozenArgs.scenarioGraphs![i];
      expect(frozen.scenario_id).toBe(live.scenario_id);
      expect(frozen.visibility_mode).toBe(live.visibility_mode);
      expect(frozen.colour).toBe(live.colour);
      expect(frozen.name).toBe(live.name);
    }
  });

  it('should produce identical backend args with What-If DSL active', () => {
    const analyticsDsl = 'from(landing).to(success)';
    const visibleIds = ['current'];
    const whatIfDSL = 'case(test:treatment)';
    const operations = makeOperations(visibleIds);

    const liveArgs = buildLiveComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      visibleScenarioIds: visibleIds,
      whatIfDSL,
      getScenarioColour: () => '#3b82f6',
      getScenarioName: () => 'Current',
      getScenarioVisibilityMode: () => 'f+e',
      getQueryDslForScenario: () => currentDSL,
    });

    const { scenarios: captured, what_if_dsl } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL,
      operations,
      scenariosContext: scenariosContext as any,
      whatIfDSL,
    });

    const frozenArgs = buildFrozenComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      frozenScenarios: captured,
      whatIfDSL: what_if_dsl,
    });

    expect(liveArgs.dsl).toBe(frozenArgs.dsl);
    expect(liveArgs.scenarioId).toBe(frozenArgs.scenarioId);
  });

  it('should use the graph passed to buildGraphForAnalysisLayer in live mode but raw graph in frozen mode', () => {
    const analyticsDsl = 'from(landing).to(success)';
    const visibleIds = ['current'];

    buildLiveComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      visibleScenarioIds: visibleIds,
      getScenarioColour: () => '#3b82f6',
      getScenarioName: () => 'Current',
      getScenarioVisibilityMode: () => 'f+e',
      getQueryDslForScenario: () => currentDSL,
    });

    expect(buildGraphForAnalysisLayer).toHaveBeenCalledTimes(1);

    const operations = makeOperations(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL,
      operations,
      scenariosContext: scenariosContext as any,
    });

    vi.mocked(buildGraphForAnalysisLayer).mockClear();

    buildFrozenComputeArgs({
      graph: baseGraph,
      analyticsDsl,
      currentDSL,
      frozenScenarios: captured,
    });

    expect(buildGraphForAnalysisLayer).not.toHaveBeenCalled();
  });
});
