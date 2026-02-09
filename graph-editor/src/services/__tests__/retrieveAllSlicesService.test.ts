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

// Mock lag horizons service (post-retrieve global recompute) so these tests remain focused on
// retrieve-all orchestration and do not pull in graph/file registry semantics.
vi.mock('../lagHorizonsService', () => {
  return {
    lagHorizonsService: {
      recomputeHorizons: vi.fn(),
      setAllHorizonOverrides: vi.fn(),
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
import { buildFetchPlanProduction } from '../fetchPlanBuilderService';
import { lagHorizonsService } from '../lagHorizonsService';
import { explodeDSL } from '../../lib/dslExplosion';

describe('retrieveAllSlicesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on cooldown, restarts ONLY the failing S; other S remains atomic and unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-09T06:00:00.000Z'));

    // Speed up cooldown in tests.
    if (typeof (global as any).window === 'undefined') {
      (global as any).window = {};
    }
    (global.window as any).__dagnetTestRateLimitCooloffMinutes = 0.02; // ~1s

    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

    const slice1 = 'window(-7d:).context(channel:paid-search)';
    const slice2 = 'window(-30d:).context(channel:paid-search)';

    // Two params (pA and pB), both same slice family + mode, but different hashes:
    // - pA uses sigA
    // - pB uses sigB
    const sigA = '{"c":"hash-A","x":{}}';
    const sigB = '{"c":"hash-B","x":{}}';

    // Slice 1: B then A (both succeed)
    // Slice 2: A fails with 429, cooldown, A retried (new retrieved_at + bustCache), then B (should reuse old retrieved_at)
    vi.mocked(buildFetchPlanProduction)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: slice1,
          items: [
            {
              itemKey: 'parameter:pB:edge-b:p:',
              type: 'parameter',
              objectId: 'pB',
              targetId: 'edge-b',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: sigB,
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
            {
              itemKey: 'parameter:pA:edge-a:p:',
              type: 'parameter',
              objectId: 'pA',
              targetId: 'edge-a',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: sigA,
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 2, itemsNeedingFetch: 2, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: slice2,
          items: [
            {
              itemKey: 'parameter:pA:edge-a:p:',
              type: 'parameter',
              objectId: 'pA',
              targetId: 'edge-a',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: sigA,
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
            {
              itemKey: 'parameter:pB:edge-b:p:',
              type: 'parameter',
              objectId: 'pB',
              targetId: 'edge-b',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: sigB,
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 2, itemsNeedingFetch: 2, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any);

    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 }) // slice1: B
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 }) // slice1: A
      .mockRejectedValueOnce(new Error('429 Too Many Requests: Exceeded rate limit'))               // slice2: A fails
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 }) // slice2: A retry
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 }); // slice2: B

    const graph: any = {
      dataInterestsDSL: `${slice1};${slice2}`,
      edges: [
        { uuid: 'edge-a', from: 'a', to: 'b', p: { id: 'pA' } },
        { uuid: 'edge-b', from: 'a', to: 'b', p: { id: 'pB' } },
      ],
      nodes: [],
    };

    const run = retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: [slice1, slice2],
      isAutomated: true,
    });

    await vi.advanceTimersByTimeAsync(2500);
    const res = await run;

    expect(res.totalErrors).toBe(0);

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(5);

    const callB1 = calls[0][0] as any;
    const callA1 = calls[1][0] as any;
    const callA2fail = calls[2][0] as any;
    const callA2retry = calls[3][0] as any;
    const callB2 = calls[4][0] as any;

    // A (failing S): retry restarts S
    expect(callA1.retrievalBatchAt).toBeInstanceOf(Date);
    expect(callA2retry.retrievalBatchAt).toBeInstanceOf(Date);
    expect(callA1.retrievalBatchAt).not.toBe(callA2retry.retrievalBatchAt);
    expect(callA2fail.bustCache).toBe(false);
    expect(callA2retry.bustCache).toBe(true);

    // B (other S): unchanged; still atomic across both slices
    expect(callB1.retrievalBatchAt).toBeInstanceOf(Date);
    expect(callB2.retrievalBatchAt).toBe(callB1.retrievalBatchAt);
    expect(callB1.bustCache).toBe(false);
    expect(callB2.bustCache).toBe(false);

    delete (global.window as any).__dagnetTestRateLimitCooloffMinutes;
    vi.useRealTimers();
  });

  it('treats window vs cohort as different S (same param+sliceFamily+hash must not coalesce across modes)', async () => {
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-02-09T06:00:00.000Z',
        referenceNow: '2026-02-09T06:00:00.000Z',
        dsl: 'window(-7d:).context(channel:paid-search)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'window',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
          },
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
          },
        ],
      },
      diagnostics: { totalItems: 2, itemsNeedingFetch: 2, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
    } as any);

    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 })
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 });

    const graph: any = {
      dataInterestsDSL: 'window(-7d:).context(channel:paid-search)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['window(-7d:).context(channel:paid-search)'],
      isAutomated: true,
    });

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(2);
    const a0 = calls[0][0] as any;
    const a1 = calls[1][0] as any;
    expect(a0.retrievalBatchAt).not.toBe(a1.retrievalBatchAt);
  });

  it('does not enable atomicity enforcement in manual runs', async () => {
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();
    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-02-09T06:00:00.000Z',
        referenceNow: '2026-02-09T06:00:00.000Z',
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
            querySignature: '{"c":"core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
          },
        ],
      },
      diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
    } as any);
    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce({
      success: true,
      cacheHit: false,
      daysFetched: 1,
      daysFromCache: 0,
    });

    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:)'],
      isAutomated: false,
    });

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0] as any).enforceAtomicityScopeS).toBe(false);
  });

  it('uses explodeDSL and still preserves S atomicity across slices that differ only by window args', async () => {
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

    const pinned = '(window(1-Jan-26:2-Jan-26);window(3-Jan-26:4-Jan-26)).context(channel:paid-search)';
    const slices = await explodeDSL(pinned);
    expect(slices.length).toBe(2);

    // For each exploded slice, the plan item has the same sliceFamily and hash (S differs only by window args => same S).
    vi.mocked(buildFetchPlanProduction)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: slices[0],
          items: [
            {
              itemKey: 'parameter:p-1:edge-1:p:',
              type: 'parameter',
              objectId: 'p-1',
              targetId: 'edge-1',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: '{"c":"same-core","x":{}}',
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: slices[1],
          items: [
            {
              itemKey: 'parameter:p-1:edge-1:p:',
              type: 'parameter',
              objectId: 'p-1',
              targetId: 'edge-1',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: '{"c":"same-core","x":{}}',
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any);

    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 })
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 });

    const graph: any = {
      dataInterestsDSL: pinned,
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      // Do NOT pass slices: force explodeDSL inside the service.
      isAutomated: true,
    });

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(2);
    const a0 = calls[0][0] as any;
    const a1 = calls[1][0] as any;
    expect(a0.retrievalBatchAt).toBe(a1.retrievalBatchAt);
  });

  it('coalesces S across different targetId edges when param+slice+hash match', async () => {
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-02-09T06:00:00.000Z',
        referenceNow: '2026-02-09T06:00:00.000Z',
        dsl: 'window(-7d:).context(channel:paid-search)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'window',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"same-core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
          },
          {
            itemKey: 'parameter:p-1:edge-2:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-2',
            slot: 'p',
            mode: 'window',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"same-core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
          },
        ],
      },
      diagnostics: { totalItems: 2, itemsNeedingFetch: 2, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
    } as any);

    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 })
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 });

    const graph: any = {
      dataInterestsDSL: 'window(-7d:).context(channel:paid-search)',
      edges: [
        { uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } },
        { uuid: 'edge-2', from: 'a', to: 'b', p: { id: 'p-1' } },
      ],
      nodes: [],
    };

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['window(-7d:).context(channel:paid-search)'],
      isAutomated: true,
    });

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(2);
    const a0 = calls[0][0] as any;
    const a1 = calls[1][0] as any;
    expect(a0.retrievalBatchAt).toBe(a1.retrievalBatchAt);
  });

  it('keys retrieved_at at scope S (param×slice×hash): window args do not create a new S', async () => {
    // Two exploded slices that differ only by window args should share the same S:
    // slice = window() + contexts (args discarded).
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

    vi.mocked(buildFetchPlanProduction)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: 'window(-7d:).context(channel:paid-search)',
          items: [
            {
              itemKey: 'parameter:p-1:edge-1:p:',
              type: 'parameter',
              objectId: 'p-1',
              targetId: 'edge-1',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: '{"c":"same-core","x":{}}',
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: 'window(-30d:).context(channel:paid-search)',
          items: [
            {
              itemKey: 'parameter:p-1:edge-1:p:',
              type: 'parameter',
              objectId: 'p-1',
              targetId: 'edge-1',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)', // args discarded
              querySignature: '{"c":"same-core","x":{}}',
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any);

    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 })
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 });

    const graph: any = {
      dataInterestsDSL: 'window(-7d:).context(channel:paid-search);window(-30d:).context(channel:paid-search)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['window(-7d:).context(channel:paid-search)', 'window(-30d:).context(channel:paid-search)'],
      isAutomated: true,
    });

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(2);
    const a0 = calls[0][0] as any;
    const a1 = calls[1][0] as any;

    // Same S => same batch timestamp object
    expect(a0.retrievalBatchAt).toBe(a1.retrievalBatchAt);
  });

  it('does not coalesce different hashes: same param+slice but different querySignature => different retrieved_at', async () => {
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

    vi.mocked(buildFetchPlanProduction)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: 'window(-7d:).context(channel:paid-search)',
          items: [
            {
              itemKey: 'parameter:p-1:edge-1:p:',
              type: 'parameter',
              objectId: 'p-1',
              targetId: 'edge-1',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: '{"c":"hash-A","x":{}}',
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any)
      .mockReturnValueOnce({
        plan: {
          version: 1,
          createdAt: '2026-02-09T06:00:00.000Z',
          referenceNow: '2026-02-09T06:00:00.000Z',
          dsl: 'window(-7d:).context(channel:paid-search)',
          items: [
            {
              itemKey: 'parameter:p-1:edge-1:p:',
              type: 'parameter',
              objectId: 'p-1',
              targetId: 'edge-1',
              slot: 'p',
              mode: 'window',
              sliceFamily: 'context(channel:paid-search)',
              querySignature: '{"c":"hash-B","x":{}}', // different hash => different S
              classification: 'fetch',
              windows: [{ start: '1-Jan-26', end: '1-Jan-26', reason: 'missing', dayCount: 1 }],
            },
          ],
        },
        diagnostics: { totalItems: 1, itemsNeedingFetch: 1, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
      } as any);

    vi.mocked(dataOperationsService.getFromSource)
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 })
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 1, daysFromCache: 0 });

    const graph: any = {
      dataInterestsDSL: 'window(-7d:).context(channel:paid-search)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    await retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['window(-7d:).context(channel:paid-search)', 'window(-7d:).context(channel:paid-search)'],
      isAutomated: true,
    });

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(2);
    const a0 = calls[0][0] as any;
    const a1 = calls[1][0] as any;
    expect(a0.retrievalBatchAt).not.toBe(a1.retrievalBatchAt);
  });

  it('clears forced bustCache after successful retry so later duplicate items do not refetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-09T06:00:00.000Z'));

    if (typeof (global as any).window === 'undefined') {
      (global as any).window = {};
    }
    (global.window as any).__dagnetTestRateLimitCooloffMinutes = 0.02; // ~1s

    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();
    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-02-09T06:00:00.000Z',
        referenceNow: '2026-02-09T06:00:00.000Z',
        dsl: 'cohort(-90d:).context(channel:paid-search)',
        items: [
          // Duplicate plan items with identical S (same param+slice+hash)
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '2-Jan-26', reason: 'missing', dayCount: 2 }],
          },
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"core","x":{}}',
            classification: 'fetch',
            windows: [{ start: '1-Jan-26', end: '2-Jan-26', reason: 'missing', dayCount: 2 }],
          },
        ],
      },
      diagnostics: { totalItems: 2, itemsNeedingFetch: 2, itemsCovered: 0, itemsUnfetchable: 0, itemDiagnostics: [] },
    } as any);

    // 1) Fail with rate-limit (triggers cooldown + retry)
    // 2) Retry succeeds (bustCache=true)
    // 3) Second duplicate item executes; bustCache must be false again
    vi.mocked(dataOperationsService.getFromSource)
      .mockRejectedValueOnce(new Error('429 Too Many Requests: Exceeded rate limit'))
      .mockResolvedValueOnce({ success: true, cacheHit: false, daysFetched: 2, daysFromCache: 0 })
      .mockResolvedValueOnce({ success: true, cacheHit: true, daysFetched: 0, daysFromCache: 2 });

    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:).context(channel:paid-search)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    const p = retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:).context(channel:paid-search)'],
      isAutomated: true,
    });

    await vi.advanceTimersByTimeAsync(2500);
    await p;

    const calls = vi.mocked(dataOperationsService.getFromSource).mock.calls;
    expect(calls.length).toBe(3);

    const first = calls[0][0] as any;
    const retry = calls[1][0] as any;
    const dup = calls[2][0] as any;

    expect(first.bustCache).toBe(false);
    expect(retry.bustCache).toBe(true);
    expect(dup.bustCache).toBe(false);

    // Duplicate uses the post-cooloff batch timestamp (same S as retry)
    expect(dup.retrievalBatchAt).toBe(retry.retrievalBatchAt);

    delete (global.window as any).__dagnetTestRateLimitCooloffMinutes;
    vi.useRealTimers();
  });

  it('automated rate-limit cooldown retries same scope S with new retrieved_at and bustCache=true', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-09T06:00:00.000Z'));

    // Speed up cooldown in tests (durationSeconds is floored).
    if (typeof (global as any).window === 'undefined') {
      (global as any).window = {};
    }
    (global.window as any).__dagnetTestRateLimitCooloffMinutes = 0.02; // ~1.2s → 1s

    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();
    vi.mocked(buildFetchPlanProduction).mockReturnValueOnce({
      plan: {
        version: 1,
        createdAt: '2026-02-09T06:00:00.000Z',
        referenceNow: '2026-02-09T06:00:00.000Z',
        dsl: 'cohort(-90d:).context(channel:paid-search)',
        items: [
          {
            itemKey: 'parameter:p-1:edge-1:p:',
            type: 'parameter',
            objectId: 'p-1',
            targetId: 'edge-1',
            slot: 'p',
            mode: 'cohort',
            sliceFamily: 'context(channel:paid-search)',
            querySignature: '{"c":"core","x":{"channel":"defhash"}}',
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

    // First attempt: rate limit error → cooldown → retry.
    vi.mocked(dataOperationsService.getFromSource)
      .mockRejectedValueOnce(new Error('429 Too Many Requests: Exceeded rate limit'))
      .mockResolvedValueOnce({
        success: true,
        cacheHit: false,
        daysFetched: 2,
        daysFromCache: 0,
      });

    const graph: any = {
      dataInterestsDSL: 'cohort(-90d:).context(channel:paid-search)',
      edges: [{ uuid: 'edge-1', from: 'a', to: 'b', p: { id: 'p-1' } }],
      nodes: [],
    };

    const p = retrieveAllSlicesService.execute({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:).context(channel:paid-search)'],
      bustCache: false,
      isAutomated: true,
    });

    // Let the cooldown elapse.
    await vi.advanceTimersByTimeAsync(2500);
    const res = await p;

    expect(res.totalErrors).toBe(0);
    expect(vi.mocked(dataOperationsService.getFromSource)).toHaveBeenCalledTimes(2);

    const firstCall = vi.mocked(dataOperationsService.getFromSource).mock.calls[0][0] as any;
    const secondCall = vi.mocked(dataOperationsService.getFromSource).mock.calls[1][0] as any;

    expect(firstCall.enforceAtomicityScopeS).toBe(true);
    expect(secondCall.enforceAtomicityScopeS).toBe(true);

    // On retry after cooldown, we must ignore cache for scope S and mint a new retrieved_at.
    expect(firstCall.bustCache).toBe(false);
    expect(secondCall.bustCache).toBe(true);
    expect(firstCall.retrievalBatchAt).toBeInstanceOf(Date);
    expect(secondCall.retrievalBatchAt).toBeInstanceOf(Date);
    expect(firstCall.retrievalBatchAt).not.toBe(secondCall.retrievalBatchAt);

    // Cleanup: avoid leaking state into subsequent tests in this file.
    delete (global.window as any).__dagnetTestRateLimitCooloffMinutes;
    vi.mocked(buildFetchPlanProduction).mockReset();
    vi.mocked(dataOperationsService.getFromSource).mockReset();

    vi.useRealTimers();
  });

  it('counts per-item failures (getFromSource throws) as errors in the final result', async () => {
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();
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

    // Global horizon recompute is only attempted after successful work.
    expect(vi.mocked(lagHorizonsService.recomputeHorizons)).not.toHaveBeenCalled();
  });

  it('stamps graph metadata last_retrieve_all_slices_success_at_ms only when run completes with 0 errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'));

    const setGraph = vi.fn();
    vi.mocked(lagHorizonsService.recomputeHorizons).mockClear();

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
    expect(vi.mocked(lagHorizonsService.recomputeHorizons)).toHaveBeenCalledTimes(1);

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
    expect(vi.mocked(lagHorizonsService.recomputeHorizons)).toHaveBeenCalledTimes(1);

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