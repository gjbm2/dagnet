/**
 * Query regeneration n_query application test
 *
 * Ensures that regenerated nQuery values are applied to graph/parameter files
 * when not overridden, and are skipped when n_query_overridden is true.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../types';
import { queryRegenerationService } from '../queryRegenerationService';

// Minimal fileRegistry mock (must match production import path)
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => mockFiles.get(id)),
      updateFile: vi.fn(async (id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      registerFile: vi.fn(async (id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      _mockFiles: mockFiles,
    },
  };
});

const { fileRegistry } = await import('../../contexts/TabContext');

describe('QueryRegenerationService n_query application', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('applies nQuery to edge and parameter file when not overridden', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } } as any,
        { id: 'C', uuid: 'C', label: 'C', event_id: 'c', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'B',
          to: 'C',
          p: { id: 'p1' } as any,
          query: 'from(B).to(C)',
          query_overridden: false,
          n_query_overridden: false,
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      query_overridden: false,
      n_query_overridden: false,
    });

    const parameters: any[] = [
      { paramType: 'edge_base_p', paramId: 'p1', edgeKey: 'B->C', query: 'from(B).to(C)', nQuery: 'from(A).to(B)', stats: { checks: 0, literals: 0 } },
    ];

    await queryRegenerationService.applyRegeneratedQueries(graph, parameters as any);

    expect((graph.edges[0] as any).n_query).toBe('from(A).to(B)');
    const file = (fileRegistry as any).getFile('parameter-p1');
    expect(file.data.n_query).toBe('from(A).to(B)');
  });

  it('does not apply nQuery when edge n_query_overridden is true', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1' } as any,
          query: 'from(A).to(B)',
          query_overridden: false,
          n_query_overridden: true,
          n_query: 'from(A).to(old)',
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      query_overridden: false,
      n_query_overridden: false,
      n_query: 'from(A).to(old)',
    });

    const parameters: any[] = [
      { paramType: 'edge_base_p', paramId: 'p1', edgeKey: 'A->B', query: 'from(A).to(B)', nQuery: 'from(A).to(new)', stats: { checks: 0, literals: 0 } },
    ];

    await queryRegenerationService.applyRegeneratedQueries(graph, parameters as any);

    expect((graph.edges[0] as any).n_query).toBe('from(A).to(old)');
  });
});


