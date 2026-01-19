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
    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce(undefined);
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

    vi.mocked(dataOperationsService.getFromSource).mockResolvedValueOnce(undefined);

    const res = await executeRetrieveAllSlicesWithProgressToast({
      getGraph: () => graph,
      setGraph: () => {},
      slices: ['cohort(-90d:)'],
      toastId: 'retrieve-all-test',
      toastLabel: 'Retrieve All (test)',
    });

    expect(res.totalErrors).toBe(0);
    expect(showProgressToast).toHaveBeenCalled();
    expect(completeProgressToast).toHaveBeenCalledWith(
      'retrieve-all-test',
      'Retrieve All complete (1 succeeded)',
      false
    );
  });
});







