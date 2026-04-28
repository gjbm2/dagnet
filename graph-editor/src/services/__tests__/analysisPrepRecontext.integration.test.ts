/**
 * Analysis-prep per-scenario re-contexting + engorgement —
 * doc 73b §3.2a, Stage 4(a)/4(b) integration.
 *
 * Pins the wiring between `prepareAnalysisComputeInputs` and the shared
 * slice helper: when `resolveParameterFile` is supplied, scenario graphs
 * (a) carry per-DSL `p.posterior.*` projected from the parameter file's
 * `posterior.slices` library, and (b) carry the transient engorgement
 * fields BE consumers expect (`_posteriorSlices`, `_bayes_evidence`,
 * `_bayes_priors`).
 *
 * This is the post-Stage-4(b) replacement for the persistent Flow G
 * stash mechanism. Without this contract the BE forecast pipeline
 * (e.g. `epistemic_bands.py:148`) would lose its data source.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareAnalysisComputeInputs,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';

const PARAM_ID = 'edge-1-param';

function makeParameterFile() {
  return {
    posterior: {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-current',
      hdi_level: 0.9,
      prior_tier: 'direct_history',
      slices: {
        'window()': {
          alpha: 42,
          beta: 118,
          p_hdi_lower: 0.22,
          p_hdi_upper: 0.32,
          mu_mean: 1.85,
          mu_sd: 0.05,
          sigma_mean: 0.32,
          sigma_sd: 0.02,
          onset_mean: 5.1,
          onset_sd: 0.7,
          ess: 1100,
          rhat: 1.003,
          divergences: 0,
          evidence_grade: 3,
          provenance: 'bayesian',
        },
        'cohort()': {
          alpha: 36,
          beta: 110,
          p_hdi_lower: 0.2,
          p_hdi_upper: 0.31,
          mu_mean: 2.4,
          mu_sd: 0.05,
          sigma_mean: 0.31,
          sigma_sd: 0.02,
          onset_mean: 5.0,
          onset_sd: 0.7,
          ess: 1100,
          rhat: 1.003,
          divergences: 0,
          evidence_grade: 3,
          provenance: 'bayesian',
        },
      },
      fit_history: [
        {
          fitted_at: '15-Jan-26',
          fingerprint: 'fp-jan15',
          slices: { 'window()': { alpha: 30, beta: 90 } },
        },
      ],
    },
    values: [
      { sliceDSL: 'window()', n: 200, k: 50, mean: 0.25, stdev: 0.03 },
    ],
  };
}

function makeGraph() {
  return {
    nodes: [
      { uuid: 'n1', id: 'a', entry: { is_start: true } },
      { uuid: 'n2', id: 'b', absorbing: true },
    ],
    edges: [
      {
        uuid: 'e1',
        id: 'e1',
        from: 'n1',
        to: 'n2',
        p: { id: PARAM_ID, mean: 0.25, type: 'probability' },
      },
    ],
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
  };
}

describe('prepareAnalysisComputeInputs — per-scenario re-context (Stage 4(a))', () => {
  it('re-projects p.posterior.* from the parameter file when resolveParameterFile is supplied', async () => {
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: makeGraph() as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: '',
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'scenario-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: makeGraph() as any,
        effective_dsl: 'window(1-Jan-26:31-Jan-26)',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile: (paramId: string) => (
        paramId === PARAM_ID ? makeParameterFile() : undefined
      ),
    }) as PreparedAnalysisComputeReady;

    expect(prepared.status).toBe('ready');
    const edge = (prepared.scenarios[0].graph as any).edges[0];

    // In-schema contexting: p.posterior.* projected from window() slice.
    expect(edge.p.posterior).toBeDefined();
    expect(edge.p.posterior.alpha).toBe(42);
    expect(edge.p.posterior.beta).toBe(118);

    // Latency posterior projected from window() slice.
    expect(edge.p.latency.posterior).toBeDefined();
    expect(edge.p.latency.posterior.mu_mean).toBe(1.85);
  });

  it('attaches engorgement fields (_posteriorSlices, _bayes_evidence, _bayes_priors)', async () => {
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: makeGraph() as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: '',
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'scenario-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: makeGraph() as any,
        effective_dsl: 'window(1-Jan-26:31-Jan-26)',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile: (paramId: string) => (
        paramId === PARAM_ID ? makeParameterFile() : undefined
      ),
    }) as PreparedAnalysisComputeReady;

    const edge = (prepared.scenarios[0].graph as any).edges[0];

    // Engorgement attaches the multi-context slice library on the
    // request-graph copy so epistemic_bands.py:148 still functions
    // without the persistent Flow G stash.
    expect(edge.p._posteriorSlices).toBeDefined();
    expect(edge.p._posteriorSlices.slices['window()']).toBeDefined();
    expect(edge.p._posteriorSlices.fit_history).toBeDefined();
    expect(edge.p._posteriorSlices.fit_history[0].fingerprint).toBe('fp-jan15');

    // Bayes evidence / priors engorgement (existing contract, doc 14 §9A).
    expect(edge._bayes_evidence).toBeDefined();
    expect(edge._bayes_priors).toBeDefined();
  });

  it('does NOT mutate the caller-supplied scenario.graph in custom f+e mode (73e §8.3 Stage 1)', async () => {
    // Mutation-isolation guard: per 73e §8.3 Stage 1 / 73b §3.2, the custom-mode
    // path that aliases `scenario.graph` directly into `scenarioGraph` must
    // clone before any visibility projection / re-contexting / engorgement.
    // The f+e branch of `applyProbabilityVisibilityModeToGraph` historically
    // returned the input reference unchanged, which let `recontextScenarioGraph`
    // engorge `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors` onto
    // the live editor graph. This test pins the isolation invariant.
    const callerScenarioGraph: any = makeGraph();

    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: makeGraph() as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: '',
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'scenario-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: callerScenarioGraph,
        effective_dsl: 'window(1-Jan-26:31-Jan-26)',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      resolveParameterFile: (paramId: string) => (
        paramId === PARAM_ID ? makeParameterFile() : undefined
      ),
    }) as PreparedAnalysisComputeReady;

    expect(prepared.status).toBe('ready');
    const preparedEdge = (prepared.scenarios[0].graph as any).edges[0];
    const callerEdge = callerScenarioGraph.edges[0];

    // Identity: the prepared graph must be a distinct object from the caller's.
    expect(prepared.scenarios[0].graph).not.toBe(callerScenarioGraph);
    expect(preparedEdge).not.toBe(callerEdge);

    // Engorgement fields appear ONLY on the prepared (request) graph.
    expect(preparedEdge._bayes_evidence).toBeDefined();
    expect(preparedEdge._bayes_priors).toBeDefined();
    expect(preparedEdge.p._posteriorSlices).toBeDefined();

    expect(callerEdge._bayes_evidence).toBeUndefined();
    expect(callerEdge._bayes_priors).toBeUndefined();
    expect(callerEdge.p._posteriorSlices).toBeUndefined();

    // In-schema projection must not have leaked onto the caller graph either:
    // the input had no `posterior` and `latency.posterior`, the prepared graph
    // gains them, but the caller's input graph stays clean.
    expect(preparedEdge.p.posterior).toBeDefined();
    expect(callerEdge.p.posterior).toBeUndefined();
    expect(callerEdge.p.latency?.posterior).toBeUndefined();
  });

  it('produces a no-op for the request graph when resolveParameterFile is omitted', async () => {
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: makeGraph() as any,
      analysisType: 'bridge_view',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: '',
      needsSnapshots: false,
      customScenarios: [{
        scenario_id: 'scenario-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: makeGraph() as any,
        effective_dsl: 'window(1-Jan-26:31-Jan-26)',
      }],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
      // resolveParameterFile intentionally absent.
    }) as PreparedAnalysisComputeReady;

    expect(prepared.status).toBe('ready');
    const edge = (prepared.scenarios[0].graph as any).edges[0];
    // Without a resolver, the helper is a no-op; the input edge has no
    // posterior so the result has none either.
    expect(edge.p.posterior).toBeUndefined();
    expect(edge.p._posteriorSlices).toBeUndefined();
    expect(edge._bayes_evidence).toBeUndefined();
    expect(edge._bayes_priors).toBeUndefined();
  });
});
