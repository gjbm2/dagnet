import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { gitConfig } from '../config/gitConfig';
import { CredentialsData, GitRepositoryCredential } from '../types/credentials';

export interface GitFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: 'file' | 'dir';
  content?: string;
  encoding?: string;
}

export interface GitCommit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
    date: string;
  };
  committer: {
    name: string;
    email: string;
    date: string;
  };
}

export interface GitBranch {
  name: string;
  commit: {
    sha: string;
  };
}

export interface GitOperationResult {
  success: boolean;
  data?: any;
  error?: string;
  message?: string;
}

// Create Octokit with throttling plugin
const OctokitWithPlugins = Octokit.plugin(throttling);

class GitService {
  private config = gitConfig;
  private credentials: CredentialsData | null = null;
  private currentRepo: GitRepositoryCredential | null = null;
  private octokit: Octokit;

  constructor(credentials?: CredentialsData) {
    this.credentials = credentials || null;
    // Initialize Octokit with throttling
    this.octokit = new OctokitWithPlugins({
      throttle: {
        onRateLimit: (retryAfter: number, options: any, octokit: any, retryCount: number) => {
          console.warn(`⚠️ GitService: Rate limit hit, retrying after ${retryAfter}s (attempt ${retryCount})`);
          return retryCount < 3; // Retry up to 3 times
        },
        onSecondaryRateLimit: (retryAfter: number, options: any, octokit: any) => {
          console.warn(`⚠️ GitService: Secondary rate limit hit, retrying after ${retryAfter}s`);
          return true; // Always retry on secondary rate limits
        }
      }
    });
    this.setCurrentRepo();
  }

  /**
   * Set current repository from credentials
   */
  private setCurrentRepo(): void {
    if (!this.credentials?.git?.length) {
      this.currentRepo = null;
      console.log('GitService.setCurrentRepo: No credentials or git repos available');
      return;
    }

    // Use default repo or first available
    const defaultRepo = this.credentials.defaultGitRepo;
    this.currentRepo = defaultRepo 
      ? this.credentials.git.find(repo => repo.name === defaultRepo) || this.credentials.git[0]
      : this.credentials.git[0];
    
    console.log(`GitService.setCurrentRepo: Set to ${this.currentRepo?.name} (defaultGitRepo was: ${defaultRepo}, owner: ${this.currentRepo?.owner}, repo: ${this.currentRepo?.repo}, basePath: ${this.currentRepo?.basePath})`);
  }

  /**
   * Update credentials and current repo
   */
  setCredentials(credentials: CredentialsData): void {
    this.credentials = credentials;
    this.setCurrentRepo();
    
    // Reinitialize Octokit with new token
    const authToken = this.currentRepo?.token || this.config.githubToken;
    if (authToken && authToken.trim() !== '') {
      this.octokit = new OctokitWithPlugins({
        auth: authToken,
        throttle: {
          onRateLimit: (retryAfter: number, options: any, octokit: any, retryCount: number) => {
            console.warn(`⚠️ GitService: Rate limit hit, retrying after ${retryAfter}s (attempt ${retryCount})`);
            return retryCount < 3;
          },
          onSecondaryRateLimit: (retryAfter: number, options: any, octokit: any) => {
            console.warn(`⚠️ GitService: Secondary rate limit hit, retrying after ${retryAfter}s`);
            return true;
          }
        }
      });
      console.log('✅ GitService: Octokit reinitialized with new credentials');
    }
  }

  /**
   * Get base URL dynamically to support repo switching
   */
  private getBaseUrl(repoOwner?: string, repoName?: string): string {
    const owner = repoOwner || this.currentRepo?.owner || this.config.repoOwner;
    // Use currentRepo.name if repo is not set (deprecated field migration)
    const name = repoName || this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;
    return `${this.config.githubApiBase}/repos/${owner}/${name}`;
  }

  private async makeRequest(endpoint: string, options: RequestInit = {}, repoOwner?: string, repoName?: string, token?: string): Promise<Response> {
    const baseUrl = this.getBaseUrl(repoOwner, repoName);
    const url = `${baseUrl}${endpoint}`;
    
    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    };

    console.log('GitService config:', this.config);
    console.log('GitService githubToken:', this.config.githubToken ? 'SET' : 'NOT SET');

    // Use provided token, or token from credentials, or fall back to config
    const authToken = token || this.currentRepo?.token || this.config.githubToken;
    if (authToken && authToken.trim() !== '') {
      headers['Authorization'] = `token ${authToken}`;
      console.log('GitService: Using token for authentication');
    } else {
      console.log('GitService: No token available for authentication');
    }

    if (this.config.debugGitOperations) {
      console.log(`Git API Request: ${options.method || 'GET'} ${url}`);
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Git API Error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response;
  }

  // Get all branches
  async getBranches(repoOwner?: string, repoName?: string, token?: string): Promise<GitOperationResult> {
    try {
      const response = await this.makeRequest('/branches', {}, repoOwner, repoName, token);
      const branches: GitBranch[] = await response.json();
      
      if (this.config.debugGitOperations) {
        console.log('Available branches:', branches.map(b => b.name));
      }

      return {
        success: true,
        data: branches,
        message: `Found ${branches.length} branches`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to fetch branches'
      };
    }
  }

  // Get files in a directory
  async getDirectoryContents(path: string, branch: string = this.config.branch, repoOwner?: string, repoName?: string, token?: string): Promise<GitOperationResult> {
    try {
      const response = await this.makeRequest(`/contents/${path}?ref=${branch}`, {}, repoOwner, repoName, token);
      const files: GitFile[] = await response.json();
      
      if (this.config.debugGitOperations) {
        console.log(`Directory contents for ${path}:`, files);
      }

      return {
        success: true,
        data: files,
        message: `Found ${files.length} items in ${path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to fetch directory contents for ${path}`
      };
    }
  }

  // Get a specific file
  async getFile(path: string, branch: string = this.config.branch): Promise<GitOperationResult> {
    try {
      console.log(`🔵 GitService.getFile: Fetching ${path} from branch ${branch}, repo: ${this.currentRepo?.owner}/${this.currentRepo?.repo || this.currentRepo?.name}, basePath: ${this.currentRepo?.basePath}`);
      const response = await this.makeRequest(`/contents/${path}?ref=${branch}`);
      const file: GitFile = await response.json();
      
      console.log(`🔵 GitService.getFile: Got ${path}, size: ${file.size}, SHA: ${file.sha?.substring(0, 8)}`);
      
      if (this.config.debugGitOperations) {
        console.log(`File contents for ${path}:`, file);
      }

      return {
        success: true,
        data: file,
        message: `Successfully fetched ${path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to fetch file ${path}`
      };
    }
  }

  // Get file content (decoded)
  async getFileContent(path: string, branch: string = this.config.branch): Promise<GitOperationResult> {
    try {
      const fileResult = await this.getFile(path, branch);
      if (!fileResult.success || !fileResult.data) {
        return fileResult;
      }

      const file = fileResult.data as GitFile;
      if (!file.content) {
        return {
          success: false,
          error: 'File has no content',
          message: `File ${path} is empty or binary`
        };
      }

      // Decode base64 content
      const content = atob(file.content);
      
      if (this.config.debugGitOperations) {
        console.log(`Decoded content for ${path}:`, content.substring(0, 100) + '...');
      }

      return {
        success: true,
        data: {
          ...file,
          content: content
        },
        message: `Successfully decoded ${path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to decode file content for ${path}`
      };
    }
  }

  // Create or update a file
  async createOrUpdateFile(
    path: string, 
    content: string, 
    message: string,
    branch: string = this.config.branch,
    sha?: string
  ): Promise<GitOperationResult> {
    try {
      // Encode content to base64 - handle UTF-8 properly
      const encodedContent = btoa(unescape(encodeURIComponent(content)));
      
      const body = {
        message,
        content: encodedContent,
        branch,
        ...(sha && { sha }) // Include sha for updates
      };

      if (this.config.debugGitOperations) {
        console.log(`Creating/updating file ${path}:`, { 
          message, 
          branch, 
          sha: sha || 'none (new file)',
          contentLength: content.length 
        });
      }

      const response = await this.makeRequest(`/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error(`GitHub API Error: ${response.status} -`, errorData);
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }

      const result = await response.json();
      
      return {
        success: true,
        data: result,
        message: `Successfully ${sha ? 'updated' : 'created'} ${path}`
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to ${sha ? 'update' : 'create'} file ${path}:`, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: `Failed to ${sha ? 'update' : 'create'} file ${path}: ${errorMsg}`
      };
    }
  }

  // Delete a file
  async deleteFile(
    path: string, 
    message: string,
    branch: string = this.config.branch
  ): Promise<GitOperationResult> {
    try {
      // First get the file to get its SHA
      const fileResult = await this.getFile(path, branch);
      if (!fileResult.success || !fileResult.data) {
        return {
          success: false,
          error: 'File not found',
          message: `Cannot delete ${path} - file not found`
        };
      }

      const file = fileResult.data as GitFile;
      
      const body = {
        message,
        sha: file.sha,
        branch
      };

      if (this.config.debugGitOperations) {
        console.log(`Deleting file ${path}:`, { message, branch, sha: file.sha });
      }

      const response = await this.makeRequest(`/contents/${path}`, {
        method: 'DELETE',
        body: JSON.stringify(body)
      });

      const result = await response.json();
      
      return {
        success: true,
        data: result,
        message: `Successfully deleted ${path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to delete file ${path}`
      };
    }
  }

  // Get commit history for a file
  async getFileHistory(path: string, branch: string = this.config.branch): Promise<GitOperationResult> {
    try {
      const response = await this.makeRequest(`/commits?path=${path}&sha=${branch}`);
      const commits: GitCommit[] = await response.json();
      
      if (this.config.debugGitOperations) {
        console.log(`Commit history for ${path}:`, commits.length, 'commits');
      }

      return {
        success: true,
        data: commits,
        message: `Found ${commits.length} commits for ${path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to fetch commit history for ${path}`
      };
    }
  }

  // Commit and push multiple files
  async commitAndPushFiles(
    files: Array<{ path: string; content: string; sha?: string }>,
    message: string,
    branch: string = this.config.branch
  ): Promise<GitOperationResult> {
    try {
      if (files.length === 0) {
        return {
          success: false,
          error: 'No files to commit',
          message: 'Cannot commit empty file list'
        };
      }

      if (this.config.debugGitOperations) {
        console.log(`Committing ${files.length} files with message: ${message}`);
      }

      // For now, we'll commit files one by one
      // In a more sophisticated implementation, we could use GitHub's tree API
      // to create a single commit with multiple files
      const results: GitOperationResult[] = [];
      
      for (const file of files) {
        // Always fetch the current file SHA from GitHub to ensure we have the latest
        // This prevents 409 conflicts from stale SHAs
        let fileSha: string | undefined = undefined;
        
        try {
          // Use the raw GitHub API to get file metadata
          const fileInfoResponse = await this.makeRequest(`/contents/${file.path}?ref=${branch}`, {
            method: 'GET'
          });
          
          if (fileInfoResponse.ok) {
            const fileInfo = await fileInfoResponse.json();
            fileSha = fileInfo.sha;
            
            if (this.config.debugGitOperations) {
              console.log(`Fetched current SHA for ${file.path}: ${fileSha}`);
            }
          }
        } catch (error) {
          // File doesn't exist yet, which is fine for new files
          if (this.config.debugGitOperations) {
            console.log(`File ${file.path} doesn't exist yet, will create it`);
          }
        }
        
        console.log(`🔵 GitService.commitAndPushFiles: Committing ${file.path}, content length: ${file.content.length}, SHA: ${fileSha?.substring(0, 8) || 'new file'}`);
        
        const result = await this.createOrUpdateFile(
          file.path,
          file.content,
          message,
          branch,
          fileSha
        );
        
        if (!result.success) {
          return {
            success: false,
            error: result.error,
            message: `Failed to commit file ${file.path}: ${result.error}`
          };
        }
        
        console.log(`🔵 GitService.commitAndPushFiles: Successfully committed ${file.path}, new SHA: ${result.data?.content?.sha?.substring(0, 8)}`);
        results.push(result);
      }

      return {
        success: true,
        data: results,
        message: `Successfully committed ${files.length} files`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to commit files'
      };
    }
  }

  // Pull latest changes (refresh from remote)
  async pullLatest(branch: string = this.config.branch): Promise<GitOperationResult> {
    try {
      // For a simple pull, we just need to verify the branch exists and is accessible
      // In a full implementation, this would involve checking for new commits
      // and potentially updating local state
      
      const branchResult = await this.getBranches();
      if (!branchResult.success) {
        return {
          success: false,
          error: branchResult.error,
          message: 'Failed to verify branch exists'
        };
      }

      const branches = branchResult.data as GitBranch[];
      const targetBranch = branches.find(b => b.name === branch);
      
      if (!targetBranch) {
        return {
          success: false,
          error: 'Branch not found',
          message: `Branch ${branch} does not exist`
        };
      }

      if (this.config.debugGitOperations) {
        console.log(`Pull latest from branch ${branch} - latest commit: ${targetBranch.commit.sha}`);
      }

      return {
        success: true,
        data: { branch, latestCommit: targetBranch.commit.sha },
        message: `Successfully pulled latest from ${branch}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to pull latest changes'
      };
    }
  }

  // Get repository info
  async getRepoInfo(): Promise<GitOperationResult> {
    try {
      const response = await this.makeRequest('');
      const repo = await response.json();
      
      if (this.config.debugGitOperations) {
        console.log('Repository info:', repo);
      }

      return {
        success: true,
        data: repo,
        message: 'Successfully fetched repository info'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to fetch repository info'
      };
    }
  }

  // =========================================================================
  // Git Data API Methods (for batch operations)
  // =========================================================================

  /**
   * Get repository tree recursively (all files at once)
   * This is much more efficient than listing directories one by one
   */
  async getRepositoryTree(
    branch: string = this.config.branch,
    recursive: boolean = true
  ): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      console.log(`📦 GitService.getRepositoryTree: Fetching tree for ${owner}/${repo}@${branch} (recursive: ${recursive})`);

      // 1. Get branch reference
      const refResponse = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
      });
      const commitSha = refResponse.data.object.sha;
      console.log(`📦 GitService.getRepositoryTree: Branch HEAD at commit ${commitSha.substring(0, 8)}`);

      // 2. Get commit to find tree SHA
      const commitResponse = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha
      });
      const treeSha = commitResponse.data.tree.sha;
      console.log(`📦 GitService.getRepositoryTree: Tree SHA: ${treeSha.substring(0, 8)}`);

      // 3. Get entire tree in ONE API call
      const treeResponse = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: recursive ? 'true' : undefined
      });

      console.log(`📦 GitService.getRepositoryTree: Got ${treeResponse.data.tree.length} items`);

      return {
        success: true,
        data: {
          tree: treeResponse.data.tree,
          commitSha,
          treeSha
        },
        message: `Successfully fetched tree with ${treeResponse.data.tree.length} items`
      };
    } catch (error) {
      console.error('❌ GitService.getRepositoryTree: Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to fetch repository tree'
      };
    }
  }

  /**
   * Get blob content by SHA (more efficient than fetching by path)
   */
  async getBlobContent(sha: string): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      console.log(`📦 GitService.getBlobContent: Fetching blob ${sha.substring(0, 8)} for ${owner}/${repo}`);

      const blobResponse = await this.octokit.git.getBlob({
        owner,
        repo,
        file_sha: sha
      });

      // Decode base64 content (atob works in browser, Buffer is Node.js)
      const content = atob(blobResponse.data.content);

      return {
        success: true,
        data: {
          sha,
          content,
          size: blobResponse.data.size
        },
        message: 'Successfully fetched blob'
      };
    } catch (error) {
      console.error(`❌ GitService.getBlobContent: Failed to fetch blob ${sha.substring(0, 8)}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to fetch blob ${sha}`
      };
    }
  }

  /**
   * Create a blob (for atomic commits)
   */
  async createBlob(content: string): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      const blobResponse = await this.octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64'
      });

      return {
        success: true,
        data: {
          sha: blobResponse.data.sha
        },
        message: 'Successfully created blob'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to create blob'
      };
    }
  }

  /**
   * Create a tree with multiple files (for atomic commits)
   */
  async createTree(
    baseTreeSha: string,
    files: Array<{ path: string; sha: string; mode?: '100644' | '100755' | '040000' | '160000' | '120000' }>
  ): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      const treeResponse = await this.octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: files.map(file => ({
          path: file.path,
          mode: file.mode || '100644', // Default to regular file
          type: 'blob',
          sha: file.sha
        }))
      });

      return {
        success: true,
        data: {
          sha: treeResponse.data.sha
        },
        message: 'Successfully created tree'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to create tree'
      };
    }
  }

  /**
   * Create a commit
   */
  async createCommit(
    message: string,
    treeSha: string,
    parentShas: string[]
  ): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      const commitResponse = await this.octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: treeSha,
        parents: parentShas
      });

      return {
        success: true,
        data: {
          sha: commitResponse.data.sha
        },
        message: 'Successfully created commit'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to create commit'
      };
    }
  }

  /**
   * Update branch reference to point to a new commit
   */
  async updateRef(
    branch: string,
    commitSha: string,
    force: boolean = false
  ): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      await this.octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commitSha,
        force
      });

      return {
        success: true,
        data: { commitSha },
        message: `Successfully updated ${branch} to ${commitSha.substring(0, 8)}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to update branch ${branch}`
      };
    }
  }
}

// Export singleton instance
export const gitService = new GitService();