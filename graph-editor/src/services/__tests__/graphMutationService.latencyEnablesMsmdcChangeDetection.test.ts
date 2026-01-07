import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph } from '../../types';

// Prevent actual MSMDC/HTTP work; we only care that the change is classified as topology-relevant.
vi.mock('../queryRegenerationService', () => ({
  queryRegenerationService: {
    regenerateQueries: vi.fn().mockResolvedValue({ parameters: [], anchors: {} }),
  },
}));

import { sessionLogService } from '../sessionLogService';
import { graphMutationService } from '../graphMutationService';

function makeGraph(params: { latencyEnabled: boolean; conditionalLatencyEnabled?: boolean }): Graph {
  return {
    nodes: [
      { uuid: 'A', id: 'A', label: 'A', absorbing: false, layout: { x: 0, y: 0 } } as any,
      { uuid: 'B', id: 'B', label: 'B', absorbing: false, layout: { x: 100, y: 0 } } as any,
    ],
    edges: [
      {
        uuid: 'E',
        id: 'A-to-B',
        from: 'A',
        to: 'B',
        p: {
          id: 'param-a-b',
          latency: { latency_parameter: params.latencyEnabled },
        },
        conditional_p:
          typeof params.conditionalLatencyEnabled === 'boolean'
            ? [
                {
                  condition: 'visited(x)',
                  p: {
                    id: 'cond-param-0',
                    latency: { latency_parameter: params.conditionalLatencyEnabled },
                  },
                },
              ]
            : undefined,
      } as any,
    ],
    policies: {},
    metadata: {},
  } as any;
}

describe('graphMutationService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('treats latency_parameter false→true as topology-relevant (should not short-circuit regeneration)', async () => {
    const oldGraph = makeGraph({ latencyEnabled: false });
    const newGraph = makeGraph({ latencyEnabled: true });

    const calls: Array<{ nodes: number; edges: number }> = [];
    const setGraph = (g: any) => {
      if (g) calls.push({ nodes: g.nodes?.length ?? 0, edges: g.edges?.length ?? 0 });
    };

    const infoSpy = vi.spyOn(sessionLogService, 'info');

    await graphMutationService.updateGraph(oldGraph, newGraph, setGraph as any);

    // updateGraph always applies the new graph immediately
    expect(calls[0]).toEqual({ nodes: 2, edges: 1 });

    // The key assertion: topology changes are logged to session log; data-only changes are not.
    expect(infoSpy).toHaveBeenCalledWith(
      'graph',
      'GRAPH_LATENCY_EDGE_ENABLED',
      'Latency enabled on edge',
      undefined
    );
  });

  it('treats conditional_p latency_parameter false→true as topology-relevant (should not short-circuit regeneration)', async () => {
    const oldGraph = makeGraph({ latencyEnabled: false, conditionalLatencyEnabled: false });
    const newGraph = makeGraph({ latencyEnabled: false, conditionalLatencyEnabled: true });

    const infoSpy = vi.spyOn(sessionLogService, 'info');

    await graphMutationService.updateGraph(oldGraph, newGraph, (() => {}) as any);

    expect(infoSpy).toHaveBeenCalledWith(
      'graph',
      'GRAPH_CONDITIONAL_LATENCY_EDGE_ENABLED',
      'Latency enabled on conditional probability',
      undefined
    );
  });
});


