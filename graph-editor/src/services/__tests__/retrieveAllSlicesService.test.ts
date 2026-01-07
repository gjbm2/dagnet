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

import { retrieveAllSlicesService } from '../retrieveAllSlicesService';
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
});


