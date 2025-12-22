import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';
import { normalizeToUK } from '../../lib/dateFormat';

function applyChanges(target: any, changes: Array<{ field: string; newValue: any }> | undefined): void {
  if (!changes) return;
  for (const change of changes) {
    const path = change.field.split('.');
    let obj = target;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in obj) || obj[key] === undefined || obj[key] === null) obj[key] = {};
      obj = obj[key];
    }
    obj[path[path.length - 1]] = change.newValue;
  }
}

describe('UpdateManager external_to_graph parameter mapping', () => {
  it('updates evidence mean + window fields (so logs and E-mode are not stale)', async () => {
    const um = new UpdateManager();

    const source = {
      mean: 0.25,
      n: 100,
      k: 25,
      window_from: '2025-11-01T00:00:00.000Z',
      window_to: '2025-11-14T00:00:00.000Z',
      retrieved_at: '2025-12-22T15:00:00.000Z',
      source: 'amplitude',
      data_source: { type: 'amplitude', retrieved_at: '2025-12-22T15:00:00.000Z', full_query: '{}' },
    };

    const target: any = {
      p: {
        mean: 0.1,
        evidence: {
          n: 10,
          k: 1,
          mean: 0.1,
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-02T00:00:00.000Z',
        },
      },
    };

    const result = await um.handleExternalToGraph(source as any, target, 'UPDATE', 'parameter', { interactive: false });

    expect(result.success).toBe(true);
    expect(result.changes?.length).toBeGreaterThan(0);

    // Apply changes to a clone and validate final shape
    const updated = structuredClone(target);
    applyChanges(updated, result.changes as any);

    expect(updated.p.mean).toBeCloseTo(0.25, 6);
    expect(updated.p.evidence.n).toBe(100);
    expect(updated.p.evidence.k).toBe(25);
    expect(updated.p.evidence.mean).toBeCloseTo(0.25, 6);
    expect(updated.p.evidence.window_from).toBe(normalizeToUK(source.window_from));
    expect(updated.p.evidence.window_to).toBe(normalizeToUK(source.window_to));
  });
});


