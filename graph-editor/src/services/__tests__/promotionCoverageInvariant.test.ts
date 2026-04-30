/**
 * Promotion-coverage invariant (posterior unification plan §4 Step 0).
 *
 * Posterior unification makes `p.posterior` and `p.latency.posterior`
 * source-agnostic surfaces written exclusively by `applyPromotion` from
 * the active `model_vars[*]` entry. That contract only holds if every
 * site that mutates `model_vars`, `quality.gate_passed`, or the
 * source-preference selector ends with `applyPromotion`.
 *
 * Step 0 closed six known gaps. This file pins them as behavioural tests:
 * after each operation, the forecast scalars must reflect the active
 * source — and not the one whose entry just got mutated/invalidated.
 *
 * The §4 Step 0 audit also identifies one site (`fetchDataService.ts`
 * horizon bootstrap) that is correct only because of an implicit caller
 * contract — the surrounding fetch always runs the LAG/FE pass + a
 * promotion sweep. That site is documented inline; we don't re-test it
 * here because the surrounding fetch is exercised by other suites.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock IDB before importing services that touch fileRegistry.
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

import { fileRegistry } from '../../contexts/TabContext';
import {
  resetPriorsForParam,
  resetPriorsForAllParams,
  deleteHistoryForParam,
  deleteHistoryForAllParams,
} from '../bayesPriorService';

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerParam(paramId: string, doc: any): Promise<void> {
  const fileId = `parameter-${paramId}`;
  await fileRegistry.registerFile(fileId, {
    fileId,
    type: 'parameter',
    data: doc,
    originalData: JSON.parse(JSON.stringify(doc)),
    isDirty: false,
    lastModified: Date.now(),
  } as any);
}

function makeParamFile(paramId: string): any {
  return {
    id: paramId,
    values: [{ sliceDSL: 'window(1-Jan-25:1-Mar-25)', n: 500, k: 175, mean: 0.35 }],
    latency: { latency_parameter: true, mu: 2.0, sigma: 0.4, t95: 30 },
    posterior: { distribution: 'beta', alpha: 80, beta: 200 },
  };
}

/**
 * Build an edge with both analytic and bayesian entries. The analytic
 * mean is 0.30 with a valid Beta moment-match. The bayesian mean is
 * 0.40 (deliberately distinct) with `gate_passed: true` so a healthy
 * promotion picks bayesian. After Step 0's invalidations, the gate must
 * fail and the forecast must come from analytic.
 */
function makeEdgeWithBothSources(paramId: string): any {
  return {
    uuid: `e-${paramId}`,
    from: 'anchor',
    to: 'target',
    p: {
      id: paramId,
      model_source_preference: 'best_available',
      model_vars: [
        {
          source: 'analytic',
          probability: { mean: 0.30, stdev: 0.05, alpha: 25, beta: 58.33, n_effective: 83.33, provenance: 'analytic_window_baseline' },
          latency: { mu: 2.0, sigma: 0.4, t95: 30, onset_delta_days: 1 },
        },
        {
          source: 'bayesian',
          probability: { mean: 0.40, stdev: 0.06 },
          latency: { mu: 2.5, sigma: 0.5, t95: 40, onset_delta_days: 2 },
          quality: { gate_passed: true, rhat: 1.005, ess: 1500 },
        },
      ],
      forecast: { mean: 0.40, stdev: 0.06, source: 'bayesian' }, // pre-state: bayesian promoted
      latency: { latency_parameter: true, mu: 2.5, sigma: 0.5, promoted_t95: 40, promoted_onset_delta_days: 2 },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Posterior unification §4 Step 0 — promotion coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resetPriorsForAllParams', () => {
    it('leaves edges fully promoted: forecast reflects analytic after gate is failed', async () => {
      await registerParam('p1', makeParamFile('p1'));
      const graph: any = {
        model_source_preference: 'best_available',
        nodes: [
          { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
          { uuid: 'target', id: 'target' },
        ],
        edges: [makeEdgeWithBothSources('p1')],
      };

      await resetPriorsForAllParams(() => graph);

      const edge = graph.edges[0];
      // Bayesian gate must be failed.
      const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
      expect(bayesEntry.quality.gate_passed).toBe(false);
      // Forecast must now reflect analytic, NOT the stale bayesian value.
      expect(edge.p.forecast.source).toBe('analytic');
      expect(edge.p.forecast.mean).toBeCloseTo(0.30, 6);
      expect(edge.p.forecast.stdev).toBeCloseTo(0.05, 6);
      // Latency promoted scalars must reflect the analytic entry.
      expect(edge.p.latency.mu).toBeCloseTo(2.0, 6);
      expect(edge.p.latency.sigma).toBeCloseTo(0.4, 6);
      expect(edge.p.latency.promoted_t95).toBeCloseTo(30, 6);
    });
  });

  describe('deleteHistoryForAllParams', () => {
    it('leaves edges fully promoted: forecast reflects analytic after gate is failed', async () => {
      await registerParam('p1', makeParamFile('p1'));
      const graph: any = {
        model_source_preference: 'best_available',
        nodes: [
          { uuid: 'anchor', id: 'anchor', entry: { is_start: true } },
          { uuid: 'target', id: 'target' },
        ],
        edges: [makeEdgeWithBothSources('p1')],
      };

      await deleteHistoryForAllParams(() => graph);

      const edge = graph.edges[0];
      const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
      expect(bayesEntry.quality.gate_passed).toBe(false);
      expect(edge.p.forecast.source).toBe('analytic');
      expect(edge.p.forecast.mean).toBeCloseTo(0.30, 6);
    });
  });

  describe('resetPriorsForParam (single-param via invalidateBayesianOnEdges)', () => {
    it('leaves the touched edge fully promoted: forecast reflects analytic', async () => {
      await registerParam('p1', makeParamFile('p1'));
      const graph: any = {
        model_source_preference: 'best_available',
        edges: [makeEdgeWithBothSources('p1')],
      };
      // Pin the edge to bayesian so invalidateBayesianOnEdges has both
      // a pin to clear AND a gate to fail.
      graph.edges[0].p.model_source_preference = 'bayesian';
      graph.edges[0].p.model_source_preference_overridden = true;
      const setGraph = vi.fn();

      await resetPriorsForParam('p1', { graph, setGraph });

      const edge = graph.edges[0];
      // Bayesian pin cleared.
      expect(edge.p.model_source_preference).toBeUndefined();
      // Bayesian gate failed.
      const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
      expect(bayesEntry.quality.gate_passed).toBe(false);
      // Forecast reflects analytic post-promotion.
      expect(edge.p.forecast.source).toBe('analytic');
      expect(edge.p.forecast.mean).toBeCloseTo(0.30, 6);
    });
  });

  describe('deleteHistoryForParam (single-param via invalidateBayesianOnEdges with clearPosterior)', () => {
    it('post-Step-2: p.posterior is rewritten from the analytic source (not left cleared)', async () => {
      await registerParam('p1', makeParamFile('p1'));
      const edge = makeEdgeWithBothSources('p1');
      // Stale bayesian posterior data on the live edge — the kind of state
      // that produced the parity defect before unification.
      edge.p.posterior = { distribution: 'beta', alpha: 80, beta: 200 };
      edge.p.latency.posterior = { mu_mean: 2.5, sigma_mean: 0.35 };
      edge.p.model_source_preference = 'bayesian';
      const graph: any = {
        model_source_preference: 'best_available',
        edges: [edge],
      };
      const setGraph = vi.fn();

      await deleteHistoryForParam('p1', { graph, setGraph });

      // Bayesian pin cleared, gate failed.
      expect(edge.p.model_source_preference).toBeUndefined();
      const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
      expect(bayesEntry.quality.gate_passed).toBe(false);
      // Forecast reflects analytic post-promotion.
      expect(edge.p.forecast.source).toBe('analytic');
      expect(edge.p.forecast.mean).toBeCloseTo(0.30, 6);
      // Posterior unification plan §4 Step 2: p.posterior is the source-
      // agnostic projection of the active source's Beta. After
      // invalidateBayesianOnEdges deletes the stale bayesian Beta and
      // applyPromotion runs, p.posterior carries the analytic α/β —
      // structurally impossible to be stale-bayesian.
      expect(edge.p.posterior).toBeDefined();
      expect(edge.p.posterior.distribution).toBe('beta');
      expect(edge.p.posterior.alpha).toBeCloseTo(25, 6);
      expect(edge.p.posterior.beta).toBeCloseTo(58.33, 2);
      expect(edge.p.posterior.provenance).toBe('analytic_window_baseline');
      // Latency v1.1 (30-Apr-26): p.latency.posterior is projected source-
      // agnostically by applyPromotion from model_vars[active].latency.
      // For analytic, the projection is a degenerate posterior — point
      // estimates (mu_mean, sigma_mean, onset_delta_days) without SDs.
      // The promoted card surfaces this as the active source's actual
      // promoted view, rather than rendering nothing because of a stale
      // source-conditional gate.
      expect(edge.p.latency.posterior).toBeDefined();
      expect(edge.p.latency.posterior.distribution).toBe('lognormal');
      expect(edge.p.latency.posterior.mu_mean).toBe(2.0);
      expect(edge.p.latency.posterior.sigma_mean).toBe(0.4);
      expect(edge.p.latency.posterior.onset_delta_days).toBe(1);
      expect(edge.p.latency.posterior.provenance).toBe('analytic_window_baseline');
    });
  });

  describe('Step 2 — p.posterior reflects the active selector', () => {
    it('parity reproducer: stale bayesian Beta survives an analytic pin', async () => {
      // The bug this refactor structurally eliminates: a graph with
      // model_source_preference = 'analytic' but a stale bayesian Beta
      // sitting on p.posterior, producing FE = analytic α/β and BE =
      // bayesian α/β when the resolver fell through to p.posterior first.
      const edge: any = {
        uuid: 'e-parity',
        p: {
          model_source_preference: 'analytic',
          model_vars: [
            {
              source: 'analytic',
              probability: { mean: 0.30, stdev: 0.05, alpha: 25, beta: 58.33, n_effective: 83.33, provenance: 'analytic_window_baseline' },
            },
            {
              source: 'bayesian',
              probability: { mean: 0.85, stdev: 0.10, alpha: 100, beta: 17.65, n_effective: 117.65, provenance: 'bayesian' },
              quality: { gate_passed: true, rhat: 1.005, ess: 1500, divergences: 0, evidence_grade: 3 },
            },
          ],
          // Stale bayesian Beta squatting on p.posterior — the parity defect.
          posterior: { distribution: 'beta', alpha: 100, beta: 17.65 },
        },
      };

      const { applyPromotion } = await import('../modelVarsResolution');
      applyPromotion(edge.p, 'best_available');

      // After promotion, p.posterior matches the analytic Beta — the
      // stale bayesian projection is structurally impossible to survive.
      expect(edge.p.posterior.alpha).toBeCloseTo(25, 6);
      expect(edge.p.posterior.beta).toBeCloseTo(58.33, 2);
      expect(edge.p.posterior.provenance).toBe('analytic_window_baseline');
      expect(edge.p.forecast.source).toBe('analytic');
    });

    it('source-agnostic invariant: pinning to bayesian projects the bayesian Beta', async () => {
      const edge: any = {
        uuid: 'e-bayes-pin',
        p: {
          model_source_preference: 'bayesian',
          model_vars: [
            {
              source: 'analytic',
              probability: { mean: 0.30, stdev: 0.05, alpha: 25, beta: 58.33, provenance: 'analytic_window_baseline' },
            },
            {
              source: 'bayesian',
              probability: { mean: 0.85, stdev: 0.10, alpha: 100, beta: 17.65, provenance: 'bayesian' },
              quality: { gate_passed: true, rhat: 1.005, ess: 1500, divergences: 0, evidence_grade: 3 },
            },
          ],
        },
      };

      const { applyPromotion } = await import('../modelVarsResolution');
      applyPromotion(edge.p, 'best_available');

      expect(edge.p.posterior.alpha).toBeCloseTo(100, 6);
      expect(edge.p.posterior.beta).toBeCloseTo(17.65, 2);
      expect(edge.p.posterior.provenance).toBe('bayesian');
      expect(edge.p.forecast.source).toBe('bayesian');
    });

    it('clears p.posterior when the promoted source has no Beta', async () => {
      const edge: any = {
        uuid: 'e-no-beta',
        p: {
          model_source_preference: 'analytic',
          model_vars: [
            // analytic without a moment-match (mean alone, no α/β).
            { source: 'analytic', probability: { mean: 0.30, stdev: 0 } },
          ],
          // Pre-existing stale projection.
          posterior: { distribution: 'beta', alpha: 80, beta: 200 },
        },
      };

      const { applyPromotion } = await import('../modelVarsResolution');
      applyPromotion(edge.p, 'best_available');

      // No Beta on the promoted source → p.posterior is cleared.
      expect(edge.p.posterior).toBeUndefined();
      expect(edge.p.forecast.source).toBe('analytic');
    });

    it('clears p.posterior when no source resolves at all', async () => {
      const edge: any = {
        uuid: 'e-empty',
        p: {
          model_source_preference: 'best_available',
          model_vars: [],
          posterior: { distribution: 'beta', alpha: 80, beta: 200 },
          forecast: { mean: 0.5, stdev: 0.1, source: 'bayesian' },
        },
      };

      const { applyPromotion } = await import('../modelVarsResolution');
      applyPromotion(edge.p, 'best_available');

      // No entry resolved → all promoted surfaces cleared.
      expect(edge.p.posterior).toBeUndefined();
      expect(edge.p.forecast.source).toBeUndefined();
    });

    it('projects bayesian latency posterior when the entry has mu_sd', async () => {
      const edge: any = {
        uuid: 'e-lat',
        p: {
          model_source_preference: 'bayesian',
          model_vars: [
            {
              source: 'bayesian',
              probability: { mean: 0.5, stdev: 0.1, alpha: 25, beta: 25, provenance: 'bayesian' },
              latency: { mu: 2.5, sigma: 0.5, t95: 40, onset_delta_days: 2, mu_sd: 0.1, sigma_sd: 0.05 },
              quality: { gate_passed: true, rhat: 1.005, ess: 1500, divergences: 0, evidence_grade: 3 },
            },
          ],
          latency: { latency_parameter: true },
        },
      };

      const { applyPromotion } = await import('../modelVarsResolution');
      applyPromotion(edge.p, 'best_available');

      // Field-name rename per plan §3: mu → mu_mean, sigma → sigma_mean.
      expect(edge.p.latency.posterior).toBeDefined();
      expect(edge.p.latency.posterior.mu_mean).toBeCloseTo(2.5, 6);
      expect(edge.p.latency.posterior.sigma_mean).toBeCloseTo(0.5, 6);
      expect(edge.p.latency.posterior.mu_sd).toBeCloseTo(0.1, 6);
      expect(edge.p.latency.posterior.distribution).toBe('lognormal');
    });
  });

  describe('idempotency: re-running the same operation is safe', () => {
    it('a second resetPriorsForAllParams leaves a graph already-failed-and-promoted unchanged', async () => {
      await registerParam('p1', makeParamFile('p1'));
      const graph: any = {
        model_source_preference: 'best_available',
        edges: [makeEdgeWithBothSources('p1')],
      };

      await resetPriorsForAllParams(() => graph);
      const firstSnapshot = JSON.stringify(graph.edges[0].p);

      await resetPriorsForAllParams(() => graph);
      const secondSnapshot = JSON.stringify(graph.edges[0].p);

      expect(secondSnapshot).toBe(firstSnapshot);
    });
  });
});
