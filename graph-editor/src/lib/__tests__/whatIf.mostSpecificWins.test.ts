import { describe, it, expect } from 'vitest';
import { computeEffectiveEdgeProbability } from '../whatIf';

describe('whatIf.computeEffectiveEdgeProbability - most specific wins (Phase 6)', () => {
  it('prefers the more specific matching conditional when multiple match (visited+exclude beats visited)', () => {
    const graph: any = {
      nodes: [],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          p: { mean: 0.9 },
          conditional_p: [
            // Less specific first (order should no longer matter)
            { condition: 'visited(a)', p: { mean: 0.2 } },
            { condition: 'visited(a).exclude(b)', p: { mean: 0.1 } },
          ],
        },
      ],
    };

    const prob = computeEffectiveEdgeProbability(graph, 'e1', { whatIfDSL: null }, new Set(['a']));
    expect(prob).toBeCloseTo(0.1, 10);
  });

  it('prefers visited() over a broader visitedAny() when both match', () => {
    const graph: any = {
      nodes: [],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          p: { mean: 0.9 },
          conditional_p: [
            // Broader first
            { condition: 'visitedAny(a,b,c)', p: { mean: 0.3 } },
            { condition: 'visited(a)', p: { mean: 0.2 } },
          ],
        },
      ],
    };

    const prob = computeEffectiveEdgeProbability(graph, 'e1', { whatIfDSL: null }, new Set(['a']));
    expect(prob).toBeCloseTo(0.2, 10);
  });
});


