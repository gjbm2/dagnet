import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { GraphData, GraphNode, GraphEdge } from '../../types';

vi.mock('../useQuerySelectionUuids', () => ({
  querySelectionUuids: () => ({
    selectedNodeUuids: ['node-1', 'node-2'],
    selectedEdgeUuids: ['edge-1'],
  }),
}));

import { useRemoveOverrides } from '../useRemoveOverrides';

function createGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphData {
  return {
    nodes,
    edges,
    policies: { default_outcome: 'success' } as any,
    metadata: { version: '1.0.0', created_at: '1-Dec-25' } as any,
  } as any;
}

describe('useRemoveOverrides (multi-selection)', () => {
  it('clears overrides across selected nodes and edges in one update', () => {
    const nodes: GraphNode[] = [
      { uuid: 'node-1', label_overridden: true } as any,
      { uuid: 'node-2', description_overridden: true } as any,
    ];
    const edges: GraphEdge[] = [
      { uuid: 'edge-1', description_overridden: true } as any,
    ];
    const graph = createGraph(nodes, edges);
    const onUpdateGraph = vi.fn();

    const { result } = renderHook(() =>
      useRemoveOverrides(graph, onUpdateGraph, 'node-1', null, { includeMultiSelection: true })
    );

    expect(result.current.hasOverrides).toBe(true);

    act(() => {
      result.current.removeOverrides();
    });

    expect(onUpdateGraph).toHaveBeenCalledTimes(1);
    const nextGraph = onUpdateGraph.mock.calls[0][0] as GraphData;
    expect(nextGraph.nodes.find(n => n.uuid === 'node-1')?.label_overridden).toBeUndefined();
    expect(nextGraph.nodes.find(n => n.uuid === 'node-2')?.description_overridden).toBeUndefined();
    expect(nextGraph.edges.find(e => e.uuid === 'edge-1')?.description_overridden).toBeUndefined();
  });
});




