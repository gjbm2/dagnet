/**
 * Share-restore posterior rehydration — doc 73b §8 Stage 4(a) extension /
 * doc 73d.
 *
 * Plan §8(a) "Share-bundle / share-chart hydration coverage": the
 * `useShareBundleFromUrl` / `useShareChartFromUrl` hooks restore
 * graph-level `baseDSL` / `currentQueryDSL` from the share payload
 * but do not themselves re-project edge posteriors. After Stage 4(b)
 * removed the persistent `_posteriorSlices` stash, the re-projection
 * happens at analysis-prep time via `posteriorSliceContexting`,
 * reading slices directly from the parameter file.
 *
 * 73d sentinel: a saved share whose `currentQueryDSL` selects a
 * non-default slice — after restore, `analysisComputePreparationService`
 * invokes the parameter-file-backed re-projection and the request graph
 * carries the slice that matches `currentQueryDSL`, not the live-edge
 * load-time slice. Without this, the share-restore dependency on the
 * parameter-file-backed re-projection (Stage 4(a)) can rot silently.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareAnalysisComputeInputs,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';

const PARAM_ID = 'edge-1-param';

const DEFAULT_SLICE = { alpha: 30, beta: 90, mu_mean: 1.5, sigma_mean: 0.3, onset_mean: 4.0,
  ess: 1100, rhat: 1.003, divergences: 0, evidence_grade: 3, provenance: 'bayesian' };
const SHARE_DSL_SLICE = { alpha: 80, beta: 20, mu_mean: 2.5, sigma_mean: 0.5, onset_mean: 6.0,
  ess: 1100, rhat: 1.003, divergences: 0, evidence_grade: 3, provenance: 'bayesian' };

function paramFile() {
  return {
    posterior: {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-current',
      hdi_level: 0.9,
      slices: {
        'window()': DEFAULT_SLICE,
        'context(channel:google).window()': SHARE_DSL_SLICE,
      },
    },
    values: [{ sliceDSL: 'window()', n: 200, k: 50, mean: 0.25, stdev: 0.03 }],
  };
}

/**
 * Post-Stage-4(b) world: the live edge has NO `_posteriorSlices`
 * stash on `edge.p`. The shared helper must source the slice library
 * from the parameter file via `resolveParameterFile`, NOT from the
 * persistent stash.
 *
 * The edge's `p.posterior` carries the load-time `window()` projection
 * (whatever the canvas was looking at when the share was taken). The
 * share payload carried `currentQueryDSL = 'context(channel:google).window()'`,
 * and the share hooks restored that DSL at the graph level. The
 * analysis-prep call below dispatches with the restored DSL.
 */
function makeRestoredGraph() {
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
          // Load-time `window()` projection — the share-restore must
          // overwrite this with the `currentQueryDSL` slice via the
          // rewired re-projection.
          posterior: { alpha: DEFAULT_SLICE.alpha, beta: DEFAULT_SLICE.beta },
          latency: { posterior: { mu_mean: DEFAULT_SLICE.mu_mean,
                                   sigma_mean: DEFAULT_SLICE.sigma_mean } },
          // Sentinel discipline: NO `_posteriorSlices` stash on the
          // edge. Stage 4(b) removed that persistent field; the shared
          // helper must read from the parameter file instead.
        },
      },
    ],
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
    // Share hook restored these graph-level DSLs from the bundle.
    baseDSL: 'window()',
    currentQueryDSL: 'context(channel:google).window()',
  };
}

const resolveParameterFile = (paramId: string) => (
  paramId === PARAM_ID ? paramFile() : undefined
);

describe('Share-restore posterior rehydration (Stage 4(a) extension)', () => {
  it('produces a request graph contexted to the restored currentQueryDSL slice (sentinel)', async () => {
    const restored = makeRestoredGraph();
    expect((restored.edges[0].p as any)._posteriorSlices,
      'pre-condition: no persistent _posteriorSlices on edge'
    ).toBeUndefined();

    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: restored as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      // The share hooks restored currentQueryDSL; the analysis-prep
      // dispatch follows it.
      currentDSL: restored.currentQueryDSL,
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'restored-current',
        name: 'Restored',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: restored as any,
        effective_dsl: restored.currentQueryDSL,
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile,
    }) as PreparedAnalysisComputeReady;

    expect(prepared.status).toBe('ready');
    const edge = (prepared.scenarios[0].graph as any).edges[0];

    // Sentinel: request graph carries the share-DSL slice values, NOT
    // the live-edge load-time slice. Without the Stage 4(b) rewiring,
    // this would either fail (no stash to read from) or silently
    // return stale (load-time) values.
    expect(edge.p.posterior).toBeDefined();
    expect(edge.p.posterior.alpha).toBe(SHARE_DSL_SLICE.alpha);
    expect(edge.p.posterior.beta).toBe(SHARE_DSL_SLICE.beta);
    expect(edge.p.posterior.alpha).not.toBe(DEFAULT_SLICE.alpha);

    expect(edge.p.latency.posterior.mu_mean).toBe(SHARE_DSL_SLICE.mu_mean);
    expect(edge.p.latency.posterior.mu_mean).not.toBe(DEFAULT_SLICE.mu_mean);

    // Engorgement also rehydrates: the slice library on the request
    // graph comes from the parameter file via the shared helper, not
    // the (now-removed) persistent stash.
    expect(edge.p._posteriorSlices).toBeDefined();
    expect(edge.p._posteriorSlices.slices).toBeDefined();
    expect(
      Object.keys(edge.p._posteriorSlices.slices).sort(),
    ).toEqual(['context(channel:google).window()', 'window()']);
  });

  it('would have failed if the shared helper read the (absent) persistent stash', async () => {
    // Negative form of the same sentinel: the load-time slice on the
    // edge is `window()` (alpha=30). If the rewiring had been skipped,
    // the request graph would either keep that load-time value or
    // produce nothing. The earlier test asserts the positive case;
    // here we assert that under the spec the edge's load-time
    // projection MUST be overwritten by the rewired re-projection.
    const restored = makeRestoredGraph();
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: restored as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: restored.currentQueryDSL,
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'restored-current',
        name: 'Restored',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: restored as any,
        effective_dsl: restored.currentQueryDSL,
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile,
    }) as PreparedAnalysisComputeReady;

    const edge = (prepared.scenarios[0].graph as any).edges[0];
    // The load-time window() values are NOT what the request graph
    // ends up carrying. This is the rotting-silently guard.
    expect(edge.p.posterior.alpha).not.toBe(DEFAULT_SLICE.alpha);
    expect(edge.p.posterior.beta).not.toBe(DEFAULT_SLICE.beta);
  });
});
