/**
 * Strict evidence/forecast probability basis for analysis graphs.
 *
 * Rule: If UI says "Evidence Probability", we must ONLY use evidence-derived values.
 * Residual allocation within a sibling group is allowed (still evidence-derived).
 */
import { describe, expect, it } from 'vitest';
import { buildGraphForAnalysisLayer } from '../CompositionService';
import type { Graph } from '../../types';
import type { ScenarioParams } from '../../types/scenarios';

function makeGraph(p: any): Graph {
  return {
    nodes: [{ id: 'A', entry: { is_start: true } } as any, { id: 'B' } as any],
    edges: [{ id: 'A->B', from: 'A', to: 'B', p } as any],
  } as any;
}

describe('buildGraphForAnalysisLayer: strict Evidence Probability (no fallback)', () => {
  const baseParams: ScenarioParams = { edges: {}, nodes: {} };
  const currentParams: ScenarioParams = { edges: {}, nodes: {} };

  it('uses p.evidence.mean when visibilityMode is e', () => {
    const graph = makeGraph({
      mean: 0.9,
      forecast: { mean: 0.8 },
      evidence: { mean: 0.12, n: 100, k: 12 },
    });

    const out = buildGraphForAnalysisLayer(
      'current',
      graph,
      baseParams,
      currentParams,
      [],
      undefined,
      'e'
    );

    expect(out.edges?.[0]?.p?.mean).toBe(0.12);
  });

  it('derives missing sibling evidence via residual allocation when at least one sibling has explicit evidence', () => {
    const graph: Graph = {
      nodes: [{ id: 'S', entry: { is_start: true } } as any, { id: 'A' } as any, { id: 'B' } as any],
      edges: [
        // Explicit evidence for A
        { id: 'S->A', from: 'S', to: 'A', p: { mean: 0.7, evidence: { mean: 0.6 } } } as any,
        // No evidence for B; should receive residual 1 - 0.6 = 0.4 in E mode
        { id: 'S->B', from: 'S', to: 'B', p: { mean: 0.3 } } as any,
      ],
    } as any;

    const out = buildGraphForAnalysisLayer('current', graph, baseParams, currentParams, [], undefined, 'e');
    const byId = new Map(out.edges!.map((e: any) => [e.id, e]));

    expect(byId.get('S->A')?.p?.mean).toBeCloseTo(0.6, 10);
    expect(byId.get('S->B')?.p?.mean).toBeCloseTo(0.4, 10);
  });
});



