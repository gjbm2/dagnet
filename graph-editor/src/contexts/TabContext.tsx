import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { 
  TabState, 
  FileState, 
  TabOperations, 
  RepositoryItem, 
  ViewMode,
  CommitRequest 
} from '../types';
import { db } from '../db/appDatabase';
import { useDialog } from './DialogContext';

/**
 * Serialize editorState for IndexedDB storage
 * Converts Set objects to arrays (IndexedDB doesn't support Set)
 */
function serializeEditorState(editorState: any): any {
  if (!editorState) return editorState;
  
  const serialized = { ...editorState };
  
  // Convert conditionalOverrides from Record<string, Set<string>> to Record<string, string[]>
  if (serialized.conditionalOverrides) {
    const serializedConditional: Record<string, string[]> = {};
    Object.entries(serialized.conditionalOverrides).forEach(([key, value]) => {
      serializedConditional[key] = value instanceof Set ? Array.from(value) : value as string[];
    });
    serialized.conditionalOverrides = serializedConditional;
  }
  
  // Convert hiddenNodes from Set<string> to string[]
  if (serialized.hiddenNodes) {
    serialized.hiddenNodes = serialized.hiddenNodes instanceof Set ? Array.from(serialized.hiddenNodes) : serialized.hiddenNodes;
  }
  
  // Strip out savedDockLayout from sidebarState (contains React elements that can't be serialized)
  if (serialized.sidebarState?.savedDockLayout) {
    serialized.sidebarState = { ...serialized.sidebarState };
    delete serialized.sidebarState.savedDockLayout;
  }
  
  return serialized;
}

/**
 * Deserialize editorState from IndexedDB
 * Converts arrays back to Set objects
 */
function deserializeEditorState(editorState: any): any {
  if (!editorState) return editorState;
  
  const deserialized = { ...editorState };
  
  // Convert conditionalOverrides from Record<string, string[]> to Record<string, Set<string>>
  if (deserialized.conditionalOverrides) {
    const deserializedConditional: Record<string, Set<string>> = {};
    Object.entries(deserialized.conditionalOverrides).forEach(([key, value]) => {
      deserializedConditional[key] = Array.isArray(value) ? new Set(value) : value as Set<string>;
    });
    deserialized.conditionalOverrides = deserializedConditional;
  }
  
  // Convert hiddenNodes from string[] to Set<string>
  if (deserialized.hiddenNodes) {
    deserialized.hiddenNodes = Array.isArray(deserialized.hiddenNodes) ? new Set(deserialized.hiddenNodes) : deserialized.hiddenNodes;
  }
  
  return deserialized;
}

/**
 * File Registry - Single source of truth for file data
 * Manages files and synchronizes across multiple tabs viewing the same file
 */
class FileRegistry {
  private files = new Map<string, FileState>();
  private listeners = new Map<string, Set<(file: FileState) => void>>();
  private updatingFiles = new Set<string>(); // Guard against re-entrant updates

  /**
   * Get or create a file state
   */
  async getOrCreateFile(
    fileId: string, 
    type: RepositoryItem['type'],
    source: FileState['source'],
    data: any
  ): Promise<FileState> {
    let file = this.files.get(fileId);
    let shouldNotify = false;
    
    if (!file) {
      // Check if file exists in IndexedDB
      file = await db.files.get(fileId);
      
      if (!file) {
        // Create new file state
        file = {
          fileId,
          type,
          data,
          originalData: structuredClone(data),
          isDirty: false, // Files are clean when first loaded
          isInitializing: true, // Allow validation/normalization without marking dirty
          source,
          viewTabs: [],
          lastModified: Date.now()
        };
        
        await db.files.add(file);
        
        // Auto-complete initialization after a short delay (fallback for editors that don't explicitly signal)
        setTimeout(() => {
          this.completeInitialization(fileId);
        }, 500);
      } else {
        // File loaded from IndexedDB
        // If file is dirty, it must have already completed initialization
        // (can't be dirty without user changes, which only happen after init)
        if (file.isDirty && file.isInitializing) {
          console.log(`FileRegistry: File ${fileId} loaded from DB as dirty, completing initialization`);
          file.isInitializing = false;
        }
        
        // If file is still initializing from a previous session, set up timeout
        if (file.isInitializing) {
          setTimeout(() => {
            this.completeInitialization(fileId);
          }, 500);
        }
      }
      
      this.files.set(fileId, file);
      shouldNotify = true; // Notify whenever we add to memory cache
    }
    
    // Notify listeners that file is now available (either newly created or loaded from DB)
    if (shouldNotify) {
      console.log(`FileRegistry: Notifying listeners for ${fileId}, data:`, file.data);
      this.notifyListeners(fileId, file);
      
      // Emit dirty state change event for newly created local files
      if (file.isDirty) {
        window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
          detail: { fileId, isDirty: file.isDirty } 
        }));
      }
    }
    
    return file;
  }

  /**
   * Register a file directly (for testing)
   */
  async registerFile(fileId: string, file: FileState): Promise<void> {
    this.files.set(fileId, file);
    await db.files.put(file);
    this.notifyListeners(fileId, file);
  }

  /**
   * Update file data
   */
  async updateFile(fileId: string, newData: any): Promise<void> {
    // Guard against re-entrant updates (prevents stack overflow)
    if (this.updatingFiles.has(fileId)) {
      console.warn(`FileRegistry: Skipping re-entrant update for ${fileId}`);
      return;
    }
    
    const file = this.files.get(fileId);
    if (!file) {
      console.warn(`FileRegistry: File ${fileId} not found for update (may have been closed)`);
      return;
    }

    this.updatingFiles.add(fileId);
    
    try {
    const oldDataStr = JSON.stringify(file.data);
    const newDataStr = JSON.stringify(newData);
    const originalDataStr = JSON.stringify(file.originalData);
    
    // Debug logging for dirty detection
    const newNodeCount = newData?.nodes?.length ?? 0;
    const originalNodeCount = file.originalData?.nodes?.length ?? 0;
    console.log(`FileRegistry.updateFile[${fileId}]: nodes ${originalNodeCount} → ${newNodeCount}, isInitializing=${file.isInitializing}, contentMatch=${newDataStr === originalDataStr}`);

    // Detect dangerous logical ID changes for registry-backed types
    try {
      const w = (typeof window !== 'undefined') ? (window as any) : null;
      const logicalTypes = new Set(['parameter', 'context', 'case', 'node', 'event']);
      const oldId = file.data?.id;
      const newId = newData?.id;

      if (
        w &&
        logicalTypes.has(file.type as string) &&
        !file.isInitializing &&           // Skip controlled initialization/creation flows
        oldId &&
        newId &&
        oldId !== newId
      ) {
        w.dispatchEvent(
          new CustomEvent('dagnet:logicalIdChanged', {
            detail: {
              fileId,
              type: file.type,
              oldId,
              newId,
            },
          }),
        );
      }
    } catch {
      // Best-effort only; never block updates on listener issues
    }
    
    file.data = newData;
    const wasDirty = file.isDirty;
    
    // Simple dirty detection: if content changed from original, it's dirty. Period.
    // No exceptions - every change marks dirty. The user explicitly wants this.
    file.isDirty = newDataStr !== originalDataStr;
    
    // If this is the first real change during initialization, complete init now
    if (file.isInitializing && file.isDirty) {
      file.isInitializing = false;
    }
    
    file.lastModified = Date.now();

    if (wasDirty !== file.isDirty) {
      console.log(`FileRegistry: ${fileId} dirty state changed:`, wasDirty, '→', file.isDirty);
      console.log('  oldData === newData:', oldDataStr === newDataStr);
      console.log('  newData === original:', newDataStr === originalDataStr);
    }

    // Update in IndexedDB - need to update BOTH prefixed and unprefixed versions
    // Unprefixed version (used by FileRegistry)
    await db.files.put(file);
    
    // Also update prefixed version if it exists (used by workspace loading/commit)
    if (file.source?.repository && file.source?.branch) {
      const prefixedId = `${file.source.repository}-${file.source.branch}-${fileId}`;
      const prefixedFile = { ...file, fileId: prefixedId };
      await db.files.put(prefixedFile);
    }

    // Notify all listeners
    this.notifyListeners(fileId, file);
    
    // Emit dirty state change event for UI updates
    if (wasDirty !== file.isDirty) {
      window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
        detail: { fileId, isDirty: file.isDirty } 
      }));
    }
    } finally {
      this.updatingFiles.delete(fileId);
    }
  }

  /**
   * Complete initialization phase for a file
   * After this, normal dirty tracking applies
   */
  async completeInitialization(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file || !file.isInitializing) return;
    
    console.log(`FileRegistry: Completing initialization for ${fileId}`);
    file.isInitializing = false;
    
    // Update in IndexedDB - need to update BOTH prefixed and unprefixed versions
    // Unprefixed version (used by FileRegistry)
    await db.files.put(file);
    
    // Also update prefixed version if it exists (used by workspace loading/commit)
    if (file.source?.repository && file.source?.branch) {
      const prefixedId = `${file.source.repository}-${file.source.branch}-${fileId}`;
      const prefixedFile = { ...file, fileId: prefixedId };
      await db.files.put(prefixedFile);
    }
    
    // Notify listeners of state change
    this.notifyListeners(fileId, file);
  }

  /**
   * Mark file as saved
   */
  async markSaved(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    console.log(`FileRegistry.markSaved[${fileId}]: Marking as saved`, {
      wasDirty: file.isDirty,
      wasLocal: file.isLocal,
      dataSize: JSON.stringify(file.data).length,
      originalDataSize: JSON.stringify(file.originalData).length
    });

    const now = Date.now();
    
    // DON'T update timestamps here - the file was just committed with whatever
    // timestamp it had. Modifying it now would make IDB diverge from Git.
    // The lastModified/lastSaved fields track when WE saved, not file content timestamps.

    file.originalData = structuredClone(file.data);
    file.isDirty = false;
    file.isLocal = false; // File is now in the repository
    file.lastSaved = now;
    file.lastModified = now;

    console.log(`📝 markSaved[${fileId}]: Marked as saved`, {
      lastSaved: file.lastSaved,
      lastModified: file.lastModified
    });

    // Save to IDB - need to update BOTH prefixed and unprefixed versions
    // Unprefixed version (used by FileRegistry)
    await db.files.put(file);
    
    // Also update prefixed version if it exists (used by workspace loading)
    if (file.source?.repository && file.source?.branch) {
      const prefixedId = `${file.source.repository}-${file.source.branch}-${fileId}`;
      const prefixedFile = { ...file, fileId: prefixedId };
      await db.files.put(prefixedFile);
      console.log(`FileRegistry.markSaved[${fileId}]: Updated prefixed version ${prefixedId}`);
    }
    
    console.log(`FileRegistry.markSaved[${fileId}]: Saved to IDB with updated timestamp`);
    
    this.notifyListeners(fileId, file);
    console.log(`FileRegistry.markSaved[${fileId}]: Notified ${this.listeners.get(fileId)?.size || 0} listeners`);
    
    // Fire custom event so tab indicators can update
    window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
      detail: { fileId, isDirty: false } 
    }));
    console.log(`FileRegistry.markSaved[${fileId}]: Fired dagnet:fileDirtyChanged event`);
  }

  /**
   * Revert file to original data
   */
  async revertFile(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    console.log(`FileRegistry: Reverting ${fileId} to original data`);
    const wasDirty = file.isDirty;
    file.data = structuredClone(file.originalData);
    file.isDirty = false;
    file.lastModified = Date.now();

    await db.files.put(file);
    
    // Emit dirty state change event for UI updates (tab indicators)
    if (wasDirty !== file.isDirty) {
      window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
        detail: { fileId, isDirty: file.isDirty } 
      }));
    }
    
    // Notify listeners - this will add the reverted state to editor history naturally
    this.notifyListeners(fileId, file);
  }

  /**
   * Add a tab to the file's view list
   */
  async addViewTab(fileId: string, tabId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    if (!file.viewTabs.includes(tabId)) {
      file.viewTabs.push(tabId);
      await db.files.put(file);
    }
  }

  /**
   * Remove a tab from the file's view list
   * 
   * NOTE: Files are NEVER deleted when tabs close. They persist in IndexedDB
   * as part of the local workspace. This allows:
   * - Files to remain dirty when tabs close
   * - Index files to stay loaded even when not viewed
   * - Credentials/settings to persist
   * - Proper workspace model where files != tabs
   */
  async removeViewTab(fileId: string, tabId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    file.viewTabs = file.viewTabs.filter(id => id !== tabId);
    
    // NEVER delete file - just update view tabs
    // Files persist in workspace regardless of open tabs
    await db.files.put(file);
    
    console.log(`FileRegistry: Removed tab ${tabId} from ${fileId}, file persists in workspace`);
  }
  
  /**
   * Explicitly delete a file from workspace
   * This is a deliberate user action (File > Delete, context menu delete, etc.)
   * NOT called automatically when tabs close
   * 
   * NOTE: Validation and confirmation should be handled by the caller (fileOperationsService)
   * This function just performs the actual deletion
   */
  async deleteFile(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;
    
    // No validation here - caller (fileOperationsService) handles all confirmations
    // This just performs the deletion
    console.log(`FileRegistry: Deleting ${fileId} (${file.viewTabs.length} tabs, dirty: ${file.isDirty})`);
    
    // Notify listeners BEFORE deleting
    const callbacks = this.listeners.get(fileId);
    if (callbacks) {
      callbacks.forEach(callback => callback(null as any));
    }
    
    // Remove from in-memory registry
    this.files.delete(fileId);
    this.listeners.delete(fileId);
    
    // Delete from IndexedDB.
    // Files cloned from a workspace are stored with a workspace‑prefixed ID
    //   `${repository}-${branch}-${fileId}`
    // while many in‑app operations have historically written unprefixed IDs.
    // To keep behaviour correct (and avoid "zombie" files reloading from IDB),
    // we delete BOTH the plain and prefixed IDs when workspace metadata exists.
    const repo = file.source?.repository;
    const branch = file.source?.branch;
    const idbIds = new Set<string>();
    idbIds.add(fileId);
    if (repo && branch) {
      idbIds.add(`${repo}-${branch}-${fileId}`);
    }
    
    for (const idbId of idbIds) {
      try {
        await db.files.delete(idbId);
      } catch (error) {
        console.warn(`FileRegistry: Failed to delete IDB record ${idbId} (non‑fatal):`, error);
      }
    }
    
    // Update index file to remove entry
    const [type] = fileId.split('-');
    if (type === 'parameter' || type === 'context' || type === 'case' || type === 'node') {
      await this.updateIndexOnDelete(type as any, fileId);
    }
  }

  /**
   * Update index file when a new item is created
   * Called automatically when creating parameters, contexts, cases, or nodes
   */
  async updateIndexOnCreate(type: 'parameter' | 'context' | 'case' | 'node', itemId: string, metadata?: any): Promise<void> {
    const indexFileId = `${type}-index`;
    const indexFileName = `${type}s-index.yaml`;  // parameters-index.yaml (plural form at root)
    
    try {
      // Load or create index file
      let indexFile = this.getFile(indexFileId);
      
      if (!indexFile) {
        // Create new index file
        indexFile = {
          fileId: indexFileId,
          type: type,
          name: indexFileName,
          path: indexFileName,  // Index files go at repo root, not in subdirectories
          data: {
            version: '1.0.0',
            entries: []
          },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastOpened: Date.now(),
          lastModified: Date.now()
        };
        this.files.set(indexFileId, indexFile);
      }
      
      // Ensure data structure exists (match Git repo format)
      if (!indexFile.data) {
        indexFile.data = { 
          version: '1.0.0',
          created_at: new Date().toISOString(),
          parameters: type === 'parameter' ? [] : undefined,
          contexts: type === 'context' ? [] : undefined,
          cases: type === 'case' ? [] : undefined,
          nodes: type === 'node' ? [] : undefined
        };
        // Remove undefined keys
        Object.keys(indexFile.data).forEach(key => {
          if (indexFile.data[key] === undefined) {
            delete indexFile.data[key];
          }
        });
      }
      
      // Get the correct array key based on type
      const arrayKey = `${type}s` as 'parameters' | 'contexts' | 'cases' | 'nodes';
      const entries = indexFile.data[arrayKey] || [];
      
      // Add entry to index
      const newEntry = {
        id: itemId.replace(`${type}-`, ''),
        file_path: `${type}s/${itemId.replace(`${type}-`, '')}.yaml`,
        status: 'active',
        created_at: new Date().toISOString(),
        ...metadata
      };
      
      entries.push(newEntry);
      indexFile.data = {
        ...indexFile.data,
        [arrayKey]: entries,
        updated_at: new Date().toISOString()
      };
      indexFile.isDirty = true;
      indexFile.lastModified = Date.now();
      
      // Save to IDB
      await db.files.put(indexFile);
      
      // Notify listeners
      this.notifyListeners(indexFileId, indexFile);
      
      console.log(`FileRegistry: Added ${itemId} to ${type} index`);
    } catch (error) {
      console.error(`FileRegistry: Failed to update index on create:`, error);
    }
  }

  /**
   * Update index file when an item is deleted
   * Called automatically when deleting parameters, contexts, cases, or nodes
   */
  async updateIndexOnDelete(type: 'parameter' | 'context' | 'case' | 'node', itemId: string): Promise<void> {
    const indexFileId = `${type}-index`;
    
    try {
      const indexFile = this.getFile(indexFileId);
      const arrayKey = `${type}s` as 'parameters' | 'contexts' | 'cases' | 'nodes';
      
      if (!indexFile || !indexFile.data?.[arrayKey]) {
        console.warn(`FileRegistry: No index file found for ${type}`);
        return;
      }
      
      // Remove entry from index
      const itemIdBase = itemId.replace(`${type}-`, '');
      const entries = indexFile.data[arrayKey].filter((entry: any) => entry.id !== itemIdBase);
      
      indexFile.data = {
        ...indexFile.data,
        [arrayKey]: entries,
        updated_at: new Date().toISOString()
      };
      indexFile.isDirty = true;
      indexFile.lastModified = Date.now();
      
      // Save to IDB
      await db.files.put(indexFile);
      
      // Notify listeners
      this.notifyListeners(indexFileId, indexFile);
      
      console.log(`FileRegistry: Removed ${itemId} from ${type} index`);
    } catch (error) {
      console.error(`FileRegistry: Failed to update index on delete:`, error);
    }
  }

  /**
   * Subscribe to file changes
   */
  subscribe(fileId: string, callback: (file: FileState) => void): () => void {
    if (!this.listeners.has(fileId)) {
      this.listeners.set(fileId, new Set());
    }
    
    this.listeners.get(fileId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(fileId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.listeners.delete(fileId);
        }
      }
    };
  }

  /**
   * Notify all listeners of a file change
   */
  private notifyListeners(fileId: string, file: FileState): void {
    const callbacks = this.listeners.get(fileId);
    // ATOMIC RESTORATION: Check if we're in atomic restore window
    // If so, defer notifications to avoid triggering component re-renders during restoration
    try {
      const w = (typeof window !== 'undefined') ? (window as any) : null;
      if (w && w.__DAGNET_ATOMIC_RESTORE_ACTIVE) {
        console.log('[ATOMIC GUARD] fileRegistry.notifyListeners blocked during atomic restore', {
          fileId,
          listenerCount: callbacks ? callbacks.size : 0
        });
        // Defer notifications using setTimeout(0) so they fire after flushSync completes
        setTimeout(() => {
          this.notifyListeners(fileId, file);
        }, 0);
        return;
      }
    } catch {
      // best-effort guards only
    }
    if (callbacks) {
      console.log(`FileRegistry: Notifying ${callbacks.size} listeners for ${fileId}`);
      // Create COMPLETELY NEW objects to ensure React detects changes
      // Deep clone the data to create new object references at all levels
      const fileCopy: FileState = {
        ...file,
        data: JSON.parse(JSON.stringify(file.data)) // Deep clone = new references everywhere
      };
      console.log(`FileRegistry: Calling ${callbacks.size} callbacks with NEW data object`);
      callbacks.forEach(callback => callback(fileCopy));
    }
  }

  /**
   * Get all files
   */
  getAllFiles(): FileState[] {
    return Array.from(this.files.values());
  }

  /**
   * Get all dirty files
   */
  getDirtyFiles(): FileState[] {
    return Array.from(this.files.values()).filter(file => file.isDirty);
  }

  /**
   * Check if a file is git-committable
   * Centralized logic used by all UI entry points (menus, context menus, shortcuts)
   * 
   * Works on FileState object directly (from db.getDirtyFiles()) - no lookup needed
   */
  static isFileCommittable(file: any): boolean {
    if (!file) return false;
    
    // Must be dirty
    if (!file.isDirty) return false;
    
    // Exclude local-only system files
    if (file.type === 'credentials') return false;
    if (file.type === 'settings') return false;
    if (file.source?.repository === 'temporary') return false;
    
    // Exclude files controlled from code (not repo)
    if (file.fileId === 'connections-connections') return false;
    
    return true;
  }

  /**
   * Check if a file is committable by fileId (looks up in FileRegistry)
   * Use this for UI state checks when you only have the fileId
   */
  isFileCommittableById(fileId: string): boolean {
    const file = this.files.get(fileId);
    return FileRegistry.isFileCommittable(file);
  }

  /**
   * Get file by ID
   */
  getFile(fileId: string): FileState | undefined {
    return this.files.get(fileId);
  }

  /**
   * Restore file from database
   * Used when loading persisted tabs
   */
  async restoreFile(fileId: string): Promise<FileState | null> {
    const fileInDb = await db.files.get(fileId);
    if (fileInDb) {
      this.files.set(fileId, fileInDb);
      this.notifyListeners(fileId, fileInDb);
      return fileInDb;
    }
    return null;
  }
  
  // ============================================================
  // PENDING OPERATIONS TRACKING (for Git staging)
  // ============================================================
  
  private pendingImageOps: Array<{
    type: 'upload' | 'delete';
    image_id: string;
    path: string;
    data?: Uint8Array;
  }> = [];
  
  private pendingFileDeletions: Array<{
    fileId: string;
    path: string;
    type: string;
  }> = [];
  
  /**
   * Register a pending image upload
   */
  registerImageUpload(imageId: string, path: string, data: Uint8Array): void {
    this.pendingImageOps.push({
      type: 'upload',
      image_id: imageId,
      path,
      data
    });
    console.log(`FileRegistry: Registered image upload: ${imageId}`);
  }
  
  /**
   * Register a pending image deletion
   */
  async registerImageDelete(imageId: string, path: string): Promise<void> {
    // Remove any pending upload for this image
    this.pendingImageOps = this.pendingImageOps.filter(
      op => op.image_id !== imageId
    );
    
    // Add delete operation for Git
    this.pendingImageOps.push({
      type: 'delete',
      image_id: imageId,
      path
    });
    
    // Remove from FileRegistry memory
    const baseFileId = `image-${imageId}`;
    this.files.delete(baseFileId);
    
    // Remove from IndexedDB (both prefixed and unprefixed versions)
    try {
      await db.files.delete(baseFileId);
      
      // Also try to delete prefixed version
      const allFiles = await db.files.toArray();
      const prefixedFiles = allFiles.filter(f => f.fileId.endsWith(`-${baseFileId}`));
      for (const pf of prefixedFiles) {
        await db.files.delete(pf.fileId);
      }
    } catch (error) {
      console.warn(`FileRegistry: Failed to delete image from IDB: ${imageId}`, error);
    }
    
    console.log(`FileRegistry: Registered image deletion: ${imageId}`);
  }
  
  /**
   * Collect all pending image operations for commit
   * Returns array of GitFileToCommit objects
   */
  async commitPendingImages(): Promise<Array<{
    path: string;
    content?: string;
    binaryContent?: Uint8Array;
    encoding?: 'utf-8' | 'base64';
    delete?: boolean;
  }>> {
    const filesToCommit: Array<any> = [];
    
    for (const op of this.pendingImageOps) {
      if (op.type === 'upload') {
        filesToCommit.push({
          path: op.path,
          binaryContent: op.data!,
          encoding: 'base64'
        });
      } else if (op.type === 'delete') {
        filesToCommit.push({
          path: op.path,
          delete: true
        });
      }
    }
    
    // Clear pending operations
    this.pendingImageOps = [];
    
    console.log(`FileRegistry: Collected ${filesToCommit.length} pending image operations for commit`);
    return filesToCommit;
  }
  
  /**
   * Register a pending file deletion
   */
  registerFileDeletion(fileId: string, path: string, type: string): void {
    this.pendingFileDeletions.push({
      fileId,
      path,
      type
    });
    console.log(`FileRegistry: Registered file deletion: ${fileId}`);
    window.dispatchEvent(new CustomEvent('dagnet:pendingDeletionChanged'));
  }
  
  /**
   * Get all pending file deletions
   */
  getPendingDeletions(): Array<{ fileId: string; path: string; type: string }> {
    return [...this.pendingFileDeletions];
  }
  
  /**
   * Clear (unstage) a pending deletion
   */
  clearPendingDeletion(fileId: string): void {
    this.pendingFileDeletions = this.pendingFileDeletions.filter(
      op => op.fileId !== fileId
    );
    console.log(`FileRegistry: Cleared pending deletion: ${fileId}`);
    window.dispatchEvent(new CustomEvent('dagnet:pendingDeletionChanged'));
  }
  
  /**
   * Collect all pending file deletions for commit
   */
  async commitPendingFileDeletions(): Promise<Array<{
    path: string;
    delete: boolean;
  }>> {
    const filesToCommit = this.pendingFileDeletions.map(op => ({
      path: op.path,
      delete: true
    }));
    
    // Clear pending deletions
    this.pendingFileDeletions = [];
    
    console.log(`FileRegistry: Collected ${filesToCommit.length} pending file deletions for commit`);
    return filesToCommit;
  }
  
  /**
   * Store an image in IDB
   */
  async storeImage(imageFileState: FileState): Promise<void> {
    await db.files.put(imageFileState);
    this.files.set(imageFileState.fileId, imageFileState);
    console.log(`FileRegistry: Stored image ${imageFileState.fileId} in IDB`);
  }
}

// Create singleton instance
export const fileRegistry = new FileRegistry();

/**
 * Use FileRegistry hook - direct access to registry
 */
export function useFileRegistry(): FileRegistry {
  return fileRegistry;
}

/**
 * Tab Context
 */
interface TabContextValue {
  tabs: TabState[];
  activeTabId: string | null;
  operations: TabOperations;
}

const TabContext = createContext<TabContextValue | null>(null);

/**
 * Tab Provider
 */
export function TabProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const { showConfirm } = useDialog();

  // Load tabs from IndexedDB on mount, initialize credentials and connections
  useEffect(() => {
    const initializeApp = async () => {
      await loadTabsFromDB();
      await initializeCredentials();
      await initializeConnections();
      await loadFromURLData();
    };
    initializeApp();
    
    // Listen for temporary tab creation (for log files)
    const handleTemporaryTab = async (event: CustomEvent<{ tab: TabState }>) => {
      const { tab } = event.detail;
      // File already exists in fileRegistry, just create the tab
      setTabs(prev => [...prev, tab]);
      setActiveTabId(tab.id);
      await db.tabs.add(tab);
      await db.saveAppState({ activeTabId: tab.id });
    };
    
    // Listen for tab switch requests (e.g., from session log service when tab already exists)
    const handleSwitchToTab = async (event: CustomEvent<{ tabId: string }>) => {
      const { tabId } = event.detail;
      console.log(`[TabContext] dagnet:switchToTab event received for ${tabId}`);
      setActiveTabId(tabId);
      await db.saveAppState({ activeTabId: tabId });
    };
    
    window.addEventListener('dagnet:openTemporaryTab', handleTemporaryTab as unknown as EventListener);
    window.addEventListener('dagnet:switchToTab', handleSwitchToTab as unknown as EventListener);
    
    return () => {
      window.removeEventListener('dagnet:openTemporaryTab', handleTemporaryTab as unknown as EventListener);
      window.removeEventListener('dagnet:switchToTab', handleSwitchToTab as unknown as EventListener);
    };
  }, []);

  /**
   * Initialize credentials file from schema defaults if it doesn't exist
   */
  const initializeCredentials = async () => {
    const credentialsFileId = 'credentials-credentials';
    const existingFile = fileRegistry.getFile(credentialsFileId);
    
    if (!existingFile) {
      // Check if credentials are loaded from URL - if so, don't create a file
      const { credentialsManager } = await import('../lib/credentials');
      const credentialsResult = await credentialsManager.loadCredentials();
      
      if (credentialsResult.success && credentialsResult.source === 'url') {
        console.log('TabContext: Credentials loaded from URL, skipping file creation');
        return;
      }
      
      // Create credentials file with empty data - defaults come from schema
      console.log('TabContext: Creating credentials file from schema defaults');
      await fileRegistry.getOrCreateFile(credentialsFileId, 'credentials', { repository: 'local', path: 'credentials.yaml', branch: 'main' }, {
        version: '1.0.0',
        git: []
      });
    }
  };

  /**
   * Initialize connections file - seeds from git or creates from defaults
   * This runs during TabProvider initialization, ensuring connections exist before any tabs open
   */
  const initializeConnections = async () => {
    const { seedConnectionsFile } = await import('../init/seedConnections');
    await seedConnectionsFile();
  };

  /**
   * Load graph data from URL parameters (?data=... or ?graph=...)
   */
  const loadFromURLData = async () => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      
      // Handle ?data parameter (compressed/uncompressed JSON)
      const dataParam = urlParams.get('data');
      if (dataParam) {
        console.log('TabContext: Found ?data parameter, attempting to decode...');
        const { decodeStateFromUrl } = await import('../lib/shareUrl');
        const urlData = decodeStateFromUrl();
        
        if (urlData) {
          console.log('TabContext: Successfully decoded graph data from ?data parameter');
          
          // Create file in registry with URL data
          const timestamp = Date.now();
          const fileId = `graph-url-data-${timestamp}`;
          await fileRegistry.getOrCreateFile(fileId, 'graph', { repository: 'url', path: 'url-data', branch: 'main' }, urlData);
          
          // Create new tab directly with the data (don't use openTab which tries to load from GitHub)
          const newTab: TabState = {
            id: `tab-${fileId}-interactive`,
            fileId: fileId,
            title: 'Shared Graph',
            viewMode: 'interactive'
          };
          
          setTabs(prev => [...prev, newTab]);
          setActiveTabId(newTab.id);
          await db.tabs.add(newTab);
          await db.saveAppState({ activeTabId: newTab.id });
          
          // Clean up URL parameter
          const url = new URL(window.location.href);
          url.searchParams.delete('data');
          window.history.replaceState({}, document.title, url.toString());
          
          console.log('TabContext: Successfully loaded graph from ?data parameter');
        } else {
          console.error('TabContext: Failed to decode ?data parameter');
        }
        return;
      }
      
      // Handle ?graph parameter (graph name from default repo)
      const graphName = urlParams.get('graph');
      if (graphName) {
        console.log(`TabContext: Loading graph '${graphName}' from default repo`);
        
        // Check if a tab for this graph already exists (read from DB since state may be stale)
        const savedTabs = await db.tabs.toArray();
        const existingTab = savedTabs.find(t => t.fileId === `graph-${graphName}`);
        if (existingTab) {
          console.log(`TabContext: Tab for graph '${graphName}' already exists (${existingTab.id}), switching to it`);
          setActiveTabId(existingTab.id);
          await db.saveAppState({ activeTabId: existingTab.id });
          
          // Clean up URL parameter
          const url = new URL(window.location.href);
          url.searchParams.delete('graph');
          window.history.replaceState({}, document.title, url.toString());
          return;
        }
        
        // Create a graph item for the named graph
        const graphItem: RepositoryItem = {
          id: graphName,
          name: graphName,
          type: 'graph',
          path: `graphs/${graphName}.json`
        };
        
        // Open tab with the named graph
        await openTab(graphItem, 'interactive', true);
        
        // Clean up URL parameter
        const url = new URL(window.location.href);
        url.searchParams.delete('graph');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened graph '${graphName}'`);
        return;
      }
      
      // Handle ?parameter parameter (parameter name from default repo)
      const parameterName = urlParams.get('parameter');
      if (parameterName) {
        console.log(`TabContext: Loading parameter '${parameterName}' from default repo`);
        
        const parameterItem: RepositoryItem = {
          id: parameterName,
          name: parameterName,
          type: 'parameter',
          path: `parameters/${parameterName}.yaml`
        };
        
        await openTab(parameterItem, 'interactive', true);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('parameter');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened parameter '${parameterName}'`);
        return;
      }
      
      // Handle ?context parameter (context name from default repo)
      const contextName = urlParams.get('context');
      if (contextName) {
        console.log(`TabContext: Loading context '${contextName}' from default repo`);
        
        const contextItem: RepositoryItem = {
          id: contextName,
          name: contextName,
          type: 'context',
          path: `contexts/${contextName}.yaml`
        };
        
        await openTab(contextItem, 'interactive', true);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('context');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened context '${contextName}'`);
        return;
      }
      
      // Handle ?case parameter (case name from default repo)
      const caseName = urlParams.get('case');
      if (caseName) {
        console.log(`TabContext: Loading case '${caseName}' from default repo`);
        
        const caseItem: RepositoryItem = {
          id: caseName,
          name: caseName,
          type: 'case',
          path: `cases/${caseName}.yaml`
        };
        
        await openTab(caseItem, 'interactive', true);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('case');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened case '${caseName}'`);
        return;
      }
    } catch (error) {
      console.error('TabContext: Failed to load data from URL:', error);
    }
  };

  /**
   * Load tabs from IndexedDB
   * Error handling is in db wrapper - if it fails, DB gets nuked and page reloads
   */
  const loadTabsFromDB = async () => {
    const savedTabs = await db.tabs.toArray();
    console.log(`TabContext: Loading ${savedTabs.length} tabs from IndexedDB:`, savedTabs.map(t => t.id));
    
    // Deserialize editorState for each tab (convert arrays back to Sets)
    const deserializedTabs = savedTabs.map(tab => ({
      ...tab,
      editorState: deserializeEditorState(tab.editorState)
    }));
    
    // Load file data for each tab
    for (const tab of deserializedTabs) {
      const restored = await fileRegistry.restoreFile(tab.fileId);
      if (restored) {
        console.log(`TabContext: Restored file data for ${tab.fileId}`);
      }
    }
    
    // Set tabs and activeTabId together - React 18 automatically batches these
    // But we need to ensure activeTabId is set in the same synchronous call
    const appState = await db.getAppState();
    let activeTabIdToSet: string | null = null;
    
    if (appState?.activeTabId) {
      // Validate that the activeTabId exists in the restored tabs
      const activeTabExists = deserializedTabs.some(t => t.id === appState.activeTabId);
      if (activeTabExists) {
        activeTabIdToSet = appState.activeTabId;
        console.log(`TabContext: Restoring activeTabId from IndexedDB: ${appState.activeTabId}`);
      } else {
        // Active tab doesn't exist - use first tab or null
        activeTabIdToSet = deserializedTabs.length > 0 ? deserializedTabs[0].id : null;
        if (activeTabIdToSet) {
          await db.saveAppState({ activeTabId: activeTabIdToSet });
          console.log(`TabContext: Active tab ${appState.activeTabId} not found, using first tab: ${activeTabIdToSet}`);
        } else {
          console.log(`TabContext: No tabs restored, activeTabId will be null`);
        }
      }
    } else if (deserializedTabs.length > 0) {
      // No saved activeTabId, but we have tabs - use first one
      activeTabIdToSet = deserializedTabs[0].id;
      await db.saveAppState({ activeTabId: activeTabIdToSet });
      console.log(`TabContext: No saved activeTabId, using first tab: ${activeTabIdToSet}`);
    }
    
    // Set both state updates together - React 18 will batch them
    // This ensures tabs exist before activeTabId is checked by components
    setTabs(deserializedTabs);
    setActiveTabId(activeTabIdToSet);
  };

  /**
   * Open a tab
   */
  const openTab = useCallback(async (
    item: RepositoryItem, 
    viewMode: ViewMode = 'interactive',
    forceNew: boolean = false,
    initialEditorState?: Partial<TabState['editorState']>
  ): Promise<void> => {
    const fileId = `${item.type}-${item.id}`;
    
    // Generate tab ID - add timestamp if forcing new tab to ensure uniqueness
    const tabId = forceNew 
      ? `tab-${fileId}-${viewMode}-${Date.now()}` 
      : `tab-${fileId}-${viewMode}`;

    // Check if tab already exists (skip if forceNew)
    if (!forceNew) {
      const existingTab = tabs.find(t => t.id === tabId);
      if (existingTab) {
        // If we have initial editor state (e.g., selection), merge it into existing tab
        if (initialEditorState) {
          console.log('[TabContext.openTab] Merging initialEditorState into existing tab:', { tabId, initialEditorState });
          setTabs(prev => prev.map(t => 
            t.id === tabId 
              ? { ...t, editorState: { ...t.editorState, ...initialEditorState } }
              : t
          ));
        }
        setActiveTabId(tabId);
        await db.saveAppState({ activeTabId: tabId });
        return;
      }
    }

    // Load actual data from repository
    let data: any = {};
    let existingFile: any = null; // Track if file already exists (for temporary files)
    
    try {
      if (item.type === 'graph') {
        console.log(`TabContext: Loading graph ${item.name}...`);
        
        // Get the currently selected repository from NavigatorContext by reading from IndexedDB
        const appState = await db.appState.get('app-state');
        let selectedRepo = appState?.navigatorState?.selectedRepo;
        const selectedBranch = appState?.navigatorState?.selectedBranch || 'main';
        
        // Load credentials to configure gitService
        const { credentialsManager } = await import('../lib/credentials');
        const credentialsResult = await credentialsManager.loadCredentials();
        
        // If no selectedRepo in IndexedDB, use defaultGitRepo from credentials
        if (!selectedRepo && credentialsResult.success && credentialsResult.credentials) {
          selectedRepo = credentialsResult.credentials.defaultGitRepo;
          console.log(`TabContext: No selectedRepo in IndexedDB, using defaultGitRepo: ${selectedRepo}`);
        }
        
        console.log(`TabContext: Loading from repo: ${selectedRepo}, branch: ${selectedBranch}`);
        
        if (credentialsResult.success && credentialsResult.credentials && selectedRepo) {
          console.log(`TabContext: Configuring gitService with credentials for repo: ${selectedRepo}`);
          // Configure gitService with credentials for the selected repository
          const { gitService } = await import('../services/gitService');
          const credentialsWithRepo = {
            ...credentialsResult.credentials,
            defaultGitRepo: selectedRepo
          };
          gitService.setCredentials(credentialsWithRepo);
        } else {
          console.warn('TabContext: No credentials or selected repo available for graph loading');
        }
        
        const { graphGitService } = await import('../services/graphGitService');
        const result = await graphGitService.getGraph(item.name, selectedBranch);
        console.log(`TabContext: Graph load result:`, result);
        if (result.success && result.data) {
          data = result.data.content;
          console.log(`TabContext: Loaded graph data with ${data.nodes?.length || 0} nodes`);
        } else {
          console.warn(`TabContext: Graph load failed or no data`);
        }
      } else if (item.type === 'parameter' || item.type === 'context' || item.type === 'case' || item.type === 'node') {
        console.log(`TabContext: Loading ${item.type} ${item.name}...`);
        
        // Check if file already exists in fileRegistry (e.g., temporary log files)
        existingFile = fileRegistry.getFile(fileId);
        if (existingFile && existingFile.source?.repository === 'temporary') {
          // Temporary file already exists - use its data (don't load from Git)
          console.log(`TabContext: File ${fileId} is temporary, using existing data`);
          data = existingFile.data;
        } else {
          // File doesn't exist or is not temporary - load from Git
          const { paramRegistryService } = await import('../services/paramRegistryService');
          
          // Get the currently selected repository from NavigatorContext by reading from IndexedDB
          const appState = await db.appState.get('app-state');
          const selectedRepo = appState?.navigatorState?.selectedRepo;
          const selectedBranch = appState?.navigatorState?.selectedBranch || 'main';
          
          console.log(`TabContext: Loading ${item.type} from repo: ${selectedRepo}, branch: ${selectedBranch}`);
          
          // Load credentials to configure the service
          const { credentialsManager } = await import('../lib/credentials');
          const credentialsResult = await credentialsManager.loadCredentials();
          
          if (credentialsResult.success && credentialsResult.credentials && selectedRepo) {
            const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === selectedRepo);
            if (gitCreds) {
              console.log(`TabContext: Configuring paramRegistryService with credentials for ${gitCreds.name}`);
              paramRegistryService.setConfig({
                source: 'git',
                gitBasePath: gitCreds.basePath || '',
                gitBranch: selectedBranch,
                gitRepoOwner: gitCreds.owner,
                gitRepoName: gitCreds.repo || gitCreds.name,
                gitToken: gitCreds.token
              });
            } else {
              console.warn(`TabContext: No git credentials found for repo: ${selectedRepo}`);
            }
          } else {
            console.warn('TabContext: No credentials or selected repo available for paramRegistryService');
          }
          
          // Load based on type
          try {
            if (item.type === 'parameter') {
              data = await paramRegistryService.loadParameter(item.id);
            } else if (item.type === 'context') {
              data = await paramRegistryService.loadContext(item.id);
            } else if (item.type === 'case') {
              data = await paramRegistryService.loadCase(item.id);
            } else if (item.type === 'node') {
              data = await paramRegistryService.loadNode(item.id);
            }
            console.log(`TabContext: Loaded ${item.type} data:`, data);
          } catch (loadError) {
            console.error(`TabContext: Failed to load ${item.type}:`, loadError);
            // For now, use empty object with error flag
            data = { 
              _loadError: true,
              _errorMessage: String(loadError),
              _fileId: item.id
            };
          }
        }
      } else if (item.type === 'credentials' || item.type === 'connections') {
        console.log(`TabContext: Loading ${item.type} ${item.name}...`);
        // These files are seeded/initialized separately
        // Must already exist in IndexedDB - if not, initialization hasn't completed
        const existing = await db.files.get(fileId);
        if (!existing) {
          throw new Error(`${item.type} file not found - initialization incomplete. Please refresh the page.`);
        }
        data = existing.data;
        console.log(`TabContext: Loaded ${item.type} from IndexedDB with`, 
          item.type === 'connections' ? (data?.connections?.length || 0) + ' connections' : 'data');
      } else if (item.type === 'markdown') {
        console.log(`TabContext: Loading markdown ${item.name}...`);
        // Load markdown content from local docs
        try {
          // Use the path if provided, otherwise default to /docs/{id}.md
          // Ensure path starts with / for absolute fetch
          const fetchPath = item.path || `docs/${item.id}.md`;
          const absolutePath = fetchPath.startsWith('/') ? fetchPath : `/${fetchPath}`;
          console.log(`TabContext: Fetching markdown from ${absolutePath}`);
          const response = await fetch(absolutePath);
          if (response.ok) {
            const markdownContent = await response.text();
            console.log(`TabContext: Loaded ${markdownContent.length} chars of markdown`);
            data = { content: markdownContent };
          } else {
            console.warn(`TabContext: Could not load markdown file: ${absolutePath} (status ${response.status})`);
            data = { content: '# File Not Found\n\nThe requested markdown file could not be loaded.' };
          }
        } catch (error) {
          console.error(`TabContext: Error loading markdown file:`, error);
          data = { content: '# Error Loading File\n\nThere was an error loading the markdown file.' };
        }
      } else {
        console.warn(`TabContext: Unknown item type: ${item.type}`);
        data = {};
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      data = { error: 'Failed to load file' };
    }
    
    // Use the item's source if available, otherwise use 'local' as fallback
    // Note: Files created with 'local' will be updated when workspace loads
    const file = await fileRegistry.getOrCreateFile(
      fileId,
      item.type,
      existingFile?.source || {
        repository: (item as any).repository || 'local',
        path: item.path,
        branch: (item as any).branch || 'main'
      },
      data
    );

    // Create new tab
    const defaultEditorState = viewMode === 'interactive' && fileId.startsWith('graph-') ? {
      useUniformScaling: false,
      massGenerosity: 0.5,
      autoReroute: true,
      useSankeyView: false,
      sidebarOpen: true,
      whatIfOpen: false,
      propertiesOpen: true,
      jsonOpen: false,
      selectedNodeId: null,
      selectedEdgeId: null,
      // IMPORTANT: current layer is visible by default
      scenarioState: {
        scenarioOrder: ['current'],
        visibleScenarioIds: ['current'],
        visibleColourOrderIds: ['current'],
        selectedScenarioId: undefined,
      },
    } : undefined;
    
    const newTab: TabState = {
      id: tabId,
      fileId,
      viewMode,
      title: getTabTitle(item.name, viewMode, item.type),
      icon: getIconForType(item.type),
      closable: true,
      group: 'main-content',
      // Initialize editor state for graph tabs, merging any initial state (e.g., selection)
      editorState: defaultEditorState 
        ? { ...defaultEditorState, ...initialEditorState }
        : initialEditorState
    };

    // Add to registry
    await fileRegistry.addViewTab(fileId, tabId);

    // Add to tabs
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    // Persist to IndexedDB (serialize Set objects)
    const serializedTab = {
      ...newTab,
      editorState: serializeEditorState(newTab.editorState)
    };
    await db.tabs.add(serializedTab as TabState);
    await db.saveAppState({ activeTabId: tabId });
  }, [tabs]);

  /**
   * Close a tab - SINGLE SOURCE OF TRUTH FOR CLOSING TABS
   * This is called by:
   * - Custom close button (✕)
   * - Context menu "Close"
   * - Keyboard shortcut (Cmd+W)
   * - "Close All" operations
   */
  const closeTab = useCallback(async (
    tabId: string, 
    force: boolean = false
  ): Promise<boolean> => {
    console.log(`\n=== CLOSE TAB: ${tabId} (force=${force}) ===`);
    
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.warn(`closeTab: Tab ${tabId} not found in tabs array`);
      return false;
    }

    const file = fileRegistry.getFile(tab.fileId);
    const isLastView = file && file.viewTabs.length === 1 && file.viewTabs[0] === tabId;
    
    console.log(`closeTab: isDirty=${file?.isDirty}, isLastView=${isLastView}, viewTabs=${file?.viewTabs.length}`);
    
    // Files now persist in IndexedDB - no need to warn about dirty files
    // The file will remain in the workspace even if all tabs are closed
    console.log(`closeTab: Closing tab ${tabId} for file ${tab.fileId} (file persists in workspace)`);

    // ATOMIC REMOVAL - all steps with proper state management
    console.log(`closeTab: Step 1 - Remove from file registry`);
    await fileRegistry.removeViewTab(tab.fileId, tabId);

    console.log(`closeTab: Step 2 - Calculate new active tab BEFORE state updates`);
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter(t => t.id !== tabId);
      newActiveId = remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1].id : null;
      console.log(`closeTab: Will switch activeTabId: ${activeTabId} -> ${newActiveId}`);
    }

    console.log(`closeTab: Step 3 - Update ALL state atomically`);
    setTabs(prev => prev.filter(t => t.id !== tabId));
    if (newActiveId !== activeTabId) {
      setActiveTabId(newActiveId);
      await db.saveAppState({ activeTabId: newActiveId || undefined });
    }

    console.log(`closeTab: Step 4 - Remove from IndexedDB`);
    await db.tabs.delete(tabId);
    
    console.log(`closeTab: Step 5 - Check if local file should be removed from navigator`);
    if (isLastView && file) {
      // Clean up temporary log files
      if (file.source?.repository === 'temporary') {
        console.log(`closeTab: Cleaning up temporary file: ${tab.fileId}`);
        const { LogFileService } = await import('../services/logFileService');
        await LogFileService.cleanupTemporaryFile(tab.fileId);
      } else {
        // Dispatch event to let NavigatorContext check if this is a local item
        // and remove it if needed
        window.dispatchEvent(new CustomEvent('dagnet:lastViewClosed', { 
          detail: { 
            fileId: tab.fileId,
            type: file.type
          } 
        }));
      }
    }

    console.log(`closeTab: Step 6 - Signal rc-dock to destroy tab`);
    window.dispatchEvent(new CustomEvent('dagnet:tabClosed', { detail: { tabId } }));

    console.log(`closeTab: ✅ COMPLETED closing ${tabId}\n`);
    return true;
  }, [tabs, activeTabId, showConfirm]);

  /**
   * Switch to a tab
   */
  const switchTab = useCallback(async (tabId: string): Promise<void> => {
    if (import.meta.env.DEV) {
      console.log(`[TabContext.switchTab] Called with tabId=${tabId}`);
      console.log(`[TabContext.switchTab] Current activeTabId=${activeTabId}`);
      console.log(`[TabContext.switchTab] Tab exists=${!!tabs.find(t => t.id === tabId)}`);
      // Only log call stack in development for debugging (if DEBUG_TAB_SWITCH env var is set)
      if (import.meta.env.VITE_DEBUG_TAB_SWITCH === 'true') {
        console.log(`[TabContext.switchTab] Call stack:`, new Error().stack);
      }
    }
    
    if (tabs.find(t => t.id === tabId)) {
      if (import.meta.env.DEV) {
        console.log(`[TabContext.switchTab] Setting activeTabId to ${tabId}`);
      }
      setActiveTabId(tabId);
      await db.saveAppState({ activeTabId: tabId });
      if (import.meta.env.DEV) {
        console.log(`[TabContext.switchTab] ✅ Done`);
      }
    } else {
      console.warn(`[TabContext.switchTab] ⚠️ Tab ${tabId} not found in tabs array`);
    }
  }, [tabs, activeTabId]);

  /**
   * Update tab data
   */
  const updateTabData = useCallback(async (
    fileId: string, 
    newData: any
  ): Promise<void> => {
    await fileRegistry.updateFile(fileId, newData);
  }, []);

  /**
   * Update tab-specific editor state
   */
  const updateTabState = useCallback(async (
    tabId: string,
    editorState: Partial<TabState['editorState']>
  ): Promise<void> => {
    // ATOMIC RESTORATION: Check if we're in atomic restore window
    // If so, defer this update until after the window closes to avoid interference
    try {
      const w = (typeof window !== 'undefined') ? (window as any) : null;
      if (w && w.__DAGNET_ATOMIC_RESTORE_ACTIVE) {
        console.log('[ATOMIC GUARD] TabContext.updateTabState blocked during atomic restore', {
          tabId,
          editorStateKeys: Object.keys(editorState || {}),
          payload: editorState
        });
        // Defer update using setTimeout(0) so it runs after flushSync completes
        setTimeout(() => {
          updateTabState(tabId, editorState);
        }, 0);
        return;
      }
    } catch {
      // best-effort guards only
    }
    let newEditorState: TabState['editorState'] | null = null;
    
    // Update React state with functional update to get LATEST tabs
    setTabs(prev => {
      const currentTab = prev.find(t => t.id === tabId);
      if (!currentTab) return prev;
      
      // Calculate the new state using LATEST tab data
      newEditorState = { ...currentTab.editorState, ...editorState };
      
      // Debug logging for scenario state changes
      if (editorState?.scenarioState) {
        console.log(`[TabContext] updateTabState: scenarioState changing for ${tabId}:`, {
          oldVisible: currentTab.editorState?.scenarioState?.visibleScenarioIds,
          newVisible: editorState.scenarioState.visibleScenarioIds,
          stackTrace: new Error().stack?.split('\n').slice(2, 5).join('\n')
        });
      }
      
      return prev.map(tab => 
        tab.id === tabId 
          ? { ...tab, editorState: newEditorState! }
          : tab
      );
    });
    
    // Persist to IndexedDB with the NEW state (serialize Set objects to arrays)
    if (newEditorState) {
      const serializedState = serializeEditorState(newEditorState);
      await db.tabs.update(tabId, { 
        editorState: serializedState
      });
    }
  }, []); // No dependencies - always uses functional update

  /**
   * Get dirty tabs
   */
  const getDirtyTabs = useCallback((): TabState[] => {
    const dirtyFiles = fileRegistry.getDirtyFiles();
    const dirtyFileIds = new Set(dirtyFiles.map(f => f.fileId));
    return tabs.filter(tab => dirtyFileIds.has(tab.fileId));
  }, [tabs, fileRegistry]);

  /**
   * Save a tab
   */
  const saveTab = useCallback(async (tabId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const file = fileRegistry.getFile(tab.fileId);
    if (!file) return;

    // TODO: Implement actual save to repository
    console.log('Saving file:', file);

    await fileRegistry.markSaved(tab.fileId);
  }, [tabs]);

  /**
   * Save all dirty tabs
   */
  const saveAll = useCallback(async (): Promise<void> => {
    const dirtyTabs = getDirtyTabs();
    await Promise.all(dirtyTabs.map(tab => saveTab(tab.id)));
  }, [getDirtyTabs, saveTab]);

  /**
   * Revert a tab
   */
  const revertTab = useCallback(async (tabId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    await fileRegistry.revertFile(tab.fileId);
  }, [tabs]);

  /**
   * Open in new view
   */
  const openInNewView = useCallback(async (
    tabId: string, 
    viewMode: ViewMode
  ): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const file = fileRegistry.getFile(tab.fileId);
    if (!file) return;

    // Create new tab with UNIQUE ID (always force new, never reuse existing)
    const newTabId = `tab-${tab.fileId}-${viewMode}-${Date.now()}`;

    const newTab: TabState = {
      id: newTabId,
      fileId: tab.fileId,
      viewMode,
      title: getTabTitle(tab.title.split(' (')[0], viewMode, tab.fileId.split('-')[0]),
      icon: tab.icon,
      closable: true,
      group: 'main-content'
    };

    await fileRegistry.addViewTab(tab.fileId, newTabId);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
    
    // Serialize before saving to IndexedDB
    const serializedTab = {
      ...newTab,
      editorState: serializeEditorState(newTab.editorState)
    };
    await db.tabs.add(serializedTab as TabState);
  }, [tabs]);

  /**
   * Commit files
   */
  const commitFiles = useCallback(async (request: CommitRequest): Promise<void> => {
    // TODO: Implement actual git commit
    console.log('Committing files:', request);

    // Mark all files as saved
    await Promise.all(
      request.files.map(f => fileRegistry.markSaved(f.fileId))
    );
  }, []);

  /**
   * Hide a node
   */
  const hideNode = useCallback(async (tabId: string, nodeId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const hiddenNodes = tab.editorState?.hiddenNodes || new Set<string>();
    hiddenNodes.add(nodeId);

    await updateTabState(tabId, { hiddenNodes });
  }, [tabs, updateTabState]);

  /**
   * Unhide a node
   */
  const unhideNode = useCallback(async (tabId: string, nodeId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const hiddenNodes = tab.editorState?.hiddenNodes || new Set<string>();
    hiddenNodes.delete(nodeId);

    await updateTabState(tabId, { hiddenNodes });
  }, [tabs, updateTabState]);

  /**
   * Hide all unselected nodes
   */
  const hideUnselectedNodes = useCallback(async (tabId: string, selectedNodeIds: string[]): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Get all node IDs from the graph
    const file = fileRegistry.getFile(tab.fileId);
    if (!file?.data?.nodes) return;

    const allNodeIds = file.data.nodes.map((node: any) => node.id);
    const selectedSet = new Set(selectedNodeIds);
    const nodesToHide = allNodeIds.filter((id: string) => !selectedSet.has(id));

    const hiddenNodes = new Set<string>(nodesToHide);
    await updateTabState(tabId, { hiddenNodes });
  }, [tabs, updateTabState]);

  /**
   * Show all nodes (unhide all)
   */
  const showAllNodes = useCallback(async (tabId: string): Promise<void> => {
    await updateTabState(tabId, { hiddenNodes: new Set<string>() });
  }, [updateTabState]);

  /**
   * Check if a node is hidden
   */
  const isNodeHidden = useCallback((tabId: string, nodeId: string): boolean => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return false;

    const hiddenNodes = tab.editorState?.hiddenNodes || new Set<string>();
    return hiddenNodes.has(nodeId);
  }, [tabs]);

  /**
   * Get scenario state for a tab
   * If no state exists yet (first open), default to 'current' visible.
   * Existing states are returned verbatim to avoid hidden "fixers".
   */
  const getScenarioState = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return undefined;

    const state = tab.editorState?.scenarioState;

    if (!state) {
      // Default: current layer visible in a well-formed state
      return {
        scenarioOrder: ['current'],
        visibleScenarioIds: ['current'],
        visibleColourOrderIds: ['current'],
        selectedScenarioId: undefined,
      };
    }

    return state;
  }, [tabs]);

  /**
   * Set visible scenarios for a tab
   */
  const setVisibleScenarios = useCallback(async (tabId: string, scenarioIds: string[]): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const currentState = tab.editorState?.scenarioState || {
      scenarioOrder: [],
      visibleScenarioIds: [],
      visibleColourOrderIds: [],
    };

    // Add any new visible scenarios to colourOrderIds (preserving existing order)
    const newColourOrderIds = [...currentState.visibleColourOrderIds];
    for (const id of scenarioIds) {
      if (!newColourOrderIds.includes(id)) {
        newColourOrderIds.push(id);
      }
    }
    // Remove any IDs that are no longer visible
    const finalColourOrderIds = newColourOrderIds.filter(id => scenarioIds.includes(id));

    // Preserve existing scenarioOrder - only update visibility, don't reorder
    // If scenarioOrder doesn't exist yet, ensure all scenarios are included
    let newScenarioOrder = currentState.scenarioOrder || [];
    if (newScenarioOrder.length === 0) {
      // Initialise from visible order (top..bottom)
      newScenarioOrder = [...scenarioIds];
    } else {
      // Keep existing order intact, just ensure any new IDs are added
      const missingIds = scenarioIds.filter(id => !newScenarioOrder.includes(id));
      if (missingIds.length > 0) {
        // Add missing IDs at the top (prepend)
        newScenarioOrder = [...missingIds, ...newScenarioOrder];
      }
    }

    await updateTabState(tabId, {
      scenarioState: {
        ...currentState,
        scenarioOrder: newScenarioOrder,
        visibleScenarioIds: scenarioIds,
        visibleColourOrderIds: finalColourOrderIds
      }
    });
  }, [tabs, updateTabState]);

  /**
   * Add scenarios to visible list (uses functional update to avoid stale closures)
   * This is safer than setVisibleScenarios when called rapidly in succession.
   */
  const addVisibleScenarios = useCallback(async (tabId: string, scenarioIdsToAdd: string[]): Promise<void> => {
    // Use functional update to get LATEST state, avoiding stale closure issues
    setTabs(prevTabs => {
      const tabIndex = prevTabs.findIndex(t => t.id === tabId);
      if (tabIndex < 0) return prevTabs;
      
      const tab = prevTabs[tabIndex];
      const currentState = tab.editorState?.scenarioState || {
        scenarioOrder: [],
        visibleScenarioIds: ['current'],
        visibleColourOrderIds: ['current'],
      };
      
      // Only add IDs that aren't already visible
      const currentVisible = new Set(currentState.visibleScenarioIds);
      const toAdd = scenarioIdsToAdd.filter(id => !currentVisible.has(id));
      
      if (toAdd.length === 0) return prevTabs; // No change needed
      
      const newVisibleIds = [...currentState.visibleScenarioIds, ...toAdd];
      const newColourOrderIds = [...currentState.visibleColourOrderIds, ...toAdd.filter(id => !currentState.visibleColourOrderIds.includes(id))];
      const newScenarioOrder = [...toAdd, ...(currentState.scenarioOrder || [])]; // Prepend new ones
      
      // Create updated tabs array
      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        editorState: {
          ...tab.editorState,
          scenarioState: {
            ...currentState,
            scenarioOrder: newScenarioOrder,
            visibleScenarioIds: newVisibleIds,
            visibleColourOrderIds: newColourOrderIds
          }
        }
      };
      
      console.log(`[TabContext] addVisibleScenarios: Added ${toAdd.length} scenarios to visibility`, {
        tabId,
        added: toAdd,
        newTotal: newVisibleIds.length
      });
      
      return updatedTabs;
    });
  }, []);

  /**
   * Toggle scenario visibility for a tab
   */
  const toggleScenarioVisibility = useCallback(async (tabId: string, scenarioId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const currentState = tab.editorState?.scenarioState || {
      scenarioOrder: [],
      visibleScenarioIds: [],
      visibleColourOrderIds: [],
    };

    const isVisible = currentState.visibleScenarioIds.includes(scenarioId);
    
    let newScenarioOrder: string[];
    let newVisibleIds: string[];
    let newColourOrderIds: string[];
    
    if (isVisible) {
      // Hide scenario - remove from visible but KEEP in scenarioOrder
      newScenarioOrder = currentState.scenarioOrder || currentState.visibleScenarioIds;
      newVisibleIds = currentState.visibleScenarioIds.filter(id => id !== scenarioId);
      newColourOrderIds = currentState.visibleColourOrderIds.filter(id => id !== scenarioId);
      
      // Auto-fallback: ensure at least one layer is always visible
      if (newVisibleIds.length === 0) {
        const fallbackId = scenarioId === 'base' ? 'current' : 'base';
        // Add fallback to scenarioOrder if not there
        if (!newScenarioOrder.includes(fallbackId)) {
          newScenarioOrder = [fallbackId, ...newScenarioOrder];
        }
        newVisibleIds = [fallbackId];
        newColourOrderIds = [fallbackId];
      }
    } else {
      // Show scenario - add to visible, and to scenarioOrder if not there
      newScenarioOrder = currentState.scenarioOrder || currentState.visibleScenarioIds;
      
      if (!newScenarioOrder.includes(scenarioId)) {
        // New scenario - add at top of order
        newScenarioOrder = [scenarioId, ...newScenarioOrder];
      }
      
      // Add to visible at its position in scenarioOrder
      // Filter scenarioOrder to only include this scenario and currently visible ones, maintaining order
      newVisibleIds = newScenarioOrder.filter(id => 
        id === scenarioId || currentState.visibleScenarioIds.includes(id)
      );
      
      // Colours are assigned in activation order, so append to end
      newColourOrderIds = [...currentState.visibleColourOrderIds, scenarioId];
    }

    await updateTabState(tabId, {
      scenarioState: {
        ...currentState,
        scenarioOrder: newScenarioOrder,
        visibleScenarioIds: newVisibleIds,
        visibleColourOrderIds: newColourOrderIds
      }
    });
  }, [tabs, updateTabState]);

  /**
   * Select a scenario for a tab
   */
  const selectScenario = useCallback(async (tabId: string, scenarioId: string | undefined): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const currentState = tab.editorState?.scenarioState || {
      visibleScenarioIds: [],
      visibleColourOrderIds: [],
    };

    await updateTabState(tabId, {
      scenarioState: {
        ...currentState,
        selectedScenarioId: scenarioId
      }
    });
  }, [tabs, updateTabState]);

  /**
   * Reorder visible scenarios for a tab (render order only, not colour order)
   */
  const reorderScenarios = useCallback(async (tabId: string, newOrder: string[]): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const currentState = tab.editorState?.scenarioState || {
      scenarioOrder: [],
      visibleScenarioIds: [],
      visibleColourOrderIds: [],
    };

    // Reorder scenarioOrder, then update visibleScenarioIds to match the new order
    const newVisibleIds = newOrder.filter(id => currentState.visibleScenarioIds.includes(id));

    await updateTabState(tabId, {
      scenarioState: {
        ...currentState,
        scenarioOrder: newOrder,
        visibleScenarioIds: newVisibleIds
      }
    });
  }, [tabs, updateTabState]);

  const operations: TabOperations = {
    openTab,
    closeTab,
    switchTab,
    updateTabData,
    updateTabState,
    getDirtyTabs,
    saveTab,
    saveAll,
    revertTab,
    openInNewView,
    commitFiles,
    hideNode,
    unhideNode,
    hideUnselectedNodes,
    showAllNodes,
    isNodeHidden,
    getScenarioState,
    setVisibleScenarios,
    addVisibleScenarios,
    toggleScenarioVisibility,
    selectScenario,
    reorderScenarios
  };

  return (
    <TabContext.Provider value={{ tabs, activeTabId, operations }}>
      {children}
    </TabContext.Provider>
  );
}

/**
 * Use Tab Context hook
 */
export function useTabContext(): TabContextValue {
  const context = useContext(TabContext);
  if (!context) {
    throw new Error('useTabContext must be used within TabProvider');
  }
  return context;
}

/**
 * Use file state hook - subscribe to file changes
 */
export function useFileState<T = any>(fileId: string): {
  data: T | null;
  originalData: T | null;
  isDirty: boolean;
  updateData: (newData: T) => void;
} {
  const [file, setFile] = useState<FileState<T> | null>(null);

  useEffect(() => {
    console.log(`useFileState: Setting up for ${fileId}`);
    
    // Get initial file state if it exists
    const initialFile = fileRegistry.getFile(fileId);
    if (initialFile) {
      console.log(`useFileState: Found initial file for ${fileId}`, initialFile.data);
      setFile(initialFile as FileState<T>);
    } else {
      console.log(`useFileState: No initial file for ${fileId}, waiting for notification`);
    }

    // Subscribe to changes (will be notified when file is created/loaded/deleted)
    const unsubscribe = fileRegistry.subscribe(fileId, (updatedFile) => {
      if (updatedFile === null) {
        console.log(`useFileState: File ${fileId} was deleted`);
        setFile(null);
      } else {
        console.log(`useFileState[${fileId}]: Received update notification, updating local state`);
        setFile(updatedFile as FileState<T>);
      }
    });

    return unsubscribe;
  }, [fileId]);

  const updateData = useCallback((newData: T) => {
    console.log(`useFileState.updateData[${fileId}]: Calling FileRegistry.updateFile`);
    fileRegistry.updateFile(fileId, newData);
  }, [fileId]);

  return {
    data: file?.data ?? null,
    originalData: file?.originalData ?? null,
    isDirty: file?.isDirty ?? false,
    updateData
  };
}

/**
 * Helper: Get tab title with view mode suffix
 */
function getTabTitle(name: string, viewMode: ViewMode, type?: string): string {
  // Strip file extension
  const nameWithoutExt = name.replace(/\.(yaml|yml|json)$/, '');
  
  // Don't add icon to title - rc-dock renders the icon separately from the tab.icon property
  // Adding it here would cause double icons
  
  // Add view mode suffix
  if (viewMode === 'raw-json') return `${nameWithoutExt} (JSON)`;
  if (viewMode === 'raw-yaml') return `${nameWithoutExt} (YAML)`;
  return nameWithoutExt;
}

/**
 * Helper: Get icon for object type
 */
function getIconForType(type: string): string {
  // Direct icon mapping - avoid circular imports
  const icons: Record<string, string> = {
    graph: '📊',
    parameter: '📋',
    context: '🏷️',
    case: '📦',
    settings: '⚙️',
    about: 'ℹ️'
  };
  return icons[type] || '📄';
}

