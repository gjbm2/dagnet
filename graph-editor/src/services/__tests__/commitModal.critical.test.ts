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

    it('should recognize workspace-prefixed event files as committable', async () => {
      const eventFile = {
        fileId: 'event-test',
        type: 'event' as const,
        data: { id: 'test', name: 'Test Event', event_type: 'user_action' },
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'events/test.yaml' },
      };
      
      (fileRegistry as any).files.set('event-test', eventFile);

      const dirtyFilesFromDB = [
        {
          ...eventFile,
          fileId: 'test-repo-main-event-test', // Workspace-prefixed!
        },
      ];
      
      (db.files.toArray as any).mockResolvedValue(dirtyFilesFromDB);

      const dirtyFile = dirtyFilesFromDB[0];
      const isCommittable = (fileRegistry.constructor as any).isFileCommittable(dirtyFile);
      
      expect(isCommittable).toBe(true);
    });

    it('should recognize workspace-prefixed event-index as committable', async () => {
      const eventIndexFile = {
        fileId: 'event-index',
        type: 'event' as const,
        data: { version: '1.0.0', events: [{ id: 'test', name: 'Test Event' }] },
        isDirty: true,
        isLoaded: true,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'events-index.yaml' },
      };
      
      (fileRegistry as any).files.set('event-index', eventIndexFile);

      const dirtyFilesFromDB = [
        {
          ...eventIndexFile,
          fileId: 'test-repo-main-event-index', // Workspace-prefixed!
        },
      ];
      
      (db.files.toArray as any).mockResolvedValue(dirtyFilesFromDB);

      const dirtyFile = dirtyFilesFromDB[0];
      const isCommittable = (fileRegistry.constructor as any).isFileCommittable(dirtyFile);
      
      expect(isCommittable).toBe(true);
    });
  });

  describe('BUG FIX: updateFile must sync workspace-prefixed version to IndexedDB', () => {
    it('should update both unprefixed and workspace-prefixed versions when file is edited', async () => {
      const eventFile = {
        fileId: 'event-test',
        type: 'event' as const,
        data: { id: 'test', name: 'Test Event', event_type: 'user_action' },
        originalData: { id: 'test', name: 'Test Event', event_type: 'user_action' },
        isDirty: false,
        isLoaded: true,
        isInitializing: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'events/test.yaml' },
      };
      
      (fileRegistry as any).files.set('event-test', eventFile);

      // Simulate editing the file
      const updatedData = { id: 'test', name: 'Updated Event', event_type: 'conversion' };
      await fileRegistry.updateFile('event-test', updatedData);

      // Verify db.files.put was called TWICE (unprefixed + prefixed)
      expect(db.files.put).toHaveBeenCalledTimes(2);
      
      // First call: unprefixed version
      const call1 = (db.files.put as any).mock.calls[0][0];
      expect(call1.fileId).toBe('event-test');
      expect(call1.isDirty).toBe(true);
      
      // Second call: workspace-prefixed version
      const call2 = (db.files.put as any).mock.calls[1][0];
      expect(call2.fileId).toBe('test-repo-main-event-test');
      expect(call2.isDirty).toBe(true);
    });

    it('should update both versions when event-index is edited', async () => {
      const indexFile = {
        fileId: 'event-index',
        type: 'event' as const,
        data: { version: '1.0.0', events: [] },
        originalData: { version: '1.0.0', events: [] },
        isDirty: false,
        isLoaded: true,
        isInitializing: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'events-index.yaml' },
      };
      
      (fileRegistry as any).files.set('event-index', indexFile);

      // Simulate updating the index
      const updatedData = { 
        version: '1.0.0', 
        events: [{ id: 'test', name: 'Test Event', file_path: 'events/test.yaml' }] 
      };
      await fileRegistry.updateFile('event-index', updatedData);

      // Verify db.files.put was called TWICE
      expect(db.files.put).toHaveBeenCalledTimes(2);
      
      // Both versions should be marked dirty
      const call1 = (db.files.put as any).mock.calls[0][0];
      expect(call1.fileId).toBe('event-index');
      expect(call1.isDirty).toBe(true);
      
      const call2 = (db.files.put as any).mock.calls[1][0];
      expect(call2.fileId).toBe('test-repo-main-event-index');
      expect(call2.isDirty).toBe(true);
    });

    it('should update both versions even for local repo files', async () => {
      const localFile = {
        fileId: 'event-local',
        type: 'event' as const,
        data: { id: 'local', name: 'Local Event' },
        originalData: { id: 'local', name: 'Local Event' },
        isDirty: false,
        isLoaded: true,
        isInitializing: false,
        viewTabs: [],
        lastModified: Date.now(),
        source: { repository: 'local', branch: 'main', path: 'events/local.yaml' },
      };
      
      (fileRegistry as any).files.set('event-local', localFile);

      const updatedData = { id: 'local', name: 'Updated Local Event' };
      await fileRegistry.updateFile('event-local', updatedData);

      // Should call db.files.put TWICE (even 'local' repo uses workspace prefixing)
      expect(db.files.put).toHaveBeenCalledTimes(2);
      
      const call1 = (db.files.put as any).mock.calls[0][0];
      expect(call1.fileId).toBe('event-local');
      expect(call1.isDirty).toBe(true);
      
      const call2 = (db.files.put as any).mock.calls[1][0];
      expect(call2.fileId).toBe('local-main-event-local');
      expect(call2.isDirty).toBe(true);
    });
  });
});

