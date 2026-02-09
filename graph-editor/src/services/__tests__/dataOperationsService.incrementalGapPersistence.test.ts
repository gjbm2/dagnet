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
import { sessionLogService } from '../sessionLogService';

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

// Composite executor is dynamically imported by dataOperationsService.
// We mock it here so we can force rate limit errors deterministically.
const compositeExecuteSpy = vi.fn();
vi.mock('../../lib/das/compositeQueryExecutor', () => ({
  executeCompositeQuery: (...args: any[]) => compositeExecuteSpy(...args),
}));

const { fileRegistry } = await import('../../contexts/TabContext');
const { dataOperationsService } = await import('../dataOperationsService');

describe('dataOperationsService.getFromSourceDirect persists successful gaps immediately', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
    executeSpy.mockReset();
    compositeExecuteSpy.mockReset();
  });

  it('does not misclassify "executed but returned no daily data" as cacheHit (plan-interpreter override windows)', async () => {
    const addChildSpy = vi.spyOn(sessionLogService, 'addChild');

    // No cached values; this should attempt external fetch for the override window.
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [],
    });

    executeSpy.mockResolvedValue({
      success: true,
      updates: [],
      raw: {
        time_series: [],
        n: 0,
        k: 0,
      },
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

    const result = await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'e1',
      graph,
      setGraph: () => {},
      writeToFile: true,
      bustCache: false,
      currentDSL: 'window(1-Dec-25:5-Dec-25)',
      targetSlice: 'window(1-Dec-25:5-Dec-25)',
      overrideFetchWindows: [{ start: '1-Dec-25', end: '5-Dec-25' }],
    } as any);

    expect(result.daysFetched).toBe(0);
    expect(result.cacheHit).toBe(false);

    // Explicit warning emitted for plan-interpreter (override windows) empty response.
    const noDataCalls = addChildSpy.mock.calls.filter((c) => c[2] === 'FETCH_NO_DATA_RETURNED');
    expect(noDataCalls.length).toBeGreaterThan(0);
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

  it('throws on rate limit after partial gap persistence when enforceAtomicityScopeS=true (so orchestrator can cooldown + restart S)', async () => {
    // Same setup as the resumability test, but with enforcement enabled:
    // - gap 1 succeeds and is persisted
    // - gap 2 fails with a rate-limit error
    // - we MUST throw (even though gap 1 was persisted) so retrieve-all automation can cooldown and restart S
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:5-Dec-25)',
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
    executeSpy.mockImplementation(async () => {
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
      // Rate limit on later gap (after some persistence already happened)
      return { success: false, error: '429 Too Many Requests: Exceeded rate limit' };
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

    let caught: unknown = undefined;
    try {
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
        enforceAtomicityScopeS: true,
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/429|rate limit|Too Many Requests/i);

    // Even though we threw, the first gap should still have been persisted (resumability invariant).
    expect((fileRegistry as any).updateFile).toHaveBeenCalled();
    const stored = (fileRegistry as any)._mockFiles.get('parameter-p1')?.data;
    const allDates: string[] = (stored.values ?? []).flatMap((v: any) => v.dates ?? []);
    expect(allDates).toContain('1-Dec-25');
    expect(allDates).toContain('2-Dec-25');
  });

  it('throws on composite-query rate limit after partial persistence when enforceAtomicityScopeS=true', async () => {
    // Force composite path by using an already-composite query string.
    // Gap 1 succeeds and is persisted; gap 2 throws a 429 in the composite executor.
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:5-Dec-25)',
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
    compositeExecuteSpy.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          n: 100,
          k: 10,
          p_mean: 0.1,
          evidence: {
            time_series: [
              { date: '1-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '2-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
          },
        };
      }
      throw new Error('429 Too Many Requests: Exceeded rate limit');
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
          // Already-composite query (forces isComposite=true)
          query: 'from(a).to(b).minus(from(x).to(y))',
          p: { id: 'p1', connection: 'amplitude-test' },
        } as any,
      ],
      currentQueryDSL: 'window(1-Dec-25:5-Dec-25)',
    } as any;

    let caught: unknown = undefined;
    try {
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
        enforceAtomicityScopeS: true,
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/429|rate limit|Too Many Requests/i);

    // First gap still persisted
    const stored = (fileRegistry as any)._mockFiles.get('parameter-p1')?.data;
    const allDates: string[] = (stored.values ?? []).flatMap((v: any) => v.dates ?? []);
    expect(allDates).toContain('1-Dec-25');
    expect(allDates).toContain('2-Dec-25');
  });

  it('throws on explicit n_query base-query rate limit after partial persistence when enforceAtomicityScopeS=true', async () => {
    // Trigger dual-query by adding explicit n_query on the edge.
    // Base query fails with a 429 on the second gap after first gap persisted.
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:5-Dec-25)',
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

    // executeSpy is used for both base and conditioned queries in the simple dual-query branch.
    // We simulate:
    // - gap1: base succeeds, conditioned succeeds (writes)
    // - gap2: base fails with 429 (after partial persistence)
    let call = 0;
    executeSpy.mockImplementation(async (_connectionName: string, _queryPayload: any) => {
      call += 1;
      // First gap: base (n_query) and conditioned (k) both succeed with daily data
      if (call === 1 || call === 2) {
        return {
          success: true,
          updates: [],
          raw: {
            time_series: [
              { date: '1-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '2-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
            n: 100,
            k: 10,
          },
        };
      }
      // Second gap: base fails with 429 (this should throw under enforcement)
      if (call === 3) {
        return { success: false, error: '429 Too Many Requests: Exceeded rate limit' };
      }
      // Conditioned would not be reached if we throw on base failure, but keep safe default
      return { success: false, error: 'unexpected' };
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
          // Explicit n_query triggers needsDualQuery
          n_query: 'to(a)',
          p: { id: 'p1', connection: 'amplitude-test' },
        } as any,
      ],
      currentQueryDSL: 'window(1-Dec-25:5-Dec-25)',
    } as any;

    let caught: unknown = undefined;
    try {
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
        enforceAtomicityScopeS: true,
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/429|rate limit|Too Many Requests/i);

    // First gap still persisted
    const stored = (fileRegistry as any)._mockFiles.get('parameter-p1')?.data;
    const allDates: string[] = (stored.values ?? []).flatMap((v: any) => v.dates ?? []);
    expect(allDates).toContain('1-Dec-25');
    expect(allDates).toContain('2-Dec-25');
  });

  it('throws on conditioned-query rate limit after partial persistence when enforceAtomicityScopeS=true', async () => {
    // Dual-query path: base succeeds but conditioned fails with 429 on a later gap,
    // after earlier gaps were already persisted.
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:5-Dec-25)',
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

    // Call order in simple dual-query branch:
    // gap1 base, gap1 conditioned, gap2 base, gap2 conditioned (fails)
    let call = 0;
    executeSpy.mockImplementation(async () => {
      call += 1;
      // gap1 base + conditioned succeed with daily data (persisted)
      if (call === 1 || call === 2) {
        return {
          success: true,
          updates: [],
          raw: {
            time_series: [
              { date: '1-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '2-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
            n: 100,
            k: 10,
          },
        };
      }
      // gap2 base succeeds (not persisted without conditioned success)
      if (call === 3) {
        return {
          success: true,
          updates: [],
          raw: {
            time_series: [
              { date: '4-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '5-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
            n: 100,
            k: 10,
          },
        };
      }
      // gap2 conditioned fails with rate limit -> must throw under enforcement
      return { success: false, error: '429 Too Many Requests: Exceeded rate limit' };
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
          n_query: 'to(a)',
          p: { id: 'p1', connection: 'amplitude-test' },
        } as any,
      ],
      currentQueryDSL: 'window(1-Dec-25:5-Dec-25)',
    } as any;

    let caught: unknown = undefined;
    try {
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
        enforceAtomicityScopeS: true,
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/429|rate limit|Too Many Requests/i);

    // gap1 still persisted
    const stored = (fileRegistry as any)._mockFiles.get('parameter-p1')?.data;
    const allDates: string[] = (stored.values ?? []).flatMap((v: any) => v.dates ?? []);
    expect(allDates).toContain('1-Dec-25');
    expect(allDates).toContain('2-Dec-25');
  });

  it('throws on explicit n_query (composite) rate limit after partial persistence when enforceAtomicityScopeS=true', async () => {
    // Dual-query with explicit n_query that is composite (minus/plus form).
    // Base n_query uses composite executor; second gap 429 must throw under enforcement.
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-test',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:5-Dec-25)',
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

    let baseCall = 0;
    compositeExecuteSpy.mockImplementation(async () => {
      baseCall += 1;
      if (baseCall === 1) {
        return {
          n: 100,
          k: 10,
          p_mean: 0.1,
          evidence: {
            time_series: [
              { date: '1-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '2-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
          },
        };
      }
      throw new Error('429 Too Many Requests: Exceeded rate limit');
    });

    // Conditioned query (main query) succeeds for gap1.
    // For gap2, we should throw before conditioned query runs, but keep safe default.
    let condCall = 0;
    executeSpy.mockImplementation(async () => {
      condCall += 1;
      if (condCall === 1) {
        return {
          success: true,
          updates: [],
          raw: {
            time_series: [
              { date: '1-Dec-25', n: 50, k: 5, p: 0.1 },
              { date: '2-Dec-25', n: 50, k: 5, p: 0.1 },
            ],
            n: 100,
            k: 10,
          },
        };
      }
      return { success: false, error: 'unexpected' };
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
          // Already composite n_query (so nQueryIsComposite=true without compilation helpers)
          n_query: 'to(a).minus(to(x))',
          p: { id: 'p1', connection: 'amplitude-test' },
        } as any,
      ],
      currentQueryDSL: 'window(1-Dec-25:5-Dec-25)',
    } as any;

    let caught: unknown = undefined;
    try {
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
        enforceAtomicityScopeS: true,
      } as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/429|rate limit|Too Many Requests/i);

    // gap1 still persisted
    const stored = (fileRegistry as any)._mockFiles.get('parameter-p1')?.data;
    const allDates: string[] = (stored.values ?? []).flatMap((v: any) => v.dates ?? []);
    expect(allDates).toContain('1-Dec-25');
    expect(allDates).toContain('2-Dec-25');
  });
});


