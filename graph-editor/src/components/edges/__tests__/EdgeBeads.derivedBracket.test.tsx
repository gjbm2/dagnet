import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBeadDefinitions } from '../edgeBeadHelpers';
import type { Graph, GraphEdge } from '../../../types';

vi.mock('../../../services/CompositionService', () => ({
  getComposedParamsForLayer: vi.fn((layerId: string, baseParams: any, currentParams: any) => {
    if (layerId === 'current') return currentParams;
    if (layerId === 'base') return baseParams;
    return baseParams;
  })
}));

vi.mock('@/lib/conditionalColours', () => ({
  getConditionalProbabilityColour: vi.fn(() => '#8B5CF6'),
  ensureDarkBeadColour: vi.fn((colour: string) => colour),
  darkenCaseColour: vi.fn((colour: string) => colour)
}));

function createTestGraph(edges: any[]): Graph {
  return {
    nodes: [
      { uuid: 'node-a', id: 'node-a', label: 'A' } as any,
      { uuid: 'node-b', id: 'node-b', label: 'B' } as any,
      { uuid: 'node-c', id: 'node-c', label: 'C' } as any,
    ],
    edges,
    metadata: { name: 'g' } as any,
  } as Graph;
}

describe('EdgeBeads derived basis brackets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows E [..] for derived evidence sibling when another sibling has explicit evidence', () => {
    // Graph has two siblings from node-a: a->b has explicit evidence, a->c has none.
    const graphEdges: any[] = [
      { uuid: 'e1', id: 'e1', from: 'node-a', to: 'node-b', p: { mean: 0.4, evidence: { mean: 0.2 } } },
      { uuid: 'e2', id: 'e2', from: 'node-a', to: 'node-c', p: { mean: 0.6 } },
    ];
    const graph = createTestGraph(graphEdges);

    const edge = graphEdges[1] as GraphEdge; // the sibling missing evidence

    const scenariosContext = {
      scenarios: [],
      baseParams: { edges: { e1: { p: graphEdges[0].p }, e2: { p: graphEdges[1].p } } },
      currentParams: { edges: { e1: { p: graphEdges[0].p }, e2: { p: graphEdges[1].p } } },
    };

    const beads = buildBeadDefinitions(
      edge,
      graph,
      scenariosContext,
      [],
      ['current'],
      ['current'],
      new Map([['current', '#00f']]),
      null,
      0,
      () => 'e'
    );

    const probBead = beads.find(b => b.type === 'probability');
    expect(probBead).toBeDefined();

    const currentVal = probBead!.values.find(v => v.scenarioId === 'current');
    expect(currentVal?.prefix).toBe('E');
    expect(currentVal?.isDerived).toBe(true);
  });
});



