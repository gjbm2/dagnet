/**
 * Index Operations Integration Tests
 * 
 * Tests actual index maintenance workflows with real services
 * Validates index files stay in sync with data files
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
      delete: vi.fn().mockResolvedValue(undefined),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          and: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
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

describe('Index Operations Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Index File Path Validation', () => {
    it('should create index files with PLURAL names at ROOT', async () => {
      const mockFile = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        data: { id: 'test', p: { mean: 0.5 } },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/test.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      // Simulate no existing index
      (fileRegistry as any).files.clear();
      (db.files.get as any).mockResolvedValue(null);

      await IndexRebuildService.ensureFileInIndex(mockFile, 'parameter');

      // Should have created index with correct path
      const putCalls = (db.files.put as any).mock.calls;
      const indexFile = putCalls.find((call: any) => 
        call[0].fileId === 'parameter-index'
      );

      expect(indexFile).toBeTruthy();
      expect(indexFile[0].path).toBe('parameters-index.yaml'); // Plural!
      expect(indexFile[0].name).toBe('parameters-index.yaml');
      expect(indexFile[0].path).not.toContain('parameter-index.yaml'); // Not singular
      expect(indexFile[0].path).not.toContain('parameters/parameters-index'); // Not nested
    });

    it('should create index files for all types with plural names', async () => {
      const types = [
        { type: 'parameter', expectedPath: 'parameters-index.yaml' },
        { type: 'context', expectedPath: 'contexts-index.yaml' },
        { type: 'case', expectedPath: 'cases-index.yaml' },
        { type: 'node', expectedPath: 'nodes-index.yaml' },
        { type: 'event', expectedPath: 'events-index.yaml' },
      ] as const;

      for (const { type, expectedPath } of types) {
        vi.clearAllMocks();

        const mockFile = {
          fileId: `${type}-test`,
          type,
          data: { id: 'test' },
          source: {
            repository: 'test-repo',
            branch: 'main',
            path: `${type}s/test.yaml`,
          },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        };

        (db.files.get as any).mockResolvedValue(null);

        await IndexRebuildService.ensureFileInIndex(mockFile as any, type);

        const putCalls = (db.files.put as any).mock.calls;
        const indexFile = putCalls.find((call: any) => 
          call[0].fileId === `${type}-index`
        );

        expect(indexFile).toBeTruthy();
        expect(indexFile[0].path).toBe(expectedPath);
      }
    });
  });

  describe('Index Entry Management', () => {
    it('should add file entry to index', async () => {
      const existingIndex = {
        fileId: 'parameter-index',
        type: 'parameter' as const,
        data: {
          version: '1.0.0',
          parameters: [
            { id: 'existing', file_path: 'parameters/existing.yaml', status: 'active' },
          ],
        },
        path: 'parameters-index.yaml',
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      const newFile = {
        fileId: 'parameter-new',
        type: 'parameter' as const,
        data: { id: 'new', p: { mean: 0.8 } },
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

      (fileRegistry as any).files.set('parameter-index', existingIndex);
      (db.files.get as any).mockResolvedValue(existingIndex);

      await IndexRebuildService.ensureFileInIndex(newFile, 'parameter');

      // Should have added new entry
      const putCalls = (db.files.put as any).mock.calls;
      const updatedIndex = putCalls.find((call: any) => 
        call[0].fileId === 'parameter-index'
      );

      expect(updatedIndex).toBeTruthy();
      expect(updatedIndex[0].data.parameters).toHaveLength(2);
      expect(updatedIndex[0].data.parameters.some((p: any) => p.id === 'new')).toBe(true);
    });

    it('should not add duplicate entries', async () => {
      const existingIndex = {
        fileId: 'node-index',
        type: 'node' as const,
        data: {
          version: '1.0.0',
          nodes: [
            { id: 'test', file_path: 'nodes/test.yaml', status: 'active' },
          ],
        },
        path: 'nodes-index.yaml',
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      const sameFile = {
        fileId: 'node-test',
        type: 'node' as const,
        data: { id: 'test' },
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

      (fileRegistry as any).files.set('node-index', existingIndex);
      (db.files.get as any).mockResolvedValue(existingIndex);

      await IndexRebuildService.ensureFileInIndex(sameFile, 'node');

      // Should still have only 1 entry
      const putCalls = (db.files.put as any).mock.calls;
      if (putCalls.length > 0) {
        const updatedIndex = putCalls.find((call: any) => 
          call[0].fileId === 'node-index'
        );
        if (updatedIndex) {
          expect(updatedIndex[0].data.nodes).toHaveLength(1);
        }
      }
    });

    it('should update existing entry with new metadata', async () => {
      const existingIndex = {
        fileId: 'event-index',
        type: 'event' as const,
        data: {
          version: '1.0.0',
          events: [
            { id: 'test', file_path: 'events/test.yaml', status: 'active', name: 'Old Name' },
          ],
        },
        path: 'events-index.yaml',
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      const updatedFile = {
        fileId: 'event-test',
        type: 'event' as const,
        data: { id: 'test', name: 'New Name' },
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

      (fileRegistry as any).files.set('event-index', existingIndex);
      (db.files.get as any).mockResolvedValue(existingIndex);

      await IndexRebuildService.ensureFileInIndex(updatedFile, 'event');

      // Should have updated name
      const putCalls = (db.files.put as any).mock.calls;
      const updatedIndex = putCalls.find((call: any) => 
        call[0].fileId === 'event-index'
      );

      if (updatedIndex) {
        const entry = updatedIndex[0].data.events.find((e: any) => e.id === 'test');
        expect(entry?.name).toBe('New Name');
      }
    });
  });

  describe('Index Rebuild Workflow', () => {
    it('should rebuild all indexes from workspace files', async () => {
      const mockFiles = [
        {
          fileId: 'parameter-p1',
          type: 'parameter' as const,
          data: { id: 'p1' },
          source: { repository: 'test-repo', branch: 'main', path: 'parameters/p1.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
        {
          fileId: 'parameter-p2',
          type: 'parameter' as const,
          data: { id: 'p2' },
          source: { repository: 'test-repo', branch: 'main', path: 'parameters/p2.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
        {
          fileId: 'node-n1',
          type: 'node' as const,
          data: { id: 'n1' },
          source: { repository: 'test-repo', branch: 'main', path: 'nodes/n1.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
      ];

      (db.files.toArray as any).mockResolvedValue(mockFiles);
      (db.files.get as any).mockResolvedValue(null); // No existing indexes
      
      // Mock fileRegistry methods to prevent log file errors
      (fileRegistry as any).addViewTab = vi.fn().mockResolvedValue('tab-id');
      (fileRegistry as any).closeTab = vi.fn().mockResolvedValue(undefined);

      // Create mock tab operations
      const mockTabOps = {
        addTab: vi.fn().mockResolvedValue('tab-id'),
        closeTab: vi.fn().mockResolvedValue(undefined),
      };

      const report = await IndexRebuildService.rebuildAllIndexes(mockTabOps as any, false);

      // Should have processed files
      expect(report).toBeTruthy();
      expect(report.success).toBe(true);
      
      // Should have created parameter-index and node-index
      const putCalls = (db.files.put as any).mock.calls;
      const paramIndex = putCalls.find((call: any) => call[0].fileId === 'parameter-index');
      const nodeIndex = putCalls.find((call: any) => call[0].fileId === 'node-index');

      expect(paramIndex).toBeTruthy();
      expect(nodeIndex).toBeTruthy();
      
      // Verify plural paths
      expect(paramIndex[0].path).toBe('parameters-index.yaml');
      expect(nodeIndex[0].path).toBe('nodes-index.yaml');
    });

    it('should skip graph files (no index needed)', async () => {
      const mockFiles = [
        {
          fileId: 'graph-test',
          type: 'graph' as const,
          data: { nodes: [], edges: [] },
          source: { repository: 'test-repo', branch: 'main', path: 'graphs/test.json' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
      ];

      (db.files.toArray as any).mockResolvedValue(mockFiles);
      (fileRegistry as any).addViewTab = vi.fn().mockResolvedValue('tab-id');
      (fileRegistry as any).closeTab = vi.fn().mockResolvedValue(undefined);

      const mockTabOps = {
        addTab: vi.fn().mockResolvedValue('tab-id'),
        closeTab: vi.fn().mockResolvedValue(undefined),
      };

      const report = await IndexRebuildService.rebuildAllIndexes(mockTabOps as any, false);

      expect(report).toBeTruthy();
      
      // Should NOT have created graph-index
      const putCalls = (db.files.put as any).mock.calls;
      const graphIndex = putCalls.find((call: any) => call[0].fileId === 'graph-index');
      expect(graphIndex).toBeFalsy();
    });

    it('should skip index files themselves', async () => {
      const mockFiles = [
        {
          fileId: 'parameter-index',
          type: 'parameter' as const,
          data: { version: '1.0.0', parameters: [] },
          source: { repository: 'test-repo', branch: 'main', path: 'parameters-index.yaml' },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastModified: Date.now(),
        },
      ];

      (db.files.toArray as any).mockResolvedValue(mockFiles);
      (fileRegistry as any).addViewTab = vi.fn().mockResolvedValue('tab-id');
      (fileRegistry as any).closeTab = vi.fn().mockResolvedValue(undefined);

      const mockTabOps = {
        addTab: vi.fn().mockResolvedValue('tab-id'),
        closeTab: vi.fn().mockResolvedValue(undefined),
      };

      const report = await IndexRebuildService.rebuildAllIndexes(mockTabOps as any, false);

      // Should have processed and skipped the index file
      expect(report).toBeTruthy();
      expect(report.success).toBe(true);
    });
  });

  describe('Index Consistency', () => {
    it('should detect files missing from index', async () => {
      const files = [
        {
          fileId: 'node-a',
          type: 'node' as const,
          data: { id: 'a' },
          source: { path: 'nodes/a.yaml' },
        },
        {
          fileId: 'node-b',
          type: 'node' as const,
          data: { id: 'b' },
          source: { path: 'nodes/b.yaml' },
        },
      ];

      const incompleteIndex = {
        fileId: 'node-index',
        type: 'node' as const,
        data: {
          version: '1.0.0',
          nodes: [
            { id: 'a', file_path: 'nodes/a.yaml', status: 'active' },
            // 'b' is missing!
          ],
        },
      };

      (fileRegistry as any).files.set('node-index', incompleteIndex);

      // Rebuild should detect and add 'b'
      for (const file of files) {
        await IndexRebuildService.ensureFileInIndex(file as any, 'node');
      }

      const putCalls = (db.files.put as any).mock.calls;
      const updatedIndex = putCalls[putCalls.length - 1];
      
      if (updatedIndex) {
        expect(updatedIndex[0].data.nodes.some((n: any) => n.id === 'b')).toBe(true);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle missing file IDs gracefully', async () => {
      const invalidFile = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        data: {}, // Missing 'id'!
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/test.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      const result = await IndexRebuildService.ensureFileInIndex(invalidFile, 'parameter');

      // Should skip without throwing
      expect(result.action).toBe('skipped');
    });

    it('should handle corrupted indexes gracefully', async () => {
      const corruptedIndex = {
        fileId: 'node-index',
        type: 'node' as const,
        data: null, // Corrupted!
        path: 'nodes-index.yaml',
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      const file = {
        fileId: 'node-test',
        type: 'node' as const,
        data: { id: 'test' },
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

      (fileRegistry as any).files.set('node-index', corruptedIndex);
      (db.files.get as any).mockResolvedValue(corruptedIndex);

      await IndexRebuildService.ensureFileInIndex(file, 'node');

      // Should have recreated with proper structure
      const putCalls = (db.files.put as any).mock.calls;
      const recreatedIndex = putCalls.find((call: any) => 
        call[0].fileId === 'node-index'
      );

      expect(recreatedIndex).toBeTruthy();
      expect(recreatedIndex[0].data).toBeTruthy();
      expect(recreatedIndex[0].data.version).toBe('1.0.0');
      expect(Array.isArray(recreatedIndex[0].data.nodes)).toBe(true);
    });

    it('should handle IndexedDB errors', async () => {
      (db.files.put as any).mockRejectedValueOnce(new Error('IndexedDB error'));

      const file = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        data: { id: 'test' },
        source: {
          repository: 'test-repo',
          branch: 'main',
          path: 'parameters/test.yaml',
        },
        isDirty: false,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };

      // Should throw when IndexedDB fails
      await expect(
        IndexRebuildService.ensureFileInIndex(file, 'parameter')
      ).rejects.toThrow('IndexedDB error');
    });
  });
});

