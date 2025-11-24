import { db } from '../db/appDatabase';
import { gitService } from './gitService';
import { fileRegistry } from '../contexts/TabContext';
import { WorkspaceState, FileState, ObjectType } from '../types';
import YAML from 'yaml';
import { merge3Way } from './mergeService';

export interface RemoteStatus {
  isAhead: boolean;
  filesChanged: number;
  filesAdded: number;
  filesDeleted: number;
  changedPaths: string[];
}

export interface MergeConflict {
  fileId: string;
  fileName: string;
  path: string;
  type: ObjectType;
  localContent: string;
  remoteContent: string;
  baseContent: string;
  mergedContent: string;
  hasConflicts: boolean;
}

export interface PullResult {
  success: boolean;
  conflicts: MergeConflict[];
  filesUpdated?: number;
  filesDeleted?: number;
}

/**
 * Workspace Service
 * 
 * Manages local workspace cloning and synchronization.
 * Implements the core principle: "Local workspace mirrors remote repo"
 */
class WorkspaceService {
  /**
   * Check if workspace exists for given repo/branch
   */
  async workspaceExists(repository: string, branch: string): Promise<boolean> {
    const workspaceId = `${repository}-${branch}`;
    const workspace = await db.workspaces.get(workspaceId);
    return !!workspace;
  }

  /**
   * Get workspace metadata
   */
  async getWorkspace(repository: string, branch: string): Promise<WorkspaceState | undefined> {
    const workspaceId = `${repository}-${branch}`;
    return await db.workspaces.get(workspaceId);
  }

  /**
   * Check if remote has changes we don't have (is ahead of us)
   * Returns true if pull would fetch new changes
   * 
   * This should be called before commit to warn user to pull first
   */
  async checkRemoteAhead(repository: string, branch: string, gitCreds: any): Promise<RemoteStatus> {
    console.log(`🔍 WorkspaceService: Checking if remote is ahead for ${repository}/${branch}`);

    // Configure git service
    const fullCredentials = {
      version: '1.0.0',
      defaultGitRepo: gitCreds.name,
      git: [gitCreds]
    };
    gitService.setCredentials(fullCredentials);

    try {
      // Get local file SHAs
      const localFiles = await db.files
        .where('source.repository').equals(repository)
        .and(file => file.source?.branch === branch)
        .toArray();

      const localShaMap = new Map<string, string>();
      for (const file of localFiles) {
        if (file.source?.path && file.sha) {
          localShaMap.set(file.source.path, file.sha);
        }
      }

      // Get remote tree
      const treeResult = await gitService.getRepositoryTree(branch, true);
      if (!treeResult.success || !treeResult.data) {
        throw new Error('Failed to fetch remote tree');
      }

      const { tree } = treeResult.data;

      // Filter relevant remote files
      const basePath = gitCreds.basePath || '';
      const directories = [
        { path: gitCreds.graphsPath || 'graphs', type: 'graph' as ObjectType, extension: 'json' },
        { path: gitCreds.paramsPath || 'parameters', type: 'parameter' as ObjectType, extension: 'yaml' },
        { path: gitCreds.contextsPath || 'contexts', type: 'context' as ObjectType, extension: 'yaml' },
        { path: gitCreds.casesPath || 'cases', type: 'case' as ObjectType, extension: 'yaml' },
        { path: gitCreds.nodesPath || 'nodes', type: 'node' as ObjectType, extension: 'yaml' },
        { path: gitCreds.eventsPath || 'events', type: 'event' as ObjectType, extension: 'yaml' }
      ];

      const remoteFiles: any[] = [];
      for (const dir of directories) {
        const fullPath = basePath ? `${basePath}/${dir.path}` : dir.path;
        const matchingFiles = tree.filter((item: any) => {
          if (item.type !== 'blob') return false;
          if (!item.path.startsWith(fullPath + '/')) return false;
          if (!item.path.endsWith(`.${dir.extension}`)) return false;
          const relativePath = item.path.substring((fullPath + '/').length);
          return !relativePath.includes('/');
        });
        remoteFiles.push(...matchingFiles);
      }

      // Add index files
      const indexFiles = [
        { fileName: 'parameters-index.yaml', type: 'parameter' as ObjectType },
        { fileName: 'contexts-index.yaml', type: 'context' as ObjectType },
        { fileName: 'cases-index.yaml', type: 'case' as ObjectType },
        { fileName: 'nodes-index.yaml', type: 'node' as ObjectType },
        { fileName: 'events-index.yaml', type: 'event' as ObjectType }
      ];

      for (const indexFile of indexFiles) {
        const fullPath = basePath ? `${basePath}/${indexFile.fileName}` : indexFile.fileName;
        const indexTreeItem = tree.find((item: any) => item.path === fullPath && item.type === 'blob');
        
        if (indexTreeItem) {
          remoteFiles.push(indexTreeItem);
        }
      }

      // Compare SHAs
      let changed = 0;
      let added = 0;
      let deleted = 0;
      const changedPaths: string[] = [];

      for (const remoteFile of remoteFiles) {
        const localSha = localShaMap.get(remoteFile.path);
        if (!localSha) {
          added++;
          changedPaths.push(remoteFile.path);
        } else if (localSha !== remoteFile.sha) {
          changed++;
          changedPaths.push(remoteFile.path);
        }
        localShaMap.delete(remoteFile.path);
      }

      // Remaining local files were deleted remotely
      deleted = localShaMap.size;
      for (const path of localShaMap.keys()) {
        changedPaths.push(path);
      }

      const isAhead = changed > 0 || added > 0 || deleted > 0;

      console.log(`🔍 Remote status: ahead=${isAhead}, changed=${changed}, added=${added}, deleted=${deleted}`);

      return {
        isAhead,
        filesChanged: changed,
        filesAdded: added,
        filesDeleted: deleted,
        changedPaths
      };
    } catch (error) {
      console.error('❌ WorkspaceService: Failed to check remote status:', error);
      // On error, assume remote might be ahead (safer)
      return {
        isAhead: true,
        filesChanged: 0,
        filesAdded: 0,
        filesDeleted: 0,
        changedPaths: []
      };
    }
  }

  /**
   * Clone entire repository to IndexedDB using Git Tree API (OPTIMIZED)
   * 
   * This is the core operation that creates a local mirror of the remote repo.
   * Called on first init or when switching repos/branches.
   * 
   * NEW: Uses Git Tree API for 10x faster cloning with parallel blob fetching
   */
  async cloneWorkspace(repository: string, branch: string, gitCreds: any): Promise<WorkspaceState> {
    const workspaceId = `${repository}-${branch}`;
    console.log(`🚀 WorkspaceService: Cloning workspace ${workspaceId} (using Tree API)...`);

    // Create workspace record
    const workspace: WorkspaceState = {
      id: workspaceId,
      repository,
      branch,
      lastSynced: Date.now(),
      fileIds: [],
      isCloning: true
    };
    
    await db.workspaces.put(workspace);

    try {
      // Configure git service with full credentials
      const fullCredentials = {
        version: '1.0.0',
        defaultGitRepo: gitCreds.name,
        git: [gitCreds]
      };
      gitService.setCredentials(fullCredentials);

      const startTime = Date.now();

      // STEP 1: Get entire repository tree in ONE API call
      console.log(`📦 WorkspaceService: Fetching repository tree...`);
      const treeResult = await gitService.getRepositoryTree(branch, true);
      if (!treeResult.success || !treeResult.data) {
        throw new Error('Failed to fetch repository tree');
      }

      const { tree, commitSha } = treeResult.data;
      console.log(`📦 WorkspaceService: Got ${tree.length} items from tree, commit: ${commitSha.substring(0, 8)}`);

      // STEP 2: Filter relevant files based on basePath and directory paths
      const basePath = gitCreds.basePath || '';
      const directories = [
        { path: gitCreds.graphsPath || 'graphs', type: 'graph' as ObjectType, extension: 'json' },
        { path: gitCreds.paramsPath || 'parameters', type: 'parameter' as ObjectType, extension: 'yaml' },
        { path: gitCreds.contextsPath || 'contexts', type: 'context' as ObjectType, extension: 'yaml' },
        { path: gitCreds.casesPath || 'cases', type: 'case' as ObjectType, extension: 'yaml' },
        { path: gitCreds.nodesPath || 'nodes', type: 'node' as ObjectType, extension: 'yaml' },
        { path: gitCreds.eventsPath || 'events', type: 'event' as ObjectType, extension: 'yaml' }
      ];

      // Build list of files to fetch
      const filesToFetch: Array<{ treeItem: any; dirConfig: any }> = [];

      for (const dir of directories) {
        const fullPath = basePath ? `${basePath}/${dir.path}` : dir.path;
        console.log(`📂 WorkspaceService: Filtering files in ${fullPath}/...`);

        // Find files in this directory from the tree
        const matchingFiles = tree.filter((item: any) => {
          if (item.type !== 'blob') return false; // Only files, not directories
          if (!item.path.startsWith(fullPath + '/')) return false; // Must be in this directory
          if (!item.path.endsWith(`.${dir.extension}`)) return false; // Must have correct extension
          // Ensure it's directly in the directory, not in a subdirectory
          const relativePath = item.path.substring((fullPath + '/').length);
          return !relativePath.includes('/'); // No subdirectories
        });

        console.log(`📂 WorkspaceService: Found ${matchingFiles.length} ${dir.type} files in ${fullPath}/`);
        
        for (const file of matchingFiles) {
          filesToFetch.push({ treeItem: file, dirConfig: dir });
        }
      }

      // Add index files to fetch list
      const indexFiles = [
        { fileName: 'parameters-index.yaml', type: 'parameter' as ObjectType },
        { fileName: 'contexts-index.yaml', type: 'context' as ObjectType },
        { fileName: 'cases-index.yaml', type: 'case' as ObjectType },
        { fileName: 'nodes-index.yaml', type: 'node' as ObjectType },
        { fileName: 'events-index.yaml', type: 'event' as ObjectType }
      ];

      for (const indexFile of indexFiles) {
        const fullPath = basePath ? `${basePath}/${indexFile.fileName}` : indexFile.fileName;
        const indexTreeItem = tree.find((item: any) => item.path === fullPath && item.type === 'blob');
        
        if (indexTreeItem) {
          console.log(`📋 WorkspaceService: Found index file ${fullPath}`);
          filesToFetch.push({ 
            treeItem: indexTreeItem, 
            dirConfig: { type: indexFile.type, extension: 'yaml', isIndex: true } 
          });
        } else {
          console.log(`📋 WorkspaceService: Index file ${fullPath} not found (normal for new repos)`);
        }
      }

      console.log(`📦 WorkspaceService: Fetching ${filesToFetch.length} files in parallel...`);

      // STEP 3: Fetch all file contents in parallel (HUGE PERF WIN!)
      const fetchPromises = filesToFetch.map(async ({ treeItem, dirConfig }) => {
        try {
          const blobResult = await gitService.getBlobContent(treeItem.sha);
          if (!blobResult.success || !blobResult.data) {
            console.warn(`⚠️ WorkspaceService: Failed to fetch blob ${treeItem.sha} for ${treeItem.path}`);
            return null;
          }

          const contentStr = blobResult.data.content;

            // Parse content
            let data: any;
          if (dirConfig.type === 'graph') {
              data = JSON.parse(contentStr);
            } else {
              data = YAML.parse(contentStr);
            }

            // Create FileState
          const fileName = treeItem.path.split('/').pop() || ''; // Get filename from path
          const fileNameWithoutExt = fileName.replace(/\.(yaml|yml|json)$/, '');
          
          // Validate filename extraction
          if (!fileName || !fileNameWithoutExt) {
            console.error(`❌ WorkspaceService: Invalid path ${treeItem.path} - filename extraction failed`);
            return null;
          }
          
          const fileId = dirConfig.isIndex 
            ? `${dirConfig.type}-index`
            : `${dirConfig.type}-${fileNameWithoutExt}`;

            // Get file modification time from metadata (standardized across all file types)
            let fileModTime = Date.now();
            if (data?.metadata) {
              // All file types now use metadata.updated_at / metadata.created_at
              if (data.metadata.updated_at) {
                fileModTime = new Date(data.metadata.updated_at).getTime();
              } else if (data.metadata.created_at) {
                fileModTime = new Date(data.metadata.created_at).getTime();
              }
            }
            
            const fileState: FileState = {
              fileId,
            type: dirConfig.type,
            name: fileName,
            path: treeItem.path,
              data,
              originalData: structuredClone(data),
              isDirty: false,
              source: {
                repository,
              path: treeItem.path,
                branch,
              commitHash: treeItem.sha
              },
              isLoaded: true,
              isLocal: false,
              viewTabs: [],
              lastModified: fileModTime,
            sha: treeItem.sha,
              lastSynced: Date.now()
            };

          // Save to IndexedDB with workspace-prefixed fileId to prevent collisions
          const idbFileId = `${repository}-${branch}-${fileId}`;
          const idbFileState = { ...fileState, fileId: idbFileId };
          await db.files.put(idbFileState);
          
          // Add to FileRegistry memory cache
          console.log(`📝 WorkspaceService: Adding ${fileId} to FileRegistry...`);
          (fileRegistry as any).files.set(fileId, fileState);
          const verifyAdded = (fileRegistry as any).files.get(fileId);
          console.log(`📝 WorkspaceService: Verified in FileRegistry:`, !!verifyAdded);
          
          console.log(`✅ WorkspaceService: Cloned ${treeItem.path} (${treeItem.sha.substring(0, 8)})`);
          
          return fileId;
        } catch (error) {
          console.error(`❌ WorkspaceService: Failed to clone ${treeItem.path}:`, error);
          return null;
        }
      });

      // Wait for all fetches to complete
      const results = await Promise.all(fetchPromises);
      const fileIds = results.filter((id): id is string => id !== null);

      const elapsed = Date.now() - startTime;
      const registryCount = (fileRegistry as any).files.size;
      console.log(`⚡ WorkspaceService: Clone complete in ${elapsed}ms! ${fileIds.length} files loaded`);
      console.log(`📊 WorkspaceService: FileRegistry now has ${registryCount} files in memory`);

      // STEP 4: Fetch and store images
      console.log(`🖼️ WorkspaceService: Fetching images...`);
      const images = await this.fetchAllImagesFromGit(repository, branch, gitCreds);
      
      for (const image of images) {
        const imageId = image.name.replace(/\.(png|jpg|jpeg)$/i, '');
        const ext = image.name.match(/\.(png|jpg|jpeg)$/i)?.[1].toLowerCase() as 'png' | 'jpg' | 'jpeg';
        
        const imageFileState: FileState = {
          fileId: `image-${imageId}`,
          type: 'image' as any,
          name: image.name,
          path: `nodes/images/${image.name}`,
          data: {
            image_id: imageId,
            file_extension: ext,
            binaryData: image.binaryData
          },
          originalData: null,
          isDirty: false,
          source: {
            repository,
            path: `nodes/images/${image.name}`,
            branch,
            commitHash: commitSha
          },
          isLoaded: true,
          isLocal: false,
          viewTabs: [],
          lastModified: Date.now(),
          lastSynced: Date.now()
        };
        
        // Save to IDB with workspace prefix
        const idbFileId = `${repository}-${branch}-${imageFileState.fileId}`;
        await db.files.put({ ...imageFileState, fileId: idbFileId });
        
        // Also add to FileRegistry memory cache
        (fileRegistry as any).files.set(imageFileState.fileId, imageFileState);
      }
      
      console.log(`✅ WorkspaceService: Stored ${images.length} images in IDB`);

      // Update workspace record
      workspace.fileIds = fileIds;
      workspace.isCloning = false;
      workspace.lastSynced = Date.now();
      delete workspace.cloneError;
      
      await db.workspaces.put(workspace);

      return workspace;

    } catch (error) {
      console.error(`❌ WorkspaceService: Clone failed:`, error);
      
      // Update workspace with error
      workspace.isCloning = false;
      workspace.cloneError = error instanceof Error ? error.message : 'Unknown error';
      await db.workspaces.put(workspace);
      
      throw error;
    }
  }

  /**
   * Load workspace from IndexedDB into FileRegistry
   * 
   * Called when workspace already exists - loads all files into memory.
   */
  async loadWorkspaceFromIDB(repository: string, branch: string): Promise<WorkspaceState> {
    const workspaceId = `${repository}-${branch}`;
    console.log(`📦 WorkspaceService: Loading workspace ${workspaceId} from IndexedDB...`);

    const workspace = await db.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found in IndexedDB`);
    }

    // Load all files into FileRegistry memory cache
    const files = await db.files
      .where('source.repository').equals(repository)
      .and(file => file.source?.branch === branch)
      .toArray();

    console.log(`📦 WorkspaceService: Loaded ${files.length} files from IndexedDB`);

    // Load all files into FileRegistry memory
    // Group by actualFileId to handle duplicates (keep most recent)
    const fileMap = new Map<string, typeof files[0]>();
    
    for (const file of files) {
      // Strip workspace prefix from fileId (format: "repo-branch-actualFileId")
      const prefix = `${repository}-${branch}-`;
      const actualFileId = file.fileId.startsWith(prefix) 
        ? file.fileId.substring(prefix.length)
        : file.fileId;
      
      // If we already have this fileId, keep the one with the most recent timestamp
      const existing = fileMap.get(actualFileId);
      if (existing) {
        // Compare timestamps - prefer updated_at, then lastModified
        const existingTime = existing.data?.updated_at || existing.lastModified || 0;
        const currentTime = file.data?.updated_at || file.lastModified || 0;
        
        if (currentTime > existingTime) {
          console.log(`📦 loadWorkspaceFromIDB: Replacing older ${actualFileId} (${new Date(existingTime).toISOString()}) with newer version (${new Date(currentTime).toISOString()})`);
          fileMap.set(actualFileId, file);
        } else {
          console.log(`📦 loadWorkspaceFromIDB: Skipping older duplicate ${actualFileId} (${new Date(currentTime).toISOString()} vs ${new Date(existingTime).toISOString()})`);
        }
      } else {
        fileMap.set(actualFileId, file);
      }
    }
    
    // Now load the deduplicated files into FileRegistry
    for (const file of fileMap.values()) {
      const prefix = `${repository}-${branch}-`;
      const actualFileId = file.fileId.startsWith(prefix) 
        ? file.fileId.substring(prefix.length)
        : file.fileId;
      
      // Create clean FileState with original fileId for FileRegistry
      const cleanFileState = { ...file, fileId: actualFileId };
      
      console.log(`📦 loadWorkspaceFromIDB: Loaded file ${actualFileId}`, {
        lastModified: cleanFileState.lastModified,
        'data.metadata.updated': cleanFileState.data?.metadata?.updated,
        'data.updated_at': cleanFileState.data?.updated_at
      });
      
      // Use the internal map directly since files are already in IDB
      (fileRegistry as any).files.set(actualFileId, cleanFileState);
      console.log(`📦 WorkspaceService: Loaded ${actualFileId} into FileRegistry`);
    }

    return workspace;
  }

  /**
   * Pull latest changes from remote and sync with IDB (OPTIMIZED with SHA diff)
   * 
   * Similar to git pull - fetches changes and updates local workspace.
   * 
   * NEW: Uses SHA comparison to only fetch changed files (5x faster than re-clone)
   * Returns conflicts if 3-way merge fails for any files with local changes
   */
  async pullLatest(repository: string, branch: string, gitCreds: any): Promise<PullResult> {
    const workspaceId = `${repository}-${branch}`;
    console.log(`🔄 WorkspaceService: Pulling latest for ${workspaceId} (smart diff)...`);

    const workspace = await db.workspaces.get(workspaceId);
    if (!workspace) {
      console.log(`⚠️ WorkspaceService: Workspace doesn't exist, cloning instead...`);
      await this.cloneWorkspace(repository, branch, gitCreds);
      return { success: true, conflicts: [] };
    }

    // Configure git service with full credentials
    const fullCredentials = {
      version: '1.0.0',
      defaultGitRepo: gitCreds.name,
      git: [gitCreds]
    };
    gitService.setCredentials(fullCredentials);

    const startTime = Date.now();
    
    try {
      // STEP 1: Get current local file SHAs
      const localFiles = await db.files
      .where('source.repository').equals(repository)
        .and(file => file.source?.branch === branch)
      .toArray();

      const localShaMap = new Map<string, string>(); // path -> SHA
      const localFileMap = new Map<string, FileState>(); // path -> FileState
      
      for (const file of localFiles) {
        if (file.source?.path && file.sha) {
          localShaMap.set(file.source.path, file.sha);
          localFileMap.set(file.source.path, file);
        }
      }

      console.log(`🔄 WorkspaceService: Local workspace has ${localFiles.length} files`);

      // STEP 2: Get remote repository tree
      const treeResult = await gitService.getRepositoryTree(branch, true);
      if (!treeResult.success || !treeResult.data) {
        throw new Error('Failed to fetch repository tree');
      }

      const { tree, commitSha } = treeResult.data;
      console.log(`🔄 WorkspaceService: Remote tree has ${tree.length} items, commit: ${commitSha.substring(0, 8)}`);

      // STEP 3: Filter relevant remote files
      const basePath = gitCreds.basePath || '';
      const directories = [
        { path: gitCreds.graphsPath || 'graphs', type: 'graph' as ObjectType, extension: 'json' },
        { path: gitCreds.paramsPath || 'parameters', type: 'parameter' as ObjectType, extension: 'yaml' },
        { path: gitCreds.contextsPath || 'contexts', type: 'context' as ObjectType, extension: 'yaml' },
        { path: gitCreds.casesPath || 'cases', type: 'case' as ObjectType, extension: 'yaml' },
        { path: gitCreds.nodesPath || 'nodes', type: 'node' as ObjectType, extension: 'yaml' },
        { path: gitCreds.eventsPath || 'events', type: 'event' as ObjectType, extension: 'yaml' }
      ];

      const remoteFileMap = new Map<string, any>(); // path -> treeItem

      for (const dir of directories) {
        const fullPath = basePath ? `${basePath}/${dir.path}` : dir.path;
        
        const matchingFiles = tree.filter((item: any) => {
          if (item.type !== 'blob') return false;
          if (!item.path.startsWith(fullPath + '/')) return false;
          if (!item.path.endsWith(`.${dir.extension}`)) return false;
          const relativePath = item.path.substring((fullPath + '/').length);
          return !relativePath.includes('/');
        });

        for (const file of matchingFiles) {
          remoteFileMap.set(file.path, { treeItem: file, dirConfig: dir });
        }
      }

      // Add index files
      const indexFiles = [
        { fileName: 'parameters-index.yaml', type: 'parameter' as ObjectType },
        { fileName: 'contexts-index.yaml', type: 'context' as ObjectType },
        { fileName: 'cases-index.yaml', type: 'case' as ObjectType },
        { fileName: 'nodes-index.yaml', type: 'node' as ObjectType },
        { fileName: 'events-index.yaml', type: 'event' as ObjectType }
      ];

      for (const indexFile of indexFiles) {
        const fullPath = basePath ? `${basePath}/${indexFile.fileName}` : indexFile.fileName;
        const indexTreeItem = tree.find((item: any) => item.path === fullPath && item.type === 'blob');
        
        if (indexTreeItem) {
          remoteFileMap.set(fullPath, {
            treeItem: indexTreeItem,
            dirConfig: { type: indexFile.type, extension: 'yaml', isIndex: true }
          });
        }
      }

      console.log(`🔄 WorkspaceService: Remote has ${remoteFileMap.size} relevant files`);

      // STEP 4: Compare SHAs and determine what changed
      const toFetch: Array<{ treeItem: any; dirConfig: any }> = [];
      const toDelete: string[] = [];
      const unchanged: string[] = [];

      // Check each remote file
      for (const [remotePath, { treeItem, dirConfig }] of remoteFileMap.entries()) {
        const localSha = localShaMap.get(remotePath);
        
        if (!localSha) {
          // New file
          console.log(`📄 WorkspaceService: NEW file: ${remotePath}`);
          toFetch.push({ treeItem, dirConfig });
        } else if (localSha !== treeItem.sha) {
          // Changed file
          console.log(`📝 WorkspaceService: CHANGED file: ${remotePath} (${localSha.substring(0, 8)} -> ${treeItem.sha.substring(0, 8)})`);
          toFetch.push({ treeItem, dirConfig });
        } else {
          // Unchanged file
          unchanged.push(remotePath);
        }
        
        // Mark as seen (remove from local map)
        localShaMap.delete(remotePath);
      }

      // Any remaining local files were deleted remotely
      for (const [localPath, localSha] of localShaMap.entries()) {
        console.log(`🗑️ WorkspaceService: DELETED file: ${localPath}`);
        toDelete.push(localPath);
      }

      console.log(`🔄 WorkspaceService: Changes detected:`);
      console.log(`   📄 New/Changed: ${toFetch.length}`);
      console.log(`   🗑️ Deleted: ${toDelete.length}`);
      console.log(`   ✓ Unchanged: ${unchanged.length}`);

      // STEP 5: If no changes, we're done!
      if (toFetch.length === 0 && toDelete.length === 0) {
        const elapsed = Date.now() - startTime;
        console.log(`⚡ WorkspaceService: Pull complete in ${elapsed}ms - no changes!`);
        workspace.lastSynced = Date.now();
        await db.workspaces.put(workspace);
        return { success: true, conflicts: [], filesUpdated: 0, filesDeleted: 0 };
      }

      // STEP 6: Fetch changed files and perform 3-way merge if needed
      const conflicts: MergeConflict[] = [];
      let updatedCount = 0;
      
      if (toFetch.length > 0) {
        console.log(`📦 WorkspaceService: Fetching ${toFetch.length} changed files in parallel...`);
        
        const fetchPromises = toFetch.map(async ({ treeItem, dirConfig }) => {
          try {
            const blobResult = await gitService.getBlobContent(treeItem.sha);
            if (!blobResult.success || !blobResult.data) {
              console.warn(`⚠️ WorkspaceService: Failed to fetch blob ${treeItem.sha} for ${treeItem.path}`);
              return;
            }

            const contentStr = blobResult.data.content;
            
            // Parse content
            let data: any;
            if (dirConfig.type === 'graph') {
              data = JSON.parse(contentStr);
            } else {
              data = YAML.parse(contentStr);
            }

            // Create FileState identifiers
            const fileName = treeItem.path.split('/').pop() || '';
            const fileNameWithoutExt = fileName.replace(/\.(yaml|yml|json)$/, '');
            
            // Validate filename extraction
            if (!fileName || !fileNameWithoutExt) {
              console.error(`❌ WorkspaceService: Invalid path ${treeItem.path} - filename extraction failed`);
              return null;
            }
            
            const fileId = dirConfig.isIndex 
              ? `${dirConfig.type}-index`
              : `${dirConfig.type}-${fileNameWithoutExt}`;

            // Check if local file exists and is dirty
            const localFileState = localFileMap.get(treeItem.path);
            
            if (localFileState && localFileState.isDirty) {
              // Local changes exist - perform 3-way merge
              console.log(`🔀 WorkspaceService: 3-way merge needed for ${treeItem.path} (local changes detected)`);
              
              // Convert to strings for merge
              const remoteContent = contentStr;
              const baseContent = localFileState.originalData 
                ? (dirConfig.type === 'graph' 
                    ? JSON.stringify(localFileState.originalData, null, 2)
                    : YAML.stringify(localFileState.originalData))
                : '';
              const localContent = localFileState.data
                ? (dirConfig.type === 'graph'
                    ? JSON.stringify(localFileState.data, null, 2)
                    : YAML.stringify(localFileState.data))
                : '';

              // Perform 3-way merge
              const mergeResult = merge3Way(baseContent, localContent, remoteContent);

              if (mergeResult.hasConflicts) {
                // Conflict detected - preserve local and notify user
                console.warn(`⚠️ WorkspaceService: CONFLICT detected for ${treeItem.path}`);
                conflicts.push({
                  fileId,
                  fileName,
                  path: treeItem.path,
                  type: dirConfig.type,
                  localContent,
                  remoteContent,
                  baseContent,
                  mergedContent: mergeResult.merged || '',
                  hasConflicts: true
                });
                
                // Keep local version in IndexedDB for now, user will resolve via modal
                return;
              } else {
                // Auto-merge successful
                console.log(`✅ WorkspaceService: Auto-merged ${treeItem.path}`);
                
                // Parse merged content back to object
                const mergedContent = mergeResult.merged || remoteContent;
                const mergedData = dirConfig.type === 'graph'
                  ? JSON.parse(mergedContent)
                  : YAML.parse(mergedContent);

                // Update file state with merged content
                localFileState.data = mergedData;
                localFileState.originalData = structuredClone(mergedData);
                localFileState.isDirty = false;
                localFileState.sha = treeItem.sha;
                localFileState.lastSynced = Date.now();
                localFileState.source = {
                  repository,
                  path: treeItem.path,
                  branch,
                  commitHash: treeItem.sha
                };

                await db.files.put(localFileState);
                
                // Update in FileRegistry if loaded
                if (fileRegistry.getFile(fileId)) {
                  (fileRegistry as any).files.set(fileId, localFileState);
                  (fileRegistry as any).notifyListeners(fileId, localFileState);
                }
                
                updatedCount++;
              }
            } else {
              // No local changes - safe to update
              const fileState: FileState = {
                fileId,
                type: dirConfig.type,
                name: fileName,
                path: treeItem.path,
                data,
                originalData: structuredClone(data),
                isDirty: false,
                source: {
                  repository,
                  path: treeItem.path,
                  branch,
                  commitHash: treeItem.sha
                },
                isLoaded: true,
                isLocal: false,
                viewTabs: localFileState?.viewTabs || [],
                lastModified: Date.now(),
                sha: treeItem.sha,
                lastSynced: Date.now()
              };

              await db.files.put(fileState);
              
              // Update in FileRegistry if loaded
              if (fileRegistry.getFile(fileId)) {
                (fileRegistry as any).files.set(fileId, fileState);
                (fileRegistry as any).notifyListeners(fileId, fileState);
              }
              
              console.log(`✅ WorkspaceService: Updated ${treeItem.path}`);
              updatedCount++;
            }
          } catch (error) {
            console.error(`❌ WorkspaceService: Failed to update ${treeItem.path}:`, error);
          }
        });

        await Promise.all(fetchPromises);
      }

      // STEP 7: Delete removed files
      if (toDelete.length > 0) {
        console.log(`🗑️ WorkspaceService: Deleting ${toDelete.length} removed files...`);
        
        for (const path of toDelete) {
          const file = localFileMap.get(path);
          if (file) {
      await db.files.delete(file.fileId);
            
            // Remove from FileRegistry if loaded
            (fileRegistry as any).files.delete(file.fileId);
            (fileRegistry as any).listeners.delete(file.fileId);
            
            console.log(`🗑️ WorkspaceService: Deleted ${path}`);
          }
        }
      }

      // STEP 8: Fetch and store images
      console.log(`🖼️ WorkspaceService: Fetching images...`);
      const images = await this.fetchAllImagesFromGit(repository, branch, gitCreds);
      
      for (const image of images) {
        const imageId = image.name.replace(/\.(png|jpg|jpeg)$/i, '');
        const ext = image.name.match(/\.(png|jpg|jpeg)$/i)?.[1].toLowerCase() as 'png' | 'jpg' | 'jpeg';
        
        const imageFileState: FileState = {
          fileId: `image-${imageId}`,
          type: 'image' as any,
          name: image.name,
          path: `nodes/images/${image.name}`,
          data: {
            image_id: imageId,
            file_extension: ext,
            binaryData: image.binaryData
          },
          originalData: null,
          isDirty: false,
          source: {
            repository,
            path: `nodes/images/${image.name}`,
            branch,
            commitHash: commitSha
          },
          isLoaded: true,
          isLocal: false,
          viewTabs: [],
          lastModified: Date.now(),
          lastSynced: Date.now()
        };
        
        await db.files.put(imageFileState);
      }
      
      console.log(`✅ WorkspaceService: Stored ${images.length} images in IDB`);

      // STEP 9: Update workspace metadata
      const updatedFiles = await db.files
        .where('source.repository').equals(repository)
        .and(file => file.source?.branch === branch)
        .toArray();

      workspace.fileIds = updatedFiles.map(f => f.fileId);
      workspace.lastSynced = Date.now();
      await db.workspaces.put(workspace);

      const elapsed = Date.now() - startTime;
      
      if (conflicts.length > 0) {
        console.log(`⚠️ WorkspaceService: Pull complete in ${elapsed}ms with ${conflicts.length} conflicts! Updated ${updatedCount}, deleted ${toDelete.length}`);
        return { success: true, conflicts, filesUpdated: updatedCount, filesDeleted: toDelete.length };
      }
      
      console.log(`⚡ WorkspaceService: Pull complete in ${elapsed}ms! Updated ${updatedCount}, deleted ${toDelete.length}`);
      return { success: true, conflicts: [], filesUpdated: updatedCount, filesDeleted: toDelete.length };

    } catch (error) {
      console.error(`❌ WorkspaceService: Pull failed, falling back to full re-clone:`, error);
      
      // Fallback: Delete and re-clone
      await this.deleteWorkspace(repository, branch);
      await this.cloneWorkspace(repository, branch, gitCreds);
      
      return { success: true, conflicts: [] };
    }
  }

  /**
   * Delete workspace and all its files
   */
  async deleteWorkspace(repository: string, branch: string): Promise<void> {
    const workspaceId = `${repository}-${branch}`;
    console.log(`🗑️ WorkspaceService: Deleting workspace ${workspaceId}...`);

    const workspace = await db.workspaces.get(workspaceId);
    if (!workspace) {
      console.log(`⚠️ WorkspaceService: Workspace ${workspaceId} doesn't exist`);
      return;
    }

    // Delete all files in this workspace
    const files = await db.files
      .where('source.repository').equals(repository)
      .and(file => file.source?.branch === branch)
      .toArray();

    for (const file of files) {
      await db.files.delete(file.fileId);
      
      // Strip workspace prefix from fileId for FileRegistry operations
      const prefix = `${repository}-${branch}-`;
      const actualFileId = file.fileId.startsWith(prefix) 
        ? file.fileId.substring(prefix.length)
        : file.fileId;
      
      // Remove from FileRegistry memory cache (force delete, bypass dirty/open checks)
      // We're deleting the entire workspace so we don't care about dirty state
      (fileRegistry as any).files.delete(actualFileId);
      (fileRegistry as any).listeners.delete(actualFileId);
    }

    // Delete workspace record
    await db.workspaces.delete(workspaceId);
    
    console.log(`✅ WorkspaceService: Deleted workspace ${workspaceId} and ${files.length} files`);
  }

  /**
   * Get all files in a workspace (from IDB)
   */
  async getWorkspaceFiles(repository: string, branch: string): Promise<FileState[]> {
    const files = await db.files
      .where('source.repository').equals(repository)
      .and(file => file.source?.branch === branch)
      .toArray();
    
    // Strip workspace prefix from fileIds
    const prefix = `${repository}-${branch}-`;
    return files.map(file => {
      const actualFileId = file.fileId.startsWith(prefix) 
        ? file.fileId.substring(prefix.length)
        : file.fileId;
      return { ...file, fileId: actualFileId };
    });
  }
  
  /**
   * Fetch all images from Git repository nodes/images/ directory
   * Used during clone and pull operations
   */
  async fetchAllImagesFromGit(
    repository: string,
    branch: string,
    gitCreds: any
  ): Promise<Array<{ name: string; binaryData: Uint8Array }>> {
    try {
      const basePath = gitCreds.basePath || '';
      const imagesPath = basePath ? `${basePath}/nodes/images` : 'nodes/images';
      
      // List all files in nodes/images/
      const response = await gitService.getDirectoryContents(imagesPath, branch);
      
      if (!response.success || !response.data) {
        console.log(`WorkspaceService: No images directory found at ${imagesPath}`);
        return [];
      }
      
      const files = response.data.filter((item: any) =>
        item.type === 'file' && /\.(png|jpg|jpeg)$/i.test(item.name)
      );
      
      console.log(`WorkspaceService: Found ${files.length} images to fetch`);
      
      // Fetch each image
      const results = await Promise.all(
        files.map(async (file: any) => {
          try {
            const fileResponse = await fetch(file.download_url);
            if (!fileResponse.ok) {
              throw new Error(`Failed to fetch ${file.name}`);
            }
            const arrayBuffer = await fileResponse.arrayBuffer();
            return {
              name: file.name,
              binaryData: new Uint8Array(arrayBuffer)
            };
          } catch (error) {
            console.error(`Failed to fetch image ${file.name}:`, error);
            return null;
          }
        })
      );
      
      return results.filter((r): r is { name: string; binaryData: Uint8Array } => r !== null);
    } catch (error) {
      console.error('Failed to fetch images from Git:', error);
      return [];
    }
  }
  
  /**
   * Get all node files from IDB for current workspace
   */
  async getAllNodeFilesFromIDB(): Promise<Array<{ fileId: string; data: any }>> {
    const files = await db.files
      .where('type')
      .equals('node')
      .toArray();
    
    return files.map(f => ({ fileId: f.fileId, data: f.data }));
  }
  
  /**
   * Get all graph files from IDB for current workspace
   */
  async getAllGraphFilesFromIDB(): Promise<Array<{ fileId: string; data: any }>> {
    const files = await db.files
      .where('type')
      .equals('graph')
      .toArray();
    
    return files.map(f => ({ fileId: f.fileId, data: f.data }));
  }
  
  /**
   * Get all image IDs from IDB
   * Used for ensuring image ID uniqueness on upload
   */
  async getAllImageIdsFromIDB(): Promise<string[]> {
    const imageFiles = await db.files
      .where('type')
      .equals('image')
      .toArray();
    
    return imageFiles
      .map(f => f.data?.image_id)
      .filter((id): id is string => typeof id === 'string');
  }
}

export const workspaceService = new WorkspaceService();

