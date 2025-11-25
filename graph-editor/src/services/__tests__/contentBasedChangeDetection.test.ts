/**
 * Content-Based Change Detection Tests
 * 
 * Tests that repositoryOperationsService.getCommittableFiles() 
 * correctly detects changed files by comparing local content SHA
 * to stored remote SHA, not just relying on isDirty flag.
 * 
 * This is critical for cross-session change detection (after F5 refresh)
 * and for detecting ALL local changes vs remote state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { repositoryOperationsService } from '../repositoryOperationsService';

// Mock IndexedDB with more sophisticated mock
const mockFiles: any[] = [];

vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      toArray: vi.fn(() => Promise.resolve(mockFiles)),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          and: vi.fn(() => ({
            toArray: vi.fn(() => Promise.resolve(mockFiles))
          }))
        }))
      })),
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    getDirtyFiles: vi.fn(async () => mockFiles.filter(f => f.isDirty)),
  },
}));

// Helper to compute git blob SHA (same as in service)
async function computeGitBlobSha(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content);
  const header = `blob ${contentBytes.length}\0`;
  const headerBytes = encoder.encode(header);
  
  const combined = new Uint8Array(headerBytes.length + contentBytes.length);
  combined.set(headerBytes, 0);
  combined.set(contentBytes, headerBytes.length);
  
  const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('SHA-Based Change Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.length = 0; // Clear mock files
  });

  describe('getFilesWithChanges() - originalData comparison', () => {
    it('should detect files where data differs from originalData', async () => {
      mockFiles.push({
        fileId: 'parameter-test',
        type: 'parameter',
        data: { id: 'test', p: { mean: 0.7 } },           // Changed!
        originalData: { id: 'test', p: { mean: 0.5 } },   // Original
        isDirty: false,  // isDirty might be false after page refresh
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const changedFiles = await repositoryOperationsService.getFilesWithChanges();
      
      expect(changedFiles).toHaveLength(1);
      expect(changedFiles[0].fileId).toBe('parameter-test');
    });

    it('should NOT include files where data equals originalData', async () => {
      mockFiles.push({
        fileId: 'parameter-unchanged',
        type: 'parameter',
        data: { id: 'test', p: { mean: 0.5 } },
        originalData: { id: 'test', p: { mean: 0.5 } },  // Same!
        isDirty: false,
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const changedFiles = await repositoryOperationsService.getFilesWithChanges();
      
      expect(changedFiles).toHaveLength(0);
    });

    it('should detect local-only files (no originalData)', async () => {
      mockFiles.push({
        fileId: 'parameter-new',
        type: 'parameter',
        data: { id: 'new', p: { mean: 0.5 } },
        originalData: null,  // No original - brand new file
        isLocal: true,
        isDirty: true,
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const changedFiles = await repositoryOperationsService.getFilesWithChanges();
      
      expect(changedFiles).toHaveLength(1);
      expect(changedFiles[0].fileId).toBe('parameter-new');
    });
  });

  describe('getCommittableFiles() - SHA-based remote comparison', () => {
    it('should detect local-only files (no SHA)', async () => {
      mockFiles.push({
        fileId: 'parameter-new',
        type: 'parameter',
        data: { id: 'new', p: { mean: 0.5 } },
        // No sha = never pushed to remote
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(1);
      expect(committableFiles[0].fileId).toBe('parameter-new');
    });

    it('should detect files where local content differs from stored SHA', async () => {
      // Compute SHA for the "original" remote content
      const YAML = await import('yaml');
      const originalContent = YAML.stringify({ id: 'test', value: 'original' });
      const remoteSha = await computeGitBlobSha(originalContent);
      
      mockFiles.push({
        fileId: 'parameter-changed',
        type: 'parameter',
        data: { id: 'test', value: 'modified' },  // Different from remote!
        sha: remoteSha,  // SHA of original content
        isDirty: false,  // Even if isDirty is false
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(1);
      expect(committableFiles[0].fileId).toBe('parameter-changed');
    });

    it('should NOT include files where local content matches stored SHA', async () => {
      // Compute SHA for the content
      const YAML = await import('yaml');
      const content = YAML.stringify({ id: 'unchanged', value: 'same' });
      const sha = await computeGitBlobSha(content);
      
      mockFiles.push({
        fileId: 'parameter-unchanged',
        type: 'parameter',
        data: { id: 'unchanged', value: 'same' },
        sha: sha,  // SHA matches current content
        isDirty: false,
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(0);
    });

    it('should exclude credentials files', async () => {
      mockFiles.push({
        fileId: 'credentials-credentials',
        type: 'credentials',
        data: { git: [{ name: 'test' }] },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(0);
    });

    it('should exclude settings files', async () => {
      mockFiles.push({
        fileId: 'settings-settings',
        type: 'settings',
        data: { theme: 'dark' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(0);
    });

    it('should exclude temporary repository files', async () => {
      mockFiles.push({
        fileId: 'graph-temp',
        type: 'graph',
        data: { nodes: [] },
        source: { repository: 'temporary', branch: 'main' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(0);
    });
  });

  describe('Cross-session persistence (comparing vs remote)', () => {
    it('should detect changes even when originalData was updated by pull', async () => {
      // This is the key scenario: user edited file, then pulled
      // Pull updated originalData, so data === originalData
      // But BOTH differ from what was originally on remote (stored in SHA)
      
      const YAML = await import('yaml');
      const originalRemoteContent = YAML.stringify({ id: 'test', value: 'v1' });
      const remoteSha = await computeGitBlobSha(originalRemoteContent);
      
      mockFiles.push({
        fileId: 'parameter-post-pull',
        type: 'parameter',
        data: { id: 'test', value: 'v3-local-edit' },        // User's edit
        originalData: { id: 'test', value: 'v3-local-edit' }, // Same as data (after pull normalized)
        sha: remoteSha,  // SHA from when we originally cloned (v1)
        isDirty: false,
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      // SHA comparison should find it even though data === originalData!
      expect(committableFiles).toHaveLength(1);
      expect(committableFiles[0].fileId).toBe('parameter-post-pull');
    });

    it('should detect graph files with different content than remote', async () => {
      const originalContent = JSON.stringify({ nodes: [], edges: [] }, null, 2);
      const remoteSha = await computeGitBlobSha(originalContent);
      
      mockFiles.push({
        fileId: 'graph-edited',
        type: 'graph',
        data: { nodes: [{ id: 'new-node' }], edges: [] },  // Added a node!
        sha: remoteSha,
        isDirty: false,
        source: { repository: 'test-repo', branch: 'main' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles();
      
      expect(committableFiles).toHaveLength(1);
    });

    it('should handle workspace-prefixed files from IDB', async () => {
      mockFiles.push({
        fileId: 'test-repo-main-graph-test',  // Prefixed!
        type: 'graph',
        data: { nodes: [{ id: 'a' }], edges: [] },
        // No SHA = new file
        source: { repository: 'test-repo', branch: 'main', path: 'graphs/test.json' },
        viewTabs: [],
      });

      const committableFiles = await repositoryOperationsService.getCommittableFiles('test-repo', 'main');
      
      expect(committableFiles).toHaveLength(1);
    });
  });
});

