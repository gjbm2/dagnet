import { describe, it, expect } from 'vitest';

import { buildScenarioRenderEdges } from '../buildScenarioRenderEdges';
import type { Graph } from '../../../types';

describe('buildScenarioRenderEdges - latency completeness for current layer', () => {
  it('uses currentParams (not baseParams) when building edgeLatencyDisplay for current layer', () => {
    const graph: Graph = {
      id: 'g',
      nodes: [
        { id: 'A', uuid: 'A', type: 'conversion', position: { x: 0, y: 0 }, data: {} as any },
        { id: 'B', uuid: 'B', type: 'conversion', position: { x: 100, y: 0 }, data: {} as any },
      ],
      edges: [
        {
          id: 'e.confirmed-to-shipped',
          uuid: 'e.confirmed-to-shipped',
          from: 'A',
          to: 'B',
          type: 'conversion',
          label: 'confirmed→shipped',
          p: {
            mean: 0.86,
            latency: {
              completeness: 0.3,
              median_lag_days: 10.5,
            },
          },
        } as any,
      ],
      metadata: {},
    };

    const baseParams = {
      edges: {
        'e.confirmed-to-shipped': {
          p: {
            latency: {
              completeness: 1.0, // Old value baked into Base when file was opened
            },
          },
        },
      },
      nodes: {},
    };

    const currentParams = {
      edges: {
        'e.confirmed-to-shipped': {
          p: {
            latency: {
              completeness: 0.63, // Live value after retrieval/update
            },
          },
        },
      },
      nodes: {},
    };

    const scenariosContext = {
      scenarios: [],
      baseParams,
      currentParams,
      currentColour: '#0000ff',
      baseColour: '#999999',
    } as any;

    const rfEdges = [
      {
        id: 'e.confirmed-to-shipped',
        source: 'A',
        target: 'B',
        type: 'conversion',
        data: {
          uuid: 'e.confirmed-to-shipped',
          probability: 0.86,
        },
      },
    ];

    const rfNodes = [
      { id: 'A', position: { x: 0, y: 0 }, data: {} },
      { id: 'B', position: { x: 100, y: 0 }, data: {} },
    ];

    const visibleScenarioIds = ['current'];
    const visibleColourOrderIds: string[] = [];

    const result = buildScenarioRenderEdges({
      baseEdges: rfEdges as any,
      nodes: rfNodes as any,
      graph,
      scenariosContext,
      visibleScenarioIds,
      visibleColourOrderIds,
      whatIfDSL: null,
      useUniformScaling: false,
      massGenerosity: 0,
      useSankeyView: false,
      calculateEdgeOffsets: (edges: any[]) => edges,
      tabId: 'tab-1',
      highlightMetadata: {
        highlightedEdgeIds: new Set<string>(),
        edgeDepthMap: new Map<string, number>(),
        isSingleNodeSelection: false,
      },
      isPanningOrZooming: false,
      isInSlowPathRebuild: false,
    });

    // There should be exactly one rendered edge for the current layer
    expect(result).toHaveLength(1);
    const currentEdge = result[0];
    expect(currentEdge.data.scenarioId).toBe('current');

    // EdgeLatencyDisplay.completeness_pct should reflect currentParams (0.63 => 63)
    expect(currentEdge.data.edgeLatencyDisplay).toBeDefined();
    expect(currentEdge.data.edgeLatencyDisplay.completeness_pct).toBeCloseTo(63, 6);
  });
});






