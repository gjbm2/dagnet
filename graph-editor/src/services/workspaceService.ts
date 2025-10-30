import { db } from '../db/appDatabase';
import { gitService } from './gitService';
import { fileRegistry } from '../contexts/TabContext';
import { WorkspaceState, FileState, ObjectType } from '../types';
import YAML from 'yaml';

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
   * Clone entire repository to IndexedDB
   * 
   * This is the core operation that creates a local mirror of the remote repo.
   * Called on first init or when switching repos/branches.
   */
  async cloneWorkspace(repository: string, branch: string, gitCreds: any): Promise<WorkspaceState> {
    const workspaceId = `${repository}-${branch}`;
    console.log(`🔄 WorkspaceService: Cloning workspace ${workspaceId}...`);

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

      const fileIds: string[] = [];

      // Clone each directory using paths from credentials (prepend basePath if it exists)
      const basePath = gitCreds.basePath || '';
      const directories = [
        { path: gitCreds.graphsPath || 'graphs', type: 'graph' as ObjectType, extension: 'json' },
        { path: gitCreds.paramsPath || 'parameters', type: 'parameter' as ObjectType, extension: 'yaml' },
        { path: gitCreds.contextsPath || 'contexts', type: 'context' as ObjectType, extension: 'yaml' },
        { path: gitCreds.casesPath || 'cases', type: 'case' as ObjectType, extension: 'yaml' },
        { path: gitCreds.nodesPath || 'nodes', type: 'node' as ObjectType, extension: 'yaml' }
      ];

      for (const dir of directories) {
        const fullPath = basePath ? `${basePath}/${dir.path}` : dir.path;
        console.log(`📂 WorkspaceService: Cloning ${fullPath}/...`);
        
        const result = await gitService.getDirectoryContents(fullPath);
        if (!result.success || !result.data) {
          console.log(`📂 WorkspaceService: Directory ${dir.path} not found (skipping)`);
          continue;
        }

        const files = result.data.filter((item: any) => 
          item.type === 'file' && item.name.endsWith(`.${dir.extension}`)
        );

        console.log(`📂 WorkspaceService: Found ${files.length} files in ${dir.path}/`);

        // Load each file and create FileState
        for (const file of files) {
          try {
            const fileContent = await gitService.getFileContent(file.path);
            if (!fileContent.success || !fileContent.data) {
              console.warn(`⚠️ WorkspaceService: Failed to load ${file.path}`);
              continue;
            }

            // Parse content
            let data: any;
            const contentStr = fileContent.data.content; // getFileContent returns { data: { content: string } }
            if (dir.type === 'graph') {
              data = JSON.parse(contentStr);
            } else {
              data = YAML.parse(contentStr);
            }

            // Create FileState
            // Strip extension from fileId - IDs should not have extensions
            const fileName = file.name.replace(/\.(yaml|yml|json)$/, '');
            const fileId = `${dir.type}-${fileName}`;
            const fileSha = fileContent.data.sha || file.sha; // Use SHA from file content response
            const fileState: FileState = {
              fileId,
              type: dir.type,
              name: file.name,
              path: file.path,
              data,
              originalData: structuredClone(data),
              isDirty: false,
              source: {
                repository,
                path: file.path,
                branch,
                commitHash: fileSha
              },
              isLoaded: true,
              isLocal: false,
              viewTabs: [],
              lastModified: Date.now(),
              sha: fileSha,
              lastSynced: Date.now()
            };

            // Save to IndexedDB
            await db.files.put(fileState);
            fileIds.push(fileId);

            console.log(`✅ WorkspaceService: Cloned ${file.path}`);
          } catch (error) {
            console.error(`❌ WorkspaceService: Failed to clone ${file.path}:`, error);
          }
        }
      }

      // Load index files (if they exist) - prepend basePath
      const indexFiles = [
        { path: 'parameters-index.yaml', type: 'parameter' as ObjectType },
        { path: 'contexts-index.yaml', type: 'context' as ObjectType },
        { path: 'cases-index.yaml', type: 'case' as ObjectType },
        { path: 'nodes-index.yaml', type: 'node' as ObjectType }
      ];

      for (const indexFile of indexFiles) {
        try {
          const fullPath = basePath ? `${basePath}/${indexFile.path}` : indexFile.path;
          console.log(`📋 WorkspaceService: Loading index file ${fullPath}...`);
          const fileContent = await gitService.getFileContent(fullPath);
          
          if (fileContent.success && fileContent.data) {
            const contentStr = fileContent.data.content; // getFileContent returns { data: { content: string } }
            const data = YAML.parse(contentStr);
            const fileId = `${indexFile.type}-index`;
            const fileSha = fileContent.data.sha; // SHA from file content response
            
            const fileState: FileState = {
              fileId,
              type: indexFile.type,
              name: indexFile.path,
              path: fullPath,  // Use full path including basePath
              data,
              originalData: structuredClone(data),
              isDirty: false,
              source: {
                repository,
                path: fullPath,  // Use full path including basePath
                branch,
                commitHash: fileSha
              },
              isLoaded: true,
              isLocal: false,
              viewTabs: [],
              lastModified: Date.now(),
              sha: fileSha,
              lastSynced: Date.now()
            };

            await db.files.put(fileState);
            fileIds.push(fileId);
            
            console.log(`✅ WorkspaceService: Cloned index ${indexFile.path}`);
          } else {
            console.log(`📋 WorkspaceService: Index file ${indexFile.path} not found (normal for new repos)`);
          }
        } catch (error) {
          console.log(`📋 WorkspaceService: Index file ${indexFile.path} not available:`, error);
        }
      }

      // Update workspace record
      workspace.fileIds = fileIds;
      workspace.isCloning = false;
      workspace.lastSynced = Date.now();
      delete workspace.cloneError;
      
      await db.workspaces.put(workspace);

      console.log(`✅ WorkspaceService: Clone complete! ${fileIds.length} files loaded`);
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
    for (const file of files) {
      // Use the internal map directly since files are already in IDB
      (fileRegistry as any).files.set(file.fileId, file);
      console.log(`📦 WorkspaceService: Loaded ${file.fileId} into FileRegistry`);
    }

    return workspace;
  }

  /**
   * Pull latest changes from remote and sync with IDB
   * 
   * Similar to git pull - fetches changes and updates local workspace.
   */
  async pullLatest(repository: string, branch: string, gitCreds: any): Promise<void> {
    const workspaceId = `${repository}-${branch}`;
    console.log(`🔄 WorkspaceService: Pulling latest for ${workspaceId}...`);

    const workspace = await db.workspaces.get(workspaceId);
    if (!workspace) {
      console.log(`⚠️ WorkspaceService: Workspace doesn't exist, cloning instead...`);
      await this.cloneWorkspace(repository, branch, gitCreds);
      return;
    }

    // Configure git service with full credentials
    const fullCredentials = {
      version: '1.0.0',
      defaultGitRepo: gitCreds.name,
      git: [gitCreds]
    };
    gitService.setCredentials(fullCredentials);

    // For now, simple approach: re-clone everything
    // TODO: Implement smart diff-based sync using commit SHAs
    console.log(`🔄 WorkspaceService: Re-cloning ${workspaceId} (simple approach)...`);
    
    // Delete old files
    const oldFiles = await db.files
      .where('source.repository').equals(repository)
      .and(file => file.source?.branch === branch && !file.isDirty)
      .toArray();

    for (const file of oldFiles) {
      await db.files.delete(file.fileId);
    }

    // Re-clone
    await this.cloneWorkspace(repository, branch, gitCreds);
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
      // Remove from FileRegistry memory cache (force delete, bypass dirty/open checks)
      // We're deleting the entire workspace so we don't care about dirty state
      (fileRegistry as any).files.delete(file.fileId);
      (fileRegistry as any).listeners.delete(file.fileId);
    }

    // Delete workspace record
    await db.workspaces.delete(workspaceId);
    
    console.log(`✅ WorkspaceService: Deleted workspace ${workspaceId} and ${files.length} files`);
  }

  /**
   * Get all files in a workspace (from IDB)
   */
  async getWorkspaceFiles(repository: string, branch: string): Promise<FileState[]> {
    return await db.files
      .where('source.repository').equals(repository)
      .and(file => file.source?.branch === branch)
      .toArray();
  }
}

export const workspaceService = new WorkspaceService();

