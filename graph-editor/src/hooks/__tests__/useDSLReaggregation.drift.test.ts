/**
 * Drift detection unit tests — `collectDriftedBayesEdges`.
 *
 * The function decides which edges need a file→graph fetch because their
 * bayesian projection lags behind the parameter file's posterior. It is
 * the predicate underneath the α (graph-load) and β (post-clean-merge)
 * drift-detection effects in `useDSLReaggregation`.
 *
 * Drift signals (any one is sufficient):
 *   • file has a fit but the edge has no bayesian source ledger entry
 *   • file's fitted_at is newer than the edge's
 *   • fingerprints differ
 *
 * The function takes a `resolveParameterFile` callback so it is testable
 * as a pure unit — no `fileRegistry` import or mock required here.
 */

import { describe, it, expect } from 'vitest';
import { collectDriftedBayesEdges } from '../useDSLReaggregation';
import type { Graph } from '../../types';

// ── Fixture builders ─────────────────────────────────────────────────────

interface EdgeOpts {
  uuid: string;
  paramId?: string;
  modelVars?: any[];
}

function makeEdge({ uuid, paramId, modelVars }: EdgeOpts): any {
  const edge: any = {
    uuid,
    id: uuid,
    from: `from-${uuid}`,
    to: `to-${uuid}`,
  };
  if (paramId) {
    edge.p = {
      id: paramId,
      type: 'probability',
      ...(modelVars !== undefined ? { model_vars: modelVars } : {}),
    };
  }
  return edge;
}

function makeGraph(edges: EdgeOpts[]): Graph {
  return {
    nodes: [],
    edges: edges.map(makeEdge),
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
  } as any;
}

function bayesianModelVar(fittedAt: string, fingerprint: string): any {
  return {
    source: 'bayesian',
    source_at: fittedAt,
    probability: { mean: 0.5, stdev: 0.05, alpha: 50, beta: 50 },
    quality: { rhat: 1.001, ess: 5000, divergences: 0, evidence_grade: 3, gate_passed: true },
    fit_diagnostics: {
      probability: { fitted_at: fittedAt, fingerprint },
    },
  };
}

function paramFileWithPosterior(fittedAt: string, fingerprint: string): any {
  return {
    type: 'probability',
    posterior: {
      fitted_at: fittedAt,
      fingerprint,
      hdi_level: 0.9,
      slices: {
        'window()': {
          alpha: 100, beta: 100,
          ess: 5000, rhat: 1.001, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
      },
    },
    values: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('collectDriftedBayesEdges', () => {
  it('returns empty when fitted_at and fingerprint match (no drift)', () => {
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'p1', modelVars: [bayesianModelVar('2026-05-12T07:06:14Z', 'fp-1')] },
    ]);
    const resolve = (id: string) =>
      id === 'p1' ? paramFileWithPosterior('2026-05-12T07:06:14Z', 'fp-1') : undefined;

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([]);
  });

  it('detects case-3 drift: file has fit but edge has no bayesian entry (the boot-time race symptom)', () => {
    const graph = makeGraph([
      {
        uuid: 'e1',
        paramId: 'p1',
        // analytic-only — exactly the state we saw on the failed F5 boot
        modelVars: [{ source: 'analytic', probability: { mean: 0.3 } }],
      },
    ]);
    const resolve = (id: string) =>
      id === 'p1' ? paramFileWithPosterior('2026-05-12T07:06:14Z', 'fp-1') : undefined;

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([{ paramId: 'p1', edgeId: 'e1' }]);
  });

  it('detects case-1a drift: file fitted_at is newer than edge fitted_at', () => {
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'p1', modelVars: [bayesianModelVar('2026-04-23T21:37:52Z', 'fp-old')] },
    ]);
    const resolve = (id: string) =>
      id === 'p1' ? paramFileWithPosterior('2026-05-12T07:06:14Z', 'fp-new') : undefined;

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([{ paramId: 'p1', edgeId: 'e1' }]);
  });

  it('detects case-1b drift: fingerprints differ even when fitted_at is equal', () => {
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'p1', modelVars: [bayesianModelVar('2026-05-12T07:06:14Z', 'fp-A')] },
    ]);
    const resolve = (id: string) =>
      id === 'p1' ? paramFileWithPosterior('2026-05-12T07:06:14Z', 'fp-B') : undefined;

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([{ paramId: 'p1', edgeId: 'e1' }]);
  });

  it('filterParamId restricts the scan to a single paramId (β subscription path)', () => {
    // Three drifted edges; filter should pick only the one matching.
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'pA', modelVars: [{ source: 'analytic' }] },
      { uuid: 'e2', paramId: 'pB', modelVars: [{ source: 'analytic' }] },
      { uuid: 'e3', paramId: 'pC', modelVars: [{ source: 'analytic' }] },
    ]);
    const resolve = (id: string) => paramFileWithPosterior('2026-05-12T07:06:14Z', `fp-${id}`);

    const drifted = collectDriftedBayesEdges(graph, resolve, 'pB');

    expect(drifted).toEqual([{ paramId: 'pB', edgeId: 'e2' }]);
  });

  it('skips edges without a paramId (e.g. cost_gbp-only edges)', () => {
    const graph = makeGraph([
      { uuid: 'e1' }, // no paramId
      { uuid: 'e2', paramId: 'p1', modelVars: [{ source: 'analytic' }] },
    ]);
    const resolve = (id: string) =>
      id === 'p1' ? paramFileWithPosterior('2026-05-12T07:06:14Z', 'fp-1') : undefined;

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([{ paramId: 'p1', edgeId: 'e2' }]);
  });

  it('skips edges whose parameter file has no posterior block (analytic-only files do not false-positive)', () => {
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'p1', modelVars: [{ source: 'analytic' }] },
    ]);
    // File exists, has values, but no posterior block — legitimately analytic-only.
    const resolve = (_id: string) => ({ type: 'probability', values: [{ mean: 0.4 }] });

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([]);
  });

  it('skips edges whose parameter file is not yet in FileRegistry (no false-positive on the very race we are guarding against)', () => {
    // resolveParameterFile returns undefined when the file has not yet
    // hydrated from IDB. The drift check must NOT treat that as drift —
    // the β subscription will fire when the file actually arrives.
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'p1', modelVars: [{ source: 'analytic' }] },
    ]);
    const resolve = (_id: string) => undefined;

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toEqual([]);
  });

  it('returns empty for null graph and empty graph', () => {
    const resolve = (_id: string) => paramFileWithPosterior('2026-05-12T07:06:14Z', 'fp-1');
    expect(collectDriftedBayesEdges(null, resolve)).toEqual([]);
    expect(collectDriftedBayesEdges(makeGraph([]), resolve)).toEqual([]);
  });

  it('uses edge.uuid for the returned edgeId, falling back to edge.id', () => {
    const graph: Graph = {
      nodes: [],
      edges: [
        // Edge with both uuid and id — uuid takes precedence
        {
          uuid: 'uuid-x', id: 'id-x', from: 'a', to: 'b',
          p: { id: 'p1', type: 'probability', model_vars: [{ source: 'analytic' }] },
        },
        // Edge with only id (no uuid) — id is used
        {
          id: 'id-y', from: 'c', to: 'd',
          p: { id: 'p2', type: 'probability', model_vars: [{ source: 'analytic' }] },
        },
      ] as any,
      policies: { default_outcome: 'end' },
      metadata: { version: '1.0.0' },
    } as any;
    const resolve = (id: string) => paramFileWithPosterior('2026-05-12T07:06:14Z', `fp-${id}`);

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toContainEqual({ paramId: 'p1', edgeId: 'uuid-x' });
    expect(drifted).toContainEqual({ paramId: 'p2', edgeId: 'id-y' });
  });

  it('returns multiple items in one pass (the gm-rebuild-jan-26 boot symptom)', () => {
    // Recreates the F5 log: four paramId-bearing edges, all analytic-only,
    // all four files have fresh posteriors. Drift returns all four.
    const graph = makeGraph([
      { uuid: 'e1', paramId: 'gm-create-to-delegated', modelVars: [{ source: 'analytic' }] },
      { uuid: 'e2', paramId: 'gm-delegated-to-registered', modelVars: [{ source: 'analytic' }] },
      { uuid: 'e3', paramId: 'gm-landing-page-to-account-created', modelVars: [{ source: 'analytic' }] },
      { uuid: 'e4', paramId: 'gm-registered-to-success', modelVars: [{ source: 'analytic' }] },
    ]);
    const resolve = (id: string) => paramFileWithPosterior('2026-05-12T07:06:14Z', `fp-${id}`);

    const drifted = collectDriftedBayesEdges(graph, resolve);

    expect(drifted).toHaveLength(4);
    expect(drifted.map(d => d.paramId)).toEqual(
      expect.arrayContaining([
        'gm-create-to-delegated',
        'gm-delegated-to-registered',
        'gm-landing-page-to-account-created',
        'gm-registered-to-success',
      ]),
    );
  });
});
