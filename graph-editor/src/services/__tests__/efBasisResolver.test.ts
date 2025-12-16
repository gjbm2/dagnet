import { describe, it, expect } from 'vitest';
import { computeEFBasisForLayer } from '../efBasisResolver';
import type { Graph } from '../../types';

describe('efBasisResolver', () => {
  it('derives evidence residual across missing siblings when any explicit evidence exists', () => {
    const graph: Graph = {
      nodes: [{ id: 'n', uuid: 'n' } as any],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n', to: 'x', p: { mean: 0.25 } } as any,
        { id: 'e2', uuid: 'e2', from: 'n', to: 'y', p: { mean: 0.75 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const layerParams = {
      edges: {
        e1: { p: { mean: 0.25, evidence: { mean: 0.3 } } },
        e2: { p: { mean: 0.75 } },
      },
    };

    const maps = computeEFBasisForLayer(graph, layerParams);
    const e1 = maps.evidence.get('e1')!;
    const e2 = maps.evidence.get('e2')!;

    expect(e1.groupHasAnyExplicit).toBe(true);
    expect(e1.isExplicit).toBe(true);
    expect(e1.isDerived).toBe(false);
    expect(e1.value).toBeCloseTo(0.3, 12);

    // Residual = 1 - 0.3 = 0.7. Only e2 is missing, so it receives the full residual.
    expect(e2.groupHasAnyExplicit).toBe(true);
    expect(e2.isExplicit).toBe(false);
    expect(e2.isDerived).toBe(true);
    expect(e2.value).toBeCloseTo(0.7, 12);
  });

  it('derives forecast residual across missing siblings ONLY when any explicit forecast exists', () => {
    const graph: Graph = {
      nodes: [{ id: 'n', uuid: 'n' } as any],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n', to: 'x', p: { mean: 0.25 } } as any,
        { id: 'e2', uuid: 'e2', from: 'n', to: 'y', p: { mean: 0.75 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const layerParams = {
      edges: {
        e1: { p: { mean: 0.25, forecast: { mean: 0.2 } } },
        e2: { p: { mean: 0.75 } },
      },
    };

    const maps = computeEFBasisForLayer(graph, layerParams);
    const f1 = maps.forecast.get('e1')!;
    const f2 = maps.forecast.get('e2')!;

    expect(f1.groupHasAnyExplicit).toBe(true);
    expect(f1.isExplicit).toBe(true);
    expect(f1.isDerived).toBe(false);
    expect(f1.value).toBeCloseTo(0.2, 12);

    // Residual = 1 - 0.2 = 0.8. Only e2 is missing, so it receives the full residual.
    expect(f2.groupHasAnyExplicit).toBe(true);
    expect(f2.isExplicit).toBe(false);
    expect(f2.isDerived).toBe(true);
    expect(f2.value).toBeCloseTo(0.8, 12);
  });

  it('does not fabricate forecasts when no explicit forecast exists anywhere in the sibling group', () => {
    const graph: Graph = {
      nodes: [{ id: 'n', uuid: 'n' } as any],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n', to: 'x', p: { mean: 0.4 } } as any,
        { id: 'e2', uuid: 'e2', from: 'n', to: 'y', p: { mean: 0.6 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const layerParams = {
      edges: {
        e1: { p: { mean: 0.4 } },
        e2: { p: { mean: 0.6 } },
      },
    };

    const maps = computeEFBasisForLayer(graph, layerParams);
    const f1 = maps.forecast.get('e1')!;
    const f2 = maps.forecast.get('e2')!;

    expect(f1.groupHasAnyExplicit).toBe(false);
    expect(f1.isExplicit).toBe(false);
    expect(f1.isDerived).toBe(false);

    expect(f2.groupHasAnyExplicit).toBe(false);
    expect(f2.isExplicit).toBe(false);
    expect(f2.isDerived).toBe(false);
  });

  it('supports id/uuid aliases when looking up layer params', () => {
    const graph: Graph = {
      nodes: [{ id: 'n', uuid: 'n' } as any],
      edges: [
        // id differs from uuid; params are keyed by id only.
        { id: 'edge-human', uuid: 'edge-uuid', from: 'n', to: 'x', p: { mean: 1 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const layerParams = {
      edges: {
        'edge-human': { p: { mean: 1, forecast: { mean: 0.9 } } },
      },
    };

    const maps = computeEFBasisForLayer(graph, layerParams);
    expect(maps.forecast.get('edge-human')?.isExplicit).toBe(true);
    expect(maps.forecast.get('edge-uuid')?.isExplicit).toBe(true);
    expect(maps.forecast.get('edge-uuid')?.value).toBeCloseTo(0.9, 12);
  });
});



