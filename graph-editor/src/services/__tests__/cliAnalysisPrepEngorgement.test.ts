/**
 * CLI analysis-prep engorgement parity — doc 73b §8 Stage 4(a) CLI
 * subtask / doc 73d.
 *
 * Plan §8(a) CLI subtask (binding for doc 73a Stage 6 parity): the
 * contexting + engorgement step must be wired into the CLI's
 * analysis-prep code path, not just the FE. Today the CLI loads
 * graphs through `graph-editor/src/cli/aggregate.ts` /
 * `graph-editor/src/cli/commands/analyse.ts` and shares
 * `analysisComputePreparationService` with the FE; that sharing IS
 * the binding contract — both must call the slice helper with the
 * scenario's effective DSL before dispatching to the BE. Without this,
 * CLI requests go out with stale slices and doc 73a Stage 6's CLI/FE
 * parity gate fails.
 *
 * 73d sentinel: CLI request payload contains the contexted slice for
 * the scenario's DSL, not the live-edge load-time slice.
 *
 * Apparatus: the CLI calls the same exported `prepareAnalysisComputeInputs`
 * function. This test exercises the binding contract directly: when
 * the live edge carries one slice's projection (mimicking load-time
 * contexting at currentDSL = `window()`) and the scenario is dispatched
 * with a different effective DSL (`context(channel:google).window()`),
 * the prepared request graph must carry the scenario's DSL slice — not
 * the live edge's load-time slice.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareAnalysisComputeInputs,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';

const PARAM_ID = 'edge-1-param';

const LIVE_LOAD_TIME_SLICE = { alpha: 30, beta: 90, mu_mean: 1.5, sigma_mean: 0.3, onset_mean: 4.0,
  ess: 1100, rhat: 1.003, divergences: 0, evidence_grade: 3, provenance: 'bayesian' };
const SCENARIO_DSL_SLICE = { alpha: 80, beta: 20, mu_mean: 2.5, sigma_mean: 0.5, onset_mean: 6.0,
  ess: 1100, rhat: 1.003, divergences: 0, evidence_grade: 3, provenance: 'bayesian' };

function paramFile() {
  return {
    posterior: {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-current',
      hdi_level: 0.9,
      slices: {
        'window()': LIVE_LOAD_TIME_SLICE,
        'context(channel:google).window()': SCENARIO_DSL_SLICE,
      },
      fit_history: [{ fitted_at: '15-Jan-26', fingerprint: 'fp-jan15',
        slices: { 'window()': { alpha: 25, beta: 75 } } }],
    },
    values: [{ sliceDSL: 'window()', n: 200, k: 50, mean: 0.25, stdev: 0.03 }],
  };
}

/**
 * Live edge as the user's canvas would have it: load-time `window()`
 * slice already projected onto `p.posterior.*`. The CLI does not
 * re-context the LIVE graph; the binding contract is that
 * analysis-prep produces a per-scenario request graph contexted to
 * the SCENARIO's effective DSL.
 */
function makeLiveGraph() {
  return {
    nodes: [
      { uuid: 'n1', id: 'a', entry: { is_start: true } },
      { uuid: 'n2', id: 'b', absorbing: true },
    ],
    edges: [
      {
        uuid: 'e1', id: 'e1', from: 'n1', to: 'n2',
        p: {
          id: PARAM_ID,
          mean: 0.25,
          type: 'probability',
          // Live edge load-time slice — `window()` values.
          posterior: {
            alpha: LIVE_LOAD_TIME_SLICE.alpha,
            beta: LIVE_LOAD_TIME_SLICE.beta,
          },
          latency: {
            posterior: {
              mu_mean: LIVE_LOAD_TIME_SLICE.mu_mean,
              sigma_mean: LIVE_LOAD_TIME_SLICE.sigma_mean,
            },
          },
        },
      },
    ],
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
  };
}

const resolveParameterFile = (paramId: string) => (
  paramId === PARAM_ID ? paramFile() : undefined
);

describe('CLI analysis-prep engorgement parity (Stage 4(a) CLI subtask)', () => {
  it('dispatches the scenario-DSL slice, NOT the live-edge load-time slice', async () => {
    // The CLI flow goes through prepareAnalysisComputeInputs (the
    // shared service that doc 73a Stage 6 parity binds to). The live
    // edge carries `window()` slice values; the scenario asks for
    // `context(channel:google).window()`. The request graph must
    // carry the scenario's slice.
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: makeLiveGraph() as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: 'window()',
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'cli-scenario',
        name: 'CLI Scenario',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: makeLiveGraph() as any,
        effective_dsl: 'context(channel:google).window()',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile,
    }) as PreparedAnalysisComputeReady;

    expect(prepared.status).toBe('ready');
    const edge = (prepared.scenarios[0].graph as any).edges[0];

    // Sentinel: the request graph carries the SCENARIO's slice values
    // (alpha=80, beta=20) — not the live-edge load-time slice
    // (alpha=30, beta=90).
    expect(edge.p.posterior).toBeDefined();
    expect(edge.p.posterior.alpha).toBe(SCENARIO_DSL_SLICE.alpha);
    expect(edge.p.posterior.beta).toBe(SCENARIO_DSL_SLICE.beta);
    expect(edge.p.posterior.alpha).not.toBe(LIVE_LOAD_TIME_SLICE.alpha);

    expect(edge.p.latency.posterior.mu_mean).toBe(SCENARIO_DSL_SLICE.mu_mean);
    expect(edge.p.latency.posterior.mu_mean).not.toBe(
      LIVE_LOAD_TIME_SLICE.mu_mean,
    );

    // Engorgement also lands so epistemic_bands.py-style consumers
    // get the slice library + fit_history without the persistent
    // Flow G stash.
    expect(edge.p._posteriorSlices).toBeDefined();
    expect(edge.p._posteriorSlices.slices).toBeDefined();
    expect(
      Object.keys(edge.p._posteriorSlices.slices).sort(),
    ).toEqual([
      'context(channel:google).window()',
      'window()',
    ]);
    expect(edge.p._posteriorSlices.fit_history?.[0]?.fingerprint).toBe(
      'fp-jan15',
    );
  });
});
