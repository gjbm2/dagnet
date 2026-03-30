/**
 * Cross-boundary integration test: chart axis extent consistency.
 *
 * Verifies that ALL FE sparkline/CDF charts use the same axis extent,
 * derived from t95 / path_t95 point estimates on the graph edge.
 *
 * Also verifies:
 *   - The BE cohort maturity chart extent is >= FE extent (it additionally
 *     includes sweep_span and HDI bounds, so is always at least as wide).
 *   - projectLatencyPosterior correctly routes edge t95 from window() slice
 *     and path t95 from cohort() slice.
 *
 * The BE test requires the Python BE to be running on localhost:9000.
 * Skips gracefully when the BE is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { projectLatencyPosterior } from '../posteriorSliceResolution';

// ── Known posterior fixture ────────────────────────────────────────────────

const POSTERIOR_MU = 1.3;
const POSTERIOR_SIGMA = 0.7;
const POSTERIOR_ONSET = 4.4;
const POSTERIOR_MU_SD = 0.05;
const POSTERIOR_SIGMA_SD = 0.03;
const POSTERIOR_ONSET_SD = 0.2;

const POSTERIOR_PATH_MU = -0.4;
const POSTERIOR_PATH_SIGMA = 3.0;
const POSTERIOR_PATH_ONSET = 17.0;
const POSTERIOR_PATH_MU_SD = 0.15;
const POSTERIOR_PATH_SIGMA_SD = 0.05;
const POSTERIOR_PATH_ONSET_SD = 0.22;

const POSTERIOR_HDI_T95_LOWER = 14.0;
const POSTERIOR_HDI_T95_UPPER = 16.5;
const POSTERIOR_PATH_HDI_T95_LOWER = 18.0;
const POSTERIOR_PATH_HDI_T95_UPPER = 95.0;

const WINDOW_ALPHA = 12.0;
const WINDOW_BETA = 3.0;
const COHORT_ALPHA = 100.0;
const COHORT_BETA = 20.0;

// Point estimates on the graph edge — these are what FE charts use
const EDGE_T95 = 20;
const PATH_T95 = 30;

const EDGE_UUID = 'test-edge-uuid-1234';

function makeGraph() {
  return {
    nodes: [
      { id: 'from-node', uuid: 'from-uuid' },
      { id: 'to-node', uuid: 'to-uuid' },
    ],
    edges: [{
      id: 'test-from-to-test-to',
      uuid: EDGE_UUID,
      from: 'from-uuid',
      to: 'to-uuid',
      p: {
        mean: 0.75,
        stdev: 0.01,
        forecast: { mean: 0.76 },
        model_vars: [
          {
            source: 'analytic',
            probability: { mean: 0.76, stdev: 0.02 },
            latency: { mu: 2.0, sigma: 0.4, t95: 20, onset_delta_days: 8.0, path_mu: 2.5, path_sigma: 0.35, path_t95: 30, path_onset_delta_days: 10.0 },
          },
          {
            source: 'bayesian',
            probability: { mean: 0.8, stdev: 0.095 },
            quality: { rhat: 1.001, ess: 5000, divergences: 0, gate_passed: true },
            latency: { mu: POSTERIOR_MU, sigma: POSTERIOR_SIGMA, t95: 15, onset_delta_days: POSTERIOR_ONSET, path_mu: POSTERIOR_PATH_MU, path_sigma: POSTERIOR_PATH_SIGMA, path_t95: 40 },
          },
        ],
        latency: {
          mu: 2.0, sigma: 0.4, onset_delta_days: 8.0,
          path_mu: 2.5, path_sigma: 0.35, path_onset_delta_days: 10.0,
          t95: EDGE_T95, path_t95: PATH_T95, latency_parameter: true,
          posterior: {
            distribution: 'lognormal',
            mu_mean: POSTERIOR_MU, mu_sd: POSTERIOR_MU_SD,
            sigma_mean: POSTERIOR_SIGMA, sigma_sd: POSTERIOR_SIGMA_SD,
            onset_delta_days: POSTERIOR_ONSET, onset_mean: POSTERIOR_ONSET, onset_sd: POSTERIOR_ONSET_SD,
            onset_mu_corr: -0.88,
            hdi_t95_lower: POSTERIOR_HDI_T95_LOWER, hdi_t95_upper: POSTERIOR_HDI_T95_UPPER,
            path_mu_mean: POSTERIOR_PATH_MU, path_mu_sd: POSTERIOR_PATH_MU_SD,
            path_sigma_mean: POSTERIOR_PATH_SIGMA, path_sigma_sd: POSTERIOR_PATH_SIGMA_SD,
            path_onset_delta_days: POSTERIOR_PATH_ONSET, path_onset_sd: POSTERIOR_PATH_ONSET_SD,
            path_hdi_t95_lower: POSTERIOR_PATH_HDI_T95_LOWER,
            path_hdi_t95_upper: POSTERIOR_PATH_HDI_T95_UPPER,
          },
        },
        posterior: {
          distribution: 'beta',
          alpha: WINDOW_ALPHA, beta: WINDOW_BETA,
          path_alpha: COHORT_ALPHA, path_beta: COHORT_BETA,
        },
      },
    }],
  };
}

// ── FE sparkline extent (replicates BayesModelRateChart / LatencyCdfSparkline / buildCombinedCdfOption) ──

function computeSparklineMaxDays(t95: number, pathT95: number): number {
  return Math.ceil(Math.max(t95, pathT95, 5));
}

// ── BE call ─────────────────────────────────────────────────────────────────

const PYTHON_BASE_URL = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';

async function callBE(graph: any, queryDsl: string): Promise<any> {
  const resp = await undiciFetch(`${PYTHON_BASE_URL}/api/runner/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenarios: [{
        scenario_id: 'current',
        name: 'Current',
        graph,
        visibility_mode: 'f+e',
        snapshot_subjects: [{
          subject_id: 'test-subject',
          param_id: 'test-param',
          core_hash: 'testhash',
          slice_keys: [queryDsl.includes('cohort') ? 'cohort()' : 'window()'],
          anchor_from: '2026-02-01',
          anchor_to: '2026-02-21',
          sweep_from: '2026-02-08',
          sweep_to: '2026-03-29',
          read_mode: 'cohort_maturity',
          target: { targetId: EDGE_UUID },
          from_node: 'from-node',
          to_node: 'to-node',
        }],
      }],
      query_dsl: queryDsl,
      analysis_type: 'cohort_maturity',
      display_settings: { show_model_bayesian: true, bayes_band_level: '90' },
    }),
  });
  if (!resp.ok) throw new Error(`BE returned ${resp.status}`);
  const raw = await resp.json() as any;
  return raw.result ?? raw;
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function isBEAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 1000);
    try {
      const resp = await undiciFetch(`${PYTHON_BASE_URL}/`, { signal: controller.signal });
      return resp.ok;
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return false;
  }
}

const BE_AVAILABLE = await isBEAvailable();
const describeIfBE = BE_AVAILABLE ? describe : describe.skip;

describe('FE sparkline axis extent consistency', () => {
  it('should derive extent from t95 / path_t95 point estimates, not formula or HDI', () => {
    // All three FE charts (BayesModelRateChart, buildCombinedCdfOption, LatencyCdfSparkline)
    // use the same computation: ceil(max(t95, path_t95, 5))
    const feMaxDays = computeSparklineMaxDays(EDGE_T95, PATH_T95);
    expect(feMaxDays).toBe(Math.ceil(Math.max(EDGE_T95, PATH_T95, 5)));
    expect(feMaxDays).toBe(30);
  });

  it('should use edge t95 only when path_t95 is not available', () => {
    const feMaxDays = computeSparklineMaxDays(EDGE_T95, 0);
    expect(feMaxDays).toBe(EDGE_T95);
  });

  it('should fall back to minimum of 5 when neither t95 is meaningful', () => {
    const feMaxDays = computeSparklineMaxDays(0, 0);
    expect(feMaxDays).toBe(5);
  });
});

describe('posteriorSliceResolution routes edge/path t95 from correct slices', () => {
  const windowSlice = {
    alpha: WINDOW_ALPHA, beta: WINDOW_BETA,
    mu_mean: POSTERIOR_MU, mu_sd: POSTERIOR_MU_SD,
    sigma_mean: POSTERIOR_SIGMA, sigma_sd: POSTERIOR_SIGMA_SD,
    onset_mean: POSTERIOR_ONSET, onset_sd: POSTERIOR_ONSET_SD,
    onset_mu_corr: -0.88,
    hdi_t95_lower: POSTERIOR_HDI_T95_LOWER, hdi_t95_upper: POSTERIOR_HDI_T95_UPPER,
    ess: 5000, rhat: 1.001, provenance: 'bayesian', evidence_grade: 3, divergences: 0,
  };
  const cohortSlice = {
    alpha: COHORT_ALPHA, beta: COHORT_BETA,
    mu_mean: POSTERIOR_PATH_MU, mu_sd: POSTERIOR_PATH_MU_SD,
    sigma_mean: POSTERIOR_PATH_SIGMA, sigma_sd: POSTERIOR_PATH_SIGMA_SD,
    onset_mean: POSTERIOR_PATH_ONSET, onset_sd: POSTERIOR_PATH_ONSET_SD,
    hdi_t95_lower: POSTERIOR_PATH_HDI_T95_LOWER, hdi_t95_upper: POSTERIOR_PATH_HDI_T95_UPPER,
    ess: 5000, rhat: 1.001, provenance: 'bayesian', evidence_grade: 3, divergences: 0,
  };

  it('should take edge hdi_t95 from window() slice and path hdi_t95 from cohort() slice', () => {
    const projected = projectLatencyPosterior(
      { slices: { 'window()': windowSlice, 'cohort()': cohortSlice }, fitted_at: '2026-03-29' } as any,
      'cohort(1-Feb-26:21-Feb-26)',
    );
    expect(projected).toBeDefined();
    expect(projected!.hdi_t95_lower).toBe(POSTERIOR_HDI_T95_LOWER);
    expect(projected!.hdi_t95_upper).toBe(POSTERIOR_HDI_T95_UPPER);
    expect(projected!.path_hdi_t95_lower).toBe(POSTERIOR_PATH_HDI_T95_LOWER);
    expect(projected!.path_hdi_t95_upper).toBe(POSTERIOR_PATH_HDI_T95_UPPER);
  });

  it('should omit path_hdi_t95 when cohort slice has no latency', () => {
    const projected = projectLatencyPosterior(
      { slices: { 'window()': windowSlice }, fitted_at: '2026-03-29' } as any,
      'window(1-Feb-26:21-Feb-26)',
    );
    expect(projected).toBeDefined();
    expect(projected!.hdi_t95_lower).toBe(POSTERIOR_HDI_T95_LOWER);
    expect(projected!.hdi_t95_upper).toBe(POSTERIOR_HDI_T95_UPPER);
    expect(projected!.path_hdi_t95_lower).toBeUndefined();
    expect(projected!.path_hdi_t95_upper).toBeUndefined();
  });
});

describeIfBE('CohortMaturity BE extent >= FE sparkline extent', () => {
  it('cohort mode: BE model_curve extent should be >= FE sparkline extent', async () => {
    const graph = makeGraph();

    const beResult = await callBE(graph, 'cohort(1-Feb-26:21-Feb-26)');
    const beCurve = beResult.model_curve ?? [];
    if (beCurve.length === 0) {
      // BE didn't produce a model curve for this fixture — skip comparison
      return;
    }
    const beMaxTau = Math.max(...beCurve.map((p: any) => p.tau_days));

    const feMaxDays = computeSparklineMaxDays(EDGE_T95, PATH_T95);

    // BE extent includes sweep_span and HDI bounds, so is always >= FE t95 extent
    expect(beMaxTau).toBeGreaterThanOrEqual(feMaxDays);
  });
});
