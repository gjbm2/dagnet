import { describe, it, expect, vi } from 'vitest';

vi.mock('../contextRegistry', () => ({
  contextRegistry: {
    detectMECEPartitionSync: vi.fn(() => ({ canAggregate: true })),
  },
}));

import { convertVirtualSnapshotToTimeSeries } from '../dataOperationsService';

describe('dataOperationsService asat slice matching', () => {
  it('matches contexted slice by normalised family key (ignores cohort/window args)', () => {
    const rows: any[] = [
      { slice_key: 'context(channel:google).cohort(-100d:)', anchor_day: '2026-02-01', x: 10, y: 1 },
      { slice_key: 'context(channel:google).cohort(1-Feb-26:5-Feb-26)', anchor_day: '2026-02-02', x: 20, y: 2 },
    ];

    const ts = convertVirtualSnapshotToTimeSeries(rows as any, 'context(channel:google).cohort()');
    expect(ts.map((p) => ({ date: p.date, n: p.n, k: p.k }))).toEqual([
      { date: '2026-02-01', n: 10, k: 1 },
      { date: '2026-02-02', n: 20, k: 2 },
    ]);
  });
});

