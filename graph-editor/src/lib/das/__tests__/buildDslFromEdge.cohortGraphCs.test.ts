/**
 * Graph-level cohort conversion window (cs) test
 *
 * Verifies that buildDslFromEdge uses a graph-level maximum latency horizon
 * (clamped) to set conversion_window_days, rather than per-edge path_t95.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { buildDslFromEdge } from '../buildDslFromEdge';

describe('buildDslFromEdge cohort conversion window uses graph max', () => {
  it('sets conversion_window_days to ceil(max(path_t95/t95)) with 90d clamp', async () => {
    const graph: any = {
      nodes: [
        { id: 'A', uuid: 'A', event_id: 'a' },
        { id: 'B', uuid: 'B', event_id: 'b' },
        { id: 'C', uuid: 'C', event_id: 'c' },
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { latency: { anchor_node_id: 'A', path_t95: 12, t95: 10 } },
        },
        {
          id: 'e2',
          uuid: 'e2',
          from: 'B',
          to: 'C',
          p: { latency: { anchor_node_id: 'A', path_t95: 40, t95: 18 } },
        },
      ],
    };

    const edge: any = {
      id: 'e1',
      uuid: 'e1',
      from: 'A',
      to: 'B',
      query: 'from(A).to(B)',
      p: { latency: { anchor_node_id: 'A', path_t95: 12, t95: 10 } },
    };

    const res = await buildDslFromEdge(edge, graph, 'amplitude', async () => ({ id: 'x', provider_event_names: {} }), {
      cohort: { start: '1-Nov-25', end: '14-Nov-25' },
      window: null,
      context: [],
      contextAny: [],
      cases: [],
      visited: [],
      visitedAny: [],
      exclude: [],
    } as any);

    expect(res.queryPayload.cohort?.conversion_window_days).toBe(40);
  });
});


