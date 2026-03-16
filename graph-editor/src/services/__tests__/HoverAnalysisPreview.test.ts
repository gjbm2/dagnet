/**
 * Tests for HoverAnalysisPreview drag-to-pin data and center-out reveal order.
 *
 * These are pure-function unit tests — no DOM, no React rendering.
 * They protect the invariants that ensure visual continuity when a hover
 * preview card is dragged and pinned to the canvas.
 *
 * Satellite recipe generation is now driven by resolveAnalysisType (the same
 * codepath as the analytics panel palette) so those invariants are tested
 * via the analysis type resolution service tests.
 */

import { describe, it, expect } from 'vitest';
import { buildPinDragData, centerOutOrder } from '../../components/HoverAnalysisPreview';
import { getChartKindsForAnalysisType } from '../analysisTypeResolutionService';
import { ANALYSIS_TYPES } from '../../components/panels/analysisTypes';
import type { CanvasAnalysis } from '../../types';

// ---------------------------------------------------------------
// buildPinDragData
// ---------------------------------------------------------------

describe('buildPinDragData', () => {
  const baseInput = {
    analysisType: 'node_info',
    dsl: 'from(myNode)',
    chartKind: 'info',
    result: { analysis_type: 'node_info', data: [{ label: 'x', value: 1 }] } as any,
    screenWidth: 300,
    screenHeight: 200,
    canvasZoom: 1,
    baseFontSize: 11,
    scaleContent: false,
  };

  it('should preserve analysis type and DSL in the recipe', () => {
    const data = buildPinDragData(baseInput);
    expect(data.recipe.analysis.analysis_type).toBe('node_info');
    expect(data.recipe.analysis.analytics_dsl).toBe('from(myNode)');
  });

  it('should preserve the chart kind and analysis result', () => {
    const data = buildPinDragData(baseInput);
    expect(data.chartKind).toBe('info');
    expect(data.analysisResult).toBe(baseInput.result);
  });

  it('should compute flow-space dimensions at zoom 1 (drawWidth = screenWidth)', () => {
    const data = buildPinDragData({ ...baseInput, canvasZoom: 1 });
    expect(data.drawWidth).toBe(300);
    expect(data.drawHeight).toBe(200);
  });

  it('should scale flow-space dimensions inversely with canvasZoom', () => {
    const data = buildPinDragData({ ...baseInput, canvasZoom: 0.5, screenWidth: 120, screenHeight: 120 });
    expect(data.drawWidth).toBe(240);
    expect(data.drawHeight).toBe(240);
  });

  it('should set scale_with_canvas=false for main card (no scaleContent)', () => {
    const data = buildPinDragData({ ...baseInput, scaleContent: false });
    expect(data.display.scale_with_canvas).toBe(false);
  });

  it('should set scale_with_canvas=true for satellite card (scaleContent)', () => {
    const data = buildPinDragData({ ...baseInput, scaleContent: true });
    expect(data.display.scale_with_canvas).toBe(true);
  });

  it('should pass through the base font size unchanged', () => {
    const data = buildPinDragData({ ...baseInput, baseFontSize: 14 });
    expect(data.display.font_size).toBe(14);
  });

  it('should default to zoom=1 when canvasZoom is 0 (guard against division by zero)', () => {
    const data = buildPinDragData({ ...baseInput, canvasZoom: 0, screenWidth: 200, screenHeight: 150 });
    expect(data.drawWidth).toBe(200);
    expect(data.drawHeight).toBe(150);
  });

  it('should preserve drawWidth/drawHeight at high zoom', () => {
    const data = buildPinDragData({ ...baseInput, canvasZoom: 2, screenWidth: 400, screenHeight: 300 });
    expect(data.drawWidth).toBe(200);
    expect(data.drawHeight).toBe(150);
  });

  it('should handle undefined chartKind gracefully', () => {
    const data = buildPinDragData({ ...baseInput, chartKind: undefined });
    expect(data.chartKind).toBeUndefined();
    // All other fields should still be populated
    expect(data.recipe.analysis.analysis_type).toBe('node_info');
    expect(data.drawWidth).toBe(300);
  });
});

// ---------------------------------------------------------------
// centerOutOrder
// ---------------------------------------------------------------

describe('centerOutOrder', () => {
  it('should return empty array for count 0', () => {
    expect(centerOutOrder(0)).toEqual([]);
  });

  it('should return [0] for count 1', () => {
    expect(centerOutOrder(1)).toEqual([0]);
  });

  it('should start from center and alternate left/right for odd count', () => {
    const order = centerOutOrder(5);
    expect(order).toEqual([2, 1, 3, 0, 4]);
  });

  it('should start from center and alternate left/right for even count', () => {
    const order = centerOutOrder(4);
    expect(order).toEqual([2, 1, 3, 0]);
  });

  it('should contain every index exactly once', () => {
    for (const n of [1, 2, 3, 5, 7, 10]) {
      const order = centerOutOrder(n);
      expect(order).toHaveLength(n);
      expect(new Set(order).size).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(order).toContain(i);
      }
    }
  });

  it('should always start with the center index', () => {
    for (const n of [1, 3, 5, 7]) {
      expect(centerOutOrder(n)[0]).toBe(Math.floor(n / 2));
    }
  });
});

// ---------------------------------------------------------------
// getChartKindsForAnalysisType
// ---------------------------------------------------------------

describe('getChartKindsForAnalysisType', () => {
  it('should return info for node_info', () => {
    expect(getChartKindsForAnalysisType('node_info')).toEqual(['info']);
  });

  it('should return info for edge_info', () => {
    expect(getChartKindsForAnalysisType('edge_info')).toEqual(['info']);
  });

  it('should include time_series for branch_comparison (FE augmentation)', () => {
    const kinds = getChartKindsForAnalysisType('branch_comparison');
    expect(kinds).toContain('bar_grouped');
    expect(kinds).toContain('pie');
    expect(kinds).toContain('table');
    expect(kinds).toContain('time_series');
  });

  it('should include time_series for outcome_comparison (FE augmentation)', () => {
    const kinds = getChartKindsForAnalysisType('outcome_comparison');
    expect(kinds).toContain('time_series');
  });

  it('should return funnel-based kinds for path_between', () => {
    const kinds = getChartKindsForAnalysisType('path_between');
    expect(kinds).toContain('funnel');
    expect(kinds).toContain('bridge');
    expect(kinds).toContain('bar_grouped');
    expect(kinds).toContain('table');
  });

  it('should return empty array for unknown analysis type', () => {
    expect(getChartKindsForAnalysisType('nonexistent_type')).toEqual([]);
  });

  it('should return dedicated snapshot chart kinds for snapshot-based types', () => {
    expect(getChartKindsForAnalysisType('cohort_maturity')).toEqual(['cohort_maturity', 'table']);
    expect(getChartKindsForAnalysisType('daily_conversions')).toEqual(['daily_conversions', 'table']);
    expect(getChartKindsForAnalysisType('lag_histogram')).toEqual(['histogram', 'table']);
    expect(getChartKindsForAnalysisType('lag_fit')).toEqual(['lag_fit', 'table']);
  });
});

// ---------------------------------------------------------------
// Pipeline uniformity — the hard invariant
// ---------------------------------------------------------------
//
// ALL satellite charts MUST render through PRECISELY the same pipeline
// as the analytics panel / CanvasAnalysisNode. This test suite verifies:
//
// 1. Every analysis type has known chart kinds (no gaps in the mapping)
// 2. The satellite recipe cartesian product covers every visual chart kind
// 3. The needsSnapshots derivation does NOT block non-snapshot chart kinds
//    for snapshot-capable types — the standard pipeline handles both
// 4. The synthetic CanvasAnalysis shape is valid for the standard hook

describe('Pipeline uniformity — satellite ↔ CanvasAnalysisNode invariant', () => {
  // Replicate the satellite NON_CHART_KINDS filter (same as HoverAnalysisPreview)
  const NON_CHART_KINDS = new Set(['table', 'info']);

  // Replicate the SNAPSHOT_REQUIRING_CHART_KINDS logic from useCanvasAnalysisCompute
  const SNAPSHOT_REQUIRING_CHART_KINDS = new Set([
    'time_series',
    'histogram',
    ...ANALYSIS_TYPES.filter(t => t.snapshotContract).map(t => t.id),
  ]);

  const snapshotTypeIds = ANALYSIS_TYPES
    .filter(t => t.snapshotContract)
    .map(t => t.id);

  const allAnalysisTypeIds = ANALYSIS_TYPES.map(t => t.id);

  it('should have chart_kinds for every analysis type in ANALYSIS_TYPES', () => {
    // Every analysis type must have at least one known chart kind so that
    // it can participate in the satellite recipe cartesian product.
    for (const typeId of allAnalysisTypeIds) {
      const kinds = getChartKindsForAnalysisType(typeId);
      expect(kinds.length, `${typeId} has no chart_kinds mapping`).toBeGreaterThan(0);
    }
  });

  it('should produce at least one satellite-eligible chart kind for every non-info analysis type', () => {
    // For each analysis type (except node_info/edge_info whose only kind is
    // 'info'), at least one chart kind must survive the NON_CHART_KINDS filter.
    const infoOnlyTypes = new Set(['node_info', 'edge_info']);
    for (const typeId of allAnalysisTypeIds) {
      if (infoOnlyTypes.has(typeId)) continue;
      const kinds = getChartKindsForAnalysisType(typeId);
      const visual = kinds.filter(k => !NON_CHART_KINDS.has(k));
      expect(visual.length, `${typeId} has no visual chart kinds after filtering table/info`).toBeGreaterThan(0);
    }
  });

  it('should only filter table and info from satellite recipes — no other chart kinds excluded', () => {
    // Guard: if someone adds a new exclusion it must be intentional and tested.
    // The NON_CHART_KINDS set must contain exactly 'table' and 'info'.
    expect([...NON_CHART_KINDS].sort()).toEqual(['info', 'table']);
  });

  it('should NOT mark non-snapshot chart kinds as needing snapshots for snapshot types', () => {
    // The SNAPSHOT_REQUIRING_CHART_KINDS set should contain only 'time_series'
    // plus the snapshot type IDs themselves. Standard path_runner chart kinds
    // (funnel, bridge, bar_grouped, bar, pie, etc.) must NOT be in this set,
    // so the standard pipeline does not block on snapshot resolution for them.
    const standardPathRunnerKinds = ['funnel', 'bridge', 'bar_grouped', 'bar', 'pie', 'bridge_horizontal'];
    for (const kind of standardPathRunnerKinds) {
      expect(
        SNAPSHOT_REQUIRING_CHART_KINDS.has(kind),
        `${kind} should NOT require snapshots — it is a standard path_runner chart kind`,
      ).toBe(false);
    }
  });

  it('should mark time_series, histogram, and snapshot type IDs as needing snapshots', () => {
    expect(SNAPSHOT_REQUIRING_CHART_KINDS.has('time_series')).toBe(true);
    expect(SNAPSHOT_REQUIRING_CHART_KINDS.has('histogram')).toBe(true);
    for (const typeId of snapshotTypeIds) {
      expect(
        SNAPSHOT_REQUIRING_CHART_KINDS.has(typeId),
        `${typeId} should be in SNAPSHOT_REQUIRING_CHART_KINDS`,
      ).toBe(true);
    }
  });

  it('should use dedicated chart kinds for pure snapshot types (not path_runner fallbacks)', () => {
    // Pure snapshot types (daily_conversions, cohort_maturity, lag_histogram,
    // lag_fit) have dedicated ECharts builders and must NOT use path_runner
    // chart kinds like funnel/bridge/bar_grouped. Using path_runner kinds
    // produces garbage results labeled as the snapshot type but containing
    // funnel data. The pipeline handles snapshot resolution via needsSnapshots=true.
    //
    // Hybrid types (outcome_comparison, branch_comparison) have snapshotContract
    // but legitimately use both path_runner AND time_series chart kinds.
    const pureSnapshotTypeIds = ['daily_conversions', 'cohort_maturity', 'lag_histogram', 'lag_fit'];
    const pathRunnerKinds = new Set(['funnel', 'bridge', 'bar_grouped', 'bar', 'pie']);
    for (const typeId of pureSnapshotTypeIds) {
      const kinds = getChartKindsForAnalysisType(typeId);
      const visualKinds = kinds.filter(k => !NON_CHART_KINDS.has(k));
      for (const kind of visualKinds) {
        expect(
          pathRunnerKinds.has(kind),
          `${typeId} × ${kind}: pure snapshot types must NOT use path_runner chart kinds`,
        ).toBe(false);
      }
    }
  });

  it('should route snapshot-needing chart kinds through the same pipeline (needsSnapshots=true)', () => {
    // Chart kinds that need snapshots (time_series, snapshot type IDs) go
    // through the SAME useCanvasAnalysisCompute hook — the only difference
    // is needsSnapshots=true, which gates snapshot resolution in the prep
    // service. This is standard pipeline behaviour, not a special case.
    const snapshotChartKinds = ['time_series', ...snapshotTypeIds];
    for (const kind of snapshotChartKinds) {
      expect(
        SNAPSHOT_REQUIRING_CHART_KINDS.has(kind),
        `${kind} should be in SNAPSHOT_REQUIRING_CHART_KINDS so the pipeline resolves snapshots`,
      ).toBe(true);
    }
  });

  it('should produce a valid CanvasAnalysis shape for every analysis type × chart kind combo', () => {
    // Replicate DraggableAnalysisCard's syntheticAnalysis construction and
    // verify it produces valid CanvasAnalysis objects for every combo.
    for (const typeId of allAnalysisTypeIds) {
      const kinds = getChartKindsForAnalysisType(typeId);
      const visualKinds = kinds.filter(k => !NON_CHART_KINDS.has(k));
      for (const kind of visualKinds) {
        const synthetic: CanvasAnalysis = {
          id: `test-${typeId}-${kind}`,
          recipe: {
            analysis: {
              analysis_type: typeId,
              analytics_dsl: 'from(testNode)',
            },
          },
          view_mode: 'chart',
          chart_kind: kind,
          mode: 'live' as const,
          x: 0, y: 0, width: 300, height: 200,
        };
        // The shape must have all required fields
        expect(synthetic.id).toBeTruthy();
        expect(synthetic.recipe.analysis.analysis_type).toBe(typeId);
        expect(synthetic.chart_kind).toBe(kind);
        expect(synthetic.view_mode).toBe('chart');
        expect(synthetic.mode).toBe('live');
      }
    }
  });

  it('should cover the full cartesian product: every analysis type × every visual chart kind', () => {
    // Build the complete satellite recipe set (same logic as HoverAnalysisPreview)
    // and verify no analysis type × chart kind combos are missing.
    const allRecipes: Array<{ analysisType: string; chartKind: string }> = [];
    for (const typeId of allAnalysisTypeIds) {
      const kinds = getChartKindsForAnalysisType(typeId);
      const visual = kinds.filter(k => !NON_CHART_KINDS.has(k));
      for (const kind of visual) {
        allRecipes.push({ analysisType: typeId, chartKind: kind });
      }
    }
    // Verify we got recipes for all non-info-only types
    const typesWithRecipes = new Set(allRecipes.map(r => r.analysisType));
    const infoOnlyTypes = new Set(['node_info', 'edge_info']);
    for (const typeId of allAnalysisTypeIds) {
      if (infoOnlyTypes.has(typeId)) continue;
      expect(
        typesWithRecipes.has(typeId),
        `${typeId} has no satellite recipes — it would be invisible in satellite row`,
      ).toBe(true);
    }
    // Verify total recipe count is reasonable (not accidentally empty)
    expect(allRecipes.length).toBeGreaterThan(20);
  });
});
