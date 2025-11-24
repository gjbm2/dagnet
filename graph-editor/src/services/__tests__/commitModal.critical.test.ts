/**
 * Critical CommitModal Tests
 * 
 * Tests that dirty files from IndexedDB (with workspace prefixes)
 * are properly shown as committable in the UI
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// Mock IndexedDB
vi.mock('../../db/appDatabase', () => ({
  db: {
    getDirtyFiles: vi.fn(async function(this: any) {
      const allFiles = await this.files.toArray();
      return allFiles.filter((f: any) => f.isDirty);
    }),
    files: {
      toArray: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

describe('CommitModal - Critical Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any).files.clear();
  });

  describe('BUG: Workspace-prefixed dirty files not shown in commit modal', () => {
    it('should recognize workspace-prefixed index files as committable', async () => {
      // Set up index file in FileRegistry (unprefixed)
      const indexFile = {
        fileId: 'node-index',
        type: 'node' as const,
        data: { version: '1.0.0', nodes: [{ id: 'test' }] },
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'nodes-index.yaml' },
      };
      
      (fileRegistry as any).files.set('node-index', indexFile);

      // db.getDirtyFiles() returns workspace-prefixed IDs
      const dirtyFilesFromDB = [
        {
          ...indexFile,
          fileId: 'test-repo-main-node-index', // Workspace-prefixed!
        },
      ];
      
      (db.files.toArray as any).mockResolvedValue(dirtyFilesFromDB);

      const dirtyFiles = await db.getDirtyFiles();
      expect(dirtyFiles).toHaveLength(1);

      // This is what CommitModal does - should recognize the file as committable
      const dirtyFile = dirtyFilesFromDB[0];
      const isCommittable = (fileRegistry.constructor as any).isFileCommittable(dirtyFile);
      
      expect(isCommittable).toBe(true);
    });

    it('should recognize workspace-prefixed data files as committable', async () => {
      const paramFile = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        data: { id: 'test', p: { mean: 0.5 } },
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'parameters/test.yaml' },
      };
      
      (fileRegistry as any).files.set('parameter-test', paramFile);

      const dirtyFilesFromDB = [
        {
          ...paramFile,
          fileId: 'test-repo-main-parameter-test', // Workspace-prefixed!
        },
      ];
      
      (db.files.toArray as any).mockResolvedValue(dirtyFilesFromDB);

      const dirtyFile = dirtyFilesFromDB[0];
      const isCommittable = (fileRegistry.constructor as any).isFileCommittable(dirtyFile);
      
      expect(isCommittable).toBe(true);
    });

    it('should reject non-committable files even with workspace prefix', async () => {
      const credentialsFile = {
        fileId: 'credentials-credentials',
        type: 'credentials' as const,
        data: { version: '1.0.0', git: [] },
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
      };
      
      (fileRegistry as any).files.set('credentials-credentials', credentialsFile);

      const dirtyFilesFromDB = [
        {
          ...credentialsFile,
          fileId: 'test-repo-main-credentials-credentials',
        },
      ];
      
      (db.files.toArray as any).mockResolvedValue(dirtyFilesFromDB);

      const dirtyFile = dirtyFilesFromDB[0];
      const isCommittable = (fileRegistry.constructor as any).isFileCommittable(dirtyFile);
      
      expect(isCommittable).toBe(false); // Credentials are never committable
    });

    it('should handle unprefixed fileIds (local files)', () => {
      const localFile = {
        fileId: 'graph-local',
        type: 'graph' as const,
        data: { nodes: [], edges: [] },
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'local', branch: 'main', path: 'graphs/local.json' },
      };
      
      (fileRegistry as any).files.set('graph-local', localFile);

      const isCommittable = fileRegistry.isFileCommittableById('graph-local');
      
      expect(isCommittable).toBe(true);
    });
  });
});

