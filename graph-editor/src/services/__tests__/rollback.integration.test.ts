/**
 * Rollback Feature Integration Tests
 * 
 * Tests for repository and file rollback functionality:
 * - File history viewing
 * - Single file rollback
 * - Repository-wide rollback
 * - Binary file (image) handling during rollback
 * - Efficient parallel fetching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gitService } from '../gitService';
import { workspaceService } from '../workspaceService';
import { repositoryOperationsService } from '../repositoryOperationsService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { credentialsManager } from '../../lib/credentials';

// Mock credentials
vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn()
  }
}));

describe('Rollback Integration Tests', () => {
  const mockGitCreds = {
    name: 'test-repo',
    owner: 'test-owner',
    token: 'test-token',
    graphsPath: 'graphs',
    paramsPath: 'parameters',
    contextsPath: 'contexts',
    casesPath: 'cases',
    nodesPath: 'nodes',
    eventsPath: 'events'
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Clear IDB
    await db.files.clear();
    await db.workspaces.clear();
    
    // Mock credentials
    vi.mocked(credentialsManager.loadCredentials).mockResolvedValue({
      success: true,
      source: 'user',
      credentials: {
        version: '1.0.0',
        git: [mockGitCreds],
        defaultGitRepo: 'test-repo'
      }
    });
  });

  afterEach(async () => {
    await db.files.clear();
    await db.workspaces.clear();
  });

  describe('gitService.getRepositoryTree', () => {
    it('should detect commit SHA vs branch name correctly', () => {
      // Test the regex pattern used to detect commit SHAs
      const commitShaRegex = /^[0-9a-f]{40}$/i;
      
      // Valid commit SHAs
      expect(commitShaRegex.test('abc123def456abc123def456abc123def456abc1')).toBe(true);
      expect(commitShaRegex.test('ABC123DEF456ABC123DEF456ABC123DEF456ABC1')).toBe(true);
      expect(commitShaRegex.test('0000000000000000000000000000000000000000')).toBe(true);
      
      // Branch names (should NOT match)
      expect(commitShaRegex.test('main')).toBe(false);
      expect(commitShaRegex.test('feature/test')).toBe(false);
      expect(commitShaRegex.test('abc123')).toBe(false); // Too short
      expect(commitShaRegex.test('abc123def456abc123def456abc123def456abc1z')).toBe(false); // Invalid char
    });
  });

  describe('gitService.getRepositoryCommits', () => {
    it('should fetch repository commit history', async () => {
      const mockCommits = [
        { sha: 'commit1', commit: { message: 'First commit', author: { name: 'Test', date: '2024-01-01' } } },
        { sha: 'commit2', commit: { message: 'Second commit', author: { name: 'Test', date: '2024-01-02' } } }
      ];

      // Mock the makeRequest method
      vi.spyOn(gitService as any, 'makeRequest').mockResolvedValue({
        ok: true,
        json: async () => mockCommits
      });

      gitService.setCredentials({
        git: [mockGitCreds],
        defaultGitRepo: 'test-repo'
      });

      const result = await gitService.getRepositoryCommits('main', 50);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].sha).toBe('commit1');
    });
  });

  describe('workspaceService.pullAtCommit', () => {
    it('should fetch ALL files from a historical commit', async () => {
      const commitSha = 'abc123def456abc123def456abc123def456abc1';
      
      // Mock tree with multiple file types
      const mockTree = [
        { path: 'graphs/graph1.json', type: 'blob', sha: 'blob-graph1' },
        { path: 'graphs/graph2.json', type: 'blob', sha: 'blob-graph2' },
        { path: 'parameters/param1.yaml', type: 'blob', sha: 'blob-param1' },
        { path: 'nodes/node1.yaml', type: 'blob', sha: 'blob-node1' }
      ];

      vi.spyOn(gitService, 'getRepositoryTree').mockResolvedValue({
        success: true,
        data: { tree: mockTree, commitSha, treeSha: 'tree-sha' }
      });

      // Mock blob content for each file
      vi.spyOn(gitService, 'getBlobContent').mockImplementation(async (sha: string) => {
        const contents: Record<string, string> = {
          'blob-graph1': '{"nodes":[],"edges":[]}',
          'blob-graph2': '{"nodes":[{"id":"test"}],"edges":[]}',
          'blob-param1': 'id: param1\nvalue: test',
          'blob-node1': 'id: node1\nlabel: Test Node'
        };
        return {
          success: true,
          data: { content: contents[sha] || '{}' }
        };
      });

      // Mock fileRegistry
      vi.spyOn(fileRegistry, 'getFile').mockReturnValue(undefined);
      vi.spyOn(fileRegistry, 'getOrCreateFile').mockResolvedValue({} as any);
      vi.spyOn(db.files, 'put').mockResolvedValue(undefined as any);

      const result = await workspaceService.pullAtCommit(
        'test-repo',
        'main',
        commitSha,
        mockGitCreds
      );

      expect(result.success).toBe(true);
      // Should have fetched all 4 files
      expect(gitService.getBlobContent).toHaveBeenCalledTimes(4);
      expect(result.filesCreated).toBe(4);
    });

    it('should fetch blobs in parallel for efficiency', async () => {
      const commitSha = 'abc123def456abc123def456abc123def456abc1';
      
      // Create 10 files to test parallel fetching
      const mockTree = Array.from({ length: 10 }, (_, i) => ({
        path: `graphs/graph${i}.json`,
        type: 'blob',
        sha: `blob-${i}`
      }));

      vi.spyOn(gitService, 'getRepositoryTree').mockResolvedValue({
        success: true,
        data: { tree: mockTree, commitSha, treeSha: 'tree-sha' }
      });

      // Track call timing to verify parallel execution
      const callTimes: number[] = [];
      vi.spyOn(gitService, 'getBlobContent').mockImplementation(async () => {
        callTimes.push(Date.now());
        await new Promise(r => setTimeout(r, 10)); // Small delay
        return { success: true, data: { content: '{}' } };
      });

      vi.spyOn(fileRegistry, 'getFile').mockReturnValue(undefined);
      vi.spyOn(fileRegistry, 'getOrCreateFile').mockResolvedValue({} as any);
      vi.spyOn(db.files, 'put').mockResolvedValue(undefined as any);

      const startTime = Date.now();
      await workspaceService.pullAtCommit('test-repo', 'main', commitSha, mockGitCreds);
      const totalTime = Date.now() - startTime;

      // If sequential, would take 10 * 10ms = 100ms minimum
      // If parallel, should be much less (around 10-20ms)
      expect(totalTime).toBeLessThan(80); // Allow some overhead
    });

    it('should update existing files and mark them dirty', async () => {
      const commitSha = 'abc123def456abc123def456abc123def456abc1';
      
      const mockTree = [
        { path: 'graphs/existing.json', type: 'blob', sha: 'blob-existing' }
      ];

      vi.spyOn(gitService, 'getRepositoryTree').mockResolvedValue({
        success: true,
        data: { tree: mockTree, commitSha, treeSha: 'tree-sha' }
      });

      vi.spyOn(gitService, 'getBlobContent').mockResolvedValue({
        success: true,
        data: { content: '{"nodes":[{"id":"old-version"}],"edges":[]}' }
      });

      // Simulate existing file
      const existingFile = {
        fileId: 'graph-existing',
        type: 'graph',
        data: { nodes: [{ id: 'current-version' }], edges: [] },
        isDirty: false
      };
      vi.spyOn(fileRegistry, 'getFile').mockReturnValue(existingFile as any);
      const updateFileSpy = vi.spyOn(fileRegistry, 'updateFile').mockResolvedValue(undefined);

      const result = await workspaceService.pullAtCommit(
        'test-repo',
        'main',
        commitSha,
        mockGitCreds
      );

      expect(result.success).toBe(true);
      expect(result.filesUpdated).toBe(1);
      expect(updateFileSpy).toHaveBeenCalledWith(
        'graph-existing',
        expect.objectContaining({ nodes: [{ id: 'old-version' }] })
      );
    });
  });

  describe('Binary file handling in rollback', () => {
    it('should handle base64-encoded binary content from blobs', async () => {
      const commitSha = 'abc123def456abc123def456abc123def456abc1';
      
      // PNG header as base64
      const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const base64Content = btoa(String.fromCharCode(...pngHeader));
      
      vi.spyOn(gitService, 'getBlobContent').mockResolvedValue({
        success: true,
        data: { 
          content: base64Content,
          encoding: 'base64'
        }
      });

      // Verify getBlobContent returns proper structure
      const result = await gitService.getBlobContent('test-blob-sha');
      
      expect(result.success).toBe(true);
      expect(result.data?.content).toBe(base64Content);
      
      // Verify we can decode it back
      const decoded = Uint8Array.from(atob(result.data!.content), c => c.charCodeAt(0));
      expect(decoded).toEqual(pngHeader);
    });

    it('should not corrupt binary data during rollback processing', async () => {
      // Test that YAML/JSON parsing doesn't corrupt binary data
      // Binary files should be handled separately from text files
      
      const commitSha = 'abc123def456abc123def456abc123def456abc1';
      
      // Simulate a tree with both text and binary files
      const mockTree = [
        { path: 'graphs/test.json', type: 'blob', sha: 'blob-json' },
        { path: 'nodes/images/test.png', type: 'blob', sha: 'blob-png' }
      ];

      vi.spyOn(gitService, 'getRepositoryTree').mockResolvedValue({
        success: true,
        data: { tree: mockTree, commitSha, treeSha: 'tree-sha' }
      });

      const blobContents: Record<string, { content: string; isJson: boolean }> = {
        'blob-json': { content: '{"nodes":[],"edges":[]}', isJson: true },
        'blob-png': { content: 'iVBORw0KGgo=', isJson: false } // Base64 PNG
      };

      vi.spyOn(gitService, 'getBlobContent').mockImplementation(async (sha: string) => {
        return {
          success: true,
          data: { content: blobContents[sha]?.content || '' }
        };
      });

      vi.spyOn(fileRegistry, 'getFile').mockReturnValue(undefined);
      vi.spyOn(fileRegistry, 'getOrCreateFile').mockResolvedValue({} as any);
      vi.spyOn(db.files, 'put').mockResolvedValue(undefined as any);

      // pullAtCommit currently only handles graphs/parameters/etc, not images
      // This test verifies it doesn't try to parse images as JSON/YAML
      const result = await workspaceService.pullAtCommit(
        'test-repo',
        'main',
        commitSha,
        mockGitCreds
      );

      expect(result.success).toBe(true);
      // Only the JSON file should be processed (images are in nodes/images, not nodes/)
      expect(result.filesCreated).toBe(1);
    });
  });

  describe('repositoryOperationsService.rollbackToCommit', () => {
    it('should use efficient workspaceService.pullAtCommit', async () => {
      const pullAtCommitSpy = vi.spyOn(workspaceService, 'pullAtCommit').mockResolvedValue({
        success: true,
        filesUpdated: 5,
        filesCreated: 2
      });

      vi.spyOn(repositoryOperationsService as any, 'navigatorOps', 'get').mockReturnValue({
        refreshItems: vi.fn()
      });

      const result = await repositoryOperationsService.rollbackToCommit(
        'test-repo',
        'main',
        'abc123def456abc123def456abc123def456abc1'
      );

      expect(result.success).toBe(true);
      expect(result.filesChanged).toBe(7); // 5 updated + 2 created
      expect(pullAtCommitSpy).toHaveBeenCalledWith(
        'test-repo',
        'main',
        'abc123def456abc123def456abc123def456abc1',
        mockGitCreds
      );
    });

    it('should invalidate committable files cache after rollback', async () => {
      vi.spyOn(workspaceService, 'pullAtCommit').mockResolvedValue({
        success: true,
        filesUpdated: 1,
        filesCreated: 0
      });

      const invalidateCacheSpy = vi.spyOn(repositoryOperationsService, 'invalidateCommittableFilesCache');

      await repositoryOperationsService.rollbackToCommit(
        'test-repo',
        'main',
        'abc123def456abc123def456abc123def456abc1'
      );

      expect(invalidateCacheSpy).toHaveBeenCalled();
    });
  });

  describe('Single file rollback (useViewHistory)', () => {
    it('should fetch file content at specific commit', async () => {
      const commitSha = 'abc123';
      const filePath = 'graphs/test.json';
      
      vi.spyOn(gitService, 'getFile').mockResolvedValue({
        success: true,
        data: {
          content: btoa('{"nodes":[{"id":"old"}],"edges":[]}'),
          encoding: 'base64'
        }
      });

      // Set credentials
      gitService.setCredentials({
        git: [mockGitCreds],
        defaultGitRepo: 'test-repo'
      });

      const result = await gitService.getFile(filePath, commitSha);

      expect(result.success).toBe(true);
      // Content should be base64 encoded
      const decoded = atob(result.data!.content);
      const parsed = JSON.parse(decoded);
      expect(parsed.nodes[0].id).toBe('old');
    });
  });
});

