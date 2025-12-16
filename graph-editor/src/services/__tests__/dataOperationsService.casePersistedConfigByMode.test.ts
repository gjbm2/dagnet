/**
 * DataOperationsService – case persisted config usage by mode
 *
 * Ensures:
 * - versionedCase=true prefers case file connection/connection_string
 * - versionedCase=false prefers graph node inline case connection/connection_string
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

// Mock DAS runner: capture connection name passed to execute
const executeSpy = vi.fn(async () => ({
  success: true,
  raw: { request: { method: 'GET', url: 'https://example.test' } },
}));

vi.mock('../../lib/das', () => ({
  createDASRunner: () => ({
    connectionProvider: {
      getConnection: vi.fn(async () => ({
        provider: 'statsig',
        requires_event_ids: false,
        capabilities: { supports_daily_time_series: false },
      })),
    },
    execute: (...args: any[]) => executeSpy(...args),
  }),
}));

const { fileRegistry } = await import('../../contexts/TabContext');

describe('dataOperationsService.getFromSourceDirect uses correct case persisted config by mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('versionedCase=true uses case file connection', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        {
          id: 'N1',
          uuid: 'N1',
          type: 'case',
          label: 'CaseNode',
          layout: { x: 0, y: 0 },
          case: { id: 'c1', connection: 'graph-conn', connection_string: '{"a":2}', variants: [] },
        } as any,
      ],
      edges: [],
    };

    await (fileRegistry as any).registerFile('case-c1', {
      id: 'c1',
      connection: 'file-conn',
      connection_string: '{"a":1}',
      case: { variants: [] },
      schedules: [],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'case',
      objectId: 'c1',
      targetId: 'N1',
      graph,
      setGraph: () => {},
      versionedCase: true,
      dontExecuteHttp: true,
    });

    expect(executeSpy).toHaveBeenCalled();
    expect(executeSpy.mock.calls[0][0]).toBe('file-conn');
  });

  it('versionedCase=false (direct) uses graph node case connection even if file exists', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        {
          id: 'N1',
          uuid: 'N1',
          type: 'case',
          label: 'CaseNode',
          layout: { x: 0, y: 0 },
          case: { id: 'c1', connection: 'graph-conn', connection_string: '{"a":2}', variants: [] },
        } as any,
      ],
      edges: [],
    };

    await (fileRegistry as any).registerFile('case-c1', {
      id: 'c1',
      connection: 'file-conn',
      connection_string: '{"a":1}',
      case: { variants: [] },
      schedules: [],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'case',
      objectId: 'c1',
      targetId: 'N1',
      graph,
      setGraph: () => {},
      versionedCase: false,
      dontExecuteHttp: true,
    });

    expect(executeSpy).toHaveBeenCalled();
    expect(executeSpy.mock.calls[0][0]).toBe('graph-conn');
  });
});




