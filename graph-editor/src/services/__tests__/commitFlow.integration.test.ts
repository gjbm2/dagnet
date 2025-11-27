/**
 * Commit Flow Integration Tests
 * 
 * These tests verify the FULL commit flow without mocking internal services.
 * They catch integration bugs that unit tests miss.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import { repositoryOperationsService } from '../repositoryOperationsService';
import { db } from '../../db/appDatabase';

// Mock only external dependencies (GitHub API)
vi.mock('../gitService', () => ({
  gitService: {
    setCredentials: vi.fn(),
    getRemoteHeadSha: vi.fn().mockResolvedValue('abc123'),
    commitAndPushFiles: vi.fn().mockResolvedValue({ success: true, data: [] }),
  }
}));

vi.mock('../credentialsManager', () => ({
  credentialsManager: {
    loadCredentials: vi.fn().mockResolvedValue({
      success: true,
      credentials: {
        git: [{ name: 'test-repo', token: 'test-token', basePath: '' }]
      }
    })
  }
}));

describe('Commit Flow Integration Tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear FileRegistry state
    (fileRegistry as any).files.clear();
    (fileRegistry as any).pendingImageOps = [];
    (fileRegistry as any).pendingFileDeletions = [];
  });

  describe('File immutability during commit', () => {
    it('should NOT mutate original file data during commit', async () => {
      // Setup: Create a connections file with specific content
      const originalData = {
        connections: [
          { id: 'conn-1', name: 'Test Connection' }
        ]
      };
      
      const file = await fileRegistry.getOrCreateFile(
        'connections-test',
        'connections',
        { repository: 'test-repo', branch: 'main', path: 'connections/test.yaml' },
        structuredClone(originalData)
      );
      
      // Capture the data BEFORE commit
      const dataBeforeCommit = JSON.stringify(file.data);
      
      // Perform commit
      const showTripleChoice = vi.fn().mockResolvedValue('secondary');
      try {
        await repositoryOperationsService.commitFiles(
          [{ fileId: 'connections-test', path: 'connections/test.yaml', content: '' }],
          'Test commit',
          'main',
          'test-repo',
          showTripleChoice
        );
      } catch (e) {
        // Ignore errors - we're testing mutation
      }
      
      // Verify: Data should be UNCHANGED
      const dataAfterCommit = JSON.stringify(file.data);
      expect(dataAfterCommit).toBe(dataBeforeCommit);
    });

    it('should NOT add metadata to files that do not have it', async () => {
      const originalData = {
        connections: [{ id: 'conn-1' }]
        // Note: NO metadata field
      };
      
      const file = await fileRegistry.getOrCreateFile(
        'connections-no-meta',
        'connections',
        { repository: 'test-repo', branch: 'main', path: 'connections/test.yaml' },
        structuredClone(originalData)
      );
      
      expect(file.data.metadata).toBeUndefined();
      
      const showTripleChoice = vi.fn().mockResolvedValue('secondary');
      try {
        await repositoryOperationsService.commitFiles(
          [{ fileId: 'connections-no-meta', path: 'connections/test.yaml', content: '' }],
          'Test commit',
          'main',
          'test-repo',
          showTripleChoice
        );
      } catch (e) {}
      
      // Verify: Still no metadata added
      expect(file.data.metadata).toBeUndefined();
    });
  });

  describe('Image handling', () => {
    it('should NOT include image files in committable files list', async () => {
      // Setup: Create an image file in IDB
      const imageFile = {
        fileId: 'image-test-img',
        type: 'image' as const,
        path: 'nodes/images/test-img.jpg',
        data: { image_id: 'test-img', binaryData: new Uint8Array([1, 2, 3]) },
        originalData: null,
        isDirty: true,
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'nodes/images/test-img.jpg' },
        viewTabs: [],
        isInitializing: false
      };
      
      await db.files.put(imageFile);
      
      // Get committable files
      const committableFiles = await repositoryOperationsService.getCommittableFiles('test-repo', 'main');
      
      // Verify: Image files should be excluded
      const imageFiles = committableFiles.filter(f => f.type === 'image');
      expect(imageFiles).toHaveLength(0);
      
      // Cleanup
      await db.files.delete('image-test-img');
    });

    it('should handle large binary data without stack overflow', async () => {
      // Create a realistic-sized image (500KB)
      const largeImageData = new Uint8Array(500 * 1024);
      for (let i = 0; i < largeImageData.length; i++) {
        largeImageData[i] = i % 256;
      }
      
      // Register image upload
      fileRegistry.registerImageUpload('large-test-img', 'nodes/images/large-test-img.jpg', largeImageData);
      
      // Get pending images
      const pendingImages = await fileRegistry.commitPendingImages();
      
      // Verify: Should have the image with correct binary data
      expect(pendingImages).toHaveLength(1);
      expect(pendingImages[0].binaryContent).toBeInstanceOf(Uint8Array);
      expect(pendingImages[0].binaryContent?.length).toBe(500 * 1024);
    });
  });

  describe('Delete handling', () => {
    it('should remove image from IDB when deleted', async () => {
      // Setup: Create an image in IDB
      const imageFileId = 'image-to-delete';
      const imageFile = {
        fileId: imageFileId,
        type: 'image' as const,
        path: 'nodes/images/to-delete.jpg',
        data: { image_id: 'to-delete', binaryData: new Uint8Array([1, 2, 3]) },
        originalData: null,
        isDirty: false,
        lastModified: Date.now(),
        source: { repository: 'test-repo', branch: 'main', path: 'nodes/images/to-delete.jpg' },
        viewTabs: [],
        isInitializing: false
      };
      
      await db.files.put(imageFile);
      (fileRegistry as any).files.set(imageFileId, imageFile);
      
      // Verify it exists
      expect(await db.files.get(imageFileId)).toBeDefined();
      
      // Delete the image
      await fileRegistry.registerImageDelete('to-delete', 'nodes/images/to-delete.jpg');
      
      // Verify: Image should be removed from IDB
      expect(await db.files.get(imageFileId)).toBeUndefined();
      
      // Verify: Should be in pending deletions for Git
      const pendingImages = await fileRegistry.commitPendingImages();
      const deleteOp = pendingImages.find(op => op.delete && op.path.includes('to-delete'));
      expect(deleteOp).toBeDefined();
    });
  });

  describe('Round-trip consistency', () => {
    it('file should not be dirty after successful commit + markSaved', async () => {
      const originalData = {
        nodes: [{ id: 'node-1', label: 'Test' }],
        edges: [],
        metadata: { created_at: '2024-01-01', version: '1.0.0' }
      };
      
      await fileRegistry.getOrCreateFile(
        'graph-roundtrip',
        'graph',
        { repository: 'test-repo', branch: 'main', path: 'graphs/test.json' },
        structuredClone(originalData)
      );
      
      // Get the file and make a change
      const file = fileRegistry.getFile('graph-roundtrip');
      expect(file).toBeDefined();
      expect(file?.data?.nodes).toBeDefined();
      
      // Make a change via updateFile (the proper way)
      const modifiedData = structuredClone(file!.data);
      modifiedData.nodes[0].label = 'Modified';
      await fileRegistry.updateFile('graph-roundtrip', modifiedData);
      
      // Should be dirty
      expect(fileRegistry.getFile('graph-roundtrip')?.isDirty).toBe(true);
      
      // Mark as saved (simulating successful commit)
      await fileRegistry.markSaved('graph-roundtrip');
      
      // Should NOT be dirty
      expect(fileRegistry.getFile('graph-roundtrip')?.isDirty).toBe(false);
      
      // originalData should now match current data
      const savedFile = fileRegistry.getFile('graph-roundtrip');
      expect(JSON.stringify(savedFile?.data)).toBe(JSON.stringify(savedFile?.originalData));
    });
  });
});

