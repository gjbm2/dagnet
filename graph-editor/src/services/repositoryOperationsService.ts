/**
 * RepositoryOperationsService
 * 
 * Central service for repository operations (pull, push, clone, status).
 * Properly wired to workspaceService for IndexedDB-based workspace management.
 */

import { workspaceService } from './workspaceService';
import { fileRegistry } from '../contexts/TabContext';
import { gitService } from './gitService';
import { credentialsManager } from '../lib/credentials';

export interface RepositoryStatus {
  repository: string;
  branch: string;
  dirtyFiles: number;
  localOnlyFiles: number;
  lastSynced?: number;
  isConnected: boolean;
}

class RepositoryOperationsService {
  private navigatorOps: any = null;
  private dialogOps: any = null;

  /**
   * Initialize with dependencies
   */
  initialize(deps: { navigatorOps: any; dialogOps?: any }) {
    this.navigatorOps = deps.navigatorOps;
    this.dialogOps = deps.dialogOps;
  }

  /**
   * Pull latest changes from remote (incremental with 3-way merge)
   * - Compare local SHAs with remote SHAs
   * - Only fetch changed/new files
   * - Perform 3-way merge for files with local changes
   * - Delete files removed remotely
   * - Return conflict info if any
   * - Reload Navigator
   */
  async pullLatest(repository: string, branch: string): Promise<{ success: boolean; conflicts?: any[] }> {
    console.log(`🔄 RepositoryOperationsService: Pulling latest for ${repository}/${branch}`);

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    // Use workspaceService.pullLatest which does incremental SHA comparison + merge
    const result = await workspaceService.pullLatest(repository, branch, gitCreds);

    // Reload Navigator to show updated files
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    if (result.conflicts && result.conflicts.length > 0) {
      console.log(`⚠️ RepositoryOperationsService: Pull completed with ${result.conflicts.length} conflicts`);
      return { success: true, conflicts: result.conflicts };
    }

    console.log(`✅ RepositoryOperationsService: Pulled latest successfully`);
    return { success: true };
  }

  /**
   * Clone/refresh workspace (force)
   * - Force delete and re-clone
   */
  async cloneWorkspace(repository: string, branch: string): Promise<void> {
    console.log(`🔄 RepositoryOperationsService: Force cloning ${repository}/${branch}`);

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    // Delete and re-clone
    await workspaceService.deleteWorkspace(repository, branch);
    await workspaceService.cloneWorkspace(repository, branch, gitCreds);

    // Reload Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    console.log(`✅ RepositoryOperationsService: Cloned successfully`);
  }

  /**
   * Force full reload - delete workspace and re-clone from Git
   * This is the main entry point for "Force Full Reload" command
   * Can be called from menus, context menus, keyboard shortcuts, etc.
   * 
   * @param skipConfirm - Skip confirmation dialog (for programmatic calls)
   */
  async forceFullReload(repository: string, branch: string, skipConfirm: boolean = false): Promise<void> {
    console.log(`🔄 RepositoryOperationsService: Force full reload ${repository}/${branch}`);

    // Confirmation dialog
    if (!skipConfirm && this.dialogOps) {
      const confirmed = await this.dialogOps.showConfirm({
        title: 'Force Full Reload',
        message:
          `Delete local workspace and re-clone ${repository}/${branch} from Git?\n\n` +
          'This will:\n' +
          '• Discard all uncommitted changes\n' +
          '• Clear local workspace cache\n' +
          '• Re-clone the repository into IndexedDB',
        confirmLabel: 'Force Reload',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });
      if (!confirmed) {
        return; // User cancelled
      }
    }

    try {
      // Get git credentials
      const credsResult = await credentialsManager.loadCredentials();
      if (!credsResult.success) {
        throw new Error('No credentials available');
      }

      const gitCreds = credsResult.credentials?.git?.find(
        (repo: any) => repo.name === repository
      );

      if (!gitCreds) {
        throw new Error(`Repository "${repository}" not found in credentials`);
      }

      // Delete workspace
      await workspaceService.deleteWorkspace(repository, branch);
      
      // Re-clone from Git
      await workspaceService.cloneWorkspace(repository, branch, gitCreds);

      // Reload Navigator to reflect fresh workspace
      if (this.navigatorOps) {
        await this.navigatorOps.refreshItems();
      }

      console.log(`✅ RepositoryOperationsService: Force reload complete`);
    } catch (error) {
      // Show error dialog
      if (this.dialogOps) {
        await this.dialogOps.showConfirm({
          title: 'Error',
          message: `Failed to reload workspace: ${error instanceof Error ? error.message : String(error)}`,
          confirmLabel: 'OK',
          cancelLabel: ''
        });
      }
      throw error;
    }
  }

  /**
   * Push all dirty files
   * - Get all dirty files from FileRegistry
   * - Commit and push to remote
   * - Mark as saved
   */
  async pushChanges(
    repository: string,
    branch: string,
    message: string
  ): Promise<number> {
    console.log(`🔄 RepositoryOperationsService: Pushing changes to ${repository}/${branch}`);

    const dirtyFiles = fileRegistry.getDirtyFiles();
    
    if (dirtyFiles.length === 0) {
      console.log('RepositoryOperationsService: No dirty files to push');
      return 0;
    }

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    // Commit each file
    let pushedCount = 0;
    for (const file of dirtyFiles) {
      try {
        // Convert data to string
        const content = typeof file.data === 'string' 
          ? file.data 
          : JSON.stringify(file.data, null, 2);

        // Determine correct file path
        let filePath = file.path;
        if (!filePath) {
          // Check if this is an index file
          if (file.fileId.endsWith('-index')) {
            // Index files go to repo root: parameter-index.yaml, not parameters/parameter-index.yaml
            filePath = `${file.fileId}.yaml`;
          } else {
            // Regular files go to subdirectories: parameters/my-param.yaml
            filePath = `${file.type}s/${file.fileId}.yaml`;
          }
        }

        // Commit to Git
        await (gitService as any).commitFile(
          filePath,
          content,
          message,
          branch,
          gitCreds.owner,
          gitCreds.repo || gitCreds.name,
          gitCreds.token,
          file.sha // Include SHA for conflict detection
        );

        // Mark as saved
        file.isDirty = false;
        file.lastSaved = Date.now();
        file.originalData = structuredClone(file.data);
        
        // Update in FileRegistry
        (fileRegistry as any).notifyListeners(file.fileId, file);

        pushedCount++;
      } catch (error) {
        console.error(`Failed to push ${file.fileId}:`, error);
        throw error;
      }
    }

    console.log(`✅ RepositoryOperationsService: Pushed ${pushedCount} files`);
    return pushedCount;
  }

  /**
   * Discard all local changes
   * - Revert all dirty files
   * - Reload from workspace (IDB)
   */
  async discardLocalChanges(repository: string, branch: string): Promise<number> {
    console.log(`🔄 RepositoryOperationsService: Discarding local changes`);

    const dirtyFiles = fileRegistry.getDirtyFiles();
    
    if (dirtyFiles.length === 0) {
      console.log('RepositoryOperationsService: No dirty files to discard');
      return 0;
    }

    let discardedCount = 0;
    for (const file of dirtyFiles) {
      if (file.isLocal) {
        // Local-only file: delete it
        await fileRegistry.deleteFile(file.fileId);
      } else {
        // Remote file: revert to original
        if (file.originalData) {
          file.data = structuredClone(file.originalData);
          file.isDirty = false;
          (fileRegistry as any).notifyListeners(file.fileId, file);
        }
      }
      discardedCount++;
    }

    // Reload Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    console.log(`✅ RepositoryOperationsService: Discarded ${discardedCount} changes`);
    return discardedCount;
  }

  /**
   * Get repository status
   * - Count dirty files
   * - Check connection
   * - Show branch info
   */
  async getStatus(repository: string, branch: string): Promise<RepositoryStatus> {
    console.log(`📊 RepositoryOperationsService: Getting status for ${repository}/${branch}`);

    const allFiles = fileRegistry.getAllFiles();
    const dirtyFiles = allFiles.filter(f => f.isDirty);
    const localOnlyFiles = allFiles.filter(f => f.isLocal);

    // Get workspace metadata
    const workspace = await workspaceService.getWorkspace(repository, branch);

    return {
      repository,
      branch,
      dirtyFiles: dirtyFiles.length,
      localOnlyFiles: localOnlyFiles.length,
      lastSynced: workspace?.lastSynced,
      isConnected: !!workspace
    };
  }

  /**
   * Show dirty files list
   */
  getDirtyFiles() {
    return fileRegistry.getDirtyFiles();
  }
}

// Export singleton instance
export const repositoryOperationsService = new RepositoryOperationsService();

