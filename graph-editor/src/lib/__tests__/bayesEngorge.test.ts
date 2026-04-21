import { describe, expect, it } from 'vitest';

import { buildEngorgedBayesGraphSnapshot } from '../bayesEngorge';
import { stripBayesRuntimeFieldsFromGraphInPlace } from '../bayesGraphRuntime';

function makeContaminatedGraph() {
  return {
    nodes: [
      { uuid: 'node-a', id: 'A', name: 'A', type: 'state' },
      { uuid: 'node-b', id: 'B', name: 'B', type: 'state' },
    ],
    edges: [
      {
        uuid: 'edge-a-b',
        from: 'A',
        to: 'B',
        _bayes_evidence: { stale: true },
        _bayes_priors: { stale: true },
        p: {
          id: 'checkout-to-payment',
          latency: {
            mu: 1.4,
            sigma: 0.5,
            onset_delta_days: 2,
            __parityEvidence: [{ date: '1-Jan-26', n: 10, k: 3 }],
            __parityComputedT95Days: 12,
          },
        },
      },
    ],
    metadata: {
      version: '1.0.0',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

function makeParameterFiles() {
  return {
    'parameter-checkout-to-payment': {
      id: 'checkout-to-payment',
      values: [
        {
          sliceDSL: 'window(1-Jan-26:31-Jan-26)',
          n: 120,
          k: 36,
        },
        {
          sliceDSL: 'cohort(Checkout,1-Jan-26:31-Jan-26)',
          n_daily: [60, 60],
          k_daily: [18, 18],
          dates: ['1-Jan-26', '2-Jan-26'],
        },
      ],
      latency: {
        mu: 1.3,
        sigma: 0.45,
        onset_delta_days: 2,
      },
    },
  };
}

describe('Bayes graph runtime helpers', () => {
  it('buildEngorgedBayesGraphSnapshot should engorge a clone, not the live graph', () => {
    const graph = makeContaminatedGraph();

    const snapshot = buildEngorgedBayesGraphSnapshot(graph, makeParameterFiles());

    expect(graph).not.toBe(snapshot);
    expect(graph.edges[0]._bayes_evidence).toEqual({ stale: true });
    expect(graph.edges[0]._bayes_priors).toEqual({ stale: true });
    expect(graph.edges[0].p.latency.__parityEvidence).toEqual([{ date: '1-Jan-26', n: 10, k: 3 }]);
    expect(graph.edges[0].p.latency.__parityComputedT95Days).toBe(12);

    expect(snapshot.edges[0]._bayes_evidence).toBeDefined();
    expect(snapshot.edges[0]._bayes_priors).toBeDefined();
    expect((snapshot.edges[0] as any)._bayes_evidence.stale).toBeUndefined();
    expect((snapshot.edges[0] as any)._bayes_priors.stale).toBeUndefined();
    expect(snapshot.edges[0].p.latency.__parityEvidence).toBeUndefined();
    expect(snapshot.edges[0].p.latency.__parityComputedT95Days).toBeUndefined();
  });

  it('stripBayesRuntimeFieldsFromGraphInPlace should remove engorged and parity baggage', () => {
    const graph = makeContaminatedGraph();

    const modified = stripBayesRuntimeFieldsFromGraphInPlace(graph);

    expect(modified).toBe(true);
    expect(graph.edges[0]._bayes_evidence).toBeUndefined();
    expect(graph.edges[0]._bayes_priors).toBeUndefined();
    expect(graph.edges[0].p.latency.__parityEvidence).toBeUndefined();
    expect(graph.edges[0].p.latency.__parityComputedT95Days).toBeUndefined();
  });
});
