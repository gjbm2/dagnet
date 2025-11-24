/**
 * Critical Index Rebuild Tests
 * 
 * Tests the exact bugs we just fixed:
 * 1. Index entries persist after rebuild (workspace prefix)
 * 2. Dirty index files are committable (no open tabs needed)
 * 3. No orphans after rebuild
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexRebuildService } from '../indexRebuildService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// Mock IndexedDB
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      put: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      toArray: vi.fn().mockResolvedValue([]),
    },
    workspaces: {
      get: vi.fn().mockResolvedValue({
        id: 'test-repo-main',
        repository: 'test-repo',
        branch: 'main',
        lastSynced: Date.now(),
      }),
    },
  },
}));

describe('Index Rebuild - Critical Bug Fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('BUG FIX: Index files with workspace prefix', () => {
    it('should save index files with workspace prefix to IndexedDB', async () => {
      const mockFile = {
        fileId: 'test-repo-main-node-test', // Workspace-prefixed file
        type: 'node' as const,
        data: { id: 'test', name: 'Test Node' },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'nodes/test.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null); // No existing index

      await IndexRebuildService.ensureFileInIndex(mockFile, 'node');

      // Verify index was saved with workspace prefix
      const putCalls = (db.files.put as any).mock.calls;
      const indexFile = putCalls.find((call: any) => 
        call[0].fileId.includes('node-index')
      );

      expect(indexFile).toBeTruthy();
      expect(indexFile[0].fileId).toBe('test-repo-main-node-index'); // Must have workspace prefix
      expect(indexFile[0].path).toBe('nodes-index.yaml'); // But path is still plural at root
    });

    it('should handle local files without workspace prefix', async () => {
      const localFile = {
        fileId: 'parameter-local-test', // No workspace prefix
        type: 'parameter' as const,
        data: { id: 'local-test', name: 'Local Test' },
        source: {
          repository: 'local',
          branch: 'main',
          path: 'parameters/local-test.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null);

      await IndexRebuildService.ensureFileInIndex(localFile, 'parameter');

      const putCalls = (db.files.put as any).mock.calls;
      const indexFile = putCalls.find((call: any) => 
        call[0].fileId.includes('parameter-index')
      );

      expect(indexFile).toBeTruthy();
      expect(indexFile[0].fileId).toBe('parameter-index'); // No workspace prefix for local
    });
  });

  describe('BUG FIX: First entry not added to new index', () => {
    it('should add entry to newly created index (not return early)', async () => {
      const mockFile = {
        fileId: 'test-repo-main-node-first',
        type: 'node' as const,
        data: { id: 'first', name: 'First Node' },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'nodes/first.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null); // No existing index

      await IndexRebuildService.ensureFileInIndex(mockFile, 'node');

      // Verify index was created AND entry was added
      const putCalls = (db.files.put as any).mock.calls;
      expect(putCalls.length).toBeGreaterThan(0);
      
      const indexFile = putCalls[putCalls.length - 1][0]; // Last put call
      expect(indexFile.data.nodes).toBeDefined();
      expect(indexFile.data.nodes.length).toBe(1); // Entry was added!
      expect(indexFile.data.nodes[0].id).toBe('first');
      expect(indexFile.data.nodes[0].name).toBe('First Node');
    });
  });

  describe('BUG FIX: FileRegistry not updated after index modification', () => {
    it('should update FileRegistry when adding entry to index', async () => {
      const existingIndex = {
        fileId: 'parameter-index',
        type: 'parameter' as const,
        data: {
          version: '1.0.0',
          parameters: [
            { id: 'existing', file_path: 'parameters/existing.yaml', name: 'Existing' },
          ],
        },
        path: 'parameters-index.yaml',
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters-index.yaml' },
      };

      const newFile = {
        fileId: 'test-repo-main-parameter-new',
        type: 'parameter' as const,
        data: { id: 'new', name: 'New Parameter' },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/new.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      // Set existing index in FileRegistry
      (fileRegistry as any).files.set('parameter-index', existingIndex);
      (db.files.get as any).mockResolvedValue({
        ...existingIndex,
        fileId: 'test-repo-main-parameter-index',
      });

      await IndexRebuildService.ensureFileInIndex(newFile, 'parameter');

      // Verify FileRegistry was updated
      const updatedIndex = fileRegistry.getFile('parameter-index');
      expect(updatedIndex).toBeTruthy();
      expect(updatedIndex?.data.parameters).toHaveLength(2);
      expect(updatedIndex?.data.parameters.some((p: any) => p.id === 'new')).toBe(true);
    });
  });

  describe('BUG FIX: Dirty files committable without open tabs', () => {
    it('should mark index files as dirty after adding entries', async () => {
      const mockFile = {
        fileId: 'test-repo-main-event-test',
        type: 'event' as const,
        data: { id: 'test', name: 'Test Event' },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'events/test.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null);

      await IndexRebuildService.ensureFileInIndex(mockFile, 'event');

      // Verify index in FileRegistry is marked dirty
      const indexFile = fileRegistry.getFile('event-index');
      expect(indexFile).toBeTruthy();
      expect(indexFile?.isDirty).toBe(true);
      
      // Verify it has NO open tabs
      expect(indexFile?.viewTabs).toEqual([]);
    });

    it('should include dirty index files in getDirtyFiles()', async () => {
      const dirtyIndex = {
        fileId: 'node-index',
        type: 'node' as const,
        data: { version: '1.0.0', nodes: [{ id: 'test' }] },
        isDirty: true,
        isLoaded: true,
        viewTabs: [], // No open tabs!
        lastModified: Date.now(),
      };

      (fileRegistry as any).files.set('node-index', dirtyIndex);

      const dirtyFiles = fileRegistry.getDirtyFiles();

      expect(dirtyFiles).toHaveLength(1);
      expect(dirtyFiles[0].fileId).toBe('node-index');
      expect(dirtyFiles[0].viewTabs).toHaveLength(0); // No tabs, but still dirty!
    });
  });

  describe('BUG FIX: Missing names in index entries', () => {
    it('should use file.data.name when creating index entry', async () => {
      const fileWithName = {
        fileId: 'test-repo-main-node-with-name',
        type: 'node' as const,
        data: { 
          id: 'with-name', 
          name: 'Household Created' // Proper name from YAML
        },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'nodes/with-name.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null);

      await IndexRebuildService.ensureFileInIndex(fileWithName, 'node');

      const putCalls = (db.files.put as any).mock.calls;
      const indexFile = putCalls[putCalls.length - 1][0];
      
      const entry = indexFile.data.nodes[0];
      expect(entry.name).toBe('Household Created'); // Should use data.name, not ID
    });

    it('should fallback to ID when name is missing', async () => {
      const fileWithoutName = {
        fileId: 'test-repo-main-node-no-name',
        type: 'node' as const,
        data: { 
          id: 'no-name'
          // No name field!
        },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'nodes/no-name.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null);

      await IndexRebuildService.ensureFileInIndex(fileWithoutName, 'node');

      const putCalls = (db.files.put as any).mock.calls;
      const indexFile = putCalls[putCalls.length - 1][0];
      
      const entry = indexFile.data.nodes[0];
      expect(entry.name).toBe('no-name'); // Should fallback to ID
    });
  });

  describe('INTEGRATION: Full rebuild workflow', () => {
    it('should rebuild indexes and make files committable', async () => {
      const mockFiles = [
        {
          fileId: 'test-repo-main-node-n1',
          type: 'node' as const,
          data: { id: 'n1', name: 'Node 1' },
          source: { repository: 'test-repo', branch: 'main', path: 'nodes/n1.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
        {
          fileId: 'test-repo-main-parameter-p1',
          type: 'parameter' as const,
          data: { id: 'p1', name: 'Parameter 1' },
          source: { repository: 'test-repo', branch: 'main', path: 'parameters/p1.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
      ];

      (db.files.toArray as any).mockResolvedValue(mockFiles);
      (db.files.get as any).mockResolvedValue(null);
      (fileRegistry as any).addViewTab = vi.fn().mockResolvedValue('tab-id');
      (fileRegistry as any).closeTab = vi.fn().mockResolvedValue(undefined);

      const mockTabOps = {
        addTab: vi.fn().mockResolvedValue('tab-id'),
        closeTab: vi.fn().mockResolvedValue(undefined),
      };

      await IndexRebuildService.rebuildAllIndexes(mockTabOps as any, false);

      // 1. Verify indexes were created and marked dirty
      const nodeIndex = fileRegistry.getFile('node-index');
      const paramIndex = fileRegistry.getFile('parameter-index');
      
      expect(nodeIndex).toBeTruthy();
      expect(paramIndex).toBeTruthy();
      expect(nodeIndex?.isDirty).toBe(true);
      expect(paramIndex?.isDirty).toBe(true);

      // 2. Verify they have NO open tabs
      expect(nodeIndex?.viewTabs).toEqual([]);
      expect(paramIndex?.viewTabs).toEqual([]);

      // 3. Verify they appear in getDirtyFiles()
      const dirtyFiles = fileRegistry.getDirtyFiles();
      expect(dirtyFiles.length).toBeGreaterThanOrEqual(2);
      expect(dirtyFiles.some(f => f.fileId === 'node-index')).toBe(true);
      expect(dirtyFiles.some(f => f.fileId === 'parameter-index')).toBe(true);

      // 4. Verify they were saved to IndexedDB with workspace prefix
      const putCalls = (db.files.put as any).mock.calls;
      const nodeIndexIDB = putCalls.find((call: any) => 
        call[0].fileId === 'test-repo-main-node-index'
      );
      const paramIndexIDB = putCalls.find((call: any) => 
        call[0].fileId === 'test-repo-main-parameter-index'
      );

      expect(nodeIndexIDB).toBeTruthy();
      expect(paramIndexIDB).toBeTruthy();
    });
  });

  describe('BUG FIX: No orphans after rebuild', () => {
    it('should add all files to index (no orphans)', async () => {
      const mockFiles = [
        {
          fileId: 'test-repo-main-node-orphan1',
          type: 'node' as const,
          data: { id: 'orphan1', name: 'Orphan 1' },
          source: { repository: 'test-repo', branch: 'main', path: 'nodes/orphan1.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
        {
          fileId: 'test-repo-main-node-orphan2',
          type: 'node' as const,
          data: { id: 'orphan2', name: 'Orphan 2' },
          source: { repository: 'test-repo', branch: 'main', path: 'nodes/orphan2.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
      ];

      (db.files.toArray as any).mockResolvedValue(mockFiles);
      (db.files.get as any).mockResolvedValue(null);
      (fileRegistry as any).addViewTab = vi.fn().mockResolvedValue('tab-id');
      (fileRegistry as any).closeTab = vi.fn().mockResolvedValue(undefined);

      const mockTabOps = {
        addTab: vi.fn().mockResolvedValue('tab-id'),
        closeTab: vi.fn().mockResolvedValue(undefined),
      };

      await IndexRebuildService.rebuildAllIndexes(mockTabOps as any, false);

      // Verify index has both entries
      const nodeIndex = fileRegistry.getFile('node-index');
      expect(nodeIndex).toBeTruthy();
      expect(nodeIndex?.data.nodes).toHaveLength(2);
      expect(nodeIndex?.data.nodes.some((n: any) => n.id === 'orphan1')).toBe(true);
      expect(nodeIndex?.data.nodes.some((n: any) => n.id === 'orphan2')).toBe(true);
    });
  });

  describe('BUG FIX: Index entries use proper names', () => {
    it('should use data.name from YAML, not just ID', async () => {
      const fileWithProperName = {
        fileId: 'test-repo-main-event-household-created',
        type: 'event' as const,
        data: { 
          id: 'household-created',
          name: 'Household Created', // This should be in index entry
          description: 'Household has created an account'
        },
        source: { repository: 'test-repo', branch: 'main', path: 'events/household-created.yaml' },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      (db.files.get as any).mockResolvedValue(null);

      await IndexRebuildService.ensureFileInIndex(fileWithProperName, 'event');

      const putCalls = (db.files.put as any).mock.calls;
      const indexFile = putCalls[putCalls.length - 1][0];
      
      const entry = indexFile.data.events[0];
      expect(entry.id).toBe('household-created');
      expect(entry.name).toBe('Household Created'); // Not 'household-created'!
    });
  });

  describe('BUG FIX: Index files use plural paths', () => {
    it('should create all index files with plural names at root', async () => {
      const types = ['parameter', 'node', 'event', 'context', 'case'] as const;
      const expectedPaths = {
        parameter: 'parameters-index.yaml',
        node: 'nodes-index.yaml',
        event: 'events-index.yaml',
        context: 'contexts-index.yaml',
        case: 'cases-index.yaml',
      };

      for (const type of types) {
        vi.clearAllMocks();
        (fileRegistry as any).files.clear();

        const mockFile = {
          fileId: `test-repo-main-${type}-test`,
          type,
          data: { id: 'test', name: 'Test' },
          source: { repository: 'test-repo', branch: 'main', path: `${type}s/test.yaml` },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        };

        (db.files.get as any).mockResolvedValue(null);

        await IndexRebuildService.ensureFileInIndex(mockFile as any, type);

        const putCalls = (db.files.put as any).mock.calls;
        const indexFile = putCalls[putCalls.length - 1][0];
        
        expect(indexFile.path).toBe(expectedPaths[type]);
        expect(indexFile.path).not.toContain(`${type}-index`); // Not singular
        expect(indexFile.path).not.toContain(`${type}s/${type}s-index`); // Not nested
      }
    });
  });
});

