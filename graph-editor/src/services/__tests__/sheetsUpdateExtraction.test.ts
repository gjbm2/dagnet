import { describe, it, expect } from 'vitest';
import type { Graph } from '../../types';
import { extractSheetsUpdateData } from '../dataOperationsService';

describe('extractSheetsUpdateData', () => {
  const graph: Graph = {
    edges: [
      { uuid: 'edge-1-uuid', id: 'edge-1', from: 'n1', to: 'n2' } as any,
      { uuid: 'edge-2-uuid', id: 'edge-2', from: 'n2', to: 'n3' } as any,
    ],
    nodes: [],
    policies: {
      default_outcome: 'abandon',
      overflow_policy: 'error',
      free_edge_policy: 'complement',
    },
    metadata: {
      version: '1.0.0',
      created_at: new Date().toISOString(),
    },
  };

  it('uses scalar_value as mean in single mode when no param_pack', () => {
    const raw = { scalar_value: 0.45 };
    const connectionString = { mode: 'single' };

    const update = extractSheetsUpdateData(raw, connectionString, 'p', graph, 'edge-1-uuid');

    expect(update).toEqual({ mean: 0.45 });
  });

  it('extracts contextual param_pack keys for current slot', () => {
    const raw = {
      param_pack: {
        mean: 0.3,
        stdev: 0.1,
        'cost_gbp.mean': 99, // different slot, should be ignored when paramSlot='p'
      },
    };
    const connectionString = { mode: 'param-pack' };

    const update = extractSheetsUpdateData(raw, connectionString, 'p', graph, 'edge-1-uuid');

    expect(update).toEqual({ mean: 0.3, stdev: 0.1 });
  });

  it('accepts HRN key for current edge and slot', () => {
    const raw = {
      param_pack: {
        'e.edge-1.p.mean': 0.55,
        'e.edge-1.p.n': 1000,
      },
    };
    const connectionString = { mode: 'param-pack' };

    const update = extractSheetsUpdateData(raw, connectionString, 'p', graph, 'edge-1-uuid');

    expect(update).toEqual({ mean: 0.55, n: 1000 });
  });

  it('skips HRN keys that resolve to a different edge', () => {
    const raw = {
      param_pack: {
        'e.edge-2.p.mean': 0.99,
      },
    };
    const connectionString = { mode: 'param-pack' };

    const update = extractSheetsUpdateData(raw, connectionString, 'p', graph, 'edge-1-uuid');

    expect(update).toEqual({});
  });

  it('skips HRN keys with different param slot', () => {
    const raw = {
      param_pack: {
        'e.edge-1.cost_gbp.mean': 123,
      },
    };
    const connectionString = { mode: 'param-pack' };

    const update = extractSheetsUpdateData(raw, connectionString, 'p', graph, 'edge-1-uuid');

    expect(update).toEqual({});
  });
});


