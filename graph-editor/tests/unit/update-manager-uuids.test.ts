/**
 * Unit Tests: UpdateManager UUID Generation
 * 
 * Tests the critical bug fix where UUIDs were being overwritten with human-readable IDs.
 * 
 * Bug #18 Fixed: createEdge now generates proper UUIDs
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { UpdateManager } from '../../src/services/UpdateManager';
import type { Graph } from '../../src/types';

describe('UpdateManager: UUID Generation', () => {
  let updateManager: UpdateManager;
  let mockGraph: Graph;

  beforeEach(() => {
    updateManager = new UpdateManager();
    mockGraph = {
      nodes: [
        { 
          uuid: 'node-uuid-1', 
          id: 'node-a', 
          name: 'Node A', 
          type: 'event',
          position: { x: 0, y: 0 }
        },
        { 
          uuid: 'node-uuid-2', 
          id: 'node-b', 
          name: 'Node B', 
          type: 'event',
          position: { x: 100, y: 0 }
        },
      ],
      edges: []
    };
  });

  describe('BUG #18 FIX: UUID Generation', () => {
    test('createEdge generates valid UUID', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];
      
      // UUID should be a valid UUID format, NOT human-readable ID
      expect(edge.uuid).toBeDefined();
      expect(edge.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      
      // UUID should NOT be the human-readable ID
      expect(edge.uuid).not.toBe(edge.id);
    });

    test('UUID is different from human-readable ID', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      // The bug was: uuid was being set to human-readable ID like "node-a-to-node-b"
      expect(edge.uuid).not.toBe(edge.id);
      expect(edge.uuid).not.toContain('node-a');
      expect(edge.uuid).not.toContain('node-b');
      
      // UUID should follow UUID v4 format
      expect(edge.uuid.length).toBe(36); // UUID format: 8-4-4-4-12
      expect(edge.uuid.split('-')).toHaveLength(5);
    });

    test('each edge gets unique UUID', () => {
      const result1 = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );
      const result2 = updateManager.createEdge(
        result1.graph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge1 = result1.graph.edges[0];
      const edge2 = result2.graph.edges[1];

      expect(edge1.uuid).not.toBe(edge2.uuid);
      expect(edge1.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(edge2.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    });

    test('provided UUID is respected', () => {
      const customUuid = crypto.randomUUID();
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        { uuid: customUuid }
      );

      const edge = result.graph.edges[0];
      expect(edge.uuid).toBe(customUuid);
    });

    test('missing UUID is auto-generated', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];
      expect(edge.uuid).toBeDefined();
      expect(edge.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });

  describe('UUID vs ID Distinction', () => {
    test('UUID is system-generated', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      // UUID should be randomly generated
      expect(edge.uuid).toMatch(/^[0-9a-f]{8}-/i);
      expect(edge.uuid).not.toContain('node');
    });

    test('ID is human-readable', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        { id: 'my-custom-edge' }
      );

      const edge = result.graph.edges[0];

      // ID should be human-readable
      expect(edge.id).toBe('my-custom-edge');
      
      // UUID should still be system-generated
      expect(edge.uuid).not.toBe('my-custom-edge');
      expect(edge.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    });

    test('UUID used for React keys', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      // In React, we use UUID as the key (stable across renders)
      const reactKey = edge.uuid;
      
      expect(reactKey).toBeDefined();
      expect(reactKey).toMatch(/^[0-9a-f-]{36}$/i);
    });

    test('ID used for semantic references', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        { id: 'checkout-conversion' }
      );

      const edge = result.graph.edges[0];

      // ID is used for human-readable references
      expect(edge.id).toBe('checkout-conversion');
      
      // But UUID is still used for system tracking
      expect(edge.uuid).not.toBe('checkout-conversion');
    });
  });

  describe('Edge Creation Scenarios', () => {
    test('creating edge with minimal properties', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      expect(edge.uuid).toBeDefined();
      expect(edge.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      // from/to use UUID for referencing nodes
      expect(edge.from).toBe('node-uuid-1');
      expect(edge.to).toBe('node-uuid-2');
    });

    test('creating multiple edges between same nodes', () => {
      const result1 = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );
      const result2 = updateManager.createEdge(
        result1.graph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge1 = result1.graph.edges[0];
      const edge2 = result2.graph.edges[1];

      // Should have different UUIDs
      expect(edge1.uuid).not.toBe(edge2.uuid);
      
      // Both should be valid UUIDs
      expect(edge1.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(edge2.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    });

    test('returns updated graph and edge ID', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      expect(result).toHaveProperty('graph');
      expect(result).toHaveProperty('edgeId');
      expect(result.graph.edges).toHaveLength(1);
      expect(typeof result.edgeId).toBe('string');
    });
  });

  describe('UUID Format Validation', () => {
    test('UUID follows RFC 4122 v4 format', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      // where x is any hex digit and y is one of 8, 9, A, or B
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      
      expect(edge.uuid).toMatch(uuidRegex);
    });

    test('UUID version is 4 (random)', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      // 13th character (after removing hyphens) should be '4'
      const uuidWithoutHyphens = edge.uuid.replace(/-/g, '');
      expect(uuidWithoutHyphens[12]).toBe('4');
    });

    test('UUID variant is RFC 4122', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      // 17th character (after removing hyphens) should be 8, 9, a, or b
      const uuidWithoutHyphens = edge.uuid.replace(/-/g, '');
      const variant = uuidWithoutHyphens[16].toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variant);
    });
  });

  describe('Regression Prevention', () => {
    test('REGRESSION CHECK: UUID never set to human-readable format', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        { id: 'viewed-coffee-screen-to-straight-to-dashboard' }
      );

      const edge = result.graph.edges[0];

      // The bug: UUID was being set to the same value as ID
      expect(edge.uuid).not.toBe('viewed-coffee-screen-to-straight-to-dashboard');
      expect(edge.uuid).not.toContain('viewed-coffee-screen');
      expect(edge.uuid).not.toContain('dashboard');
      
      // UUID should be a proper UUID
      expect(edge.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('REGRESSION CHECK: UUID never contains node IDs', () => {
      // Use nodes with descriptive IDs
      const graphWithDescriptiveIds: Graph = {
        nodes: [
          { uuid: 'uuid-1', id: 'saw-WA-details', name: 'Saw WA Details', type: 'event', position: { x: 0, y: 0 } },
          { uuid: 'uuid-2', id: 'dashboard', name: 'Dashboard', type: 'event', position: { x: 100, y: 0 } },
        ],
        edges: []
      };

      const result = updateManager.createEdge(
        graphWithDescriptiveIds,
        { source: 'uuid-1', target: 'uuid-2' },
        {}
      );

      const edge = result.graph.edges[0];

      expect(edge.uuid).not.toContain('saw-WA-details');
      expect(edge.uuid).not.toContain('dashboard');
      expect(edge.uuid).not.toContain('to');
      expect(edge.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    });

    test('REGRESSION CHECK: UUID generation is not deterministic', () => {
      // We should NOT use deterministic UUID generation
      // Each edge should get a unique UUID even with same parameters
      const result1 = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );
      const result2 = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const edge1 = result1.graph.edges[0];
      const edge2 = result2.graph.edges[0];

      expect(edge1.uuid).not.toBe(edge2.uuid);
    });
  });

  describe('Audit Trail', () => {
    test('createEdge is logged in audit trail', () => {
      const result = updateManager.createEdge(
        mockGraph,
        { source: 'node-uuid-1', target: 'node-uuid-2' },
        {}
      );

      const auditLog = updateManager.getAuditLog();
      const createEdgeEntry = auditLog.find(entry => entry.operation === 'createEdge');

      expect(createEdgeEntry).toBeDefined();
      expect(createEdgeEntry?.details).toHaveProperty('edgeId');
      expect(createEdgeEntry?.details).toHaveProperty('source');
      expect(createEdgeEntry?.details).toHaveProperty('target');
    });
  });
});

describe('UpdateManager: Edge ID Generation', () => {
  let updateManager: UpdateManager;
  let mockGraph: Graph;

  beforeEach(() => {
    updateManager = new UpdateManager();
    mockGraph = {
      nodes: [
        { uuid: 'uuid-1', id: 'a', name: 'A', type: 'event', position: { x: 0, y: 0 } },
        { uuid: 'uuid-2', id: 'b', name: 'B', type: 'event', position: { x: 100, y: 0 } },
      ],
      edges: []
    };
  });

  test('auto-generates human-readable ID', () => {
    const result = updateManager.createEdge(
      mockGraph,
      { source: 'uuid-1', target: 'uuid-2' },
      {}
    );

    const edge = result.graph.edges[0];
    
    // ID should be human-readable (based on node IDs)
    expect(edge.id).toBeDefined();
    expect(typeof edge.id).toBe('string');
    expect(edge.id.length).toBeGreaterThan(0);
  });

  test('respects custom ID', () => {
    const result = updateManager.createEdge(
      mockGraph,
      { source: 'uuid-1', target: 'uuid-2' },
      { id: 'my-custom-id' }
    );

    const edge = result.graph.edges[0];
    expect(edge.id).toBe('my-custom-id');
  });

  test('ID and UUID are different', () => {
    const result = updateManager.createEdge(
      mockGraph,
      { source: 'uuid-1', target: 'uuid-2' },
      {}
    );

    const edge = result.graph.edges[0];
    expect(edge.id).not.toBe(edge.uuid);
    expect(edge.id.length).toBeLessThan(edge.uuid.length); // ID is shorter than UUID
  });
});
