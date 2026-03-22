/**
 * Content item spec tests — written from the SPEC, not the implementation.
 *
 * These tests describe what SHOULD happen. If they fail, the code is wrong.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ── Spec: Content item schema ──────────────────────────────────────────────
//
// A ContentItem has three core fields:
//   analysis_type: string   — what to compute
//   view_type: 'chart' | 'cards' | 'table' — rendering mode
//   kind: string            — variant within analysis_type × view_type
//
// There is NO chart_kind field. There is NO facet field.
// The container-level CanvasAnalysis.chart_kind exists for legacy persistence only.

// ── Spec: Registry ─────────────────────────────────────────────────────────
//
// The ANALYSIS_TYPES registry declares valid view_type → kind[] per analysis type.
// getKindsForView(analysisTypeId, viewType) returns KindMeta[] from the registry.
// UI components query this to populate pickers — no hardcoded kind lists in UI.

// ── Spec: Normalisation ────────────────────────────────────────────────────
//
// normaliseCanvasAnalysis upgrades legacy content items:
//   - facet → kind, view_type becomes 'cards'
//   - chart_kind → kind, view_type stays 'chart'
//   - Deletes the legacy fields after migration

// ── Spec: Compute per tab ──────────────────────────────────────────────────
//
// The compute hook uses the ACTIVE content item's analysis_type, analytics_dsl,
// and kind — not the container's. Switching tabs changes what gets computed.
// If a tab has a cached result, switching to it restores instantly with no
// backend call and no loading state.

// ── Spec: Creation ─────────────────────────────────────────────────────────
//
// When building a canvas analysis from a drag payload:
//   - Each content item gets kind from the payload
//   - Single-tab fallback gets kind from payload.chartKind
//   - title is set from the ANALYSIS_TYPES registry name

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec: ContentItem has kind, not chart_kind or facet', () => {
  it('addContentItem with kind="diagnostics" produces item with kind, no chart_kind, no facet', async () => {
    const { addContentItem } = await import('../canvasAnalysisMutationService');
    const { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } = await import('../canvasAnalysisCreationService');

    const payload = buildCanvasAnalysisPayload({ analysisType: 'edge_info', analyticsDsl: 'from(a).to(b)' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });

    const item = addContentItem(analysis, {
      analysis_type: 'edge_info',
      view_type: 'cards',
      kind: 'diagnostics',
      title: 'Diagnostics',
      analytics_dsl: 'from(a).to(b)',
    });

    expect(item.kind).toBe('diagnostics');
    expect(item.view_type).toBe('cards');
    expect(item.title).toBe('Diagnostics');
    expect(item.analytics_dsl).toBe('from(a).to(b)');
    expect('chart_kind' in item).toBe(false);
    expect('facet' in item).toBe(false);
  });

  it('buildCanvasAnalysisObject single-tab fallback sets kind from chartKind', async () => {
    const { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } = await import('../canvasAnalysisCreationService');

    const payload = buildCanvasAnalysisPayload({ analysisType: 'graph_overview', chartKind: 'pie', analyticsDsl: '' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });

    const ci = analysis.content_items![0];
    expect(ci.kind).toBe('pie');
    expect(ci.analysis_type).toBe('graph_overview');
    expect('chart_kind' in ci).toBe(false);
    expect('facet' in ci).toBe(false);
  });
});

describe('Spec: normaliseCanvasAnalysis migrates legacy fields', () => {
  it('migrates facet → kind and sets view_type to cards', async () => {
    const { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } = await import('../canvasAnalysisCreationService');
    const { normaliseCanvasAnalysis } = await import('../../utils/canvasAnalysisAccessors');

    const payload = buildCanvasAnalysisPayload({ analysisType: 'edge_info', analyticsDsl: 'from(a).to(b)' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });

    // Simulate legacy data: chart_kind + facet on content item, no kind
    const ci = analysis.content_items![0] as any;
    ci.chart_kind = 'info';
    ci.facet = 'evidence';
    ci.view_type = 'chart';
    delete ci.kind;

    normaliseCanvasAnalysis(analysis);

    expect(analysis.content_items![0].kind).toBe('evidence');
    expect(analysis.content_items![0].view_type).toBe('cards');
    expect('chart_kind' in analysis.content_items![0]).toBe(false);
    expect('facet' in analysis.content_items![0]).toBe(false);
  });

  it('migrates chart_kind → kind, keeps view_type chart when no facet', async () => {
    const { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } = await import('../canvasAnalysisCreationService');
    const { normaliseCanvasAnalysis } = await import('../../utils/canvasAnalysisAccessors');

    const payload = buildCanvasAnalysisPayload({ analysisType: 'graph_overview', chartKind: 'pie', analyticsDsl: '' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });

    // Simulate legacy: chart_kind on content item, no kind
    const ci = analysis.content_items![0] as any;
    ci.chart_kind = 'funnel';
    ci.view_type = 'chart';
    delete ci.kind;

    normaliseCanvasAnalysis(analysis);

    expect(analysis.content_items![0].kind).toBe('funnel');
    expect(analysis.content_items![0].view_type).toBe('chart');
    expect('chart_kind' in analysis.content_items![0]).toBe(false);
  });
});

describe('Spec: getKindsForView returns registry-driven kind options', () => {
  it('edge_info cards view has overview, evidence, forecast, depth, diagnostics', async () => {
    const { getKindsForView } = await import('../../components/panels/analysisTypes');
    const kinds = getKindsForView('edge_info', 'cards');

    const ids = kinds.map(k => k.id);
    expect(ids).toEqual(['overview', 'evidence', 'forecast', 'depth', 'diagnostics']);
    // Each kind has a human name
    for (const k of kinds) {
      expect(k.name).toBeTruthy();
      expect(k.name).not.toBe(k.id); // name should be human readable, not the raw id
    }
  });

  it('edge_info chart view has info', async () => {
    const { getKindsForView } = await import('../../components/panels/analysisTypes');
    const kinds = getKindsForView('edge_info', 'chart');
    expect(kinds.map(k => k.id)).toEqual(['info']);
  });

  it('types without declared views return empty (fall back to result semantics)', async () => {
    const { getKindsForView } = await import('../../components/panels/analysisTypes');
    expect(getKindsForView('conversion_funnel', 'chart')).toEqual([]);
    expect(getKindsForView('graph_overview', 'chart')).toEqual([]);
  });
});

describe('Spec: syncFlatFieldsToContentItems writes kind not chart_kind', () => {
  it('container chart_kind syncs to single content item as kind', async () => {
    const { mutateCanvasAnalysisGraph } = await import('../canvasAnalysisMutationService');
    const { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } = await import('../canvasAnalysisCreationService');

    const payload = buildCanvasAnalysisPayload({ analysisType: 'edge_info', analyticsDsl: 'from(a).to(b)' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });
    const graph = { canvasAnalyses: [analysis], metadata: { updated_at: '' } };

    const nextGraph = mutateCanvasAnalysisGraph(graph as any, analysis.id, (a) => {
      a.chart_kind = 'bridge';
    });

    const ci = nextGraph!.canvasAnalyses!.find((a: any) => a.id === analysis.id)!.content_items![0];
    expect(ci.kind).toBe('bridge');
    expect('chart_kind' in ci).toBe(false);
  });
});

// ── Compute per tab (hook test) ────────────────────────────────────────────

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
  tabs: [{
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
  }],
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
  data: null, originalData: null, isDirty: false, source: undefined,
  syncRevision: undefined, syncOrigin: undefined, updateData: vi.fn(),
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

const mockAnalyzeMultipleScenarios: any = vi.fn(async () => ({
  result: {
    analysis_type: 'edge_info',
    analysis_name: 'Edge Info',
    data: [],
    semantics: { dimensions: [], metrics: [] },
    dimension_values: {},
  },
}));

vi.mock('../../contexts/GraphStoreContext', () => ({
  useGraphStore: vi.fn(() => mockGraphStoreState),
  useGraphStoreApi: vi.fn(() => ({ getState: () => mockGraphStoreState })),
}));
vi.mock('../../contexts/ScenariosContext', () => ({
  useScenariosContextOptional: vi.fn(() => mockScenariosContextState),
}));
vi.mock('../../contexts/TabContext', () => ({
  useTabContext: vi.fn(() => ({
    tabs: mockTabsState.tabs,
    operations: {
      getScenarioState: () => mockTabsState.tabs[0]?.editorState?.scenarioState,
      getScenarioVisibilityMode: () => 'f+e',
      getEffectiveScenarioColour: () => '#3b82f6',
    },
    activeTabId: 'tab-1',
  })),
  useFileState: vi.fn(() => mockGraphFileState),
  fileRegistry: { getFileVersion: vi.fn(() => 0), subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../contexts/AnalysisBootContext', () => ({
  useAnalysisBootContext: vi.fn(() => ({ bootReady: true, bootReadyEpoch: 1 })),
}));
vi.mock('../../services/CompositionService', () => ({
  buildGraphForAnalysisLayer: vi.fn((_id: any, graph: any) => graph),
  applyProbabilityVisibilityModeToGraph: vi.fn((graph: any) => graph),
  applyWhatIfToGraph: vi.fn((graph: any) => graph),
}));
vi.mock('../../services/snapshotSubjectResolutionService', () => ({
  getSnapshotPlannerInputsStatus: vi.fn(() => ({ ready: true })),
  hydrateSnapshotPlannerInputs: vi.fn(),
  resolveSnapshotSubjectsForScenario: vi.fn(async () => []),
}));
vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    analyzeSelection: mockAnalyzeSelection,
    analyzeMultipleScenarios: mockAnalyzeMultipleScenarios,
    clearCache: vi.fn(),
  },
}));
vi.mock('../../components/panels/analysisTypes', async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig };
});
vi.mock('../../lib/snapshotBootTrace', () => ({
  isSnapshotBootChart: vi.fn(() => false),
  logSnapshotBoot: vi.fn(),
  logChartReadinessTrace: vi.fn(),
  recordSnapshotBootLedgerStage: vi.fn(),
  registerSnapshotBootExpectations: vi.fn(),
}));
vi.mock('../../services/chartHydrationService', () => ({
  isChartComputeReady: vi.fn(() => true),
}));

describe('Spec: switching tabs with cached result skips backend call', () => {
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
  });

  it('should preserve result when switching between same-analysis-type card tabs', async () => {
    const { useCanvasAnalysisCompute } = await import('../../hooks/useCanvasAnalysisCompute');

    const analysis: any = {
      id: 'edge-info-cards',
      mode: 'live',
      view_mode: 'chart',
      chart_kind: 'info',
      recipe: { analysis: { analysis_type: 'edge_info', analytics_dsl: 'from(a).to(b)' } },
      content_items: [
        { id: 'ci-overview', analysis_type: 'edge_info', view_type: 'cards', kind: 'overview', analytics_dsl: 'from(a).to(b)' },
        { id: 'ci-diagnostics', analysis_type: 'edge_info', view_type: 'cards', kind: 'diagnostics', analytics_dsl: 'from(a).to(b)' },
      ],
    };

    // Start on tab 0 — edge_info is locally computed, should resolve fast
    const { result, rerender } = renderHook(
      ({ idx }) => useCanvasAnalysisCompute({ analysis, tabId: 'tab-1', activeContentIndex: idx }),
      { initialProps: { idx: 0 } },
    );

    await waitFor(() => {
      expect(result.current.result).not.toBeNull();
      expect(result.current.loading).toBe(false);
    });

    const resultBeforeSwitch = result.current.result;

    // Switch to tab 1 (Diagnostics) — same analysis_type, same DSL
    rerender({ idx: 1 });

    // Result must be preserved immediately — no null flash, no loading
    expect(result.current.result).not.toBeNull();
    expect(result.current.result).toBe(resultBeforeSwitch);
    expect(result.current.loading).toBe(false);
  });

  it('should not call analyzeSelection when switching to a tab with a cached result', async () => {
    const { useCanvasAnalysisCompute, contentItemResultCache } = await import('../../hooks/useCanvasAnalysisCompute');

    const analysis: any = {
      id: 'multi-tab-1',
      mode: 'live',
      view_mode: 'chart',
      chart_kind: 'info',
      recipe: { analysis: { analysis_type: 'edge_info', analytics_dsl: 'from(a).to(b)' } },
      content_items: [
        { id: 'ci-0', analysis_type: 'edge_info', view_type: 'cards', kind: 'overview', analytics_dsl: 'from(a).to(b)' },
        { id: 'ci-1', analysis_type: 'graph_overview', view_type: 'chart', kind: 'pie', analytics_dsl: 'from(c).to(d)' },
      ],
    };

    // Pre-seed cache for BOTH tabs (simulating they were computed before)
    const overviewResult = { analysis_type: 'edge_info', data: [{ tab: 'overview' }], semantics: { dimensions: [], metrics: [] }, metadata: {} } as any;
    const pieResult = { analysis_type: 'graph_overview', data: [{ stage: 'x' }], semantics: { dimensions: [], metrics: [] }, metadata: {} } as any;
    contentItemResultCache.set('ci-0', overviewResult);
    contentItemResultCache.set('ci-1', pieResult);

    // Start on tab 0
    const { result, rerender } = renderHook(
      ({ idx }) => useCanvasAnalysisCompute({ analysis, tabId: 'tab-1', activeContentIndex: idx }),
      { initialProps: { idx: 0 } },
    );

    // Wait for initial settle
    await waitFor(() => {
      expect(result.current.result).not.toBeNull();
    });

    // Clear mock call counts
    mockAnalyzeSelection.mockClear();
    mockAnalyzeMultipleScenarios.mockClear();

    // Switch to tab 1
    rerender({ idx: 1 });

    // Should restore cached result immediately
    await waitFor(() => {
      expect(result.current.result).toBe(pieResult);
      expect(result.current.loading).toBe(false);
    });

    // Should NOT have called the backend
    expect(mockAnalyzeSelection).not.toHaveBeenCalled();
    expect(mockAnalyzeMultipleScenarios).not.toHaveBeenCalled();
  });
});
