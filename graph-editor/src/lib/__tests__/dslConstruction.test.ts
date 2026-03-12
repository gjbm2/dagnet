/**
 * DSL Construction Tests
 * 
 * Exhaustive test cases for constructQueryDSL based on:
 * - docs/current/project-analysis/DSL_CONSTRUCTION_CASES.md
 * 
 * Graph patterns tested:
 * 1. Single node selections (entry, absorbing, middle)
 * 2. Two node selections (path, siblings, parallel)
 * 3. Three+ node selections (paths with intermediates, diamond, fan-out, fan-in)
 * 4. Complex selections (multiple intermediates, mixed siblings)
 */

import { describe, it, expect } from 'vitest';
import { constructQueryDSL, constructDSLFromSelection } from '../dslConstruction';

// Helper to create mock nodes
function createNode(id: string, opts: { isEntry?: boolean; isAbsorbing?: boolean; uuid?: string } = {}) {
  return {
    id: opts.uuid || id,
    data: {
      id: id,
      entry: opts.isEntry ? { is_start: true } : undefined,
      absorbing: opts.isAbsorbing || false,
    },
    uuid: opts.uuid || id,
  } as any;
}

// Helper to create mock edges (using human-readable IDs)
function createEdge(from: string, to: string) {
  return { from, to } as any;
}

describe('constructQueryDSL', () => {
  // ============================================================
  // CASE 1: Single Node Selections
  // ============================================================
  describe('Single node selections', () => {
    it('should return from(node) for entry node', () => {
      const nodes = [createNode('start', { isEntry: true })];
      const edges: any[] = [];
      
      const result = constructQueryDSL(['start'], nodes, edges);
      expect(result).toBe('from(start)');
    });
    
    it('should return to(node) for absorbing node', () => {
      const nodes = [
        createNode('start', { isEntry: true }),
        createNode('end', { isAbsorbing: true }),
      ];
      const edges = [createEdge('start', 'end')];
      
      const result = constructQueryDSL(['end'], nodes, edges);
      expect(result).toBe('to(end)');
    });
    
    it('should return visited(node) for middle node', () => {
      const nodes = [
        createNode('start', { isEntry: true }),
        createNode('middle'),
        createNode('end', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('start', 'middle'),
        createEdge('middle', 'end'),
      ];
      
      const result = constructQueryDSL(['middle'], nodes, edges);
      expect(result).toBe('visited(middle)');
    });
  });
  
  // ============================================================
  // CASE 2: Two Node Selections
  // ============================================================
  describe('Two node selections', () => {
    it('should return from(a).to(b) when a can reach b', () => {
      const nodes = [
        createNode('start', { isEntry: true }),
        createNode('end', { isAbsorbing: true }),
      ];
      const edges = [createEdge('start', 'end')];
      
      const result = constructQueryDSL(['start', 'end'], nodes, edges);
      expect(result).toBe('from(start).to(end)');
    });
    
    it('should return from(a).to(b) when a can reach b through intermediates', () => {
      const nodes = [
        createNode('a', { isEntry: true }),
        createNode('x'),
        createNode('b', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('a', 'x'),
        createEdge('x', 'b'),
      ];
      
      // Select only a and b (not x)
      const result = constructQueryDSL(['a', 'b'], nodes, edges);
      expect(result).toBe('from(a).to(b)');
    });
    
    it('should return visitedAny(a,b) for parallel siblings', () => {
      const nodes = [
        createNode('start', { isEntry: true }),
        createNode('a'),
        createNode('b'),
        createNode('end', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('start', 'a'),
        createEdge('start', 'b'),
        createEdge('a', 'end'),
        createEdge('b', 'end'),
      ];
      
      // Select only a and b (siblings)
      const result = constructQueryDSL(['a', 'b'], nodes, edges);
      expect(result).toBe('visitedAny(a,b)');
    });
    
    it('should return visitedAny for absorbing siblings (outcome comparison)', () => {
      const nodes = [
        createNode('start', { isEntry: true }),
        createNode('end1', { isAbsorbing: true }),
        createNode('end2', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('start', 'end1'),
        createEdge('start', 'end2'),
      ];
      
      const result = constructQueryDSL(['end1', 'end2'], nodes, edges);
      expect(result).toBe('visitedAny(end1,end2)');
    });
  });
  
  // ============================================================
  // CASE 3: Three Node Selections - Linear Path
  // ============================================================
  describe('Three node linear path', () => {
    it('should return from(a).to(c).visited(b) for sequential path', () => {
      const nodes = [
        createNode('a', { isEntry: true }),
        createNode('b'),
        createNode('c', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('a', 'b'),
        createEdge('b', 'c'),
      ];
      
      const result = constructQueryDSL(['a', 'b', 'c'], nodes, edges);
      expect(result).toBe('from(a).to(c).visited(b)');
    });
    
    it('should handle non-adjacent nodes in path (connected through unselected)', () => {
      const nodes = [
        createNode('a', { isEntry: true }),
        createNode('x'),
        createNode('b'),
        createNode('y'),
        createNode('c', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('a', 'x'),
        createEdge('x', 'b'),
        createEdge('b', 'y'),
        createEdge('y', 'c'),
      ];
      
      // Select a, b, c (not x, y)
      const result = constructQueryDSL(['a', 'b', 'c'], nodes, edges);
      expect(result).toBe('from(a).to(c).visited(b)');
    });
  });
  
  // ============================================================
  // CASE 4: Diamond Pattern (a→b, a→c, b→d, c→d)
  // ============================================================
  describe('Diamond pattern', () => {
    const diamondNodes = [
      createNode('a', { isEntry: true }),
      createNode('b'),
      createNode('c'),
      createNode('d', { isAbsorbing: true }),
    ];
    const diamondEdges = [
      createEdge('a', 'b'),
      createEdge('a', 'c'),
      createEdge('b', 'd'),
      createEdge('c', 'd'),
    ];
    
    it('should return from(a).to(d).visitedAny(b,c) for full diamond selection', () => {
      const result = constructQueryDSL(['a', 'b', 'c', 'd'], diamondNodes, diamondEdges);
      expect(result).toBe('from(a).to(d).visitedAny(b,c)');
    });
    
    it('should return from(a).to(d) when selecting only endpoints', () => {
      const result = constructQueryDSL(['a', 'd'], diamondNodes, diamondEdges);
      expect(result).toBe('from(a).to(d)');
    });
    
    it('should return visitedAny(b,c) when selecting only middle siblings', () => {
      const result = constructQueryDSL(['b', 'c'], diamondNodes, diamondEdges);
      expect(result).toBe('visitedAny(b,c)');
    });
    
    it('should return from(a).visited(b) for start + one branch', () => {
      const result = constructQueryDSL(['a', 'b'], diamondNodes, diamondEdges);
      expect(result).toBe('from(a).to(b)');
    });
  });
  
  // ============================================================
  // CASE 5: Fan-out Pattern (a→b, a→c, a→d)
  // ============================================================
  describe('Fan-out pattern', () => {
    const fanOutNodes = [
      createNode('a', { isEntry: true }),
      createNode('b', { isAbsorbing: true }),
      createNode('c', { isAbsorbing: true }),
      createNode('d', { isAbsorbing: true }),
    ];
    const fanOutEdges = [
      createEdge('a', 'b'),
      createEdge('a', 'c'),
      createEdge('a', 'd'),
    ];
    
    it('should return visitedAny for all absorbing children', () => {
      const result = constructQueryDSL(['b', 'c', 'd'], fanOutNodes, fanOutEdges);
      expect(result).toBe('visitedAny(b,c,d)');
    });
    
    it('should return from(a).visitedAny(b,c) for start + two children', () => {
      const result = constructQueryDSL(['a', 'b', 'c'], fanOutNodes, fanOutEdges);
      // a is start, b and c are siblings -> from(a).visitedAny(b,c)
      expect(result).toBe('from(a).visitedAny(b,c)');
    });
  });
  
  // ============================================================
  // CASE 6: Fan-in Pattern (a→d, b→d, c→d)
  // ============================================================
  describe('Fan-in pattern', () => {
    const fanInNodes = [
      createNode('a', { isEntry: true }),
      createNode('b', { isEntry: true }),
      createNode('c', { isEntry: true }),
      createNode('d', { isAbsorbing: true }),
    ];
    const fanInEdges = [
      createEdge('a', 'd'),
      createEdge('b', 'd'),
      createEdge('c', 'd'),
    ];
    
    it('should return visitedAny for multiple entry nodes', () => {
      const result = constructQueryDSL(['a', 'b', 'c'], fanInNodes, fanInEdges);
      // Multiple starts, all are entries - visitedAny
      expect(result).toBe('visitedAny(a,b,c)');
    });
    
    it('should return to(d).visitedAny(a,b) for end + two entries', () => {
      const result = constructQueryDSL(['a', 'b', 'd'], fanInNodes, fanInEdges);
      // a, b are starts (can't be reached by selection), d is end
      // But a and b are "parallel" - neither can reach the other
      expect(result).toBe('to(d).visitedAny(a,b)');
    });
  });
  
  // ============================================================
  // CASE 7: Complex Multi-level
  // ============================================================
  describe('Complex multi-level', () => {
    // a → b → d
    // a → c → d
    // (diamond with sequential depth)
    it('should handle multiple intermediate levels', () => {
      const nodes = [
        createNode('a', { isEntry: true }),
        createNode('b1'),
        createNode('b2'),
        createNode('c1'),
        createNode('c2'),
        createNode('d', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('a', 'b1'),
        createEdge('a', 'c1'),
        createEdge('b1', 'b2'),
        createEdge('c1', 'c2'),
        createEdge('b2', 'd'),
        createEdge('c2', 'd'),
      ];
      
      // Select a, b1, c1, d
      const result = constructQueryDSL(['a', 'b1', 'c1', 'd'], nodes, edges);
      expect(result).toBe('from(a).to(d).visitedAny(b1,c1)');
    });
  });
  
  // ============================================================
  // CASE 8: No Clear Start/End (middle nodes only)
  // ============================================================
  describe('Middle nodes only', () => {
    it('should return visited chain for non-sibling middle nodes', () => {
      const nodes = [
        createNode('start', { isEntry: true }),
        createNode('a'),
        createNode('b'),
        createNode('c'),
        createNode('end', { isAbsorbing: true }),
      ];
      const edges = [
        createEdge('start', 'a'),
        createEdge('a', 'b'),
        createEdge('b', 'c'),
        createEdge('c', 'end'),
      ];
      
      // Select only middle nodes a, b, c
      const result = constructQueryDSL(['a', 'b', 'c'], nodes, edges);
      // a→b→c in full graph, so a is start, c is end within selection
      expect(result).toBe('from(a).to(c).visited(b)');
    });
  });
  
  // ============================================================
  // CASE 9: Edge Cases
  // ============================================================
  describe('Edge cases', () => {
    it('should return empty string for empty selection', () => {
      const result = constructQueryDSL([], [], []);
      expect(result).toBe('');
    });
    
    it('should handle disconnected nodes', () => {
      const nodes = [
        createNode('a'),
        createNode('b'),
      ];
      const edges: any[] = []; // No edges

      const result = constructQueryDSL(['a', 'b'], nodes, edges);
      // Neither can reach the other, both are "absorbing" (no outgoing edges)
      expect(result).toBe('visitedAny(a,b)');
    });
  });
});

// ============================================================
// constructDSLFromSelection — end-to-end tests covering the
// full entry point (node selection + edge selection + format mapping)
// ============================================================

/** Graph-store node format (no .data wrapper, has .uuid and .id) */
function graphStoreNode(id: string, uuid: string, opts: { isEntry?: boolean; isAbsorbing?: boolean } = {}) {
  return {
    id,
    uuid,
    label: id,
    entry: opts.isEntry ? { is_start: true, entry_weight: 1.0 } : undefined,
    absorbing: opts.isAbsorbing || false,
  } as any;
}

/** ReactFlow node format (.data wrapper, RF id = uuid) */
function rfNode(id: string, uuid: string, opts: { isEntry?: boolean; isAbsorbing?: boolean; selected?: boolean } = {}) {
  return {
    id: uuid,       // ReactFlow uses UUID as node ID
    selected: opts.selected ?? false,
    data: {
      id,            // Human-readable ID
      uuid,
      entry: opts.isEntry ? { is_start: true, entry_weight: 1.0 } : undefined,
      absorbing: opts.isAbsorbing || false,
    },
  } as any;
}

/** Graph-store edge format (from/to are UUIDs) */
function graphStoreEdge(fromUuid: string, toUuid: string, uuid?: string) {
  return {
    uuid: uuid || `edge-${fromUuid}-${toUuid}`,
    from: fromUuid,
    to: toUuid,
    p: { mean: 0.5 },
  } as any;
}

describe('constructDSLFromSelection', () => {
  // Simple funnel: A → B → C (3 consecutive nodes)
  const uuidA = 'uuid-a';
  const uuidB = 'uuid-b';
  const uuidC = 'uuid-c';

  describe('with graph-store format nodes (AnalyticsPanel path)', () => {
    const gsNodes = [
      graphStoreNode('switch-registered', uuidA, { isEntry: true }),
      graphStoreNode('switch-activated', uuidB),
      graphStoreNode('switch-success', uuidC, { isAbsorbing: true }),
    ];
    const gsEdges = [
      graphStoreEdge(uuidA, uuidB),
      graphStoreEdge(uuidB, uuidC),
    ];

    it('should produce DSL for 3 consecutive nodes selected by human-readable IDs', () => {
      const dsl = constructDSLFromSelection(
        ['switch-registered', 'switch-activated', 'switch-success'],
        [],
        gsNodes,
        gsEdges,
      );
      expect(dsl).toBe('from(switch-registered).to(switch-success).visited(switch-activated)');
    });

    it('should produce DSL for 2 endpoint nodes', () => {
      const dsl = constructDSLFromSelection(
        ['switch-registered', 'switch-success'],
        [],
        gsNodes,
        gsEdges,
      );
      expect(dsl).toBe('from(switch-registered).to(switch-success)');
    });

    it('should produce DSL for single node', () => {
      const dsl = constructDSLFromSelection(
        ['switch-activated'],
        [],
        gsNodes,
        gsEdges,
      );
      expect(dsl).toBe('visited(switch-activated)');
    });

    it('should produce DSL for single entry node', () => {
      const dsl = constructDSLFromSelection(
        ['switch-registered'],
        [],
        gsNodes,
        gsEdges,
      );
      expect(dsl).toBe('from(switch-registered)');
    });

    it('should produce empty string for empty selection', () => {
      const dsl = constructDSLFromSelection([], [], gsNodes, gsEdges);
      expect(dsl).toBe('');
    });

    it('should produce DSL from single edge selection (by UUID)', () => {
      const edgeUuid = gsEdges[0].uuid;
      const dsl = constructDSLFromSelection([], [edgeUuid], gsNodes, gsEdges);
      expect(dsl).toBe('from(switch-registered).to(switch-activated)');
    });
  });

  describe('with ReactFlow format nodes (startAddChart path)', () => {
    const rfNodes = [
      rfNode('switch-registered', uuidA, { isEntry: true }),
      rfNode('switch-activated', uuidB),
      rfNode('switch-success', uuidC, { isAbsorbing: true }),
    ];
    const gsEdges = [
      graphStoreEdge(uuidA, uuidB),
      graphStoreEdge(uuidB, uuidC),
    ];

    it('should produce DSL for 3 consecutive nodes selected by human-readable IDs', () => {
      const dsl = constructDSLFromSelection(
        ['switch-registered', 'switch-activated', 'switch-success'],
        [],
        rfNodes,
        gsEdges,
      );
      expect(dsl).toBe('from(switch-registered).to(switch-success).visited(switch-activated)');
    });

    it('should produce DSL for single right-clicked node (contextNodeIds)', () => {
      // Simulates right-clicking a node: contextNodeIds = [humanId]
      const dsl = constructDSLFromSelection(
        ['switch-activated'],
        [],
        rfNodes,
        gsEdges,
      );
      expect(dsl).toBe('visited(switch-activated)');
    });

    it('should produce DSL from single edge selection', () => {
      const edgeUuid = gsEdges[0].uuid;
      const dsl = constructDSLFromSelection([], [edgeUuid], rfNodes, gsEdges);
      expect(dsl).toBe('from(switch-registered).to(switch-activated)');
    });
  });
});

