/**
 * Git Service Integration Tests
 * 
 * Tests real git operations with mocked Octokit responses
 * Tests the actual code paths used in production
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gitService } from '../gitService';

describe('GitService Integration Tests', () => {
  let fetchMock: any;
  let octokitMock: any;

  beforeEach(() => {
    // Mock global fetch for GitHub API calls
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    // Mock Octokit instance
    octokitMock = {
      git: {
        getRef: vi.fn(),
        getCommit: vi.fn(),
        getTree: vi.fn(),
        getBlob: vi.fn(),
        createBlob: vi.fn(),
        createTree: vi.fn(),
        createCommit: vi.fn(),
        updateRef: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
        deleteFile: vi.fn(),
      },
    };
    
    // Replace gitService's octokit instance
    (gitService as any).octokit = octokitMock;
    
    // Reset gitService state
    (gitService as any).config = {
      repoOwner: 'test-owner',
      repoName: 'test-repo',
      branch: 'main',
      debugGitOperations: false,
    };
    
    (gitService as any).currentRepo = {
      owner: 'test-owner',
      name: 'test-repo',
      repo: 'test-repo',
    };

    // Default mock returns for the commit pipeline
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'base-commit' } } });
    octokitMock.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'base-tree' } } });
    // getTree (recursive) — return a tree that contains common test paths
    // so delete validation works. Tests can override this if needed.
    octokitMock.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: 'graphs/test.json', type: 'blob' },
          { path: 'parameters/old-param.yaml', type: 'blob' },
          { path: 'parameters/new-param.yaml', type: 'blob' },
          { path: 'parameters-index.yaml', type: 'blob' },
          { path: 'nodes/images/test.png', type: 'blob' },
        ],
      },
    });
    octokitMock.git.createBlob.mockResolvedValue({ data: { sha: 'new-blob-sha' } });
    octokitMock.git.createTree.mockResolvedValue({ data: { sha: 'new-tree-sha' } });
    octokitMock.git.createCommit.mockResolvedValue({ data: { sha: 'new-commit-sha' } });
    octokitMock.git.updateRef.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Repository Tree Fetching (Pull Operations)', () => {
    it('should fetch entire repository tree with one API call', async () => {
      // Mock Octokit API calls
      octokitMock.git.getRef.mockResolvedValue({
        data: { object: { sha: 'commit-abc123' } }
      });
      
      octokitMock.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'tree-def456' } }
      });
      
      octokitMock.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: 'graphs/test.json', type: 'blob', sha: 'blob1', size: 100 },
            { path: 'parameters-index.yaml', type: 'blob', sha: 'blob2', size: 50 },
            { path: 'nodes-index.yaml', type: 'blob', sha: 'blob3', size: 80 },
            { path: 'parameters/test-param.yaml', type: 'blob', sha: 'blob4', size: 60 },
          ]
        }
      });

      const result = await gitService.getRepositoryTree('main', true);

      expect(result.success).toBe(true);
      expect(result.data?.tree).toHaveLength(4);
      expect(result.data?.commitSha).toBe('commit-abc123');
      expect(result.data?.treeSha).toBe('tree-def456');
      
      // Should have made exactly 3 Octokit calls
      expect(octokitMock.git.getRef).toHaveBeenCalledTimes(1);
      expect(octokitMock.git.getCommit).toHaveBeenCalledTimes(1);
      expect(octokitMock.git.getTree).toHaveBeenCalledTimes(1);
      
      // Verify tree includes index files at root
      const tree = result.data?.tree || [];
      expect(tree.some((f: any) => f.path === 'parameters-index.yaml')).toBe(true);
      expect(tree.some((f: any) => f.path === 'nodes-index.yaml')).toBe(true);
    });

    it('should fetch blob content by SHA', async () => {
      octokitMock.git.getBlob.mockResolvedValue({
        data: {
          content: Buffer.from('{"test": "data"}').toString('base64'),
          encoding: 'base64'
        }
      });

      const result = await gitService.getBlobContent('blob-sha-123');

      expect(result.success).toBe(true);
      expect(result.data?.content).toBe('{"test": "data"}');
      expect(octokitMock.git.getBlob).toHaveBeenCalledTimes(1);
    });
  });

  describe('File Commit Operations (Push) - Atomic Commits via Git Data API', () => {
    beforeEach(() => {
      // Setup default Octokit mocks for atomic commit flow
      octokitMock.git.getRef.mockResolvedValue({
        data: { object: { sha: 'base-commit-sha' } }
      });
      octokitMock.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'base-tree-sha' } }
      });
      octokitMock.git.createBlob.mockResolvedValue({
        data: { sha: 'new-blob-sha' }
      });
      octokitMock.git.createTree.mockResolvedValue({
        data: { sha: 'new-tree-sha' }
      });
      octokitMock.git.createCommit.mockResolvedValue({
        data: { sha: 'new-commit-sha' }
      });
      octokitMock.git.updateRef.mockResolvedValue({
        data: { object: { sha: 'new-commit-sha' } }
      });
    });

    it('should commit multiple files in ONE atomic commit', async () => {
      const files = [
        { path: 'graphs/graph1.json', content: '{"nodes":[]}' },
        { path: 'parameters-index.yaml', content: 'version: 1.0.0' },
      ];

      const result = await gitService.commitAndPushFiles(files, 'Test commit', 'main');

      expect(result.success).toBe(true);
      expect(result.data?.filesCommitted).toBe(2);
      
      // Verify atomic flow: getRef -> getCommit -> createBlob(s) -> createTree -> createCommit -> updateRef
      expect(octokitMock.git.getRef).toHaveBeenCalledTimes(1);
      expect(octokitMock.git.getCommit).toHaveBeenCalledTimes(1);
      expect(octokitMock.git.createBlob).toHaveBeenCalledTimes(2); // One per file
      expect(octokitMock.git.createTree).toHaveBeenCalledTimes(1); // Single tree with all changes
      expect(octokitMock.git.createCommit).toHaveBeenCalledTimes(1); // Single commit
      expect(octokitMock.git.updateRef).toHaveBeenCalledTimes(1); // Single ref update
    });

    it('should handle file deletions in atomic commit', async () => {
      const files = [
        { path: 'parameters/old-param.yaml', delete: true },
        { path: 'parameters/new-param.yaml', content: 'id: new-param' },
      ];

      const result = await gitService.commitAndPushFiles(files, 'Rename parameter', 'main');

      expect(result.success).toBe(true);
      
      // Verify tree was created with both delete and add
      expect(octokitMock.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          base_tree: 'base-tree-sha',
          tree: expect.arrayContaining([
            expect.objectContaining({ path: 'parameters/old-param.yaml', sha: null }), // Delete
            expect.objectContaining({ path: 'parameters/new-param.yaml', sha: 'new-blob-sha' }), // Add
          ])
        })
      );
    });

    it('should handle binary files (images) in atomic commit', async () => {
      const binaryData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
      const files = [
        {
          path: 'nodes/images/test.png',
          binaryContent: binaryData,
          encoding: 'base64' as const,
        },
      ];

      const result = await gitService.commitAndPushFiles(files, 'Add image', 'main');

      expect(result.success).toBe(true);
      
      // Verify blob was created with base64 encoding
      expect(octokitMock.git.createBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          encoding: 'base64',
        })
      );
    });

    it('should fail gracefully if API call fails', async () => {
      octokitMock.git.createTree.mockRejectedValue(new Error('Tree creation failed'));

      const files = [
        { path: 'graphs/test.json', content: '{}' },
      ];

      const result = await gitService.commitAndPushFiles(files, 'Test', 'main');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Tree creation failed');
    });
  });

  describe('Single File Operations (Contents API)', () => {
    it('should commit a single file to GitHub via Contents API', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'new-sha-456' } }),
          json: async () => ({
            content: { sha: 'new-sha-456' },
            commit: { sha: 'commit-789' }
          })
        });

      const result = await gitService.createOrUpdateFile(
        'graphs/test.json',
        JSON.stringify({ nodes: [], edges: [] }),
        'Add test graph',
        'main',
        'current-sha-123'
      );

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should handle 409 conflict errors gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ message: 'SHA does not match' }),
        json: async () => ({ message: 'SHA does not match' })
      });

      const result = await gitService.createOrUpdateFile(
        'graphs/test.json',
        '{}',
        'Update',
        'main',
        'wrong-sha'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SHA does not match');
    });
  });

  describe('Index File Path Handling', () => {
    beforeEach(() => {
      // Setup Octokit mocks
      octokitMock.git.getRef.mockResolvedValue({
        data: { object: { sha: 'base-commit' } }
      });
      octokitMock.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'base-tree' } }
      });
      octokitMock.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      });
      octokitMock.git.createTree.mockResolvedValue({
        data: { sha: 'new-tree' }
      });
      octokitMock.git.createCommit.mockResolvedValue({
        data: { sha: 'new-commit' }
      });
      octokitMock.git.updateRef.mockResolvedValue({
        data: { object: { sha: 'new-commit' } }
      });
    });

    it('should commit index files to root with plural names', async () => {
      const files = [
        { path: 'parameters-index.yaml', content: 'version: 1.0.0\nparameters: []' },
      ];

      await gitService.commitAndPushFiles(files, 'Create index', 'main');

      // Verify tree entry has correct path
      expect(octokitMock.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          tree: expect.arrayContaining([
            expect.objectContaining({ path: 'parameters-index.yaml' })
          ])
        })
      );
    });

    it('should handle graph files in graphs directory', async () => {
      const files = [
        { path: 'graphs/my-graph.json', content: '{"nodes":[],"edges":[]}' },
      ];

      await gitService.commitAndPushFiles(files, 'Add graph', 'main');

      expect(octokitMock.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          tree: expect.arrayContaining([
            expect.objectContaining({ path: 'graphs/my-graph.json' })
          ])
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle network failures', async () => {
      octokitMock.git.getRef.mockRejectedValue(new Error('Network error'));

      const result = await gitService.getRepositoryTree('main', true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should handle empty file list', async () => {
      const result = await gitService.commitAndPushFiles([], 'Empty', 'main');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No files to commit');
    });

    it('should handle invalid JSON responses', async () => {
      octokitMock.git.getRef.mockRejectedValue(new Error('Invalid response'));

      const result = await gitService.getRepositoryTree('main', true);

      expect(result.success).toBe(false);
    });
  });

  describe('Atomic Commit Flow', () => {
    beforeEach(() => {
      octokitMock.git.getRef.mockResolvedValue({
        data: { object: { sha: 'base-commit' } }
      });
      octokitMock.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'base-tree' } }
      });
      octokitMock.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha' }
      });
      octokitMock.git.createTree.mockResolvedValue({
        data: { sha: 'new-tree' }
      });
      octokitMock.git.createCommit.mockResolvedValue({
        data: { sha: 'new-commit' }
      });
      octokitMock.git.updateRef.mockResolvedValue({
        data: { object: { sha: 'new-commit' } }
      });
    });

    it('should use base_tree for incremental changes', async () => {
      const files = [
        { path: 'graphs/test.json', content: '{}' },
      ];

      await gitService.commitAndPushFiles(files, 'Update', 'main');

      // Verify createTree was called with base_tree
      expect(octokitMock.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          base_tree: 'base-tree'
        })
      );
    });

    it('should create proper parent reference for new commit', async () => {
      const files = [
        { path: 'graphs/test.json', content: '{}' },
      ];

      await gitService.commitAndPushFiles(files, 'Update', 'main');

      // Verify createCommit was called with parent reference
      expect(octokitMock.git.createCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          parents: ['base-commit'],
          tree: 'new-tree'
        })
      );
    });

    it('should update branch ref to new commit', async () => {
      const files = [
        { path: 'graphs/test.json', content: '{}' },
      ];

      await gitService.commitAndPushFiles(files, 'Update', 'main');

      // Verify updateRef was called
      expect(octokitMock.git.updateRef).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: 'heads/main',
          sha: 'new-commit'
        })
      );
    });
  });

  describe('API Efficiency', () => {
    it('should use minimal API calls for tree fetching', async () => {
      octokitMock.git.getRef.mockResolvedValue({
        data: { object: { sha: 'c1' } }
      });
      
      octokitMock.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 't1' } }
      });
      
      octokitMock.git.getTree.mockResolvedValue({
        data: { tree: [] }
      });

      await gitService.getRepositoryTree('main', true);

      // Should only make 3 Octokit calls regardless of repo size
      expect(octokitMock.git.getRef).toHaveBeenCalledTimes(1);
      expect(octokitMock.git.getCommit).toHaveBeenCalledTimes(1);
      expect(octokitMock.git.getTree).toHaveBeenCalledTimes(1);
    });
  });
});

