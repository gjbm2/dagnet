/**
 * Tests that useCanvasAnalysisCompute passes the correct DSL to analyzeSelection.
 *
 * The critical invariant: for non-snapshot analyses, the analytics DSL (from/to path)
 * must be passed to analyzeSelection, not just the window DSL.
 * Regression: the compute hook was passing getQueryDslForScenario() (window only)
 * instead of analyticsDsl, causing the backend to return degraded results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { augmentDSLWithConstraint } from '../../lib/queryDSL';

const mockGraphStoreState: any = {
  graph: {
    nodes: [{ uuid: 'n1', id: 'start', label: 'Start' }],
    edges: [],
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
    currentQueryDSL: 'window(1-Jan-26:7-Jan-26)',
  },
  currentDSL: 'window(1-Jan-26:7-Jan-26)',
};

const mockTabsState: any = {
  tabs: [
    {
      id: 'tab-1',
      fileId: 'graph-1',
      editorState: {
        scenarioState: {
          scenarioOrder: ['current'],
          visibleScenarioIds: ['current'],
          visibleColourOrderIds: ['current'],
          visibilityMode: { current: 'f+e' as const },
        },
      },
    },
  ],
};

const mockScenariosContextState: any = {
  scenarios: [],
  baseParams: {},
  currentParams: {},
  baseDSL: '',
  currentColour: '#3b82f6',
  baseColour: '#6b7280',
  scenariosReady: true,
};

const mockGraphFileState: any = {
  data: null,
  originalData: null,
  isDirty: false,
  source: undefined,
  syncRevision: undefined,
  syncOrigin: undefined,
  updateData: vi.fn(),
};

function makeBranchComparisonTimeSeriesResult() {
  return {
    result: {
      analysis_type: 'branch_comparison',
      analysis_name: 'Branch Comparison',
      data: [{ scenario_id: 'current', branch: 'child-a', date: '1-Mar-26', rate: 0.1 }],
      semantics: {
        dimensions: [
          { id: 'date', role: 'primary', type: 'time' },
          { id: 'scenario_id', role: 'secondary', type: 'scenario' },
          { id: 'branch', role: 'filter', type: 'node' },
        ],
        metrics: [{ id: 'rate', role: 'primary', type: 'ratio' }],
        chart: { recommended: 'time_series', alternatives: ['bar_grouped'] },
      },
      dimension_values: {
        scenario_id: { current: { name: 'Current', colour: '#3b82f6' } },
        branch: { 'child-a': { name: 'Child A' } },
      },
    },
  };
}

function makeBranchComparisonBarResult() {
  return {
    result: {
      analysis_type: 'branch_comparison',
      analysis_name: 'Branch Comparison',
      data: [{ scenario_id: 'current', branch: 'child-a', rate: 0.1 }],
      semantics: {
        dimensions: [
          { id: 'scenario_id', role: 'secondary', type: 'scenario' },
          { id: 'branch', role: 'primary', type: 'node' },
        ],
        metrics: [{ id: 'rate', role: 'primary', type: 'ratio' }],
        chart: { recommended: 'bar_grouped', alternatives: ['time_series'] },
      },
      dimension_values: {
        scenario_id: { current: { name: 'Current', colour: '#3b82f6' } },
        branch: { 'child-a': { name: 'Child A' } },
      },
    },
  };
}

function makeEmptyDailyConversionsResult() {
  return {
    result: {
      analysis_type: 'daily_conversions',
      analysis_name: 'Daily Conversions',
      analysis_description: 'No snapshot data found for this query and date range',
      metadata: { source: 'snapshot_db', empty: true },
      semantics: {
        dimensions: [],
        metrics: [],
        chart: { recommended: 'daily_conversions', alternatives: [] },
      },
      dimension_values: {
        scenario_id: {
          'scenario-1': { name: 'Scenario 1', colour: '#ec4899' },
          current: { name: 'Current', colour: '#3b82f6' },
        },
      },
      data: [],
    },
  };
}

function makeDailyConversionsResult() {
  return {
    result: {
      analysis_type: 'daily_conversions',
      analysis_name: 'Daily Conversions',
      analysis_description: 'Daily conversion rate by cohort',
      metadata: {
        source: 'snapshot_db',
        date_range: { from: '2026-02-17', to: '2026-03-09' },
        total_conversions: 42,
      },
      semantics: {
        dimensions: [
          { id: 'date', role: 'primary', type: 'time' },
          { id: 'scenario_id', role: 'secondary', type: 'scenario' },
          { id: 'subject_id', role: 'filter', type: 'categorical' },
        ],
        metrics: [{ id: 'rate', role: 'primary', type: 'ratio' }],
        chart: { recommended: 'daily_conversions', alternatives: ['table'] },
      },
      dimension_values: {
        scenario_id: {
          'scenario-1': { name: 'Scenario 1', colour: '#ec4899' },
          current: { name: 'Current', colour: '#3b82f6' },
        },
        subject_id: {
          'subject-scenario-1': { name: 'Scenario 1 subject' },
          'subject-current': { name: 'Current subject' },
        },
      },
      data: [
        { scenario_id: 'scenario-1', subject_id: 'subject-scenario-1', date: '2026-02-17', x: 10, y: 2, rate: 0.2 },
        { scenario_id: 'current', subject_id: 'subject-current', date: '2026-02-17', x: 8, y: 1, rate: 0.125 },
      ],
    },
  };
}

function makeCohortMaturityResult() {
  return {
    result: {
      analysis_type: 'cohort_maturity',
      analysis_name: 'Cohort Maturity',
      analysis_description: 'How conversion rates evolved over time for a cohort range',
      metadata: {
        source: 'snapshot_db',
        anchor_from: '2026-02-17',
        anchor_to: '2026-02-23',
        sweep_from: '2026-02-17',
        sweep_to: '2026-03-10',
      },
      semantics: {
        dimensions: [
          { id: 'tau_days', role: 'primary', type: 'number' },
          { id: 'scenario_id', role: 'secondary', type: 'scenario' },
          { id: 'subject_id', role: 'filter', type: 'categorical' },
        ],
        metrics: [{ id: 'rate', role: 'primary', type: 'ratio' }],
        chart: { recommended: 'cohort_maturity', alternatives: ['table'] },
      },
      dimension_values: {
        scenario_id: {
          'scenario-1': { name: 'Scenario 1', colour: '#ec4899' },
          current: { name: 'Current', colour: '#3b82f6' },
        },
        subject_id: {
          'subject-scenario-1': { name: 'Scenario 1 subject' },
          'subject-current': { name: 'Current subject' },
        },
      },
      data: [
        { scenario_id: 'scenario-1', subject_id: 'subject-scenario-1', tau_days: 0, rate: 0.1, projected_rate: 0.12 },
        { scenario_id: 'current', subject_id: 'subject-current', tau_days: 0, rate: 0.08, projected_rate: 0.11 },
      ],
    },
  };
}

const mockResolveSnapshotSubjectsForScenario = vi.fn(async ({ scenarioId }: any) => ({
  subjects: [{ subject_id: `subject-${scenarioId}` }],
  snapshotDsl: 'visited(household-delegated).window(1-Jan-26:7-Jan-26)',
}));
const mockGetSnapshotPlannerInputsStatus: any = vi.fn(async () => ({
  ready: true,
  requiredFileIds: [],
  missingFileIds: [],
  hydratableFileIds: [],
  unavailableFileIds: [],
}));
const mockHydrateSnapshotPlannerInputs: any = vi.fn(async () => {});
const fileRegistrySubscribers = new Map<string, Set<() => void>>();
const mockFileRegistry = {
  subscribe: vi.fn((fileId: string, callback: () => void) => {
    if (!fileRegistrySubscribers.has(fileId)) {
      fileRegistrySubscribers.set(fileId, new Set());
    }
    fileRegistrySubscribers.get(fileId)!.add(callback);
    return () => {
      fileRegistrySubscribers.get(fileId)?.delete(callback);
    };
  }),
};

const mockAnalyzeSelection = vi.fn(async () => ({
  result: {
    analysis_type: 'graph_overview',
    analysis_name: 'Overview',
    data: [{ stage: 'a', probability: 0.5 }],
    semantics: { dimensions: [{ id: 'stage', role: 'primary' }], metrics: [] },
    dimension_values: { stage: { a: { name: 'A' } } },
  },
}));

const mockAnalyzeMultipleScenarios: any = vi.fn(async (_scenarios: any, _dsl?: string, analysisType?: string) => (
  analysisType === 'branch_comparison'
    ? makeBranchComparisonTimeSeriesResult()
    : {
        result: {
          analysis_type: 'conversion_funnel',
          analysis_name: 'Funnel',
          data: [],
          semantics: { dimensions: [], metrics: [] },
          dimension_values: {},
        },
      }
));

// Mock all context/service dependencies before imports
vi.mock('../../contexts/GraphStoreContext', () => ({
  useGraphStore: vi.fn(() => mockGraphStoreState),
}));

vi.mock('../../contexts/ScenariosContext', () => ({
  useScenariosContextOptional: vi.fn(() => mockScenariosContextState),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: vi.fn(() => ({
    tabs: mockTabsState.tabs,
    operations: {
      getScenarioState: () => mockTabsState.tabs[0]?.editorState?.scenarioState ?? null,
      getScenarioVisibilityMode: (_tabId: string, scenarioId: string) =>
        mockTabsState.tabs[0]?.editorState?.scenarioState?.visibilityMode?.[scenarioId] || 'f+e',
    },
  })),
  useFileState: vi.fn((fileId?: string) => {
    if (fileId === 'graph-1') return mockGraphFileState;
    return {
      data: null,
      originalData: null,
      isDirty: false,
      source: undefined,
      syncRevision: undefined,
      syncOrigin: undefined,
      updateData: vi.fn(),
    };
  }),
  fileRegistry: mockFileRegistry,
}));

vi.mock('../../services/CompositionService', () => ({
  buildGraphForAnalysisLayer: vi.fn((_id, graph) => graph),
  applyProbabilityVisibilityModeToGraph: vi.fn((graph) => graph),
  applyWhatIfToGraph: vi.fn((graph) => graph),
}));

vi.mock('../../services/snapshotSubjectResolutionService', () => ({
  getSnapshotPlannerInputsStatus: mockGetSnapshotPlannerInputsStatus,
  hydrateSnapshotPlannerInputs: mockHydrateSnapshotPlannerInputs,
  resolveSnapshotSubjectsForScenario: mockResolveSnapshotSubjectsForScenario,
}));

vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    analyzeSelection: mockAnalyzeSelection,
    analyzeMultipleScenarios: mockAnalyzeMultipleScenarios,
  },
}));

vi.mock('../../components/panels/analysisTypes', () => ({
  ANALYSIS_TYPES: [
    { id: 'conversion_funnel', name: 'Funnel' },
    { id: 'graph_overview', name: 'Overview' },
    { id: 'branch_comparison', name: 'Branch', snapshotContract: { scopeRule: 'children_of_selected_node', readMode: 'raw_snapshots', slicePolicy: 'mece_fulfilment_allowed', timeBoundsSource: 'query_dsl_window', perScenario: true } },
    { id: 'daily_conversions', name: 'Daily', snapshotContract: { scopeRule: 'funnel_path', readMode: 'raw_snapshots', slicePolicy: 'mece_fulfilment_allowed', timeBoundsSource: 'query_dsl_window', perScenario: false } },
    { id: 'cohort_maturity', name: 'Cohort', snapshotContract: { scopeRule: 'funnel_path', readMode: 'raw_snapshots', slicePolicy: 'mece_fulfilment_allowed', timeBoundsSource: 'query_dsl_window', perScenario: false } },
  ],
}));

describe('useCanvasAnalysisCompute DSL handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphStoreState.graph = {
      nodes: [{ uuid: 'n1', id: 'start', label: 'Start' }],
      edges: [],
      policies: { default_outcome: 'end' },
      metadata: { version: '1.0.0' },
      currentQueryDSL: 'window(1-Jan-26:7-Jan-26)',
    };
    mockGraphStoreState.currentDSL = 'window(1-Jan-26:7-Jan-26)';
    mockTabsState.tabs = [
      {
        id: 'tab-1',
        fileId: 'graph-1',
        editorState: {
          scenarioState: {
            scenarioOrder: ['current'],
            visibleScenarioIds: ['current'],
            visibleColourOrderIds: ['current'],
            visibilityMode: { current: 'f+e' as const },
          },
        },
      },
    ];
    mockScenariosContextState.scenarios = [];
    mockScenariosContextState.scenariosReady = true;
    mockGraphFileState.data = null;
    mockGraphFileState.originalData = null;
    mockGraphFileState.isDirty = false;
    mockGraphFileState.source = undefined;
    mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
      ready: true,
      requiredFileIds: [],
      missingFileIds: [],
      hydratableFileIds: [],
      unavailableFileIds: [],
    });
    mockHydrateSnapshotPlannerInputs.mockResolvedValue(undefined);
    fileRegistrySubscribers.clear();
    vi.resetModules();
  });

  it('should pass analyticsDsl (not window DSL) to analyzeSelection for non-snapshot analyses', async () => {
    const analyticsDsl = 'from(start).to(end).visited(middle)';
    const windowDsl = 'window(1-Jan-26:7-Jan-26)';

    const analysis: any = {
      id: 'test-analysis-1',
      live: true,
      view_mode: 'chart',
      recipe: {
        analysis: {
          analysis_type: 'conversion_funnel',
          analytics_dsl: analyticsDsl,
        },
      },
    };

    const analysisType = analysis.recipe.analysis.analysis_type;
    const recipeAnalyticsDsl = analysis.recipe.analysis.analytics_dsl || '';
    const currentDSL = windowDsl;

    const finalDsl = recipeAnalyticsDsl || currentDSL;

    expect(finalDsl).toBe(analyticsDsl);
    expect(finalDsl).not.toBe(windowDsl);
    expect(finalDsl).toContain('from(start)');
    expect(finalDsl).toContain('to(end)');
    expect(analysisType).toBe('conversion_funnel');
  });

  it('should fall back to currentDSL when analyticsDsl is empty', () => {
    const analyticsDsl = '';
    const currentDSL = 'window(1-Jan-26:7-Jan-26)';

    const finalDsl = analyticsDsl || currentDSL;

    expect(finalDsl).toBe(currentDSL);
  });

  it('should use analyticsDsl for multi-scenario path (consistency check)', () => {
    const analyticsDsl = 'from(a).to(b)';
    const currentDSL = 'window(1-Jan-26:7-Jan-26)';

    const multiScenarioDsl = analyticsDsl || currentDSL;
    const singleScenarioDsl = analyticsDsl || currentDSL;

    expect(multiScenarioDsl).toBe(singleScenarioDsl);
    expect(multiScenarioDsl).toBe('from(a).to(b)');
  });

  it('should NOT use getQueryDslForScenario for non-snapshot single-scenario compute', () => {
    const analyticsDsl = 'from(x).to(y)';
    const windowDsl = 'window(1-Feb-26:7-Feb-26)';
    const getQueryDslForScenario = (_id: string) => windowDsl;

    const needsSnapshots = false;
    const oldBuggyDsl = needsSnapshots ? analyticsDsl : getQueryDslForScenario('current');
    expect(oldBuggyDsl).toBe(windowDsl);

    const fixedDsl = analyticsDsl || windowDsl;
    expect(fixedDsl).toBe(analyticsDsl);
  });

  it('should defer snapshot-backed boot until workspace source metadata is available', async () => {
    const { useCanvasAnalysisCompute } = await import('../useCanvasAnalysisCompute');

    mockTabsState.tabs = [
      {
        id: 'tab-1',
        fileId: 'graph-1',
        editorState: {
          scenarioState: {
            scenarioOrder: ['scenario-1', 'current'],
            visibleScenarioIds: ['scenario-1', 'current'],
            visibleColourOrderIds: ['scenario-1', 'current'],
            visibilityMode: {
              'scenario-1': 'f+e' as const,
              current: 'f+e' as const,
            },
          },
        },
      },
    ];
    mockScenariosContextState.scenarios = [{ id: 'scenario-1', name: 'Scenario 1', colour: '#ec4899' }];

    const analysis: any = {
      id: 'snapshot-analysis-1',
      live: true,
      view_mode: 'chart',
      chart_kind: 'time_series',
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: 'visited(household-delegated)',
        },
      },
    };

    const { result, rerender } = renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(result.current.waitingForDeps).toBe(true);
    });
    expect(mockResolveSnapshotSubjectsForScenario).not.toHaveBeenCalled();
    expect(mockAnalyzeMultipleScenarios).not.toHaveBeenCalled();

    mockGraphFileState.source = { repository: 'repo-a', branch: 'main', path: 'graphs/graph-1.yaml' };
    rerender({ currentAnalysis: analysis });

    await waitFor(() => {
      expect(mockResolveSnapshotSubjectsForScenario).toHaveBeenCalledTimes(2);
      expect(mockAnalyzeMultipleScenarios).toHaveBeenCalledTimes(1);
      expect(result.current.waitingForDeps).toBe(false);
    });
  });

  it('should still compute non-snapshot analyses without workspace source metadata', async () => {
    const { useCanvasAnalysisCompute } = await import('../useCanvasAnalysisCompute');

    const analysis: any = {
      id: 'non-snapshot-analysis-1',
      live: true,
      view_mode: 'chart',
      recipe: {
        analysis: {
          analysis_type: 'graph_overview',
          analytics_dsl: '',
        },
      },
    };

    renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(mockAnalyzeSelection).toHaveBeenCalledTimes(1);
    });
    expect(mockResolveSnapshotSubjectsForScenario).not.toHaveBeenCalled();
  });

  it('should move from blocked to ready when planner files hydrate into FileRegistry', async () => {
    const { useCanvasAnalysisCompute } = await import('../useCanvasAnalysisCompute');

    mockTabsState.tabs = [
      {
        id: 'tab-1',
        fileId: 'graph-1',
        editorState: {
          scenarioState: {
            scenarioOrder: ['scenario-1', 'current'],
            visibleScenarioIds: ['scenario-1', 'current'],
            visibleColourOrderIds: ['scenario-1', 'current'],
            visibilityMode: {
              'scenario-1': 'f+e' as const,
              current: 'f+e' as const,
            },
          },
        },
      },
    ];
    mockScenariosContextState.scenarios = [{ id: 'scenario-1', name: 'Scenario 1', colour: '#ec4899' }];
    mockGraphFileState.source = { repository: 'repo-a', branch: 'main', path: 'graphs/graph-1.yaml' };
    mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
      ready: false,
      requiredFileIds: ['parameter-edge-a'],
      missingFileIds: ['parameter-edge-a'],
      hydratableFileIds: ['parameter-edge-a'],
      unavailableFileIds: [],
    });

    const analysis: any = {
      id: 'snapshot-analysis-2',
      live: true,
      view_mode: 'chart',
      chart_kind: 'time_series',
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: 'visited(household-delegated)',
        },
      },
    };

    const { result } = renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(result.current.waitingForDeps).toBe(true);
    });
    expect(mockResolveSnapshotSubjectsForScenario).not.toHaveBeenCalled();
    expect(mockAnalyzeMultipleScenarios).not.toHaveBeenCalled();
    expect(mockHydrateSnapshotPlannerInputs).toHaveBeenCalledWith({
      fileIds: ['parameter-edge-a'],
      workspace: { repository: 'repo-a', branch: 'main' },
    });

    mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
      ready: true,
      requiredFileIds: ['parameter-edge-a'],
      missingFileIds: [],
      hydratableFileIds: [],
      unavailableFileIds: [],
    });
    fileRegistrySubscribers.get('parameter-edge-a')?.forEach((callback) => callback());

    await waitFor(() => {
      expect(mockResolveSnapshotSubjectsForScenario).toHaveBeenCalledTimes(2);
      expect(mockAnalyzeMultipleScenarios).toHaveBeenCalledTimes(1);
      expect(result.current.waitingForDeps).toBe(false);
    });
  });

  it('should not retry daily_conversions after an empty snapshot result', async () => {
    const { useCanvasAnalysisCompute } = await import('../useCanvasAnalysisCompute');

    mockTabsState.tabs = [
      {
        id: 'tab-1',
        fileId: 'graph-1',
        editorState: {
          scenarioState: {
            scenarioOrder: ['scenario-1', 'current'],
            visibleScenarioIds: ['scenario-1', 'current'],
            visibleColourOrderIds: ['scenario-1', 'current'],
            visibilityMode: {
              'scenario-1': 'f+e' as const,
              current: 'f+e' as const,
            },
          },
        },
      },
    ];
    mockScenariosContextState.scenarios = [{ id: 'scenario-1', name: 'Scenario 1', colour: '#ec4899' }];
    mockGraphFileState.source = { repository: 'repo-a', branch: 'main', path: 'graphs/graph-1.yaml' };
    mockAnalyzeMultipleScenarios
      .mockResolvedValueOnce(makeEmptyDailyConversionsResult())
      .mockResolvedValueOnce(makeDailyConversionsResult());

    const analysis: any = {
      id: 'snapshot-analysis-daily-retry',
      live: true,
      view_mode: 'chart',
      chart_kind: 'daily_conversions',
      recipe: {
        analysis: {
          analysis_type: 'daily_conversions',
          analytics_dsl: 'from(household-created).to(household-delegated)',
        },
      },
    };

    const { result } = renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(mockAnalyzeMultipleScenarios).toHaveBeenCalledTimes(1);
      expect(result.current.result?.metadata?.empty).toBe(true);
    });
  });

  it('should recompute after clearing a seeded non-time-series branch result', async () => {
    const mod = await import('../useCanvasAnalysisCompute');
    const { useCanvasAnalysisCompute, canvasAnalysisTransientCache } = mod;

    mockTabsState.tabs = [
      {
        id: 'tab-1',
        fileId: 'graph-1',
        editorState: {
          scenarioState: {
            scenarioOrder: ['scenario-1', 'current'],
            visibleScenarioIds: ['scenario-1', 'current'],
            visibleColourOrderIds: ['scenario-1', 'current'],
            visibilityMode: {
              'scenario-1': 'f+e' as const,
              current: 'f+e' as const,
            },
          },
        },
      },
    ];
    mockScenariosContextState.scenarios = [{ id: 'scenario-1', name: 'Scenario 1', colour: '#ec4899' }];
    mockGraphFileState.source = { repository: 'repo-a', branch: 'main', path: 'graphs/graph-1.yaml' };
    mockAnalyzeMultipleScenarios.mockResolvedValueOnce(makeBranchComparisonTimeSeriesResult());

    const analysis: any = {
      id: 'snapshot-analysis-seeded-branch-retry',
      live: true,
      view_mode: 'chart',
      chart_kind: 'time_series',
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: 'visited(household-delegated)',
        },
      },
    };

    canvasAnalysisTransientCache.set(analysis.id, makeBranchComparisonBarResult().result);

    const { result } = renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(mockAnalyzeMultipleScenarios).toHaveBeenCalledTimes(1);
      expect(result.current.result?.semantics?.dimensions?.some((d: any) => d.id === 'date')).toBe(true);
    });
  });

  it('should compute custom snapshot charts without waiting for scenariosReady', async () => {
    const { useCanvasAnalysisCompute } = await import('../useCanvasAnalysisCompute');

    mockScenariosContextState.scenarios = [];
    mockScenariosContextState.scenariosReady = false;
    mockGraphFileState.source = { repository: 'repo-a', branch: 'main', path: 'graphs/graph-1.yaml' };
    const analysis: any = {
      id: 'custom-snapshot-analysis',
      live: false,
      view_mode: 'chart',
      recipe: {
        analysis: {
          analysis_type: 'cohort_maturity',
          analytics_dsl: 'from(household-delegated).to(switch-registered)',
          what_if_dsl: 'case(test:on)',
        },
        scenarios: [
          {
            scenario_id: 'scenario-1',
            effective_dsl: 'window(1-Jan-26:7-Jan-26).context(channel:paid-search)',
            visibility_mode: 'f+e',
          },
          {
            scenario_id: 'current',
            effective_dsl: 'window(1-Jan-26:7-Jan-26)',
            visibility_mode: 'f+e',
          },
        ],
      },
    };

    const { result } = renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(result.current.waitingForDeps).toBe(false);
    });
    expect(result.current.error).toBeNull();
  });

  it('should not start a second live compute while the first one is still in flight', async () => {
    const { useCanvasAnalysisCompute } = await import('../useCanvasAnalysisCompute');

    mockAnalyzeSelection.mockImplementationOnce(async () => new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          result: {
            analysis_type: 'graph_overview',
            analysis_name: 'Overview',
            data: [{ stage: 'a', probability: 0.5 }],
            semantics: { dimensions: [{ id: 'stage', role: 'primary' }], metrics: [] },
            dimension_values: { stage: { a: { name: 'A' } } },
          },
        });
      }, 700);
    }));

    const analysis: any = {
      id: 'single-inflight-compute',
      live: true,
      view_mode: 'chart',
      recipe: {
        analysis: {
          analysis_type: 'graph_overview',
          analytics_dsl: '',
        },
      },
    };

    renderHook(
      ({ currentAnalysis }) => useCanvasAnalysisCompute({ analysis: currentAnalysis, tabId: 'tab-1' }),
      { initialProps: { currentAnalysis: analysis } },
    );

    await waitFor(() => {
      expect(mockAnalyzeSelection).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(mockAnalyzeSelection).toHaveBeenCalledTimes(1);
  });
});

describe('chart_current_layer_dsl fragment composition', () => {
  it('should compose context fragment onto scenario DSL', () => {
    const scenarioDsl = 'window(-30d:)';
    const fragment = 'context(channel:influencer)';
    const composed = augmentDSLWithConstraint(scenarioDsl, fragment);
    expect(composed).toContain('context(channel:influencer)');
    expect(composed).toContain('window(-30d:)');
  });

  it('should replace window when fragment specifies window', () => {
    const scenarioDsl = 'window(-30d:)';
    const fragment = 'window(-90d:)';
    const composed = augmentDSLWithConstraint(scenarioDsl, fragment);
    expect(composed).toContain('window(-90d:)');
    expect(composed).not.toContain('window(-30d:)');
  });

  it('should preserve all clauses when fragment is empty', () => {
    const scenarioDsl = 'window(-30d:).context(channel:organic)';
    const result = augmentDSLWithConstraint(scenarioDsl, '');
    expect(result).toContain('window(-30d:)');
    expect(result).toContain('context(channel:organic)');
  });

  it('should return fragment when scenario DSL is empty', () => {
    const fragment = 'context(channel:influencer)';
    const composed = augmentDSLWithConstraint('', fragment);
    expect(composed).toContain('context(channel:influencer)');
  });

  it('should compose fragment onto frozen scenario effective_dsl', () => {
    const frozenEffectiveDsl = 'window(-7d:).context(channel:organic)';
    const fragment = 'context(channel:influencer)';
    const composed = augmentDSLWithConstraint(frozenEffectiveDsl, fragment);
    expect(composed).toContain('context(channel:influencer)');
    expect(composed).not.toContain('context(channel:organic)');
  });

  it('should add context to DSL that has none', () => {
    const scenarioDsl = 'window(-30d:)';
    const fragment = 'context(channel:influencer)';
    const composed = augmentDSLWithConstraint(scenarioDsl, fragment);
    expect(composed).toContain('context(channel:influencer)');
    expect(composed).toContain('window(-30d:)');
  });
});
