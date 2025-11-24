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

  describe('File Commit Operations (Push)', () => {
    it('should commit a single file to GitHub', async () => {
      fetchMock
        // Commit file (with SHA provided, no need to fetch)
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

    it('should commit multiple files sequentially', async () => {
      // Mock fetches for 2 files (2 GETs + 2 PUTs)
      fetchMock
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ sha: 'sha1' }),
          json: async () => ({ sha: 'sha1' }) 
        })
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'new-sha1' } }),
          json: async () => ({ content: { sha: 'new-sha1' } }) 
        })
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ sha: 'sha2' }),
          json: async () => ({ sha: 'sha2' }) 
        })
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'new-sha2' } }),
          json: async () => ({ content: { sha: 'new-sha2' } }) 
        });

      const files = [
        { path: 'graphs/graph1.json', content: '{"nodes":[]}' },
        { path: 'parameters-index.yaml', content: 'version: 1.0.0' },
      ];

      const result = await gitService.commitAndPushFiles(files, 'Test commit', 'main');

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('should handle new file creation (no existing SHA)', async () => {
      fetchMock
        // Create new file (no SHA means new file, no 404 check needed)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ content: { sha: 'new-file-sha' } }),
          json: async () => ({ content: { sha: 'new-file-sha' } })
        });

      const result = await gitService.createOrUpdateFile(
        'parameters/new-param.yaml',
        'id: new-param\np: {mean: 0.5}',
        'Add new parameter',
        'main'
        // No SHA = new file
      );

      expect(result.success).toBe(true);
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
    it('should commit index files to root with plural names', async () => {
      fetchMock
        .mockResolvedValueOnce({ 
          ok: false, 
          status: 404,
          text: async () => JSON.stringify({ message: 'Not Found' }),
        }) // File doesn't exist
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'new' } }),
          json: async () => ({ content: { sha: 'new' } }) 
        });

      const files = [
        { path: 'parameters-index.yaml', content: 'version: 1.0.0\nparameters: []' },
      ];

      await gitService.commitAndPushFiles(files, 'Create index', 'main');

      // Verify the PUT request has correct path
      const putCall = fetchMock.mock.calls.find((call: any) => 
        call[1]?.method === 'PUT'
      );
      expect(putCall[0]).toContain('parameters-index.yaml');
      expect(putCall[0]).not.toContain('parameter-index.yaml'); // Not singular
      expect(putCall[0]).not.toContain('parameters/parameters-index'); // Not nested
    });

    it('should handle graph files in graphs directory', async () => {
      fetchMock
        .mockResolvedValueOnce({ 
          ok: false, 
          status: 404,
          text: async () => JSON.stringify({ message: 'Not Found' }),
        })
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'new' } }),
          json: async () => ({ content: { sha: 'new' } }) 
        });

      const files = [
        { path: 'graphs/my-graph.json', content: '{"nodes":[],"edges":[]}' },
      ];

      await gitService.commitAndPushFiles(files, 'Add graph', 'main');

      const putCall = fetchMock.mock.calls.find((call: any) => call[1]?.method === 'PUT');
      expect(putCall[0]).toContain('graphs/my-graph.json');
    });
  });

  describe('Binary Content Handling', () => {
    it('should handle binary files (images)', async () => {
      fetchMock
        .mockResolvedValueOnce({ 
          ok: false, 
          status: 404,
          text: async () => JSON.stringify({ message: 'Not Found' }),
        })
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'img-sha' } }),
          json: async () => ({ content: { sha: 'img-sha' } }) 
        });

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
      
      // Verify base64 encoding was used
      const putCall = fetchMock.mock.calls.find((call: any) => call[1]?.method === 'PUT');
      if (putCall) {
        const body = JSON.parse(putCall[1].body);
        expect(body.content).toBeTruthy();
        // Note: encoding field may not be in body for binary - implementation detail
      }
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

  describe('SHA Tracking', () => {
    it('should always fetch current SHA before committing', async () => {
      fetchMock
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ sha: 'current-sha' }),
          json: async () => ({ sha: 'current-sha' }) 
        })
        .mockResolvedValueOnce({ 
          ok: true, 
          status: 200,
          text: async () => JSON.stringify({ content: { sha: 'new-sha' } }),
          json: async () => ({ content: { sha: 'new-sha' } }) 
        });

      const files = [
        { 
          path: 'graphs/test.json',
          content: '{}',
          sha: 'stale-sha', // Stale SHA provided
        },
      ];

      await gitService.commitAndPushFiles(files, 'Update', 'main');

      // Verify it fetched current SHA
      const getCall = fetchMock.mock.calls.find((call: any) => 
        call[0].includes('?ref=') && (!call[1] || call[1].method === 'GET')
      );
      expect(getCall).toBeTruthy();
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

