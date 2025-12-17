/**
 * Tests for path_t95 computation
 * 
 * Design reference: retrieval-date-logic-implementation-plan.md §4, §8.2
 * 
 * path_t95 is the cumulative latency from the anchor (start node) to each edge,
 * computed by summing t95 values along the topological path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computePathT95,
  applyPathT95ToGraph,
  getActiveEdges,
  type GraphForPath,
} from '../statisticalEnhancementService';
import { computeAndApplyPathT95 } from '../fetchDataService';
import type { Graph } from '../../types';
import { DEFAULT_T95_DAYS } from '../../constants/latency';

describe('path_t95 computation', () => {
  describe('computePathT95', () => {
    it('should compute cumulative t95 along a linear path', () => {
      // Graph: A → B → C → D
      // Each edge has t95 = 10
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
          { id: 'D' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e3', from: 'C', to: 'D', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 (start) + 10 = 10
      expect(pathT95Map.get('e1')).toBe(10);
      // e2: 10 (from B) + 10 = 20
      expect(pathT95Map.get('e2')).toBe(20);
      // e3: 20 (from C) + 10 = 30
      expect(pathT95Map.get('e3')).toBe(30);
    });
    
    it('should take max path_t95 when multiple paths converge', () => {
      // Graph: A → B, A → C, B → D, C → D
      // Two paths to D: A→B→D (t95: 10+10=20) and A→C→D (t95: 15+5=20)
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
          { id: 'D' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e2', from: 'A', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true, t95: 15 } } },
          { id: 'e3', from: 'B', to: 'D', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e4', from: 'C', to: 'D', p: { mean: 0.5, latency: { latency_parameter: true, t95: 5 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + 10 = 10
      expect(pathT95Map.get('e1')).toBe(10);
      // e2: 0 + 15 = 15
      expect(pathT95Map.get('e2')).toBe(15);
      // e3: max(10) + 10 = 20 (from B only)
      expect(pathT95Map.get('e3')).toBe(20);
      // e4: max(15) + 5 = 20 (from C only)
      expect(pathT95Map.get('e4')).toBe(20);
    });
    
    it('should handle edges without latency (t95 = 0)', () => {
      // Graph: A → B → C where B→C has no latency
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5 } },  // No latency
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + 10 = 10
      expect(pathT95Map.get('e1')).toBe(10);
      // e2: 10 + 0 = 10 (no latency adds nothing)
      expect(pathT95Map.get('e2')).toBe(10);
    });
    
    it('should ignore inactive edges (zero probability)', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0 } },  // Inactive (zero prob)
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // Only e1 should be computed
      expect(pathT95Map.get('e1')).toBe(10);
      expect(pathT95Map.has('e2')).toBe(false);
    });
    
    it('should compute from specified anchor node as sole start point', () => {
      // When anchor is specified, it becomes the only start node.
      // Graph with no explicit start node type - A has no incoming edges,
      // B has one incoming edge from A, C has one from B.
      // If we anchor at A, we get full path computation.
      // Note: The current implementation still processes all nodes reachable
      // from ALL nodes with in-degree 0 OR the anchor. This is correct for
      // standard graph traversal but anchor isolation is a future refinement.
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true, t95: 15 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      // Compute from anchor A (same as default in this case)
      const pathT95Map = computePathT95(graph, activeEdges, 'A');
      
      // e1: 0 + 10 = 10
      expect(pathT95Map.get('e1')).toBe(10);
      // e2: 10 + 15 = 25
      expect(pathT95Map.get('e2')).toBe(25);
    });
  });
  
  describe('applyPathT95ToGraph', () => {
    it('should apply path_t95 values to edges with latency', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { t95: 10 } } },
        ],
      };
      
      const pathT95Map = new Map([['e1', 25]]);
      
      applyPathT95ToGraph(graph, pathT95Map);
      
      expect(graph.edges[0].p?.latency?.path_t95).toBe(25);
    });
    
    it('should not add path_t95 to edges without latency', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5 } },  // No latency
        ],
      };
      
      const pathT95Map = new Map([['e1', 25]]);
      
      applyPathT95ToGraph(graph, pathT95Map);
      
      // Should not create latency object just to add path_t95
      expect(graph.edges[0].p?.latency?.path_t95).toBeUndefined();
    });
  });
  
  describe('getActiveEdges', () => {
    it('should return edges with positive probability', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5 } },
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0 } },
          { id: 'e3', from: 'A', to: 'C', p: { mean: 0.001 } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      
      expect(activeEdges.has('e1')).toBe(true);
      expect(activeEdges.has('e2')).toBe(false);  // Zero probability
      expect(activeEdges.has('e3')).toBe(true);
    });
  });
});

describe('computeAndApplyPathT95 (integration)', () => {
  it('should compute and apply path_t95 to graph edges', () => {
    const graph: Graph = {
      nodes: [
        { id: 'A', uuid: 'A', type: 'start', label: 'Start' },
        { id: 'B', uuid: 'B', label: 'Mid' },
        { id: 'C', uuid: 'C', label: 'End' },
      ],
      edges: [
        { 
          id: 'e1', uuid: 'e1', from: 'A', to: 'B', 
          p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } 
        },
        { 
          id: 'e2', uuid: 'e2', from: 'B', to: 'C', 
          p: { mean: 0.5, latency: { latency_parameter: true, t95: 15 } } 
        },
      ],
    } as any;
    
    let updatedGraph: Graph | null = null;
    const setGraph = (g: Graph | null) => { updatedGraph = g; };
    
    computeAndApplyPathT95(graph, setGraph);
    
    expect(updatedGraph).not.toBeNull();
    
    // Check path_t95 was applied
    const e1 = updatedGraph!.edges.find(e => e.id === 'e1');
    const e2 = updatedGraph!.edges.find(e => e.id === 'e2');
    
    expect(e1?.p?.latency?.path_t95).toBe(10);  // 0 + 10
    expect(e2?.p?.latency?.path_t95).toBe(25);  // 10 + 15
  });
  
  it('should handle graph with no latency edges', () => {
    const graph: Graph = {
      nodes: [
        { id: 'A', uuid: 'A', label: 'Start' },
        { id: 'B', uuid: 'B', label: 'End' },
      ],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'A', to: 'B', p: { mean: 0.5 } },
      ],
    } as any;
    
    let updatedGraph: Graph | null = null;
    const setGraph = (g: Graph | null) => { updatedGraph = g; };
    
    // Should not throw
    computeAndApplyPathT95(graph, setGraph);
    
    // Graph should be updated (even if no path_t95 was added)
    expect(updatedGraph).not.toBeNull();
  });
  
  it('should handle empty graph', () => {
    const graph: Graph = { nodes: [], edges: [] } as any;
    
    let updatedGraph: Graph | null = null;
    const setGraph = (g: Graph | null) => { updatedGraph = g; };
    
    // Should not throw
    computeAndApplyPathT95(graph, setGraph);
    
    // Should not call setGraph for empty graph
    expect(updatedGraph).toBeNull();
  });
});

describe('implementation plan test scenarios (§8.2)', () => {
  describe('non-latency vs latency edges on the same path', () => {
    it('should compute distinct path_t95 for mixed latency paths', () => {
      // Path: a→b→c→d
      // a→b: non-latency (latency_parameter disabled)
      // b→c: moderate t95 (10 days)
      // c→d: shorter t95 (5 days)
      const graph: GraphForPath = {
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b' },
          { id: 'c' },
          { id: 'd' },
        ],
        edges: [
          { id: 'e1', from: 'a', to: 'b', p: { mean: 0.5, latency: { latency_parameter: false } } },  // Non-latency
          { id: 'e2', from: 'b', to: 'c', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
          { id: 'e3', from: 'c', to: 'd', p: { mean: 0.5, latency: { latency_parameter: true, t95: 5 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + 0 = 0 (non-latency edge)
      expect(pathT95Map.get('e1')).toBe(0);
      // e2: 0 + 10 = 10
      expect(pathT95Map.get('e2')).toBe(10);
      // e3: 10 + 5 = 15
      expect(pathT95Map.get('e3')).toBe(15);
    });
  });
  
  describe('graphs with mixed latency configurations', () => {
    it('should handle non-latency a→b, latency b→c, shorter-latency c→d', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b' },
          { id: 'c' },
          { id: 'd' },
        ],
        edges: [
          { id: 'ab', from: 'a', to: 'b', p: { mean: 0.8 } },  // Non-latency
          { id: 'bc', from: 'b', to: 'c', p: { mean: 0.5, latency: { latency_parameter: true, t95: 21 } } },
          { id: 'cd', from: 'c', to: 'd', p: { mean: 0.3, latency: { latency_parameter: true, t95: 7 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // ab: 0 + 0 = 0 (no latency)
      expect(pathT95Map.get('ab')).toBe(0);
      // bc: 0 + 21 = 21
      expect(pathT95Map.get('bc')).toBe(21);
      // cd: 21 + 7 = 28
      expect(pathT95Map.get('cd')).toBe(28);
    });
  });
  
  describe('scenarios where t95 is undefined or zero', () => {
    it('should treat missing t95 as DEFAULT_T95_DAYS when latency is enabled', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b' },
          { id: 'c' },
        ],
        edges: [
          { id: 'e1', from: 'a', to: 'b', p: { mean: 0.5, latency: { latency_parameter: true, t95: undefined as any } } },
          { id: 'e2', from: 'b', to: 'c', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + DEFAULT_T95_DAYS
      expect(pathT95Map.get('e1')).toBe(DEFAULT_T95_DAYS);
      // e2: DEFAULT_T95_DAYS + 10
      expect(pathT95Map.get('e2')).toBe(DEFAULT_T95_DAYS + 10);
    });
  });
  
  describe('default t95 fallback (data sufficiency)', () => {
    it('should use DEFAULT_T95_DAYS when t95 is undefined and latency is enabled', () => {
      // First-fetch scenario: no computed t95 yet, but latency is enabled.
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true } } },  // No t95
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true } } },  // No t95
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + DEFAULT_T95_DAYS
      expect(pathT95Map.get('e1')).toBe(DEFAULT_T95_DAYS);
      // e2: DEFAULT_T95_DAYS + DEFAULT_T95_DAYS
      expect(pathT95Map.get('e2')).toBe(DEFAULT_T95_DAYS * 2);
    });
    
    it('should use explicit t95 values when present and latency is enabled', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 7 } } },
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true, t95: 5 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + 7 = 7
      expect(pathT95Map.get('e1')).toBe(7);
      // e2: 7 + 5 = 12
      expect(pathT95Map.get('e2')).toBe(12);
    });
    
    it('should handle mixed data sufficiency (some explicit t95, some missing t95)', () => {
      // Real scenario: one edge has an explicit t95; another is missing t95.
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
          { id: 'D' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 8 } } },  // Has t95
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true } } },          // Missing t95
          { id: 'e3', from: 'C', to: 'D', p: { mean: 0.5, latency: { latency_parameter: true, t95: 5 } } },  // Has t95
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + 8 (t95) = 8
      expect(pathT95Map.get('e1')).toBe(8);
      // e2: 8 + DEFAULT_T95_DAYS
      expect(pathT95Map.get('e2')).toBe(8 + DEFAULT_T95_DAYS);
      // e3: 8 + DEFAULT_T95_DAYS + 5
      expect(pathT95Map.get('e3')).toBe(8 + DEFAULT_T95_DAYS + 5);
    });
    
    it('should use 0 when neither latency_parameter nor t95 exist', () => {
      // Edge with latency object but no timing data
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5, latency: {} } },  // Empty latency
          { id: 'e2', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // e1: 0 + 0 (no data) = 0
      expect(pathT95Map.get('e1')).toBe(0);
      // e2: 0 + 10 = 10
      expect(pathT95Map.get('e2')).toBe(10);
    });
    
    it('should handle 3-step funnel: A → X → Y with cumulative t95', () => {
      // The specific use case from the bug: registration → intermediate → success
      // Each edge has t95 configured; downstream conversion windows should be cumulative.
      const graph: GraphForPath = {
        nodes: [
          { id: 'registration', type: 'start' },
          { id: 'intermediate' },
          { id: 'success' },
        ],
        edges: [
          { 
            id: 'reg-to-int', 
            from: 'registration', 
            to: 'intermediate', 
            p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } 
          },
          { 
            id: 'int-to-success', 
            from: 'intermediate', 
            to: 'success', 
            p: { mean: 0.3, latency: { latency_parameter: true, t95: 10 } } 
          },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      // Compute from the anchor node (registration)
      const pathT95Map = computePathT95(graph, activeEdges, 'registration');
      
      // reg-to-int: 0 + 10 = 10
      expect(pathT95Map.get('reg-to-int')).toBe(10);
      // int-to-success: 10 + 10 = 20 (cumulative!)
      // This is the critical fix: conversion window should be 20, not 10
      expect(pathT95Map.get('int-to-success')).toBe(20);
    });
  });
});

