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

describe('EdgeBeads derived forecast brackets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT show derived F when no explicit forecasts exist in the sibling group (falls back to mean)', () => {
    // Two siblings from node-a, neither has explicit forecast.
    const graphEdges: any[] = [
      { uuid: 'e1', id: 'e1', from: 'node-a', to: 'node-b', p: { mean: 0.25 } },
      { uuid: 'e2', id: 'e2', from: 'node-a', to: 'node-c', p: { mean: 0.75 } },
    ];
    const graph = createTestGraph(graphEdges);

    const edge = graphEdges[1] as GraphEdge;

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
      () => 'f'
    );

    const probBead = beads.find(b => b.type === 'probability');
    expect(probBead).toBeDefined();

    const currentVal = probBead!.values.find(v => v.scenarioId === 'current');
    expect(currentVal?.prefix).toBe('F');
    expect(currentVal?.isDerived).toBeUndefined();
    // With no explicit forecasts anywhere in the sibling group, F mode falls back to mean.
    expect(currentVal?.value).toBeCloseTo(0.75, 6);
  });

  it('does not renormalise p.mean weights when falling back in F mode with no explicit forecasts', () => {
    // Sibling weights intentionally do NOT sum to 1 (invalid PMF state).
    const graphEdges: any[] = [
      { uuid: 'e1', id: 'e1', from: 'node-a', to: 'node-b', p: { mean: 0.8 } },
      { uuid: 'e2', id: 'e2', from: 'node-a', to: 'node-c', p: { mean: 0.6 } },
    ];
    const graph = createTestGraph(graphEdges);
    const edge = graphEdges[1] as GraphEdge;

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
      () => 'f'
    );

    const probBead = beads.find(b => b.type === 'probability');
    expect(probBead).toBeDefined();

    const currentVal = probBead!.values.find(v => v.scenarioId === 'current');
    expect(currentVal?.prefix).toBe('F');
    expect(currentVal?.isDerived).toBeUndefined();
    // Fallback should use raw p.mean (0.6), not a renormalised value (0.6/1.4 ≈ 0.4286).
    expect(currentVal?.value).toBeCloseTo(0.6, 6);
  });

  it('shows derived F when at least one sibling has an explicit forecast baseline', () => {
    // Two siblings from node-a.
    // e1 has explicit forecast baseline; e2 is missing and should receive residual allocation.
    const graphEdges: any[] = [
      { uuid: 'e1', id: 'e1', from: 'node-a', to: 'node-b', p: { mean: 0.25 } },
      { uuid: 'e2', id: 'e2', from: 'node-a', to: 'node-c', p: { mean: 0.75 } },
    ];
    const graph = createTestGraph(graphEdges);
    const edge = graphEdges[1] as GraphEdge;

    const scenariosContext = {
      scenarios: [],
      baseParams: {
        edges: {
          e1: { p: { mean: 0.25, forecast: { mean: 0.2 } } },
          e2: { p: { mean: 0.75 } },
        }
      },
      currentParams: {
        edges: {
          e1: { p: { mean: 0.25, forecast: { mean: 0.2 } } },
          e2: { p: { mean: 0.75 } },
        }
      },
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
      () => 'f'
    );

    const probBead = beads.find(b => b.type === 'probability');
    expect(probBead).toBeDefined();

    const currentVal = probBead!.values.find(v => v.scenarioId === 'current');
    expect(currentVal?.prefix).toBe('F');
    expect(currentVal?.isDerived).toBe(true);
    // Residual is 1 - 0.2 = 0.8. Only e2 is missing, so it receives the full residual.
    expect(currentVal?.value).toBeCloseTo(0.8, 6);
  });
});


