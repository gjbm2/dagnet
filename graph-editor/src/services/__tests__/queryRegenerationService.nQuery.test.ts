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

// Mock the Python compute client so we can inspect the payload that would be sent to MSMDC.
vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    generateAllParameters: vi.fn(),
  },
}));

const { graphComputeClient } = await import('../../lib/graphComputeClient');

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

  it('applies anchor_node_id to edge and parameter file when not overridden', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 }, entry: { is_start: true } } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', latency: {} } as any,
          query: 'from(A).to(B)',
          query_overridden: false,
          n_query_overridden: false,
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      query_overridden: false,
      n_query_overridden: false,
      latency: {
        anchor_node_id_overridden: false,
      },
    });

    const parameters: any[] = [
      { paramType: 'edge_base_p', paramId: 'p1', edgeKey: 'A->B', query: 'from(A).to(B)', nQuery: 'from(A).to(B)', stats: { checks: 0, literals: 0 } },
    ];

    await queryRegenerationService.applyRegeneratedQueries(graph, parameters as any, { e1: 'A' });

    expect((graph.edges[0] as any).p.latency.anchor_node_id).toBe('A');
    const file = (fileRegistry as any).getFile('parameter-p1');
    expect(file.data.latency.anchor_node_id).toBe('A');
  });

  it('does not write anchor_node_id to parameter file when file override flag is true', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 }, entry: { is_start: true } } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', latency: {} } as any,
          query: 'from(A).to(B)',
          query_overridden: false,
          n_query_overridden: false,
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      query_overridden: false,
      n_query_overridden: false,
      latency: {
        anchor_node_id_overridden: true,
        anchor_node_id: 'manual-anchor',
      },
    });

    const parameters: any[] = [
      { paramType: 'edge_base_p', paramId: 'p1', edgeKey: 'A->B', query: 'from(A).to(B)', nQuery: 'from(A).to(B)', stats: { checks: 0, literals: 0 } },
    ];

    await queryRegenerationService.applyRegeneratedQueries(graph, parameters as any, { e1: 'A' });

    // Graph is allowed to update (file override only blocks file write)
    expect((graph.edges[0] as any).p.latency.anchor_node_id).toBe('A');
    const file = (fileRegistry as any).getFile('parameter-p1');
    expect(file.data.latency.anchor_node_id).toBe('manual-anchor');
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

  it('applies nQuery from regenerated conditional_p payload (conditional-only regeneration)', async () => {
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
          conditional_p: [
            { condition: 'visited(x)', p: { id: 'cp1', mean: 0.5 } as any } as any,
          ],
          query: 'from(A).to(B)',
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

    // Simulate a backend response when regenerating ONLY the conditional:
    // paramId is the conditional param's id, but nQuery should still apply to the EDGE (base p1).
    const parameters: any[] = [
      {
        paramType: 'edge_conditional_p',
        paramId: 'cp1',
        edgeUuid: 'e1',
        edgeKey: 'A->B',
        condition: 'visited(x)',
        query: 'from(A).to(B).visited(x)',
        nQuery: 'to(A)',
        stats: { checks: 0, literals: 0 },
      },
    ];

    await queryRegenerationService.applyRegeneratedQueries(graph, parameters as any);

    expect((graph.edges[0] as any).n_query).toBe('to(A)');
    const file = (fileRegistry as any).getFile('parameter-p1');
    expect(file.data.n_query).toBe('to(A)');
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

describe('QueryRegenerationService - backend payload sanitisation', () => {
  beforeEach(() => {
    vi.mocked(graphComputeClient.generateAllParameters).mockReset();
    vi.mocked(graphComputeClient.generateAllParameters).mockResolvedValue({
      parameters: [],
      anchors: {},
    } as any);
  });

  it('strips node images before sending graph to Python MSMDC API', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        {
          id: 'node-1',
          uuid: 'uuid-1',
          images: [
            {
              image_id: 'node-1-img',
              caption: 'Image 1',
              file_extension: 'png',
              caption_overridden: false,
            } as any,
          ],
          images_overridden: true,
        } as any,
      ],
      edges: [],
    };

    await queryRegenerationService.regenerateQueries(graph, {
      literalWeights: { visited: 10, exclude: 1 },
      preserveCondition: true,
    });

    expect(graphComputeClient.generateAllParameters).toHaveBeenCalledTimes(1);

    const [payloadGraph] = vi.mocked(graphComputeClient.generateAllParameters).mock.calls[0];
    expect((payloadGraph as any).nodes[0].images).toBeUndefined();
    expect((payloadGraph as any).nodes[0].images_overridden).toBeUndefined();
  });
});


