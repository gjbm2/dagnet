/**
 * Direct fetch failure propagation test
 *
 * Ensures that getFromSourceDirect throws when the underlying DAS execute fails,
 * so batch operations report ITEM_ERROR and the batch summary counts failures.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import type { Graph } from '../../types';

// In node env, DASRunnerFactory defaults to ./config/connections.yaml which doesn't exist in the repo.
// We mock DAS runner and force execute() to fail.
vi.mock('../../lib/das', async () => {
  const execute = vi.fn(async () => ({ success: false, error: 'boom', phase: 'execute', details: {} }));
  const createDASRunner = vi.fn(() => ({
    connectionProvider: {
      getConnection: async () => ({ capabilities: { supports_native_exclude: true } }),
    },
    execute,
    getExecutionHistory: () => [],
  }));
  return {
    createDASRunner,
    __mock: { createDASRunner, execute },
  };
});

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Minimal fileRegistry mock (must match production import path)
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => mockFiles.get(id)),
      updateFile: vi.fn(async () => {}),
      registerFile: vi.fn(async (id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      _mockFiles: mockFiles,
    },
  };
});

const { fileRegistry } = await import('../../contexts/TabContext');
const { __mock } = await import('../../lib/das');

describe('dataOperationsService.getFromSourceDirect failure propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('throws on direct fetch failure so callers can count failures', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 }, entry: { is_start: true, entry_weight: 1 } } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod', latency: { anchor_node_id: 'A', latency_parameter: true, path_t95: 10 } } as any,
          query: 'from(A).to(B)',
        } as any,
      ],
    };

    // parameter file exists (minimal)
    await (fileRegistry as any).registerFile('parameter-p1', { id: 'p1', connection: 'amplitude-prod', values: [] });

    let caught: unknown = undefined;
    try {
      await dataOperationsService.getFromSourceDirect({
        objectType: 'parameter',
        objectId: 'p1',
        targetId: 'e1',
        graph,
        setGraph: () => {},
        writeToFile: false,
        bustCache: true,
        currentDSL: 'cohort(1-Nov-25:14-Nov-25)',
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/API call failed:/);
    
    // Ensure we actually exercised the DAS execution path in this test
    expect(__mock.createDASRunner).toHaveBeenCalled();
    expect(__mock.execute).toHaveBeenCalled();
  });
});


