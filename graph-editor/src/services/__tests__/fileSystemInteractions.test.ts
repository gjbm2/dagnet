/**
 * FileOperationsService Persistence & Registry Integration Tests
 * 
 * Tests the fix for "Files disappear on F5" and registry sync hardening.
 * Ensures that files are created with the correct repository/branch source
 * derived from the current workspace state.
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileOperationsService } from '../fileOperationsService';

// Mock dependencies
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  
  return {
    fileRegistry: {
      getOrCreateFile: vi.fn(),
      getFile: vi.fn(),
      updateFile: vi.fn(),
      deleteFile: vi.fn(),
      getAllFiles: vi.fn(() => []),
      _mockFiles: mockFiles
    }
  };
});

vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      get: vi.fn(),
      add: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    }
  }
}));

vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn().mockResolvedValue({ success: true, credentials: {} })
  }
}));

// Need to import fileRegistry after mocking to spy on it
const { fileRegistry } = await import('../../contexts/TabContext');

describe('FileOperationsService Persistence', () => {
  let navigatorOps: any;
  let tabOps: any;
  let dialogOps: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    navigatorOps = {
      addLocalItem: vi.fn(),
      refreshItems: vi.fn(),
    };
    
    tabOps = {
      openTab: vi.fn(),
    };
    
    dialogOps = {
      showConfirm: vi.fn().mockResolvedValue(true),
    };
  });

  it('should use provided workspace state for file creation source', async () => {
    // 1. Setup workspace state mock
    const getWorkspaceState = vi.fn().mockReturnValue({
      repo: 'my-custom-repo',
      branch: 'feature-branch'
    });

    // 2. Initialize service with the getter
    fileOperationsService.initialize({
      navigatorOps,
      tabOps,
      dialogOps,
      getWorkspaceState
    });

    // 3. Mock getOrCreateFile
    const getOrCreateFileSpy = vi.spyOn(fileRegistry, 'getOrCreateFile').mockResolvedValue({
      fileId: 'event-test-event',
      type: 'event',
      data: { id: 'test-event' },
      source: { repository: 'my-custom-repo', branch: 'feature-branch' },
      isDirty: false,
      viewTabs: []
    } as any);

    // 4. Action: Create file
    await fileOperationsService.createFile('test-event', 'event');

    // 5. Verification
    expect(getWorkspaceState).toHaveBeenCalled();
    
    // Check if getOrCreateFile was called with correct source
    expect(getOrCreateFileSpy).toHaveBeenCalledWith(
      expect.stringContaining('test-event'), // fileId
      'event',                               // type
      expect.objectContaining({              // source
        repository: 'my-custom-repo',
        branch: 'feature-branch'
      }),
      expect.any(Object)                     // data
    );
  });

  it('should default to local/main if workspace state getter is missing', async () => {
    // 1. Initialize WITHOUT getter
    fileOperationsService.initialize({
      navigatorOps,
      tabOps,
      dialogOps,
      // No getWorkspaceState
    });

    const getOrCreateFileSpy = vi.spyOn(fileRegistry, 'getOrCreateFile').mockResolvedValue({
      fileId: 'default-event',
      type: 'event',
      data: {},
      source: { repository: 'local', branch: 'main' },
      isDirty: false,
      viewTabs: []
    } as any);

    // 2. Action
    await fileOperationsService.createFile('default-event', 'event');

    // 3. Verification
    expect(getOrCreateFileSpy).toHaveBeenCalledWith(
      expect.any(String),
      'event',
      expect.objectContaining({
        repository: 'local',
        branch: 'main'
      }),
      expect.any(Object)
    );
  });

  it('should update index file with correct workspace info', async () => {
     // 1. Setup workspace state mock
    const getWorkspaceState = vi.fn().mockReturnValue({
      repo: 'my-repo',
      branch: 'dev'
    });

    fileOperationsService.initialize({
      navigatorOps,
      tabOps,
      dialogOps,
      getWorkspaceState
    });

    // 2. Mock file registry to return 'event' file created
    vi.spyOn(fileRegistry, 'getOrCreateFile').mockImplementation(async (id, type, source, data) => {
      if (type === 'event') {
        return {
          fileId: id,
          type,
          source, // Should receive passed source
          data,
          isDirty: false,
          viewTabs: []
        } as any;
      }
      // Handle index file creation mock
      if (id.endsWith('-index')) {
        return {
          fileId: id,
          type,
          source,
          data: { events: [] },
          isDirty: false,
          viewTabs: []
        } as any;
      }
      return {} as any;
    });

    // Mock getFile to return null for index initially (so it gets created)
    vi.spyOn(fileRegistry, 'getFile').mockReturnValue(undefined);

    // 3. Action
    await fileOperationsService.createFile('indexed-event', 'event');

    // 4. Verify index file creation used correct source from workspace state
    //    (Not defaulting to local)
    expect(fileRegistry.getOrCreateFile).toHaveBeenCalledWith(
      'event-index',
      'event',
      expect.objectContaining({
        repository: 'my-repo',
        branch: 'dev'
      }),
      expect.any(Object)
    );
  });
});

