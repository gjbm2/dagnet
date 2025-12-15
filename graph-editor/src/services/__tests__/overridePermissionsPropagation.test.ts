/**
 * Override permissions propagation rules (Put/Get only)
 *
 * Principles:
 * - Permission flags (`*_overridden`) must be copied between graph ↔ file ONLY via explicit Put/Get operations.
 * - Automated flows should respect the relevant domain flags (graph for direct, file for versioned writes).
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

describe('override permissions propagation (UpdateManager)', () => {
  it('PUT (graph→file) respects file override flags by default, but can bypass for explicit copy', async () => {
    const updateManager = new UpdateManager();

    const graphEntity: any = {
      query: 'from(a).to(b)',
      query_overridden: true,
      n_query: 'from(a).to(x)',
      n_query_overridden: true,
      p: {
        id: 'p1',
        latency: {
          latency_parameter: true,
          latency_parameter_overridden: true,
          anchor_node_id: 'A',
          anchor_node_id_overridden: true,
          t95: 12.3456,
          t95_overridden: true,
          path_t95: 40.9876,
          path_t95_overridden: true,
        },
      },
    };

    // File is already "locked" (overridden) for query; default PUT should not overwrite query.
    const file: any = {
      id: 'p1',
      type: 'probability',
      query: 'from(a).to(c)',
      query_overridden: true,
      values: [{ mean: 0.5 }],
      latency: {
        t95: 1,
        t95_overridden: true,
      },
    };

    const defaultPut = await updateManager.handleGraphToFile(graphEntity, file, 'UPDATE', 'parameter', { validateOnly: true });
    applyChanges(file, defaultPut.changes);
    expect(file.query).toBe('from(a).to(c)'); // unchanged because file query_overridden=true

    const forcedPut = await updateManager.handleGraphToFile(graphEntity, file, 'UPDATE', 'parameter', {
      validateOnly: true,
      ignoreOverrideFlags: true,
    });
    applyChanges(file, forcedPut.changes);

    expect(file.query).toBe('from(a).to(b)');
    expect(file.query_overridden).toBe(true);
    expect(file.n_query).toBe('from(a).to(x)');
    expect(file.n_query_overridden).toBe(true);
    expect(file.latency.anchor_node_id_overridden).toBe(true);
    expect(file.latency.t95_overridden).toBe(true);
    expect(file.latency.path_t95_overridden).toBe(true);
  });

  it('GET (file→graph) can copy permission flags and values when explicitly requested', async () => {
    const updateManager = new UpdateManager();

    const file: any = {
      id: 'p1',
      type: 'probability',
      query: 'from(a).to(b)',
      query_overridden: true,
      n_query: 'from(a).to(b)',
      n_query_overridden: false,
      latency: {
        latency_parameter: true,
        latency_parameter_overridden: true,
        anchor_node_id: 'A',
        anchor_node_id_overridden: true,
        t95: 10,
        t95_overridden: true,
        path_t95: 40,
        path_t95_overridden: true,
      },
      values: [{ mean: 0.5 }],
    };

    const graphEdge: any = {
      query: 'from(a).to(x)',
      query_overridden: false,
      n_query: 'from(a).to(x)',
      n_query_overridden: true,
      p: { id: 'p1', latency: { t95_overridden: false } },
    };

    const get = await updateManager.handleFileToGraph(file, graphEdge, 'UPDATE', 'parameter', {
      validateOnly: true,
      ignoreOverrideFlags: true,
    });
    applyChanges(graphEdge, get.changes);

    // Graph-mastered policy: query/n_query (and their override flags) do NOT copy file → graph,
    // even when permission copying is explicitly enabled.
    expect(graphEdge.query).toBe('from(a).to(x)');
    expect(graphEdge.query_overridden).toBe(false);
    expect(graphEdge.n_query_overridden).toBe(true);
    expect(graphEdge.p.latency.t95_overridden).toBe(true);
  });
});


