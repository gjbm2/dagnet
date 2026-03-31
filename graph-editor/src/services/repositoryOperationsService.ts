/**
 * RepositoryOperationsService
 * 
 * Central service for repository operations (pull, push, clone, status).
 * Properly wired to workspaceService for IndexedDB-based workspace management.
 */

import { workspaceService, type PullOptions, type ForceReplaceRequest } from './workspaceService';
import { fileRegistry } from '../contexts/TabContext';
import { gitService } from './gitService';
import { credentialsManager } from '../lib/credentials';
import { db } from '../db/appDatabase';
import { FileState } from '../types';
import { sessionLogService } from './sessionLogService';
import { conflictResolutionService } from './conflictResolutionService';
import { merge3Way, mergeJson3Way } from './mergeService';
import type { ConflictFile } from '../components/modals/MergeConflictModal';

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
  async pullLatest(
    repository: string,
    branch: string,
    options?: PullOptions
  ): Promise<{ success: boolean; conflicts?: any[]; forceReplaceRequests?: ForceReplaceRequest[]; forceReplaceApplied?: string[] }> {
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
    const result = await workspaceService.pullLatest(repository, branch, gitCreds, options);

    // Force-replace session logging (request + applied)
    try {
      const reqs = (result as any)?.forceReplaceRequests as ForceReplaceRequest[] | undefined;
      const applied = (result as any)?.forceReplaceApplied as string[] | undefined;
      const mode = options?.forceReplace?.mode;

      if (Array.isArray(reqs) && reqs.length > 0) {
        sessionLogService.warning(
          'git',
          'GIT_PULL_FORCE_REPLACE_REQUESTED',
          `Force replace requested for ${reqs.length} file(s)`,
          undefined,
          { repository, branch, mode, files: reqs.map(r => ({ fileId: r.fileId, path: r.path, remoteForceReplaceAtMs: r.remoteForceReplaceAtMs })) }
        );
      }

      if (Array.isArray(applied) && applied.length > 0) {
        sessionLogService.success(
          'git',
          'GIT_PULL_FORCE_REPLACE_APPLIED',
          `Force replaced ${applied.length} file(s) (overwrite remote, skipped merge)`,
          undefined,
          { repository, branch, mode, fileIds: applied }
        );
      }
    } catch {
      // best-effort only
    }

    // Dynamic update: file revision changes are a first-class staleness cause.
    // Emit a lightweight event so graph/scenario/chart orchestrators can decide what (if anything) to reconcile.
    // (No business logic here; this is a signal only.)
    try {
      window.dispatchEvent(
        new CustomEvent('dagnet:workspaceFilesChanged', {
          detail: {
            repository,
            branch,
            newFiles: (result as any)?.newFiles || [],
            changedFiles: (result as any)?.changedFiles || [],
            deletedFiles: (result as any)?.deletedFiles || [],
          },
        })
      );
    } catch {
      // best-effort only
    }

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
      return {
        success: true,
        conflicts: result.conflicts,
        forceReplaceRequests: (result as any).forceReplaceRequests || [],
        forceReplaceApplied: (result as any).forceReplaceApplied || [],
      };
    }

    const fileDetails = buildFileDetails();
    console.log(`✅ RepositoryOperationsService: Pulled latest successfully - ${fileDetails}`);
    sessionLogService.success('git', 'GIT_PULL_SUCCESS', `Pulled latest from ${repository}/${branch}`,
      fileDetails,
      { repository, branch, newFiles: result.newFiles, changedFiles: result.changedFiles, deletedFiles: result.deletedFiles });
    return {
      success: true,
      forceReplaceRequests: (result as any).forceReplaceRequests || [],
      forceReplaceApplied: (result as any).forceReplaceApplied || [],
    };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionLogService.error('git', 'GIT_PULL_ERROR', `Pull failed: ${message}`);
      throw error;
    }
  }

  /**
   * Pull latest changes, but auto-resolve any merge conflicts by accepting REMOTE versions.
   *
   * Intended for headless automation runs where "remote wins" is the safest default.
   * Still logs conflicts to session log for morning inspection.
   */
  async pullLatestRemoteWins(
    repository: string,
    branch: string
  ): Promise<{ success: boolean; conflictsResolved: number; conflicts?: any[] }> {
    // Headless/unattended default: auto-OK force-replace requests (overwrite remote, skip merge).
    // This ensures dashboard mode and daily automation converge without user interaction.
    const preflight = await this.pullLatest(repository, branch, { forceReplace: { mode: 'detect' } });
    const requested = preflight.forceReplaceRequests || [];
    const allowFileIds = requested.map(r => r.fileId);

    if (allowFileIds.length > 0) {
      sessionLogService.warning(
        'git',
        'GIT_PULL_FORCE_REPLACE_AUTO_OK',
        `Auto-OK force replace for ${allowFileIds.length} file(s) (unattended)`,
        undefined,
        { repository, branch, fileIds: allowFileIds }
      );
    }

    const result =
      allowFileIds.length > 0
        ? await this.pullLatest(repository, branch, { forceReplace: { mode: 'apply', allowFileIds } })
        : preflight;
    const conflicts = result.conflicts || [];
    if (conflicts.length === 0) {
      return { success: true, conflictsResolved: 0 };
    }

    sessionLogService.warning(
      'git',
      'GIT_PULL_CONFLICTS_REMOTE_WINS',
      `Pull completed with ${conflicts.length} conflict(s) - applying remote versions`,
      undefined,
      { repository, branch, conflicts: conflicts.map((c: any) => c.fileName || c.fileId) }
    );

    const resolutions = new Map<string, 'remote'>();
    for (const c of conflicts) {
      if (c?.fileId) resolutions.set(c.fileId, 'remote');
    }

    const conflictsResolved = await conflictResolutionService.applyResolutions(conflicts as any, resolutions as any, { silent: true });

    // Refresh navigator again so resolved state is reflected.
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    // Invalidate cache since file states may have changed.
    this.invalidateCommittableFilesCache();

    return { success: true, conflictsResolved, conflicts };
  }

  /**
   * Pull latest version of a single file from remote
   * - Fetches file content from Git
   * - Updates local file in IDB and FileRegistry
   * - Marks file as not dirty (synced with remote)
   */
  async pullFile(fileId: string, repository: string, branch: string): Promise<{ success: boolean; message?: string; conflict?: ConflictFile }> {
    console.log(`🔄 RepositoryOperationsService: Pulling file ${fileId} from ${repository}/${branch}`);
    sessionLogService.info('git', 'GIT_PULL_FILE', `Pulling file ${fileId}`, undefined, { fileId, repository, branch });

    // Get the file from registry to find its path
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      const error = `File ${fileId} not found in registry`;
      sessionLogService.error('git', 'GIT_PULL_FILE_ERROR', error);
      throw new Error(error);
    }

    if (!file.source?.path) {
      const error = `File ${fileId} has no source path - cannot pull`;
      sessionLogService.error('git', 'GIT_PULL_FILE_ERROR', error);
      throw new Error(error);
    }

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      sessionLogService.error('git', 'GIT_PULL_FILE_ERROR', 'Pull failed: No credentials available');
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      sessionLogService.error('git', 'GIT_PULL_FILE_ERROR', `Repository "${repository}" not found in credentials`);
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    try {
      // Configure gitService with credentials
      const fullCredentials = {
        git: [gitCreds],
        defaultGitRepo: repository
      };
      gitService.setCredentials(fullCredentials);

      // Fetch file from remote
      const result = await gitService.getFileContent(file.source.path, branch);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch file from remote');
      }

      // getFileContent returns { ...file, content: string } - extract the content
      const fileData = result.data as { content: string; sha?: string };
      const content = fileData.content;
      
      if (!content) {
        throw new Error('File content is empty');
      }
      
      const isYaml = file.source.path.endsWith('.yaml') || file.source.path.endsWith('.yml');
      const isJson = file.source.path.endsWith('.json');
      const YAML = isYaml ? await import('yaml') : null;

      const parseContent = (raw: string): any => {
        if (isJson) return JSON.parse(raw);
        if (isYaml && YAML) return YAML.parse(raw);
        return raw;
      };
      const serialise = (data: any): string => {
        if (isJson) return JSON.stringify(data, null, 2);
        if (isYaml && YAML) return YAML.stringify(data);
        return String(data);
      };

      const remoteData = parseContent(content);

      const hasLocalChanges = file.isDirty ||
        (file.originalData && serialise(file.data) !== serialise(file.originalData));

      let finalData: any;

      if (hasLocalChanges && file.originalData) {
        // JSON files: structural merge (key-by-key, handles different-key additions).
        // Other files: text-based line-level merge.
        if (isJson) {
          // Diagnostic: log the top-level keys each side has so we can trace merge decisions.
          const baseKeys = Object.keys(file.originalData || {}).sort();
          const localKeys = Object.keys(file.data || {}).sort();
          const remoteKeys = Object.keys(remoteData || {}).sort();
          const localOnly = localKeys.filter(k => !baseKeys.includes(k));
          const remoteOnly = remoteKeys.filter(k => !baseKeys.includes(k));
          sessionLogService.info('git', 'JSON_MERGE_INPUTS',
            `Structural merge inputs for ${fileId}`,
            `base keys: ${baseKeys.join(', ')}\nlocal keys: ${localKeys.join(', ')}\nremote keys: ${remoteKeys.join(', ')}\nlocal-only: ${localOnly.join(', ') || '(none)'}\nremote-only: ${remoteOnly.join(', ') || '(none)'}`,
            { fileId, baseKeyCount: baseKeys.length, localKeyCount: localKeys.length, remoteKeyCount: remoteKeys.length, localOnlyKeys: localOnly, remoteOnlyKeys: remoteOnly });

          const jsonMerge = mergeJson3Way(file.originalData, file.data, remoteData);

          if (jsonMerge.hasConflicts) {
            const baseContent = serialise(file.originalData);
            const localContent = serialise(file.data);
            const remoteContent = JSON.stringify(remoteData, null, 2);

            // Log each conflict path with detail about what each side has.
            for (const c of jsonMerge.conflicts) {
              const pathStr = c.path.join('.');
              sessionLogService.warning('git', 'JSON_MERGE_CONFLICT_DETAIL',
                `Conflict at "${pathStr}": base=${typeof c.base === 'object' ? JSON.stringify(c.base)?.slice(0, 80) : String(c.base)}, local=${typeof c.local === 'object' ? JSON.stringify(c.local)?.slice(0, 80) : String(c.local)}, remote=${typeof c.remote === 'object' ? JSON.stringify(c.remote)?.slice(0, 80) : String(c.remote)}`,
                undefined,
                { fileId, path: pathStr });
            }

            sessionLogService.warning('git', 'GIT_PULL_FILE_CONFLICT',
              `Pull file ${fileId}: structural merge has ${jsonMerge.conflicts.length} conflict(s)`,
              jsonMerge.conflicts.map(c => c.path.join('.')).join(', '),
              { fileId, conflictCount: jsonMerge.conflicts.length, paths: jsonMerge.conflicts.map(c => c.path.join('.')) });
            return {
              success: false,
              message: `Merge conflict pulling ${file.name || fileId}`,
              conflict: {
                fileId,
                fileName: file.name || fileId,
                path: file.source!.path,
                type: file.type || 'unknown',
                localContent: localContent,
                remoteContent: remoteContent,
                baseContent: baseContent,
                mergedContent: JSON.stringify(jsonMerge.merged, null, 2),
                hasConflicts: true,
              },
            };
          }

          finalData = jsonMerge.merged;
          sessionLogService.info('git', 'GIT_PULL_FILE_MERGED',
            `Structural auto-merge for ${fileId} (JSON)`, undefined, { fileId });
        } else {
          const baseContent = serialise(file.originalData);
          const localContent = serialise(file.data);
          const remoteContent = isYaml && YAML ? YAML.stringify(remoteData) : content;

          const mergeResult = merge3Way(baseContent, localContent, remoteContent);

          if (mergeResult.hasConflicts) {
            sessionLogService.warning('git', 'GIT_PULL_FILE_CONFLICT',
              `Pull file ${fileId}: 3-way merge has conflicts`,
              undefined, { fileId, conflictCount: mergeResult.conflicts?.length });
            return {
              success: false,
              message: `Merge conflict pulling ${file.name || fileId}`,
              conflict: {
                fileId,
                fileName: file.name || fileId,
                path: file.source!.path,
                type: file.type || 'unknown',
                localContent: localContent,
                remoteContent: remoteContent,
                baseContent: baseContent,
                mergedContent: mergeResult.merged || '',
                hasConflicts: true,
              },
            };
          }

          finalData = parseContent(mergeResult.merged || remoteContent);
        }

        sessionLogService.info('git', 'GIT_PULL_FILE_MERGED',
          `Auto-merged local changes with remote for ${fileId}`, undefined, { fileId });
      } else {
        finalData = remoteData;
      }

      if (fileData.sha) {
        file.sha = fileData.sha;
      }

      file.data = finalData;
      file.originalData = structuredClone(finalData);
      file.isDirty = false;
      file.isLocal = false;
      file.lastModified = Date.now();

      await db.files.put(file);

      if (file.source?.repository && file.source?.branch) {
        const prefixedId = `${file.source.repository}-${file.source.branch}-${fileId}`;
        const prefixedFile = { ...file, fileId: prefixedId };
        await db.files.put(prefixedFile);
      }

      (fileRegistry as any).notifyListeners(fileId, file);

      window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', {
        detail: { fileId, isDirty: false }
      }));

      sessionLogService.success('git', 'GIT_PULL_FILE', `Pulled ${fileId} from remote`);
      return { success: true, message: `Updated ${file.name || fileId} from remote` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionLogService.error('git', 'GIT_PULL_FILE_ERROR', `Pull file failed: ${message}`);
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

      console.log(`✅ RepositoryOperationsService: Force reload complete — reloading page`);

      // Hard page reload to get a genuinely clean slate (fresh FileRegistry,
      // graph stores, editors, no stale loadingRef guards).  IDB is already
      // populated by cloneWorkspace, so the reload hydrates from fresh data.
      window.location.reload();
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
   * Discard all local changes for the given workspace.
   *
   * Uses IDB (source of truth) to find ALL dirty files, not just those loaded
   * in FileRegistry (which only has open tabs).  For files that are also in
   * FileRegistry we delegate to fileRegistry.revertFile() so listeners, events
   * and IDB are updated consistently.  For IDB-only files we patch IDB directly.
   */
  async discardLocalChanges(repository: string, branch: string): Promise<number> {
    const logOpId = sessionLogService.startOperation('info', 'git', 'DISCARD_LOCAL', `Discarding local changes for ${repository}/${branch}`);

    // IDB stores files with workspace-prefixed IDs: "repo-branch-fileId"
    const workspacePrefix = `${repository}-${branch}-`;

    // Query IDB — the source of truth for dirty state
    const allDirtyFiles = await db.getDirtyFiles();
    const dirtyFiles = allDirtyFiles.filter(f => f.fileId.startsWith(workspacePrefix));

    if (dirtyFiles.length === 0) {
      sessionLogService.endOperation(logOpId, 'success', 'No dirty files to discard');
      return 0;
    }

    let discardedCount = 0;
    for (const idbFile of dirtyFiles) {
      // Derive the unprefixed fileId used by FileRegistry
      const unprefixedId = idbFile.fileId.substring(workspacePrefix.length);
      const registryFile = fileRegistry.getFile(unprefixedId);

      if (registryFile) {
        // File is loaded in FileRegistry — delegate so listeners/events fire
        if (registryFile.isLocal) {
          await fileRegistry.deleteFile(unprefixedId);
        } else {
          await fileRegistry.revertFile(unprefixedId);
        }
      } else {
        // File only exists in IDB (not open in any tab) — patch directly
        if (idbFile.originalData) {
          idbFile.data = structuredClone(idbFile.originalData);
          idbFile.isDirty = false;
          idbFile.lastModified = Date.now();
          await db.files.put(idbFile);
        } else {
          // Local-only file with no original — remove from IDB
          await db.files.delete(idbFile.fileId);
        }
      }

      sessionLogService.addChild(logOpId, 'info', 'DISCARD_FILE', `Discarded: ${unprefixedId}`);
      discardedCount++;
    }

    // Reload Navigator
    if (this.navigatorOps) {
      await this.navigatorOps.refreshItems();
    }

    sessionLogService.endOperation(logOpId, 'success', `Discarded ${discardedCount} file(s)`);
    return discardedCount;
  }

  /**
   * Create a new branch on the remote from an existing branch
   */
  async createBranch(
    newBranchName: string,
    sourceBranch: string,
    repository: string
  ): Promise<{ success: boolean; error?: string }> {
    sessionLogService.info('git', 'GIT_CREATE_BRANCH', `Creating branch ${newBranchName} from ${sourceBranch}`, undefined, {
      repository,
      sourceBranch,
      newBranchName
    });

    const result = await gitService.createBranch(newBranchName, sourceBranch);

    if (!result.success) {
      sessionLogService.error('git', 'GIT_CREATE_BRANCH_ERROR', `Failed to create branch: ${result.error}`, undefined, {
        repository,
        sourceBranch,
        newBranchName
      });
      return { success: false, error: result.error };
    }

    sessionLogService.success('git', 'GIT_CREATE_BRANCH_SUCCESS', `Created branch ${newBranchName} from ${sourceBranch}`, undefined, {
      repository,
      sourceBranch,
      newBranchName,
      sha: result.data?.sha
    });

    return { success: true };
  }

  /**
   * Merge one branch into another on the remote.
   *
   * Returns { success, alreadyUpToDate?, conflict?, error? }.
   * On conflict the caller should warn the user and recommend aborting
   * (Level 3 will add client-side conflict resolution).
   */
  async mergeBranch(
    headBranch: string,
    baseBranch: string,
    repository: string,
    commitMessage?: string
  ): Promise<{ success: boolean; alreadyUpToDate?: boolean; conflict?: boolean; error?: string }> {
    sessionLogService.info('git', 'GIT_MERGE_BRANCH', `Merging ${headBranch} → ${baseBranch}`, undefined, {
      repository,
      headBranch,
      baseBranch
    });

    const result = await gitService.mergeBranch(headBranch, baseBranch, commitMessage);

    if (!result.success) {
      const isConflict = result.error === 'conflict';
      sessionLogService[isConflict ? 'warning' : 'error'](
        'git',
        isConflict ? 'GIT_MERGE_CONFLICT' : 'GIT_MERGE_ERROR',
        result.message || 'Merge failed',
        undefined,
        { repository, headBranch, baseBranch }
      );
      return { success: false, conflict: isConflict, error: result.message || result.error };
    }

    const alreadyUpToDate = result.data?.alreadyUpToDate === true;
    sessionLogService.success('git', 'GIT_MERGE_SUCCESS',
      alreadyUpToDate
        ? `${baseBranch} already up to date with ${headBranch}`
        : `Merged ${headBranch} → ${baseBranch}`,
      undefined,
      { repository, headBranch, baseBranch, sha: result.data?.sha }
    );

    return { success: true, alreadyUpToDate };
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
   * 3. AND are committable (not credentials/images/temporary/excluded, and have a commit-able path)
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
    
    // Files that should never be committed (controlled from code, not repo)
    const EXCLUDED_FROM_COMMIT = new Set([
      'connections-connections',  // connections.yaml - controlled from public/defaults/
    ]);
    
    for (const file of deduplicatedFiles) {
      // Skip files explicitly excluded from commits
      if (EXCLUDED_FROM_COMMIT.has(file.fileId)) {
        console.log(`  ⏭️ Skipping: ${file.fileId} (excluded from commits)`);
        continue;
      }
      
      // Skip non-committable file types
      if (file.type === 'credentials') continue;
      if (file.type === 'image') continue; // Images handled separately via commitPendingImages()
      if (file.source?.repository === 'temporary') continue;
      
      // Skip files without data
      if (!file.data) continue;

      // Safety: don't return files that cannot be committed (commit requires a real repo path)
      // This prevents crashes in headless automation when a local seed exists without any source/path.
      if (!file.path && !file.source?.path) {
        console.log(`  ⏭️ Skipping: ${file.fileId} (no path; cannot be committed)`);
        continue;
      }

      // Safety (settings seed): after "Clean", we seed a default settings file locally.
      // If the repo doesn't have settings/settings.yaml (or pull fails), we must not commit
      // the default seed back to the repo unless the user explicitly edited it.
      if (file.type === 'settings' && !file.sha && !file.source && !file.isDirty) {
        console.log(`  ⏭️ Skipping: ${file.fileId} (settings seed; no sha/source and not dirty)`);
        continue;
      }
      
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
    onPullRequested?: () => Promise<void>,
    onProgress?: (completed: number, total: number, phase: 'uploading' | 'finalising') => void,
    onHashGuard?: (result: import('./commitHashGuardService').HashGuardResult) => Promise<import('./commitHashGuardService').HashChangeItem[]>,
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
    }> = files.map((file: any) => {
      const fileId: string | undefined = file?.fileId;

      // Prefer FileRegistry (live state). Fall back to the passed object if it looks like a FileState.
      const registryState = fileId ? fileRegistry.getFile(fileId) : undefined;
      const fileState: any = registryState || (file?.data ? file : undefined);

      let content: string | undefined = file?.content;
      
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
      // Ensure correct file extension: graphs should always be .json
      const rawPath =
        (typeof file?.path === 'string' && file.path.trim() !== '' ? file.path.trim() : undefined) ||
        (typeof fileState?.source?.path === 'string' && fileState.source.path.trim() !== '' ? fileState.source.path.trim() : undefined);

      if (!rawPath) {
        const idHint = fileId || fileState?.fileId || '(unknown fileId)';
        throw new Error(`Cannot commit "${idHint}": missing file path (no file.path and no source.path)`);
      }

      let filePath = rawPath;
      if (fileState?.type === 'graph' && filePath.endsWith('.yaml')) {
        filePath = filePath.replace(/\.yaml$/, '.json');
        console.log(`[RepositoryOperationsService] Corrected graph path: ${rawPath} → ${filePath}`);
      }
      const fullPath = basePath ? `${basePath}/${filePath}` : filePath;
      return {
        path: fullPath,
        content,
        sha: file?.sha ?? fileState?.sha
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

    // ═══════════════════════════════════════════════════════════════
    // HASH GUARD: Detect hash-breaking changes in event/context files
    // and offer to create hash-mappings.json entries before pushing.
    // ═══════════════════════════════════════════════════════════════
    if (onHashGuard) {
      try {
        const { commitHashGuardService } = await import('./commitHashGuardService');
        const guardResult = await commitHashGuardService.detectHashChanges(
          files || [],
          async (path: string, br: string) => {
            const fileResult = await gitService.getFileContent(path, br);
            if (!fileResult.success || !fileResult.data) return null;
            return fileResult.data;
          },
          { repository, branch }
        );

        if (guardResult && guardResult.totalMappings > 0) {
          const selectedItems = await onHashGuard(guardResult);

          if (selectedItems.length > 0) {
            // Write hash-mappings.json entries for selected items
            const { addMapping, getMappingsFile } = await import('./hashMappingsService');
            for (const item of selectedItems) {
              // Each parameter generates 2 mapping entries (window + cohort)
              // but both use the same old/new core_hash pair
              await addMapping({
                core_hash: item.oldCoreHash,
                equivalent_to: item.newCoreHash,
                operation: 'equivalent',
                weight: 1,
                reason: `Hash guard: ${item.changedFile} changed, preserving ${item.paramLabel} in ${item.graphName}`,
              });
            }

            // Add hash-mappings.json to the commit if it was modified
            const mappingsFile = getMappingsFile();
            if (mappingsFile && mappingsFile.mappings.length > 0) {
              filesToCommit.push({
                path: 'hash-mappings.json',
                content: JSON.stringify(mappingsFile, null, 2),
              });
              sessionLogService.addChild(logOpId, 'info', 'HASH_GUARD_MAPPINGS',
                `Added ${selectedItems.length} hash mapping(s) to commit`);
            }
          }
        }
      } catch (err) {
        console.warn('[CommitFiles] Hash guard failed (non-blocking):', err);
        sessionLogService.addChild(logOpId, 'warning', 'HASH_GUARD_ERROR',
          `Hash guard failed: ${(err as Error).message}`);
      }
    }

    // Commit and push
    const result = await gitService.commitAndPushFiles(filesToCommit, message, branch, onProgress);
    if (!result.success) {
        sessionLogService.endOperation(logOpId, 'error', `Commit failed: ${result.error || 'Unknown error'}`);
      throw new Error(result.error || 'Failed to commit files');
    }

    // Mark files as saved in FileRegistry, and fix any corrected paths
    for (const file of files || []) {
      try {
        // Get the file state to check if path needs updating
        const fileState = fileRegistry.getFile(file.fileId);
        
        // If this was a graph file with .yaml extension, update to .json
        if (fileState?.type === 'graph' && fileState.source?.path?.endsWith('.yaml')) {
          const correctedPath = fileState.source.path.replace(/\.yaml$/, '.json');
          console.log(`[RepositoryOperationsService] Updating stored path: ${fileState.source.path} → ${correctedPath}`);
          fileState.source.path = correctedPath;
          // Update in IDB
          await db.files.put(fileState);
        }
        
        await fileRegistry.markSaved(file.fileId);
      } catch (e) {
        console.error(`Failed to mark file ${file.fileId} as saved:`, e);
      }
    }

    // Mark committed images as clean in IDB (prevents re-committing on next commit)
    if (imageFiles && imageFiles.length > 0) {
      try {
        const allIdbFiles = await db.files.toArray();
        const dirtyImages = allIdbFiles.filter(
          (f: any) => f.type === 'image' && f.isDirty
        );
        for (const img of dirtyImages) {
          img.isDirty = false;
          img.lastSynced = Date.now();
          await db.files.put(img);
        }
        console.log(`✅ Marked ${dirtyImages.length} images as clean after commit`);
      } catch (e) {
        console.error('Failed to mark images as clean after commit:', e);
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

  /**
   * Rollback repository to a specific commit
   * 
   * This fetches ALL files from the specified commit and replaces local versions.
   * Uses the same efficient parallel fetching as pullLatest.
   * All changed files are marked dirty so user can review and commit, or pull to revert.
   * 
   * @param repository - Repository name
   * @param branch - Current branch  
   * @param commitSha - The commit SHA to rollback to
   */
  async rollbackToCommit(
    repository: string, 
    branch: string, 
    commitSha: string
  ): Promise<{ success: boolean; filesChanged: number }> {
    console.log(`🔄 RepositoryOperationsService: Rolling back ${repository}/${branch} to commit ${commitSha.substring(0, 7)}`);
    sessionLogService.info('git', 'GIT_ROLLBACK', `Rolling back to commit ${commitSha.substring(0, 7)}`, undefined,
      { repository, branch, commitSha });

    // Get git credentials
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success) {
      sessionLogService.error('git', 'GIT_ROLLBACK_ERROR', 'Rollback failed: No credentials available');
      throw new Error('No credentials available');
    }

    const gitCreds = credsResult.credentials?.git?.find(
      (repo: any) => repo.name === repository
    );

    if (!gitCreds) {
      sessionLogService.error('git', 'GIT_ROLLBACK_ERROR', `Rollback failed: Repository "${repository}" not found in credentials`);
      throw new Error(`Repository "${repository}" not found in credentials`);
    }

    try {
      // Use workspaceService.pullAtCommit for efficient parallel fetching
      const result = await workspaceService.pullAtCommit(repository, branch, commitSha, gitCreds);
      
      const filesChanged = result.filesUpdated + result.filesCreated;

      // Invalidate cache and refresh navigator
      this.invalidateCommittableFilesCache();
      if (this.navigatorOps) {
        await this.navigatorOps.refreshItems();
      }

      console.log(`✅ RepositoryOperationsService: Rolled back to ${commitSha.substring(0, 7)}, ${filesChanged} files changed`);
      sessionLogService.success('git', 'GIT_ROLLBACK_SUCCESS', 
        `Rolled back to ${commitSha.substring(0, 7)}`,
        `${result.filesUpdated} updated, ${result.filesCreated} created`,
        { repository, branch, commitSha, filesChanged });

      return { success: true, filesChanged };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionLogService.error('git', 'GIT_ROLLBACK_ERROR', `Rollback failed: ${message}`);
      throw error;
    }
  }

  /**
   * Pull latest changes for the repository/branch currently selected in Navigator (app-state),
   * falling back to credentials.defaultGitRepo when no selection exists yet.
   *
   * Used for URL-driven boot flows (e.g. `?graph=...&pullalllatest`) where we want
   * "pull first, then load" without duplicating repo/branch resolution logic in UI code.
   *
   * NOTE:
   * - Returns {skipped:true} when there is no repository context yet (e.g. first boot without creds).
   * - Conflicts are returned but the pull is still considered successful (the workspace is updated).
   */
  async pullLatestForCurrentNavigatorSelection(): Promise<
    | { success: true; repository: string; branch: string; conflicts?: any[] }
    | { success: false; skipped: true; reason: string }
  > {
    const appState = await db.appState.get('app-state');
    const selectedRepo = appState?.navigatorState?.selectedRepo;
    const selectedBranch = appState?.navigatorState?.selectedBranch || 'main';

    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success || !credsResult.credentials) {
      return { success: false, skipped: true, reason: 'No credentials available' };
    }

    const repoToUse = selectedRepo || credsResult.credentials.defaultGitRepo;
    if (!repoToUse) {
      return { success: false, skipped: true, reason: 'No repository selected and no defaultGitRepo configured' };
    }

    const res = await this.pullLatest(repoToUse, selectedBranch);
    return { success: true, repository: repoToUse, branch: selectedBranch, conflicts: res.conflicts };
  }
}

// Export singleton instance
export const repositoryOperationsService = new RepositoryOperationsService();

