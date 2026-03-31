/**
 * bayesPatchService — merge logic integration tests (doc 21 §4.2).
 *
 * Tests the observable effects of applyPatch on parameter files:
 *   - Unified posterior written with slices, _model_state, fitted_at
 *   - fit_history populated from previous posterior on second write
 *   - Legacy latency.posterior removed
 *   - bayes_reset cleared after merge
 *   - Fit history date-based eviction
 *
 * Uses real fileRegistry with mocked IDB (same pattern as bayesPriorService tests).
 * Written from the doc 21 specification, not from implementation code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import { applyPatch } from '../bayesPatchService';
import type { BayesPatchFile } from '../bayesPatchService';

// Mock IDB
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

// Mock sessionLogService to avoid noise
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    startOperation: vi.fn().mockReturnValue('op-1'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  },
}));

// ── Helpers ──

function makePatch(overrides: Partial<BayesPatchFile> = {}): BayesPatchFile {
  return {
    job_id: 'test-job-1',
    graph_id: 'graph-test',
    graph_file_path: 'graphs/test.json',
    fitted_at: '15-Mar-26',
    fingerprint: 'fp-new-abc',
    model_version: 1,
    quality: { max_rhat: 1.002, min_ess: 1100, converged_pct: 100 },
    edges: [{
      param_id: 'param-edge-1',
      file_path: 'parameters/edge-1.yaml',
      slices: {
        'window()': {
          alpha: 43, beta: 119.5, p_hdi_lower: 0.22, p_hdi_upper: 0.33,
          mu_mean: 2.35, mu_sd: 0.08, sigma_mean: 0.72, sigma_sd: 0.04,
          onset_mean: 1.5, onset_sd: 0.3,
          hdi_t95_lower: 18.5, hdi_t95_upper: 32.1,
          onset_mu_corr: -0.42,
          ess: 1100, rhat: 1.002, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
        'cohort()': {
          alpha: 38, beta: 112, p_hdi_lower: 0.20, p_hdi_upper: 0.35,
          mu_mean: 2.81, mu_sd: 0.12, sigma_mean: 0.58, sigma_sd: 0.06,
          onset_mean: 3.2, onset_sd: 0.5,
          hdi_t95_lower: 28.4, hdi_t95_upper: 58.7,
          ess: 800, rhat: 1.01, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
      },
      _model_state: { sigma_temporal: 0.12, tau_cohort: 0.31, kappa_edge_1: 23.7 },
      prior_tier: 'direct_history',
    }],
    skipped: [],
    ...overrides,
  };
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

async function registerGraph(graphId: string, doc: any) {
  await fileRegistry.registerFile(graphId, {
    fileId: graphId,
    type: 'graph',
    data: doc,
    originalData: JSON.parse(JSON.stringify(doc)),
    isDirty: false,
    lastModified: Date.now(),
  });
}

function getDoc(fileId: string): any {
  return fileRegistry.getFile(fileId)?.data;
}

// ── Tests ──

describe('bayesPatchService — unified posterior merge (doc 21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write unified posterior with slices and _model_state on fresh param file', async () => {
    const paramDoc = {
      id: 'param-edge-1',
      values: [{ sliceDSL: 'window(1-Jan:1-Mar)', n: 500, k: 175, mean: 0.35 }],
      latency: { latency_parameter: true, mu: 2.0, sigma: 0.4, t95: 30 },
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', { edges: [] });

    await applyPatch(makePatch());

    const doc = getDoc('parameter-param-edge-1');
    // Unified posterior block exists
    expect(doc.posterior).toBeDefined();
    expect(doc.posterior.fitted_at).toBe('15-Mar-26');
    expect(doc.posterior.fingerprint).toBe('fp-new-abc');
    expect(doc.posterior.hdi_level).toBe(0.9);
    expect(doc.posterior.prior_tier).toBe('direct_history');

    // Slices present with both window and cohort
    expect(doc.posterior.slices).toBeDefined();
    expect(doc.posterior.slices['window()'].alpha).toBe(43);
    expect(doc.posterior.slices['window()'].mu_mean).toBe(2.35);
    expect(doc.posterior.slices['window()'].onset_mu_corr).toBe(-0.42);
    expect(doc.posterior.slices['cohort()'].alpha).toBe(38);
    expect(doc.posterior.slices['cohort()'].mu_mean).toBe(2.81);

    // _model_state present
    expect(doc.posterior._model_state).toBeDefined();
    expect(doc.posterior._model_state.sigma_temporal).toBe(0.12);
    expect(doc.posterior._model_state.kappa_edge_1).toBe(23.7);

    // No fit_history on first write (no prior posterior to archive)
    expect(doc.posterior.fit_history).toBeUndefined();
  });

  it('should archive existing posterior to fit_history on second write', async () => {
    const paramDoc: any = {
      id: 'param-edge-1',
      values: [],
      latency: { latency_parameter: true },
      posterior: {
        fitted_at: '10-Mar-26',
        fingerprint: 'fp-old-xyz',
        hdi_level: 0.9,
        prior_tier: 'direct_history',
        slices: {
          'window()': { alpha: 30, beta: 100, ess: 900, rhat: 1.003 },
        },
      },
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', { edges: [] });

    await applyPatch(makePatch());

    const doc = getDoc('parameter-param-edge-1');
    // New posterior replaces old
    expect(doc.posterior.fitted_at).toBe('15-Mar-26');
    expect(doc.posterior.slices['window()'].alpha).toBe(43);

    // Old posterior archived in fit_history
    expect(doc.posterior.fit_history).toBeDefined();
    expect(doc.posterior.fit_history.length).toBeGreaterThanOrEqual(1);
    const archived = doc.posterior.fit_history[0];
    expect(archived.fitted_at).toBe('10-Mar-26');
    expect(archived.fingerprint).toBe('fp-old-xyz');
    expect(archived.slices['window()'].alpha).toBe(30);
  });

  it('should remove legacy latency.posterior after merge (doc 21 invariant 1)', async () => {
    const paramDoc: any = {
      id: 'param-edge-1',
      values: [],
      latency: {
        latency_parameter: true,
        mu: 2.0,
        posterior: { mu_mean: 1.5, sigma_mean: 0.3 },  // legacy — should be deleted
      },
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', { edges: [] });

    await applyPatch(makePatch());

    const doc = getDoc('parameter-param-edge-1');
    // Legacy latency.posterior removed
    expect(doc.latency.posterior).toBeUndefined();
    // Analytic latency fields preserved
    expect(doc.latency.mu).toBe(2.0);
    expect(doc.latency.latency_parameter).toBe(true);
  });

  it('should clear bayes_reset flag after successful merge (doc 19 §4.5)', async () => {
    const paramDoc: any = {
      id: 'param-edge-1',
      values: [],
      latency: { latency_parameter: true, bayes_reset: true },
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', { edges: [] });

    await applyPatch(makePatch());

    const doc = getDoc('parameter-param-edge-1');
    expect(doc.latency.bayes_reset).toBeUndefined();
  });

  it('should update latency.model_trained_at when latency data present', async () => {
    const paramDoc: any = {
      id: 'param-edge-1',
      values: [],
      latency: { latency_parameter: true },
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', { edges: [] });

    await applyPatch(makePatch());

    const doc = getDoc('parameter-param-edge-1');
    expect(doc.latency.model_trained_at).toBe('15-Mar-26');
  });

  it('should not write fit_history or _model_state when edge has no slices', async () => {
    const patch = makePatch({
      edges: [{
        param_id: 'param-edge-1',
        file_path: 'parameters/edge-1.yaml',
        slices: {},  // empty — no posterior data
      }],
    });
    const paramDoc: any = { id: 'param-edge-1', values: [] };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', { edges: [] });

    await applyPatch(patch);

    const doc = getDoc('parameter-param-edge-1');
    // Empty slices → no posterior written (mergePosteriorsIntoParam early-returns)
    expect(doc.posterior).toBeUndefined();
  });
});

describe('bayesPatchService — graph edge projection (doc 21 §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should project ProbabilityPosterior onto matching graph edge from window() slice', async () => {
    const paramDoc = { id: 'param-edge-1', values: [], latency: { latency_parameter: true } };
    const graphDoc: any = {
      edges: [{
        uuid: 'e1', from: 'a', to: 'b',
        p: { id: 'param-edge-1', latency: { latency_parameter: true, mu: 2.0, sigma: 0.4 } },
      }],
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', graphDoc);

    await applyPatch(makePatch());

    const graph = getDoc('graph-test');
    const edge = graph.edges[0];

    // ProbabilityPosterior from window() slice
    expect(edge.p.posterior).toBeDefined();
    expect(edge.p.posterior.alpha).toBe(43);
    expect(edge.p.posterior.beta).toBe(119.5);
    expect(edge.p.posterior.hdi_lower).toBe(0.22);
    expect(edge.p.posterior.provenance).toBe('bayesian');
    expect(edge.p.posterior.fitted_at).toBe('15-Mar-26');

    // Path-level from cohort()
    expect(edge.p.posterior.path_alpha).toBe(38);
    expect(edge.p.posterior.path_beta).toBe(112);

    // No file-level internals on graph edge (doc 21 invariant 4/6)
    expect(edge.p.posterior.slices).toBeUndefined();
    expect(edge.p.posterior._model_state).toBeUndefined();
    expect(edge.p.posterior.fit_history).toBeUndefined();
  });

  it('should project LatencyPosterior onto matching graph edge with path-level fields', async () => {
    const paramDoc = { id: 'param-edge-1', values: [], latency: { latency_parameter: true } };
    const graphDoc: any = {
      edges: [{
        uuid: 'e1', from: 'a', to: 'b',
        p: { id: 'param-edge-1', latency: { latency_parameter: true, mu: 2.0, sigma: 0.4 } },
      }],
    };
    await registerParam('param-edge-1', paramDoc);
    await registerGraph('graph-test', graphDoc);

    await applyPatch(makePatch());

    const graph = getDoc('graph-test');
    const lat = graph.edges[0].p.latency.posterior;

    // Edge-level from window()
    expect(lat).toBeDefined();
    expect(lat.mu_mean).toBe(2.35);
    expect(lat.sigma_mean).toBe(0.72);
    expect(lat.onset_delta_days).toBe(1.5);
    expect(lat.onset_mu_corr).toBe(-0.42);
    expect(lat.hdi_t95_lower).toBe(18.5);

    // Path-level from cohort()
    expect(lat.path_mu_mean).toBe(2.81);
    expect(lat.path_sigma_mean).toBe(0.58);
    expect(lat.path_onset_delta_days).toBe(3.2);
    expect(lat.path_hdi_t95_lower).toBe(28.4);
  });
});
