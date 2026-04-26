import { describe, it, expect } from 'vitest';
import { extractParamsFromGraph, extractDiffParams } from '../GraphParamExtractor';

describe('GraphParamExtractor - topological ordering', () => {
  it('orders edge params in topological order (by from-node rank then to-node rank)', () => {
    const graph: any = {
      nodes: [
        { uuid: 'A', id: 'A' },
        { uuid: 'B', id: 'B' },
        { uuid: 'C', id: 'C' },
      ],
      edges: [
        // Intentionally out of topo order
        { uuid: 'e2', id: 'e2', from: 'B', to: 'C', p: { mean: 0.2 } },
        { uuid: 'e1', id: 'e1', from: 'A', to: 'B', p: { mean: 0.1 } },
      ],
    };

    const params = extractParamsFromGraph(graph);
    const edgeKeys = Object.keys(params.edges ?? {});
    expect(edgeKeys).toEqual(['e1', 'e2']);
  });

  it('extracts p.n from edge probabilities', () => {
    const graph: any = {
      nodes: [{ uuid: 'A', id: 'A' }, { uuid: 'B', id: 'B' }],
      edges: [{ uuid: 'e1', id: 'e1', from: 'A', to: 'B', p: { mean: 0.2, n: 42 } }],
    };

    const params = extractParamsFromGraph(graph);
    expect(params.edges?.e1?.p?.n).toBe(42);
  });

  it('captures non-mean probability diffs without re-emitting unchanged p.mean', () => {
    const baseGraph: any = {
      nodes: [{ uuid: 'A', id: 'A' }, { uuid: 'B', id: 'B' }],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          p: {
            mean: 0.25,
            stdev: 0.03,
            n: 100,
            posterior: { alpha: 1, beta: 3 },
          },
          conditional_p: [
            {
              condition: 'visited(node-a)',
              p: { mean: 0.4, n: 50, posterior: { alpha: 2, beta: 2 } },
            },
          ],
        },
      ],
    };

    const modifiedGraph: any = {
      nodes: [{ uuid: 'A', id: 'A' }, { uuid: 'B', id: 'B' }],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          p: {
            mean: 0.25, // unchanged
            stdev: 0.03, // unchanged
            n: 140,
            posterior: { alpha: 5, beta: 3 },
          },
          conditional_p: [
            {
              condition: 'visited(node-a)',
              p: {
                mean: 0.4, // unchanged
                n: 60,
                posterior: { alpha: 7, beta: 2 },
              },
            },
          ],
        },
      ],
    };

    const diff = extractDiffParams(modifiedGraph, baseGraph);
    const edgeDiff = diff.edges?.e1;
    expect(edgeDiff?.p?.n).toBe(140);
    expect(edgeDiff?.p?.posterior?.alpha).toBe(5);
    expect(edgeDiff?.p?.mean).toBeUndefined();
    expect(edgeDiff?.conditional_p?.['visited(node-a)']?.n).toBe(60);
    expect(edgeDiff?.conditional_p?.['visited(node-a)']?.posterior?.alpha).toBe(7);
    expect(edgeDiff?.conditional_p?.['visited(node-a)']?.mean).toBeUndefined();
  });
});



