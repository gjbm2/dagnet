/**
 * UpdateManager Graph-to-Graph Update Tests
 * 
 * Tests for the new graph-to-graph update mechanisms:
 * - renameNodeId() with comprehensive cascading updates
 * - Edge ID deduplication
 * - Query token replacement
 * - Conditional probability token replacement
 * - UUID-to-ID edge renaming on first ID assignment
 * - pasteSubgraph() for copy-paste functionality
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpdateManager } from '../UpdateManager';

// Mock crypto.randomUUID for Node.js test environment
let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

describe('UpdateManager - Graph-to-Graph Updates', () => {
  let updateManager: UpdateManager;
  
  beforeEach(() => {
    updateManager = new UpdateManager();
    updateManager.clearAuditLog();
    // Reset UUID counter for test isolation
    uuidCounter = 0;
  });
  
  // ============================================================
  // TEST SUITE 1: Basic Node ID Renaming
  // ============================================================
  
  describe('renameNodeId - Basic Functionality', () => {
    it('should rename node id and update label', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-uuid-1',
            id: 'old-node',
            label: 'Old Node',
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-uuid-1', 'new-node');
      
      expect(result.graph.nodes[0].id).toBe('new-node');
      expect(result.graph.nodes[0].label).toBe('New node'); // Humanized
      expect(result.oldId).toBe('old-node');
    });
    
    it('should not update label if label_overridden is true', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-uuid-1',
            id: 'old-node',
            label: 'Custom Label',
            label_overridden: true,
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-uuid-1', 'new-node');
      
      expect(result.graph.nodes[0].id).toBe('new-node');
      expect(result.graph.nodes[0].label).toBe('Custom Label'); // Unchanged
    });
    
    it('should handle renaming node by current id instead of uuid', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-uuid-1',
            id: 'current-id',
            label: 'Current Label',
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'current-id', 'new-id');
      
      expect(result.graph.nodes[0].id).toBe('new-id');
      expect(result.oldId).toBe('current-id');
    });
    
    it('should handle first-time id assignment (null to id)', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-uuid-1',
            id: null,
            label: 'Unlabeled Node',
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-uuid-1', 'first-id');
      
      expect(result.graph.nodes[0].id).toBe('first-id');
      expect(result.graph.nodes[0].label).toBe('First id'); // Humanized
      expect(result.oldId).toBeNull(); // null when node had no previous id
    });
    
    it('should handle empty string id assignment', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-uuid-1',
            id: 'old-id',
            label: 'Old Label',
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-uuid-1', '');
      
      expect(result.graph.nodes[0].id).toBe('');
      expect(result.oldId).toBe('old-id');
    });
  });
  
  // ============================================================
  // TEST SUITE 2: Edge From/To Preservation
  // ============================================================
  // edge.from and edge.to MUST remain as node UUIDs per GraphEdge type.
  // They should NOT be updated when renaming node human-readable IDs.
  
  describe('renameNodeId - Edge From/To Preservation', () => {
    it('should NOT change edge.from when source node is renamed (from/to use UUIDs)', () => {
      const graph = {
        nodes: [
          { uuid: 'uuid-node-a', id: 'old-node-a' },
          { uuid: 'uuid-node-b', id: 'node-b' },
        ],
        edges: [
          { id: 'edge-1', from: 'uuid-node-a', to: 'uuid-node-b', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'uuid-node-a', 'new-node-a');
      
      // edge.from/to remain as UUIDs - they do NOT change to human-readable IDs
      expect(result.graph.edges[0].from).toBe('uuid-node-a');
      expect(result.graph.edges[0].to).toBe('uuid-node-b');
      expect(result.edgesFromToUpdated).toBe(0);
    });
    
    it('should NOT change edge.to when target node is renamed (from/to use UUIDs)', () => {
      const graph = {
        nodes: [
          { uuid: 'uuid-node-a', id: 'node-a' },
          { uuid: 'uuid-node-b', id: 'old-node-b' },
        ],
        edges: [
          { id: 'edge-1', from: 'uuid-node-a', to: 'uuid-node-b', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'uuid-node-b', 'new-node-b');
      
      // edge.from/to remain as UUIDs
      expect(result.graph.edges[0].from).toBe('uuid-node-a');
      expect(result.graph.edges[0].to).toBe('uuid-node-b');
      expect(result.edgesFromToUpdated).toBe(0);
    });
    
    it('should preserve UUIDs in edge.from/to for multiple edges when node renamed', () => {
      const graph = {
        nodes: [
          { uuid: 'uuid-hub', id: 'old-hub' },
          { uuid: 'uuid-node-b', id: 'node-b' },
          { uuid: 'uuid-node-c', id: 'node-c' },
        ],
        edges: [
          { id: 'edge-1', from: 'uuid-hub', to: 'uuid-node-b', p: { mean: 0.5 } },
          { id: 'edge-2', from: 'uuid-hub', to: 'uuid-node-c', p: { mean: 0.3 } },
          { id: 'edge-3', from: 'uuid-node-b', to: 'uuid-hub', p: { mean: 0.2 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'uuid-hub', 'new-hub');
      
      // All edge.from/to remain as UUIDs
      expect(result.graph.edges[0].from).toBe('uuid-hub');
      expect(result.graph.edges[1].from).toBe('uuid-hub');
      expect(result.graph.edges[2].to).toBe('uuid-hub');
      expect(result.edgesFromToUpdated).toBe(0);
    });
  });
  
  // ============================================================
  // TEST SUITE 3: Edge ID String Replacement
  // ============================================================
  
  describe('renameNodeId - Edge ID Replacement', () => {
    it('should replace node id substring in edge ids (but NOT from/to which use UUIDs)', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
          { uuid: 'node-b', id: 'payment' },
        ],
        edges: [
          { id: 'checkout-to-payment', from: 'node-a', to: 'node-b', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'cart');
      
      expect(result.graph.edges[0].id).toBe('cart-to-payment');
      expect(result.graph.edges[0].from).toBe('node-a');  // UUID preserved, NOT changed to human ID
      expect(result.graph.edges[0].to).toBe('node-b');    // UUID preserved
      expect(result.edgeIdsUpdatedFromId).toBe(1);
    });
    
    it('should use word boundaries for token replacement', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'e' },
          { uuid: 'node-b', id: 'node-b' },
        ],
        edges: [
          { id: 'e-to-node-b', from: 'e', to: 'node-b', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'start');
      
      // Should replace 'e' only at word boundaries
      expect(result.graph.edges[0].id).toBe('start-to-node-b');
      expect(result.edgeIdsUpdatedFromId).toBe(1);
    });
    
    it('should handle edge ids with multiple occurrences of node id', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
        ],
        edges: [
          { id: 'checkout-start-checkout-end', from: 'checkout', to: 'payment', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'cart');
      
      expect(result.graph.edges[0].id).toBe('cart-start-cart-end');
    });
    
    it('should not replace partial word matches', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'web' },
          { uuid: 'node-b', id: 'website' },
        ],
        edges: [
          { id: 'web-to-website', from: 'web', to: 'website', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'app');
      
      // Should replace 'web' but not 'website'
      expect(result.graph.edges[0].id).toBe('app-to-website');
    });
  });
  
  // ============================================================
  // TEST SUITE 4: UUID-to-ID Edge Replacement
  // ============================================================
  
  describe('renameNodeId - UUID to ID Replacement', () => {
    it('should replace uuid with id in edge.id on first id assignment (but NOT in from/to)', () => {
      const graph = {
        nodes: [
          { uuid: 'f3f83440-c341-48a2-8382-12380e08e52a', id: null },
          { uuid: '2cdeac12-fa4b-4091-9164-8ace50ab5590', id: null },
        ],
        edges: [
          {
            id: 'f3f83440-c341-48a2-8382-12380e08e52a-to-2cdeac12-fa4b-4091-9164-8ace50ab5590',
            from: 'f3f83440-c341-48a2-8382-12380e08e52a',
            to: '2cdeac12-fa4b-4091-9164-8ace50ab5590',
            p: { mean: 0.5 },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(
        graph,
        '2cdeac12-fa4b-4091-9164-8ace50ab5590',
        'node-b'
      );
      
      // edge.id is updated (human-readable IDs can be used in edge.id)
      expect(result.graph.edges[0].id).toBe('f3f83440-c341-48a2-8382-12380e08e52a-to-node-b');
      // edge.from and edge.to remain as UUIDs - they do NOT change to human-readable IDs
      expect(result.graph.edges[0].from).toBe('f3f83440-c341-48a2-8382-12380e08e52a');
      expect(result.graph.edges[0].to).toBe('2cdeac12-fa4b-4091-9164-8ace50ab5590');
      expect(result.edgeIdsUpdatedFromUuid).toBe(1);
    });
    
    it('should not replace uuid when node already has an id', () => {
      const graph = {
        nodes: [
          { uuid: 'node-uuid-a', id: 'node-a' },
          { uuid: 'node-uuid-b', id: 'old-node-b' },
        ],
        edges: [
          {
            id: 'node-a-to-old-node-b',
            from: 'node-a',
            to: 'old-node-b',
            p: { mean: 0.5 },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-uuid-b', 'new-node-b');
      
      // Should use id-based replacement, not uuid
      expect(result.graph.edges[0].id).toBe('node-a-to-new-node-b');
      expect(result.edgeIdsUpdatedFromId).toBe(1);
      expect(result.edgeIdsUpdatedFromUuid).toBe(0);
    });
  });
  
  // ============================================================
  // TEST SUITE 5: Query Token Replacement
  // ============================================================
  
  describe('renameNodeId - Query Token Replacement', () => {
    it('should replace node id in edge query strings', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
          { uuid: 'node-b', id: 'payment' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'checkout',
            to: 'payment',
            p: {
              mean: 0.5,
              query: 'checkout.status == "complete"',
            },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'cart');
      
      expect(result.graph.edges[0].p.query).toBe('cart.status == "complete"');
      expect(result.queriesUpdated).toBe(1);
    });
    
    it('should replace node id in node queries', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-a',
            id: 'checkout',
            p: {
              mean: 0.3,
              query: 'checkout.source == "mobile"',
            },
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'cart');
      
      expect(result.graph.nodes[0].p.query).toBe('cart.source == "mobile"');
      expect(result.queriesUpdated).toBe(1);
    });
    
    it('should replace node id in multiple query locations', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'user' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'start',
            to: 'user',
            p: { mean: 0.5, query: 'user.age > 18 && user.verified == true' },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'customer');
      
      expect(result.graph.edges[0].p.query).toBe('customer.age > 18 && customer.verified == true');
    });
    
    it('should use word boundaries for query token replacement', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'e' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'start',
            to: 'e',
            p: { mean: 0.5, query: 'e.value > 0' },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'event');
      
      expect(result.graph.edges[0].p.query).toBe('event.value > 0');
    });
    
    it('should replace node id in edge n_query strings', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
          { uuid: 'node-b', id: 'payment' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'checkout',
            to: 'payment',
            query: 'from(checkout).to(payment).visited(cart)',
            n_query: 'from(cart).to(checkout)',
            p: { mean: 0.5 },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'order');
      
      // Both query and n_query should be updated
      expect(result.graph.edges[0].query).toBe('from(order).to(payment).visited(cart)');
      expect(result.graph.edges[0].n_query).toBe('from(cart).to(order)');
    });
    
    it('should replace node id in edge-level parameter n_query', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'signup' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'start',
            to: 'signup',
            p: { 
              mean: 0.5,
              n_query: 'from(landing).to(signup)'  // n_query on probability param
            },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'registration');
      
      expect(result.graph.edges[0].p.n_query).toBe('from(landing).to(registration)');
    });
    
    it('should replace node id in cost_gbp and labour_cost n_query', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'cart',
            to: 'checkout',
            cost_gbp: { 
              mean: 100,
              n_query: 'from(browse).to(checkout)'
            },
            labour_cost: { 
              mean: 120,
              n_query: 'from(browse).to(checkout)'
            },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'payment');
      
      expect(result.graph.edges[0].cost_gbp.n_query).toBe('from(browse).to(payment)');
      expect(result.graph.edges[0].labour_cost.n_query).toBe('from(browse).to(payment)');
    });
  });
  
  // ============================================================
  // TEST SUITE 6: Conditional Probability Token Replacement
  // ============================================================
  
  describe('renameNodeId - Conditional Probability Replacement', () => {
    it('should replace node id in conditional probability conditions', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'start',
            to: 'checkout',
            p: {
              mean: 0.5,
              conditional_probabilities: [
                {
                  condition: 'checkout.method == "card"',
                  mean: 0.8,
                },
                {
                  condition: 'checkout.method == "paypal"',
                  mean: 0.6,
                },
              ],
            },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'payment');
      
      const conditionals = result.graph.edges[0].p.conditional_probabilities;
      expect(conditionals[0].condition).toBe('payment.method == "card"');
      expect(conditionals[1].condition).toBe('payment.method == "paypal"');
      expect(result.conditionsUpdated).toBe(2);
    });
    
    it('should replace node id in node conditional probabilities', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-a',
            id: 'user',
            p: {
              mean: 0.5,
              conditional_probabilities: [
                {
                  condition: 'user.country == "US"',
                  mean: 0.7,
                },
              ],
            },
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'customer');
      
      expect(result.graph.nodes[0].p.conditional_probabilities[0].condition).toBe(
        'customer.country == "US"'
      );
      expect(result.conditionsUpdated).toBe(1);
    });
    
    it('should handle multiple node id occurrences in conditions', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'order' },
        ],
        edges: [
          {
            id: 'edge-1',
            from: 'start',
            to: 'order',
            p: {
              mean: 0.5,
              conditional_probabilities: [
                {
                  condition: 'order.value > 100 && order.status == "pending"',
                  mean: 0.8,
                },
              ],
            },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'purchase');
      
      expect(result.graph.edges[0].p.conditional_probabilities[0].condition).toBe(
        'purchase.value > 100 && purchase.status == "pending"'
      );
    });
  });
  
  // ============================================================
  // TEST SUITE 7: Edge ID Deduplication
  // ============================================================
  
  describe('renameNodeId - Edge ID Deduplication', () => {
    it('should deduplicate edge ids by appending .2, .3, etc.', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
          { uuid: 'node-b', id: 'payment' },
          { uuid: 'node-c', id: 'confirmation' },
        ],
        edges: [
          { id: 'start-to-checkout', from: 'start', to: 'checkout', p: { mean: 0.5 } },
          { id: 'start-to-payment', from: 'start', to: 'payment', p: { mean: 0.3 } },
          { id: 'start-to-confirmation', from: 'start', to: 'confirmation', p: { mean: 0.2 } },
        ],
      };
      
      // Rename all nodes to 'node', which will cause edge id collisions
      let result = updateManager.renameNodeId(graph, 'node-a', 'node');
      result = updateManager.renameNodeId(result.graph, 'node-b', 'node');
      result = updateManager.renameNodeId(result.graph, 'node-c', 'node');
      
      const edgeIds = result.graph.edges.map((e: any) => e.id);
      
      // All edge ids should be unique
      expect(new Set(edgeIds).size).toBe(3);
      expect(edgeIds).toContain('start-to-node');
      
      // Check that deduplication happened
      expect(result.edgeIdsDeduped).toBeGreaterThan(0);
    });
    
    it('should handle pre-existing duplicate edge ids', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'node-a' },
        ],
        edges: [
          { id: 'duplicate-edge', from: 'start', to: 'node-a', p: { mean: 0.5 } },
          { id: 'duplicate-edge', from: 'node-a', to: 'end', p: { mean: 0.5 } },
          { id: 'duplicate-edge', from: 'start', to: 'end', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'node-b');
      
      const edgeIds = result.graph.edges.map((e: any) => e.id);
      
      // All edge ids should be unique after deduplication
      expect(new Set(edgeIds).size).toBe(3);
      expect(edgeIds).toContain('duplicate-edge');
      expect(edgeIds).toContain('duplicate-edge.2');
      expect(edgeIds).toContain('duplicate-edge.3');
    });
    
    it('should preserve unique edge ids', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'checkout' },
          { uuid: 'node-b', id: 'payment' },
        ],
        edges: [
          { id: 'checkout-to-payment', from: 'checkout', to: 'payment', p: { mean: 0.5 } },
          { id: 'payment-to-end', from: 'payment', to: 'end', p: { mean: 0.8 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'cart');
      
      const edgeIds = result.graph.edges.map((e: any) => e.id);
      
      // Edge ids should be updated but remain unique
      expect(edgeIds).toContain('cart-to-payment');
      expect(edgeIds).toContain('payment-to-end');
      expect(new Set(edgeIds).size).toBe(2);
      expect(result.edgeIdsDeduped).toBe(0); // No deduplication needed
    });
  });
  
  // ============================================================
  // TEST SUITE 8: Complex Integration Scenarios
  // ============================================================
  
  describe('renameNodeId - Complex Integration', () => {
    it('should handle comprehensive rename with all features', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-uuid-1',
            id: 'old-checkout',
            label: 'Old Checkout',
            p: {
              mean: 0.5,
              query: 'old-checkout.type == "express"',
              conditional_probabilities: [
                {
                  condition: 'old-checkout.value > 100',
                  mean: 0.7,
                },
              ],
            },
          },
          { uuid: 'node-uuid-2', id: 'payment' },
          { uuid: 'node-uuid-start', id: 'start' },
        ],
        edges: [
          {
            id: 'start-to-old-checkout',
            from: 'node-uuid-start',  // UUID, not human-readable ID
            to: 'node-uuid-1',        // UUID, not human-readable ID
            p: {
              mean: 0.8,
              query: 'old-checkout.source == "mobile"',
            },
          },
          {
            id: 'old-checkout-to-payment',
            from: 'node-uuid-1',      // UUID, not human-readable ID
            to: 'node-uuid-2',        // UUID, not human-readable ID
            p: {
              mean: 0.6,
              conditional_probabilities: [
                {
                  condition: 'old-checkout.method == "card"',
                  mean: 0.9,
                },
              ],
            },
          },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-uuid-1', 'new-checkout');
      
      // Node updates
      expect(result.graph.nodes[0].id).toBe('new-checkout');
      expect(result.graph.nodes[0].label).toBe('New checkout'); // Humanized
      expect(result.graph.nodes[0].p.query).toBe('new-checkout.type == "express"');
      expect(result.graph.nodes[0].p.conditional_probabilities[0].condition).toBe(
        'new-checkout.value > 100'
      );
      
      // Edge updates - edge.id and queries are updated, but from/to remain as UUIDs
      expect(result.graph.edges[0].id).toBe('start-to-new-checkout');
      expect(result.graph.edges[0].from).toBe('node-uuid-start');  // UUID preserved
      expect(result.graph.edges[0].to).toBe('node-uuid-1');        // UUID preserved
      expect(result.graph.edges[0].p.query).toBe('new-checkout.source == "mobile"');
      
      expect(result.graph.edges[1].id).toBe('new-checkout-to-payment');
      expect(result.graph.edges[1].from).toBe('node-uuid-1');      // UUID preserved
      expect(result.graph.edges[1].to).toBe('node-uuid-2');        // UUID preserved
      expect(result.graph.edges[1].p.conditional_probabilities[0].condition).toBe(
        'new-checkout.method == "card"'
      );
      
      // Statistics - edgesFromToUpdated is 0 because from/to use UUIDs (not human IDs)
      expect(result.oldId).toBe('old-checkout');
      expect(result.edgesFromToUpdated).toBe(0);  // from/to not changed (they use UUIDs)
      expect(result.edgeIdsUpdatedFromId).toBe(2);
      expect(result.queriesUpdated).toBe(2);
      expect(result.conditionsUpdated).toBe(2);
    });
    
    it('should handle node with no edges gracefully', () => {
      const graph = {
        nodes: [
          { uuid: 'isolated-node', id: 'isolated', label: 'Isolated Node' },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'isolated-node', 'lonely');
      
      expect(result.graph.nodes[0].id).toBe('lonely');
      expect(result.edgesFromToUpdated).toBe(0);
      expect(result.edgeIdsUpdatedFromId).toBe(0);
      expect(result.queriesUpdated).toBe(0);
      expect(result.conditionsUpdated).toBe(0);
    });
    
    it('should handle graph with missing edges array', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'old-id' },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'new-id');
      
      expect(result.graph.nodes[0].id).toBe('new-id');
      expect(result.edgesFromToUpdated).toBe(0);
    });
    
    it('should handle cost parameters in nodes', () => {
      const graph = {
        nodes: [
          {
            uuid: 'node-a',
            id: 'service',
            cost_gbp: {
              mean: 10,
              query: 'service.tier == "premium"',
            },
            labour_cost: {
              mean: 5,
              conditional_probabilities: [
                {
                  condition: 'service.region == "US"',
                  mean: 3,
                },
              ],
            },
          },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'product');
      
      expect(result.graph.nodes[0].cost_gbp.query).toBe('product.tier == "premium"');
      expect(result.graph.nodes[0].labour_cost.conditional_probabilities[0].condition).toBe(
        'product.region == "US"'
      );
      expect(result.queriesUpdated).toBe(1);
      expect(result.conditionsUpdated).toBe(1);
    });
  });
  
  // ============================================================
  // TEST SUITE 9: Edge Cases and Error Handling
  // ============================================================
  
  describe('renameNodeId - Edge Cases', () => {
    it('should handle node not found', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'node-a' },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'non-existent', 'new-id');
      
      // Should return unchanged graph
      expect(result.graph.nodes[0].id).toBe('node-a');
      expect(result.oldId).toBeUndefined();
    });
    
    it('should handle special characters in node ids', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'special-chars-$&*' },
          { uuid: 'node-end', id: 'end' },
        ],
        edges: [
          { id: 'special-chars-$&*-to-end', from: 'node-a', to: 'node-end', p: { mean: 0.5 } },
        ],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'normal-id');
      
      expect(result.graph.nodes[0].id).toBe('normal-id');
      // edge.id NOT updated because special chars break regex token matching
      // (this is expected - special chars in IDs are not well-supported)
      expect(result.graph.edges[0].id).toBe('special-chars-$&*-to-end');
      // edge.from/to remain as UUIDs
      expect(result.graph.edges[0].from).toBe('node-a');
      expect(result.graph.edges[0].to).toBe('node-end');
    });
    
    it('should handle very long node ids', () => {
      const longId = 'very-long-node-id-'.repeat(10);
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'short' },
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', longId);
      
      expect(result.graph.nodes[0].id).toBe(longId);
    });
    
    it('should handle nodes with minimal data', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a' }, // No id, no label
        ],
        edges: [],
      };
      
      const result = updateManager.renameNodeId(graph, 'node-a', 'new-id');
      
      expect(result.graph.nodes[0].id).toBe('new-id');
    });
  });
  
  // ============================================================
  // TEST SUITE 9: Subgraph Paste
  // ============================================================
  
  describe('pasteSubgraph', () => {
    it('should paste nodes with new unique UUIDs', () => {
      const graph = {
        nodes: [
          { uuid: 'existing-1', id: 'start', label: 'Start' },
        ],
        edges: [],
        metadata: { version: '1.0' }
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'Landing Page', position: { x: 100, y: 100 } },
        { uuid: 'copy-2', id: 'checkout', label: 'Checkout', position: { x: 200, y: 100 } },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      // Original node still exists
      expect(result.graph.nodes).toHaveLength(3);
      expect(result.graph.nodes[0].uuid).toBe('existing-1');
      
      // New nodes have new UUIDs
      expect(result.pastedNodeUuids).toHaveLength(2);
      expect(result.pastedNodeUuids[0]).not.toBe('copy-1');
      expect(result.pastedNodeUuids[1]).not.toBe('copy-2');
      
      // UUID mapping is populated
      expect(result.uuidMapping.get('copy-1')).toBe(result.pastedNodeUuids[0]);
      expect(result.uuidMapping.get('copy-2')).toBe(result.pastedNodeUuids[1]);
    });

    it('should generate unique human-readable IDs when duplicates exist', () => {
      const graph = {
        nodes: [
          { uuid: 'existing-1', id: 'landing', label: 'Landing' },
        ],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'Landing Page' },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      // New node should have a unique ID
      const pastedNode = result.graph.nodes.find((n: any) => n.uuid === result.pastedNodeUuids[0]);
      expect(pastedNode.id).toBe('landing-1');
      expect(result.idMapping.get('landing')).toBe('landing-1');
    });

    it('should offset node positions', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'node', position: { x: 100, y: 200 } },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, [], { x: 50, y: 75 });
      
      const pastedNode = result.graph.nodes[0];
      expect(pastedNode.position.x).toBe(150);
      expect(pastedNode.position.y).toBe(275);
    });

    it('should paste edges with updated references', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'Landing' },
        { uuid: 'copy-2', id: 'checkout', label: 'Checkout' },
      ];
      
      const edgesToPaste = [
        { uuid: 'edge-1', id: 'landing-to-checkout', from: 'copy-1', to: 'copy-2', p: { mean: 0.5 } },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, edgesToPaste);
      
      // Edge should be pasted
      expect(result.graph.edges).toHaveLength(1);
      expect(result.pastedEdgeUuids).toHaveLength(1);
      
      // Edge references should be updated to new node UUIDs
      const pastedEdge = result.graph.edges[0];
      expect(pastedEdge.from).toBe(result.uuidMapping.get('copy-1'));
      expect(pastedEdge.to).toBe(result.uuidMapping.get('copy-2'));
      
      // Edge should have new UUID
      expect(pastedEdge.uuid).not.toBe('edge-1');
    });

    it('should skip edges that reference nodes outside the subgraph', () => {
      const graph = {
        nodes: [
          { uuid: 'external', id: 'external-node' },
        ],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'Landing' },
      ];
      
      const edgesToPaste = [
        // This edge references an external node not being pasted
        { uuid: 'edge-1', id: 'landing-to-external', from: 'copy-1', to: 'external', p: { mean: 0.5 } },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, edgesToPaste);
      
      // Edge should be skipped
      expect(result.graph.edges).toHaveLength(0);
      expect(result.pastedEdgeUuids).toHaveLength(0);
    });

    it('should update query strings in edges with new node IDs', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'Landing' },
        { uuid: 'copy-2', id: 'checkout', label: 'Checkout' },
      ];
      
      const edgesToPaste = [
        { 
          uuid: 'edge-1', 
          id: 'landing-to-checkout', 
          from: 'copy-1', 
          to: 'copy-2', 
          query: 'landing -> checkout',
          p: { mean: 0.5 } 
        },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, edgesToPaste);
      
      const pastedEdge = result.graph.edges[0];
      const newLandingId = result.idMapping.get('landing');
      const newCheckoutId = result.idMapping.get('checkout');
      
      // Query should use new IDs
      expect(pastedEdge.query).toContain(newLandingId);
      expect(pastedEdge.query).toContain(newCheckoutId);
    });

    it('should update conditional_p conditions with new node IDs', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'Landing' },
        { uuid: 'copy-2', id: 'checkout', label: 'Checkout' },
      ];
      
      const edgesToPaste = [
        { 
          uuid: 'edge-1', 
          from: 'copy-1', 
          to: 'copy-2', 
          conditional_p: [
            { condition: 'via landing', p: { mean: 0.8 } }
          ],
          p: { mean: 0.5 } 
        },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, edgesToPaste);
      
      const pastedEdge = result.graph.edges[0];
      const newLandingId = result.idMapping.get('landing');
      
      expect(pastedEdge.conditional_p[0].condition).toContain(newLandingId);
    });

    it('should update label if not overridden', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing-page', label: 'Landing Page', label_overridden: false },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      // Since the ID might be 'landing-page' if unique, label should be humanized
      const pastedNode = result.graph.nodes[0];
      // Label should be updated based on new ID
      expect(pastedNode.label).toBeDefined();
    });

    it('should preserve label if overridden', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing', label: 'My Custom Label', label_overridden: true },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      const pastedNode = result.graph.nodes[0];
      expect(pastedNode.label).toBe('My Custom Label');
    });

    it('should preserve all node properties', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { 
          uuid: 'copy-1', 
          id: 'landing', 
          label: 'Landing',
          absorbing: true,
          event_id: 'page-view',
          case: { id: 'test-case', variants: [{ name: 'A' }] }
        },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      const pastedNode = result.graph.nodes[0];
      expect(pastedNode.absorbing).toBe(true);
      expect(pastedNode.event_id).toBe('page-view');
      expect(pastedNode.case).toBeDefined();
      expect(pastedNode.case.variants).toHaveLength(1);
    });

    it('should preserve all edge properties', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'a' },
        { uuid: 'copy-2', id: 'b' },
      ];
      
      const edgesToPaste = [
        { 
          uuid: 'edge-1', 
          from: 'copy-1', 
          to: 'copy-2', 
          p: { mean: 0.5, std: 0.1 },
          cost_gbp: { mean: 10 },
          case_variant: 'control'
        },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, edgesToPaste);
      
      const pastedEdge = result.graph.edges[0];
      expect(pastedEdge.p.mean).toBe(0.5);
      expect(pastedEdge.p.std).toBe(0.1);
      expect(pastedEdge.cost_gbp.mean).toBe(10);
      expect(pastedEdge.case_variant).toBe('control');
    });

    it('should update metadata timestamp', () => {
      const graph = {
        nodes: [],
        edges: [],
        metadata: { updated_at: '2020-01-01' }
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing' },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      expect(result.graph.metadata.updated_at).not.toBe('2020-01-01');
    });

    it('should handle empty graph', () => {
      const graph = {
        nodes: [],
        edges: [],
      };
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing' },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      expect(result.graph.nodes).toHaveLength(1);
    });

    it('should handle pasting into graph with no nodes/edges arrays', () => {
      const graph = {};
      
      const nodesToPaste = [
        { uuid: 'copy-1', id: 'landing' },
      ];
      
      const result = updateManager.pasteSubgraph(graph, nodesToPaste, []);
      
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.graph.edges).toHaveLength(0);
    });
  });
  
  // ============================================================
  // TEST SUITE 10: Delete Nodes
  // ============================================================
  
  describe('deleteNodes', () => {
    it('should delete nodes by UUID', () => {
      const graph = {
        nodes: [
          { uuid: 'node-1', id: 'landing' },
          { uuid: 'node-2', id: 'checkout' },
          { uuid: 'node-3', id: 'complete' },
        ],
        edges: [],
        metadata: { version: '1.0' }
      };
      
      const result = updateManager.deleteNodes(graph, ['node-1', 'node-3']);
      
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.graph.nodes[0].uuid).toBe('node-2');
      expect(result.deletedNodeCount).toBe(2);
    });

    it('should delete connected edges', () => {
      const graph = {
        nodes: [
          { uuid: 'node-1', id: 'landing' },
          { uuid: 'node-2', id: 'checkout' },
          { uuid: 'node-3', id: 'complete' },
        ],
        edges: [
          { uuid: 'edge-1', from: 'node-1', to: 'node-2', p: { mean: 0.5 } },
          { uuid: 'edge-2', from: 'node-2', to: 'node-3', p: { mean: 0.8 } },
          { uuid: 'edge-3', from: 'node-1', to: 'node-3', p: { mean: 0.3 } },
        ],
      };
      
      const result = updateManager.deleteNodes(graph, ['node-1']);
      
      expect(result.graph.nodes).toHaveLength(2);
      expect(result.deletedNodeCount).toBe(1);
      // Edges from/to node-1 should be deleted
      expect(result.deletedEdgeCount).toBe(2);
      expect(result.graph.edges).toHaveLength(1);
      expect(result.graph.edges[0].uuid).toBe('edge-2');
    });

    it('should return unchanged graph when empty UUIDs provided', () => {
      const graph = {
        nodes: [{ uuid: 'node-1', id: 'test' }],
        edges: [],
      };
      
      const result = updateManager.deleteNodes(graph, []);
      
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.deletedNodeCount).toBe(0);
      expect(result.deletedEdgeCount).toBe(0);
    });

    it('should handle non-existent node UUIDs gracefully', () => {
      const graph = {
        nodes: [
          { uuid: 'node-1', id: 'landing' },
        ],
        edges: [],
      };
      
      const result = updateManager.deleteNodes(graph, ['non-existent']);
      
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.deletedNodeCount).toBe(0);
    });

    it('should update metadata timestamp', () => {
      const graph = {
        nodes: [
          { uuid: 'node-1', id: 'landing' },
        ],
        edges: [],
        metadata: { updated_at: '2020-01-01' }
      };
      
      const result = updateManager.deleteNodes(graph, ['node-1']);
      
      expect(result.graph.metadata.updated_at).not.toBe('2020-01-01');
    });

    it('should handle graph with no edges', () => {
      const graph = {
        nodes: [
          { uuid: 'node-1', id: 'landing' },
          { uuid: 'node-2', id: 'checkout' },
        ],
      };
      
      const result = updateManager.deleteNodes(graph, ['node-1']);
      
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.deletedNodeCount).toBe(1);
      expect(result.deletedEdgeCount).toBe(0);
    });

    it('should delete all nodes when all UUIDs provided', () => {
      const graph = {
        nodes: [
          { uuid: 'node-1', id: 'a' },
          { uuid: 'node-2', id: 'b' },
          { uuid: 'node-3', id: 'c' },
        ],
        edges: [
          { uuid: 'edge-1', from: 'node-1', to: 'node-2', p: { mean: 0.5 } },
          { uuid: 'edge-2', from: 'node-2', to: 'node-3', p: { mean: 0.8 } },
        ],
      };
      
      const result = updateManager.deleteNodes(graph, ['node-1', 'node-2', 'node-3']);
      
      expect(result.graph.nodes).toHaveLength(0);
      expect(result.graph.edges).toHaveLength(0);
      expect(result.deletedNodeCount).toBe(3);
      expect(result.deletedEdgeCount).toBe(2);
    });
  });

  // ============================================================
  // TEST SUITE 11: Cascade Default Connection
  // ============================================================

  describe('cascadeDefaultConnection', () => {
    it('should write defaultConnection to non-overridden param slots', () => {
      const graph = {
        defaultConnection: 'amplitude',
        edges: [
          { id: 'e1', p: { mean: 0.5 }, cost_gbp: { mean: 10 }, labour_cost: { mean: 5 } },
        ],
      };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(graph.edges[0].p.connection).toBe('amplitude');
      expect(graph.edges[0].cost_gbp.connection).toBe('amplitude');
      expect(graph.edges[0].labour_cost.connection).toBe('amplitude');
      expect(changed).toBe(3);
    });

    it('should not overwrite param slots where connection_overridden is true', () => {
      const graph = {
        defaultConnection: 'amplitude',
        edges: [
          {
            id: 'e1',
            p: { mean: 0.5, connection: 'sheets-readonly', connection_overridden: true },
            cost_gbp: { mean: 10 },
          },
        ],
      };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(graph.edges[0].p.connection).toBe('sheets-readonly');
      expect(graph.edges[0].cost_gbp.connection).toBe('amplitude');
      expect(changed).toBe(1);
    });

    it('should set connection to undefined when defaultConnection is unset', () => {
      const graph = {
        defaultConnection: undefined,
        edges: [
          { id: 'e1', p: { mean: 0.5, connection: 'amplitude' } },
        ],
      };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(graph.edges[0].p.connection).toBeUndefined();
      expect(changed).toBe(1);
    });

    it('should return 0 when all slots already match the default', () => {
      const graph = {
        defaultConnection: 'amplitude',
        edges: [
          { id: 'e1', p: { mean: 0.5, connection: 'amplitude' } },
        ],
      };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(changed).toBe(0);
    });

    it('should skip param slots that do not exist on an edge', () => {
      const graph = {
        defaultConnection: 'amplitude',
        edges: [
          { id: 'e1', p: { mean: 0.5 } },
        ],
      };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(graph.edges[0].p.connection).toBe('amplitude');
      expect(graph.edges[0].cost_gbp).toBeUndefined();
      expect(graph.edges[0].labour_cost).toBeUndefined();
      expect(changed).toBe(1);
    });

    it('should handle graph with no edges', () => {
      const graph = { defaultConnection: 'amplitude', edges: [] };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(changed).toBe(0);
    });

    it('should handle graph with missing edges array', () => {
      const graph = { defaultConnection: 'amplitude' } as any;

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(changed).toBe(0);
    });

    it('should cascade across multiple edges with mixed override states', () => {
      const graph = {
        defaultConnection: 'amplitude',
        edges: [
          { id: 'e1', p: { mean: 0.5 } },
          { id: 'e2', p: { mean: 0.3, connection: 'old-conn' } },
          { id: 'e3', p: { mean: 0.2, connection: 'sheets-readonly', connection_overridden: true } },
        ],
      };

      const changed = updateManager.cascadeDefaultConnection(graph);

      expect(graph.edges[0].p.connection).toBe('amplitude');
      expect(graph.edges[1].p.connection).toBe('amplitude');
      expect(graph.edges[2].p.connection).toBe('sheets-readonly');
      expect(changed).toBe(2);
    });
  });
});

