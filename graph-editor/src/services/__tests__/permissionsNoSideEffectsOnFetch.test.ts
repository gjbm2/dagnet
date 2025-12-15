/**
 * Permission flags must not change during ordinary fetches.
 *
 * We prove the core mechanism:
 * - file → graph updates only copy `*_overridden` flags when ignoreOverrideFlags=true (explicit user choice)
 * - default behaviour does not change permissions
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';

function applyChanges(target: any, changes: any[] | undefined): any {
  if (!changes) return target;
  for (const c of changes) {
    const parts = c.field.split('.');
    let obj = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!obj[p]) obj[p] = {};
      obj = obj[p];
    }
    obj[parts[parts.length - 1]] = c.newValue;
  }
  return target;
}

describe('permissions: no side effects on ordinary fetch', () => {
  it('file→graph does not copy override flags unless explicitly opted-in', async () => {
    const updateManager = new UpdateManager();

    const file: any = {
      id: 'p1',
      type: 'probability',
      query_overridden: true,
      n_query_overridden: true,
      latency: {
        t95_overridden: true,
        path_t95_overridden: true,
      },
      values: [{ mean: 0.5 }],
    };

    const graphEdge: any = {
      query_overridden: false,
      n_query_overridden: false,
      p: { id: 'p1', latency: { t95_overridden: false, path_t95_overridden: false } },
    };

    const normal = await updateManager.handleFileToGraph(file, graphEdge, 'UPDATE', 'parameter', { validateOnly: true });
    applyChanges(graphEdge, normal.changes);
    expect(graphEdge.query_overridden).toBe(false);
    expect(graphEdge.n_query_overridden).toBe(false);
    expect(graphEdge.p.latency.t95_overridden).toBe(false);
    expect(graphEdge.p.latency.path_t95_overridden).toBe(false);

    const explicit = await updateManager.handleFileToGraph(file, graphEdge, 'UPDATE', 'parameter', {
      validateOnly: true,
      ignoreOverrideFlags: true,
    });
    applyChanges(graphEdge, explicit.changes);
    // Graph-mastered policy: query/n_query override flags do NOT copy file → graph,
    // even when permission copying is explicitly enabled.
    expect(graphEdge.query_overridden).toBe(false);
    expect(graphEdge.n_query_overridden).toBe(false);
    expect(graphEdge.p.latency.t95_overridden).toBe(true);
    expect(graphEdge.p.latency.path_t95_overridden).toBe(true);
  });
});


