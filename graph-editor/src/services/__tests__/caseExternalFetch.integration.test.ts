/**
 * Case External Fetch Integration Tests
 * 
 * Tests for:
 * - External → Graph (Direct): Statsig/API fetch → node.case.variants
 * - External → File → Graph (Versioned): Fetch → append schedule → graph update
 * - Auto-rebalancing after external fetch
 * - Override handling during fetch
 * - Evidence population
 * 
 * CRITICAL GAP: These flows had ZERO test coverage previously.
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// Mock external dependencies
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op-id'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}));

// Import after mocks
import { UpdateManager, updateManager } from '../UpdateManager';
import { createTestNode, createTestCaseFile, createTestGraph } from './helpers/testFixtures';

// Local applyChanges helper (mirrors dataOperationsService internal function)
function applyChanges(target: any, changes: Array<{ field: string; newValue: any }>): void {
  for (const change of changes) {
    const parts = change.field.split('.');
    let current = target;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined) {
        current[part] = {};
      }
      current = current[part];
    }
    
    const lastPart = parts[parts.length - 1];
    current[lastPart] = change.newValue;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createCaseNode(options: {
  uuid?: string;
  id?: string;
  caseId?: string;
  variants?: Array<{ name: string; weight: number; weight_overridden?: boolean }>;
  connection?: string;
} = {}) {
  return createTestNode({
    uuid: options.uuid || 'case-node-uuid',
    id: options.id || 'case-node',
    type: 'case',
    case: {
      id: options.caseId || 'test-case',
      status: 'active',
      connection: options.connection || 'statsig-prod',
      variants: options.variants || [
        { name: 'control', weight: 0.5 },
        { name: 'treatment', weight: 0.5 }
      ]
    }
  });
}

function createExternalPayload(options: {
  variants: Array<{ name: string; weight: number }>;
  data_source?: any;
} = { variants: [] }) {
  return {
    variants: options.variants,
    data_source: options.data_source || {
      type: 'statsig',
      connection: 'statsig-prod',
      retrieved_at: new Date().toISOString()
    }
  };
}

// ============================================================================
// TEST SUITE 1: External → Graph (Direct) - UpdateManager
// ============================================================================

describe('Case External Fetch Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManager.clearAuditLog();
  });

  describe('handleExternalToGraph for cases', () => {
    it('should apply external variants to case node', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.3 },
          { name: 'treatment', weight: 0.7 }
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect(result.changes).toBeDefined();
      
      // Apply changes
      applyChanges(caseNode, result.changes || []);
      
      // Verify variants updated
      expect(caseNode.case!.variants[0].weight).toBe(0.3);
      expect(caseNode.case!.variants[1].weight).toBe(0.7);
    });

    it('should respect weight_overridden flag', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.6, weight_overridden: true },  // Should not change
          { name: 'treatment', weight: 0.4 }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.3 },
          { name: 'treatment', weight: 0.7 }
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Apply changes - the transform respects weight_overridden internally
      applyChanges(caseNode, result.changes || []);
      
      // Control should remain at 0.6 (overridden - transform respects this)
      expect(caseNode.case!.variants[0].weight).toBe(0.6);
      expect(caseNode.case!.variants[0].weight_overridden).toBe(true);
      
      // Treatment should be updated
      expect(caseNode.case!.variants[1].weight).toBe(0.7);
    });

    it('should only update existing variants by name match (not add new ones)', async () => {
      // External sources do NOT define variants - they only provide weights
      // that map to user-defined variants in the case file
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.33 },      // Matches - should update
          { name: 'treatment-a', weight: 0.33 },  // No match - ignored
          { name: 'treatment-b', weight: 0.34 }   // No match - ignored
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Apply changes
      applyChanges(caseNode, result.changes || []);
      
      // Should still have 2 variants (external doesn't add new ones)
      expect(caseNode.case!.variants).toHaveLength(2);
      
      // control updated to 0.33 (matched by name)
      expect(caseNode.case!.variants[0].weight).toBe(0.33);
      
      // treatment unchanged (no match for "treatment" in external payload)
      expect(caseNode.case!.variants[1].weight).toBe(0.5);
    });

    it('should populate evidence from external payload', async () => {
      const caseNode = createCaseNode();
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.4 },
          { name: 'treatment', weight: 0.6 }
        ],
        data_source: {
          type: 'statsig',
          connection: 'statsig-prod',
          retrieved_at: '2025-01-15T10:30:00Z',
          experiment_id: 'checkout_test_2025'
        }
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Apply changes
      applyChanges(caseNode, result.changes || []);
      
      // Check evidence is populated (data_source maps to case.evidence)
      expect(caseNode.case!.evidence).toBeDefined();
      expect(caseNode.case!.evidence?.source).toBe('statsig-prod');
      expect(caseNode.case!.evidence?.fetched_at).toBe('2025-01-15T10:30:00Z');
    });

    it('should flag requiresVariantRebalance when variants updated', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.7 },  // Changed
          { name: 'treatment', weight: 0.3 }
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect((result.metadata as any)?.requiresVariantRebalance).toBe(true);
    });
  });

  // ============================================================================
  // TEST SUITE 2: Rebalancing After External Fetch
  // ============================================================================

  describe('Auto-rebalance after external fetch', () => {
    it('should rebalance variants when one is updated and others need adjustment', async () => {
      const graph = {
        nodes: [
          createCaseNode({
            uuid: 'case-1',
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment-a', weight: 0.3 },
              { name: 'treatment-b', weight: 0.2 }
            ]
          })
        ],
        edges: []
      };
      
      // Simulate external update setting control to 0.6
      graph.nodes[0].case!.variants[0].weight = 0.6;
      
      // Rebalance from control (index 0)
      const result = updateManager.rebalanceVariantWeights(graph as any, 'case-1', 0, false);
      
      // Control stays at 0.6
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.6);
      
      // Others redistributed proportionally (0.4 remaining, split 3:2)
      expect(result.graph.nodes[0].case.variants[1].weight).toBeCloseTo(0.24, 10);
      expect(result.graph.nodes[0].case.variants[2].weight).toBeCloseTo(0.16, 10);
      
      // PMF sums to 1.0
      const total = result.graph.nodes[0].case.variants.reduce(
        (sum: number, v: any) => sum + v.weight, 0
      );
      expect(total).toBeCloseTo(1.0, 10);
    });

    it('should skip overridden variants during non-force rebalance', async () => {
      const graph = {
        nodes: [
          createCaseNode({
            uuid: 'case-1',
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment-a', weight: 0.3, weight_overridden: true },  // Should not change
              { name: 'treatment-b', weight: 0.2 }
            ]
          })
        ],
        edges: []
      };
      
      // Simulate external update setting control to 0.6
      graph.nodes[0].case!.variants[0].weight = 0.6;
      
      // Rebalance with forceRebalance=false
      const result = updateManager.rebalanceVariantWeights(graph as any, 'case-1', 0, false);
      
      // Control stays at 0.6
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.6);
      
      // treatment-a should remain at 0.3 (overridden)
      expect(result.graph.nodes[0].case.variants[1].weight).toBe(0.3);
      expect(result.graph.nodes[0].case.variants[1].weight_overridden).toBe(true);
      
      // treatment-b gets all remaining weight (0.4 - 0.3 = 0.1)
      expect(result.graph.nodes[0].case.variants[2].weight).toBeCloseTo(0.1, 10);
      
      // Report overridden count
      expect(result.overriddenCount).toBe(1);
    });
  });

  // ============================================================================
  // TEST SUITE 3: External → File (Schedule Append)
  // ============================================================================

  describe('handleGraphToFile for case schedules', () => {
    it('should append new schedule entry to case file', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.4 },
          { name: 'treatment', weight: 0.6 }
        ]
      });
      
      const caseFile = createTestCaseFile({
        id: 'test-case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: [],
          schedules: [
            {
              window_from: '2025-01-01T00:00:00Z',
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment', weight: 0.5 }
              ],
              source: 'manual'
            }
          ]
        }
      });
      
      const result = await updateManager.handleGraphToFile(
        caseNode,
        caseFile,
        'APPEND',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect(result.changes).toBeDefined();
      expect(result.changes!.length).toBeGreaterThan(0);
      
      // Verify schedule was appended
      const scheduleChange = result.changes?.find(c => c.field.includes('schedules'));
      expect(scheduleChange).toBeDefined();
      expect(scheduleChange?.newValue.variants).toHaveLength(2);
    });

    it('should include provenance in appended schedule', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.4 },
          { name: 'treatment', weight: 0.6 }
        ]
      });
      
      const caseFile = createTestCaseFile({
        id: 'test-case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: [],
          schedules: []
        }
      });
      
      const result = await updateManager.handleGraphToFile(
        caseNode,
        caseFile,
        'APPEND',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Check schedule has provenance
      const scheduleChange = result.changes?.find(c => c.field.includes('schedules'));
      expect(scheduleChange?.newValue).toHaveProperty('window_from');
      expect(scheduleChange?.newValue).toHaveProperty('source');
    });
  });

  // ============================================================================
  // TEST SUITE 4: Edge Cases and Error Handling
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty variants array from external source', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: []  // Empty - unusual but possible
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // Should succeed but with no changes
      expect(result.success).toBe(true);
    });

    it('should handle variant with zero weight', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 1.0 },
          { name: 'treatment', weight: 0.0 }  // Zero allocation
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Apply changes
      applyChanges(caseNode, result.changes || []);
      
      expect(caseNode.case!.variants[0].weight).toBe(1.0);
      expect(caseNode.case!.variants[1].weight).toBe(0.0);
    });

    it('should handle case node without existing variants (no-op)', async () => {
      // Note: Current mapping iterates over target.case.variants
      // If empty, external variants won't be added (no match by name)
      const caseNode = createTestNode({
        uuid: 'case-1',
        type: 'case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: []  // Empty
        }
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // Succeeds but no changes since no variants to update
      expect(result.success).toBe(true);
      
      // Variants remain empty (mapping only updates existing)
      expect(caseNode.case!.variants).toHaveLength(0);
    });

    it('should handle all variants having weight_overridden', async () => {
      const caseNode = createCaseNode({
        variants: [
          { name: 'control', weight: 0.6, weight_overridden: true },
          { name: 'treatment', weight: 0.4, weight_overridden: true }
        ]
      });
      
      const externalPayload = createExternalPayload({
        variants: [
          { name: 'control', weight: 0.3 },
          { name: 'treatment', weight: 0.7 }
        ]
      });
      
      const result = await updateManager.handleExternalToGraph(
        externalPayload,
        caseNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Apply changes - transform respects all override flags
      applyChanges(caseNode, result.changes || []);
      
      // Both remain unchanged (all overridden)
      expect(caseNode.case!.variants[0].weight).toBe(0.6);
      expect(caseNode.case!.variants[1].weight).toBe(0.4);
    });
  });
});

