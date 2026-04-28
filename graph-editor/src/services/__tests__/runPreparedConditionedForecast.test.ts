/**
 * Blind dispatch test for conditioned_forecast through runPreparedAnalysis.
 *
 * Doc 73e §8.3 Stage 2 / 73b §7.1: read-only conditioned_forecast must
 * route through the prepared-analysis dispatch surface. The dispatcher
 * has to:
 *   - POST to /api/forecast/conditioned (not /api/runner/analyze);
 *   - forward `prepared.displaySettings` as `display_settings` so
 *     compute-affecting display values (e.g. axis_tau_max) reach the BE
 *     uniformly across FE and CLI;
 *   - preserve scenario_id, effective_query_dsl, candidate_regimes_by_edge,
 *     and analytics_dsl per scenario;
 *   - send the prepared graph as-is, without a second engorgement pass —
 *     the prep service has already cloned and engorged the request graph
 *     via recontextScenarioGraph, so a second clone-and-re-engorge would
 *     either duplicate work or, in callers without a parameter-file
 *     resolver, strip the engorgement entirely.
 *
 * Today the CLI bypasses runPreparedAnalysis for conditioned_forecast and
 * hand-rolls the payload, so this test fails against current code on at
 * least the URL, display_settings forwarding, and reference-identity
 * assertions.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';

function makePreparedGraph() {
  return {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'middle', type: 'state' },
    ],
    edges: [
      {
        uuid: 'edge-1',
        from_node: 'start',
        to_node: 'middle',
        p: {
          id: 'param-start-middle',
          mean: 0.4,
          // _posteriorSlices was attached by recontextScenarioGraph.
          _posteriorSlices: { slices: { 'window()': { alpha: 1, beta: 1 } } },
        },
        // _bayes_evidence / _bayes_priors were attached by
        // recontextScenarioGraph during prep — they must travel through
        // the dispatcher unchanged.
        _bayes_evidence: { y: 40, n: 100 },
        _bayes_priors: { prob_alpha: 1, prob_beta: 1 },
      },
    ],
  };
}

function makePrepared(overrides: Partial<PreparedAnalysisComputeReady> = {}): PreparedAnalysisComputeReady {
  const graph = makePreparedGraph();
  return {
    status: 'ready',
    analysisType: 'conditioned_forecast',
    analyticsDsl: 'from(start).to(middle)',
    scenarios: [
      {
        scenario_id: 'scenario-1',
        name: 'Scenario 1',
        colour: '#3b82f6',
        visibility_mode: 'f+e',
        graph: graph as any,
        effective_query_dsl: 'window(1-Jan-26:10-Jan-26)',
        candidate_regimes_by_edge: {
          'edge-1': [{ core_hash: 'h1', equivalent_hashes: ['h1'] }],
        },
      },
    ],
    signature: 'test-signature',
    displaySettings: { axis_tau_max: 30, chart_setting: 'value' },
    meceDimensions: [],
    ...overrides,
  };
}

describe('runPreparedAnalysis(conditioned_forecast)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: { analysis_type: 'conditioned_forecast', data: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    // Bypass the in-process analysis cache so repeated runs in the suite
    // do not collide.
    (globalThis as any).__dagnetComputeNoCache = true;
  });

  it('dispatches to /api/forecast/conditioned with display_settings, scenario fields, and the prepared graph engorgement intact', async () => {
    const prepared = makePrepared();

    await runPreparedAnalysis(prepared);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/forecast\/conditioned(?:\?|$)/);

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.analytics_dsl).toBe('from(start).to(middle)');
    expect(body.display_settings).toEqual({ axis_tau_max: 30, chart_setting: 'value' });

    expect(Array.isArray(body.scenarios)).toBe(true);
    expect(body.scenarios.length).toBe(1);
    const sc = body.scenarios[0];
    expect(sc.scenario_id).toBe('scenario-1');
    expect(sc.effective_query_dsl).toBe('window(1-Jan-26:10-Jan-26)');
    expect(sc.candidate_regimes_by_edge).toEqual({
      'edge-1': [{ core_hash: 'h1', equivalent_hashes: ['h1'] }],
    });

    // The prepared graph carries _bayes_evidence, _bayes_priors, and
    // p._posteriorSlices already (engorged in prep). The dispatcher must
    // not call buildConditionedForecastGraphSnapshot a second time on a
    // transport-ready graph: that would, in callers without a
    // resolveParameterFile, strip the engorgement without re-attaching it,
    // breaking BE evidence binding.
    expect(sc.graph.edges[0]._bayes_evidence).toEqual({ y: 40, n: 100 });
    expect(sc.graph.edges[0]._bayes_priors).toEqual({ prob_alpha: 1, prob_beta: 1 });
    expect(sc.graph.edges[0].p._posteriorSlices).toBeDefined();
  });
});
