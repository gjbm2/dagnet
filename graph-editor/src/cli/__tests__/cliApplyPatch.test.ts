/**
 * CLI --apply-patch integration tests.
 *
 * Exercises the production applyPatch code path (bayesPatchService) via
 * diskLoader, verifying that promoted model_vars, posteriors, and latency
 * scalars are exactly correct. Uses the existing CLI test fixtures —
 * no mocks, no Python BE.
 *
 * Key invariants verified:
 *   - model_vars[bayesian] entry created with correct fields
 *   - probability.mean = alpha / (alpha + beta)
 *   - latency.mu = windowSlice.mu_mean (promoted)
 *   - latency.sigma = windowSlice.sigma_mean (promoted)
 *   - promoted_t95 = exp(mu + 1.645 * sigma) + onset
 *   - quality.gate_passed respects ESS/rhat thresholds
 *   - Parameter file receives unified posterior with both slices
 *   - Graph _bayes block has quality metadata
 *   - Path-level (cohort) fields projected correctly
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { loadGraphFromDisk, seedFileRegistry, type GraphBundle } from '../diskLoader';
import { applyPatch, type BayesPatchFile } from '../../services/bayesPatchService';
import { fileRegistry } from '../../contexts/TabContext';

const FIXTURES_DIR = join(__dirname, 'fixtures');

// ── Known patch values (hand-computable) ─────────────────────────────
const WINDOW_ALPHA = 45.2;
const WINDOW_BETA = 5.1;
const MU_MEAN = 2.35;
const MU_SD = 0.08;
const SIGMA_MEAN = 0.48;
const SIGMA_SD = 0.06;
const ONSET_MEAN = 0.5;
const ONSET_SD = 0.1;
const HDI_T95_LOWER = 8.2;
const HDI_T95_UPPER = 15.6;
const ONSET_MU_CORR = -0.15;
const ESS = 1200;
const RHAT = 1.002;

const COHORT_ALPHA = 44.8;
const COHORT_BETA = 5.3;
const COHORT_MU_MEAN = 2.80;
const COHORT_SIGMA_MEAN = 0.55;
const COHORT_ONSET_MEAN = 0.5;

// Expected promoted values (derived from known inputs)
const EXPECTED_P_MEAN = WINDOW_ALPHA / (WINDOW_ALPHA + WINDOW_BETA);
const EXPECTED_P_STDEV = Math.sqrt(
  (WINDOW_ALPHA * WINDOW_BETA) /
  ((WINDOW_ALPHA + WINDOW_BETA) ** 2 * (WINDOW_ALPHA + WINDOW_BETA + 1))
);
const EXPECTED_T95 = Math.exp(MU_MEAN + 1.645 * SIGMA_MEAN) + ONSET_MEAN;
const EXPECTED_PATH_T95 = Math.exp(COHORT_MU_MEAN + 1.645 * COHORT_SIGMA_MEAN) + COHORT_ONSET_MEAN;

const PARAM_ID = 'param-start-middle';

function buildTestPatch(): BayesPatchFile {
  return {
    job_id: 'test-apply-patch-001',
    graph_id: 'graph-test-fixture',
    graph_file_path: 'graph-test-fixture.yaml',
    fitted_at: '2026-04-14T12:00:00Z',
    fingerprint: 'test-fp-abc123',
    model_version: 1,
    quality: { max_rhat: RHAT, min_ess: ESS, converged_pct: 100 },
    edges: [{
      param_id: PARAM_ID,
      file_path: `parameters/${PARAM_ID}.yaml`,
      slices: {
        'window()': {
          alpha: WINDOW_ALPHA,
          beta: WINDOW_BETA,
          p_hdi_lower: 0.82,
          p_hdi_upper: 0.94,
          mu_mean: MU_MEAN,
          mu_sd: MU_SD,
          sigma_mean: SIGMA_MEAN,
          sigma_sd: SIGMA_SD,
          onset_mean: ONSET_MEAN,
          onset_sd: ONSET_SD,
          hdi_t95_lower: HDI_T95_LOWER,
          hdi_t95_upper: HDI_T95_UPPER,
          onset_mu_corr: ONSET_MU_CORR,
          ess: ESS,
          rhat: RHAT,
          divergences: 0,
          evidence_grade: 3,
          provenance: 'test-synth',
        },
        'cohort()': {
          alpha: COHORT_ALPHA,
          beta: COHORT_BETA,
          p_hdi_lower: 0.81,
          p_hdi_upper: 0.93,
          mu_mean: COHORT_MU_MEAN,
          mu_sd: 0.10,
          sigma_mean: COHORT_SIGMA_MEAN,
          sigma_sd: 0.07,
          onset_mean: COHORT_ONSET_MEAN,
          onset_sd: 0.15,
          hdi_t95_lower: 12.0,
          hdi_t95_upper: 22.0,
          ess: 1100,
          rhat: 1.003,
          divergences: 0,
          evidence_grade: 3,
          provenance: 'test-synth',
        },
      },
      prior_tier: 'uninformative',
      evidence_grade: 3,
      divergences: 0,
    }],
    skipped: [],
  };
}

describe('CLI --apply-patch (bayesPatchService via diskLoader)', () => {
  let bundle: GraphBundle;

  beforeAll(async () => {
    bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);
    await applyPatch(buildTestPatch());
  });

  // ── Graph-level assertions ────────────────────────────────────────

  it('should set _bayes block on graph with quality metadata', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const graph = graphFile!.data as any;
    expect(graph._bayes).toBeDefined();
    expect(graph._bayes.fitted_at).toBe('2026-04-14T12:00:00Z');
    expect(graph._bayes.fingerprint).toBe('test-fp-abc123');
    expect(graph._bayes.model_version).toBe(1);
    expect(graph._bayes.quality.max_rhat).toBe(RHAT);
    expect(graph._bayes.quality.min_ess).toBe(ESS);
    expect(graph._bayes.quality.converged_pct).toBe(100);
  });

  // ── model_vars assertions ─────────────────────────────────────────

  it('should create model_vars[bayesian] entry with correct probability', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const mv = edge.p.model_vars?.find((m: any) => m.source === 'bayesian');

    expect(mv).toBeDefined();
    expect(mv.source).toBe('bayesian');
    expect(mv.source_at).toBe('2026-04-14T12:00:00Z');
    expect(mv.probability.mean).toBeCloseTo(EXPECTED_P_MEAN, 10);
    expect(mv.probability.stdev).toBeCloseTo(EXPECTED_P_STDEV, 10);
  });

  it('should create model_vars[bayesian] latency with exact promoted values', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const lat = edge.p.model_vars?.find((m: any) => m.source === 'bayesian')?.latency;

    expect(lat).toBeDefined();
    expect(lat.mu).toBe(MU_MEAN);
    expect(lat.sigma).toBe(SIGMA_MEAN);
    expect(lat.onset_delta_days).toBe(ONSET_MEAN);
    expect(lat.t95).toBeCloseTo(EXPECTED_T95, 10);
  });

  it('should create model_vars[bayesian] path-level latency from cohort slice', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const lat = edge.p.model_vars?.find((m: any) => m.source === 'bayesian')?.latency;

    expect(lat.path_mu).toBe(COHORT_MU_MEAN);
    expect(lat.path_sigma).toBe(COHORT_SIGMA_MEAN);
    expect(lat.path_onset_delta_days).toBe(COHORT_ONSET_MEAN);
    expect(lat.path_t95).toBeCloseTo(EXPECTED_PATH_T95, 10);
  });

  it('should set quality gate_passed=true for converged posteriors', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const q = edge.p.model_vars?.find((m: any) => m.source === 'bayesian')?.quality;

    expect(q).toBeDefined();
    expect(q.gate_passed).toBe(true);
    expect(q.rhat).toBe(RHAT);
    expect(q.ess).toBe(ESS);
    expect(q.divergences).toBe(0);
    expect(q.evidence_grade).toBe(3);
  });

  // ── Promoted latency scalars on edge.p.latency ────────────────────

  it('should promote mu/sigma/onset/t95 onto edge.p.latency', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const lat = edge.p.latency;

    expect(lat.mu).toBe(MU_MEAN);
    expect(lat.sigma).toBe(SIGMA_MEAN);
    expect(lat.promoted_t95).toBeCloseTo(EXPECTED_T95, 10);
    expect(lat.promoted_onset_delta_days).toBe(ONSET_MEAN);
  });

  it('should promote path-level latency onto edge.p.latency', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const lat = edge.p.latency;

    expect(lat.path_mu).toBe(COHORT_MU_MEAN);
    expect(lat.path_sigma).toBe(COHORT_SIGMA_MEAN);
    expect(lat.promoted_path_t95).toBeCloseTo(EXPECTED_PATH_T95, 10);
  });

  // ── Probability posterior on edge.p.posterior ──────────────────────

  it('should project window() probability posterior onto edge.p.posterior', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const post = edge.p.posterior;

    expect(post).toBeDefined();
    expect(post.distribution).toBe('beta');
    expect(post.alpha).toBe(WINDOW_ALPHA);
    expect(post.beta).toBe(WINDOW_BETA);
    expect(post.hdi_lower).toBe(0.82);
    expect(post.hdi_upper).toBe(0.94);
    expect(post.ess).toBe(ESS);
    expect(post.rhat).toBe(RHAT);
    expect(post.fitted_at).toBe('2026-04-14T12:00:00Z');
    expect(post.provenance).toBe('test-synth');
  });

  it('should project cohort() path-level onto edge.p.posterior', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const post = edge.p.posterior;

    expect(post.cohort_alpha).toBe(COHORT_ALPHA);
    expect(post.cohort_beta).toBe(COHORT_BETA);
    expect(post.cohort_hdi_lower).toBe(0.81);
    expect(post.cohort_hdi_upper).toBe(0.93);
  });

  // ── Latency posterior on edge.p.latency.posterior ──────────────────

  it('should project window() latency posterior onto edge.p.latency.posterior', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const latPost = edge.p.latency.posterior;

    expect(latPost).toBeDefined();
    expect(latPost.distribution).toBe('lognormal');
    expect(latPost.mu_mean).toBe(MU_MEAN);
    expect(latPost.mu_sd).toBe(MU_SD);
    expect(latPost.sigma_mean).toBe(SIGMA_MEAN);
    expect(latPost.sigma_sd).toBe(SIGMA_SD);
    expect(latPost.onset_mean).toBe(ONSET_MEAN);
    expect(latPost.onset_sd).toBe(ONSET_SD);
    expect(latPost.onset_mu_corr).toBe(ONSET_MU_CORR);
    expect(latPost.hdi_t95_lower).toBe(HDI_T95_LOWER);
    expect(latPost.hdi_t95_upper).toBe(HDI_T95_UPPER);
  });

  it('should project cohort() path-level latency onto edge.p.latency.posterior', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const latPost = edge.p.latency.posterior;

    expect(latPost.path_mu_mean).toBe(COHORT_MU_MEAN);
    expect(latPost.path_sigma_mean).toBe(COHORT_SIGMA_MEAN);
    expect(latPost.path_onset_delta_days).toBe(COHORT_ONSET_MEAN);
    expect(latPost.path_hdi_t95_lower).toBe(12.0);
    expect(latPost.path_hdi_t95_upper).toBe(22.0);
  });

  // ── Parameter file posterior ───────────────────────────────────────

  it('should write unified posterior to parameter file with both slices', () => {
    const paramFile = fileRegistry.getFile(`parameter-${PARAM_ID}`);
    const paramDoc = paramFile!.data as any;
    const post = paramDoc.posterior;

    expect(post).toBeDefined();
    expect(post.fitted_at).toBe('2026-04-14T12:00:00Z');
    expect(post.fingerprint).toBe('test-fp-abc123');
    expect(post.slices).toBeDefined();
    expect(Object.keys(post.slices)).toContain('window()');
    expect(Object.keys(post.slices)).toContain('cohort()');

    const ws = post.slices['window()'];
    expect(ws.alpha).toBe(WINDOW_ALPHA);
    expect(ws.mu_mean).toBe(MU_MEAN);
    expect(ws.sigma_mean).toBe(SIGMA_MEAN);
    expect(ws.ess).toBe(ESS);
  });

  // ── Quality gate edge cases ────────────────────────────────────────

  it('should set gate_passed=false when rhat exceeds threshold', async () => {
    // Reload fresh fixtures
    const freshBundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(freshBundle);

    const badPatch = buildTestPatch();
    badPatch.edges[0].slices!['window()'].rhat = 1.15; // above 1.1 gate
    await applyPatch(badPatch);

    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const q = edge.p.model_vars?.find((m: any) => m.source === 'bayesian')?.quality;
    expect(q.gate_passed).toBe(false);
  });

  it('should set gate_passed=false when latency rhat exceeds threshold', async () => {
    // The gate checks both probability and latency rhat
    const freshBundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(freshBundle);

    const badPatch = buildTestPatch();
    // Probability rhat is fine but latency rhat is bad
    // In applyPatch, latency quality is derived from the same window slice
    // ess/rhat — so setting rhat high affects the combined gate
    badPatch.edges[0].slices!['window()'].rhat = 1.12;
    await applyPatch(badPatch);

    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const edge = (graphFile!.data as any).edges.find((e: any) => e.p?.id === PARAM_ID);
    const q = edge.p.model_vars?.find((m: any) => m.source === 'bayesian')?.quality;
    expect(q.gate_passed).toBe(false);
  });

  // ── Untouched edge should not get model_vars ───────────────────────

  it('should not add model_vars to edges not in the patch', () => {
    const graphFile = fileRegistry.getFile('graph-test-fixture');
    const otherEdge = (graphFile!.data as any).edges.find(
      (e: any) => e.p?.id === 'param-middle-end'
    );
    const mv = otherEdge?.p?.model_vars;
    // Should be undefined or empty — patch only touched param-start-middle
    expect(mv?.find((m: any) => m.source === 'bayesian')).toBeUndefined();
  });
});
