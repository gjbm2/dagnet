import { describe, it, expect } from 'vitest';
import { buildGraphForLayer, buildGraphForAnalysisLayer } from '../CompositionService';
import type { Graph } from '../../types';
import type { ScenarioParams } from '../../types/scenarios';

describe('CompositionService - analysis scenario isolation', () => {
  it('buildGraphForAnalysisLayer evaluates each scenario independently (adding a new scenario does not change prior scenario graph)', () => {
    const graph: Graph = {
      nodes: [],
      edges: [
        { id: 'edge-1', uuid: 'edge-1', from: 'A', to: 'B', p: { mean: 0.5 } } as any,
      ],
      metadata: {} as any,
    } as any;

    const baseParams: ScenarioParams = {
      edges: { 'edge-1': { p: { mean: 0.5 } } },
      nodes: {},
    };

    const currentParams: ScenarioParams = {
      edges: { 'edge-1': { p: { mean: 0.5 } } },
      nodes: {},
    };

    const scenarioA = { id: 'scenario-A', params: { edges: { 'edge-1': { p: { mean: 0.1 } } }, nodes: {} } };
    const scenarioB = { id: 'scenario-B', params: { edges: { 'edge-1': { p: { mean: 0.9 } } }, nodes: {} } };

    const graphA_alone = buildGraphForAnalysisLayer(
      'scenario-A',
      graph,
      baseParams,
      currentParams,
      [scenarioA],
      null
    );
    expect(graphA_alone.edges[0].p?.mean).toBe(0.1);

    // Now "add" scenario B to the scenarios list. A must still evaluate to 0.1 in analysis mode.
    const graphA_withBPresent = buildGraphForAnalysisLayer(
      'scenario-A',
      graph,
      baseParams,
      currentParams,
      [scenarioA, scenarioB],
      null
    );
    expect(graphA_withBPresent.edges[0].p?.mean).toBe(0.1);

    // Demonstrate why we need a special analysis builder:
    // buildGraphForLayer composes cumulatively when given a layer order, so scenario-B includes scenario-A.
    const graphB_cumulative = buildGraphForLayer(
      'scenario-B',
      graph,
      baseParams,
      currentParams,
      [scenarioA, scenarioB],
      ['scenario-A', 'scenario-B'],
      null
    );
    // scenario-B should see mean=0.9 (B overrides A), but it is still cumulative composition behaviour.
    expect(graphB_cumulative.edges[0].p?.mean).toBe(0.9);
  });
});


