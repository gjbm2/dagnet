import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBeadDefinitions } from '../edgeBeadHelpers';
import type { Graph, GraphEdge } from '../../../types';

vi.mock('../../../services/CompositionService', () => ({
  getComposedParamsForLayer: vi.fn((layerId: string, baseParams: any, currentParams: any) => {
    if (layerId === 'current') return currentParams;
    if (layerId === 'base') return baseParams;
    // For this test, scenario layers behave like base unless explicitly overridden
    return baseParams;
  })
}));

vi.mock('@/lib/conditionalColours', () => ({
  getConditionalProbabilityColour: vi.fn(() => '#8B5CF6'),
  ensureDarkBeadColour: vi.fn((colour: string) => colour),
  darkenCaseColour: vi.fn((colour: string) => colour)
}));

function createTestGraph(): Graph {
  return {
    nodes: [
      { uuid: 'node-a', id: 'from', label: 'From', event_id: 'from' } as any,
      { uuid: 'node-b', id: 'to', label: 'To', event_id: 'to' } as any,
    ],
    edges: [],
    metadata: { name: 'g' } as any,
  } as Graph;
}

function createEdge(): GraphEdge {
  return {
    uuid: 'edge-uuid',
    id: 'edge-id',
    from: 'node-a',
    to: 'node-b',
    p: {
      mean: 0.35,
      stdev: 0.01,
      forecast: { mean: 0.64, stdev: 0.02 },
      evidence: { mean: 0.23, stdev: 0.03 },
    } as any,
  } as GraphEdge;
}

describe('EdgeBeads probability bead respects visibility mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows p.mean in F+E, p.forecast (F prefix) in F, and p.evidence (E prefix) in E', () => {
    const graph = createTestGraph();
    const edge = createEdge();
    const scenariosContext = {
      scenarios: [],
      baseParams: { edges: { 'edge-id': { p: edge.p } } },
      currentParams: { edges: { 'edge-id': { p: edge.p } } },
    };

    const beads = buildBeadDefinitions(
      edge,
      graph,
      scenariosContext,
      [],
      ['base', 'current'],
      ['base', 'current'],
      new Map([['base', '#999'], ['current', '#00f']]),
      null,
      0,
      (scenarioId: string) => (scenarioId === 'base' ? 'f' : 'e')
    );

    const probBead = beads.find(b => b.type === 'probability');
    expect(probBead).toBeDefined();

    const baseVal = probBead!.values.find(v => v.scenarioId === 'base');
    const currentVal = probBead!.values.find(v => v.scenarioId === 'current');

    expect(baseVal?.prefix).toBe('F');
    expect(baseVal?.value).toBeCloseTo(0.64, 6);

    expect(currentVal?.prefix).toBe('E');
    expect(currentVal?.value).toBeCloseTo(0.23, 6);
  });
});




