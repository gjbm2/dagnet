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

// Mock plan builder so retrieve-all orchestration tests are deterministic and do not depend
// on fileRegistry or cache semantics. These tests are about batch orchestration behaviour.
vi.mock('../fetchPlanBuilderService', () => {
  return {
    buildFetchPlanProduction: vi.fn(),
  };
});

vi.mock('../../components/ProgressToast', () => ({
  showProgressToast: vi.fn(),
  completeProgressToast: vi.fn(),
}));

import { completeProgressToast, showProgressToast } from '../../components/ProgressToast';
import { executeRetrieveAllSlicesWithProgressToast, retrieveAllSlicesService } from '../retrieveAllSlicesService';
import { dataOperationsService } from '../dataOperationsService';
import { buildFetchPlanProduction } from '../fetchPlanBuilderService';

describe('retrieveAllSlicesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts per-item failures (getFromSource throws) as errors in the final result', async () => {
    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p1:edge-1:p:',
            type: 'parameter',
            objectId: 'p1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '2-Jan-26', reason: 'missing', dayCount: 2 }],
          },
        ],
      },
      diagnostics: {
        totalItems: 1,
        itemsNeedingFetch: 1,
        itemsCovered: 0,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);
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
    // Covered item means no external execution is required.
    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'covered',
            windows: [],
          },
        ],
      },
      diagnostics: {
        totalItems: 1,
        itemsNeedingFetch: 0,
        itemsCovered: 1,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);
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
    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
          },
        ],
      },
      diagnostics: {
        totalItems: 1,
        itemsNeedingFetch: 1,
        itemsCovered: 0,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);
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

    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '5-Jan-26', reason: 'missing', dayCount: 5 }],
          },
        ],
      },
      diagnostics: {
        totalItems: 1,
        itemsNeedingFetch: 1,
        itemsCovered: 0,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);

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

    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'covered',
            windows: [],
          },
        ],
      },
      diagnostics: {
        totalItems: 1,
        itemsNeedingFetch: 0,
        itemsCovered: 1,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);
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

    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'covered',
            windows: [],
          },
          {
            itemKey: 'parameter:p-2:edge-2:p:',
            type: 'parameter',
            objectId: 'p-2',
            targetId: 'edge-2',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '5-Jan-26', reason: 'missing', dayCount: 5 }],
          },
          {
            itemKey: 'parameter:p-3:edge-3:p:',
            type: 'parameter',
            objectId: 'p-3',
            targetId: 'edge-3',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch',
            windows: [{ start: '6-Jan-26', end: '15-Jan-26', reason: 'missing', dayCount: 10 }],
          },
        ],
      },
      diagnostics: {
        totalItems: 3,
        itemsNeedingFetch: 2,
        itemsCovered: 1,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);

    // Two executed fetches (covered item does not call getFromSource)
    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({
        success: true,
        cacheHit: false,
        daysFetched: 5,
        daysFromCache: 85,
      })
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

  it('reports progress with current item cache status derived from the plan', async () => {
    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-01-14T12:00:00.000Z',
        referenceNow: '2026-01-14T12:00:00.000Z',
        dsl: 'cohort(-90d:)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch',
            windows: [
              { start: '1-Jan-26', end: '3-Jan-26', reason: 'missing', dayCount: 3 },
              { start: '10-Jan-26', end: '13-Jan-26', reason: 'missing', dayCount: 4 },
            ],
          },
        ],
      },
      diagnostics: {
        totalItems: 1,
        itemsNeedingFetch: 1,
        itemsCovered: 0,
        itemsUnfetchable: 0,
        itemDiagnostics: [],
      },
    } as any);

    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce({
      success: true,
      cacheHit: false,
      daysFetched: 7,
      daysFromCache: 83,
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