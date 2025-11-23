/**
 * Deletion Operations Service
 * 
 * Centralized service for handling file and node deletions with smart image garbage collection.
 * Ensures images are only deleted when they have zero references across all node and graph files.
 */

import { fileRegistry } from '../contexts/TabContext';
import { workspaceService } from './workspaceService';
import toast from 'react-hot-toast';

class DeleteOperationsService {
  
  /**
   * Scan all node and graph files from IDB for image references
   * Returns set of image_ids that are referenced by any file
   * 
   * This is the core GC utility used by both graph-node deletion and node-file deletion
   */
  async scanAllFilesForImageReferences(imageIds: string[]): Promise<Set<string>> {
    const referenced = new Set<string>();
    
    // 1) Scan ALL node files from IDB (not just loaded ones)
    const allNodeFiles = await workspaceService.getAllNodeFilesFromIDB();
    for (const nodeFile of allNodeFiles) {
      if (!nodeFile.data?.images) continue;
      for (const img of nodeFile.data.images) {
        if (imageIds.includes(img.image_id)) {
          referenced.add(img.image_id);
        }
      }
    }
    
    // 2) Scan ALL graph files from IDB (not just loaded ones)
    const allGraphFiles = await workspaceService.getAllGraphFilesFromIDB();
    for (const graphFile of allGraphFiles) {
      if (!graphFile.data?.nodes) continue;
      for (const node of graphFile.data.nodes) {
        if (!node.images) continue;
        for (const img of node.images) {
          if (imageIds.includes(img.image_id)) {
            referenced.add(img.image_id);
          }
        }
      }
    }
    
    console.log('[DeleteOperationsService] Image reference scan:', {
      imageIdsToCheck: imageIds,
      referencedCount: referenced.size,
      orphanedCount: imageIds.length - referenced.size
    });
    
    return referenced;
  }
  
  /**
   * Delete a node file from the registry
   * 
   * - Stages the file deletion
   * - Scans all files for image references
   * - Only stages orphaned images for deletion
   * - Nothing is committed to Git until user explicitly commits
   */
  async deleteNodeFile(nodeId: string): Promise<void> {
    try {
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Node file not found: ${nodeId}`);
        return;
      }
      
      // Get image IDs from this node file
      const imageIds = nodeFile.data?.images?.map((img: any) => img.image_id) || [];
      let imagesToDelete: string[] = [];
      
      if (imageIds.length > 0) {
        console.log(`[DeleteOperationsService] Node file has ${imageIds.length} images, checking references...`);
        
        // Check if ANY files (node or graph) still reference these images
        const referencedImages = await this.scanAllFilesForImageReferences(imageIds);
        
        // Determine which images to delete (no refs anywhere)
        imagesToDelete = imageIds.filter((id: string) => !referencedImages.has(id));
        
        if (imagesToDelete.length > 0) {
          // Stage images for deletion (don't delete immediately)
          for (const imageId of imagesToDelete) {
            const img = nodeFile.data.images.find((i: any) => i.image_id === imageId);
            if (img) {
              fileRegistry.registerImageDelete(imageId, `nodes/images/${imageId}.${img.file_extension}`);
            }
          }
          
          console.log(`[DeleteOperationsService] Staged ${imagesToDelete.length} orphaned images for deletion`);
        }
        
        if (imagesToDelete.length < imageIds.length) {
          console.log(`[DeleteOperationsService] Keeping ${imageIds.length - imagesToDelete.length} images (still referenced)`);
        }
      }
      
      // Stage node file deletion (don't delete immediately)
      const filePath = nodeFile.path || `nodes/${nodeId}.yaml`;
      fileRegistry.registerFileDeletion(`node-${nodeId}`, filePath, 'node');
      
      // Remove from local FileRegistry immediately (but Git file remains until commit)
      await fileRegistry.deleteFile(`node-${nodeId}`);
      
      toast.success(`Node file deletion staged: ${nodeId} (commit to sync to Git)`);
      
      console.log('[DeleteOperationsService] Staged node file deletion:', {
        nodeId,
        imagesStaged: imagesToDelete.length,
        imagesKept: imageIds.length - imagesToDelete.length
      });
    } catch (error) {
      console.error('Failed to delete node file:', error);
      toast.error('Failed to delete node file');
      throw error;
    }
  }
}

export const deleteOperationsService = new DeleteOperationsService();

