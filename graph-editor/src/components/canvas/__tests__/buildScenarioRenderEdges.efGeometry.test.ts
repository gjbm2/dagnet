import { describe, it, expect } from 'vitest';
import { buildScenarioRenderEdges } from '../buildScenarioRenderEdges';
import type { Graph } from '../../../types';

describe('buildScenarioRenderEdges - E/F geometry coherence (widths drive offsets/text)', () => {
  it('in F mode, geometry width is driven by derived forecast basis (no double scaling)', () => {
    const graph: Graph = {
      id: 'g',
      nodes: [
        { id: 'A', uuid: 'A', type: 'conversion', entry: { is_start: true, entry_weight: 1 } as any } as any,
        { id: 'B', uuid: 'B', type: 'conversion' } as any,
        { id: 'C', uuid: 'C', type: 'conversion' } as any,
      ],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'A', to: 'B', p: { mean: 0.25 } } as any,
        { id: 'e2', uuid: 'e2', from: 'A', to: 'C', p: { mean: 0.75 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const rfNodes = [
      { id: 'A', position: { x: 0, y: 0 }, data: { entry: { is_start: true, entry_weight: 1 } } },
      { id: 'B', position: { x: 100, y: 0 }, data: {} },
      { id: 'C', position: { x: 100, y: 100 }, data: {} },
    ];

    const rfEdges = [
      { id: 'e1', source: 'A', target: 'B', type: 'conversion', data: { uuid: 'e1' } },
      { id: 'e2', source: 'A', target: 'C', type: 'conversion', data: { uuid: 'e2' } },
    ];

    const scenariosContext = {
      scenarios: [],
      baseParams: { edges: { e1: { p: { mean: 0.25 } }, e2: { p: { mean: 0.75 } } }, nodes: {} },
      currentParams: {
        edges: {
          // One explicit forecast baseline in the sibling group enables derivation for the other.
          e1: { p: { mean: 0.25, forecast: { mean: 0.2 } } },
          e2: { p: { mean: 0.75 } },
        },
        nodes: {},
      },
      currentColour: '#00f',
      baseColour: '#999',
    } as any;

    const result = buildScenarioRenderEdges({
      baseEdges: rfEdges as any,
      nodes: rfNodes as any,
      graph,
      scenariosContext,
      visibleScenarioIds: ['current'],
      visibleColourOrderIds: [],
      whatIfDSL: null,
      useUniformScaling: false,
      massGenerosity: 0,
      useSankeyView: false,
      calculateEdgeOffsets: (edges: any[]) => edges,
      tabId: 'tab-1',
      highlightMetadata: { highlightedEdgeIds: new Set(), edgeDepthMap: new Map(), isSingleNodeSelection: false },
      isPanningOrZooming: false,
      isInSlowPathRebuild: false,
      getScenarioVisibilityMode: () => 'f',
      isCohortQuery: true,
    });

    const e2 = result.find(e => e.data?.uuid === 'e2')!;
    expect(e2).toBeDefined();
    expect(e2.data.edgeLatencyDisplay?.mode).toBe('f');

    // Derived forecast for e2 should be residual 1 - 0.2 = 0.8.
    expect(e2.data.edgeLatencyDisplay?.p_forecast).toBeCloseTo(0.8, 6);
    expect(e2.data.edgeLatencyDisplay?.forecastIsDerived).toBe(true);

    // Geometry width is driven by probResolver (which uses forecast basis in F mode),
    // and edgeLatencyDisplay.meanWidth should equal that base width (no second scaling).
    const w = e2.data.calculateWidth();
    expect(e2.data.edgeLatencyDisplay?.meanWidth).toBeCloseTo(w, 6);
  });

  it('in E mode, geometry width is driven by derived evidence basis and evidenceWidth matches base width', () => {
    const graph: Graph = {
      id: 'g',
      nodes: [
        { id: 'A', uuid: 'A', type: 'conversion', entry: { is_start: true, entry_weight: 1 } as any } as any,
        { id: 'B', uuid: 'B', type: 'conversion' } as any,
        { id: 'C', uuid: 'C', type: 'conversion' } as any,
      ],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'A', to: 'B', p: { mean: 0.25 } } as any,
        { id: 'e2', uuid: 'e2', from: 'A', to: 'C', p: { mean: 0.75 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const rfNodes = [
      { id: 'A', position: { x: 0, y: 0 }, data: { entry: { is_start: true, entry_weight: 1 } } },
      { id: 'B', position: { x: 100, y: 0 }, data: {} },
      { id: 'C', position: { x: 100, y: 100 }, data: {} },
    ];

    const rfEdges = [
      { id: 'e1', source: 'A', target: 'B', type: 'conversion', data: { uuid: 'e1' } },
      { id: 'e2', source: 'A', target: 'C', type: 'conversion', data: { uuid: 'e2' } },
    ];

    const scenariosContext = {
      scenarios: [],
      baseParams: { edges: { e1: { p: { mean: 0.25 } }, e2: { p: { mean: 0.75 } } }, nodes: {} },
      currentParams: {
        edges: {
          e1: { p: { mean: 0.25, evidence: { mean: 0.3 } } },
          e2: { p: { mean: 0.75 } },
        },
        nodes: {},
      },
      currentColour: '#00f',
      baseColour: '#999',
    } as any;

    const result = buildScenarioRenderEdges({
      baseEdges: rfEdges as any,
      nodes: rfNodes as any,
      graph,
      scenariosContext,
      visibleScenarioIds: ['current'],
      visibleColourOrderIds: [],
      whatIfDSL: null,
      useUniformScaling: false,
      massGenerosity: 0,
      useSankeyView: false,
      calculateEdgeOffsets: (edges: any[]) => edges,
      tabId: 'tab-1',
      highlightMetadata: { highlightedEdgeIds: new Set(), edgeDepthMap: new Map(), isSingleNodeSelection: false },
      isPanningOrZooming: false,
      isInSlowPathRebuild: false,
      getScenarioVisibilityMode: () => 'e',
      isCohortQuery: true,
    });

    const e2 = result.find(e => e.data?.uuid === 'e2')!;
    expect(e2).toBeDefined();
    expect(e2.data.edgeLatencyDisplay?.mode).toBe('e');

    // Derived evidence for e2 should be residual 1 - 0.3 = 0.7.
    expect(e2.data.edgeLatencyDisplay?.p_evidence).toBeCloseTo(0.7, 6);
    expect(e2.data.edgeLatencyDisplay?.evidenceIsDerived).toBe(true);

    const w = e2.data.calculateWidth();
    expect(e2.data.edgeLatencyDisplay?.evidenceWidth).toBeCloseTo(w, 6);
  });
});



