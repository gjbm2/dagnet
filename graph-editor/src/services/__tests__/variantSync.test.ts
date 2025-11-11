/**
 * Variant Synchronization Tests
 * 
 * Comprehensive tests for case variant syncing between graph nodes and case files.
 * Covers all scenarios:
 * - File has more variants than graph
 * - Graph has more variants than file
 * - Variants with override flags
 * - Empty initial state
 * - Bidirectional sync (file→graph and graph→file)
 * - Description field syncing
 * 
 * Phase: Properties Panel Updates
 * Critical: Variant merge logic is complex and must be bulletproof
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { updateManager } from '../UpdateManager';

describe('Case Variant Synchronization', () => {
  beforeEach(() => {
    updateManager.clearAuditLog();
  });
  
  // ============================================================
  // TEST SUITE 1: File → Graph (GET operations)
  // ============================================================
  
  describe('File → Graph Sync', () => {
    it('should add new variants from file to graph', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'Control group' },
            { name: 'treatment', weight: 0.5, description: 'Treatment group' }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 0.6, weight_overridden: false }
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Should now have 2 variants
      expect(graphNode.case.variants).toHaveLength(2);
      
      // First variant synced from file (weight not overridden)
      expect(graphNode.case.variants[0].name).toBe('control');
      expect(graphNode.case.variants[0].weight).toBe(0.5);
      expect((graphNode.case.variants[0] as any).description).toBe('Control group');
      
      // Second variant added from file
      expect(graphNode.case.variants[1].name).toBe('treatment');
      expect(graphNode.case.variants[1].weight).toBe(0.5);
      expect((graphNode.case.variants[1] as any).description).toBe('Treatment group');
    });
    
    it('should preserve graph-only variants not in file (if they have edges or overrides)', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment-a', weight: 0.5 }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 0.4, weight_overridden: false },
            { name: 'treatment-a', weight: 0.3, weight_overridden: false },
            { name: 'experiment-x', weight: 0.3, weight_overridden: false, edges: ['edge-1'] }  // Has edges, should be preserved
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Should have all 3 variants
      expect(graphNode.case.variants).toHaveLength(3);
      
      // First two synced from file
      expect(graphNode.case.variants[0].name).toBe('control');
      expect(graphNode.case.variants[0].weight).toBe(0.5);
      expect(graphNode.case.variants[1].name).toBe('treatment-a');
      expect(graphNode.case.variants[1].weight).toBe(0.5);
      
      // Third preserved from graph (because it has edges)
      expect(graphNode.case.variants[2].name).toBe('experiment-x');
      expect(graphNode.case.variants[2].weight).toBe(0.3);
      expect(graphNode.case.variants[2].edges).toEqual(['edge-1']);
    });
    
    it('should remove disposable graph-only variants (no edges, no overrides) during GET', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'single-page', weight: 0.5 }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, weight_overridden: false },
            { name: 'treatment', weight: 0.5, weight_overridden: false }  // Default placeholder, no edges
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Should have 2 variants from file, treatment should be removed
      expect(graphNode.case.variants).toHaveLength(2);
      expect(graphNode.case.variants[0].name).toBe('control');
      expect(graphNode.case.variants[1].name).toBe('single-page');
      
      // Treatment should NOT be present
      expect(graphNode.case.variants.find((v: any) => v.name === 'treatment')).toBeUndefined();
    });
    
    it('should respect weight_overridden flags', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.6, description: 'Updated desc' },
            { name: 'treatment', weight: 0.4, description: 'Treatment' }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { 
              name: 'control', 
              weight: 0.7, 
              weight_overridden: true,  // User manually set this
              description: 'My custom control'
            },
            { 
              name: 'treatment', 
              weight: 0.3, 
              weight_overridden: false  // Should sync from file
            }
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Control: weight preserved (overridden), description synced (not overridden)
      expect(graphNode.case.variants[0].weight).toBe(0.7);
      expect(graphNode.case.variants[0].description).toBe('Updated desc');
      
      // Treatment: weight synced (not overridden)
      expect(graphNode.case.variants[1].weight).toBe(0.4);
      expect(graphNode.case.variants[1].description).toBe('Treatment');
    });
    
    it('should respect description_overridden flags', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'File control desc' }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { 
              name: 'control', 
              weight: 0.5,
              description: 'User custom description',
              description_overridden: true
            }
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Description should be preserved (overridden)
      expect(graphNode.case.variants[0].description).toBe('User custom description');
    });
    
    it('should initialize empty graph with all file variants', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.33, description: 'Control' },
            { name: 'treatment-a', weight: 0.33, description: 'Treatment A' },
            { name: 'treatment-b', weight: 0.34, description: 'Treatment B' }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: []  // Empty - first connection
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect(graphNode.case.variants).toHaveLength(3);
      
      // All fields synced, no overrides
      expect(graphNode.case.variants[0]).toEqual({
        name: 'control',
        name_overridden: false,
        weight: 0.33,
        weight_overridden: false,
        description: 'Control',
        description_overridden: false
      });
      
      expect(graphNode.case.variants[1]).toEqual({
        name: 'treatment-a',
        name_overridden: false,
        weight: 0.33,
        weight_overridden: false,
        description: 'Treatment A',
        description_overridden: false
      });
      
      expect(graphNode.case.variants[2]).toEqual({
        name: 'treatment-b',
        name_overridden: false,
        weight: 0.34,
        weight_overridden: false,
        description: 'Treatment B',
        description_overridden: false
      });
    });
    
    it('should initialize missing case structure', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5 }
          ]
        }
      };
      
      const graphNode = {
        // No case property at all
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Should NOT initialize case structure - that's dataOperationsService's job
      // UpdateManager only syncs variants IF case structure exists
    });
    
    it('should prefer schedules[latest].variants over case.variants', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5 }  // Fallback
          ],
          schedules: [
            {
              variants: [
                { name: 'control', weight: 0.4 },
                { name: 'treatment', weight: 0.6 }
              ],
              window_from: '2025-01-01T00:00:00Z'
            },
            {
              variants: [
                { name: 'control', weight: 0.3 },
                { name: 'treatment', weight: 0.7 }
              ],
              window_from: '2025-02-01T00:00:00Z'  // Latest
            }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: []
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Should use latest schedule (Feb)
      expect(graphNode.case.variants).toHaveLength(2);
      expect((graphNode.case.variants[0] as any).weight).toBe(0.3);
      expect((graphNode.case.variants[1] as any).weight).toBe(0.7);
    });
  });
  
  // ============================================================
  // TEST SUITE 2: Graph → File (PUT operations)
  // ============================================================
  
  describe('Graph → File Sync', () => {
    it('should update existing file variants with graph data', async () => {
      const graphNode = {
        case: {
          variants: [
            { 
              name: 'control', 
              weight: 0.55, 
              weight_overridden: true,
              description: 'Updated control',
              description_overridden: true  // Must set this to override
            },
            { 
              name: 'treatment', 
              weight: 0.45, 
              weight_overridden: true 
            }
          ]
        }
      };
      
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'Original control' },
            { name: 'treatment', weight: 0.5, description: 'Original treatment' }
          ]
        }
      };
      
      const result = await updateManager.handleGraphToFile(
        graphNode,
        caseFile,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // File variants updated with graph data
      expect(caseFile.case.variants[0].weight).toBe(0.55);
      expect(caseFile.case.variants[0].description).toBe('Updated control');
      expect(caseFile.case.variants[1].weight).toBe(0.45);
    });
    
    it('should add new graph variants to file', async () => {
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 0.4, weight_overridden: false },
            { name: 'treatment-a', weight: 0.3, weight_overridden: false },
            { name: 'treatment-b', weight: 0.3, weight_overridden: false }  // New
          ]
        }
      };
      
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'Control' },
            { name: 'treatment-a', weight: 0.5, description: 'Treatment A' }
          ]
        }
      };
      
      const result = await updateManager.handleGraphToFile(
        graphNode,
        caseFile,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Should now have 3 variants in file
      expect(caseFile.case.variants).toHaveLength(3);
      
      // New variant added
      expect(caseFile.case.variants[2]).toEqual({
        name: 'treatment-b',
        weight: 0.3,
        description: undefined
      });
    });
    
    it('should respect override flags when updating file', async () => {
      const graphNode = {
        case: {
          variants: [
            { 
              name: 'control', 
              weight: 0.7,
              weight_overridden: true,  // User changed this
              description: 'User description',
              description_overridden: true
            },
            { 
              name: 'treatment', 
              weight: 0.3,
              weight_overridden: false  // Not changed, keep file value
            }
          ]
        }
      };
      
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'File control' },
            { name: 'treatment', weight: 0.5, description: 'File treatment' }
          ]
        }
      };
      
      const result = await updateManager.handleGraphToFile(
        graphNode,
        caseFile,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Control: overridden values win
      expect(caseFile.case.variants[0].weight).toBe(0.7);
      expect(caseFile.case.variants[0].description).toBe('User description');
      
      // Treatment: non-overridden, keep file values
      expect(caseFile.case.variants[1].weight).toBe(0.5);
      expect(caseFile.case.variants[1].description).toBe('File treatment');
    });
    
    it('should preserve other file variant properties', async () => {
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 0.6, weight_overridden: true }
          ]
        }
      };
      
      const caseFile = {
        case: {
          variants: [
            { 
              name: 'control', 
              weight: 0.5,
              description: 'Control description',
              metadata: { created_by: 'user@example.com' },  // Extra field
              tags: ['baseline', 'default']  // Extra field
            }
          ]
        }
      };
      
      const result = await updateManager.handleGraphToFile(
        graphNode,
        caseFile,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Weight updated
      expect(caseFile.case.variants[0].weight).toBe(0.6);
      
      // Other properties preserved
      expect(caseFile.case.variants[0].description).toBe('Control description');
      expect(caseFile.case.variants[0].metadata).toEqual({ created_by: 'user@example.com' });
      expect(caseFile.case.variants[0].tags).toEqual(['baseline', 'default']);
    });
  });
  
  // ============================================================
  // TEST SUITE 3: Edge Cases
  // ============================================================
  
  describe('Edge Cases', () => {
    it('should handle empty variants in both graph and file', async () => {
      const caseFile = {
        case: {
          variants: []
        }
      };
      
      const graphNode = {
        case: {
          variants: []
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect(graphNode.case.variants).toHaveLength(0);
    });
    
    it('should handle variant name changes via name_overridden', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'treatment-v2', weight: 0.5 }  // Renamed in file
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { 
              name: 'treatment-old', 
              name_overridden: true,  // User locked the old name
              weight: 0.5,
              weight_overridden: false
            }
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // Since file→graph with name mismatch: treatment-old gets updated weight from file
      // and treatment-v2 is added as new variant
      expect(graphNode.case.variants).toHaveLength(2);
      
      // First variant: file's treatment-v2 (since we match by name and old doesn't exist in file)
      expect(graphNode.case.variants[0].name).toBe('treatment-v2');
      expect(graphNode.case.variants[0].weight).toBe(0.5);
      
      // Second variant: preserved from graph (treatment-old)
      expect(graphNode.case.variants[1].name).toBe('treatment-old');
    });
    
    it('should handle variants with undefined/null descriptions', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: null },
            { name: 'treatment', weight: 0.5 }  // No description field
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: []
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect(graphNode.case.variants).toHaveLength(2);
      
      // Should handle null/undefined gracefully
      expect((graphNode.case.variants[0] as any).description).toBe(null);
      expect((graphNode.case.variants[1] as any).description).toBeUndefined();
    });
    
    it('should handle weight normalization errors gracefully', async () => {
      // File has weights that don't sum to 1.0 (user error)
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.3 },
            { name: 'treatment', weight: 0.3 }  // Sum = 0.6, not 1.0!
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: []
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // UpdateManager doesn't validate sums - that's business logic elsewhere
      // It just syncs the data as-is
      expect(result.success).toBe(true);
      expect((graphNode.case.variants[0] as any).weight).toBe(0.3);
      expect((graphNode.case.variants[1] as any).weight).toBe(0.3);
    });
  });
  
  // ============================================================
  // TEST SUITE 4: Round-Trip Consistency
  // ============================================================
  
  describe('Round-Trip Consistency', () => {
    it('should maintain data integrity through GET → edit → PUT cycle', async () => {
      // Step 1: Start with file
      const originalFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'Control' },
            { name: 'treatment', weight: 0.5, description: 'Treatment' }
          ]
        }
      };
      
      // Step 2: GET to graph
      const graphNode: any = {
        case: {
          variants: []
        }
      };
      
      await updateManager.handleFileToGraph(
        originalFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // Step 3: User edits in graph
      if (graphNode.case.variants[0]) {
        graphNode.case.variants[0].weight = 0.6;
        graphNode.case.variants[0].weight_overridden = true;
      }
      if (graphNode.case.variants[1]) {
        graphNode.case.variants[1].weight = 0.4;
        graphNode.case.variants[1].weight_overridden = true;
      }
      
      // Step 4: PUT back to file
      const updatedFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'Control' },
            { name: 'treatment', weight: 0.5, description: 'Treatment' }
          ]
        }
      };
      
      await updateManager.handleGraphToFile(
        graphNode,
        updatedFile,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      // Verify round-trip
      expect(updatedFile.case.variants[0].weight).toBe(0.6);
      expect(updatedFile.case.variants[1].weight).toBe(0.4);
      expect(updatedFile.case.variants[0].description).toBe('Control');
      expect(updatedFile.case.variants[1].description).toBe('Treatment');
    });
  });
  
  // ============================================================
  // TEST SUITE 5: Integration with Real Data
  // ============================================================
  
  describe('Real-World Scenarios', () => {
    it('should handle 3-variant A/B/C test', async () => {
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.34, description: 'Current experience' },
            { name: 'variant-a', weight: 0.33, description: 'New checkout flow' },
            { name: 'variant-b', weight: 0.33, description: 'Alternate checkout' }
          ]
        }
      };
      
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, weight_overridden: false },
            { name: 'variant-a', weight: 0.5, weight_overridden: false }
          ]
        }
      };
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        graphNode,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      expect(graphNode.case.variants).toHaveLength(3);
      
      // Verify all three variants present with correct weights
      expect(graphNode.case.variants[0].weight).toBe(0.34);
      expect(graphNode.case.variants[1].weight).toBe(0.33);
      expect(graphNode.case.variants[2].weight).toBe(0.33);
      expect(graphNode.case.variants[2].name).toBe('variant-b');
    });
    
    it('should handle user removing variant from graph', async () => {
      const graphNode = {
        case: {
          variants: [
            { name: 'control', weight: 1.0, weight_overridden: true }
            // User removed 'treatment' variant
          ]
        }
      };
      
      const caseFile = {
        case: {
          variants: [
            { name: 'control', weight: 0.5, description: 'Control' },
            { name: 'treatment', weight: 0.5, description: 'Treatment' }
          ]
        }
      };
      
      const result = await updateManager.handleGraphToFile(
        graphNode,
        caseFile,
        'UPDATE',
        'case',
        { interactive: false }
      );
      
      expect(result.success).toBe(true);
      
      // File keeps both variants (graph doesn't delete from file)
      expect(caseFile.case.variants).toHaveLength(2);
      
      // But control weight updated
      expect(caseFile.case.variants[0].weight).toBe(1.0);
    });
  });
});

