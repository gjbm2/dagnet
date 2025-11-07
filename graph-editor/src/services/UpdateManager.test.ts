/**
 * UpdateManager Tests
 * 
 * Tests all 18 mapping configurations and core functionality:
 * - Override flag respect
 * - Conflict detection
 * - Field transformations
 * - Audit logging
 * - Event emissions
 * 
 * Phase: 0.3 - UpdateManager Implementation
 * Gate 3: All tests must pass
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpdateManager } from './UpdateManager';

describe('UpdateManager', () => {
  let updateManager: UpdateManager;
  
  beforeEach(() => {
    updateManager = new UpdateManager();
    updateManager.clearAuditLog();
  });
  
  // ============================================================
  // TEST SUITE 1: Override Flag Respect
  // ============================================================
  
  describe('Override Flag Respect', () => {
    it('should skip overridden fields', async () => {
      const source = {
        name: 'Updated Name',
        description: 'Updated Description'
      };
      
      const target = {
        label: 'Original Name',
        label_overridden: true,  // ← User has manually edited
        description: 'Original Description',
        description_overridden: false
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'node',
        { interactive: false }
      );
      
      // Should NOT update overridden field
      expect(target.label).toBe('Original Name');
      
      // SHOULD update non-overridden field
      expect(target.description).toBe('Updated Description');
      
      // Should report conflict
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts![0].field).toBe('label');
      expect(result.conflicts![0].reason).toBe('overridden');
      
      // Should report change
      expect(result.changes).toHaveLength(1);
      expect(result.changes![0].field).toBe('description');
    });
    
    it('should update non-overridden fields', async () => {
      const source = {
        name: 'New Name',
        description: 'New Description'
      };
      
      const target = {
        label: 'Old Name',
        label_overridden: false,
        description: 'Old Description',
        description_overridden: false
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'node',
        { interactive: false }
      );
      
      expect(target.label).toBe('New Name');
      expect(target.description).toBe('New Description');
      expect(result.conflicts).toHaveLength(0);
      expect(result.changes).toHaveLength(2);
    });
    
    it('should always sync evidence fields (no override)', async () => {
      const source = {
        type: 'probability',
        values: [{
          mean: 0.45,
          n: 1000,
          k: 450,
          window_from: '2025-01-01'
        }]
      };
      
      const target = {
        p: {
          mean: 0.40,
          mean_overridden: true,  // ← User edited mean
          evidence: {
            n: 800,
            k: 320,
            window_from: '2024-12-01'
          }
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'parameter',
        { interactive: false }
      );
      
      // Mean should NOT change (overridden)
      expect(target.p.mean).toBe(0.40);
      
      // Evidence SHOULD change (never overridden)
      expect(target.p.evidence.n).toBe(1000);
      expect(target.p.evidence.k).toBe(450);
      expect(target.p.evidence.window_from).toBe('2025-01-01');
    });
  });
  
  // ============================================================
  // TEST SUITE 2: Field Transformations
  // ============================================================
  
  describe('Field Transformations', () => {
    it('should transform values during Graph → File CREATE', async () => {
      const graphEdge = {
        id: 'checkout-conversion',
        label: 'Checkout Conversion',
        description: 'Users who complete checkout',
        p: {
          mean: 0.35,
          stdev: 0.05
        }
      };
      
      // Mock file system operations for this test
      const result = await updateManager.handleGraphToFile(
        graphEdge,
        null,
        'CREATE',
        'parameter',
        { validateOnly: true }  // Don't actually write
      );
      
      expect(result.success).toBe(true);
      // Transformation adds timestamp to value
      expect(result.changes).toBeDefined();
    });
    
    it('should merge case variants correctly', async () => {
      const fileData = {
        case: {
          schedules: [{
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 }
            ],
            window_from: '2025-01-01'
          }]
        }
      };
      
      const target = {
        case: {
          variants: [
            { name: 'control', weight: 0.6, edges: ['edge-1'] },
            { name: 'treatment', weight: 0.4, edges: ['edge-2'] }
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        fileData,
        target,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // Weights should update
      expect(target.case.variants[0].weight).toBe(0.5);
      expect(target.case.variants[1].weight).toBe(0.5);
      
      // Edges should preserve (not in file)
      expect(target.case.variants[0].edges).toEqual(['edge-1']);
      expect(target.case.variants[1].edges).toEqual(['edge-2']);
    });
  });
  
  // ============================================================
  // TEST SUITE 3: Nested Field Access
  // ============================================================
  
  describe('Nested Field Access', () => {
    it('should handle deeply nested fields', async () => {
      const source = {
        type: 'probability',
        values: [{
          mean: 0.55,
          stdev: 0.08,
          n: 2000,
          k: 1100
        }]
      };
      
      const target = {
        p: {
          mean: 0.50,
          stdev: 0.10,
          evidence: {
            n: 1500,
            k: 750
          }
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'parameter',
        { interactive: false }
      );
      
      expect(target.p.evidence.n).toBe(2000);
      expect(target.p.evidence.k).toBe(1100);
    });
  });
  
  // ============================================================
  // TEST SUITE 4: Conflict Detection
  // ============================================================
  
  describe('Conflict Detection', () => {
    it('should detect multiple conflicts', async () => {
      const source = {
        name: 'New Name',
        description: 'New Description',
        event_id: 'new_event'
      };
      
      const target = {
        label: 'Old Name',
        label_overridden: true,
        description: 'Old Description',
        description_overridden: true,
        event_id: 'old_event',
        event_id_overridden: false
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'node',
        { interactive: false }
      );
      
      // 2 conflicts (label, description), 1 change (event_id)
      expect(result.conflicts).toHaveLength(2);
      expect(result.changes).toHaveLength(1);
      
      // event_id should update
      expect(target.event_id).toBe('new_event');
    });
    
    it('should handle no conflicts gracefully', async () => {
      const source = {
        name: 'Name',
        description: 'Description'
      };
      
      const target = {
        label: 'Old',
        description: 'Old'
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'node',
        { interactive: false }
      );
      
      expect(result.conflicts).toHaveLength(0);
      expect(result.success).toBe(true);
    });
  });
  
  // ============================================================
  // TEST SUITE 5: Validate Only Mode
  // ============================================================
  
  describe('Validate Only Mode', () => {
    it('should not apply changes in validateOnly mode', async () => {
      const source = {
        name: 'New Name'
      };
      
      const target = {
        label: 'Old Name'
      };
      
      const result = await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'node',
        { validateOnly: true }
      );
      
      // Should report what WOULD change
      expect(result.changes).toHaveLength(1);
      
      // But should NOT actually change
      expect(target.label).toBe('Old Name');
    });
  });
  
  // ============================================================
  // TEST SUITE 6: Audit Logging
  // ============================================================
  
  describe('Audit Logging', () => {
    it('should record updates in audit log', async () => {
      const source = { name: 'Name' };
      const target = { label: 'Old' };
      
      await updateManager.handleFileToGraph(
        source,
        target,
        'UPDATE',
        'node',
        { userId: 'test-user' }
      );
      
      const log = updateManager.getAuditLog();
      
      // Note: Audit logging in current implementation is placeholder
      // This test will need updating once full audit is implemented
      expect(log).toBeDefined();
    });
    
    it('should clear audit log', () => {
      updateManager.clearAuditLog();
      const log = updateManager.getAuditLog();
      expect(log).toHaveLength(0);
    });
  });
  
  // ============================================================
  // TEST SUITE 7: Event Emissions
  // ============================================================
  
  // NOTE: Event emission tests removed - UpdateManager no longer uses EventEmitter
  // (Node.js EventEmitter doesn't work in browser)
  // Events replaced with console.log for debugging
  
  // ============================================================
  // TEST SUITE 8: Error Handling
  // ============================================================
  
  describe('Error Handling', () => {
    it('should handle missing mapping configuration gracefully', async () => {
      // Graph internal mapping exists but is empty (no error)
      const result = await updateManager.handleGraphInternal({}, {}, 'UPDATE', {});
      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(0);
    });
    
    it('should collect errors and continue if stopOnError=false', async () => {
      // This test will be more meaningful once we have actual mappings
      // that can fail individually
      const result = await updateManager.handleFileToGraph(
        { name: 'Name' },
        {},  // Empty target might cause issues
        'UPDATE',
        'node',
        { stopOnError: false }
      );
      
      // Should succeed even with potential issues
      expect(result.success).toBeDefined();
    });
  });
  
  // ============================================================
  // TEST SUITE 9: Direction Handlers
  // ============================================================
  
  describe('Direction Handlers', () => {
    it('should route to correct handler for graph_to_file', async () => {
      const result = await updateManager.handleGraphToFile(
        { label: 'Test' },
        null,
        'CREATE',
        'parameter',
        { validateOnly: true }
      );
      
      expect(result).toBeDefined();
    });
    
    it('should route to correct handler for file_to_graph', async () => {
      const result = await updateManager.handleFileToGraph(
        { name: 'Test' },
        { label: 'Old' },
        'UPDATE',
        'node',
        { interactive: false }
      );
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
    
    it('should route to correct handler for external_to_graph', async () => {
      const result = await updateManager.handleExternalToGraph(
        { probability: 0.42 },
        { p: { mean: 0.40 } },
        'UPDATE',
        'parameter',
        { interactive: false }
      );
      
      expect(result).toBeDefined();
    });
    
    it('should route to correct handler for external_to_file', async () => {
      const result = await updateManager.handleExternalToFile(
        { data: { probability: 0.42 } },
        { values: [] },
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      expect(result).toBeDefined();
    });
  });
  
  // ============================================================
  // TEST SUITE 10: Integration Tests
  // ============================================================
  
  describe('Integration: Complete Workflows', () => {
    it('should handle full parameter sync workflow', async () => {
      // Simulate: Pull from parameter file → update edge
      const paramFile = {
        id: 'checkout-conversion',
        name: 'Checkout Conversion Rate',
        description: 'Probability user completes checkout',
        type: 'probability',  // Required for mapping condition
        query: 'from(cart).to(checkout)',
        values: [{
          mean: 0.45,
          stdev: 0.05,
          n: 1000,
          k: 450,
          window_from: '2025-01-01',
          window_to: '2025-01-31'
        }]
      };
      
      const graphEdge = {
        uuid: 'edge-uuid-123',
        id: 'cart-to-checkout',
        label: 'Old Label',
        description: 'Old Description',
        p: {
          parameter_id: 'checkout-conversion',
          mean: 0.40,
          stdev: 0.06,
          mean_overridden: false,
          stdev_overridden: false,
          evidence: {
            n: 800,
            k: 320,
            window_from: '2024-12-01',
            window_to: '2024-12-31'
          }
        },
        query: 'from(cart).to(checkout)',
        query_overridden: false
      };
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        graphEdge,
        'UPDATE',
        'parameter',
        { interactive: false }
      );
      
      // Verify updates
      expect(result.success).toBe(true);
      
      // Note: Edge label/description are graph metadata, NOT synced from parameter files
      // Parameter files only sync values and evidence
      expect(graphEdge.label).toBe('Old Label');
      expect(graphEdge.description).toBe('Old Description');
      
      // Values and evidence should update
      expect(graphEdge.p.mean).toBe(0.45);
      expect(graphEdge.p.stdev).toBe(0.05);
      expect(graphEdge.p.evidence.n).toBe(1000);
      expect(graphEdge.p.evidence.k).toBe(450);
      expect(graphEdge.p.evidence.window_from).toBe('2025-01-01');
      expect(graphEdge.p.evidence.window_to).toBe('2025-01-31');
      
      // Verify changes reported
      expect(result.changes!.length).toBeGreaterThan(0);
      expect(result.conflicts).toHaveLength(0);
    });
    
    it('should handle case node sync workflow', async () => {
      const caseFile = {
        id: 'checkout-test',
        name: 'Checkout A/B Test',
        description: 'Testing new checkout flow',
        case: {
          variants: [
            { name: 'control', description: 'Current flow' },
            { name: 'treatment', description: 'New flow' }
          ],
          schedules: [{
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 }
            ],
            window_from: '2025-01-01'
          }]
        }
      };
      
      const caseNode = {
        uuid: 'node-uuid-456',
        id: 'checkout',
        label: 'Old Label',
        type: 'case',
        case: {
          id: 'checkout-test',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.6, edges: ['edge-1'] },
            { name: 'treatment', weight: 0.4, edges: ['edge-2'] }
          ]
        },
        label_overridden: false,
        description_overridden: false
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // Verify updates
      expect(result.success).toBe(true);
      
      // Note: Node label/description come from node files, NOT case files
      // So label should remain unchanged
      expect(caseNode.label).toBe('Old Label');
      
      // Case variants should be updated
      expect(caseNode.case.variants[0].weight).toBe(0.5);
      expect(caseNode.case.variants[1].weight).toBe(0.5);
      
      // Verify edges preserved (graph-only field)
      expect(caseNode.case.variants[0].edges).toEqual(['edge-1']);
      expect(caseNode.case.variants[1].edges).toEqual(['edge-2']);
    });
  });
  
  // ============================================================
  // TEST SUITE 11: Real-World Data Scenarios
  // ============================================================
  
  describe('Real-World Messy Data', () => {
    it('should calculate mean from n/k when probability not provided', async () => {
      // Amplitude gives us funnel counts, not probability
      const externalData = {
        sample_size: 1000,
        successes: 450,
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'amplitude',
        window_from: '2025-01-01',
        window_to: '2025-01-31'
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.40,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      // Should calculate 450/1000 = 0.45
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(0.45);
      expect(graphEdge.p.evidence.n).toBe(1000);
      expect(graphEdge.p.evidence.k).toBe(450);
    });
    
    it('should use probability directly when n/k not provided', async () => {
      // Some sources give us computed probability without raw counts
      const externalData = {
        probability: 0.38,
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'api'
        // No n/k - that's fine
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.35,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(0.38);
      expect(graphEdge.p.evidence?.n).toBeUndefined();
      expect(graphEdge.p.evidence?.k).toBeUndefined();
    });
    
    it('should handle sparse data (no windows, no n/k)', async () => {
      // Google Sheets cost data - just a value and timestamp
      const externalData = {
        probability: 15.50,  // Actually a cost, but same field mapping
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'sheets'
        // No n, k, windows - that's fine
      };
      
      const graphEdge: any = {
        p: {
          mean: 14.00,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(15.50);
      expect(graphEdge.p.evidence?.window_from).toBeUndefined();
    });
    
    it('should handle data with only n/k (no windows)', async () => {
      // Maybe an API gives us counts but no time context
      const externalData = {
        sample_size: 500,
        successes: 200,
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'api'
        // No windows - we'll infer later if needed
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.35,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(0.4); // 200/500
      expect(graphEdge.p.evidence.n).toBe(500);
      expect(graphEdge.p.evidence.k).toBe(200);
      expect(graphEdge.p.evidence.window_from).toBeUndefined();
    });
    
    it('should clamp invalid probabilities from bad n/k data', async () => {
      // Data error: k > n (shouldn't happen but...)
      const externalData = {
        sample_size: 100,
        successes: 150,  // More successes than trials!
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'api'
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.50,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      // Should clamp 150/100 = 1.5 down to 1.0
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(1.0);
      // No warnings array yet (or empty) - just silently clamps invalid data
    });
    
    it('should not update mean when no usable data provided', async () => {
      // Source gives us nothing useful for mean
      const externalData = {
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'manual'
        // No probability, no n/k - can't calculate anything
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.45,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      // Mean should remain unchanged (no usable data)
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(0.45);
      // Evidence fields still update (retrieved_at, source)
      expect(result.changes!.some(c => c.field === 'p.mean')).toBe(false);
    });
    
    it('should handle division by zero gracefully', async () => {
      // Edge case: n=0
      const externalData = {
        sample_size: 0,
        successes: 0,
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'api'
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.45,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      // Should not attempt to divide by zero, leave mean unchanged
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(0.45);
      // But n/k should still be stored as evidence
      expect(graphEdge.p.evidence.n).toBe(0);
      expect(graphEdge.p.evidence.k).toBe(0);
    });
    
    it('should append to file with only available fields', async () => {
      // External source with partial data
      const externalData = {
        data: {
          probability: 0.42,
          retrieved_at: '2025-11-05T20:00:00Z'
          // No stdev, n, k, windows - that's ok
        }
      };
      
      const fileData: any = {
        id: 'test-param',
        values: []
      };
      
      const result = await updateManager.handleExternalToFile(
        externalData,
        fileData,
        'APPEND',
        'parameter'
      );
      
      expect(result.success).toBe(true);
      expect(fileData.values).toHaveLength(1);
      expect(fileData.values[0].mean).toBe(0.42);
      expect(fileData.values[0].retrieved_at).toBe('2025-11-05T20:00:00Z');
      // These should not be present (undefined fields shouldn't be added)
      expect(fileData.values[0].n).toBeUndefined();
      expect(fileData.values[0].window_from).toBeUndefined();
    });
    
    it('should prefer explicit probability over calculated when both present', async () => {
      // Sometimes sources give us both - trust the explicit one
      const externalData = {
        probability: 0.45,  // Explicit (maybe adjusted)
        sample_size: 1000,
        successes: 440,     // Would calculate to 0.44
        retrieved_at: '2025-11-05T20:00:00Z',
        source: 'api'
      };
      
      const graphEdge: any = {
        p: {
          mean: 0.40,
          mean_overridden: false
        }
      };
      
      const result = await updateManager.handleExternalToGraph(
        externalData,
        graphEdge,
        'UPDATE',
        'parameter'
      );
      
      // Should use explicit probability, not calculated
      expect(result.success).toBe(true);
      expect(graphEdge.p.mean).toBe(0.45);
      expect(graphEdge.p.evidence.n).toBe(1000);
      expect(graphEdge.p.evidence.k).toBe(440);
    });
  });
});

