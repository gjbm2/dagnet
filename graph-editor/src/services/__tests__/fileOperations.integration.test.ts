/**
 * File Operations Integration Tests
 * 
 * Tests actual file CRUD operations with real service instances
 * Only mocks IndexedDB and external dependencies
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileOperationsService } from '../fileOperationsService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// Mock IndexedDB
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      put: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          and: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([]),
          })),
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      toArray: vi.fn().mockResolvedValue([]),
    },
    workspaces: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

describe('File Operations Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear file registry
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('File Creation Workflows', () => {
    it('should create a file via fileRegistry', async () => {
      const file = await fileRegistry.getOrCreateFile(
        'parameter-test-param',
        'parameter',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/test-param.yaml',
        },
        { id: 'test-param', p: { mean: 0.5 } }
      );

      expect(file).toBeTruthy();
      expect(file.fileId).toBe('parameter-test-param');
      expect(file.type).toBe('parameter');
      expect(file.source?.path).toBe('parameters/test-param.yaml');
      
      // Should have saved to IndexedDB (uses add for new files)
      expect(db.files.add).toHaveBeenCalled();
      
      // Should be in file registry
      const retrieved = fileRegistry.getFile('parameter-test-param');
      expect(retrieved).toBe(file);
    });

    it('should create graph files with .json extension', async () => {
      // Mock getWorkspaceState to return a workspace
      fileOperationsService.setWorkspaceStateGetter(() => ({ repo: 'test-repo', branch: 'main' }));
      
      const { fileId, item } = await fileOperationsService.createFile('test-graph', 'graph', {
        openInTab: false,
      });

      expect(fileId).toBe('graph-test-graph');
      
      // CRITICAL: Graph files must have .json extension, not .yaml
      expect(item.path).toBe('graphs/test-graph.json');
      expect(item.name).toBe('test-graph.json');
      expect(item.path).not.toContain('.yaml');
      
      // Verify the file was created with correct path
      const file = fileRegistry.getFile(fileId);
      expect(file?.source?.path).toBe('graphs/test-graph.json');
    });

    it('should create parameter files with .yaml extension', async () => {
      fileOperationsService.setWorkspaceStateGetter(() => ({ repo: 'test-repo', branch: 'main' }));
      
      const { fileId, item } = await fileOperationsService.createFile('test-param', 'parameter', {
        openInTab: false,
      });

      expect(fileId).toBe('parameter-test-param');
      
      // Parameters should have .yaml extension
      expect(item.path).toBe('parameters/test-param.yaml');
      expect(item.name).toBe('test-param.yaml');
    });
  });

  describe('File Opening Workflows', () => {
    it('should load file into registry when accessed', async () => {
      const mockFile = {
        fileId: 'parameter-existing',
        type: 'parameter' as const,
        data: { id: 'existing', p: { mean: 0.5 } },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValueOnce(mockFile);

      // Load file into registry via getOrCreateFile
      await fileRegistry.getOrCreateFile(
        'parameter-existing',
        'parameter',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/existing.yaml',
        },
        { id: 'existing', p: { mean: 0.5 } }
      );
      
      // Should be in registry
      const file = fileRegistry.getFile('parameter-existing');
      expect(file).toBeTruthy();
      expect(file?.fileId).toBe('parameter-existing');
    });
  });

  describe('File Deletion Workflows', () => {
    it('should delete file from both registry and IndexedDB', async () => {
      // Set up a file in registry
      const mockFile = {
        fileId: 'parameter-to-delete',
        type: 'parameter' as const,
        data: { id: 'to-delete' },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (fileRegistry as any).files.set('parameter-to-delete', mockFile);

      const result = await fileOperationsService.deleteFile('parameter-to-delete', {
        force: true,
        skipConfirm: true,
      });

      expect(result).toBe(true);
      
      // Should have deleted from IndexedDB
      expect(db.files.delete).toHaveBeenCalled();
      
      // Should be removed from registry
      const file = fileRegistry.getFile('parameter-to-delete');
      expect(file).toBeUndefined();
    });

    it('should prevent deletion of dirty files without force', async () => {
      const dirtyFile = {
        fileId: 'parameter-dirty',
        type: 'parameter' as const,
        data: { id: 'dirty' },
        isDirty: true, // Dirty!
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (fileRegistry as any).files.set('parameter-dirty', dirtyFile);

      // Try to delete without force - should throw
      await expect(
        fileOperationsService.deleteFile('parameter-dirty', {
          force: false,
          skipConfirm: true,
        })
      ).rejects.toThrow('Cannot delete dirty file');

      // Should NOT have deleted from IndexedDB
      expect(db.files.delete).not.toHaveBeenCalled();
    });
  });

  describe('Index File Path Validation', () => {
    it('should store source paths correctly when creating files', async () => {
      // Test parameter file
      const paramFile = await fileRegistry.getOrCreateFile(
        'parameter-test',
        'parameter',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/test.yaml',
        },
        { id: 'test' }
      );

      expect(paramFile.source).toBeTruthy();
      expect(paramFile.source?.repository).toBe('test-repo');
      expect(paramFile.source?.branch).toBe('main');
      expect(paramFile.source?.path).toBe('parameters/test.yaml');
      
      // Test node file
      const nodeFile = await fileRegistry.getOrCreateFile(
        'node-test',
        'node',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'nodes/test.yaml',
        },
        { id: 'test' }
      );

      expect(nodeFile.source?.path).toBe('nodes/test.yaml');
      
      // Test graph file
      const graphFile = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        { nodes: [], edges: [] }
      );

      expect(graphFile.source?.path).toBe('graphs/test.json');
    });
  });

  describe('Dirty State Management', () => {
    it('should mark file as dirty when data changes', async () => {
      const originalFile = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        data: { id: 'test', p: { mean: 0.5 } },
        originalData: { id: 'test', p: { mean: 0.5 } },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (fileRegistry as any).files.set('parameter-test', originalFile);

      // Simulate data change
      const file = fileRegistry.getFile('parameter-test');
      if (file) {
        file.data.p.mean = 0.7; // Change value
        file.isDirty = true;
        await db.files.put(file);
      }

      const updatedFile = fileRegistry.getFile('parameter-test');
      expect(updatedFile?.isDirty).toBe(true);
      expect(updatedFile?.data.p.mean).toBe(0.7);
    });
  });

  describe('File Registry Operations', () => {
    it('should track open files in memory', async () => {
      const file = {
        fileId: 'graph-test',
        type: 'graph' as const,
        data: { nodes: [], edges: [] },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (fileRegistry as any).files.set('graph-test', file);

      const retrieved = fileRegistry.getFile('graph-test');
      expect(retrieved).toBe(file);
    });

    it('should handle missing files gracefully', () => {
      const file = fileRegistry.getFile('nonexistent');
      expect(file).toBeUndefined();
    });

    it('should get all dirty files', () => {
      const dirtyFile = {
        fileId: 'parameter-dirty',
        type: 'parameter' as const,
        data: {},
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      const cleanFile = {
        fileId: 'parameter-clean',
        type: 'parameter' as const,
        data: {},
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (fileRegistry as any).files.set('parameter-dirty', dirtyFile);
      (fileRegistry as any).files.set('parameter-clean', cleanFile);

      const dirtyFiles = fileRegistry.getDirtyFiles();
      
      expect(dirtyFiles).toHaveLength(1);
      expect(dirtyFiles[0].fileId).toBe('parameter-dirty');
    });
  });

  describe('Error Handling', () => {
    it('should handle IndexedDB errors gracefully', async () => {
      // Mock add to throw error (getOrCreateFile uses add for new files)
      (db.files.add as any).mockRejectedValueOnce(new Error('IndexedDB quota exceeded'));

      await expect(
        fileRegistry.getOrCreateFile(
          'parameter-test',
          'parameter',
          {
            repository: 'test-repo',
            branch: 'main',
            path: 'parameters/test.yaml',
          },
          { id: 'test' }
        )
      ).rejects.toThrow('quota');
    });

    it('should handle file not found errors', async () => {
      (db.files.get as any).mockResolvedValueOnce(null);

      const result = await fileOperationsService.openFile({
        id: 'missing',
        type: 'parameter',
        name: 'missing.yaml',
        path: 'parameters/missing.yaml',
        isLocal: false,
      });

      // Should handle missing file gracefully
      expect(result).toBeNull();
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle multiple simultaneous file creations', async () => {
      const files = [
        { fileId: 'param-1', data: { id: 'p1' } },
        { fileId: 'param-2', data: { id: 'p2' } },
        { fileId: 'param-3', data: { id: 'p3' } },
      ];

      (db.files.get as any).mockResolvedValue(null); // Files don't exist yet

      const creates = files.map(f => 
        fileRegistry.getOrCreateFile(
          f.fileId,
          'parameter',
          {
            repository: 'test-repo',
            branch: 'main',
            path: `parameters/${f.fileId}.yaml`,
          },
          f.data
        )
      );

      const results = await Promise.all(creates);

      // All should succeed
      expect(results.length).toBe(3);
      expect(results.every(r => r !== null)).toBe(true);
      
      // All should be in registry
      files.forEach(f => {
        expect(fileRegistry.getFile(f.fileId)).toBeTruthy();
      });
    });
  });

  describe('File Rename Operations', () => {
    beforeEach(() => {
      // Set workspace state for rename operations
      fileOperationsService.setWorkspaceStateGetter(() => ({ repo: 'test-repo', branch: 'main' }));
    });

    it('should rename a graph file (simple rename, no reference updates)', async () => {
      // Create a graph file
      const graphFile = {
        fileId: 'graph-old-name',
        type: 'graph' as const,
        name: 'old-name.json',
        data: { 
          nodes: [{ uuid: '1', id: 'start', label: 'Start' }], 
          edges: [],
          metadata: { name: 'old-name' }
        },
        originalData: { nodes: [], edges: [] },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/old-name.json'
        }
      };

      (fileRegistry as any).files.set('graph-old-name', graphFile);

      const result = await fileOperationsService.renameFile('graph-old-name', 'new-name');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(0); // Graphs don't have references to update

      // Old file should be gone
      expect(fileRegistry.getFile('graph-old-name')).toBeUndefined();

      // New file should exist
      const newFile = fileRegistry.getFile('graph-new-name');
      expect(newFile).toBeTruthy();
      expect(newFile?.source?.path).toBe('graphs/new-name.json');
    });

    it('should rename a parameter file and update its id', async () => {
      // Create a parameter file
      const paramFile = {
        fileId: 'parameter-old-param',
        type: 'parameter' as const,
        name: 'old-param.yaml',
        data: { 
          id: 'old-param', 
          name: 'old-param',
          type: 'probability',
          values: [{ mean: 0.5 }],
          metadata: { updated_at: '2024-01-01' }
        },
        originalData: { id: 'old-param', values: [{ mean: 0.5 }] },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/old-param.yaml'
        }
      };

      (fileRegistry as any).files.set('parameter-old-param', paramFile);

      const result = await fileOperationsService.renameFile('parameter-old-param', 'new-param');

      expect(result.success).toBe(true);

      // Old file should be gone
      expect(fileRegistry.getFile('parameter-old-param')).toBeUndefined();

      // New file should exist with updated id
      const newFile = fileRegistry.getFile('parameter-new-param');
      expect(newFile).toBeTruthy();
      expect(newFile?.data.id).toBe('new-param');
      expect(newFile?.data.name).toBe('new-param');
      expect(newFile?.source?.path).toBe('parameters/new-param.yaml');
    });

    it('should update references in graph files when renaming a parameter', async () => {
      // Create a parameter file
      const paramFile = {
        fileId: 'parameter-checkout-rate',
        type: 'parameter' as const,
        name: 'checkout-rate.yaml',
        data: { 
          id: 'checkout-rate', 
          name: 'checkout-rate',
          type: 'probability',
          values: [{ mean: 0.5 }]
        },
        originalData: { id: 'checkout-rate' },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/checkout-rate.yaml'
        }
      };

      // Create a graph file that references this parameter
      const graphFile = {
        fileId: 'graph-funnel',
        type: 'graph' as const,
        name: 'funnel.json',
        data: { 
          nodes: [
            { uuid: '1', id: 'cart', label: 'Cart' },
            { uuid: '2', id: 'checkout', label: 'Checkout' }
          ], 
          edges: [
            { 
              uuid: 'e1', 
              id: 'cart-to-checkout',
              from: '1', 
              to: '2', 
              p: { 
                mean: 0.5,
                id: 'checkout-rate' // Reference to parameter
              }
            }
          ],
          metadata: { name: 'funnel' }
        },
        originalData: { nodes: [], edges: [] },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/funnel.json'
        }
      };

      (fileRegistry as any).files.set('parameter-checkout-rate', paramFile);
      (fileRegistry as any).files.set('graph-funnel', graphFile);

      const result = await fileOperationsService.renameFile('parameter-checkout-rate', 'conversion-rate');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(1); // One graph was updated

      // Check graph was updated with new reference
      const updatedGraph = fileRegistry.getFile('graph-funnel');
      expect(updatedGraph?.data.edges[0].p.id).toBe('conversion-rate');
    });

    it('should update case references in graphs when renaming a case', async () => {
      // Create a case file
      const caseFile = {
        fileId: 'case-old-experiment',
        type: 'case' as const,
        name: 'old-experiment.yaml',
        data: { 
          id: 'old-experiment', 
          name: 'old-experiment',
          parameter_type: 'case',
          case: {
            status: 'active',
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 }
            ]
          }
        },
        originalData: { id: 'old-experiment' },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'cases/old-experiment.yaml'
        }
      };

      // Create a graph with case references
      const graphFile = {
        fileId: 'graph-ab-test',
        type: 'graph' as const,
        name: 'ab-test.json',
        data: { 
          nodes: [
            { 
              uuid: '1', 
              id: 'gate', 
              label: 'AB Test Gate',
              case: { id: 'old-experiment', status: 'active', variants: [] }
            }
          ], 
          edges: [
            { 
              uuid: 'e1',
              from: '1', 
              to: '2',
              case_id: 'old-experiment',
              case_variant: 'treatment'
            }
          ],
          metadata: { name: 'ab-test' }
        },
        originalData: { nodes: [], edges: [] },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/ab-test.json'
        }
      };

      (fileRegistry as any).files.set('case-old-experiment', caseFile);
      (fileRegistry as any).files.set('graph-ab-test', graphFile);

      const result = await fileOperationsService.renameFile('case-old-experiment', 'new-experiment');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(1);

      // Check graph was updated with new case references
      const updatedGraph = fileRegistry.getFile('graph-ab-test');
      expect(updatedGraph?.data.nodes[0].case.id).toBe('new-experiment');
      expect(updatedGraph?.data.edges[0].case_id).toBe('new-experiment');
    });

    it('should update event_id references in graphs when renaming an event', async () => {
      // Create an event file
      const eventFile = {
        fileId: 'event-old-click',
        type: 'event' as const,
        name: 'old-click.yaml',
        data: { 
          id: 'old-click', 
          name: 'old-click',
          event_type: 'interaction'
        },
        originalData: { id: 'old-click' },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'events/old-click.yaml'
        }
      };

      // Create a graph with event_id reference
      const graphFile = {
        fileId: 'graph-events',
        type: 'graph' as const,
        name: 'events.json',
        data: { 
          nodes: [
            { 
              uuid: '1', 
              id: 'button', 
              label: 'Button Click',
              event_id: 'old-click'
            }
          ], 
          edges: [],
          metadata: { name: 'events' }
        },
        originalData: { nodes: [], edges: [] },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/events.json'
        }
      };

      (fileRegistry as any).files.set('event-old-click', eventFile);
      (fileRegistry as any).files.set('graph-events', graphFile);

      const result = await fileOperationsService.renameFile('event-old-click', 'new-click');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(1);

      // Check graph was updated with new event reference
      const updatedGraph = fileRegistry.getFile('graph-events');
      expect(updatedGraph?.data.nodes[0].event_id).toBe('new-click');
    });

    it('should fail to rename if target name already exists', async () => {
      // Create two files
      const file1 = {
        fileId: 'parameter-source',
        type: 'parameter' as const,
        data: { id: 'source' },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/source.yaml' }
      };

      const file2 = {
        fileId: 'parameter-target',
        type: 'parameter' as const,
        data: { id: 'target' },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/target.yaml' }
      };

      (fileRegistry as any).files.set('parameter-source', file1);
      (fileRegistry as any).files.set('parameter-target', file2);

      const result = await fileOperationsService.renameFile('parameter-source', 'target');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should fail to rename if file does not exist', async () => {
      const result = await fileOperationsService.renameFile('parameter-nonexistent', 'new-name');

      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found');
    });

    it('should fail to rename with invalid characters', async () => {
      const file = {
        fileId: 'parameter-valid',
        type: 'parameter' as const,
        data: { id: 'valid' },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/valid.yaml' }
      };

      (fileRegistry as any).files.set('parameter-valid', file);

      const result = await fileOperationsService.renameFile('parameter-valid', 'invalid name!');

      expect(result.success).toBe(false);
      expect(result.error).toContain('letters, numbers, hyphens, and underscores');
    });

    it('should succeed with no-op when renaming to same name', async () => {
      const file = {
        fileId: 'parameter-same',
        type: 'parameter' as const,
        data: { id: 'same' },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/same.yaml' }
      };

      (fileRegistry as any).files.set('parameter-same', file);

      const result = await fileOperationsService.renameFile('parameter-same', 'same');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(0);
      
      // Original file should still exist
      expect(fileRegistry.getFile('parameter-same')).toBeTruthy();
    });

    it('should update cost parameter references', async () => {
      // Create a parameter used as a cost
      const costParam = {
        fileId: 'parameter-shipping-cost',
        type: 'parameter' as const,
        data: { id: 'shipping-cost', type: 'cost_gbp' },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/shipping-cost.yaml' }
      };

      // Create a graph with cost references
      const graphFile = {
        fileId: 'graph-costs',
        type: 'graph' as const,
        data: { 
          nodes: [],
          edges: [
            { 
              uuid: 'e1',
              from: '1',
              to: '2',
              cost_gbp: { mean: 10, id: 'shipping-cost' },
              labour_cost: { mean: 2, id: 'shipping-cost' }
            }
          ],
          metadata: { name: 'costs' }
        },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'graphs/costs.json' }
      };

      (fileRegistry as any).files.set('parameter-shipping-cost', costParam);
      (fileRegistry as any).files.set('graph-costs', graphFile);

      const result = await fileOperationsService.renameFile('parameter-shipping-cost', 'delivery-cost');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(1);

      const updatedGraph = fileRegistry.getFile('graph-costs');
      expect(updatedGraph?.data.edges[0].cost_gbp.id).toBe('delivery-cost');
      expect(updatedGraph?.data.edges[0].labour_cost.id).toBe('delivery-cost');
    });

    it('should update conditional probability references', async () => {
      // Create a parameter
      const param = {
        fileId: 'parameter-conditional-rate',
        type: 'parameter' as const,
        data: { id: 'conditional-rate', type: 'probability' },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/conditional-rate.yaml' }
      };

      // Create a graph with conditional probability references
      const graphFile = {
        fileId: 'graph-conditional',
        type: 'graph' as const,
        data: { 
          nodes: [],
          edges: [
            { 
              uuid: 'e1',
              from: '1',
              to: '2',
              p: { mean: 0.3 },
              conditional_p: [
                {
                  condition: 'visited(promo)',
                  p: { mean: 0.7, id: 'conditional-rate' }
                }
              ]
            }
          ],
          metadata: { name: 'conditional' }
        },
        isDirty: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'graphs/conditional.json' }
      };

      (fileRegistry as any).files.set('parameter-conditional-rate', param);
      (fileRegistry as any).files.set('graph-conditional', graphFile);

      const result = await fileOperationsService.renameFile('parameter-conditional-rate', 'promo-rate');

      expect(result.success).toBe(true);
      expect(result.updatedReferences).toBe(1);

      const updatedGraph = fileRegistry.getFile('graph-conditional');
      expect(updatedGraph?.data.edges[0].conditional_p[0].p.id).toBe('promo-rate');
    });

    describe('Git Integration', () => {
      it('should stage old file for deletion when renaming a committed file', async () => {
        // Clear any pending deletions first
        (fileRegistry as any).pendingFileDeletions = [];

        // Create a committed file (has SHA)
        const committedFile = {
          fileId: 'parameter-committed',
          type: 'parameter' as const,
          name: 'committed.yaml',
          data: { id: 'committed', type: 'probability' },
          originalData: { id: 'committed' },
          isDirty: false,
          viewTabs: [],
          lastModified: Date.now(),
          sha: 'abc123def456', // Has SHA = committed to Git
          path: 'parameters/committed.yaml',
          source: { 
            repository: 'test-repo', 
            branch: 'main', 
            path: 'parameters/committed.yaml' 
          }
        };

        (fileRegistry as any).files.set('parameter-committed', committedFile);

        const result = await fileOperationsService.renameFile('parameter-committed', 'renamed');

        expect(result.success).toBe(true);

        // Old file should be staged for deletion
        const pendingDeletions = fileRegistry.getPendingDeletions();
        expect(pendingDeletions.length).toBe(1);
        expect(pendingDeletions[0].path).toBe('parameters/committed.yaml');
        expect(pendingDeletions[0].fileId).toBe('parameter-committed');
      });

      it('should mark new file as dirty after rename', async () => {
        const file = {
          fileId: 'parameter-to-rename',
          type: 'parameter' as const,
          data: { id: 'to-rename' },
          originalData: { id: 'to-rename' },
          isDirty: false,
          viewTabs: [],
          lastModified: Date.now(),
          source: { repository: 'test-repo', branch: 'main', path: 'parameters/to-rename.yaml' }
        };

        (fileRegistry as any).files.set('parameter-to-rename', file);

        await fileOperationsService.renameFile('parameter-to-rename', 'renamed');

        // New file should be marked dirty (ready for commit)
        const newFile = fileRegistry.getFile('parameter-renamed');
        expect(newFile).toBeTruthy();
        expect(newFile?.isDirty).toBe(true);
      });

      it('should mark files with updated references as dirty', async () => {
        // Create a parameter
        const param = {
          fileId: 'parameter-ref-target',
          type: 'parameter' as const,
          data: { id: 'ref-target' },
          originalData: { id: 'ref-target' },
          isDirty: false,
          viewTabs: [],
          lastModified: Date.now(),
          source: { repository: 'test-repo', branch: 'main', path: 'parameters/ref-target.yaml' }
        };

        // Create a graph that references it (starts clean)
        const graph = {
          fileId: 'graph-referencing',
          type: 'graph' as const,
          data: { 
            nodes: [],
            edges: [{ uuid: 'e1', from: '1', to: '2', p: { mean: 0.5, id: 'ref-target' } }],
            metadata: {}
          },
          originalData: { 
            nodes: [],
            edges: [{ uuid: 'e1', from: '1', to: '2', p: { mean: 0.5, id: 'ref-target' } }],
            metadata: {}
          },
          isDirty: false,
          viewTabs: [],
          lastModified: Date.now(),
          source: { repository: 'test-repo', branch: 'main', path: 'graphs/referencing.json' }
        };

        (fileRegistry as any).files.set('parameter-ref-target', param);
        (fileRegistry as any).files.set('graph-referencing', graph);

        const result = await fileOperationsService.renameFile('parameter-ref-target', 'new-target');

        expect(result.success).toBe(true);
        expect(result.updatedReferences).toBe(1);

        // Graph should now be dirty because its references were updated
        const updatedGraph = fileRegistry.getFile('graph-referencing');
        expect(updatedGraph?.isDirty).toBe(true);
      });

      it('should NOT stage deletion for local-only files (no SHA)', async () => {
        (fileRegistry as any).pendingFileDeletions = [];

        // Create a local-only file (no SHA = never committed)
        const localFile = {
          fileId: 'parameter-local-only',
          type: 'parameter' as const,
          data: { id: 'local-only' },
          originalData: { id: 'local-only' },
          isDirty: false,
          isLocal: true,
          viewTabs: [],
          lastModified: Date.now(),
          // No SHA - never committed
          source: { repository: 'local', branch: 'main', path: 'parameters/local-only.yaml' }
        };

        (fileRegistry as any).files.set('parameter-local-only', localFile);

        await fileOperationsService.renameFile('parameter-local-only', 'renamed-local');

        // Should NOT stage any deletions (file was never on Git)
        const pendingDeletions = fileRegistry.getPendingDeletions();
        expect(pendingDeletions.length).toBe(0);
      });
    });
  });
});

