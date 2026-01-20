/**
 * AllSlices simulation tests
 *
 * Verifies that "Retrieve All" simulate mode runs the REAL codepaths but:
 * - does not execute external HTTP (dry-run request construction only)
 * - does not write files
 * - emits DRY_RUN_HTTP entries in the session log (including httpCommand)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieveAllSlicesService } from '../retrieveAllSlicesService';
import { sessionLogService } from '../sessionLogService';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Mock DAS runner: no external HTTP, but return a request that can be logged in DRY_RUN_HTTP.
vi.mock('../../lib/das', () => ({
  createDASRunner: () => ({
    connectionProvider: {
      getConnection: vi.fn(async () => ({
        provider: 'amplitude',
        requires_event_ids: true,
        capabilities: { supports_daily_time_series: true },
      })),
    },
    execute: vi.fn(async () => ({
      success: true,
      raw: { request: { method: 'POST', url: 'https://amplitude.example.test/api', headers: { Authorization: 'secret' }, body: { x: 1 } } },
    })),
  }),
}));

// Minimal fileRegistry mock (must be the same module path as production imports)
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

describe('Retrieve All Slices simulate mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('runs the real retrieve-all loop with dontExecuteHttp and does not write files', async () => {
    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } } as any,
        { id: 'X', uuid: 'X', label: 'X', event_id: 'x', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod', latency: { latency_parameter: true, t95: 10 } },
          conditional_p: [
            {
              condition: 'visited(X)',
              p: { id: 'cp1', connection: 'amplitude-prod' },
              query: 'from(A).to(B).visited(X)',
            },
          ],
          query: 'from(A).to(B)',
        } as any,
      ],
    };

    // Provide a parameter file with minimal structure (no values)
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });
    await (fileRegistry as any).registerFile('parameter-cp1', {
      id: 'cp1',
      connection: 'amplitude-prod',
      values: [],
    });

    let currentGraph: any = graph;
    const addChildSpy = vi.spyOn(sessionLogService, 'addChild');

    await retrieveAllSlicesService.execute({
      getGraph: () => currentGraph,
      setGraph: (g) => {
        // Simulate mode should not call this, but keep it safe.
        currentGraph = g;
      },
      slices: ['cohort(-7d:)'],
      bustCache: true,
      simulate: true,
    });

    // No file writes in simulation
    expect((fileRegistry as any).updateFile).not.toHaveBeenCalled();

    const dryRunEvents = addChildSpy.mock.calls.filter((c) => c[2] === 'DRY_RUN_HTTP');
    expect(dryRunEvents.length).toBeGreaterThan(0);
    const hasHttpCommand = dryRunEvents.some((c) => {
      const meta = c[5] as any;
      return typeof meta?.httpCommand === 'string' && meta.httpCommand.length > 0;
    });
    expect(hasHttpCommand).toBe(true);
  });
});


