/**
 * Delete Operations Service Tests
 * 
 * Tests for smart image garbage collection when deleting node and graph files.
 * Images should only be deleted when they have zero references across all files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deleteOperationsService } from '../deleteOperationsService';
import { fileRegistry } from '../../contexts/TabContext';
import { workspaceService } from '../workspaceService';
import type { FileState } from '../../types';

// Type for IDB file queries (matches workspaceService return type)
type IDBFile = { fileId: string; data: any };

// Mock dependencies
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
    deleteFile: vi.fn(),
    registerFileDeletion: vi.fn(),
    registerImageDelete: vi.fn(),
  }
}));

vi.mock('../workspaceService', () => ({
  workspaceService: {
    getAllNodeFilesFromIDB: vi.fn(),
    getAllGraphFilesFromIDB: vi.fn(),
  }
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  }
}));

describe('DeleteOperationsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deleteNodeFile - Image GC', () => {
    it('should delete orphaned images when node file is deleted', async () => {
      // Setup: Node file with image that has no other references
      const nodeFile: Partial<FileState> = {
        fileId: 'node-test-node',
        type: 'node',
        data: {
          id: 'test-node',
          images: [
            { image_id: 'orphan-image', file_extension: 'png' }
          ]
        },
        path: 'nodes/test-node.yaml'
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(nodeFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteNodeFile('test-node');

      // Image should be staged for deletion (no other refs)
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledWith(
        'orphan-image',
        'nodes/images/orphan-image.png'
      );
      // Node file should be staged for deletion
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalledWith(
        'node-test-node',
        'nodes/test-node.yaml',
        'node'
      );
    });

    it('should keep images referenced by another node file', async () => {
      // Setup: Node file with image that is also referenced by another node
      const nodeFile: Partial<FileState> = {
        fileId: 'node-test-node',
        type: 'node',
        data: {
          id: 'test-node',
          images: [
            { image_id: 'shared-image', file_extension: 'jpg' }
          ]
        },
        path: 'nodes/test-node.yaml'
      };
      
      // Another node references the same image
      const otherNodeFile: Partial<FileState> = {
        fileId: 'node-other-node',
        type: 'node',
        data: {
          id: 'other-node',
          images: [
            { image_id: 'shared-image', file_extension: 'jpg' }
          ]
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(nodeFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([otherNodeFile as IDBFile]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteNodeFile('test-node');

      // Image should NOT be deleted (still referenced by other node)
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalled();
      // Node file should still be deleted
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalledWith(
        'node-test-node',
        'nodes/test-node.yaml',
        'node'
      );
    });

    it('should keep images referenced by a graph file', async () => {
      // Setup: Node file with image that is also referenced by a graph
      const nodeFile: Partial<FileState> = {
        fileId: 'node-test-node',
        type: 'node',
        data: {
          id: 'test-node',
          images: [
            { image_id: 'graph-shared-image', file_extension: 'png' }
          ]
        },
        path: 'nodes/test-node.yaml'
      };
      
      // A graph references the same image
      const graphFile: Partial<FileState> = {
        fileId: 'graph-test-graph',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'some-node',
              images: [
                { image_id: 'graph-shared-image', file_extension: 'png' }
              ]
            }
          ]
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(nodeFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([graphFile as IDBFile]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteNodeFile('test-node');

      // Image should NOT be deleted (still referenced by graph)
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalled();
      // Node file should still be deleted
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalled();
    });

    it('should exclude the file being deleted from reference scan', async () => {
      // Setup: Node file with image - ensure we don't count self-reference
      const nodeFile: Partial<FileState> = {
        fileId: 'node-self-ref',
        type: 'node',
        data: {
          id: 'self-ref',
          images: [
            { image_id: 'self-image', file_extension: 'png' }
          ]
        },
        path: 'nodes/self-ref.yaml'
      };
      
      // Return the same file in IDB scan (simulating it hasn't been deleted from IDB yet)
      vi.mocked(fileRegistry.getFile).mockReturnValue(nodeFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([nodeFile as IDBFile]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteNodeFile('self-ref');

      // Image SHOULD be deleted because the only "reference" is from the file being deleted
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledWith(
        'self-image',
        'nodes/images/self-image.png'
      );
    });
  });

  describe('deleteGraphFile - Image GC', () => {
    it('should delete orphaned images when graph file is deleted', async () => {
      // Setup: Graph with node that has an image with no other references
      const graphFile: Partial<FileState> = {
        fileId: 'graph-test-graph',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'graph-node',
              images: [
                { image_id: 'graph-orphan-image', file_extension: 'webp' }
              ]
            }
          ]
        },
        path: 'graphs/test-graph.json'
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('test-graph');

      // Image should be staged for deletion
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledWith(
        'graph-orphan-image',
        'nodes/images/graph-orphan-image.webp'
      );
      // Graph file should be staged for deletion
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalledWith(
        'graph-test-graph',
        'graphs/test-graph.json',
        'graph'
      );
    });

    it('should keep images referenced by a node file', async () => {
      // Setup: Graph with image also referenced by a node file
      const graphFile: Partial<FileState> = {
        fileId: 'graph-test-graph',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'graph-node',
              images: [
                { image_id: 'node-shared-image', file_extension: 'png' }
              ]
            }
          ]
        },
        path: 'graphs/test-graph.json'
      };
      
      // A node file references the same image
      const nodeFile: Partial<FileState> = {
        fileId: 'node-keeper',
        type: 'node',
        data: {
          id: 'keeper',
          images: [
            { image_id: 'node-shared-image', file_extension: 'png' }
          ]
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([nodeFile as IDBFile]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('test-graph');

      // Image should NOT be deleted (still referenced by node file)
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalled();
      // Graph file should still be deleted
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalled();
    });

    it('should keep images referenced by another graph', async () => {
      // Setup: Graph with image also referenced by another graph
      const graphFile: Partial<FileState> = {
        fileId: 'graph-deleting',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'node-a',
              images: [
                { image_id: 'multi-graph-image', file_extension: 'jpg' }
              ]
            }
          ]
        },
        path: 'graphs/deleting.json'
      };
      
      // Another graph references the same image
      const otherGraph: Partial<FileState> = {
        fileId: 'graph-keeping',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'node-b',
              images: [
                { image_id: 'multi-graph-image', file_extension: 'jpg' }
              ]
            }
          ]
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([otherGraph as IDBFile]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('deleting');

      // Image should NOT be deleted (still referenced by other graph)
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalled();
    });

    it('should exclude the graph being deleted from reference scan', async () => {
      // Setup: Graph with image - ensure we don't count self-reference
      const graphFile: Partial<FileState> = {
        fileId: 'graph-self-ref',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'node-in-graph',
              images: [
                { image_id: 'graph-self-image', file_extension: 'gif' }
              ]
            }
          ]
        },
        path: 'graphs/self-ref.json'
      };
      
      // Return the same graph in IDB scan
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([graphFile as IDBFile]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('self-ref');

      // Image SHOULD be deleted because the only "reference" is from the graph being deleted
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledWith(
        'graph-self-image',
        'nodes/images/graph-self-image.gif'
      );
    });

    it('should handle multiple images - delete orphans, keep referenced', async () => {
      // Setup: Graph with multiple images, some orphaned, some referenced
      const graphFile: Partial<FileState> = {
        fileId: 'graph-multi-image',
        type: 'graph',
        data: {
          nodes: [
            {
              id: 'node-1',
              images: [
                { image_id: 'orphan-1', file_extension: 'png' },
                { image_id: 'shared-1', file_extension: 'jpg' }
              ]
            },
            {
              id: 'node-2',
              images: [
                { image_id: 'orphan-2', file_extension: 'webp' }
              ]
            }
          ]
        },
        path: 'graphs/multi-image.json'
      };
      
      // A node file references one of the images
      const nodeFile: Partial<FileState> = {
        fileId: 'node-ref',
        type: 'node',
        data: {
          id: 'ref',
          images: [
            { image_id: 'shared-1', file_extension: 'jpg' }
          ]
        }
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([nodeFile as IDBFile]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('multi-image');

      // Only orphaned images should be deleted
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledTimes(2);
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledWith(
        'orphan-1',
        'nodes/images/orphan-1.png'
      );
      expect(fileRegistry.registerImageDelete).toHaveBeenCalledWith(
        'orphan-2',
        'nodes/images/orphan-2.webp'
      );
      // shared-1 should NOT be deleted
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalledWith(
        'shared-1',
        expect.any(String)
      );
    });

    it('should handle graph with no images', async () => {
      const graphFile: Partial<FileState> = {
        fileId: 'graph-no-images',
        type: 'graph',
        data: {
          nodes: [
            { id: 'simple-node', label: 'No images here' }
          ]
        },
        path: 'graphs/no-images.json'
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('no-images');

      // No images to delete
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalled();
      // Graph should still be deleted
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalledWith(
        'graph-no-images',
        'graphs/no-images.json',
        'graph'
      );
    });

    it('should handle graph with nodes but no images array', async () => {
      const graphFile: Partial<FileState> = {
        fileId: 'graph-no-images-array',
        type: 'graph',
        data: {
          nodes: [
            { id: 'node-without-images' }
            // No images property at all
          ]
        },
        path: 'graphs/no-images-array.json'
      };
      
      vi.mocked(fileRegistry.getFile).mockReturnValue(graphFile as FileState);
      vi.mocked(fileRegistry.deleteFile).mockResolvedValue(undefined);

      await deleteOperationsService.deleteGraphFile('no-images-array');

      // Should not crash, no images to delete
      expect(fileRegistry.registerImageDelete).not.toHaveBeenCalled();
      expect(fileRegistry.registerFileDeletion).toHaveBeenCalled();
    });
  });

  describe('scanAllFilesForImageReferencesExcluding', () => {
    it('should find references in node files', async () => {
      const nodeFile: Partial<FileState> = {
        fileId: 'node-referencer',
        data: {
          images: [
            { image_id: 'target-image' }
          ]
        }
      };
      
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([nodeFile as IDBFile]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);

      const result = await deleteOperationsService.scanAllFilesForImageReferencesExcluding(
        ['target-image', 'other-image'],
        'node-different'
      );

      expect(result.has('target-image')).toBe(true);
      expect(result.has('other-image')).toBe(false);
    });

    it('should find references in graph files', async () => {
      const graphFile: Partial<FileState> = {
        fileId: 'graph-referencer',
        data: {
          nodes: [
            {
              images: [{ image_id: 'target-image' }]
            }
          ]
        }
      };
      
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([graphFile as IDBFile]);

      const result = await deleteOperationsService.scanAllFilesForImageReferencesExcluding(
        ['target-image'],
        'graph-different'
      );

      expect(result.has('target-image')).toBe(true);
    });

    it('should exclude specified file from scan', async () => {
      const excludedFile: Partial<FileState> = {
        fileId: 'node-excluded',
        data: {
          images: [{ image_id: 'my-image' }]
        }
      };
      
      vi.mocked(workspaceService.getAllNodeFilesFromIDB).mockResolvedValue([excludedFile as IDBFile]);
      vi.mocked(workspaceService.getAllGraphFilesFromIDB).mockResolvedValue([]);

      const result = await deleteOperationsService.scanAllFilesForImageReferencesExcluding(
        ['my-image'],
        'node-excluded' // Same file ID - should be excluded
      );

      // Should NOT find the image because the only file that has it is excluded
      expect(result.has('my-image')).toBe(false);
    });
  });
});

