/**
 * FileOperationsService
 * 
 * Central service for ALL file operations (create, open, delete, duplicate, rename).
 * This is the SINGLE SOURCE OF TRUTH for file CRUD operations.
 * 
 * Eliminates code duplication across:
 * - FileMenu
 * - NavigatorSectionContextMenu
 * - NavigatorItemContextMenu
 * - TabContextMenu
 * - ParameterSelector
 */

import { fileRegistry } from '../contexts/TabContext';
import { ObjectType, RepositoryItem, ViewMode } from '../types';
import { db } from '../db/appDatabase';
import { credentialsManager } from '../lib/credentials';

export interface CreateFileOptions {
  openInTab?: boolean;
  viewMode?: ViewMode;
  basedOn?: string; // For duplication
  metadata?: any;
  targetPanel?: string;
}

export interface OpenFileOptions {
  viewMode?: ViewMode;
  switchIfExists?: boolean;
  targetPanel?: string;
}

export interface DeleteFileOptions {
  force?: boolean;
  skipConfirm?: boolean;
}

class FileOperationsService {
  // Callbacks that need to be injected by the app
  private navigatorOps: any = null;
  private tabOps: any = null;
  private dialogOps: any = null;

  /**
   * Initialize the service with required dependencies
   * Call this once during app initialization
   */
  initialize(deps: {
    navigatorOps: any;
    tabOps: any;
    dialogOps?: any;
  }) {
    this.navigatorOps = deps.navigatorOps;
    this.tabOps = deps.tabOps;
    this.dialogOps = deps.dialogOps;
  }

  /**
   * Create new file with default content
   * Handles:
   * - Creating FileState in FileRegistry
   * - Updating index file
   * - Adding to Navigator
   * - Opening tab (optional)
   */
  async createFile(
    name: string,
    type: ObjectType,
    options: CreateFileOptions = {}
  ): Promise<{ fileId: string; item: RepositoryItem }> {
    const {
      openInTab = true,
      viewMode = 'interactive',
      basedOn,
      metadata = {}
    } = options;

    console.log(`FileOperationsService: Creating ${type} file: ${name}`);

    // 1. Create default data based on type
    let defaultData: any;
    
    if (basedOn) {
      // Duplication: load source file data
      const sourceFile = fileRegistry.getFile(basedOn);
      if (sourceFile) {
        defaultData = structuredClone(sourceFile.data);
        // Update ID in the data
        if (defaultData.id) {
          defaultData.id = name;
        }
      }
    }
    
    if (!defaultData) {
      // Create new default data
      if (type === 'graph') {
        defaultData = {
          nodes: [],
          edges: [],
          metadata: {
            name,
            description: '',
            created: new Date().toISOString(),
            ...metadata
          }
        };
      } else {
        defaultData = {
          id: name,
          name,
          description: '',
          ...metadata
        };
      }
    }

    // 2. Create file in FileRegistry
    const fileId = `${type}-${name}`;
    
    // Determine correct file path
    // Index files go to repo root: parameter-index.yaml
    // Regular files go to subdirectories: parameters/my-param.yaml
    const filePath = fileId.endsWith('-index') 
      ? `${fileId}.yaml` 
      : `${type}s/${name}.yaml`;
    
    const file = fileRegistry.getOrCreateFile(
      fileId,
      type,
      { repository: 'local', path: filePath, branch: 'main' },
      defaultData
    );

    // 3. Update index (if applicable)
    if (['parameter', 'context', 'case', 'node'].includes(type)) {
      await fileRegistry.updateIndexOnCreate(type as any, fileId, metadata);
    }

    // 4. Create RepositoryItem
    const item: RepositoryItem = {
      id: name,
      name: `${name}.yaml`,
      path: filePath,
      type: type,
      isLocal: true
    };

    // 5. Add to Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.addLocalItem(item);
    }

    // 6. Open in tab (if requested)
    if (openInTab && this.tabOps) {
      await this.tabOps.openTab(item, viewMode);
    }

    // 7. Refresh Navigator to show the new file
    if (this.navigatorOps) {
      // Small delay to ensure IndexedDB write completes
      setTimeout(() => {
        if (this.navigatorOps) {
          this.navigatorOps.refreshItems();
        }
      }, 100);
    }

    console.log(`FileOperationsService: Created ${fileId} successfully`);

    return { fileId, item };
  }

  /**
   * Open file in tab
   * Handles:
   * - Checking if already open
   * - Switching to existing tab vs opening new
   * - Panel placement
   * - Navigator close if unpinned
   */
  async openFile(
    item: RepositoryItem,
    options: OpenFileOptions = {}
  ): Promise<string | null> {
    const {
      viewMode = 'interactive',
      switchIfExists = true,
      targetPanel
    } = options;

    if (!this.tabOps) {
      console.error('FileOperationsService: tabOps not initialized');
      return null;
    }

    console.log(`FileOperationsService: Opening file ${item.id} (${item.type})`);

    // Check if already open
    const fileId = `${item.type}-${item.id}`;
    const file = fileRegistry.getFile(fileId);
    
    if (file && file.viewTabs && file.viewTabs.length > 0 && switchIfExists) {
      // Switch to existing tab
      const existingTabId = file.viewTabs[0];
      this.tabOps.setActiveTab(existingTabId);
      console.log(`FileOperationsService: Switched to existing tab ${existingTabId}`);
      return existingTabId;
    }

    // Open new tab
    const tabId = await this.tabOps.openTab(item, viewMode, targetPanel);
    console.log(`FileOperationsService: Opened new tab ${tabId}`);
    
    return tabId;
  }

  /**
   * Delete file
   * Handles:
   * - Checking for open tabs
   * - Checking for dirty state
   * - Confirmation dialog
   * - Updating index
   * - Removing from Navigator
   * - Removing from FileRegistry
   */
  async deleteFile(
    fileId: string,
    options: DeleteFileOptions = {}
  ): Promise<boolean> {
    const { force = false, skipConfirm = false } = options;

    console.log(`FileOperationsService: Deleting file ${fileId}`);

    const file = fileRegistry.getFile(fileId);
    const [type] = fileId.split('-');
    const isIndexOnlyEntry = !file && ['parameter', 'context', 'case', 'node'].includes(type);

    // Handle index-only entries (no file yet)
    if (isIndexOnlyEntry) {
      if (!skipConfirm && this.dialogOps) {
        const confirm = await this.dialogOps.showConfirm({
          title: 'Remove from index',
          message: `Remove "${fileId}" from the ${type} index?`,
          confirmLabel: 'Remove',
          cancelLabel: 'Cancel',
          confirmVariant: 'danger'
        });
        
        if (!confirm) return false;
      }

      // Remove from index only
      try {
        await (fileRegistry as any).updateIndexOnDelete(type, fileId);
        
        // Refresh Navigator
        if (this.navigatorOps) {
          await this.navigatorOps.refreshItems();
        }
        
        console.log(`FileOperationsService: Removed ${fileId} from index`);
        return true;
      } catch (error) {
        console.error(`FileOperationsService: Failed to remove ${fileId} from index:`, error);
        return false;
      }
    }

    if (!file) {
      console.warn(`FileOperationsService: File ${fileId} not found`);
      return false;
    }

    // 1. Check for open tabs
    if (!force && file.viewTabs && file.viewTabs.length > 0) {
      if (this.dialogOps) {
        const confirm = await this.dialogOps.showConfirm({
          title: 'File has open tabs',
          message: `"${file.name || fileId}" has ${file.viewTabs.length} open tab(s). Close them first?`,
          confirmLabel: 'Close Tabs & Delete',
          cancelLabel: 'Cancel',
          confirmVariant: 'danger'
        });
        
        if (!confirm) return false;
        
        // Close all tabs
        await this.closeAllTabsForFile(fileId);
      } else {
        throw new Error('Cannot delete file with open tabs. Close all tabs first.');
      }
    }

    // 2. Check for dirty state
    if (!force && file.isDirty) {
      if (this.dialogOps) {
        const confirm = await this.dialogOps.showConfirm({
          title: 'Unsaved changes',
          message: `"${file.name || fileId}" has unsaved changes. Delete anyway?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          confirmVariant: 'danger'
        });
        
        if (!confirm) return false;
      } else {
        throw new Error('Cannot delete dirty file. Commit or revert changes first.');
      }
    }

    // 3. Determine if file is committed to repository
    const isCommitted = file.source?.repository !== 'local' && file.sha;
    const isLocal = file.isLocal || file.source?.repository === 'local';

    // 4. Confirmation dialog with appropriate message
    if (!skipConfirm && this.dialogOps) {
      const message = isCommitted
        ? `Delete "${file.name || fileId}" from local workspace AND remote repository?`
        : `Delete "${file.name || fileId}" from local workspace?`;
      
      const confirm = await this.dialogOps.showConfirm({
        title: 'Delete file',
        message,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });
      
      if (!confirm) return false;
    }

    // 5. Delete from repository if committed
    if (isCommitted && file.path) {
      try {
        const credsResult = await credentialsManager.loadCredentials();
        if (!credsResult.success || !credsResult.credentials?.git) {
          throw new Error('No credentials available');
        }

        const repoName = file.source?.repository;
        const gitCreds = credsResult.credentials.git.find((r: any) => r.name === repoName);
        
        if (!gitCreds) {
          throw new Error(`Repository "${repoName}" not found in credentials`);
        }

        // Delete from Git
        const gitService = await import('./gitService').then(m => m.gitService);
        const deleteResult = await gitService.deleteFile(
          file.path,
          `Delete ${file.name || fileId}`,
          file.source?.branch || 'main'
        );
        
        if (!deleteResult.success) {
          throw new Error(deleteResult.error || 'Failed to delete from repository');
        }
        
        console.log(`FileOperationsService: Deleted ${fileId} from repository`);
      } catch (error) {
        console.error(`FileOperationsService: Failed to delete ${fileId} from repository:`, error);
        if (this.dialogOps) {
          const continueAnyway = await this.dialogOps.showConfirm({
            title: 'Repository delete failed',
            message: `Failed to delete from repository: ${error instanceof Error ? error.message : 'Unknown error'}. Continue with local delete?`,
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel'
          });
          if (!continueAnyway) return false;
        }
        // Continue with local delete even if repo delete fails
      }
    }

    // 6. Delete from FileRegistry (also updates index)
    try {
      await fileRegistry.deleteFile(fileId);
    } catch (error) {
      console.error(`FileOperationsService: Failed to delete ${fileId}:`, error);
      return false;
    }

    // 7. Remove from Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    console.log(`FileOperationsService: Deleted ${fileId} successfully`);
    return true;
  }

  /**
   * Duplicate file
   * Handles:
   * - Loading source file
   * - Creating copy with new name
   * - Updating index
   * - Opening in tab
   */
  async duplicateFile(
    sourceFileId: string,
    newName: string,
    openInTab: boolean = true
  ): Promise<{ fileId: string; item: RepositoryItem } | null> {
    console.log(`FileOperationsService: Duplicating ${sourceFileId} → ${newName}`);

    const sourceFile = fileRegistry.getFile(sourceFileId);
    if (!sourceFile) {
      console.error(`FileOperationsService: Source file ${sourceFileId} not found`);
      return null;
    }

    // Create new file based on source
    return await this.createFile(newName, sourceFile.type, {
      openInTab,
      basedOn: sourceFileId
    });
  }

  /**
   * Rename file
   * Handles:
   * - Updating FileState
   * - Updating index
   * - Updating all open tabs
   * - Updating Navigator
   */
  async renameFile(
    fileId: string,
    newName: string
  ): Promise<boolean> {
    console.log(`FileOperationsService: Renaming ${fileId} → ${newName}`);

    const file = fileRegistry.getFile(fileId);
    if (!file) {
      console.error(`FileOperationsService: File ${fileId} not found`);
      return false;
    }

    // TODO: Implement rename logic
    // This is complex because it affects:
    // - FileRegistry (fileId changes)
    // - IndexedDB (need to move record)
    // - Index files (need to update path)
    // - Open tabs (need to update references)
    // For now, recommend duplicate + delete workflow

    console.warn('FileOperationsService: Rename not fully implemented yet. Use duplicate + delete.');
    return false;
  }

  /**
   * Close all tabs for a file
   */
  async closeAllTabsForFile(fileId: string): Promise<void> {
    if (!this.tabOps) {
      console.error('FileOperationsService: tabOps not initialized');
      return;
    }

    const file = fileRegistry.getFile(fileId);
    if (!file || !file.viewTabs) return;

    console.log(`FileOperationsService: Closing ${file.viewTabs.length} tabs for ${fileId}`);

    // Close each tab
    for (const tabId of [...file.viewTabs]) {
      await this.tabOps.closeTab(tabId, true); // force = true
    }
  }

  /**
   * Save file (mark as not dirty, update in IDB)
   */
  async saveFile(fileId: string): Promise<boolean> {
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      console.error(`FileOperationsService: File ${fileId} not found`);
      return false;
    }

    // Update file state
    file.isDirty = false;
    file.lastSaved = Date.now();
    
    // Persist to IndexedDB
    await db.files.put(file);
    
    // Notify listeners
    (fileRegistry as any).notifyListeners(fileId, file);
    
    console.log(`FileOperationsService: Saved ${fileId}`);
    return true;
  }

  /**
   * Revert/discard file changes to original state
   * Shows confirmation dialog if not skipped
   */
  async revertFile(fileId: string, skipConfirm: boolean = false): Promise<boolean> {
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      console.error(`FileOperationsService: File ${fileId} not found`);
      return false;
    }

    if (!file.isDirty) {
      console.log(`FileOperationsService: File ${fileId} is not dirty, nothing to revert`);
      return true;
    }

    if (!file.originalData) {
      if (file.isLocal) {
        // Local-only file: offer to delete it
        if (this.dialogOps && !skipConfirm) {
          const confirm = await this.dialogOps.showConfirm({
            title: 'Discard local file',
            message: `"${file.name || fileId}" is a local-only file. Discard it completely?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Cancel',
            confirmVariant: 'danger'
          });
          
          if (!confirm) return false;
          
          // Delete the file
          return await this.deleteFile(fileId, { force: true, skipConfirm: true });
        }
      }
      
      console.warn(`FileOperationsService: No original data for ${fileId}`);
      return false;
    }

    // Confirm discard
    if (this.dialogOps && !skipConfirm) {
      const confirm = await this.dialogOps.showConfirm({
        title: 'Discard changes',
        message: `Discard all changes to "${file.name || fileId}"? This cannot be undone.`,
        confirmLabel: 'Discard',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });
      
      if (!confirm) return false;
    }

    // Revert to original
    file.data = structuredClone(file.originalData);
    file.isDirty = false;
    
    // Persist to IndexedDB
    await db.files.put(file);
    
    // Notify listeners
    (fileRegistry as any).notifyListeners(fileId, file);
    
    console.log(`FileOperationsService: Reverted ${fileId}`);
    return true;
  }
}

// Export singleton instance
export const fileOperationsService = new FileOperationsService();

