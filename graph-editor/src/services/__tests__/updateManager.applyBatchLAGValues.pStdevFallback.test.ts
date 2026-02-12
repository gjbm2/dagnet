/**
 * Regression: applyBatchLAGValues must not leave `p.stdev` undefined when it applies p.mean
 * via the topo/LAG pass and evidence.stdev is available.
 *
 * This matters for:
 * - Param-pack stability (flattened keys should be consistently present)
 * - CSV harness output (spreadsheet tooling expects fixed columns)
 */
import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';

describe('UpdateManager.applyBatchLAGValues', () => {
  it('populates p.stdev from evidence.stdev when p.stdev is missing and not overridden', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [{ id: 'A-B', from: 'A', to: 'B', p: { latency: {} } }],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        latency: { t95: 10, completeness: 1, path_t95: 10 },
        blendedMean: 0.4,
        evidence: { mean: 0.3, n: 100, k: 30, stdev: 0.01 },
      },
    ]);

    const e = next.edges.find((x: any) => x.id === 'A-B');
    expect(e.p.mean).toBe(0.4);
    expect(e.p.evidence.stdev).toBe(0.01);
    expect(e.p.stdev).toBe(0.01);
  });

  it('populates conditional_p[i].p.stdev from conditional evidence.stdev when conditionalIndex is provided', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        {
          id: 'A-B',
          from: 'A',
          to: 'B',
          p: { latency: {}, mean: 0.5, stdev: 0.5 },
          conditional_p: [
            { condition: 'context(channel:paid)', p: { latency: {}, mean: 0.6 } },
          ],
        },
      ],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        conditionalIndex: 0,
        latency: { t95: 10, completeness: 1, path_t95: 10, onset_delta_days: 3 },
        blendedMean: 0.4,
        evidence: { mean: 0.3, n: 100, k: 30, stdev: 0.01 },
      },
    ]);

    const e = next.edges.find((x: any) => x.id === 'A-B');
    expect(e.p.mean).toBe(0.5); // base unchanged
    expect(e.p.stdev).toBe(0.5); // base unchanged

    expect(e.conditional_p[0].p.mean).toBe(0.4);
    expect(e.conditional_p[0].p.evidence.stdev).toBe(0.01);
    expect(e.conditional_p[0].p.stdev).toBe(0.01);
    expect(e.conditional_p[0].p.latency.onset_delta_days).toBe(3);
  });

  it('respects onset_delta_days_overridden for conditional_p[i].p.latency when conditionalIndex is provided', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        {
          id: 'A-B',
          from: 'A',
          to: 'B',
          p: { latency: {} },
          conditional_p: [
            {
              condition: 'context(channel:paid)',
              p: {
                latency: { onset_delta_days: 9, onset_delta_days_overridden: true },
              },
            },
          ],
        },
      ],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        conditionalIndex: 0,
        latency: { t95: 10, completeness: 1, path_t95: 10, onset_delta_days: 3 },
      },
    ]);

    const e = next.edges.find((x: any) => x.id === 'A-B');
    expect(e.conditional_p[0].p.latency.onset_delta_days).toBe(9);
  });

  it('populates p.stdev from existing p.evidence.stdev even when update.evidence.stdev is not provided', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [{ id: 'A-B', from: 'A', to: 'B', p: { latency: {}, evidence: { stdev: 0.02 } } }],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        latency: { t95: 10, completeness: 1, path_t95: 10 },
        blendedMean: 0.4,
        evidence: { mean: 0.3, n: 100, k: 30 },
      },
    ]);

    const e = next.edges.find((x: any) => x.id === 'A-B');
    expect(e.p.evidence.stdev).toBe(0.02);
    expect(e.p.stdev).toBe(0.02);
  });

  it('does not overwrite p.stdev when stdev_overridden is true', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [{ id: 'A-B', from: 'A', to: 'B', p: { stdev_overridden: true, stdev: 0.1234, latency: {} } }],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        latency: { t95: 10, completeness: 1, path_t95: 10 },
        blendedMean: 0.4,
        evidence: { mean: 0.3, n: 100, k: 30, stdev: 0.01 },
      },
    ]);

    const e = next.edges.find((x: any) => x.id === 'A-B');
    expect(e.p.stdev).toBe(0.1234);
  });

  // --- Evidence-fallback rebalancing (no blendedMean) ---

  it('falls back to evidence.mean for p.mean when blendedMean is undefined, and triggers sibling rebalancing', () => {
    const um = new UpdateManager();
    // A -> B (fetchable, evidence will arrive) and A -> C (abandon, complement)
    const graph: any = {
      nodes: [
        { id: 'A', uuid: 'a' },
        { id: 'B', uuid: 'b' },
        { id: 'C', uuid: 'c', absorbing: true, outcome_type: 'failure' },
      ],
      edges: [
        { id: 'A-B', uuid: 'e1', from: 'a', to: 'b', p: { mean: 0.5, latency: {} } },
        { id: 'A-C', uuid: 'e2', from: 'a', to: 'c', p: { mean: 0.5 } },
      ],
      metadata: {},
    };

    // blendedMean is undefined (first fetch, no forecast)
    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        latency: { t95: 10, completeness: 0.8, path_t95: 10 },
        blendedMean: undefined,
        evidence: { mean: 0.6, n: 100, k: 60 },
      },
    ]);

    const eAB = next.edges.find((x: any) => x.id === 'A-B');
    const eAC = next.edges.find((x: any) => x.id === 'A-C');

    // p.mean should fall back to evidence.mean
    expect(eAB.p.mean).toBe(0.6);
    // Sibling should be rebalanced: 1 - 0.6 = 0.4
    expect(eAC.p.mean).toBe(0.4);
  });

  it('does not fall back to evidence.mean when mean_overridden is true', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [
        { id: 'A', uuid: 'a' },
        { id: 'B', uuid: 'b' },
        { id: 'C', uuid: 'c', absorbing: true, outcome_type: 'failure' },
      ],
      edges: [
        { id: 'A-B', uuid: 'e1', from: 'a', to: 'b', p: { mean: 0.7, mean_overridden: true, latency: {} } },
        { id: 'A-C', uuid: 'e2', from: 'a', to: 'c', p: { mean: 0.3 } },
      ],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        latency: { t95: 10, completeness: 0.8, path_t95: 10 },
        blendedMean: undefined,
        evidence: { mean: 0.6, n: 100, k: 60 },
      },
    ]);

    const eAB = next.edges.find((x: any) => x.id === 'A-B');
    const eAC = next.edges.find((x: any) => x.id === 'A-C');

    // mean_overridden: p.mean stays at 0.7, no rebalancing
    expect(eAB.p.mean).toBe(0.7);
    expect(eAC.p.mean).toBe(0.3);
  });

  it('does not fall back when evidence.mean equals current p.mean (no-op)', () => {
    const um = new UpdateManager();
    const graph: any = {
      nodes: [
        { id: 'A', uuid: 'a' },
        { id: 'B', uuid: 'b' },
        { id: 'C', uuid: 'c', absorbing: true, outcome_type: 'failure' },
      ],
      edges: [
        { id: 'A-B', uuid: 'e1', from: 'a', to: 'b', p: { mean: 0.6, latency: {} } },
        { id: 'A-C', uuid: 'e2', from: 'a', to: 'c', p: { mean: 0.4 } },
      ],
      metadata: {},
    };

    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: 'A-B',
        latency: { t95: 10, completeness: 0.8, path_t95: 10 },
        blendedMean: undefined,
        evidence: { mean: 0.6, n: 100, k: 60 },
      },
    ]);

    const eAB = next.edges.find((x: any) => x.id === 'A-B');
    const eAC = next.edges.find((x: any) => x.id === 'A-C');

    // No change — evidence.mean == p.mean, no rebalancing triggered
    expect(eAB.p.mean).toBe(0.6);
    expect(eAC.p.mean).toBe(0.4);
  });
});


