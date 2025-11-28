/**
 * Pull Operations Tests
 * 
 * Tests for single-file and all-files pull operations.
 * These test the service layer that the usePullFile and usePullAll hooks depend on.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { repositoryOperationsService } from '../repositoryOperationsService';
import { fileRegistry } from '../../contexts/TabContext';
import { credentialsManager } from '../../lib/credentials';
import { gitService } from '../gitService';
import { db } from '../../db/appDatabase';

// Mock dependencies
vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn()
  }
}));

vi.mock('../gitService', () => ({
  gitService: {
    setCredentials: vi.fn(),
    getFileContent: vi.fn()
  }
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      put: vi.fn(),
      get: vi.fn()
    }
  }
}));

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
    updateFile: vi.fn(),
    notifyListeners: vi.fn()
  }
}));

describe('Pull Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pullFile', () => {
    const mockFileId = 'parameter-test-param';
    const mockRepository = 'test-repo';
    const mockBranch = 'main';
    const mockFilePath = 'parameters/test-param.yaml';

    // Helper to create mock credentials
    const createMockCredentials = (repoName: string = mockRepository) => ({
      success: true,
      credentials: {
        git: [{ 
          name: repoName,
          owner: 'test-owner',
          token: 'test-token',
          basePath: 'test-path'
        }]
      }
    });

    it('should fail if file is not in registry', async () => {
      vi.mocked(fileRegistry.getFile).mockReturnValue(undefined);

      await expect(
        repositoryOperationsService.pullFile(mockFileId, mockRepository, mockBranch)
      ).rejects.toThrow('File parameter-test-param not found in registry');
    });

    it('should fail if file has no source path', async () => {
      vi.mocked(fileRegistry.getFile).mockReturnValue({
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: {},
        source: {} // No path
      } as any);

      await expect(
        repositoryOperationsService.pullFile(mockFileId, mockRepository, mockBranch)
      ).rejects.toThrow('has no source path');
    });

    it('should fail if no credentials available', async () => {
      vi.mocked(fileRegistry.getFile).mockReturnValue({
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: {},
        source: { path: mockFilePath }
      } as any);

      vi.mocked(credentialsManager.loadCredentials).mockResolvedValue({
        success: false
      });

      await expect(
        repositoryOperationsService.pullFile(mockFileId, mockRepository, mockBranch)
      ).rejects.toThrow('No credentials available');
    });

    it('should fail if repository not found in credentials', async () => {
      vi.mocked(fileRegistry.getFile).mockReturnValue({
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: {},
        source: { path: mockFilePath }
      } as any);

      vi.mocked(credentialsManager.loadCredentials).mockResolvedValue(
        createMockCredentials('different-repo')
      );

      await expect(
        repositoryOperationsService.pullFile(mockFileId, mockRepository, mockBranch)
      ).rejects.toThrow('Repository "test-repo" not found in credentials');
    });

    it('should successfully pull and parse YAML file', async () => {
      const mockYamlContent = `name: test-param
type: probability
value: 0.5`;

      vi.mocked(fileRegistry.getFile).mockReturnValue({
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: { name: 'test-param', type: 'probability', value: 0.3 },
        source: { path: mockFilePath }
      } as any);

      vi.mocked(credentialsManager.loadCredentials).mockResolvedValue(
        createMockCredentials()
      );

      vi.mocked(gitService.getFileContent).mockResolvedValue({
        success: true,
        data: {
          content: mockYamlContent,
          sha: 'new-sha-123'
        }
      });

      vi.mocked(db.files.put).mockResolvedValue(mockFileId);

      const result = await repositoryOperationsService.pullFile(
        mockFileId,
        mockRepository,
        mockBranch
      );

      expect(result.success).toBe(true);
      expect(gitService.setCredentials).toHaveBeenCalled();
      expect(gitService.getFileContent).toHaveBeenCalledWith(mockFilePath, mockBranch);
      expect(db.files.put).toHaveBeenCalled();
    });

    it('should successfully pull and parse JSON file', async () => {
      const mockJsonContent = '{"name": "test-param", "value": 42}';
      const mockJsonPath = 'parameters/test-param.json';

      vi.mocked(fileRegistry.getFile).mockReturnValue({
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: { name: 'test-param', value: 10 },
        source: { path: mockJsonPath }
      } as any);

      vi.mocked(credentialsManager.loadCredentials).mockResolvedValue(
        createMockCredentials()
      );

      vi.mocked(gitService.getFileContent).mockResolvedValue({
        success: true,
        data: {
          content: mockJsonContent,
          sha: 'new-sha-456'
        }
      });

      vi.mocked(db.files.put).mockResolvedValue(mockFileId);

      const result = await repositoryOperationsService.pullFile(
        mockFileId,
        mockRepository,
        mockBranch
      );

      expect(result.success).toBe(true);
    });

    it('should handle getFileContent failure', async () => {
      vi.mocked(fileRegistry.getFile).mockReturnValue({
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: {},
        source: { path: mockFilePath }
      } as any);

      vi.mocked(credentialsManager.loadCredentials).mockResolvedValue(
        createMockCredentials()
      );

      vi.mocked(gitService.getFileContent).mockResolvedValue({
        success: false,
        error: 'File not found on remote'
      });

      await expect(
        repositoryOperationsService.pullFile(mockFileId, mockRepository, mockBranch)
      ).rejects.toThrow('File not found on remote');
    });

    it('should update file isDirty and isLocal flags after pull', async () => {
      const mockFile: any = {
        id: mockFileId,
        name: 'test-param',
        type: 'parameter',
        data: { value: 'old' },
        originalData: { value: 'original' },
        isDirty: true,
        isLocal: true,
        sha: 'old-sha',
        source: { path: mockFilePath }
      };

      vi.mocked(fileRegistry.getFile).mockReturnValue(mockFile);

      vi.mocked(credentialsManager.loadCredentials).mockResolvedValue(
        createMockCredentials()
      );

      vi.mocked(gitService.getFileContent).mockResolvedValue({
        success: true,
        data: {
          content: 'value: new',
          sha: 'new-sha'
        }
      });

      vi.mocked(db.files.put).mockResolvedValue(mockFileId);

      await repositoryOperationsService.pullFile(mockFileId, mockRepository, mockBranch);

      // Verify the file object was updated
      expect(mockFile.isDirty).toBe(false);
      expect(mockFile.isLocal).toBe(false);
      expect(mockFile.sha).toBe('new-sha');
    });
  });
});
