/**
 * Conditioned forecast must NOT write to `model_vars[*]`.
 *
 * First-principles invariant:
 *   `edge.p.model_vars` and `edge.p.conditional_p[*].p.model_vars` may
 *   only be mutated by two paths:
 *     1. FE topo (analytic generator) — derives `model_vars[analytic]`
 *        from parameter-file evidence stats.
 *     2. File-fetch / projection — projects `posterior.slices` (or a
 *        bayes patch) into `model_vars[bayesian]`.
 *
 *   CF is neither. CF computes scenario-conditioned current-answer
 *   scalars (p.mean via blendedMean, p.stdev, p.latency.completeness,
 *   p.latency.completeness_stdev, p.evidence.*) and writes those —
 *   nothing else.
 *
 * Before the fix at `UpdateManager.applyBatchLAGValues` (scope option +
 * `scope:'cf'` gate), CF's apply path went through the same atomic-
 * replacement branch as FE topo and wiped every field on
 * `model_vars[analytic].latency` to `undefined`, because CF's update
 * payload omits μ/σ/onset/dispersions. PW couldn't pin this down
 * because the next FE topo pass re-derived the analytic ledger, making
 * the wipe transient at steady state.
 *
 * This unit test is deterministic: directly invoke
 * `applyConditionedForecastToGraph` on a graph whose analytic ledger
 * is populated, then assert every model_vars field is unchanged.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { applyConditionedForecastToGraph, type ConditionedForecastScenarioResult } from '../conditionedForecastService';

const EDGE_UUID = 'edge-a-b';

function makeGraph() {
  return {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [
      {
        id: EDGE_UUID,
        uuid: EDGE_UUID,
        from: 'a',
        to: 'b',
        p: {
          id: 'param-a-b',
          mean: 0.4,
          stdev: 0.05,
          latency: {
            latency_parameter: true,
            t95: 30,
            path_t95: 30,
            completeness: 0.3,
            completeness_stdev: 0.04,
          },
          model_vars: [
            {
              source: 'analytic',
              source_at: '1-May-26',
              probability: {
                mean: 0.40,
                stdev: 0.08,
                alpha: 14.6,
                beta: 21.9,
                n_effective: 36.5,
                provenance: 'analytic_window_baseline',
              },
              latency: {
                mu: 2.0,
                sigma: 0.5,
                t95: Math.exp(2.0 + 1.645 * 0.5) + 3.0,
                onset_delta_days: 3.0,
                mu_sd: 0.08,
                sigma_sd: 0.04,
                onset_sd: 0.5,
                onset_mu_corr: -0.3,
                path_mu: 2.3,
                path_sigma: 0.7,
                path_t95: Math.exp(2.3 + 1.645 * 0.7) + 5.0,
                path_onset_delta_days: 5.0,
                path_mu_sd: 0.10,
                path_sigma_sd: 0.06,
                path_onset_sd: 0.8,
              },
              quality: { gate_passed: true } as any,
            },
            {
              source: 'bayesian',
              source_at: '2026-05-13T12:00:00Z',
              probability: {
                mean: 60 / 100,
                stdev: 0.0487,
                alpha: 60,
                beta: 40,
                cohort_alpha: 55,
                cohort_beta: 45,
                provenance: 'bayesian',
              },
              latency: {
                mu: 2.0,
                sigma: 0.5,
                t95: 19.82,
                onset_delta_days: 3.0,
                mu_sd: 0.08,
                sigma_sd: 0.04,
                onset_sd: 0.5,
                path_mu: 2.3,
                path_sigma: 0.7,
                path_t95: 36.55,
                path_onset_delta_days: 5.0,
                path_mu_sd: 0.10,
                path_sigma_sd: 0.06,
                path_onset_sd: 0.8,
              },
              quality: { rhat: 1.001, ess: 2000, divergences: 0, evidence_grade: 3, gate_passed: true },
            },
          ],
        },
      },
    ],
    metadata: { version: '1.1.0' },
    policies: {},
  };
}

function makeCfResults(): ConditionedForecastScenarioResult[] {
  return [
    {
      scenario_id: 'current',
      success: true,
      edges: [
        {
          edge_uuid: EDGE_UUID,
          p_mean: 0.62,
          p_sd: 0.05,
          p_sd_epistemic: 0.045,
          completeness: 0.78,
          completeness_sd: 0.06,
          evidence_n: 1000,
          evidence_k: 620,
          conditioned: true,
        },
      ],
    },
  ];
}

describe('applyConditionedForecastToGraph — model_vars first-principles invariant', () => {
  it('must not mutate any field on model_vars[analytic] or model_vars[bayesian]', () => {
    const before = makeGraph();
    const analyticBefore = JSON.parse(JSON.stringify(before.edges[0].p.model_vars[0]));
    const bayesianBefore = JSON.parse(JSON.stringify(before.edges[0].p.model_vars[1]));

    const after = applyConditionedForecastToGraph(before, makeCfResults());

    const analyticAfter = (after as any).edges[0].p.model_vars[0];
    const bayesianAfter = (after as any).edges[0].p.model_vars[1];

    expect(analyticAfter).toEqual(analyticBefore);
    expect(bayesianAfter).toEqual(bayesianBefore);
  });

  it('must still apply current-answer scalars (the fields CF DOES own)', () => {
    const after = applyConditionedForecastToGraph(makeGraph(), makeCfResults());
    const p = (after as any).edges[0].p;

    // CF writes p.mean via blendedMean (UpdateManager line ~2325).
    expect(p.mean).toBeCloseTo(0.62, 6);
    // CF writes p.latency.completeness + completeness_stdev (lines 2161-2168).
    expect(p.latency.completeness).toBeCloseTo(0.78, 6);
    expect(p.latency.completeness_stdev).toBeCloseTo(0.06, 6);
    // CF must NOT have touched p.forecast (which is applyPromotion's domain).
    // p.posterior + p.latency.posterior must also be untouched (no CF write
    // path goes near them).
    expect(p.forecast).toBeUndefined();
    expect(p.posterior).toBeUndefined();
    expect(p.latency.posterior).toBeUndefined();
  });
});
