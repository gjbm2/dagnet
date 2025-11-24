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

  // NOTE: pushChanges() removed - was dead code that called non-existent gitService.commitFile()
  // For committing files, use the CommitModal UI flow which calls gitService.commitAndPushFiles()

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

  /**
   * Check remote status before committing
   * Shows dialog if remote is ahead
   * Returns true if should proceed, false if cancelled
   */
  async checkRemoteBeforeCommit(
    repository: string,
    branch: string,
    showConfirmDialog: (options: any) => Promise<boolean>,
    showLoadingToast: (message: string) => any,
    dismissToast: (id: any) => void
  ): Promise<boolean> {
    try {
      const credsResult = await credentialsManager.loadCredentials();
      
      if (!credsResult.success || !credsResult.credentials) {
        return true; // No credentials, skip check
      }

      const gitCreds = credsResult.credentials.git.find(cred => cred.name === repository);
      
      if (!gitCreds) {
        return true; // No credentials for this repo, skip check
      }

      const toastId = showLoadingToast('Checking remote status...');
      const remoteStatus = await workspaceService.checkRemoteAhead(repository, branch, gitCreds);
      dismissToast(toastId);
      
      if (remoteStatus.isAhead) {
        const fileList = remoteStatus.changedPaths.length > 0 
          ? '\n\nFiles:\n' + remoteStatus.changedPaths.map(path => `  • ${path}`).join('\n') + '\n'
          : '';
        const confirmed = await showConfirmDialog({
          title: 'Remote Has Changes',
          message: 
            `The remote repository has changes you don't have:\n\n` +
            `• ${remoteStatus.filesChanged} file(s) changed\n` +
            `• ${remoteStatus.filesAdded} file(s) added\n` +
            `• ${remoteStatus.filesDeleted} file(s) deleted` +
            fileList +
            `\nIt's recommended to pull first to avoid conflicts.`,
          confirmLabel: 'Commit Anyway',
          cancelLabel: 'Cancel',
          confirmVariant: 'danger'
        });
        
        return confirmed;
      }
      
      return true; // Remote not ahead, proceed
    } catch (error) {
      console.error('Failed to check remote status:', error);
      return true; // On error, allow commit to proceed
    }
  }

  /**
   * Commit and push files with pre-commit validation
   * - Checks for files changed on remote
   * - Shows warning dialog if needed
   * - Updates file timestamps
   * - Includes pending image operations
   * - Includes pending file deletions
   * - Commits and pushes to Git
   * - Marks files as saved
   * 
   * This is the SINGLE entry point for all commit operations
   */
  async commitFiles(
    files: any[],
    message: string,
    branch: string,
    repository: string,
    showConfirmDialog: (options: any) => Promise<boolean>
  ): Promise<void> {
    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    
    if (!credsResult.success || !credsResult.credentials) {
      throw new Error('No credentials available. Please configure credentials first.');
    }

    const gitCreds = credsResult.credentials.git.find(cred => cred.name === repository);
    
    if (!gitCreds) {
      throw new Error(`No credentials found for repository ${repository}`);
    }

    // Set credentials on gitService
    const credentialsWithRepo = {
      ...credsResult.credentials,
      defaultGitRepo: repository
    };
    gitService.setCredentials(credentialsWithRepo);

    // Check for files changed on remote and warn user
    const changedFiles = await gitService.checkFilesChangedOnRemote(files, branch, gitCreds.basePath);
    if (changedFiles.length > 0) {
      const fileList = changedFiles.map(path => `  • ${path}`).join('\n');
      const confirmed = await showConfirmDialog({
        title: 'Files Changed on Remote',
        message: 
          `The following file(s) have been changed on the remote:\n\n${fileList}\n\n` +
          `Committing will overwrite the remote changes. Continue anyway?`,
        confirmLabel: 'Commit Anyway',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });
      
      if (!confirmed) {
        throw new Error('Commit cancelled by user');
      }
    }

    // Update file timestamps BEFORE committing to Git
    const nowISO = new Date().toISOString();
    const YAML = await import('yaml');
    
    const filesToCommit: Array<{
      path: string;
      content?: string;
      binaryContent?: Uint8Array;
      encoding?: 'utf-8' | 'base64';
      sha?: string;
      delete?: boolean;
    }> = files.map(file => {
      // Get the file from registry to update its metadata
      const fileState = fileRegistry.getFile(file.fileId);
      let content = file.content;
      
      // Update timestamp in the file content itself (standardized metadata structure)
      if (fileState?.data) {
        // All file types now use metadata.updated_at
        if (!fileState.data.metadata) {
          fileState.data.metadata = {
            created_at: nowISO,
            version: '1.0.0'
          };
        }
        fileState.data.metadata.updated_at = nowISO;
        
        // Set author from credentials userName if available
        if (gitCreds?.userName && !fileState.data.metadata.author) {
          fileState.data.metadata.author = gitCreds.userName;
        }
        
        // Re-serialize with updated timestamp
        content = fileState.type === 'graph' 
          ? JSON.stringify(fileState.data, null, 2)
          : YAML.stringify(fileState.data);
      }
      
      const basePath = gitCreds.basePath || '';
      const fullPath = basePath ? `${basePath}/${file.path}` : file.path;
      return {
        path: fullPath,
        content,
        sha: file.sha
      };
    });

    const basePath = gitCreds.basePath || '';
    
    // Add pending image operations (uploads + image deletions)
    const imageFiles = await fileRegistry.commitPendingImages();
    filesToCommit.push(...imageFiles.map(img => ({
      path: basePath ? `${basePath}/${img.path}` : img.path,
      binaryContent: img.binaryContent,
      encoding: img.encoding,
      delete: img.delete
    })));
    
    // Add pending file deletions
    const fileDeletions = await fileRegistry.commitPendingFileDeletions();
    filesToCommit.push(...fileDeletions.map(del => ({
      path: basePath ? `${basePath}/${del.path}` : del.path,
      delete: true
    })));
    
    console.log('[RepositoryOperationsService] Committing:', {
      modifiedFiles: files.length,
      imageOps: imageFiles.length,
      fileDeletions: fileDeletions.length,
      total: filesToCommit.length
    });

    // Commit and push
    const result = await gitService.commitAndPushFiles(filesToCommit, message, branch);
    if (!result.success) {
      throw new Error(result.error || 'Failed to commit files');
    }

    // Mark files as saved in FileRegistry
    for (const file of files) {
      await fileRegistry.markSaved(file.fileId);
    }
  }
}

// Export singleton instance
export const repositoryOperationsService = new RepositoryOperationsService();

