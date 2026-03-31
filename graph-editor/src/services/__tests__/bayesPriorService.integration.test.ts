/**
 * Integration tests for bayesPriorService (doc 19 §4.5).
 *
 * Tests the FE-side operations:
 *   - resetPriorsForParam: sets bayes_reset flag on param file
 *   - deleteHistoryForParam: removes fit_history from param file
 *   - clearBayesResetForParam: clears the flag after successful fit
 *   - Bulk variants: iterate all graph edges
 *
 * Uses real fileRegistry with mocked IDB (fileRegistry.registerFile calls db.files.put).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import {
  resetPriorsForParam,
  clearBayesResetForParam,
  deleteHistoryForParam,
  resetPriorsForAllParams,
  deleteHistoryForAllParams,
} from '../bayesPriorService';

// Mock IDB — registerFile and updateFile call db.files.put
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          and: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      toArray: vi.fn().mockResolvedValue([]),
    },
    workspaces: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    getSettings: vi.fn().mockResolvedValue(null),
  },
}));

// ── Helpers ──

function makeParamFile(paramId: string, opts: {
  posterior?: boolean;
  fitHistory?: boolean;
  bayesReset?: boolean;
} = {}) {
  const doc: any = {
    id: paramId,
    values: [{ sliceDSL: 'window(1-Jan-25:1-Mar-25)', n: 500, k: 175, mean: 0.35 }],
    latency: { latency_parameter: true, mu: 2.0, sigma: 0.4, t95: 30 },
  };
  if (opts.bayesReset) {
    doc.latency.bayes_reset = true;
  }
  if (opts.posterior) {
    doc.posterior = {
      fitted_at: '1-Feb-25',
      fingerprint: 'abc123',
      hdi_level: 0.9,
      slices: {
        'window()': { alpha: 80, beta: 200, mu_mean: 2.5, sigma_mean: 0.35, ess: 500, rhat: 1.001 },
      },
    };
    if (opts.fitHistory) {
      doc.posterior.fit_history = [
        { fitted_at: '1-Jan-25', fingerprint: 'old1', slices: { 'window()': { alpha: 70, beta: 190 } } },
        { fitted_at: '15-Jan-25', fingerprint: 'old2', slices: { 'window()': { alpha: 75, beta: 195 } } },
      ];
    }
  }
  return doc;
}

async function registerParam(paramId: string, doc: any) {
  const fileId = `parameter-${paramId}`;
  await fileRegistry.registerFile(fileId, {
    fileId,
    type: 'parameter',
    data: doc,
    originalData: JSON.parse(JSON.stringify(doc)),
    isDirty: false,
    lastModified: Date.now(),
  });
}

function getParamDoc(paramId: string): any {
  return fileRegistry.getFile(`parameter-${paramId}`)?.data;
}

function isParamDirty(paramId: string): boolean {
  return fileRegistry.getFile(`parameter-${paramId}`)?.isDirty ?? false;
}

// ── Tests ──

describe('bayesPriorService — single-param operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should set bayes_reset on param file and mark dirty', async () => {
    await registerParam('test-param', makeParamFile('test-param', { posterior: true }));

    const result = await resetPriorsForParam('test-param');

    expect(result).toBe(true);
    const doc = getParamDoc('test-param');
    expect(doc.latency.bayes_reset).toBe(true);
    expect(isParamDirty('test-param')).toBe(true);
  });

  it('should return false when param file does not exist', async () => {
    const result = await resetPriorsForParam('nonexistent');
    expect(result).toBe(false);
  });

  it('should invalidate bayesian gate in-place on matching edge when graphMutation is provided', async () => {
    await registerParam('test-param', makeParamFile('test-param', { posterior: true }));
    const graph: any = {
      edges: [
        { uuid: 'e1', p: {
          id: 'test-param',
          model_source_preference: 'bayesian',
          model_source_preference_overridden: true,
          model_vars: [{ source: 'bayesian', probability: { mean: 0.15 }, quality: { gate_passed: true } }],
        } },
        { uuid: 'e2', p: {
          id: 'other-param',
          model_source_preference: 'bayesian',
          model_vars: [{ source: 'bayesian', probability: { mean: 0.20 }, quality: { gate_passed: true } }],
        } },
      ],
    };

    const setGraph = vi.fn();
    await resetPriorsForParam('test-param', { graph, setGraph });

    // In-place mutation: matching edge has preference cleared, gate failed
    const e1 = graph.edges.find((e: any) => e.uuid === 'e1');
    expect(e1.p.model_source_preference).toBeUndefined();
    expect(e1.p.model_source_preference_overridden).toBeUndefined();
    expect(e1.p.model_vars[0].quality.gate_passed).toBe(false);
    // Unrelated edge: completely untouched
    const e2 = graph.edges.find((e: any) => e.uuid === 'e2');
    expect(e2.p.model_source_preference).toBe('bayesian');
    expect(e2.p.model_vars[0].quality.gate_passed).toBe(true);
    // setGraph is NOT called — mutation is in-place for the fetch pipeline to pick up
    expect(setGraph).not.toHaveBeenCalled();
  });

  it('should create latency block if absent when setting bayes_reset', async () => {
    const doc = { id: 'bare-param', values: [] };
    await registerParam('bare-param', doc);

    await resetPriorsForParam('bare-param');

    const updated = getParamDoc('bare-param');
    expect(updated.latency).toBeDefined();
    expect(updated.latency.bayes_reset).toBe(true);
  });

  it('should clear bayes_reset flag', async () => {
    await registerParam('test-param', makeParamFile('test-param', { bayesReset: true }));

    await clearBayesResetForParam('test-param');

    const doc = getParamDoc('test-param');
    expect(doc.latency.bayes_reset).toBeUndefined();
    expect(isParamDirty('test-param')).toBe(true);
  });

  it('should not mark dirty when clearing flag that is not set', async () => {
    await registerParam('test-param', makeParamFile('test-param'));

    await clearBayesResetForParam('test-param');

    expect(isParamDirty('test-param')).toBe(false);
  });

  it('should delete fit_history from posterior and mark dirty', async () => {
    await registerParam('test-param', makeParamFile('test-param', { posterior: true, fitHistory: true }));

    const result = await deleteHistoryForParam('test-param');

    expect(result).toBe(true);
    const doc = getParamDoc('test-param');
    expect(doc.posterior).toBeDefined();
    expect(doc.posterior.fit_history).toBeUndefined();
    // Slices should still be present
    expect(doc.posterior.slices).toBeDefined();
    expect(doc.posterior.slices['window()']).toBeDefined();
    expect(isParamDirty('test-param')).toBe(true);
  });

  it('should return false when no fit_history exists', async () => {
    await registerParam('test-param', makeParamFile('test-param', { posterior: true }));

    const result = await deleteHistoryForParam('test-param');

    expect(result).toBe(false);
  });

  it('should return false when param file has no posterior at all', async () => {
    await registerParam('test-param', makeParamFile('test-param'));

    const result = await deleteHistoryForParam('test-param');

    expect(result).toBe(false);
  });
});

describe('bayesPriorService — bulk operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reset priors on all graph edges', async () => {
    await registerParam('param-a', makeParamFile('param-a', { posterior: true }));
    await registerParam('param-b', makeParamFile('param-b', { posterior: true }));
    const graph = {
      nodes: [
        { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
        { uuid: 't1', id: 't1' },
        { uuid: 't2', id: 't2' },
      ],
      edges: [
        { uuid: 'e1', from: 'anchor', to: 't1', p: { id: 'param-a' } },
        { uuid: 'e2', from: 'anchor', to: 't2', p: { id: 'param-b' } },
      ],
    };

    const count = await resetPriorsForAllParams(() => graph as any);

    expect(count).toBe(2);
    expect(getParamDoc('param-a').latency.bayes_reset).toBe(true);
    expect(getParamDoc('param-b').latency.bayes_reset).toBe(true);
  });

  it('should invalidate bayesian gates in-place and clear bayesian pins (no setGraph needed)', async () => {
    await registerParam('param-a', makeParamFile('param-a', { posterior: true }));
    await registerParam('param-b', makeParamFile('param-b', { posterior: true }));
    const graph: any = {
      nodes: [
        { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
        { uuid: 't1', id: 't1' },
        { uuid: 't2', id: 't2' },
      ],
      edges: [
        { uuid: 'e1', from: 'anchor', to: 't1', p: {
          id: 'param-a',
          model_source_preference: 'bayesian',
          model_source_preference_overridden: true,
          model_vars: [
            { source: 'analytic', probability: { mean: 0.12 } },
            { source: 'bayesian', probability: { mean: 0.15 }, quality: { gate_passed: true } },
          ],
        } },
        { uuid: 'e2', from: 'anchor', to: 't2', p: {
          id: 'param-b',
          model_source_preference: 'analytic',
          model_vars: [
            { source: 'bayesian', probability: { mean: 0.20 }, quality: { gate_passed: true } },
          ],
        } },
      ],
    };

    const count = await resetPriorsForAllParams(() => graph);

    expect(count).toBe(2);
    // In-place: edge 1 bayesian pin cleared, bayesian gate failed
    const e1 = graph.edges.find((e: any) => e.uuid === 'e1');
    expect(e1.p.model_source_preference).toBeUndefined();
    expect(e1.p.model_source_preference_overridden).toBeUndefined();
    const e1Bayes = e1.p.model_vars.find((v: any) => v.source === 'bayesian');
    expect(e1Bayes.quality.gate_passed).toBe(false);
    // Analytic entry untouched
    const e1Analytic = e1.p.model_vars.find((v: any) => v.source === 'analytic');
    expect(e1Analytic.probability.mean).toBe(0.12);

    // Edge 2: analytic preference unchanged, bayesian gate failed
    const e2 = graph.edges.find((e: any) => e.uuid === 'e2');
    expect(e2.p.model_source_preference).toBe('analytic');
    const e2Bayes = e2.p.model_vars.find((v: any) => v.source === 'bayesian');
    expect(e2Bayes.quality.gate_passed).toBe(false);
  });

  it('should revert graph-level bayesian preference to best_available in-place', async () => {
    await registerParam('param-a', makeParamFile('param-a', { posterior: true }));
    const graph: any = {
      model_source_preference: 'bayesian',
      nodes: [
        { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
        { uuid: 't1', id: 't1' },
      ],
      edges: [
        { uuid: 'e1', from: 'anchor', to: 't1', p: {
          id: 'param-a',
          model_vars: [{ source: 'bayesian', probability: { mean: 0.1 }, quality: { gate_passed: true } }],
        } },
      ],
    };

    await resetPriorsForAllParams(() => graph);

    expect(graph.model_source_preference).toBe('best_available');
    const e1Bayes = graph.edges[0].p.model_vars.find((v: any) => v.source === 'bayesian');
    expect(e1Bayes.quality.gate_passed).toBe(false);
  });

  it('should leave non-bayesian preferences untouched during in-place mutation', async () => {
    await registerParam('param-a', makeParamFile('param-a', { posterior: true }));
    const graph: any = {
      model_source_preference: 'best_available',
      nodes: [
        { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
        { uuid: 't1', id: 't1' },
      ],
      edges: [
        { uuid: 'e1', from: 'anchor', to: 't1', p: { id: 'param-a', model_source_preference: 'analytic' } },
      ],
    };

    await resetPriorsForAllParams(() => graph);

    // Non-bayesian preferences preserved
    expect(graph.model_source_preference).toBe('best_available');
    expect(graph.edges[0].p.model_source_preference).toBe('analytic');
  });

  it('should deduplicate when multiple edges reference the same param', async () => {
    await registerParam('shared-param', makeParamFile('shared-param', { posterior: true }));
    const graph = {
      nodes: [
        { uuid: 'a', id: 'a', entry: { is_start: true } },
        { uuid: 'b', id: 'b' },
        { uuid: 'c', id: 'c' },
      ],
      edges: [
        { uuid: 'e1', from: 'a', to: 'b', p: { id: 'shared-param' } },
        { uuid: 'e2', from: 'a', to: 'c', p: { id: 'shared-param' } },
      ],
    };

    const count = await resetPriorsForAllParams(() => graph as any);

    expect(count).toBe(1);
  });

  it('should delete history from all graph edges', async () => {
    await registerParam('param-a', makeParamFile('param-a', { posterior: true, fitHistory: true }));
    await registerParam('param-b', makeParamFile('param-b', { posterior: true, fitHistory: true }));
    const graph = {
      nodes: [
        { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
        { uuid: 't1', id: 't1' },
        { uuid: 't2', id: 't2' },
      ],
      edges: [
        { uuid: 'e1', from: 'anchor', to: 't1', p: { id: 'param-a' } },
        { uuid: 'e2', from: 'anchor', to: 't2', p: { id: 'param-b' } },
      ],
    };

    const count = await deleteHistoryForAllParams(() => graph as any);

    expect(count).toBe(2);
    expect(getParamDoc('param-a').posterior.fit_history).toBeUndefined();
    expect(getParamDoc('param-b').posterior.fit_history).toBeUndefined();
  });

  it('should return 0 when graph has no edges', async () => {
    const count = await resetPriorsForAllParams(() => ({ nodes: [], edges: [] } as any));
    expect(count).toBe(0);
  });
});
