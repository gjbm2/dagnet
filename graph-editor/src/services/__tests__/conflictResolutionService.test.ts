/**
 * Tests for conflictResolutionService
 * 
 * Tests that conflict resolution properly:
 * - Updates FileRegistry
 * - Persists to IndexedDB
 * - Notifies listeners
 * - Handles local/remote/manual resolutions
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { conflictResolutionService } from '../conflictResolutionService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import type { MergeConflict } from '../workspaceService';

// Mock dependencies
vi.mock('react-hot-toast', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn()
  }
}));

vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map();
  const mockListeners = new Map();
  
  return {
    fileRegistry: {
      getFile: vi.fn((fileId: string) => mockFiles.get(fileId)),
      files: mockFiles,
      listeners: mockListeners,
      notifyListeners: vi.fn()
    }
  };
});

describe('conflictResolutionService', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Clear IndexedDB
    await db.files.clear();
    
    // Clear FileRegistry
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('applyResolutions', () => {
    it('should keep local version when resolution is "local"', async () => {
      // Setup
      const fileState = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        name: 'test.yaml',
        path: 'parameters/test.yaml',
        data: { id: 'test', value: 150 },
        originalData: { id: 'test', value: 100 },
        isDirty: true,
        source: {
          repository: 'test-repo',
          path: 'parameters/test.yaml',
          branch: 'main',
          commitHash: 'abc'
        },
        isLoaded: true,
        isLocal: false,
        viewTabs: [],
        lastModified: Date.now(),
        sha: 'sha-old'
      };

      (fileRegistry as any).files.set('parameter-test', fileState);
      vi.mocked(fileRegistry.getFile).mockReturnValue(fileState);

      const conflicts: MergeConflict[] = [{
        fileId: 'parameter-test',
        fileName: 'test.yaml',
        path: 'parameters/test.yaml',
        type: 'parameter',
        localContent: 'id: test\nvalue: 150\n',
        remoteContent: 'id: test\nvalue: 200\n',
        baseContent: 'id: test\nvalue: 100\n',
        mergedContent: '<<<<<<\nlocal\n=====\nremote\n>>>>>',
        hasConflicts: true
      }];

      const resolutions = new Map([['parameter-test', 'local' as const]]);

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(1);
      expect(fileState.isDirty).toBe(true); // Marked dirty
      expect(fileState.data.value).toBe(150); // Local value preserved
      expect(fileRegistry.notifyListeners).toHaveBeenCalledWith('parameter-test', fileState);
    });

    it('should accept remote version when resolution is "remote"', async () => {
      // Setup
      const fileState = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        name: 'test.yaml',
        path: 'parameters/test.yaml',
        data: { id: 'test', value: 150 },
        originalData: { id: 'test', value: 100 },
        isDirty: true,
        source: {
          repository: 'test-repo',
          path: 'parameters/test.yaml',
          branch: 'main',
          commitHash: 'abc'
        },
        isLoaded: true,
        isLocal: false,
        viewTabs: [],
        lastModified: Date.now(),
        sha: 'sha-old'
      };

      await db.files.add(fileState);
      (fileRegistry as any).files.set('parameter-test', fileState);
      vi.mocked(fileRegistry.getFile).mockReturnValue(fileState);

      const conflicts: MergeConflict[] = [{
        fileId: 'parameter-test',
        fileName: 'test.yaml',
        path: 'parameters/test.yaml',
        type: 'parameter',
        localContent: 'id: test\nvalue: 150\n',
        remoteContent: 'id: test\nvalue: 200\n',
        baseContent: 'id: test\nvalue: 100\n',
        mergedContent: '<<<<<<\nlocal\n=====\nremote\n>>>>>',
        hasConflicts: true
      }];

      const resolutions = new Map([['parameter-test', 'remote' as const]]);

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(1);
      expect(fileState.data.value).toBe(200); // Remote value applied
      expect(fileState.isDirty).toBe(false); // Marked clean
      expect(fileState.originalData).toEqual(fileState.data); // originalData updated
      
      // Verify persisted to IndexedDB
      const dbFile = await db.files.get('parameter-test');
      expect(dbFile?.data.value).toBe(200);
      expect(dbFile?.isDirty).toBe(false);

      expect(fileRegistry.notifyListeners).toHaveBeenCalledWith('parameter-test', fileState);
    });

    it('should handle JSON (graph) files when resolution is "remote"', async () => {
      // Setup
      const fileState = {
        fileId: 'graph-test',
        type: 'graph' as const,
        name: 'test.json',
        path: 'graphs/test.json',
        data: { nodes: [], edges: [{ id: 'e1', local: true }] },
        originalData: { nodes: [], edges: [] },
        isDirty: true,
        source: {
          repository: 'test-repo',
          path: 'graphs/test.json',
          branch: 'main',
          commitHash: 'abc'
        },
        isLoaded: true,
        isLocal: false,
        viewTabs: [],
        lastModified: Date.now(),
        sha: 'sha-old'
      };

      await db.files.add(fileState);
      (fileRegistry as any).files.set('graph-test', fileState);
      vi.mocked(fileRegistry.getFile).mockReturnValue(fileState);

      const conflicts: MergeConflict[] = [{
        fileId: 'graph-test',
        fileName: 'test.json',
        path: 'graphs/test.json',
        type: 'graph',
        localContent: JSON.stringify({ nodes: [], edges: [{ id: 'e1', local: true }] }),
        remoteContent: JSON.stringify({ nodes: [], edges: [{ id: 'e1', remote: true }] }),
        baseContent: JSON.stringify({ nodes: [], edges: [] }),
        mergedContent: '<<<<<<\nlocal\n=====\nremote\n>>>>>',
        hasConflicts: true
      }];

      const resolutions = new Map([['graph-test', 'remote' as const]]);

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(1);
      expect(fileState.data.edges[0].remote).toBe(true); // Remote value applied
      expect(fileState.data.edges[0].local).toBeUndefined();
      expect(fileState.isDirty).toBe(false);
      
      // Verify persisted to IndexedDB
      const dbFile = await db.files.get('graph-test');
      expect(dbFile?.data.edges[0].remote).toBe(true);
    });

    it('should mark file dirty for manual resolution', async () => {
      // Setup
      const fileState = {
        fileId: 'parameter-test',
        type: 'parameter' as const,
        name: 'test.yaml',
        path: 'parameters/test.yaml',
        data: { id: 'test', value: 150 },
        originalData: { id: 'test', value: 100 },
        isDirty: true,
        source: {
          repository: 'test-repo',
          path: 'parameters/test.yaml',
          branch: 'main',
          commitHash: 'abc'
        },
        isLoaded: true,
        isLocal: false,
        viewTabs: [],
        lastModified: Date.now(),
        sha: 'sha-old'
      };

      (fileRegistry as any).files.set('parameter-test', fileState);
      vi.mocked(fileRegistry.getFile).mockReturnValue(fileState);

      const conflicts: MergeConflict[] = [{
        fileId: 'parameter-test',
        fileName: 'test.yaml',
        path: 'parameters/test.yaml',
        type: 'parameter',
        localContent: 'id: test\nvalue: 150\n',
        remoteContent: 'id: test\nvalue: 200\n',
        baseContent: 'id: test\nvalue: 100\n',
        mergedContent: '<<<<<<\nlocal\n=====\nremote\n>>>>>',
        hasConflicts: true
      }];

      const resolutions = new Map([['parameter-test', 'manual' as const]]);

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(1);
      expect(fileState.isDirty).toBe(true);
      expect(fileRegistry.notifyListeners).toHaveBeenCalledWith('parameter-test', fileState);
    });

    it('should skip conflicts without resolutions', async () => {
      // Setup
      const conflicts: MergeConflict[] = [{
        fileId: 'parameter-test',
        fileName: 'test.yaml',
        path: 'parameters/test.yaml',
        type: 'parameter',
        localContent: 'local',
        remoteContent: 'remote',
        baseContent: 'base',
        mergedContent: 'conflict',
        hasConflicts: true
      }];

      const resolutions = new Map(); // Empty - no resolution provided

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(0);
    });

    it('should skip files not in FileRegistry', async () => {
      // Setup
      vi.mocked(fileRegistry.getFile).mockReturnValue(undefined); // File not found

      const conflicts: MergeConflict[] = [{
        fileId: 'parameter-missing',
        fileName: 'missing.yaml',
        path: 'parameters/missing.yaml',
        type: 'parameter',
        localContent: 'local',
        remoteContent: 'remote',
        baseContent: 'base',
        mergedContent: 'conflict',
        hasConflicts: true
      }];

      const resolutions = new Map([['parameter-missing', 'remote' as const]]);

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(0);
    });

    it('should handle multiple conflicts in one call', async () => {
      // Setup
      const file1 = {
        fileId: 'parameter-test1',
        type: 'parameter' as const,
        name: 'test1.yaml',
        path: 'parameters/test1.yaml',
        data: { id: 'test1', value: 150 },
        originalData: { id: 'test1', value: 100 },
        isDirty: true,
        source: { repository: 'test-repo', path: 'parameters/test1.yaml', branch: 'main', commitHash: 'abc' },
        isLoaded: true,
        isLocal: false,
        viewTabs: [],
        lastModified: Date.now(),
        sha: 'sha1'
      };

      const file2 = {
        fileId: 'parameter-test2',
        type: 'parameter' as const,
        name: 'test2.yaml',
        path: 'parameters/test2.yaml',
        data: { id: 'test2', value: 250 },
        originalData: { id: 'test2', value: 200 },
        isDirty: true,
        source: { repository: 'test-repo', path: 'parameters/test2.yaml', branch: 'main', commitHash: 'abc' },
        isLoaded: true,
        isLocal: false,
        viewTabs: [],
        lastModified: Date.now(),
        sha: 'sha2'
      };

      await db.files.add(file1);
      await db.files.add(file2);
      (fileRegistry as any).files.set('parameter-test1', file1);
      (fileRegistry as any).files.set('parameter-test2', file2);
      
      vi.mocked(fileRegistry.getFile).mockImplementation((id: string) => {
        return id === 'parameter-test1' ? file1 : id === 'parameter-test2' ? file2 : undefined;
      });

      const conflicts: MergeConflict[] = [
        {
          fileId: 'parameter-test1',
          fileName: 'test1.yaml',
          path: 'parameters/test1.yaml',
          type: 'parameter',
          localContent: 'id: test1\nvalue: 150\n',
          remoteContent: 'id: test1\nvalue: 175\n',
          baseContent: 'id: test1\nvalue: 100\n',
          mergedContent: 'conflict1',
          hasConflicts: true
        },
        {
          fileId: 'parameter-test2',
          fileName: 'test2.yaml',
          path: 'parameters/test2.yaml',
          type: 'parameter',
          localContent: 'id: test2\nvalue: 250\n',
          remoteContent: 'id: test2\nvalue: 275\n',
          baseContent: 'id: test2\nvalue: 200\n',
          mergedContent: 'conflict2',
          hasConflicts: true
        }
      ];

      const resolutions = new Map([
        ['parameter-test1', 'local' as const],
        ['parameter-test2', 'remote' as const]
      ]);

      // Execute
      const count = await conflictResolutionService.applyResolutions(conflicts, resolutions);

      // Assert
      expect(count).toBe(2);
      
      // File 1: local kept
      expect(file1.data.value).toBe(150);
      expect(file1.isDirty).toBe(true);
      
      // File 2: remote accepted
      expect(file2.data.value).toBe(275);
      expect(file2.isDirty).toBe(false);
      
      const dbFile2 = await db.files.get('parameter-test2');
      expect(dbFile2?.data.value).toBe(275);
    });
  });
});

