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
import { db } from '../db/appDatabase';
import { FileState } from '../types';
import { sessionLogService } from './sessionLogService';

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

  // Cache for getCommittableFiles to avoid excessive IDB queries
  private committableFilesCache: {
    key: string;
    files: FileState[];
    timestamp: number;
  } | null = null;
  private readonly CACHE_TTL_MS = 1000; // Cache for 1 second

  /**
   * Initialize with dependencies
   */
  initialize(deps: { navigatorOps: any; dialogOps?: any }) {
    this.navigatorOps = deps.navigatorOps;
    this.dialogOps = deps.dialogOps;
  }
  
  /**
   * Invalidate the committable files cache (call after commits, pulls, saves)
   */
  invalidateCommittableFilesCache() {
    this.committableFilesCache = null;
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
    sessionLogService.info('git', 'GIT_PULL', `Pulling latest from ${repository}/${branch}`, undefined,
      { repository, branch });

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      sessionLogService.error('git', 'GIT_PULL_ERROR', 'Pull failed: No credentials available');
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      sessionLogService.error('git', 'GIT_PULL_ERROR', `Pull failed: Repository "${repository}" not found in credentials`);
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    try {
    // Use workspaceService.pullLatest which does incremental SHA comparison + merge
    const result = await workspaceService.pullLatest(repository, branch, gitCreds);

    // Reload Navigator to show updated files
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    // Build file details summary for logging
    const buildFileDetails = (): string | undefined => {
      const parts: string[] = [];
      const newFiles = result.newFiles || [];
      const changedFiles = result.changedFiles || [];
      const deletedFiles = result.deletedFiles || [];
      
      if (newFiles.length === 0 && changedFiles.length === 0 && deletedFiles.length === 0) {
        return 'No files changed';
      }
      
      // Helper to get just the filename from a path
      const getName = (path: string) => path.split('/').pop() || path;
      
      if (newFiles.length > 0) {
        parts.push(`+${newFiles.length} new: ${newFiles.map(getName).join(', ')}`);
      }
      if (changedFiles.length > 0) {
        parts.push(`~${changedFiles.length} changed: ${changedFiles.map(getName).join(', ')}`);
      }
      if (deletedFiles.length > 0) {
        parts.push(`-${deletedFiles.length} deleted: ${deletedFiles.map(getName).join(', ')}`);
      }
      
      return parts.join(' | ');
    };

    // Invalidate cache since workspace was updated
    this.invalidateCommittableFilesCache();

    if (result.conflicts && result.conflicts.length > 0) {
      console.log(`⚠️ RepositoryOperationsService: Pull completed with ${result.conflicts.length} conflicts`);
        sessionLogService.warning('git', 'GIT_PULL_CONFLICTS', 
          `Pull completed with ${result.conflicts.length} conflict(s)`, 
          result.conflicts.map((c: any) => c.fileName || c.fileId).join(', '),
          { conflicts: result.conflicts.map((c: any) => c.fileName || c.fileId) });
      return { success: true, conflicts: result.conflicts };
    }

    const fileDetails = buildFileDetails();
    console.log(`✅ RepositoryOperationsService: Pulled latest successfully - ${fileDetails}`);
    sessionLogService.success('git', 'GIT_PULL_SUCCESS', `Pulled latest from ${repository}/${branch}`,
      fileDetails,
      { repository, branch, newFiles: result.newFiles, changedFiles: result.changedFiles, deletedFiles: result.deletedFiles });
    return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionLogService.error('git', 'GIT_PULL_ERROR', `Pull failed: ${message}`);
      throw error;
    }
  }

  /**
   * Clone/refresh workspace (force)
   * - Force delete and re-clone
   */
  async cloneWorkspace(repository: string, branch: string): Promise<void> {
    console.log(`🔄 RepositoryOperationsService: Force cloning ${repository}/${branch}`);
    sessionLogService.info('git', 'GIT_CLONE', `Cloning workspace ${repository}/${branch}`, undefined,
      { repository, branch });

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      sessionLogService.error('git', 'GIT_CLONE_ERROR', 'Clone failed: No credentials available');
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      sessionLogService.error('git', 'GIT_CLONE_ERROR', `Clone failed: Repository "${repository}" not found in credentials`);
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    try {
    // Delete and re-clone
    await workspaceService.deleteWorkspace(repository, branch);
    await workspaceService.cloneWorkspace(repository, branch, gitCreds);

    // Reload Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    console.log(`✅ RepositoryOperationsService: Cloned successfully`);
      // Note: detailed logging is done by workspaceService.cloneWorkspace
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionLogService.error('git', 'GIT_CLONE_ERROR', `Clone failed: ${message}`);
      throw error;
    }
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
   * Show dirty files list (from in-memory FileRegistry)
   * Note: For reliable cross-session detection, use getFilesWithChanges() instead
   */
  getDirtyFiles() {
    return fileRegistry.getDirtyFiles();
  }

  /**
   * Get files that have been changed (content-based detection)
   * 
   * This is MORE RELIABLE than isDirty flag because:
   * 1. It compares actual content to originalData
   * 2. Works across page refreshes (persisted in IndexedDB)
   * 3. Doesn't depend on isDirty being correctly maintained
   * 
   * Returns files from IndexedDB where serialized data differs from originalData
   */
  async getFilesWithChanges(repository?: string, branch?: string): Promise<FileState[]> {
    console.log('📊 RepositoryOperationsService: Detecting changed files (content-based)...');
    
    // Get all files from IndexedDB
    let allFiles: FileState[];
    
    if (repository && branch) {
      // Filter by repository/branch
      allFiles = await db.files
        .where('source.repository').equals(repository)
        .and(file => file.source?.branch === branch)
        .toArray();
    } else {
      // Get all files
      allFiles = await db.files.toArray();
    }
    
    const changedFiles: FileState[] = [];
    
    // Files that should never be committed (controlled from code, not repo)
    const EXCLUDED_FROM_COMMIT = new Set([
      'connections-connections',  // connections.yaml - controlled from public/defaults/
    ]);
    
    for (const file of allFiles) {
      // Skip files that are explicitly excluded from commits
      if (EXCLUDED_FROM_COMMIT.has(file.fileId)) {
        console.log(`  ⏭️ Skipping: ${file.fileId} (excluded from commits)`);
        continue;
      }
      
      // Skip if no data or originalData to compare
      if (!file.data || !file.originalData) {
        // If we have data but no originalData, this is a local-only file
        if (file.data && !file.originalData && file.isLocal) {
          changedFiles.push(file);
        }
        continue;
      }
      
      // Content-based comparison
      const dataStr = JSON.stringify(file.data);
      const originalStr = JSON.stringify(file.originalData);
      
      if (dataStr !== originalStr) {
        console.log(`  📝 Changed: ${file.fileId} (content differs from original)`);
        changedFiles.push(file);
      }
    }
    
    console.log(`📊 RepositoryOperationsService: Found ${changedFiles.length} changed files`);
    return changedFiles;
  }

  /**
   * Compute Git blob SHA for content
   * Git blob SHA = SHA-1("blob " + content_length + "\0" + content)
   */
  private async computeGitBlobSha(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const contentBytes = encoder.encode(content);
    const header = `blob ${contentBytes.length}\0`;
    const headerBytes = encoder.encode(header);
    
    // Combine header and content
    const combined = new Uint8Array(headerBytes.length + contentBytes.length);
    combined.set(headerBytes, 0);
    combined.set(contentBytes, headerBytes.length);
    
    // Compute SHA-1
    const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Serialize file data to the format that would be committed to git
   */
  private async serializeFileData(file: FileState): Promise<string> {
    if (file.type === 'graph') {
      return JSON.stringify(file.data, null, 2);
    } else {
      const YAML = await import('yaml');
      return YAML.stringify(file.data);
    }
  }

  /**
   * Get all committable files by comparing to REMOTE state
   * 
   * This is the most reliable method because it compares:
   * - Local serialized content SHA vs stored remote SHA
   * - Works even if originalData was updated (e.g., after pull)
   * - Detects ALL local changes that differ from last sync
   * 
   * Returns files that:
   * 1. Have different content SHA than stored remote SHA
   * 2. OR are local-only (no SHA = never pushed)
   * 3. AND are committable (not credentials, settings, or temporary)
   */
  async getCommittableFiles(repository?: string, branch?: string): Promise<FileState[]> {
    const cacheKey = `${repository || ''}-${branch || ''}`;
    
    // Return cached result if valid
    if (this.committableFilesCache &&
        this.committableFilesCache.key === cacheKey &&
        Date.now() - this.committableFilesCache.timestamp < this.CACHE_TTL_MS) {
      return this.committableFilesCache.files;
    }
    
    console.log('📊 RepositoryOperationsService: Getting committable files (SHA-based comparison)...');
    
    // Get all files from IndexedDB
    let allFiles: FileState[];
    
    if (repository && branch) {
      // Get files matching the workspace, PLUS files with no source (workspace-agnostic files like connections)
      const workspaceFiles = await db.files
        .where('source.repository').equals(repository)
        .and(file => file.source?.branch === branch)
        .toArray();
      
      // Also get files with no source property (they belong to any/current workspace)
      const noSourceFiles = await db.files
        .filter(file => !file.source)
        .toArray();
      
      allFiles = [...workspaceFiles, ...noSourceFiles];
    } else {
      allFiles = await db.files.toArray();
    }
    
    // Deduplicate: files exist with both prefixed and unprefixed IDs
    // Keep the unprefixed version (or strip prefix to get canonical ID)
    const prefix = repository && branch ? `${repository}-${branch}-` : '';
    const seenFileIds = new Set<string>();
    const deduplicatedFiles: FileState[] = [];
    
    for (const file of allFiles) {
      // Get canonical (unprefixed) fileId
      let canonicalId = file.fileId;
      if (prefix && file.fileId.startsWith(prefix)) {
        canonicalId = file.fileId.substring(prefix.length);
      }
      
      // Skip if we've already seen this file
      if (seenFileIds.has(canonicalId)) {
        continue;
      }
      seenFileIds.add(canonicalId);
      
      // Use the file but with canonical ID
      deduplicatedFiles.push({ ...file, fileId: canonicalId });
    }
    
    console.log(`📊 RepositoryOperationsService: ${allFiles.length} files in IDB, ${deduplicatedFiles.length} after deduplication`);
    
    const committableFiles: FileState[] = [];
    
    for (const file of deduplicatedFiles) {
      // Skip non-committable file types
      if (file.type === 'credentials') continue;
      if (file.type === 'settings') continue;
      if (file.type === 'image') continue; // Images handled separately via commitPendingImages()
      if (file.source?.repository === 'temporary') continue;
      
      // Skip files without data
      if (!file.data) continue;
      
      // Check if file has changes compared to remote
      let hasChanges = false;
      let reason = '';
      
      if (!file.sha) {
        // No SHA = local-only file, never pushed
        hasChanges = true;
        reason = 'local-only (no SHA)';
      } else {
        // Compare local content SHA to stored remote SHA
        try {
          const serialized = await this.serializeFileData(file);
          const localSha = await this.computeGitBlobSha(serialized);
          
          if (localSha !== file.sha) {
            hasChanges = true;
            reason = `SHA differs (local: ${localSha.substring(0, 8)}, remote: ${file.sha.substring(0, 8)})`;
          }
        } catch (error) {
          // If we can't compute SHA, fall back to isDirty flag
          console.warn(`  ⚠️ Could not compute SHA for ${file.fileId}:`, error);
          if (file.isDirty) {
            hasChanges = true;
            reason = 'isDirty flag (SHA computation failed)';
          }
        }
      }
      
      if (hasChanges) {
        committableFiles.push(file);
        console.log(`  ✓ Committable: ${file.fileId} - ${reason}`);
      }
    }
    
    console.log(`📊 RepositoryOperationsService: Found ${committableFiles.length} committable files`);
    
    // Cache the result
    this.committableFilesCache = {
      key: cacheKey,
      files: committableFiles,
      timestamp: Date.now()
    };
    
    return committableFiles;
  }

  // NOTE: checkRemoteBeforeCommit() removed - remote-ahead check now happens 
  // inside commitFiles() using commit SHA comparison, which is more accurate

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
    showTripleChoice: (options: any) => Promise<'primary' | 'secondary' | 'cancel'>,
    onPullRequested?: () => Promise<void>
  ): Promise<void> {
    // Start hierarchical log for commit operation
    const logOpId = sessionLogService.startOperation(
      'info',
      'git',
      'GIT_COMMIT',
      `Committing ${files.length} file(s) to ${repository}/${branch}`,
      { 
        repository, 
        branch,
        filesAffected: files.map(f => f.fileId || f.path)
      }
    );
    
    sessionLogService.addChild(logOpId, 'info', 'COMMIT_MESSAGE', `Message: "${message}"`);

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    
    if (!credsResult.success || !credsResult.credentials) {
      sessionLogService.endOperation(logOpId, 'error', 'Commit failed: No credentials available');
      throw new Error('No credentials available. Please configure credentials first.');
    }

    const gitCreds = credsResult.credentials.git.find(cred => cred.name === repository);
    
    if (!gitCreds) {
      sessionLogService.endOperation(logOpId, 'error', `Commit failed: No credentials for repository ${repository}`);
      throw new Error(`No credentials found for repository ${repository}`);
    }

    // Set credentials on gitService
    const credentialsWithRepo = {
      ...credsResult.credentials,
      defaultGitRepo: repository
    };
    gitService.setCredentials(credentialsWithRepo);

    // Check if remote is ahead of local (someone else pushed)
    const workspaceId = `${repository}-${branch}`;
    const workspace = await db.workspaces.get(workspaceId);
    if (workspace?.commitSHA) {
      const remoteHeadSha = await gitService.getRemoteHeadSha(branch);
      if (remoteHeadSha && remoteHeadSha !== workspace.commitSHA) {
        console.log(`⚠️ Remote is ahead: local=${workspace.commitSHA.substring(0, 8)}, remote=${remoteHeadSha.substring(0, 8)}`);
        sessionLogService.addChild(logOpId, 'warning', 'REMOTE_AHEAD', 
          'Remote has new commits',
          `Local: ${workspace.commitSHA.substring(0, 8)}, Remote: ${remoteHeadSha.substring(0, 8)}`,
          { localSha: workspace.commitSHA, remoteSha: remoteHeadSha });
        
        const choice = await showTripleChoice({
          title: 'Remote Is Ahead',
          message: 
            `The remote branch has commits that you don't have locally.\n\n` +
            `Pull changes first to avoid conflicts?`,
          primaryLabel: 'Pull Now',
          secondaryLabel: 'Proceed Anyway',
          cancelLabel: 'Cancel',
          primaryVariant: 'primary',
          secondaryVariant: 'danger'
        });
        
        if (choice === 'cancel') {
          sessionLogService.endOperation(logOpId, 'info', 'Commit cancelled by user');
          throw new Error('Commit cancelled');
        }
        
        if (choice === 'primary' && onPullRequested) {
          sessionLogService.endOperation(logOpId, 'info', 'Commit paused - pulling changes first');
          await onPullRequested();
          throw new Error('Pull completed - please commit again');
        }
        
        // choice === 'secondary' - proceed with commit
        sessionLogService.addChild(logOpId, 'warning', 'FORCE_COMMIT', 
          'User chose to proceed despite remote being ahead');
      }
    }

    try {
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
      // Get the file from registry
      const fileState = fileRegistry.getFile(file.fileId);
      let content = file.content;
      
      // Only update metadata timestamps for graphs (they have a standard metadata structure)
      // Don't mutate fileState.data directly - create a copy for serialization
      if (fileState?.data) {
        if (fileState.type === 'graph' && fileState.data.metadata) {
          // Create a shallow copy with updated timestamp for commit
          const dataForCommit = {
            ...fileState.data,
            metadata: {
              ...fileState.data.metadata,
              updated_at: nowISO,
              ...(gitCreds?.userName && !fileState.data.metadata.author ? { author: gitCreds.userName } : {})
            }
          };
          content = JSON.stringify(dataForCommit, null, 2);
        } else {
          // For non-graph files (YAML), just serialize as-is without modifying
          content = YAML.stringify(fileState.data);
        }
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
      modifiedFiles: files?.length ?? 0,
      imageOps: imageFiles?.length ?? 0,
      fileDeletions: fileDeletions?.length ?? 0,
      total: filesToCommit?.length ?? 0
    });

      // Log files being committed
      for (const file of filesToCommit) {
        const action = file.delete ? 'DELETE' : (file.binaryContent ? 'IMAGE' : 'UPDATE');
        sessionLogService.addChild(logOpId, 'info', `COMMIT_${action}`, 
          `${action}: ${file.path}`,
          undefined,
          { filePath: file.path });
      }

    // Commit and push
    const result = await gitService.commitAndPushFiles(filesToCommit, message, branch);
    if (!result.success) {
        sessionLogService.endOperation(logOpId, 'error', `Commit failed: ${result.error || 'Unknown error'}`);
      throw new Error(result.error || 'Failed to commit files');
    }

    // Mark files as saved in FileRegistry
    for (const file of files || []) {
      try {
        await fileRegistry.markSaved(file.fileId);
      } catch (e) {
        console.error(`Failed to mark file ${file.fileId} as saved:`, e);
      }
    }
    
    // Invalidate cache since files were committed
    this.invalidateCommittableFilesCache();

    // Update workspace's commitSHA to reflect the new remote HEAD
    // This prevents false "remote is ahead" warnings on subsequent commits
    const newRemoteHeadSha = await gitService.getRemoteHeadSha(branch);
    if (newRemoteHeadSha && workspace) {
      workspace.commitSHA = newRemoteHeadSha;
      workspace.lastSynced = Date.now();
      await db.workspaces.put(workspace);
      console.log(`✅ Updated workspace commitSHA to ${newRemoteHeadSha.substring(0, 8)}`);
    }

      sessionLogService.endOperation(logOpId, 'success', 
        `Committed ${filesToCommit?.length ?? 0} file(s) to ${repository}/${branch}`,
        { 
          repository, 
          branch,
          filesAffected: filesToCommit?.map(f => f.path) ?? [],
          added: files?.length ?? 0,
          updated: imageFiles?.length ?? 0,
          errors: fileDeletions?.length ?? 0
        });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('cancelled')) {
        sessionLogService.endOperation(logOpId, 'error', `Commit failed: ${errorMessage}`);
      } else {
        sessionLogService.endOperation(logOpId, 'info', 'Commit cancelled by user');
      }
      throw error;
    }
  }
}

// Export singleton instance
export const repositoryOperationsService = new RepositoryOperationsService();

