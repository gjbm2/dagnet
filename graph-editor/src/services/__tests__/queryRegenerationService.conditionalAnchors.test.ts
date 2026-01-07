import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../types';
import { QueryRegenerationService } from '../queryRegenerationService';
import { fileRegistry } from '../../contexts/TabContext';

describe('QueryRegenerationService - conditional_p anchor propagation (Phase 4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('copies edge anchor_node_id onto conditional_p[i].p.latency.anchor_node_id when not overridden', async () => {
    const svc = new QueryRegenerationService();

    const graph: Graph = {
      nodes: [],
      edges: [
        {
          uuid: 'edge-1',
          id: 'edge-1',
          from: 'a',
          to: 'b',
          p: { id: 'base-param', latency: { latency_parameter: true } },
          conditional_p: [
            { condition: 'visited(x)', p: { id: 'cond-param-0', latency: { latency_parameter: true } }, query: 'from(a).to(b).visited(x)' },
            { condition: 'visited(y)', p: { id: 'cond-param-1', latency: { latency_parameter: true, anchor_node_id_overridden: true, anchor_node_id: 'manual' } }, query: 'from(a).to(b).visited(y)' },
          ],
        } as any,
      ],
    } as any;

    // No parameter files loaded; we only verify graph mutation behaviour.
    vi.spyOn(fileRegistry, 'getFile').mockReturnValue(null as any);

    const res = await svc.applyRegeneratedQueries(graph, [], { 'edge-1': 'start-node' });

    expect(res.graphUpdates).toBeGreaterThan(0);
    const edge: any = graph.edges?.[0];
    expect(edge.p.latency.anchor_node_id).toBe('start-node');
    expect(edge.conditional_p[0].p.latency.anchor_node_id).toBe('start-node');
    // Overridden conditional anchor should be preserved
    expect(edge.conditional_p[1].p.latency.anchor_node_id).toBe('manual');
  });
});


