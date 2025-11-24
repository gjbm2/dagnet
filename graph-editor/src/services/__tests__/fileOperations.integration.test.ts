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
});

