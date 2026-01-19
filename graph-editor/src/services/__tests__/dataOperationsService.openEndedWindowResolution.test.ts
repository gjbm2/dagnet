/**
 * Regression tests: open-ended relative window resolution and default-window transparency.
 *
 * - window(-60d:) must resolve to a ~60-day window ending "today" (no fallback to ~7 days).
 * - If we ever do fall back to a default window, it must never be silent (session log warning).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Graph } from '../../types';
import { computeCohortRetrievalHorizon } from '../cohortRetrievalHorizon';
import { formatDateUK, parseUKDate, resolveRelativeDate } from '../../lib/dateFormat';
import { parseDate } from '../windowAggregationService';

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

// Minimal session log mock (must include addChild because we explicitly warn on default-window fallback)
const addChildSpy = vi.fn();
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op'),
    endOperation: vi.fn(),
    addChild: (...args: any[]) => addChildSpy(...args),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
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
        mockFiles.set(id, { data: structuredClone(data), isDirty: false });
      }),
      _mockFiles: mockFiles,
    },
  };
});

// Mock DAS runner and capture execute options (window payload)
const executeSpy = vi.fn(async (_connection: string, _payload: any, opts: any) => ({
  success: true,
  raw: { request: { method: 'GET', url: 'https://example.test', opts } },
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
const { dataOperationsService } = await import('../dataOperationsService');

function createTestGraph(edgeQuery: string): Graph {
  return {
    schema_version: '1.0.0',
    id: 'g1',
    name: 'Test',
    description: '',
    nodes: [
      { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 }, event_id: 'event-a' } as any,
      { id: 'B', uuid: 'B', label: 'B', layout: { x: 1, y: 1 }, event_id: 'event-b' } as any,
    ],
    edges: [
      {
        id: 'E1',
        uuid: 'E1',
        from: 'A',
        to: 'B',
        query: edgeQuery,
        p: { id: 'p1', connection: 'statsig', mean: 0.1 },
      } as any,
    ],
  } as any;
}

describe('dataOperationsService window resolution regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addChildSpy.mockClear();
    (fileRegistry as any)._mockFiles.clear();

    // Fix "today" deterministically: 17-Dec-25 (UTC midnight normalised internally)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-17T12:34:56.000Z'));

    // Minimal event files required by buildDslFromEdge event loader
    (fileRegistry as any).registerFile('event-event-a', {
      id: 'event-a',
      provider_event_names: { statsig: 'Event A' },
    });
    (fileRegistry as any).registerFile('event-event-b', {
      id: 'event-b',
      provider_event_names: { statsig: 'Event B' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves window(-60d:) to a ~60-day fetch window ending today (no ~7d fallback)', async () => {
    const graph = createTestGraph('from(A).to(B)');

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'E1',
      graph,
      setGraph: () => {},
      currentDSL: 'window(-60d:)',
      dontExecuteHttp: true,
    });

    expect(executeSpy).toHaveBeenCalled();

    const payload = executeSpy.mock.calls[0][1];
    const opts = executeSpy.mock.calls[0][2];
    expect(opts?.dryRun).toBe(true);

    // Expected: 17-Dec-25 (today) and 60 days earlier: 18-Oct-25
    expect(payload?.start).toBe('2025-10-18T00:00:00.000Z');
    expect(payload?.end).toBe('2025-12-17T00:00:00.000Z');
    expect(opts.window).toEqual({
      start: '2025-10-18T00:00:00.000Z',
      end: '2025-12-17T00:00:00.000Z',
    });
  });

  it('emits a DEFAULT_WINDOW_APPLIED warning when no explicit window/cohort range exists (never silent)', async () => {
    const graph = createTestGraph('from(A).to(B)');

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'E1',
      graph,
      setGraph: () => {},
      // No window(...) or cohort(...) at all -> must use default, but must warn.
      currentDSL: '',
      dontExecuteHttp: true,
    });

    expect(executeSpy).toHaveBeenCalled();

    const opts = executeSpy.mock.calls[0][2];
    expect(opts?.dryRun).toBe(true);
    expect(opts.window).toEqual({
      start: '2025-12-10T00:00:00.000Z',
      end: '2025-12-17T00:00:00.000Z',
    });

    // Ensure we logged the warning (opId, level, code, message, ...)
    const warned = addChildSpy.mock.calls.some((call) => call[1] === 'warning' && call[2] === 'DEFAULT_WINDOW_APPLIED');
    expect(warned).toBe(true);
  });

  it('uses bounded cohort window for replace_slice refetches', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g-cohort',
      name: 'Cohort Graph',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 }, event_id: 'event-a' } as any,
        { id: 'B', uuid: 'B', label: 'B', layout: { x: 1, y: 1 }, event_id: 'event-b' } as any,
      ],
      edges: [
        {
          id: 'E1',
          uuid: 'E1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: 'p1',
            connection: 'statsig',
            mean: 0.1,
            latency: {
              latency_parameter: true,
              t95: 10,
              path_t95: 10,
              anchor_node_id: 'A',
            },
          },
        } as any,
      ],
    } as any;

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'statsig',
      latency: {
        latency_parameter: true,
        t95: 10,
        path_t95: 10,
        anchor_node_id: 'A',
      },
      values: [
        {
          sliceDSL: 'cohort(A,1-Dec-25:17-Dec-25).context(channel:paid-search)',
          dates: ['15-Dec-25', '16-Dec-25'],
          data_source: { retrieved_at: '2025-12-01T00:00:00.000Z' },
        },
      ],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'E1',
      graph,
      setGraph: () => {},
      writeToFile: true,
      currentDSL: 'context(channel:paid-search).cohort(-90d:)',
      targetSlice: 'context(channel:paid-search).cohort(-90d:)',
      dontExecuteHttp: true,
    });

    expect(executeSpy).toHaveBeenCalled();
    const opts = executeSpy.mock.calls[0][2];

    const todayUK = formatDateUK(new Date());
    const startUK = resolveRelativeDate('-90d');
    const requestedWindow = {
      start: parseUKDate(startUK).toISOString(),
      end: parseUKDate(todayUK).toISOString(),
    };
    const horizon = computeCohortRetrievalHorizon({
      requestedWindow,
      pathT95: 10,
      edgeT95: 10,
      referenceDate: new Date(),
      existingCoverage: {
        dates: ['15-Dec-25', '16-Dec-25'],
        retrievedAt: '2025-12-01T00:00:00.000Z',
      },
    });
    const expectedWindow = {
      start: parseDate(horizon.boundedWindow.start).toISOString(),
      end: parseDate(horizon.boundedWindow.end).toISOString(),
    };

    expect(opts?.window).toEqual(expectedWindow);
  });

  it('collapses overlapping partial refetch windows when cache is empty', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g-window',
      name: 'Window Graph',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 }, event_id: 'event-a' } as any,
        { id: 'B', uuid: 'B', label: 'B', layout: { x: 1, y: 1 }, event_id: 'event-b' } as any,
      ],
      edges: [
        {
          id: 'E1',
          uuid: 'E1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: 'p1',
            connection: 'statsig',
            mean: 0.1,
            latency: {
              latency_parameter: true,
              t95: 10,
              path_t95: 10,
              anchor_node_id: 'A',
            },
          },
        } as any,
      ],
    } as any;

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'statsig',
      values: [],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'E1',
      graph,
      setGraph: () => {},
      writeToFile: true,
      currentDSL: 'context(channel:paid-search).window(-80d:)',
      targetSlice: 'context(channel:paid-search).window(-80d:)',
      dontExecuteHttp: true,
    });

    // Cache is empty, so the requested window should subsume any partial refetch window.
    // We should execute exactly once (no duplicated overlapping gaps).
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps partial refetch windows disjoint when only a mature gap is missing', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g-window-gap',
      name: 'Window Gap Graph',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 }, event_id: 'event-a' } as any,
        { id: 'B', uuid: 'B', label: 'B', layout: { x: 1, y: 1 }, event_id: 'event-b' } as any,
      ],
      edges: [
        {
          id: 'E1',
          uuid: 'E1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: 'p1',
            connection: 'statsig',
            mean: 0.1,
            latency: {
              latency_parameter: true,
              t95: 10,
              path_t95: 10,
              anchor_node_id: 'A',
            },
          },
        } as any,
      ],
    } as any;

    // Build cached window data with a single missing mature day.
    // Reference date is fixed to 17-Dec-25 in beforeEach.
    const start = parseUKDate('1-Dec-25');
    const end = parseUKDate('17-Dec-25');
    const missing = formatDateUK(parseUKDate('4-Dec-25'));
    const dates: string[] = [];
    const nDaily: number[] = [];
    const kDaily: number[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const d = formatDateUK(cursor);
      if (d !== missing) {
        dates.push(d);
        nDaily.push(10);
        kDaily.push(5);
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'statsig',
      values: [
        {
          sliceDSL: 'context(channel:paid-search).window(-80d:)',
          dates,
          n_daily: nDaily,
          k_daily: kDaily,
          window_from: formatDateUK(start),
          window_to: formatDateUK(end),
          data_source: { retrieved_at: '2025-12-01T00:00:00.000Z' },
        },
      ],
    });

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'E1',
      graph,
      setGraph: () => {},
      writeToFile: true,
      currentDSL: 'context(channel:paid-search).window(-80d:)',
      targetSlice: 'context(channel:paid-search).window(-80d:)',
      dontExecuteHttp: true,
    });

    // Expect two disjoint fetch windows: the immature refetch window and the single-day mature gap.
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const w1 = executeSpy.mock.calls[0][2]?.window;
    const w2 = executeSpy.mock.calls[1][2]?.window;
    const toMs = (w: any) => ({
      start: parseDate(w.start).getTime(),
      end: parseDate(w.end).getTime(),
    });
    const a = toMs(w1);
    const b = toMs(w2);
    const overlaps = !(a.end < b.start || b.end < a.start);
    expect(overlaps).toBe(false);
  });

  it('warns when DSL contains an unparseable window() clause and proceeds with explicit fallbacks', async () => {
    const graph = createTestGraph('from(A).to(B)');

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'p1',
      targetId: 'E1',
      graph,
      setGraph: () => {},
      // Comma separator is invalid for our DSL parser; this is the "intent present but dropped" class.
      currentDSL: 'window(1-Oct-25,31-Oct-25)',
      dontExecuteHttp: true,
    });

    // We should still proceed (warn & proceed), but must log that window intent was dropped.
    const dropped = addChildSpy.mock.calls.some((call) => call[1] === 'warning' && call[2] === 'WINDOW_INTENT_DROPPED');
    expect(dropped).toBe(true);

    // And because the intent could not be honoured, we will end up defaulting a window (which is also warned).
    const defaulted = addChildSpy.mock.calls.some((call) => call[1] === 'warning' && call[2] === 'DEFAULT_WINDOW_APPLIED');
    expect(defaulted).toBe(true);
  });
});


