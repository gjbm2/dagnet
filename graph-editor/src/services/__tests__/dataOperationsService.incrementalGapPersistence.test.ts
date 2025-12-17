/**
 * dataOperationsService – versioned parameter fetch should persist per-gap (resumability)
 *
 * Contract:
 * - When writeToFile=true and the requested window has multiple gaps,
 * - and a later gap fails (e.g. rate limit),
 * - then any earlier successful gaps MUST already be written to the parameter file.
 *
 * This enables "Retrieve all slices" to pick up where it left off on a re-run.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../types';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('../rateLimiter', () => ({
  rateLimiter: {
    waitForRateLimit: vi.fn(async () => {}),
    isRateLimitError: vi.fn(() => true),
    reportRateLimitError: vi.fn(() => {}),
    reportSuccess: vi.fn(() => {}),
  },
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    getSettings: vi.fn(async () => ({ data: { excludeTestAccounts: true } })),
  },
}));

vi.mock('../contextRegistry', () => ({
  contextRegistry: { clearCache: vi.fn(() => {}) },
}));

// Minimal in-memory file registry mock that actually persists updates
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => mockFiles.get(id)),
      updateFile: vi.fn(async (id: string, data: any) => {
        const existing = mockFiles.get(id) ?? {};
        mockFiles.set(id, { ...existing, data: structuredClone(data) });
      }),
      registerFile: vi.fn(async (id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      _mockFiles: mockFiles,
    },
  };
});

// Mock buildDslFromEdge to keep planning deterministic and avoid pulling in real DSL compilation
vi.mock('../../lib/das/buildDslFromEdge', () => ({
  buildDslFromEdge: vi.fn(async () => ({
    queryPayload: {
      start: '2025-12-01T00:00:00.000Z',
      end: '2025-12-05T23:59:59.000Z',
    },
    eventDefinitions: {},
  })),
}));

// Mock DAS runner: first gap succeeds with daily data; second gap fails (rate limit)
const executeSpy = vi.fn();
vi.mock('../../lib/das', () => ({
  createDASRunner: () => ({
    connectionProvider: {
      getConnection: vi.fn(async () => ({
        provider: 'amplitude',
        requires_event_ids: true,
        capabilities: { supports_daily_time_series: true },
      })),
    },
    getExecutionHistory: vi.fn(() => []),
    execute: (...args: any[]) => executeSpy(...args),
  }),
}));

const { fileRegistry } = await import('../../contexts/TabContext');
const { dataOperationsService } = await import('../dataOperationsService');

describe('dataOperationsService.getFromSourceDirect persists successful gaps immediately', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
    executeSpy.mockReset();
  });

  it('writes first gap to file even if second gap fails', async () => {
    // Parameter file has only 3-Dec-25 cached, so window(1-Dec-25:5-Dec-25) has two missing gaps: 1-2 and 4-5.
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:5-Dec-25)',
          // Only one cached day; window_from/to must reflect that day so incremental fetch sees gaps.
          window_from: '3-Dec-25',
          window_to: '3-Dec-25',
          dates: ['3-Dec-25'],
          n_daily: [100],
          k_daily: [10],
          n: 100,
          k: 10,
          mean: 0.1,
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    });

    let call = 0;
    executeSpy.mockImplementation(async (_connectionName: string, _queryPayload: any, _opts: any) => {
      call += 1;
      if (call === 1) {
        return {
          success: true,
          updates: [],
          raw: {
            time_series: [
              { date: '1-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '2-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
          },
        };
      }
      return { success: false, error: 'Rate limited' };
    });

    const graph: Graph = {
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a' } as any,
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b' } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          query: 'from(a).to(b)',
          p: { id: 'p1', connection: 'amplitude-test' },
        } as any,
      ],
      currentQueryDSL: 'window(1-Dec-25:5-Dec-25)',
    } as any;

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'e1',
      graph,
      setGraph: () => {},
      writeToFile: true,
      bustCache: false,
      currentDSL: 'window(1-Dec-25:5-Dec-25)',
      targetSlice: 'window(1-Dec-25:5-Dec-25)',
    });

    // Ensure at least one write happened (first gap persisted)
    expect((fileRegistry as any).updateFile).toHaveBeenCalled();

    const stored = (fileRegistry as any)._mockFiles.get('parameter-p1')?.data;
    expect(stored).toBeTruthy();
    const allDates: string[] = (stored.values ?? []).flatMap((v: any) => v.dates ?? []);

    // The first gap's dates should be present in the file even though the second gap failed.
    expect(allDates).toContain('1-Dec-25');
    expect(allDates).toContain('2-Dec-25');
  });
});


