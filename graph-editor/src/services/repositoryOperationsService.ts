/**
 * RepositoryOperationsService
 * 
 * Central service for repository operations (pull, push, clone, status).
 * Properly wired to workspaceService for IndexedDB-based workspace management.
 */

import { workspaceService } from './workspaceService';
import { fileRegistry } from '../contexts/TabContext';
import { gitService } from './gitService';
import { CredentialsManager } from '../lib/credentials';

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

  /**
   * Initialize with dependencies
   */
  initialize(deps: { navigatorOps: any }) {
    this.navigatorOps = deps.navigatorOps;
  }

  /**
   * Pull latest changes from remote
   * - Delete local workspace
   * - Re-clone from Git
   * - Reload Navigator
   */
  async pullLatest(repository: string, branch: string): Promise<void> {
    console.log(`🔄 RepositoryOperationsService: Pulling latest for ${repository}/${branch}`);

    // Get git credentials
    const credsResult = await CredentialsManager.load();
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
      await this.navigatorOps.loadItems();
    }

    console.log(`✅ RepositoryOperationsService: Pulled latest successfully`);
  }

  /**
   * Clone/refresh workspace (force)
   * - Force delete and re-clone
   */
  async cloneWorkspace(repository: string, branch: string): Promise<void> {
    console.log(`🔄 RepositoryOperationsService: Force cloning ${repository}/${branch}`);

    // Get git credentials
    const credsResult = await CredentialsManager.load();
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
      await this.navigatorOps.loadItems();
    }

    console.log(`✅ RepositoryOperationsService: Cloned successfully`);
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
    const credsResult = await CredentialsManager.load();
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

        // Commit to Git
        await gitService.commitFile(
          file.path || `${file.type}s/${file.fileId}.yaml`,
          content,
          message,
          branch,
          gitCreds.owner,
          gitCreds.repo,
          gitCreds.token,
          file.sha // Include SHA for conflict detection
        );

        // Mark as saved
        file.isDirty = false;
        file.lastSaved = Date.now();
        file.originalData = structuredClone(file.data);
        
        // Update in FileRegistry
        fileRegistry.notifyListeners(file.fileId, file);

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
          fileRegistry.notifyListeners(file.fileId, file);
        }
      }
      discardedCount++;
    }

    // Reload Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.loadItems();
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

