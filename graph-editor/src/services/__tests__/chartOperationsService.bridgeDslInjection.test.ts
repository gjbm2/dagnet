/**
 * chartOperationsService: chart recipe + deps signature persistence
 *
 * Regression guard:
 * - Charts must persist a pinned recipe sufficient for pinned semantics (including Current handling).
 * - Charts must persist deps stamp + deps_signature.
 * - We do NOT inject recipe/DSL metadata into analysis_result (analysis_result is compute output only).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { db } from '../../db/appDatabase';

const hoisted = vi.hoisted(() => ({
  analyzeMultipleScenarios: vi.fn(),
}));

vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    analyzeMultipleScenarios: hoisted.analyzeMultipleScenarios,
  },
}));

vi.mock('../CompositionService', () => ({
  buildGraphForAnalysisLayer: vi.fn(() => ({ nodes: [], edges: [] })),
}));

// Persist chart file writes into IndexedDB for assertions.
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(() => null),
    restoreFile: vi.fn(async () => null),
    addViewTab: vi.fn(async () => true),
    upsertFileClean: vi.fn(async (fileId: string, type: string, source: any, data: any) => {
      await db.files.put({
        fileId,
        type: type as any,
        data,
        originalData: {},
        isDirty: false,
        isLocal: true,
        lastModified: Date.now(),
        lastSaved: Date.now(),
        source,
      } as any);
      return true;
    }),
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    startOperation: vi.fn(() => 'op'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  },
}));

import { chartOperationsService } from '../chartOperationsService';
import { chartDepsSignatureV1 } from '../../lib/chartDeps';
import { recomputeOpenChartsForGraph } from '../chartRecomputeService';
import { ukReferenceDayService } from '../ukReferenceDayService';
import { dslDependsOnReferenceDay } from '../../lib/dslDynamics';
import { graphTopologySignature } from '../graphTopologySignatureService';

describe('chartOperationsService: bridge chart recipe persistence', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Freeze reference day for deterministic deps stamps/signatures in tests.
    ukReferenceDayService.__setProviderForTests(() => '1-Jan-25');
    // Fresh DB per test
    await db.delete();
    await db.open();
    // Chart open emits events; we don't need to test TabContext event handling here.
    vi.stubGlobal('dispatchEvent', vi.fn());
  });

  it('persists recipe + deps signature for both compared scenarios (including current) without mutating analysis_result', async () => {
    const graphFileId = 'graph-conversion-flow-v2-recs-collapsed';
    const scenarioId = 'scenario-1768486418961-eqqwogh';

    // Seed scenario metadata as the authoring system would.
    await db.scenarios.put({
      id: scenarioId,
      fileId: graphFileId,
      name: '1-Dec – 17-Dec',
      colour: '#EC4899',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      params: { edges: {}, nodes: {} },
      meta: {
        isLive: true,
        queryDSL: 'window(1-Dec-25:17-Dec-25)',
        lastEffectiveDSL: 'window(1-Dec-25:17-Dec-25)',
      },
    } as any);

    const analysisResult: any = {
      analysis_type: 'bridge_view',
      analysis_name: 'Bridge View',
      analysis_description: 'Decompose the Reach Probability difference between two scenarios',
      metadata: {
        to_node: 'switch-success',
        scenario_a: {
          scenario_id: scenarioId,
          name: '1-Dec – 17-Dec',
          colour: '#EC4899',
          visibility_mode: 'f+e',
          probability_label: 'Probability',
        },
        scenario_b: {
          scenario_id: 'current',
          name: 'Current',
          colour: '#3B82F6',
          visibility_mode: 'f+e',
          probability_label: 'Probability',
        },
      },
      dimension_values: {},
      data: [],
    };

    const currentDsl = 'window(8-Jan-26:13-Jan-26)';
    const scenarioDsl = 'window(1-Dec-25:17-Dec-25)';

    const opened1 = await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_bridge' as any,
      analysisResult,
      scenarioIds: [], // Bridge embeds scenario context in metadata
      title: 'Chart — Bridge View',
      source: {
        parent_file_id: graphFileId,
        parent_tab_id: 'tab-graph-conversion-flow-v2-recs-collapsed-interactive',
        query_dsl: 'to(switch-success)',
        analysis_type: 'bridge_view',
      } as any,
      scenarioDslSubtitleById: {
        current: currentDsl,
        [scenarioId]: scenarioDsl,
      },
    });

    expect(opened1?.fileId).toBeTruthy();
    const chartFile1 = await db.files.get(opened1!.fileId);
    expect(chartFile1).toBeTruthy();

    const chart1: any = chartFile1?.data;
    expect(chart1?.version).toBe('1.0.0');
    expect(chart1?.chart_kind).toBe('analysis_bridge');

    // Payload should include participating scenario IDs (bridge inferred from metadata scenario_a/scenario_b).
    expect(chart1?.payload?.scenario_ids).toEqual([scenarioId, 'current']);

    // Recipe must be present and contain effective DSLs for participating scenarios (including Current).
    const recipeScenarios = chart1?.recipe?.scenarios;
    expect(Array.isArray(recipeScenarios)).toBe(true);
    expect(recipeScenarios.map((s: any) => s.scenario_id)).toEqual([scenarioId, 'current']);
    expect(recipeScenarios.find((s: any) => s.scenario_id === scenarioId)?.effective_dsl).toBe(scenarioDsl);
    expect(recipeScenarios.find((s: any) => s.scenario_id === 'current')?.effective_dsl).toBe(currentDsl);

    // deps_signature must exist and must match the deps stamp.
    expect(typeof chart1?.deps_signature).toBe('string');
    expect(chart1.deps_signature).toBe(chartDepsSignatureV1(chart1.deps));
    // Dynamic DSL reference day should not be present for fixed windows.
    expect(chart1?.deps?.reference_day_uk).toBeUndefined();

    const meta = chart1?.payload?.analysis_result?.metadata;
    expect(meta?.scenario_a?.scenario_id).toBe(scenarioId);
    expect(meta?.scenario_b?.scenario_id).toBe('current');

    // We do NOT inject DSL into analysis_result.
    expect(meta?.scenario_a?.dsl).toBeUndefined();
    expect(meta?.scenario_b?.dsl).toBeUndefined();

    const dv = chart1?.payload?.analysis_result?.dimension_values;
    expect(dv?.scenario_id?.[scenarioId]?.dsl).toBeUndefined();
    expect(dv?.scenario_id?.current?.dsl).toBeUndefined();

    // Signature should change if a recipe-relevant input changes.
    const opened2 = await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_bridge' as any,
      analysisResult,
      scenarioIds: [],
      title: 'Chart — Bridge View',
      source: {
        parent_file_id: graphFileId,
        parent_tab_id: 'tab-graph-conversion-flow-v2-recs-collapsed-interactive',
        query_dsl: 'to(switch-success)',
        analysis_type: 'bridge_view',
      } as any,
      scenarioDslSubtitleById: {
        current: 'window(9-Jan-26:13-Jan-26)',
        [scenarioId]: scenarioDsl,
      },
    });

    const chartFile2 = await db.files.get(opened2!.fileId);
    const chart2: any = chartFile2?.data;
    expect(chart2?.deps_signature).not.toBe(chart1?.deps_signature);
  });
});

describe('chartDepsSignatureV1 (pure)', () => {
  it('is stable under object key ordering and trims text fields', () => {
    const a: any = {
      v: 1,
      mode: 'pinned',
      chart_kind: 'analysis_bridge',
      analysis: { query_dsl: '  to(x)  ', analysis_type: 'bridge_view' },
      parent: { parent_tab_id: '  tab-1  ', parent_file_id: 'graph-1' },
      scenarios: [{ scenario_id: 'current', effective_dsl: ' window(1-Dec-25:2-Dec-25)  ', visibility_mode: 'f+e' }],
    };
    const b: any = {
      v: 1,
      chart_kind: 'analysis_bridge',
      mode: 'pinned',
      parent: { parent_file_id: 'graph-1', parent_tab_id: 'tab-1' },
      scenarios: [{ visibility_mode: 'f+e', effective_dsl: 'window(1-Dec-25:2-Dec-25)', scenario_id: 'current' }],
      analysis: { analysis_type: 'bridge_view', query_dsl: 'to(x)' },
    };

    expect(chartDepsSignatureV1(a)).toBe(chartDepsSignatureV1(b));
  });

  it('changes when scenario ordering changes', () => {
    const base: any = {
      v: 1,
      mode: 'pinned',
      chart_kind: 'analysis_funnel',
      scenarios: [
        { scenario_id: 'a', effective_dsl: 'to(x)', visibility_mode: 'f+e' },
        { scenario_id: 'b', effective_dsl: 'to(x)', visibility_mode: 'f+e' },
      ],
    };
    const reordered = { ...base, scenarios: [...base.scenarios].reverse() };
    expect(chartDepsSignatureV1(base)).not.toBe(chartDepsSignatureV1(reordered));
  });

  it('changes when mode changes (linked vs pinned)', () => {
    const pinned: any = {
      v: 1,
      mode: 'pinned',
      chart_kind: 'analysis_bridge',
      scenarios: [{ scenario_id: 'current', effective_dsl: 'to(x)', visibility_mode: 'f+e' }],
    };
    const linked: any = {
      ...pinned,
      mode: 'linked',
    };
    expect(chartDepsSignatureV1(pinned)).not.toBe(chartDepsSignatureV1(linked));
  });

  it('changes when reference day changes (only when included)', () => {
    const base: any = {
      v: 1,
      mode: 'pinned',
      chart_kind: 'analysis_funnel',
      reference_day_uk: '1-Jan-25',
      scenarios: [{ scenario_id: 'current', effective_dsl: 'window(-7d:)', visibility_mode: 'f+e' }],
    };
    const next = { ...base, reference_day_uk: '2-Jan-25' };
    expect(chartDepsSignatureV1(base)).not.toBe(chartDepsSignatureV1(next));
  });
});

describe('chartRecomputeService: recomputeOpenChartsForGraph', () => {
  beforeEach(() => {
    vi.mocked(hoisted.analyzeMultipleScenarios).mockReset();
  });

  it('updates an open chart in place and deduplicates by chart fileId', async () => {
    const graphFileId = 'graph-1';

    // Create a chart file with a stable fileId.
    const opened = await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_bridge' as any,
      analysisResult: {
        analysis_type: 'bridge_view',
        analysis_name: 'Bridge View',
        metadata: {
          scenario_a: { scenario_id: 'current', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
          scenario_b: { scenario_id: 'base', name: 'Base', colour: '#999', visibility_mode: 'f+e' },
        },
        dimension_values: {},
        data: [],
      } as any,
      scenarioIds: [],
      title: 'Chart — Bridge View',
      source: {
        parent_file_id: graphFileId,
        parent_tab_id: 'tab-graph-1',
        query_dsl: 'to(x)',
        analysis_type: 'bridge_view',
      } as any,
      scenarioDslSubtitleById: {
        current: 'window(1-Dec-25:2-Dec-25)',
        base: 'window(1-Dec-25:2-Dec-25)',
      },
      fileId: 'chart-test-1',
    });

    expect(opened?.fileId).toBe('chart-test-1');

    // Linked mode requires the specific parent graph tab to be resolvable (tab-scoped scenario state).
    await db.tabs.add({ id: 'tab-graph-1', fileId: graphFileId, viewMode: 'interactive', title: 'Graph', icon: '', closable: true, group: 'main-content' } as any);

    // Seed two tabs pointing at the same chart fileId to ensure dedup.
    await db.tabs.add({ id: 'tab-1', fileId: 'chart-test-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);
    await db.tabs.add({ id: 'tab-2', fileId: 'chart-test-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: {
        analysis_type: 'bridge_view',
        analysis_name: 'Recomputed',
        metadata: {
          scenario_a: { scenario_id: 'current', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
          scenario_b: { scenario_id: 'base', name: 'Base', colour: '#999', visibility_mode: 'f+e' },
        },
        dimension_values: {},
        data: [],
      },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [],
      currentColour: '#3B82F6',
      baseColour: '#999',
      // Make the chart stale by changing the authoritative Current DSL relative to the stored recipe.
      authoritativeCurrentDsl: 'window(3-Dec-25:4-Dec-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-test-1']);
    expect(vi.mocked(hoisted.analyzeMultipleScenarios)).toHaveBeenCalledTimes(1);

    const updated = await db.files.get('chart-test-1');
    expect((updated as any)?.data?.payload?.analysis_result?.analysis_name).toBe('Recomputed');
  });

  it('does not attempt pinned refresh when pinned_recompute_eligible is false (snapshot overlay involved)', async () => {
    const graphFileId = 'graph-2';

    // Create a chart that includes a non-live scenario and therefore is not eligible for pinned recompute.
    const opened = await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_bridge' as any,
      analysisResult: {
        analysis_type: 'bridge_view',
        analysis_name: 'Bridge View',
        metadata: {
          scenario_a: { scenario_id: 'snap-1', name: 'Snapshot', colour: '#999', visibility_mode: 'f+e' },
          scenario_b: { scenario_id: 'current', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
        },
        dimension_values: {},
        data: [],
      } as any,
      scenarioIds: [],
      title: 'Chart — Mixed',
      source: {
        parent_file_id: graphFileId,
        // No parent_tab_id ⇒ pinned/orphaned semantics.
        query_dsl: 'to(x)',
        analysis_type: 'bridge_view',
      } as any,
      scenarioDslSubtitleById: {
        current: 'window(1-Dec-25:2-Dec-25)',
        // snap-1 has no DSL; it's a snapshot overlay
      },
      fileId: 'chart-test-2',
    });

    expect(opened?.fileId).toBe('chart-test-2');

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'bridge_view', analysis_name: 'ShouldNotRun', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [{ id: 'snap-1', name: 'Snapshot', colour: '#999', meta: { isLive: false } }] as any,
      currentColour: '#3B82F6',
      baseColour: '#999',
      authoritativeCurrentDsl: 'window(3-Dec-25:4-Dec-25)',
    });

    // Should be skipped (no pinned recompute eligibility), and no compute should run.
    expect(res.updatedChartFileIds).toEqual([]);
    expect(vi.mocked(hoisted.analyzeMultipleScenarios)).toHaveBeenCalledTimes(0);
  });

  it('recomputes a funnel chart when linked parent tab scenario order changes (only scenarios; hide Current)', async () => {
    const graphFileId = 'graph-funnel-order-1';
    const tabId = 'tab-graph-funnel-order-1';

    // Seed two live scenarios.
    await db.scenarios.put({ id: 's-a', fileId: graphFileId, name: 'A', colour: '#111', meta: { isLive: true, queryDSL: 'cohort(-1w:)', lastEffectiveDSL: 'cohort(-1w:)' }, params: { edges: {}, nodes: {} }, createdAt: Date.now(), updatedAt: Date.now(), version: 1 } as any);
    await db.scenarios.put({ id: 's-b', fileId: graphFileId, name: 'B', colour: '#222', meta: { isLive: true, queryDSL: 'cohort(-2m:-1m)', lastEffectiveDSL: 'cohort(-2m:-1m)' }, params: { edges: {}, nodes: {} }, createdAt: Date.now(), updatedAt: Date.now(), version: 1 } as any);

    // Seed parent tab with reversed order (this should change linked deps stamp ordering).
    await db.tabs.add({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: { scenarioState: { visibleScenarioIds: ['s-b', 's-a'], visibilityMode: { 's-a': 'f+e', 's-b': 'f+e' } } },
    } as any);

    // Create a funnel chart whose recipe scenario order is [s-a, s-b] (different from parent tab).
    await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_funnel' as any,
      analysisResult: { analysis_type: 'graph_overview', analysis_name: 'Funnel', metadata: {}, dimension_values: {}, data: [] } as any,
      scenarioIds: ['s-a', 's-b'],
      title: 'Chart — Funnel',
      source: { parent_file_id: graphFileId, parent_tab_id: tabId, query_dsl: 'from(a).to(b)', analysis_type: 'graph_overview' } as any,
      scenarioDslSubtitleById: { 's-a': 'cohort(-1w:)', 's-b': 'cohort(-2m:-1m)' },
      hideCurrent: true,
      fileId: 'chart-funnel-1',
    });

    // Open chart tab so recomputeOpenChartsForGraph can discover it.
    await db.tabs.add({ id: 'tab-chart-funnel-1', fileId: 'chart-funnel-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'graph_overview', analysis_name: 'Recomputed Funnel', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [{ id: 's-a', meta: { isLive: true } }, { id: 's-b', meta: { isLive: true } }] as any,
      currentColour: '#3B82F6',
      baseColour: '#999',
      authoritativeCurrentDsl: 'window(1-Jan-25:2-Jan-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-funnel-1']);
    expect(vi.mocked(hoisted.analyzeMultipleScenarios)).toHaveBeenCalledTimes(1);
    const call0 = vi.mocked(hoisted.analyzeMultipleScenarios).mock.calls[0] as any[];
    const scenariosArg = call0?.[0] || [];
    expect(scenariosArg.map((s: any) => s.scenario_id)).toEqual(['s-b', 's-a']);
  });

  it('recomputes a funnel chart when authoritative Current DSL changes (just Current)', async () => {
    const graphFileId = 'graph-funnel-current-only-1';
    const tabId = 'tab-graph-funnel-current-only-1';

    await db.tabs.add({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: { scenarioState: { visibleScenarioIds: ['current'], visibilityMode: {} } },
    } as any);

    await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_funnel' as any,
      analysisResult: { analysis_type: 'graph_overview', analysis_name: 'Current Only', metadata: {}, dimension_values: {}, data: [] } as any,
      scenarioIds: ['current'],
      title: 'Chart — Current only',
      source: { parent_file_id: graphFileId, parent_tab_id: tabId, query_dsl: 'from(a).to(b)', analysis_type: 'graph_overview' } as any,
      scenarioDslSubtitleById: { current: 'window(1-Dec-25:2-Dec-25)' },
      fileId: 'chart-funnel-current-only-1',
    });
    await db.tabs.add({ id: 'tab-chart-funnel-current-only-1', fileId: 'chart-funnel-current-only-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'graph_overview', analysis_name: 'Recomputed Current', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [] as any,
      currentColour: '#3B82F6',
      baseColour: '#999',
      authoritativeCurrentDsl: 'window(3-Dec-25:4-Dec-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-funnel-current-only-1']);
    expect(vi.mocked(hoisted.analyzeMultipleScenarios)).toHaveBeenCalledTimes(1);
  });

  it('preserves participating scenario order for base + current (bridge)', async () => {
    const graphFileId = 'graph-bridge-base-current-1';
    const tabId = 'tab-graph-bridge-base-current-1';

    await db.tabs.add({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      // Explicit order: base then current (even though this is unusual, it must be preserved).
      editorState: { scenarioState: { visibleScenarioIds: ['base', 'current'], visibilityMode: {} } },
    } as any);

    await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_bridge' as any,
      analysisResult: {
        analysis_type: 'bridge_view',
        analysis_name: 'Bridge View',
        metadata: {
          scenario_a: { scenario_id: 'base', name: 'Base', colour: '#999', visibility_mode: 'f+e' },
          scenario_b: { scenario_id: 'current', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
        },
        dimension_values: {},
        data: [],
      } as any,
      scenarioIds: [],
      title: 'Chart — Base vs Current',
      source: { parent_file_id: graphFileId, parent_tab_id: tabId, query_dsl: 'to(x)', analysis_type: 'bridge_view' } as any,
      scenarioDslSubtitleById: {
        base: 'window(1-Nov-25:10-Nov-25)',
        current: 'window(1-Dec-25:17-Dec-25)',
      },
      fileId: 'chart-bridge-base-current-1',
    });
    await db.tabs.add({ id: 'tab-chart-bridge-base-current-1', fileId: 'chart-bridge-base-current-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'bridge_view', analysis_name: 'Recomputed', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [] as any,
      currentColour: '#3B82F6',
      baseColour: '#999',
      authoritativeCurrentDsl: 'window(3-Dec-25:4-Dec-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-bridge-base-current-1']);
    const call0 = vi.mocked(hoisted.analyzeMultipleScenarios).mock.calls[0] as any[];
    const scenariosArg = call0?.[0] || [];
    expect(scenariosArg.map((s: any) => s.scenario_id)).toEqual(['base', 'current']);
  });

  it('preserves participating scenario order for base + scenario(s) (funnel; only visible scenarios)', async () => {
    const graphFileId = 'graph-funnel-base-scenarios-1';
    const tabId = 'tab-graph-funnel-base-scenarios-1';

    await db.scenarios.put({ id: 's-a', fileId: graphFileId, name: 'A', colour: '#111', meta: { isLive: true, queryDSL: 'cohort(-1w:)', lastEffectiveDSL: 'cohort(-1w:)' }, params: { edges: {}, nodes: {} }, createdAt: Date.now(), updatedAt: Date.now(), version: 1 } as any);

    await db.tabs.add({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: { scenarioState: { visibleScenarioIds: ['base', 's-a'], visibilityMode: { 's-a': 'e' } } },
    } as any);

    await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_funnel' as any,
      analysisResult: { analysis_type: 'graph_overview', analysis_name: 'Funnel', metadata: {}, dimension_values: {}, data: [] } as any,
      scenarioIds: ['base', 's-a'],
      title: 'Chart — Base + A',
      source: { parent_file_id: graphFileId, parent_tab_id: tabId, query_dsl: 'from(a).to(b)', analysis_type: 'graph_overview' } as any,
      scenarioDslSubtitleById: { base: 'window(1-Nov-25:10-Nov-25)', 's-a': 'cohort(-1w:)' },
      hideCurrent: true,
      fileId: 'chart-funnel-base-scenarios-1',
    });
    await db.tabs.add({ id: 'tab-chart-funnel-base-scenarios-1', fileId: 'chart-funnel-base-scenarios-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'graph_overview', analysis_name: 'Recomputed Funnel', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [{ id: 's-a', meta: { isLive: true }, colour: '#111', name: 'A' }] as any,
      currentColour: '#3B82F6',
      baseColour: '#999',
      authoritativeCurrentDsl: 'window(3-Dec-25:4-Dec-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-funnel-base-scenarios-1']);
    const call0 = vi.mocked(hoisted.analyzeMultipleScenarios).mock.calls[0] as any[];
    const scenariosArg = call0?.[0] || [];
    expect(scenariosArg.map((s: any) => s.scenario_id)).toEqual(['base', 's-a']);
  });

  it('bridge_view linked refresh keeps "Current last" even if the parent tab lists Current first', async () => {
    const graphFileId = 'graph-bridge-current-last-1';
    const tabId = 'tab-graph-bridge-current-last-1';

    // Parent tab lists Current first (typical in UI), but bridge semantics require Current last.
    await db.tabs.add({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: { scenarioState: { visibleScenarioIds: ['current', 's-a'], visibilityMode: { 's-a': 'e' } } },
    } as any);

    await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_bridge' as any,
      analysisResult: {
        analysis_type: 'bridge_view',
        analysis_name: 'Bridge View',
        metadata: {
          scenario_a: { scenario_id: 's-a', name: 'A', colour: '#111', visibility_mode: 'e' },
          scenario_b: { scenario_id: 'current', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
        },
        dimension_values: {},
        data: [],
      } as any,
      scenarioIds: ['s-a', 'current'],
      title: 'Chart — Bridge current last',
      source: { parent_file_id: graphFileId, parent_tab_id: tabId, query_dsl: 'to(x)', analysis_type: 'bridge_view' } as any,
      scenarioDslSubtitleById: {
        's-a': 'cohort(-1w:)',
        current: 'window(1-Dec-25:17-Dec-25)',
      },
      fileId: 'chart-bridge-current-last-1',
    });
    await db.tabs.add({ id: 'tab-chart-bridge-current-last-1', fileId: 'chart-bridge-current-last-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    // Force staleness via authoritative Current DSL drift (linked refresh semantics).
    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'bridge_view', analysis_name: 'Recomputed', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: { nodes: [], edges: [] },
      baseParams: {},
      currentParams: {},
      scenarios: [{ id: 's-a', name: 'A', colour: '#111', meta: { isLive: true } }] as any,
      currentColour: '#3B82F6',
      baseColour: '#999999',
      authoritativeCurrentDsl: 'window(2-Dec-25:18-Dec-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-bridge-current-last-1']);
    const call0 = vi.mocked(hoisted.analyzeMultipleScenarios).mock.calls[0] as any[];
    const scenariosArg = call0?.[0] || [];
    expect(scenariosArg.map((s: any) => s.scenario_id)).toEqual(['s-a', 'current']);
  });

  it('treats underlying parameter file revision changes as staleness (recomputes)', async () => {
    const graphFileId = 'graph-param-rev-1';
    const tabId = 'tab-graph-param-rev-1';

    // Seed graph file with a parameter dependency (edge.p.id).
    await db.files.put({
      fileId: graphFileId,
      type: 'graph',
      viewTabs: [],
      data: {
        nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
        edges: [{ uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-1' } }],
        baseDSL: 'window(1-Nov-25:10-Nov-25)',
        currentQueryDSL: 'window(1-Dec-25:17-Dec-25)',
      },
      lastModified: Date.now(),
      sha: 'graphsha1',
    } as any);

    // Seed the parameter file with an initial revision token.
    await db.files.put({
      fileId: 'parameter-param-1',
      type: 'parameter',
      viewTabs: [],
      data: { id: 'param-1', values: [] },
      sha: 'psha1',
      lastModified: Date.now(),
    } as any);

    await db.tabs.add({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: { scenarioState: { visibleScenarioIds: ['current'], visibilityMode: {} } },
    } as any);

    // Create a chart linked to the graph.
    await chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: 'analysis_funnel' as any,
      analysisResult: { analysis_type: 'graph_overview', analysis_name: 'Funnel', metadata: {}, dimension_values: {}, data: [] } as any,
      scenarioIds: ['current'],
      title: 'Chart — Param rev',
      source: { parent_file_id: graphFileId, parent_tab_id: tabId, query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview' } as any,
      scenarioDslSubtitleById: { current: 'window(1-Dec-25:17-Dec-25)' },
      fileId: 'chart-param-rev-1',
    });
    await db.tabs.add({ id: 'tab-chart-param-rev-1', fileId: 'chart-param-rev-1', viewMode: 'interactive', title: 'Chart', icon: '', closable: true, group: 'main-content' } as any);

    const beforeFile: any = await db.files.get('chart-param-rev-1');
    const beforeSig = beforeFile?.data?.deps_signature;
    expect(typeof beforeSig).toBe('string');

    // Change parameter revision token (simulates git pull / overwrite / edit).
    await db.files.put({
      ...(await db.files.get('parameter-param-1')),
      sha: 'psha2',
      lastModified: Date.now() + 1000,
    } as any);

    vi.mocked(hoisted.analyzeMultipleScenarios).mockResolvedValue({
      success: true,
      result: { analysis_type: 'graph_overview', analysis_name: 'Recomputed', metadata: {}, dimension_values: {}, data: [] },
    } as any);

    const res = await recomputeOpenChartsForGraph({
      graphFileId,
      graph: (await db.files.get(graphFileId))?.data,
      baseParams: {},
      currentParams: {},
      scenarios: [] as any,
      currentColour: '#3B82F6',
      baseColour: '#999999',
      authoritativeCurrentDsl: 'window(1-Dec-25:17-Dec-25)',
    });

    expect(res.updatedChartFileIds).toEqual(['chart-param-rev-1']);
    const afterFile: any = await db.files.get('chart-param-rev-1');
    const afterSig = afterFile?.data?.deps_signature;
    expect(afterSig).not.toBe(beforeSig);
  });
});

describe('dslDependsOnReferenceDay (unit)', () => {
  it('returns true for relative/open-ended windows and false for fixed ranges', () => {
    expect(dslDependsOnReferenceDay('window(-7d:)')).toBe(true);
    expect(dslDependsOnReferenceDay('window(-2w:-1w)')).toBe(true);
    expect(dslDependsOnReferenceDay('window(1-Dec-25:2-Dec-25)')).toBe(false);
    expect(dslDependsOnReferenceDay('cohort(1-Dec-25:2-Dec-25)')).toBe(false);
  });
});

describe('graphTopologySignature (unit)', () => {
  it('is stable under node/edge ordering and changes on topology edits', () => {
    const g1: any = {
      nodes: [{ uuid: 'n1', id: 'a' }, { uuid: 'n2', id: 'b' }],
      edges: [{ uuid: 'e1', id: 'a-to-b', from: 'a', to: 'b' }],
    };
    const g2: any = {
      nodes: [{ uuid: 'n2', id: 'b' }, { uuid: 'n1', id: 'a' }],
      edges: [{ uuid: 'e1', id: 'a-to-b', from: 'a', to: 'b' }],
    };
    const g3: any = {
      nodes: [{ uuid: 'n1', id: 'a' }, { uuid: 'n2', id: 'b' }],
      edges: [{ uuid: 'e1', id: 'a-to-b', from: 'b', to: 'a' }], // topology change
    };

    expect(graphTopologySignature(g1)).toBeTruthy();
    expect(graphTopologySignature(g1)).toBe(graphTopologySignature(g2));
    expect(graphTopologySignature(g1)).not.toBe(graphTopologySignature(g3));
  });
});


