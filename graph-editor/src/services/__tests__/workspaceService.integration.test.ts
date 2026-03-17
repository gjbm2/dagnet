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
vi.mock('../../contexts/TabContext', () => {
  const files = new Map();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => files.get(id) ?? null),
      files,
      listeners: new Map(),
      notifyListeners: vi.fn(),
    },
  };
});

describe('workspaceService.pullLatest() - Integration Tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear the in-memory FileRegistry mock map
    (fileRegistry as any).files.clear();
    
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

  it('should make hash-mappings.json available via getMappings() after pull', async () => {
    // This test verifies the full pull → IDB → FileRegistry → getMappings() chain
    // for the new hash-mappings.json root file. A gap here means Snapshot Manager
    // shows "no links" even after pulling a repo that contains mappings.

    const { getMappings } = await import('../hashMappingsService');

    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: [],
      lastSynced: Date.now(),
    });

    // The repo tree contains hash-mappings.json (new file, no local equivalent)
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          {
            path: 'hash-mappings.json',
            type: 'blob',
            sha: 'sha-hash-mappings-001',
            size: 200,
          },
        ],
        commitSha: 'commit-with-mappings',
      },
    });

    const mappingsPayload = {
      version: 1,
      mappings: [
        { core_hash: 'AAA', equivalent_to: 'BBB', operation: 'equivalent', weight: 1.0, created_by: 'test' },
        { core_hash: 'BBB', equivalent_to: 'CCC', operation: 'equivalent', weight: 1.0, created_by: 'test' },
      ],
    };

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: { content: JSON.stringify(mappingsPayload) },
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
      casesPath: 'cases',
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);
    expect(result.success).toBe(true);

    // The critical assertion: getMappings() must return the pulled rows.
    const mappings = getMappings();
    expect(mappings).toHaveLength(2);
    expect(mappings[0].core_hash).toBe('AAA');
    expect(mappings[0].equivalent_to).toBe('BBB');
    expect(mappings[1].core_hash).toBe('BBB');
    expect(mappings[1].equivalent_to).toBe('CCC');
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

  // ---------------------------------------------------------------------------
  // REGRESSION TESTS: isDirty=false but actual content changes
  //
  // These tests protect against the critical regression where pullLatest
  // unconditionally overwrote files when isDirty was false, even if the file
  // had real content changes (data !== originalData).
  // ---------------------------------------------------------------------------

  it('should merge (not overwrite) when isDirty is false but data differs from originalData', async () => {
    // This is the EXACT regression scenario: the file has been modified
    // (data !== originalData) but isDirty was not set (e.g. race condition,
    // editor focus loss, programmatic change). Without the defence-in-depth
    // content comparison, the pull silently overwrites local changes.

    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-drifted'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-drifted',
      type: 'parameter',
      name: 'drifted.yaml',
      path: 'parameters/drifted.yaml',
      data: { id: 'drifted', value: 999, localEdit: 'unsaved work' },         // MODIFIED
      originalData: { id: 'drifted', value: 100 },                             // Original from last sync
      isDirty: false,  // BUG SCENARIO: flag is false despite actual changes
      source: {
        repository: 'test-repo',
        path: 'parameters/drifted.yaml',
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

    // Remote has a different change
    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          { path: 'parameters/drifted.yaml', type: 'blob', sha: 'sha-new', size: 120 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: drifted\nvalue: 200\nremoteField: added remotely\n',
        sha: 'sha-new'
      }
    });

    // Mock merge3Way — the critical assertion is that merge IS called (not skipped)
    const mergeSpy = vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: false,
      merged: 'id: drifted\nvalue: 999\nlocalEdit: unsaved work\nremoteField: added remotely\n',
      conflicts: []
    });

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // CRITICAL: merge3Way MUST have been called — the old code skipped it when isDirty=false
    expect(mergeSpy).toHaveBeenCalled();
    expect(result.success).toBe(true);

    // Verify local work was preserved via merge (not overwritten with remote)
    const file = await db.files.get('parameter-drifted');
    expect(file?.data).toHaveProperty('localEdit', 'unsaved work');
    expect(file?.data).toHaveProperty('remoteField', 'added remotely');
  });

  it('should detect conflict when isDirty is false but data has conflicting changes with remote', async () => {
    // Same drift scenario, but this time local and remote changed the same field.

    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-conflict-drift'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-conflict-drift',
      type: 'parameter',
      name: 'conflict-drift.yaml',
      path: 'parameters/conflict-drift.yaml',
      data: { id: 'conflict-drift', value: 999 },       // Local changed value
      originalData: { id: 'conflict-drift', value: 100 }, // Base
      isDirty: false,  // Flag not set
      source: {
        repository: 'test-repo',
        path: 'parameters/conflict-drift.yaml',
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
          { path: 'parameters/conflict-drift.yaml', type: 'blob', sha: 'sha-new', size: 120 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: conflict-drift\nvalue: 500\n', // Remote also changed value
        sha: 'sha-new'
      }
    });

    // Mock merge3Way to report a conflict
    vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: true,
      merged: 'id: conflict-drift\n<<<<<<< LOCAL\nvalue: 999\n=======\nvalue: 500\n>>>>>>> REMOTE\n',
      conflicts: [{
        startLine: 1,
        endLine: 1,
        base: ['value: 100'],
        local: ['value: 999'],
        remote: ['value: 500']
      }]
    });

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // CRITICAL: conflict must be detected, not silently overwritten
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].fileId).toBe('parameter-conflict-drift');
    expect(result.conflicts[0].hasConflicts).toBe(true);

    // Local data must be preserved (not overwritten with remote)
    const file = await db.files.get('parameter-conflict-drift');
    expect(file?.data.value).toBe(999);
  });

  it('should safely overwrite when isDirty is false AND data matches originalData (no real changes)', async () => {
    // Control case: when isDirty is false and data truly matches originalData,
    // the file should be updated from remote without merge (fast path).

    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-clean'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-clean',
      type: 'parameter',
      name: 'clean.yaml',
      path: 'parameters/clean.yaml',
      data: { id: 'clean', value: 100 },
      originalData: { id: 'clean', value: 100 },  // Matches data — truly clean
      isDirty: false,
      source: {
        repository: 'test-repo',
        path: 'parameters/clean.yaml',
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
          { path: 'parameters/clean.yaml', type: 'blob', sha: 'sha-new', size: 120 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: clean\nvalue: 300\n',
        sha: 'sha-new'
      }
    });

    // merge3Way should NOT be called — file is genuinely clean
    const mergeSpy = vi.spyOn(mergeServiceModule, 'merge3Way');

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    expect(result.success).toBe(true);
    expect(mergeSpy).not.toHaveBeenCalled();

    // File should be updated to remote value (fast path overwrite is safe here)
    const file = await db.files.get('parameter-clean');
    expect(file?.data.value).toBe(300);
    expect(file?.sha).toBe('sha-new');
    expect(file?.isDirty).toBe(false);
  });
  // ---------------------------------------------------------------------------
  // BUG A REGRESSION: merge parse failure must surface as conflict, never be
  // silently swallowed. The text-based 3-way merge can produce structurally
  // invalid JSON/YAML (e.g. duplicate keys, broken syntax). Before this fix
  // the parse error was caught by the outer catch and discarded — the file
  // was never updated and the user received no feedback.
  // ---------------------------------------------------------------------------

  it('should surface as conflict when auto-merge produces unparseable JSON (graph file)', async () => {
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['graph-test-graph'],
      lastSynced: Date.now()
    });

    const originalGraph = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }] };
    const localGraph = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }], extra: 'local' };

    await db.files.add({
      fileId: 'graph-test-graph',
      type: 'graph',
      name: 'test-graph.json',
      path: 'graphs/test-graph.json',
      data: localGraph,
      originalData: originalGraph,
      isDirty: true,
      source: {
        repository: 'test-repo',
        path: 'graphs/test-graph.json',
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
          { path: 'graphs/test-graph.json', type: 'blob', sha: 'sha-new', size: 200 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'c' }], edges: [] }, null, 2),
        sha: 'sha-new'
      }
    });

    // Mock merge3Way to return "no conflicts" but produce INVALID JSON.
    // This simulates the real-world scenario where the text-level merge
    // produces output that looks conflict-free but is structurally broken.
    vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: false,
      merged: '{ "nodes": [{ "id": "a" }], INVALID JSON HERE }}}',
    });

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // CRITICAL: parse failure must surface as a conflict
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      fileId: 'graph-test-graph',
      type: 'graph',
      hasConflicts: true
    });

    // File in IDB must NOT be updated with corrupt data
    const file = await db.files.get('graph-test-graph');
    expect(file?.data).toEqual(localGraph);   // Still the local version
    expect(file?.sha).toBe('sha-old');        // SHA unchanged
    expect(file?.isDirty).toBe(true);         // Still dirty
  });

  it('should surface as conflict when auto-merge produces unparseable YAML (parameter file)', async () => {
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['parameter-dup-keys'],
      lastSynced: Date.now()
    });

    await db.files.add({
      fileId: 'parameter-dup-keys',
      type: 'parameter',
      name: 'dup-keys.yaml',
      path: 'parameters/dup-keys.yaml',
      data: { id: 'dup-keys', value: 100, created_at: '2025-01-01' },
      originalData: { id: 'dup-keys', value: 100 },
      isDirty: true,
      source: {
        repository: 'test-repo',
        path: 'parameters/dup-keys.yaml',
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
          { path: 'parameters/dup-keys.yaml', type: 'blob', sha: 'sha-new', size: 120 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: {
        content: 'id: dup-keys\nvalue: 200\ncreated_at: 2025-06-01\n',
        sha: 'sha-new'
      }
    });

    // Mock merge3Way to return YAML with duplicate keys (real-world failure mode)
    vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: false,
      merged: 'id: dup-keys\nvalue: 100\ncreated_at: 2025-01-01\ncreated_at: 2025-06-01\nvalue: 200\n',
    });

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // CRITICAL: must surface as conflict, not silently skip
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      fileId: 'parameter-dup-keys',
      type: 'parameter',
      hasConflicts: true
    });

    // File must NOT be corrupted in IDB
    const file = await db.files.get('parameter-dup-keys');
    expect(file?.data.value).toBe(100);       // Local value preserved
    expect(file?.sha).toBe('sha-old');
  });

  it('should tolerate duplicate YAML keys in remote index files (v1.x parseDocument workaround)', async () => {
    // Remote index files generated by the Python pipeline contain duplicate
    // `created_at` keys.  yaml v1.x YAML.parse() rejects these with
    // YAMLSemanticError.  parseYamlLenient uses parseDocument + error
    // filtering so the file loads successfully.
    const workspaceId = 'test-repo-main';
    await db.workspaces.put({
      id: workspaceId,
      name: 'test-repo',
      branch: 'main',
      repository: 'test-repo',
      createdAt: Date.now(),
      lastSynced: Date.now(),
      commitSHA: 'commit-old',
    });

    // Remote YAML with duplicate created_at (matches real-world Python pipeline output)
    const remoteContent =
      '- id: param-1\n  file_path: parameters/param-1.yaml\n  status: active\n  created_at: 2025-01-01\n  created_at: 2025-06-01\n' +
      '- id: param-2\n  file_path: parameters/param-2.yaml\n  status: active\n  created_at: 2025-02-01\n  created_at: 2025-07-01\n';

    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          { path: 'parameters-index.yaml', type: 'blob', sha: 'sha-idx-new', size: 300 }
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockResolvedValue({
      success: true,
      data: { content: remoteContent, sha: 'sha-idx-new' }
    });

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Must succeed — no conflicts, no errors
    expect(result.conflicts).toHaveLength(0);

    // Index file stored in IDB with correct data (last duplicate key wins in YAML)
    const file = await db.files.get('parameter-index');
    expect(file).toBeDefined();
    expect(file?.data).toBeInstanceOf(Array);
    expect(file?.data).toHaveLength(2);
    expect(file?.data[0].id).toBe('param-1');
    expect(file?.data[1].id).toBe('param-2');
    // Duplicate created_at: last value wins
    expect(file?.data[0].created_at).toBe('2025-06-01');
    expect(file?.data[1].created_at).toBe('2025-07-01');
  });

  it('should still apply valid auto-merge result after failed parse on a different file', async () => {
    // Ensures one file's parse failure doesn't block other files from updating
    const workspaceId = 'test-repo-main';
    await db.workspaces.add({
      id: workspaceId,
      repository: 'test-repo',
      branch: 'main',
      fileIds: ['graph-broken', 'parameter-good'],
      lastSynced: Date.now()
    });

    // File 1: graph that will fail to merge-parse
    await db.files.add({
      fileId: 'graph-broken',
      type: 'graph',
      name: 'broken.json',
      path: 'graphs/broken.json',
      data: { nodes: [{ id: 'a' }], edges: [] },
      originalData: { nodes: [], edges: [] },
      isDirty: true,
      source: { repository: 'test-repo', path: 'graphs/broken.json', branch: 'main', commitHash: 'abc' },
      isLoaded: true, isLocal: false, viewTabs: [], lastModified: Date.now(),
      sha: 'sha-old-1', lastSynced: Date.now()
    });

    // File 2: parameter that will cleanly update (not dirty)
    await db.files.add({
      fileId: 'parameter-good',
      type: 'parameter',
      name: 'good.yaml',
      path: 'parameters/good.yaml',
      data: { id: 'good', value: 10 },
      originalData: { id: 'good', value: 10 },
      isDirty: false,
      source: { repository: 'test-repo', path: 'parameters/good.yaml', branch: 'main', commitHash: 'abc' },
      isLoaded: true, isLocal: false, viewTabs: [], lastModified: Date.now(),
      sha: 'sha-old-2', lastSynced: Date.now()
    });

    vi.mocked(gitService.setCredentials).mockImplementation(() => {});
    vi.mocked(gitService.getRepositoryTree).mockResolvedValue({
      success: true,
      data: {
        tree: [
          { path: 'graphs/broken.json', type: 'blob', sha: 'sha-new-1', size: 200 },
          { path: 'parameters/good.yaml', type: 'blob', sha: 'sha-new-2', size: 100 },
        ],
        commitSha: 'commit-new'
      }
    });

    vi.mocked(gitService.getBlobContent).mockImplementation(async (sha: string) => {
      if (sha === 'sha-new-1') {
        return { success: true, data: { content: '{"nodes":[]}', sha: 'sha-new-1' } };
      }
      return { success: true, data: { content: 'id: good\nvalue: 99\n', sha: 'sha-new-2' } };
    });

    // Only the graph file triggers merge (it's dirty); mock to produce invalid JSON
    vi.spyOn(mergeServiceModule, 'merge3Way').mockReturnValue({
      success: true,
      hasConflicts: false,
      merged: 'NOT VALID JSON AT ALL',
    });

    const gitCreds = {
      name: 'test-repo', owner: 'test-owner', token: 'test-token', basePath: '',
      paramsPath: 'parameters', graphsPath: 'graphs', nodesPath: 'nodes',
      eventsPath: 'events', contextsPath: 'contexts', casesPath: 'cases'
    };

    const result = await workspaceService.pullLatest('test-repo', 'main', gitCreds);

    // Broken file → conflict
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].fileId).toBe('graph-broken');

    // Good file → updated normally
    const goodFile = await db.files.get('parameter-good');
    expect(goodFile?.data.value).toBe(99);
    expect(goodFile?.sha).toBe('sha-new-2');
  });
});

// ---------------------------------------------------------------------------
// POLICY INVARIANT: pullLatestRemoteWins must NEVER be called from interactive paths
//
// This static analysis test ensures that pullLatestRemoteWins is only called from
// explicitly headless/unattended contexts. If someone adds a new caller, this test
// fails and forces them to justify the decision.
//
// Background: a critical regression occurred when nonBlockingPullService (interactive
// auto-pull with countdown) used pullLatestRemoteWins, silently overwriting dirty
// local files. The fix was to use pullLatest (3-way merge) in all interactive paths.
// ---------------------------------------------------------------------------

describe('POLICY: pullLatestRemoteWins usage is restricted to headless contexts', () => {
  // Exhaustive allowlist of files permitted to call pullLatestRemoteWins.
  // Any file NOT in this list that calls pullLatestRemoteWins will fail this test.
  const ALLOWED_CALLERS = new Set([
    // The method definition itself
    'repositoryOperationsService.ts',
    // Headless nightly automation
    'dailyRetrieveAllAutomationService.ts',
    // Headless URL-triggered automation
    'useURLDailyRetrieveAllQueue.ts',
    // Staleness nudge service — only calls it behind isDashboardMode guard
    'stalenessNudgeService.ts',
    // useStalenessNudges wires the callback but stalenessNudgeService gates it
    'useStalenessNudges.ts',
  ]);

  it('should only be called from explicitly headless/unattended code paths', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const glob = await import('glob');

    const srcRoot = path.resolve(__dirname, '../..');
    const allTsFiles = glob.sync('**/*.{ts,tsx}', {
      cwd: srcRoot,
      ignore: ['**/__tests__/**', '**/node_modules/**', '**/*.test.*', '**/*.spec.*'],
    });

    const violations: string[] = [];
    for (const relPath of allTsFiles) {
      const fullPath = path.join(srcRoot, relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check each non-comment line for actual calls to pullLatestRemoteWins.
      // Lines that are purely comments (// or * prefix) are excluded —
      // we care about real invocations, not explanatory references.
      const hasRealCall = content.split('\n').some(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
        return trimmed.includes('pullLatestRemoteWins');
      });
      if (!hasRealCall) continue;

      const fileName = path.basename(relPath);
      if (!ALLOWED_CALLERS.has(fileName)) {
        violations.push(relPath);
      }
    }

    expect(violations).toEqual([]);
  });
});

