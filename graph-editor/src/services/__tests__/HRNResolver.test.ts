/**
 * Tests for HRNResolver
 * 
 * Tests resolution of Human-Readable Names to UUIDs
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { resolveEdgeHRN, resolveNodeHRN, resolveConditionalHRN, resolveAllHRNs } from '../HRNResolver';
import { Graph } from '../../types';

// Mock graph data
const mockGraph: Graph = {
  nodes: [
    { uuid: 'node-uuid-1', id: 'checkout', label: 'Checkout Page' },
    { uuid: 'node-uuid-2', id: 'purchase', label: 'Purchase Complete' },
    { uuid: 'node-uuid-3', id: 'promo', label: 'Promo Banner' },
  ],
  edges: [
    { uuid: 'edge-uuid-1', id: 'checkout-to-purchase', from: 'node-uuid-1', to: 'node-uuid-2' },
    { uuid: 'edge-uuid-2', id: 'checkout-to-promo', from: 'node-uuid-1', to: 'node-uuid-3' },
  ],
  policies: {
    default_outcome: 'node-uuid-1'
  },
  metadata: {
    version: '1.0.0',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    description: 'Test Graph'
  }
};

describe('HRNResolver', () => {
  describe('resolveEdgeHRN', () => {
    it('resolves edge by direct ID', () => {
      const result = resolveEdgeHRN('e.checkout-to-purchase', mockGraph);
      expect(result).toBe('edge-uuid-1');
    });
    
    it('resolves edge by endpoints', () => {
      const result = resolveEdgeHRN('e.from(checkout).to(purchase)', mockGraph);
      expect(result).toBe('edge-uuid-1');
    });
    
    it('resolves edge by UUID selector', () => {
      const result = resolveEdgeHRN('e.uuid(edge-uuid-1)', mockGraph);
      expect(result).toBe('edge-uuid-1');
    });
    
    it('handles missing e. prefix', () => {
      const result = resolveEdgeHRN('checkout-to-purchase', mockGraph);
      expect(result).toBe('edge-uuid-1');
    });
    
    it('returns null for unresolved edge', () => {
      const result = resolveEdgeHRN('e.nonexistent', mockGraph);
      expect(result).toBeNull();
    });
    
    it('returns null for ambiguous endpoints (parallel edges)', () => {
      // Create graph with parallel edges
      const graphWithParallel: Graph = {
        ...mockGraph,
        edges: [
          { uuid: 'edge-uuid-1', id: 'checkout-to-purchase-1', from: 'node-uuid-1', to: 'node-uuid-2' },
          { uuid: 'edge-uuid-2', id: 'checkout-to-purchase-2', from: 'node-uuid-1', to: 'node-uuid-2' },
        ]
      };
      
      const result = resolveEdgeHRN('e.from(checkout).to(purchase)', graphWithParallel);
      expect(result).toBeNull();
    });
  });
  
  describe('resolveNodeHRN', () => {
    it('resolves node by direct ID', () => {
      const result = resolveNodeHRN('n.checkout', mockGraph);
      expect(result).toBe('node-uuid-1');
    });
    
    it('resolves node by name (case-insensitive)', () => {
      const result = resolveNodeHRN('n.checkout page', mockGraph);
      expect(result).toBe('node-uuid-1');
    });
    
    it('resolves node by UUID selector', () => {
      const result = resolveNodeHRN('n.uuid(node-uuid-1)', mockGraph);
      expect(result).toBe('node-uuid-1');
    });
    
    it('handles missing n. prefix', () => {
      const result = resolveNodeHRN('checkout', mockGraph);
      expect(result).toBe('node-uuid-1');
    });
    
    it('returns null for unresolved node', () => {
      const result = resolveNodeHRN('n.nonexistent', mockGraph);
      expect(result).toBeNull();
    });
  });
  
  describe('resolveConditionalHRN', () => {
    it('resolves visited condition', () => {
      const result = resolveConditionalHRN('visited(promo)', mockGraph);
      expect(result).toBe('visited(node-uuid-3)');
    });
    
    it('resolves negated visited condition', () => {
      const result = resolveConditionalHRN('!visited(promo)', mockGraph);
      expect(result).toBe('!visited(node-uuid-3)');
    });
    
    it('returns null for unresolved node', () => {
      const result = resolveConditionalHRN('visited(nonexistent)', mockGraph);
      expect(result).toBeNull();
    });
    
    it('returns input as-is for non-visited conditions', () => {
      const result = resolveConditionalHRN('some-other-condition', mockGraph);
      expect(result).toBe('some-other-condition');
    });
  });
  
  describe('resolveAllHRNs', () => {
    it('resolves all HRNs in params', () => {
      const params = {
        edges: {
          'checkout-to-purchase': {
            p: { mean: 0.5 }
          }
        },
        nodes: {
          'checkout': {
            entry: { entry_weight: 1.0 }
          }
        }
      };
      
      const { resolved, unresolved } = resolveAllHRNs(params, mockGraph);
      
      // resolveAllHRNs now prefers edge.id / node.id over UUIDs
      expect(resolved.edges['checkout-to-purchase']).toBeDefined();
      expect(resolved.nodes['checkout']).toBeDefined();
      expect(unresolved).toHaveLength(0);
    });
    
    it('tracks unresolved HRNs', () => {
      const params = {
        edges: {
          'nonexistent-edge': {
            p: { mean: 0.5 }
          }
        },
        nodes: {
          'nonexistent-node': {
            entry: { entry_weight: 1.0 }
          }
        }
      };
      
      const { resolved, unresolved } = resolveAllHRNs(params, mockGraph);
      
      expect(unresolved).toContain('edges.nonexistent-edge');
      expect(unresolved).toContain('nodes.nonexistent-node');
      expect(unresolved).toHaveLength(2);
    });
    
    it('keeps original keys for unresolved HRNs (with warning)', () => {
      const params = {
        edges: {
          'nonexistent-edge': {
            p: { mean: 0.5 }
          }
        }
      };
      
      const { resolved, unresolved } = resolveAllHRNs(params, mockGraph);
      
      // Keeps the original key even though unresolved
      expect(resolved.edges['nonexistent-edge']).toBeDefined();
      expect(unresolved).toContain('edges.nonexistent-edge');
    });
  });
});

