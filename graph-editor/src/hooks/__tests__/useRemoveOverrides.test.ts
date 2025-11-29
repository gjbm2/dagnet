/**
 * Tests for useRemoveOverrides hook
 * 
 * Tests counting and clearing of override flags on nodes and edges.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoveOverrides, countNodeOverrides, countEdgeOverrides } from '../useRemoveOverrides';
import type { GraphData, GraphNode, GraphEdge } from '../../types';

// Helper to create a minimal test graph
const createTestGraph = (nodes: GraphNode[] = [], edges: GraphEdge[] = []): GraphData => ({
  nodes,
  edges,
  policies: {
    default_outcome: 'success'
  },
  metadata: {
    version: '1.0.0',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
  }
});

describe('countNodeOverrides', () => {
  it('returns 0 for undefined node', () => {
    expect(countNodeOverrides(undefined)).toBe(0);
  });

  it('returns 0 for node with no overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label: 'Test'
    };
    expect(countNodeOverrides(node)).toBe(0);
  });

  it('counts direct node overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label: 'Test',
      label_overridden: true,
      description_overridden: true,
      outcome_type_overridden: true
    };
    expect(countNodeOverrides(node)).toBe(3);
  });

  it('counts all node override types', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label_overridden: true,
      description_overridden: true,
      outcome_type_overridden: true,
      event_id_overridden: true,
      url_overridden: true,
      images_overridden: true
    };
    expect(countNodeOverrides(node)).toBe(6);
  });

  it('counts case status override', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      type: 'case',
      case: {
        id: 'case-1',
        status: 'active',
        status_overridden: true,
        variants: []
      }
    };
    expect(countNodeOverrides(node)).toBe(1);
  });

  it('counts variant overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      type: 'case',
      case: {
        id: 'case-1',
        status: 'active',
        variants: [
          { name: 'control', weight: 0.5, name_overridden: true, weight_overridden: true },
          { name: 'treatment', weight: 0.5, description_overridden: true }
        ]
      }
    };
    expect(countNodeOverrides(node)).toBe(3);
  });

  it('counts image caption overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      images: [
        { image_id: 'img-1', caption: 'Test', caption_overridden: true, file_extension: 'png' },
        { image_id: 'img-2', caption: 'Test2', caption_overridden: true, file_extension: 'png' }
      ]
    };
    expect(countNodeOverrides(node)).toBe(2);
  });
});

describe('countEdgeOverrides', () => {
  it('returns 0 for undefined edge', () => {
    expect(countEdgeOverrides(undefined)).toBe(0);
  });

  it('returns 0 for edge with no overrides', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b'
    };
    expect(countEdgeOverrides(edge)).toBe(0);
  });

  it('counts direct edge overrides', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      description_overridden: true,
      query_overridden: true
    };
    expect(countEdgeOverrides(edge)).toBe(2);
  });

  it('counts probability param overrides', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      p: {
        mean: 0.5,
        mean_overridden: true,
        stdev: 0.1,
        stdev_overridden: true,
        distribution: 'beta',
        distribution_overridden: true
      }
    };
    expect(countEdgeOverrides(edge)).toBe(3);
  });

  it('counts conditional probability overrides', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      conditional_p: [
        {
          condition: 'visited(node-x)',
          query_overridden: true,
          p: { mean: 0.7, mean_overridden: true }
        },
        {
          condition: 'visited(node-y)',
          p: { mean: 0.3, stdev_overridden: true }
        }
      ]
    };
    expect(countEdgeOverrides(edge)).toBe(3);
  });

  it('counts cost overrides', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      cost_gbp: { mean: 100, mean_overridden: true },
      cost_time: { mean: 5, stdev_overridden: true, distribution_overridden: true }
    };
    expect(countEdgeOverrides(edge)).toBe(3);
  });
});

describe('useRemoveOverrides', () => {
  it('returns 0 count for null graph', () => {
    const onUpdateGraph = vi.fn();
    const { result } = renderHook(() => useRemoveOverrides(null, onUpdateGraph, 'node-1', null));
    
    expect(result.current.overrideCount).toBe(0);
    expect(result.current.hasOverrides).toBe(false);
  });

  it('returns 0 count when no selection', () => {
    const graph = createTestGraph();
    const onUpdateGraph = vi.fn();
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, null, null));
    
    expect(result.current.overrideCount).toBe(0);
    expect(result.current.hasOverrides).toBe(false);
  });

  it('counts node overrides correctly', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label_overridden: true,
      description_overridden: true
    };
    const graph = createTestGraph([node]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'node-1', null));
    
    expect(result.current.overrideCount).toBe(2);
    expect(result.current.hasOverrides).toBe(true);
  });

  it('counts edge overrides correctly', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      p: { mean: 0.5, mean_overridden: true },
      query_overridden: true
    };
    const graph = createTestGraph([], [edge]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, null, 'edge-1'));
    
    expect(result.current.overrideCount).toBe(2);
    expect(result.current.hasOverrides).toBe(true);
  });

  it('counts combined node and edge overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label_overridden: true
    };
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-1',
      to: 'node-2',
      description_overridden: true
    };
    const graph = createTestGraph([node], [edge]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'node-1', 'edge-1'));
    
    expect(result.current.overrideCount).toBe(2);
    expect(result.current.hasOverrides).toBe(true);
  });

  it('removes node overrides when removeOverrides is called', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label: 'Test',
      label_overridden: true,
      description: 'Desc',
      description_overridden: true
    };
    const graph = createTestGraph([node]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'node-1', null));
    
    act(() => {
      result.current.removeOverrides();
    });
    
    expect(onUpdateGraph).toHaveBeenCalledTimes(1);
    const updatedGraph = onUpdateGraph.mock.calls[0][0];
    expect(updatedGraph.nodes[0].label_overridden).toBeUndefined();
    expect(updatedGraph.nodes[0].description_overridden).toBeUndefined();
    // Original values preserved
    expect(updatedGraph.nodes[0].label).toBe('Test');
    expect(updatedGraph.nodes[0].description).toBe('Desc');
    // Check history label
    expect(onUpdateGraph.mock.calls[0][1]).toBe('Remove overrides');
  });

  it('removes edge overrides when removeOverrides is called', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      p: { mean: 0.5, mean_overridden: true, stdev: 0.1, stdev_overridden: true },
      description: 'Test edge',
      description_overridden: true
    };
    const graph = createTestGraph([], [edge]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, null, 'edge-1'));
    
    act(() => {
      result.current.removeOverrides();
    });
    
    expect(onUpdateGraph).toHaveBeenCalledTimes(1);
    const updatedGraph = onUpdateGraph.mock.calls[0][0];
    expect(updatedGraph.edges[0].p.mean_overridden).toBeUndefined();
    expect(updatedGraph.edges[0].p.stdev_overridden).toBeUndefined();
    expect(updatedGraph.edges[0].description_overridden).toBeUndefined();
    // Original values preserved
    expect(updatedGraph.edges[0].p.mean).toBe(0.5);
    expect(updatedGraph.edges[0].description).toBe('Test edge');
    // Check object ID passed
    expect(onUpdateGraph.mock.calls[0][2]).toBe('edge-1');
  });

  it('removes variant overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      type: 'case',
      case: {
        id: 'case-1',
        status: 'active',
        status_overridden: true,
        variants: [
          { name: 'control', weight: 0.5, weight_overridden: true },
          { name: 'treatment', weight: 0.5, name_overridden: true }
        ]
      }
    };
    const graph = createTestGraph([node]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'node-1', null));
    
    expect(result.current.overrideCount).toBe(3);
    
    act(() => {
      result.current.removeOverrides();
    });
    
    const updatedGraph = onUpdateGraph.mock.calls[0][0];
    expect(updatedGraph.nodes[0].case.status_overridden).toBeUndefined();
    expect(updatedGraph.nodes[0].case.variants[0].weight_overridden).toBeUndefined();
    expect(updatedGraph.nodes[0].case.variants[1].name_overridden).toBeUndefined();
  });

  it('removes conditional probability overrides', () => {
    const edge: GraphEdge = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      conditional_p: [
        {
          condition: 'visited(x)',
          query_overridden: true,
          p: { mean: 0.7, mean_overridden: true }
        }
      ]
    };
    const graph = createTestGraph([], [edge]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, null, 'edge-1'));
    
    expect(result.current.overrideCount).toBe(2);
    
    act(() => {
      result.current.removeOverrides();
    });
    
    const updatedGraph = onUpdateGraph.mock.calls[0][0];
    expect(updatedGraph.edges[0].conditional_p[0].query_overridden).toBeUndefined();
    expect(updatedGraph.edges[0].conditional_p[0].p.mean_overridden).toBeUndefined();
  });

  it('does not call onUpdateGraph when no overrides exist', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node'
    };
    const graph = createTestGraph([node]);
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'node-1', null));
    
    expect(result.current.hasOverrides).toBe(false);
    
    act(() => {
      result.current.removeOverrides();
    });
    
    expect(onUpdateGraph).not.toHaveBeenCalled();
  });

  it('updates metadata.updated_at when removing overrides', () => {
    const node: GraphNode = {
      uuid: 'node-1',
      id: 'test-node',
      label_overridden: true
    };
    const graph = createTestGraph([node]);
    const originalTimestamp = graph.metadata!.updated_at;
    const onUpdateGraph = vi.fn();
    
    const { result } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'node-1', null));
    
    act(() => {
      result.current.removeOverrides();
    });
    
    const updatedGraph = onUpdateGraph.mock.calls[0][0];
    expect(updatedGraph.metadata.updated_at).not.toBe(originalTimestamp);
  });

  it('finds node by uuid or id', () => {
    const node: GraphNode = {
      uuid: 'uuid-123',
      id: 'human-id',
      label_overridden: true
    };
    const graph = createTestGraph([node]);
    const onUpdateGraph = vi.fn();
    
    // Find by uuid
    const { result: result1 } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'uuid-123', null));
    expect(result1.current.overrideCount).toBe(1);
    
    // Find by id
    const { result: result2 } = renderHook(() => useRemoveOverrides(graph, onUpdateGraph, 'human-id', null));
    expect(result2.current.overrideCount).toBe(1);
  });
});

