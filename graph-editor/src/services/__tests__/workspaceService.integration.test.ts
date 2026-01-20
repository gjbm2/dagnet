/**
 * Integration tests for workspaceService.pullLatest()
 * 
 * Tests the actual pull flow including:
 * - SHA comparison
 * - Dirty file detection
 * - 3-way merge invocation
 * - Conflict detection and return
 * - Auto-merge success
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { workspaceService } from '../workspaceService';
import { gitService } from '../gitService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import * as mergeServiceModule from '../mergeService';

// Mock dependencies (not IndexedDB - that's handled by fake-indexeddb)
vi.mock('../gitService');
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
    files: new Map(),
    listeners: new Map(),
    notifyListeners: vi.fn()
  }
}));

describe('workspaceService.pullLatest() - Integration Tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Clear IndexedDB (using fake-indexeddb)
    await db.workspaces.clear();
    await db.files.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return empty conflicts when no changes detected', async () => {
    // Setup: Create workspace with one file
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-test-param'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-test-param',
      type: 'parameter',
      name: 'test-param.yaml',
      path: 'parameters/test-param.yaml',
      data: { id: 'test-param', value: 100 },
      originalData: { id: 'test-param', value: 100 },
      isDirty: false,
      source: {
        repository: 'test-repo',
        path: 'parameters/test-param.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-unchanged',
      lastSynced: Date.now()
    });

    // Mock git service to return same SHA (no changes)
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          {
            path: 'parameters/test-param.yaml',
            type: 'blob',
            sha: 'sha-unchanged', // Same SHA - no change
            size: 100
          }
        ],
        commitSha: 'commit-abc'
      }
    });

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    // Execute
    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Assert
    expect(result.success).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesDeleted).toBe(0);
  });

  it('should auto-merge when no local changes exist', async () => {
    // Setup: Create workspace with clean file
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-test-param'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-test-param',
      type: 'parameter',
      name: 'test-param.yaml',
      path: 'parameters/test-param.yaml',
      data: { id: 'test-param', value: 100 },
      originalData: { id: 'test-param', value: 100 },
      isDirty: false, // Not dirty
      source: {
        repository: 'test-repo',
        path: 'parameters/test-param.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-old',
      lastSynced: Date.now()
    });

    // Mock git service to return new SHA and content
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          {
            path: 'parameters/test-param.yaml',
            type: 'blob',
            sha: 'sha-new', // Different SHA - changed
            size: 120
          }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: test-param\nvalue: 200\n', // Changed value
        sha: 'sha-new'
      }
    });

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    // Execute
    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Assert
    expect(result.success).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.filesUpdated).toBe(1);

    // Verify file was updated in DB
    const updatedFile = await db.files.get('parameter-test-param');
    expect(updatedFile?.data.value).toBe(200);
    expect(updatedFile?.sha).toBe('sha-new');
    expect(updatedFile?.isDirty).toBe(false);
  });

  it('should detect conflict when both local and remote changed same file', async () => {
    // Setup: Create workspace with dirty file
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-test-param'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-test-param',
      type: 'parameter',
      name: 'test-param.yaml',
      path: 'parameters/test-param.yaml',
      data: { id: 'test-param', value: 150, description: 'local change' },
      originalData: { id: 'test-param', value: 100 }, // Base version
      isDirty: true, // Locally modified
      source: {
        repository: 'test-repo',
        path: 'parameters/test-param.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-old',
      lastSynced: Date.now()
    });

    // Mock git service
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          {
            path: 'parameters/test-param.yaml',
            type: 'blob',
            sha: 'sha-new', // Different SHA
            size: 120
          }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: test-param\nvalue: 200\ndescription: remote change\n', // Remote changed same line
        sha: 'sha-new'
      }
    });

    // Mock merge3Way to return conflict
    vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: true,
      merged: 'id: test-param\n<<<<<<< LOCAL\nvalue: 150\ndescription: local change\n=======\nvalue: 200\ndescription: remote change\n>>>>>>> REMOTE\n',
      conflicts: [{
        startLine: 1,
        endLine: 2,
        base: ['value: 100'],
        local: ['value: 150', 'description: local change'],
        remote: ['value: 200', 'description: remote change']
      }]
    });

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    // Execute
    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Assert
    expect(result.success).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      fileId: 'parameter-test-param',
      fileName: 'test-param.yaml',
      type: 'parameter',
      hasConflicts: true
    });

    // Verify merge3Way was called with correct parameters
    expect(mergeServiceModule.merge3Way).toHaveBeenCalledWith(
      expect.stringContaining('value: 100'), // base
      expect.stringContaining('value: 150'), // local
      expect.stringContaining('value: 200')  // remote
    );

    // Verify file was NOT updated (conflict preserved local)
    const file = await db.files.get('parameter-test-param');
    expect(file?.data.value).toBe(150); // Still local version
    expect(file?.isDirty).toBe(true);
  });

  it('should report force-replace requests in detect mode (and defer those dirty files)', async () => {
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-test-param'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-test-param',
      type: 'parameter',
      name: 'test-param.yaml',
      path: 'parameters/test-param.yaml',
      data: { id: 'test-param', value: 150, force_replace_at_ms: 1000 },
      originalData: { id: 'test-param', value: 100, force_replace_at_ms: 1000 },
      isDirty: true,
      source: {
        repository: 'test-repo',
        path: 'parameters/test-param.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-old',
      lastSynced: Date.now()
    });

    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          { path: 'parameters/test-param.yaml', type: 'blob', sha: 'sha-new', size: 120 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: test-param\nvalue: 0\nforce_replace_at_ms: 2000\nvalues: []\n',
        sha: 'sha-new'
      }
    });

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds, {
      forceReplace: { mode: 'detect' },
    });

    expect(result.success).toBe(true);
    expect(result.forceReplaceRequests?.length).toBe(1);
    expect(result.forceReplaceRequests?.[0]).toMatchObject({
      fileId: 'parameter-test-param',
      path: 'parameters/test-param.yaml',
      remoteForceReplaceAtMs: 2000,
      localForceReplaceAtMs: 1000,
    });

    // Verify file was NOT overwritten in DB (deferred)
    const fileAfter = await db.files.get('parameter-test-param');
    expect(fileAfter?.data.value).toBe(150);
    expect(fileAfter?.isDirty).toBe(true);
    expect(fileAfter?.sha).toBe('sha-old');
  });

  it('should overwrite dirty param file in apply mode when allowed (skip 3-way merge)', async () => {
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-test-param'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-test-param',
      type: 'parameter',
      name: 'test-param.yaml',
      path: 'parameters/test-param.yaml',
      data: { id: 'test-param', value: 150, force_replace_at_ms: 1000 },
      originalData: { id: 'test-param', value: 100, force_replace_at_ms: 1000 },
      isDirty: true,
      source: {
        repository: 'test-repo',
        path: 'parameters/test-param.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-old',
      lastSynced: Date.now()
    });

    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          { path: 'parameters/test-param.yaml', type: 'blob', sha: 'sha-new', size: 120 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: test-param\nvalue: 0\nforce_replace_at_ms: 2000\nvalues: []\n',
        sha: 'sha-new'
      }
    });

    // Ensure merge3Way isn't called (we're overwriting)
    const mergeSpy = vi.spyOn(mergeServiceModule, 'merge3Way');

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds, {
      forceReplace: { mode: 'apply', allowFileIds: ['parameter-test-param'] },
    });

    expect(result.success).toBe(true);
    expect(result.forceReplaceApplied).toContain('parameter-test-param');
    expect(mergeSpy).not.toHaveBeenCalled();

    const fileAfter = await db.files.get('parameter-test-param');
    expect(fileAfter?.data.value).toBe(0);
    expect((fileAfter?.data as any)?.force_replace_at_ms).toBe(2000);
    expect(fileAfter?.isDirty).toBe(false);
    expect(fileAfter?.sha).toBe('sha-new');
  });

  it('should auto-merge when changes do not conflict', async () => {
    // Setup: Create workspace with dirty file
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-test-param'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-test-param',
      type: 'parameter',
      name: 'test-param.yaml',
      path: 'parameters/test-param.yaml',
      data: { id: 'test-param', value: 100, localField: 'added locally' },
      originalData: { id: 'test-param', value: 100 }, // Base version
      isDirty: true,
      source: {
        repository: 'test-repo',
        path: 'parameters/test-param.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-old',
      lastSynced: Date.now()
    });

    // Mock git service
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          {
            path: 'parameters/test-param.yaml',
            type: 'blob',
            sha: 'sha-new',
            size: 120
          }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: test-param\nvalue: 100\nremoteField: added remotely\n', // Different field changed
        sha: 'sha-new'
      }
    });

    // Mock merge3Way to return successful merge (no conflicts)
    vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: false,
      merged: 'id: test-param\nvalue: 100\nlocalField: added locally\nremoteField: added remotely\n',
      conflicts: []
    });

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    // Execute
    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Assert
    expect(result.success).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.filesUpdated).toBe(1);

    // Verify file was merged
    const file = await db.files.get('parameter-test-param');
    expect(file?.data).toHaveProperty('localField', 'added locally');
    expect(file?.data).toHaveProperty('remoteField', 'added remotely');
    expect(file?.isDirty).toBe(false); // Merged and marked clean
    expect(file?.sha).toBe('sha-new');
  });

  it('should handle deleted files from remote', async () => {
    // Setup: Create workspace with file that was deleted remotely
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-deleted'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-deleted',
      type: 'parameter',
      name: 'deleted.yaml',
      path: 'parameters/deleted.yaml',
      data: { id: 'deleted' },
      originalData: { id: 'deleted' },
      isDirty: false,
      source: {
        repository: 'test-repo',
        path: 'parameters/deleted.yaml',
        branch: 'main',
        commitHash: 'abc123'
      },
      isLoaded: true,
      isLocal: false,
      viewTabs: [],
      lastModified: Date.now(),
      sha: 'sha-old',
      lastSynced: Date.now()
    });

    // Mock git service to return empty tree (file deleted)
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [], // File deleted from remote
        commitSha: 'commit-new'
      }
    });

    const gitCreds = {
      name: 'test-repo',
      owner: 'test-owner',
      token: 'test-token',
      basePath: '',
      paramsPath: 'parameters',
      graphsPath: 'graphs',
      nodesPath: 'nodes',
      eventsPath: 'events',
      contextsPath: 'contexts',
      casesPath: 'cases'
    };

    // Execute
    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Assert
    expect(result.success).toBe(true);
    expect(result.filesDeleted).toBe(1);

    // Verify file was deleted from DB
    const file = await db.files.get('parameter-deleted');
    expect(file).toBeUndefined();
  });
});

