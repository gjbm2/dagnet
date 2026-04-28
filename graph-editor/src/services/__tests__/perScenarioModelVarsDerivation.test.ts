/**
 * Per-scenario model_vars derivation — doc 73b §8 Stage 4(a) / doc 73d.
 *
 * Pins two sentinels that posteriorSliceContexting.test.ts does not
 * already cover:
 *
 *   (i) Analytic preservation — when the per-scenario contexting step
 *   re-projects the bayesian source from a parameter-file slice, the
 *   `model_vars[analytic]` entry on the request graph survives. Stage
 *   4(a)'s contexting must not strip analytic source state.
 *
 *  (ii) No cross-context bayesian fallback — when the requested
 *  scenario DSL has no matching slice in the parameter file, the
 *  request graph's bayesian fields are NOT silently borrowed from a
 *  different context's slice. The selector cascade and §3.9 mirror
 *  contract both rely on the absence of cross-context fallback; a
 *  silent borrow would re-introduce the multi-context leakage that
 *  Stage 4(a) is supposed to close.
 *
 * Other claims that 73d names for this test (correct slice picked,
 * in-schema field projection, fit_history engorgement) are pinned by
 * `analysisPrepRecontext.integration.test.ts` and
 * `posteriorSliceContexting.test.ts`. This file deliberately stays
 * narrow on the two outstanding sentinels.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareAnalysisComputeInputs,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';

const PARAM_ID = 'edge-1-param';

function paramFileWithTwoContexts() {
  return {
    posterior: {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-current',
      hdi_level: 0.9,
      slices: {
        // Default window context.
        'window()': {
          alpha: 30, beta: 90,
          mu_mean: 1.5, sigma_mean: 0.3, onset_mean: 4.0,
          ess: 1100, rhat: 1.003, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
        // Channel-scoped window context.
        'context(channel:google).window()': {
          alpha: 80, beta: 20,
          mu_mean: 2.5, sigma_mean: 0.5, onset_mean: 6.0,
          ess: 1100, rhat: 1.003, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
      },
    },
    values: [{ sliceDSL: 'window()', n: 200, k: 50, mean: 0.25, stdev: 0.03 }],
  };
}

function paramFileWithOnlyDefaultContext() {
  // Param file with only the default `window()` slice — no branch for
  // any context-scoped DSL. Used to exercise the no-fallback sentinel.
  return {
    posterior: {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-current',
      hdi_level: 0.9,
      slices: {
        'window()': {
          alpha: 30, beta: 90,
          mu_mean: 1.5, sigma_mean: 0.3, onset_mean: 4.0,
          ess: 1100, rhat: 1.003, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
      },
    },
    values: [{ sliceDSL: 'window()', n: 200, k: 50, mean: 0.25, stdev: 0.03 }],
  };
}

function makeGraph(opts: { withAnalyticEntry?: boolean } = {}) {
  const p: any = { id: PARAM_ID, mean: 0.25, type: 'probability' };
  if (opts.withAnalyticEntry) {
    p.model_vars = [
      {
        source: 'analytic',
        source_at: '20-Mar-26',
        probability: {
          mean: 0.27, stdev: 0.04,
          alpha: 27, beta: 73, n_effective: 100,
          provenance: 'analytic_window_baseline',
        },
        latency: { mu: 1.7, sigma: 0.32, t95: 12, onset_delta_days: 4 },
      },
    ];
  }
  return {
    nodes: [
      { uuid: 'n1', id: 'a', entry: { is_start: true } },
      { uuid: 'n2', id: 'b', absorbing: true },
    ],
    edges: [{ uuid: 'e1', id: 'e1', from: 'n1', to: 'n2', p }],
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
  };
}

async function prepare(
  graph: any,
  scenarioDsl: string,
  paramFile: any,
): Promise<PreparedAnalysisComputeReady> {
  return await prepareAnalysisComputeInputs({
    mode: 'custom',
    graph: graph,
    analysisType: 'bridge_view',
    analyticsDsl: 'from(a).to(b)',
    currentDSL: '',
    needsSnapshots: false,
    customScenarios: [{
      scenario_id: 'scenario-1',
      name: 'Scenario 1',
      colour: '#3b82f6',
      visibility_mode: 'f+e',
      graph: graph,
      effective_dsl: scenarioDsl,
    }],
    hiddenScenarioIds: [],
    frozenWhatIfDsl: null,
    resolveParameterFile: (paramId: string) => (
      paramId === PARAM_ID ? paramFile : undefined
    ),
  }) as PreparedAnalysisComputeReady;
}

describe('Per-scenario model_vars derivation (Stage 4(a)) — analytic preservation', () => {
  it('preserves the analytic source-layer entry when bayesian is projected from the slice', async () => {
    const graph = makeGraph({ withAnalyticEntry: true });
    const prepared = await prepare(graph, 'window()', paramFileWithTwoContexts());

    const edge = (prepared.scenarios[0].graph as any).edges[0];

    // Sentinel: the analytic model_vars entry was on the input graph and
    // must survive the per-scenario contexting step. Stage 4(a) writes
    // the bayesian projection alongside the existing analytic ledger.
    const analytic = (edge.p.model_vars ?? []).find(
      (e: any) => e.source === 'analytic',
    );
    expect(analytic, 'analytic model_vars entry must survive contexting').toBeDefined();
    expect(analytic.probability.mean).toBe(0.27);
    expect(analytic.probability.alpha).toBe(27);
    expect(analytic.probability.beta).toBe(73);
    expect(analytic.latency.mu).toBe(1.7);

    // The bayesian projection landed too — confirms the contexting step
    // ran, so the survival above is meaningful (not just because nothing
    // happened).
    expect(edge.p.posterior).toBeDefined();
    expect(edge.p.posterior.alpha).toBe(30);
    expect(edge.p.posterior.beta).toBe(90);
  });
});

describe('Per-scenario model_vars derivation (Stage 4(a)) — no cross-context bayesian fallback', () => {
  it('does NOT borrow a bayesian slice from a different context when the requested DSL has no match', async () => {
    // Request a context-scoped DSL when the param file only has `window()`.
    // The contexting step must NOT silently project the `window()` slice.
    const graph = makeGraph({ withAnalyticEntry: true });
    const prepared = await prepare(
      graph,
      'context(channel:google).window()',
      paramFileWithOnlyDefaultContext(),
    );

    const edge = (prepared.scenarios[0].graph as any).edges[0];

    // Sentinel: no posterior projection should have happened — the
    // requested context has no matching slice, and cross-context
    // fallback would re-introduce the multi-context leakage that
    // Stage 4(a) closes.
    if (edge.p.posterior !== undefined) {
      // If a posterior block exists on the request graph, it must NOT
      // carry the default-context Beta shape. (Some implementations
      // initialise an empty posterior object; that's acceptable, but
      // it must not be populated with the wrong slice's values.)
      expect(edge.p.posterior.alpha).not.toBe(30);
      expect(edge.p.posterior.beta).not.toBe(90);
    }

    // The bayesian model_vars entry (if any) likewise must not carry
    // the default slice's values for a non-matching context.
    const bayesian = (edge.p.model_vars ?? []).find(
      (e: any) => e.source === 'bayesian',
    );
    if (bayesian !== undefined) {
      expect(bayesian.probability?.alpha).not.toBe(30);
    }
  });

  it('projects the matching context-scoped slice when the parameter file has one', async () => {
    // Sanity: when the param file DOES have a matching context slice,
    // the projection picks it (not the default `window()` slice).
    const graph = makeGraph({ withAnalyticEntry: true });
    const prepared = await prepare(
      graph,
      'context(channel:google).window()',
      paramFileWithTwoContexts(),
    );

    const edge = (prepared.scenarios[0].graph as any).edges[0];
    expect(edge.p.posterior).toBeDefined();
    // The channel-scoped slice's values, not the default window's.
    expect(edge.p.posterior.alpha).toBe(80);
    expect(edge.p.posterior.beta).toBe(20);
  });
});
