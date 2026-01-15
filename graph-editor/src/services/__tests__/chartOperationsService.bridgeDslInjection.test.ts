/**
 * chartOperationsService: bridge chart DSL injection
 *
 * Regression guard:
 * - Bridge charts compare two scenarios (one may be "current").
 * - The persisted chart artefact must record the DSL for BOTH compared scenarios.
 * - "current" DSL must be the AUTHORITATIVE current DSL (GraphStore.currentDSL), passed through
 *   scenarioDslSubtitleById at chart creation time.
 *
 * This test does NOT require Base DSL to be present in the chart.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { db } from '../../db/appDatabase';

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

describe('chartOperationsService: bridge chart DSL injection', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Fresh DB per test
    await db.delete();
    await db.open();
    // Chart open emits events; we don't need to test TabContext event handling here.
    vi.stubGlobal('dispatchEvent', vi.fn());
  });

  it('persists DSL for both compared scenarios (including current) into the bridge chart artefact', async () => {
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

    const opened = await chartOperationsService.openAnalysisChartTabFromAnalysis({
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

    expect(opened?.fileId).toBeTruthy();
    const chartFile = await db.files.get(opened!.fileId);
    expect(chartFile).toBeTruthy();

    const chart: any = chartFile?.data;
    expect(chart?.version).toBe('1.0.0');
    expect(chart?.chart_kind).toBe('analysis_bridge');

    const meta = chart?.payload?.analysis_result?.metadata;
    expect(meta?.scenario_a?.scenario_id).toBe(scenarioId);
    expect(meta?.scenario_b?.scenario_id).toBe('current');

    // Critical: DSL must be present for BOTH compared scenarios.
    expect(meta?.scenario_a?.dsl).toBe(scenarioDsl);
    expect(meta?.scenario_b?.dsl).toBe(currentDsl);

    // Also ensure the chart embeds DSL in dimension_values.scenario_id (where present).
    const dv = chart?.payload?.analysis_result?.dimension_values;
    expect(dv?.scenario_id?.[scenarioId]?.dsl).toBe(scenarioDsl);
    expect(dv?.scenario_id?.current?.dsl).toBe(currentDsl);
  });
});


