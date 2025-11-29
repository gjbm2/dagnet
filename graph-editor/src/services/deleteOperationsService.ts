/**
 * Deletion Operations Service
 * 
 * Centralized service for handling file and node deletions with smart image garbage collection.
 * Ensures images are only deleted when they have zero references across all node and graph files.
 */

import { fileRegistry } from '../contexts/TabContext';
import { workspaceService } from './workspaceService';
import { sessionLogService } from './sessionLogService';
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
    sessionLogService.info('file', 'NODE_FILE_DELETE', 
      `Attempting to delete node file: ${nodeId}`, undefined, { fileId: `node-${nodeId}` });
    
    try {
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Node file not found: ${nodeId}`);
        sessionLogService.warning('file', 'NODE_FILE_DELETE_NOT_FOUND', 
          `Node file not found: ${nodeId}`, undefined, { fileId: `node-${nodeId}` });
        return;
      }
      
      // Get image IDs from this node file
      const imageIds = nodeFile.data?.images?.map((img: any) => img.image_id) || [];
      let imagesToDelete: string[] = [];
      
      if (imageIds.length > 0) {
        console.log(`[DeleteOperationsService] Node file has ${imageIds.length} images, checking references...`);
        
        // Check if ANY OTHER files (node or graph) still reference these images
        // Exclude this node file from the scan since it's being deleted
        const referencedImages = await this.scanAllFilesForImageReferencesExcluding(imageIds, `node-${nodeId}`);
        
        // Determine which images to delete (no refs anywhere else)
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
      
      sessionLogService.success('file', 'NODE_FILE_DELETE_SUCCESS', 
        `Node file deletion staged: ${nodeId}`,
        `Images staged for deletion: ${imagesToDelete.length}, Images kept: ${imageIds.length - imagesToDelete.length}`,
        { fileId: `node-${nodeId}`, filesAffected: imagesToDelete });
    } catch (error) {
      console.error('Failed to delete node file:', error);
      toast.error('Failed to delete node file');
      
      sessionLogService.error('file', 'NODE_FILE_DELETE_FAILURE', 
        `Failed to delete node file: ${nodeId}`,
        error instanceof Error ? error.message : String(error),
        { fileId: `node-${nodeId}` });
      throw error;
    }
  }
  
  /**
   * Delete a graph file from the registry
   * 
   * - Stages the file deletion
   * - Extracts all image_ids from graph nodes
   * - Scans all files for image references
   * - Only stages orphaned images for deletion
   * - Nothing is committed to Git until user explicitly commits
   */
  async deleteGraphFile(graphId: string): Promise<void> {
    sessionLogService.info('file', 'GRAPH_FILE_DELETE', 
      `Attempting to delete graph file: ${graphId}`, undefined, { fileId: `graph-${graphId}` });
    
    try {
      const graphFile = fileRegistry.getFile(`graph-${graphId}`);
      if (!graphFile) {
        toast.error(`Graph file not found: ${graphId}`);
        sessionLogService.warning('file', 'GRAPH_FILE_DELETE_NOT_FOUND', 
          `Graph file not found: ${graphId}`, undefined, { fileId: `graph-${graphId}` });
        return;
      }
      
      // Extract all image IDs from all nodes in this graph
      const imageIds: string[] = [];
      const imageExtensions: Record<string, string> = {};
      
      if (graphFile.data?.nodes) {
        for (const node of graphFile.data.nodes) {
          if (node.images) {
            for (const img of node.images) {
              if (img.image_id && !imageIds.includes(img.image_id)) {
                imageIds.push(img.image_id);
                imageExtensions[img.image_id] = img.file_extension || 'png';
              }
            }
          }
        }
      }
      
      let imagesToDelete: string[] = [];
      
      if (imageIds.length > 0) {
        console.log(`[DeleteOperationsService] Graph file has ${imageIds.length} images, checking references...`);
        
        // Check if ANY other files (node or graph) still reference these images
        // Note: We need to exclude THIS graph from the scan since it's being deleted
        const referencedImages = await this.scanAllFilesForImageReferencesExcluding(imageIds, `graph-${graphId}`);
        
        // Determine which images to delete (no refs anywhere else)
        imagesToDelete = imageIds.filter((id: string) => !referencedImages.has(id));
        
        if (imagesToDelete.length > 0) {
          // Stage images for deletion (don't delete immediately)
          for (const imageId of imagesToDelete) {
            const ext = imageExtensions[imageId] || 'png';
            fileRegistry.registerImageDelete(imageId, `nodes/images/${imageId}.${ext}`);
          }
          
          console.log(`[DeleteOperationsService] Staged ${imagesToDelete.length} orphaned images for deletion`);
        }
        
        if (imagesToDelete.length < imageIds.length) {
          console.log(`[DeleteOperationsService] Keeping ${imageIds.length - imagesToDelete.length} images (still referenced)`);
        }
      }
      
      // Stage graph file deletion
      const filePath = graphFile.path || `graphs/${graphId}.json`;
      fileRegistry.registerFileDeletion(`graph-${graphId}`, filePath, 'graph');
      
      // Remove from local FileRegistry immediately (but Git file remains until commit)
      await fileRegistry.deleteFile(`graph-${graphId}`);
      
      toast.success(`Graph file deletion staged: ${graphId} (commit to sync to Git)`);
      
      console.log('[DeleteOperationsService] Staged graph file deletion:', {
        graphId,
        imagesStaged: imagesToDelete.length,
        imagesKept: imageIds.length - imagesToDelete.length
      });
      
      sessionLogService.success('file', 'GRAPH_FILE_DELETE_SUCCESS', 
        `Graph file deletion staged: ${graphId}`,
        `Images staged for deletion: ${imagesToDelete.length}, Images kept: ${imageIds.length - imagesToDelete.length}`,
        { fileId: `graph-${graphId}`, filesAffected: imagesToDelete });
    } catch (error) {
      console.error('Failed to delete graph file:', error);
      toast.error('Failed to delete graph file');
      
      sessionLogService.error('file', 'GRAPH_FILE_DELETE_FAILURE', 
        `Failed to delete graph file: ${graphId}`,
        error instanceof Error ? error.message : String(error),
        { fileId: `graph-${graphId}` });
      throw error;
    }
  }
  
  /**
   * Scan all node and graph files for image references, EXCLUDING a specific file
   * Used when deleting a file to check if images are still referenced by OTHER files
   */
  async scanAllFilesForImageReferencesExcluding(imageIds: string[], excludeFileId: string): Promise<Set<string>> {
    const referenced = new Set<string>();
    
    // 1) Scan ALL node files from IDB (not just loaded ones)
    const allNodeFiles = await workspaceService.getAllNodeFilesFromIDB();
    for (const nodeFile of allNodeFiles) {
      // Skip the file being deleted
      if (nodeFile.fileId === excludeFileId) continue;
      
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
      // Skip the file being deleted
      if (graphFile.fileId === excludeFileId) continue;
      
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
    
    console.log('[DeleteOperationsService] Image reference scan (excluding ' + excludeFileId + '):', {
      imageIdsToCheck: imageIds,
      referencedCount: referenced.size,
      orphanedCount: imageIds.length - referenced.size
    });
    
    return referenced;
  }
}

export const deleteOperationsService = new DeleteOperationsService();
