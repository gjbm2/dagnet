/**
 * Cohort conversion window propagation test
 *
 * Verifies that `conversion_window_days` (computed by buildDslFromEdge and stored on queryPayload.cohort)
 * is preserved into the DAS runner `cohort` execution context, so the Amplitude adapter appends `cs=...`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import type { Graph } from '../../types';
import path from 'path';
import { fileURLToPath } from 'url';
import { sessionLogService } from '../sessionLogService';

// In node env, DASRunnerFactory defaults to ./config/connections.yaml which doesn't exist in the repo.
// For this test we want the real Amplitude adapter behaviour, so point DAS at the shipped defaults.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionsPath = path.join(__dirname, '../../../public/defaults/connections.yaml');

vi.mock('../../lib/das', async () => {
  const actual = await vi.importActual<any>('../../lib/das');
  return {
    ...actual,
    createDASRunner: (options: any = {}) =>
      actual.createDASRunner({ ...options, serverConnectionsPath: connectionsPath }),
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

describe('cohort conversion window propagation (cs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('includes cs= in Amplitude cohort-mode dry-run request when conversion_window_days is present', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        // Anchor must exist and have event_id so cohort mode becomes a 3-step funnel
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
          p: {
            id: 'p1',
            connection: 'amplitude-prod',
            latency: {
              latency_parameter: true,
              anchor_node_id: 'A',
              // Ensure conversion_window_days is positive via path_t95 fallback chain
              path_t95: 12,
              t95: 10,
            },
          },
          query: 'from(B).to(C)',
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    const addChildSpy = vi.spyOn(sessionLogService, 'addChild');

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'e1',
      graph,
      // dry-run must not mutate graph
      setGraph: undefined,
      writeToFile: true,
      bustCache: true,
      currentDSL: 'cohort(-7d:)',
      targetSlice: 'cohort(-7d:)',
      dontExecuteHttp: true,
    });

    const dryRunEvents = addChildSpy.mock.calls.filter((c) => c[2] === 'DRY_RUN_HTTP');
    const payload = dryRunEvents.map((c) => c[5] as any).find((m) => m?.httpCommand)?.httpCommand as string | undefined;

    // The adapter appends cs=<seconds> for cohort mode when conversion_window_days is present.
    expect(payload).toBeTruthy();
    expect(payload).toContain('cs=');
  });
});


