import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dataOperationsService so we can force per-item failures/successes deterministically.
vi.mock('../dataOperationsService', () => {
  return {
    setBatchMode: vi.fn(),
    dataOperationsService: {
      getFromSource: vi.fn(),
    },
  };
});

vi.mock('../../components/ProgressToast', () => ({
  showProgressToast: vi.fn(),
  completeProgressToast: vi.fn(),
}));

import { completeProgressToast, showProgressToast } from '../../components/ProgressToast';
import { executeRetrieveAllSlicesWithProgressToast, retrieveAllSlicesService } from '../retrieveAllSlicesService';
import { dataOperationsService } from '../dataOperationsService';

describe('retrieveAllSlicesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts per-item failures (getFromSource throws) as errors in the final result', async () => {
    vi.mocked(dataOperationsService.getFromSource).mockRejectedValueOnce(new Error('boom'));

    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [
        {
          uuid: 'edge-1',
          from: 'a',
          to: 'b',
          p: { id: 'gm-delegated-to-reco' },
        },
      ],
      nodes: [],
    };

    const res = await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:)'],
      bustCache: false,
    });

    expect(res.totalSlices).toBe(1);
    expect(res.totalItems).toBe(1);
    expect(res.totalSuccess).toBe(0);
    expect(res.totalErrors).toBe(1);
    expect(res.aborted).toBe(false);
  });

  it('stamps graph metadata last_retrieve_all_slices_success_at_ms only when run completes with 0 errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'));

    const setGraph = vi.fn();

    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
      metadata: { version: '1.1.0', created_at: '14-Jan-26' },
    };

    // Success path: no errors → marker written.
    // Return a proper GetFromSourceResult
    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce({
      success: true,
      cacheHit: true,
      daysFetched: 0,
      daysFromCache: 90,
    });
    const res1 = await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph,
      slices: ['cohort(-90d:)'],
    });
    expect(res1.totalErrors).toBe(0);

    const stamped = setGraph.mock.calls.find(c => (c[0] as any)?.metadata?.last_retrieve_all_slices_success_at_ms)?.[0] as any;
    expect(stamped?.metadata?.last_retrieve_all_slices_success_at_ms).toBe(new Date('2026-01-14T12:00:00.000Z').getTime());

    // Error path: errors → no new marker write.
    setGraph.mockClear();
    vi.mocked(dataOperationsService.getFromSource).mockRejectedValueOnce(new Error('boom'));
    const res2 = await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph,
      slices: ['cohort(-90d:)'],
    });
    expect(res2.totalErrors).toBe(1);
    expect(setGraph.mock.calls.some(c => (c[0] as any)?.metadata?.last_retrieve_all_slices_success_at_ms)).toBe(false);

    vi.useRealTimers();
  });

  it('shows a progress toast and completes it for automated runs', async () => {
    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    // Return a proper GetFromSourceResult with cache miss
    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce({
      success: true,
      cacheHit: false,
      daysFetched: 5,
      daysFromCache: 85,
    });

    const res = await executeRetrieveAllSlicesWithProgressToast({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:)'],
      toastId: 'retrieve-all-test',
      toastLabel: 'Retrieve All (test)',
    });

    expect(res.totalErrors).toBe(0);
    expect(res.totalCacheHits).toBe(0);
    expect(res.totalApiFetches).toBe(1);
    expect(res.totalDaysFetched).toBe(5);
    expect(showProgressToast).toHaveBeenCalled();
    // New toast format includes cached/fetched stats
    expect(completeProgressToast).toHaveBeenCalledWith(
      'retrieve-all-test',
      expect.stringContaining('0 cached'),
      false
    );
    expect(completeProgressToast).toHaveBeenCalledWith(
      'retrieve-all-test',
      expect.stringContaining('1 fetched'),
      false
    );
  });

  it('stamps metadata even if graph has no pre-existing metadata object', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'));

    const setGraph = vi.fn();

    // Graph WITHOUT metadata field initially
    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
      // No metadata field!
    };

    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce({
      success: true,
      cacheHit: true,
      daysFetched: 0,
      daysFromCache: 90,
    });
    const res = await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph,
      slices: ['cohort(-90d:)'],
    });
    expect(res.totalErrors).toBe(0);

    // The marker should still be written (metadata object created)
    const stamped = setGraph.mock.calls.find(c => (c[0] as any)?.metadata?.last_retrieve_all_slices_success_at_ms)?.[0] as any;
    expect(stamped?.metadata?.last_retrieve_all_slices_success_at_ms).toBe(new Date('2026-01-14T12:00:00.000Z').getTime());

    vi.useRealTimers();
  });

  it('aggregates cache hit/miss stats across multiple items', async () => {
    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [
        { uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } },
        { uuid: 'edge-2', from: 'a', to: 'c', p: { id: 'p-2' } },
        { uuid: 'edge-3', from: 'a', to: 'd', p: { id: 'p-3' } },
      ],
      nodes: [],
    };

    // First item: cache hit
    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({
        success: true,
        cacheHit: true,
        daysFetched: 0,
        daysFromCache: 90,
      })
      // Second item: cache miss, fetch 5 days
      .mockResolvedValueOnce({
        success: true,
        cacheHit: false,
        daysFetched: 5,
        daysFromCache: 85,
      })
      // Third item: cache miss, fetch 10 days
      .mockResolvedValueOnce({
        success: true,
        cacheHit: false,
        daysFetched: 10,
        daysFromCache: 80,
      });

    const res = await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:)'],
    });

    expect(res.totalSuccess).toBe(3);
    expect(res.totalErrors).toBe(0);
    expect(res.totalCacheHits).toBe(1);
    expect(res.totalApiFetches).toBe(2);
    expect(res.totalDaysFetched).toBe(15); // 5 + 10
    expect(res.sliceStats).toHaveLength(1);
    expect(res.sliceStats[0]).toEqual({
      slice: 'cohort(-90d:)',
      items: 3,
      cached: 1,
      fetched: 2,
      daysFetched: 15,
      errors: 0,
    });
  });

  it('reports progress with current item cache status via onCacheAnalysis callback', async () => {
    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    // Capture the onCacheAnalysis callback
    let capturedCallback: any = null;
    vi.mocked(dataOperationsService.getFromSource).mockImplementationOnce(async (opts: any) => {
      capturedCallback = opts.onCacheAnalysis;
      // Call the callback to simulate cache analysis
      if (capturedCallback) {
        capturedCallback({
          cacheHit: false,
          daysToFetch: 7,
          gapCount: 2,
          daysFromCache: 83,
          totalDays: 90,
        });
      }
      return {
        success: true,
        cacheHit: false,
        daysFetched: 7,
        daysFromCache: 83,
      };
    });

    const progressReports: any[] = [];
    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:)'],
      onProgress: (p) => progressReports.push({ ...p }),
    });

    // Should have received progress with currentItemStatus
    const withStatus = progressReports.find(p => p.currentItemStatus);
    expect(withStatus).toBeDefined();
    expect(withStatus.currentItemStatus).toEqual({
      cacheHit: false,
      daysToFetch: 7,
      gapCount: 2,
    });
  });
});