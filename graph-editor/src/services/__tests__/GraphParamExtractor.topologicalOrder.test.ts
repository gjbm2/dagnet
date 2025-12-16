import { describe, it, expect } from 'vitest';
import { extractParamsFromGraph } from '../GraphParamExtractor';

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
});



