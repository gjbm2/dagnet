/**
 * Image Operations Service
 * 
 * Centralized service for all image operations (upload, delete, edit caption)
 * to avoid code duplication between PropertiesPanel and ConversionNode.
 */

import { fileRegistry } from '../contexts/TabContext';
import { workspaceService } from './workspaceService';
import toast from 'react-hot-toast';

export interface ImageOperationCallbacks {
  onGraphUpdate: (updatedGraph: any) => void;
  onHistorySave: (action: string, nodeId: string) => void;
  getNodeId: () => string | undefined; // Returns node UUID or ID
}

class ImageOperationsService {
  /**
   * Upload a new image for a node
   */
  async uploadImage(
    graph: any,
    imageData: Uint8Array,
    extension: string,
    source: string,
    callbacks: ImageOperationCallbacks,
    caption?: string
  ): Promise<void> {
    const nodeId = callbacks.getNodeId();
    if (!graph || !nodeId) return;

    try {
      const node = graph.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!node) return;

      // Generate unique image_id
      const existingImageIds = await workspaceService.getAllImageIdsFromIDB();
      const baseId = node.id ? `${node.id}-img` : `node-img-${Date.now()}`;
      let imageId = baseId;
      let counter = 1;
      while (existingImageIds.includes(imageId)) {
        imageId = `${baseId}-${counter}`;
        counter++;
      }

      // Get next caption number
      const imageCount = (node.images?.length || 0) + 1;
      const finalCaption = caption?.trim() || `Image ${imageCount}`;

      // Get current workspace info for proper storage
      const { db } = await import('../db/appDatabase');
      const appState = await db.appState.get('app-state');
      const repository = appState?.navigatorState?.selectedRepo || '';
      const branch = appState?.navigatorState?.selectedBranch || 'main';

      // Store image in IDB FIRST, before updating graph
      const baseFileId = `image-${imageId}`;
      const idbFileId = repository && branch ? `${repository}-${branch}-${baseFileId}` : baseFileId;

      const imageFileState: any = {
        fileId: baseFileId,
        path: `nodes/images/${imageId}.${extension}`,
        type: 'image' as any,
        data: {
          image_id: imageId,
          file_extension: extension,
          binaryData: imageData
        },
        originalData: null,
        isDirty: true,
        lastModified: Date.now(),
        source: {
          repository,
          branch,
          path: `nodes/images/${imageId}.${extension}`
        },
        viewTabs: [],
        isInitializing: false
      };

      // Store in IDB with prefixed fileId
      await db.files.put({ ...imageFileState, fileId: idbFileId });

      // Also store in FileRegistry memory with unprefixed fileId
      (fileRegistry as any).files.set(baseFileId, imageFileState);

      // Update graph with new image AFTER storage completes
      const next = structuredClone(graph);
      const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (nodeIndex >= 0) {
        if (!next.nodes[nodeIndex].images) {
          next.nodes[nodeIndex].images = [];
        }
        next.nodes[nodeIndex].images.push({
          image_id: imageId,
          caption: finalCaption,
          file_extension: extension as 'png' | 'jpg' | 'jpeg',
          caption_overridden: false
        });
        next.nodes[nodeIndex].images_overridden = true;
        if (next.metadata) {
          next.metadata.updated_at = new Date().toISOString();
        }

        callbacks.onGraphUpdate(next);
        // NOTE: History not saved for image operations to prevent desync with IDB/pending ops
        // TODO: Implement proper undo/redo support (see TODO.md § Image Undo/Redo Broken)

        // Register image for Git commit
        fileRegistry.registerImageUpload(imageId, `nodes/images/${imageId}.${extension}`, imageData);

        toast.success(`Image uploaded: ${imageId}`);
      }
    } catch (error) {
      console.error('Failed to upload image:', error);
      toast.error('Failed to upload image');
    }
  }

  /**
   * Delete an image from a node
   */
  deleteImage(
    graph: any,
    imageId: string,
    callbacks: ImageOperationCallbacks
  ): void {
    const nodeId = callbacks.getNodeId();
    if (!graph || !nodeId) return;

    const next = structuredClone(graph);
    const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
    if (nodeIndex >= 0) {
      const node = next.nodes[nodeIndex];
      if (!node.images) return;

      const imageToDelete = node.images.find((img: any) => img.image_id === imageId);
      if (!imageToDelete) return;

      node.images = node.images.filter((img: any) => img.image_id !== imageId);
      if (node.images.length === 0) {
        delete node.images_overridden;
      }

      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }

      callbacks.onGraphUpdate(next);
      // NOTE: History not saved for image operations to prevent desync with IDB/pending ops

      // Register image for deletion from Git
      fileRegistry.registerImageDelete(imageId, `nodes/images/${imageId}.${imageToDelete.file_extension}`);

      toast.success('Image deleted');
    }
  }

  /**
   * Edit an image caption
   */
  editCaption(
    graph: any,
    imageId: string,
    newCaption: string,
    callbacks: ImageOperationCallbacks
  ): void {
    const nodeId = callbacks.getNodeId();
    if (!graph || !nodeId) return;

    const next = structuredClone(graph);
    const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
    if (nodeIndex >= 0) {
      const node = next.nodes[nodeIndex];
      if (!node.images) return;

      const imageIndex = node.images.findIndex((img: any) => img.image_id === imageId);
      if (imageIndex >= 0) {
        // Create new images array with updated caption to ensure React detects the change
        node.images = [...node.images];
        node.images[imageIndex] = {
          ...node.images[imageIndex],
          caption: newCaption,
          caption_overridden: true
        };

        if (next.metadata) {
          next.metadata.updated_at = new Date().toISOString();
        }

        callbacks.onGraphUpdate(next);
        // NOTE: History not saved for image operations to prevent desync with IDB/pending ops

        toast.success('Caption updated');
      }
    }
  }
}

export const imageOperationsService = new ImageOperationsService();

