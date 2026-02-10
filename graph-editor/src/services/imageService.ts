/**
 * Image Service
 * 
 * Manages serving images from IDB as blob URLs for display in React components.
 * Images are stored in IDB as binary data (Uint8Array) and converted to blob URLs on demand.
 */

import { fileRegistry } from '../contexts/TabContext';

class ImageService {
  private blobUrlCache = new Map<string, string>();
  
  /**
   * Get blob URL for an image from IDB
   * Returns cached URL if available, otherwise loads from IDB and creates new blob URL
   */
  async getImageUrl(imageId: string, ext: string): Promise<string> {
    const cacheKey = `${imageId}.${ext}`;
    
    // Check cache
    if (this.blobUrlCache.has(cacheKey)) {
      return this.blobUrlCache.get(cacheKey)!;
    }
    
    // Try FileRegistry first (in-memory cache)
    let imageFile = fileRegistry.getFile(`image-${imageId}`);
    
    // If not in FileRegistry, try loading from IDB directly
    if (!imageFile || !imageFile.data?.binaryData) {
      const { db } = await import('../db/appDatabase');
      const fileId = `image-${imageId}`;
      
      // Try unprefixed fileId first (for files stored locally)
      imageFile = await db.files.get(fileId);
      
      // If not found, try with workspace prefix (for Git-loaded files)
      if (!imageFile) {
        const appState = await db.appState.get('app-state');
        let repository = appState?.navigatorState?.selectedRepo || '';
        let branch = appState?.navigatorState?.selectedBranch || '';

        // Navigator state can lag during boot/clone/load. Since we enforce a single-workspace policy,
        // fall back to the persisted workspace record (source of truth for current repo/branch).
        if (!repository || !branch) {
          try {
            const workspace = await db.workspaces.toCollection().first();
            if (workspace) {
              repository = repository || workspace.repository;
              branch = branch || workspace.branch;
            }
          } catch {
            // Ignore and proceed - we'll throw a "not found" error below if we can't locate the file.
          }
        }

        // Final safety: if we have a repo but no branch, default to main (historic behaviour).
        if (repository && !branch) {
          branch = 'main';
        }

        if (repository && branch) {
          const prefixedFileId = `${repository}-${branch}-${fileId}`;
          imageFile = await db.files.get(prefixedFileId);

          // If found with prefix, strip prefix and add to FileRegistry
          if (imageFile) {
            const unprefixedFile = { ...imageFile, fileId };
            (fileRegistry as any).files.set(fileId, unprefixedFile);
            imageFile = unprefixedFile;
          }
        }
      } else {
        // Found with unprefixed ID, add to FileRegistry
        (fileRegistry as any).files.set(fileId, imageFile);
      }
    }
    
    if (!imageFile || !imageFile.data?.binaryData) {
      throw new Error(`Image not found in IDB: ${imageId}`);
    }
    
    // Create blob URL
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const blob = new Blob([imageFile.data.binaryData], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    
    // Cache
    this.blobUrlCache.set(cacheKey, blobUrl);
    
    return blobUrl;
  }
  
  /**
   * Revoke blob URL and remove from cache
   * Should be called when image is no longer needed (e.g., component unmount)
   */
  revokeImageUrl(imageId: string, ext: string): void {
    const cacheKey = `${imageId}.${ext}`;
    const blobUrl = this.blobUrlCache.get(cacheKey);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      this.blobUrlCache.delete(cacheKey);
    }
  }
  
  /**
   * Clear all cached blob URLs
   * Useful when workspace changes or app closes
   */
  clearCache(): void {
    for (const blobUrl of this.blobUrlCache.values()) {
      URL.revokeObjectURL(blobUrl);
    }
    this.blobUrlCache.clear();
  }
}

export const imageService = new ImageService();

