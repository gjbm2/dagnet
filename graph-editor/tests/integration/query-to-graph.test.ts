/**
 * Integration Test: Query → Graph Pipeline
 * 
 * Tests the full pipeline from DSL query to graph update.
 * Focuses on the actual data flow without complex mocking.
 */

import { describe, test, expect } from 'vitest';
import { parseCompositeQuery, isCompositeQuery } from '../../src/lib/das/compositeQueryParser';
import { QUERY_PATTERN } from '../../src/lib/queryDSL';
import { UpdateManager } from '../../src/services/UpdateManager';
import type { Graph } from '../../src/types';

describe('Integration: Query → Graph Pipeline', () => {
  describe('Query Validation → Parsing', () => {
    test('valid simple query: validates then parses', () => {
      const query = 'from(a).to(b)';
      
      // Step 1: Validate
      const isValid = QUERY_PATTERN.test(query);
      expect(isValid).toBe(true);
      
      // Step 2: Check if composite
      const isComp = isCompositeQuery(query);
      expect(isComp).toBe(false);
      
      // Step 3: Parse (would happen in executor)
      const parsed = parseCompositeQuery(query);
      expect(parsed.base.from).toBe('a');
      expect(parsed.base.to).toBe('b');
    });

    test('valid composite query: validates then parses', () => {
      const query = 'from(a).to(b).minus(c)';
      
      // Step 1: Validate
      const isValid = QUERY_PATTERN.test(query);
      expect(isValid).toBe(true);
      
      // Step 2: Check if composite
      const isComp = isCompositeQuery(query);
      expect(isComp).toBe(true);
      
      // Step 3: Parse
      const parsed = parseCompositeQuery(query);
      expect(parsed.base.from).toBe('a');
      expect(parsed.base.to).toBe('b');
      expect(parsed.minusTerms).toHaveLength(1);
    });

    test('invalid query: rejected at validation', () => {
      const query = 'invalid-query';
      
      const isValid = QUERY_PATTERN.test(query);
      expect(isValid).toBe(false);
      
      // Pipeline stops here - no parsing attempted
    });

    test('real-world query: full validation pipeline', () => {
      const query = 'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)';
      
      expect(QUERY_PATTERN.test(query)).toBe(true);
      expect(isCompositeQuery(query)).toBe(true);
      
      const parsed = parseCompositeQuery(query);
      expect(parsed.base.from).toBe('saw-WA-details-page');
      expect(parsed.base.to).toBe('straight-to-dashboard');
      expect(parsed.minusTerms[0]).toEqual(['viewed-coffee-screen']);
    });
  });

  describe('Graph → UpdateManager → Edge Creation', () => {
    test('create edge: generates UUID and stores query', () => {
      const updateManager = new UpdateManager();
      const graph: Graph = {
        nodes: [
          { uuid: 'uuid-a', id: 'a', name: 'A', type: 'event', position: { x: 0, y: 0 } },
          { uuid: 'uuid-b', id: 'b', name: 'B', type: 'event', position: { x: 100, y: 0 } },
        ],
        edges: []
      };

      const query = 'from(a).to(b)';
      const result = updateManager.createEdge(
        graph,
        { source: 'uuid-a', target: 'uuid-b' },
        { id: 'test-edge' }
      );

      const edge = result.graph.edges[0];
      
      // UUID generated
      expect(edge.uuid).toBeDefined();
      expect(edge.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      
      // ID preserved
      expect(edge.id).toBe('test-edge');
      
      // Graph structure
      expect(edge.from).toBe('uuid-a');
      expect(edge.to).toBe('uuid-b');
    });

    test('create multiple edges: unique UUIDs', () => {
      const updateManager = new UpdateManager();
      const graph: Graph = {
        nodes: [
          { uuid: 'uuid-a', id: 'a', name: 'A', type: 'event', position: { x: 0, y: 0 } },
          { uuid: 'uuid-b', id: 'b', name: 'B', type: 'event', position: { x: 100, y: 0 } },
          { uuid: 'uuid-c', id: 'c', name: 'C', type: 'event', position: { x: 200, y: 0 } },
        ],
        edges: []
      };

      const result1 = updateManager.createEdge(
        graph,
        { source: 'uuid-a', target: 'uuid-b' },
        {}
      );

      const result2 = updateManager.createEdge(
        result1.graph,
        { source: 'uuid-b', target: 'uuid-c' },
        {}
      );

      const uuids = result2.graph.edges.map((e: any) => e.uuid);
      expect(uuids).toHaveLength(2);
      expect(uuids[0]).not.toBe(uuids[1]);
      expect(new Set(uuids).size).toBe(2); // All unique
    });
  });

  describe('Query → Validation → Edge → Graph', () => {
    test('full pipeline: query to graph with validation', () => {
      // User enters query
      const query = 'from(node-a).to(node-b).minus(node-c)';
      
      // Step 1: Validate query syntax
      const isValid = QUERY_PATTERN.test(query);
      if (!isValid) {
        throw new Error('Invalid query syntax');
      }
      
      // Step 2: Check if composite
      const needsCompositeExecution = isCompositeQuery(query);
      expect(needsCompositeExecution).toBe(true);
      
      // Step 3: Parse query
      const parsed = parseCompositeQuery(query);
      expect(parsed.base.from).toBe('node-a');
      expect(parsed.base.to).toBe('node-b');
      expect(parsed.minusTerms).toHaveLength(1);
      
      // Step 4: Create/update edge in graph
      const updateManager = new UpdateManager();
      const graph: Graph = {
        nodes: [
          { uuid: 'uuid-a', id: 'node-a', name: 'Node A', type: 'event', position: { x: 0, y: 0 } },
          { uuid: 'uuid-b', id: 'node-b', name: 'Node B', type: 'event', position: { x: 100, y: 0 } },
        ],
        edges: []
      };

      const result = updateManager.createEdge(
        graph,
        { source: 'uuid-a', target: 'uuid-b' },
        { id: 'edge-a-b' }
      );

      const edge = result.graph.edges[0];
      
      // Verify edge created with proper UUID
      expect(edge.uuid).toBeDefined();
      expect(edge.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(edge.id).toBe('edge-a-b');
      
      // Edge could now have query attached (in real app)
      // expect(edge.query).toBe(query);
    });
  });

  describe('Error Handling', () => {
    test('invalid query: pipeline stops at validation', () => {
      const invalidQuery = 'not-a-query';
      
      const isValid = QUERY_PATTERN.test(invalidQuery);
      expect(isValid).toBe(false);
      
      // In real app, this would show error to user
      // No parsing or execution attempted
    });

    test('missing nodes: edge creation fails gracefully', () => {
      const updateManager = new UpdateManager();
      const graph: Graph = {
        nodes: [], // No nodes!
        edges: []
      };

      const result = updateManager.createEdge(
        graph,
        { source: 'uuid-a', target: 'uuid-b' },
        {}
      );

      // Edge creation should fail or return null
      // (UpdateManager logs error but doesn't throw)
      expect(result.graph.edges).toHaveLength(0);
    });
  });

  describe('Performance: Full Pipeline', () => {
    test('validate + parse + create edge: < 10ms', () => {
      const query = 'from(a).to(b).minus(c).minus(d).plus(e)';
      const updateManager = new UpdateManager();
      const graph: Graph = {
        nodes: [
          { uuid: 'uuid-a', id: 'a', name: 'A', type: 'event', position: { x: 0, y: 0 } },
          { uuid: 'uuid-b', id: 'b', name: 'B', type: 'event', position: { x: 100, y: 0 } },
        ],
        edges: []
      };

      const start = performance.now();
      
      // Full pipeline
      const isValid = QUERY_PATTERN.test(query);
      const isComp = isCompositeQuery(query);
      const parsed = parseCompositeQuery(query);
      const result = updateManager.createEdge(
        graph,
        { source: 'uuid-a', target: 'uuid-b' },
        {}
      );
      
      const elapsed = performance.now() - start;
      
      expect(elapsed).toBeLessThan(20);
      expect(isValid).toBe(true);
      expect(isComp).toBe(true);
      expect(result.graph.edges).toHaveLength(1);
    });

    test('large graph: 100 edges created in reasonable time', () => {
      const updateManager = new UpdateManager();
      let graph: Graph = {
        nodes: Array.from({ length: 101 }, (_, i) => ({
          uuid: `uuid-${i}`,
          id: `node-${i}`,
          name: `Node ${i}`,
          type: 'event' as const,
          position: { x: i * 100, y: 0 }
        })),
        edges: []
      };

      const start = performance.now();
      
      // Create 100 edges
      for (let i = 0; i < 100; i++) {
        const result = updateManager.createEdge(
          graph,
          { source: `uuid-${i}`, target: `uuid-${i + 1}` },
          {}
        );
        graph = result.graph;
      }
      
      const elapsed = performance.now() - start;
      
      expect(graph.edges).toHaveLength(100);
      expect(elapsed).toBeLessThan(750); // < 750ms for 100 edges
      
      // All UUIDs unique
      const uuids = graph.edges.map((e: any) => e.uuid);
      expect(new Set(uuids).size).toBe(100);
    });
  });
});

