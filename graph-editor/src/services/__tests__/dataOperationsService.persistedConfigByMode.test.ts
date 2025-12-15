/**
 * DataOperationsService – persisted config usage by retrieval mode
 *
 * This catches the class of bugs where versioned retrieval accidentally uses stale graph config
 * (or direct retrieval accidentally consults file config) for horizon primitives.
 *
 * We assert which latency config is passed into buildDslFromEdge, because that controls
 * cohort conversion window construction (cs/conversion_window_days) and related planning.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../types';
import { dataOperationsService } from '../dataOperationsService';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('../rateLimiter', () => ({
  rateLimiter: {
    waitForRateLimit: vi.fn(async () => {}),
    isRateLimitError: vi.fn(() => false),
    reportRateLimitError: vi.fn(() => {}),
    reportSuccess: vi.fn(() => {}),
  },
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    getSettings: vi.fn(async () => ({ data: { excludeTestAccounts: true } })),
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

// Make contextRegistry a no-op for node env
vi.mock('../contextRegistry', () => ({
  contextRegistry: { clearCache: vi.fn(() => {}) },
}));

// Mock DAS runner (no external HTTP) + connection lookup
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
      raw: { request: { method: 'GET', url: 'https://example.test' } },
    })),
  }),
}));

// Capture buildDslFromEdge calls
const buildDslFromEdgeSpy = vi.fn(async () => ({
  queryPayload: { start: '2025-12-01T00:00:00.000Z', end: '2025-12-15T00:00:00.000Z' },
  eventDefinitions: {},
}));

vi.mock('../../lib/das/buildDslFromEdge', () => ({
  buildDslFromEdge: (...args: any[]) => buildDslFromEdgeSpy(...args),
}));

const { fileRegistry } = await import('../../contexts/TabContext');

describe('dataOperationsService.getFromSourceDirect uses correct persisted config by mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('in versioned mode (writeToFile=true), uses file connection + file latency.path_t95 for buildDslFromEdge when present', async () => {
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
          query: 'from(a).to(b)',
          p: {
            id: 'p1',
            connection: 'amplitude-prod-graph',
            latency: { latency_parameter: true, anchor_node_id: 'A', t95: 13.12, path_t95: 26 },
          },
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod-file',
      latency: { latency_parameter: true, anchor_node_id: 'A', t95: 13.12, path_t95: 40 },
      values: [],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'e1',
      graph,
      setGraph: () => {},
      writeToFile: true,
      bustCache: true,
      currentDSL: 'cohort(1-Dec-25:15-Dec-25)',
      targetSlice: 'cohort(1-Dec-25:15-Dec-25)',
      dontExecuteHttp: true,
    });

    expect(buildDslFromEdgeSpy).toHaveBeenCalled();
    const edgeArg = buildDslFromEdgeSpy.mock.calls[0][0];
    expect(edgeArg.p.latency.path_t95).toBe(40);
    expect(edgeArg.p.connection).toBe('amplitude-prod-file');
  });

  it('in direct mode (writeToFile=false), uses graph connection + graph latency.path_t95 even if file differs', async () => {
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
          query: 'from(a).to(b)',
          p: {
            id: 'p1',
            connection: 'amplitude-prod-graph',
            latency: { latency_parameter: true, anchor_node_id: 'A', t95: 13.12, path_t95: 26 },
          },
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod-file',
      latency: { latency_parameter: true, anchor_node_id: 'A', t95: 13.12, path_t95: 40 },
      values: [],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'e1',
      graph,
      setGraph: () => {},
      writeToFile: false,
      bustCache: true,
      currentDSL: 'cohort(1-Dec-25:15-Dec-25)',
      targetSlice: 'cohort(1-Dec-25:15-Dec-25)',
      dontExecuteHttp: true,
    });

    expect(buildDslFromEdgeSpy).toHaveBeenCalled();
    const edgeArg = buildDslFromEdgeSpy.mock.calls[0][0];
    expect(edgeArg.p.latency.path_t95).toBe(26);
    expect(edgeArg.p.connection).toBe('amplitude-prod-graph');
  });
});


