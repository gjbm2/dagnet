import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { gitConfig } from '../config/gitConfig';
import { CredentialsData, GitRepositoryCredential } from '../types/credentials';

/** Thrown when a GitHub API call returns 401 (invalid/revoked/expired token). */
export class GitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitAuthError';
  }
}

/** Fire this event to trigger the app-level 401 modal. */
export function dispatchGitAuthExpired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dagnet:gitAuthExpired'));
  }
}

/**
 * Re-throw as GitAuthError if the error indicates a 401.
 * Works with both fetch errors (from makeRequest) and Octokit RequestError.
 * Does NOT dispatch events — the modal is triggered by a post-init check
 * and by explicit event dispatch in user-action callers, not here.
 */
export function rethrowIfAuthError(error: unknown): void {
  if (error instanceof GitAuthError) throw error;
  const status = (error as any)?.status ?? (error as any)?.response?.status;
  if (status === 401) {
    throw new GitAuthError('GitHub credentials are invalid or expired (401). Connect your GitHub account to continue.');
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('401') && (msg.includes('Bad credentials') || msg.includes('Unauthorized'))) {
    throw new GitAuthError('GitHub credentials are invalid or expired (401). Connect your GitHub account to continue.');
  }
}

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
    
    console.log(`GitService.setCurrentRepo: Set to ${this.currentRepo?.owner}/${this.currentRepo?.name} (branch: ${this.currentRepo?.branch || 'default'}, basePath: ${this.currentRepo?.basePath || 'none'})`);
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
    
    const method = (options.method || 'GET').toUpperCase();
    const headers: HeadersInit = {
      Accept: 'application/vnd.github.v3+json',
      ...(options.headers || {}),
    };

    // CRITICAL (CORS):
    // Do NOT set Content-Type on GET/HEAD requests.
    // Some GitHub endpoints do not respond to OPTIONS preflights with permissive CORS headers,
    // and forcing a preflight makes browser fetches fail intermittently/hard.
    //
    // Only set JSON Content-Type when we actually send a body (PUT/POST/DELETE etc).
    const hasBody = typeof (options as any)?.body !== 'undefined' && (options as any).body !== null;
    if (hasBody && method !== 'GET' && method !== 'HEAD') {
      (headers as any)['Content-Type'] = (headers as any)['Content-Type'] || 'application/json';
    }

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

    // Avoid indefinite hangs (observed as minute+ stalls in live share boot when a request
    // gets stuck on the network/CORS preflight). Fail fast so callers can surface a real error.
    const timeoutMs = (this.config as any)?.requestTimeoutMs ?? 30_000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout =
      controller
        ? setTimeout(() => {
            try {
              controller.abort();
            } catch {
              // ignore
            }
          }, timeoutMs)
        : null;
    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401) {
          throw new GitAuthError(`GitHub credentials are invalid or expired (401). Connect your GitHub account to continue.`);
        }
        throw new Error(`Git API Error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      return response;
    } catch (e: any) {
      // Normalise abort errors to something readable for session logs.
      if (e?.name === 'AbortError') {
        throw new Error(`Git API Error: request timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      if (timeout) clearTimeout(timeout as any);
    }
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
      rethrowIfAuthError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to fetch branches'
      };
    }
  }

  /**
   * Create a new branch from an existing branch's HEAD
   */
  async createBranch(newBranchName: string, sourceBranch: string): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      // Get the SHA of the source branch HEAD
      const refResponse = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${sourceBranch}`
      });
      const sourceSha = refResponse.data.object.sha;

      console.log(`🔵 GitService.createBranch: Creating ${newBranchName} from ${sourceBranch} (${sourceSha.substring(0, 8)})`);

      // Create the new ref
      await this.octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${newBranchName}`,
        sha: sourceSha
      });

      return {
        success: true,
        data: { name: newBranchName, sourceBranch, sha: sourceSha },
        message: `Created branch ${newBranchName} from ${sourceBranch}`
      };
    } catch (error: any) {
      rethrowIfAuthError(error);
      const message = error?.status === 422
        ? `Branch '${newBranchName}' already exists`
        : (error instanceof Error ? error.message : 'Unknown error');
      return {
        success: false,
        error: message,
        message: `Failed to create branch ${newBranchName}`
      };
    }
  }

  /**
   * Merge one branch into another using GitHub's merge API.
   *
   * On success returns { success: true, data: { sha, message } }.
   * On conflict returns { success: false, error: 'conflict', message: '...' }.
   * On other errors returns { success: false, error: '...', message: '...' }.
   */
  async mergeBranch(
    headBranch: string,
    baseBranch: string,
    commitMessage?: string
  ): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      console.log(`🔵 GitService.mergeBranch: Merging ${headBranch} → ${baseBranch} in ${owner}/${repo}`);

      const response = await this.octokit.repos.merge({
        owner,
        repo,
        base: baseBranch,
        head: headBranch,
        commit_message: commitMessage || `Merge ${headBranch} into ${baseBranch}`
      });

      // 201 = merge commit created, 204 = already up to date (no-op)
      const sha = response.data?.sha;
      // Octokit currently types this endpoint as returning status 201 only, but the API
      // can also return 204 (already up to date). Widen to number to keep the check valid.
      const status: number = response.status;
      const isNoOp = status === 204;

      console.log(`🔵 GitService.mergeBranch: ${isNoOp ? 'Already up to date' : `Merge commit ${sha?.substring(0, 8)}`}`);

      return {
        success: true,
        data: { sha, alreadyUpToDate: isNoOp },
        message: isNoOp
          ? `${baseBranch} is already up to date with ${headBranch}`
          : `Merged ${headBranch} into ${baseBranch}`
      };
    } catch (error: any) {
      rethrowIfAuthError(error);
      // 409 = merge conflict
      if (error?.status === 409) {
        return {
          success: false,
          error: 'conflict',
          message: `Merge conflict: ${headBranch} cannot be cleanly merged into ${baseBranch}`
        };
      }
      // 404 = branch not found
      if (error?.status === 404) {
        return {
          success: false,
          error: 'not_found',
          message: `Branch not found — check that both ${headBranch} and ${baseBranch} exist`
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to merge ${headBranch} into ${baseBranch}`
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
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
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
    sha?: string,
    encoding: 'utf-8' | 'base64' = 'utf-8'
  ): Promise<GitOperationResult> {
    try {
      // Encode content to base64
      let encodedContent: string;
      if (encoding === 'base64') {
        // Already base64 or binary data encoded as base64
        encodedContent = content;
      } else {
        // UTF-8 text - handle properly
        encodedContent = btoa(unescape(encodeURIComponent(content)));
      }
      
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
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to delete file ${path}`
      };
    }
  }

  /**
   * Convert Uint8Array to base64 string
   * Uses chunked approach to avoid JavaScript argument limits with spread operator
   */
  private uint8ArrayToBase64(uint8Array: Uint8Array): string {
    // Process in chunks to avoid "Maximum call stack size exceeded" error
    const CHUNK_SIZE = 0x8000; // 32KB chunks
    let result = '';
    for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
      const chunk = uint8Array.subarray(i, i + CHUNK_SIZE);
      result += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(result);
  }

  // Get commit history for the entire repository
  // GitHub API max is 100 per page; for more, would need pagination
  async getRepositoryCommits(branch: string = this.config.branch, perPage: number = 100): Promise<GitOperationResult> {
    try {
      console.log(`🔵 GitService.getRepositoryCommits: Fetching commits for branch ${branch}, repo: ${this.currentRepo?.owner}/${this.currentRepo?.name}`);
      const response = await this.makeRequest(`/commits?sha=${branch}&per_page=${perPage}`);
      const commits: GitCommit[] = await response.json();
      
      if (this.config.debugGitOperations) {
        console.log(`Repository commits:`, commits.length, 'commits');
      }

      return {
        success: true,
        data: commits,
        message: `Found ${commits.length} commits`
      };
    } catch (error) {
      rethrowIfAuthError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to fetch repository commits'
      };
    }
  }

  // Get commit history for a file
  async getFileHistory(path: string, branch: string = this.config.branch): Promise<GitOperationResult> {
    try {
      console.log(`🔵 GitService.getFileHistory: Fetching history for ${path} from branch ${branch}, repo: ${this.currentRepo?.owner}/${this.currentRepo?.name}`);
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
      rethrowIfAuthError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to fetch commit history for ${path}`
      };
    }
  }

  /**
   * Commit and push multiple files in a SINGLE atomic commit
   * 
   * Uses Git Data API (trees/blobs/commits) for:
   * - Single atomic commit (all-or-nothing)
   * - Proper rename detection by GitHub
   * - Better performance (fewer API calls)
   * - Consistent with how pull uses Git Data API
   */
  async commitAndPushFiles(
    files: Array<{
      path: string;
      content?: string;
      binaryContent?: Uint8Array;
      encoding?: 'utf-8' | 'base64';
      sha?: string;
      delete?: boolean;
    }>,
    message: string,
    branch: string = this.config.branch,
    onProgress?: (completed: number, total: number, phase: 'uploading' | 'finalising') => void
  ): Promise<GitOperationResult> {
    try {
      if (files.length === 0) {
        return {
          success: false,
          error: 'No files to commit',
          message: 'Cannot commit empty file list'
        };
      }

      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      console.log(`🔵 GitService.commitAndPushFiles: Atomic commit of ${files.length} files to ${owner}/${repo}@${branch}`);
      
      if (this.config.debugGitOperations) {
        files.forEach(f => console.log(`   ${f.delete ? 'DELETE' : 'UPSERT'}: ${f.path}`));
      }

      // Report initial progress
      onProgress?.(0, files.length, 'uploading');

      // Step 1: Get current branch HEAD commit
      const refResponse = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
      });
      const baseCommitSha = refResponse.data.object.sha;
      console.log(`🔵 GitService: Base commit: ${baseCommitSha.substring(0, 8)}`);

      // Step 2: Get base tree SHA from commit
      const commitResponse = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: baseCommitSha
      });
      const baseTreeSha = commitResponse.data.tree.sha;
      console.log(`🔵 GitService: Base tree: ${baseTreeSha.substring(0, 8)}`);

      // Step 3: Build tree entries for all file changes
      const treeEntries: Array<{
        path: string;
        mode: '100644' | '100755' | '040000' | '160000' | '120000';
        type: 'blob' | 'tree' | 'commit';
        sha?: string | null;
        content?: string;
      }> = [];

      // Build a set of paths that exist in the base tree (for delete validation)
      const baseTreeResult = await this.octokit.git.getTree({
        owner, repo, tree_sha: baseTreeSha, recursive: 'true'
      });
      const existingPaths = new Set(
        baseTreeResult.data.tree.map((item: any) => item.path)
      );

      // Separate deletes (no API call needed) from upserts (need blob creation)
      const deleteFiles = files.filter(f => f.delete);
      const upsertFiles = files.filter(f => !f.delete);

      // Handle deletes synchronously — they don't need blob creation
      let completed = 0;
      for (const file of deleteFiles) {
        if (!existingPaths.has(file.path)) {
          console.log(`🔵 GitService: Skipping DELETE (not in remote tree): ${file.path}`);
          completed++;
          onProgress?.(completed, files.length, 'uploading');
          continue;
        }
        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: null // null SHA = delete
        });
        console.log(`🔵 GitService: Staging DELETE: ${file.path}`);
        completed++;
        onProgress?.(completed, files.length, 'uploading');
      }

      // Upload blobs with bounded concurrency (6 parallel requests)
      const CONCURRENCY = 6;
      for (let i = 0; i < upsertFiles.length; i += CONCURRENCY) {
        const batch = upsertFiles.slice(i, i + CONCURRENCY);
        const blobResults = await Promise.all(
          batch.map(async (file) => {
            let blobContent: string;
            let blobEncoding: 'utf-8' | 'base64' = 'utf-8';

            if (file.binaryContent) {
              blobContent = this.uint8ArrayToBase64(file.binaryContent);
              blobEncoding = 'base64';
            } else {
              blobContent = file.content!;
            }

            const blobResponse = await this.octokit.git.createBlob({
              owner,
              repo,
              content: blobContent,
              encoding: blobEncoding
            });

            return { path: file.path, sha: blobResponse.data.sha };
          })
        );

        for (const result of blobResults) {
          treeEntries.push({
            path: result.path,
            mode: '100644',
            type: 'blob',
            sha: result.sha
          });
          console.log(`🔵 GitService: Staging UPSERT: ${result.path} (blob: ${result.sha.substring(0, 8)})`);
        }

        completed += batch.length;
        onProgress?.(completed, files.length, 'uploading');
      }

      // Step 4: Create new tree with all changes
      // base_tree ensures we keep all unchanged files
      onProgress?.(files.length, files.length, 'finalising');

      const treeResponse = await this.octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: treeEntries as any // Type assertion needed due to null sha for deletions
      });
      const newTreeSha = treeResponse.data.sha;
      console.log(`🔵 GitService: New tree: ${newTreeSha.substring(0, 8)}`);

      // Step 5: Create commit pointing to new tree
      const newCommitResponse = await this.octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: newTreeSha,
        parents: [baseCommitSha]
      });
      const newCommitSha = newCommitResponse.data.sha;
      console.log(`🔵 GitService: New commit: ${newCommitSha.substring(0, 8)}`);

      // Step 6: Update branch ref to point to new commit
      await this.octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommitSha
      });
      console.log(`🔵 GitService: Updated ${branch} to ${newCommitSha.substring(0, 8)}`);

      return {
        success: true,
        data: {
          commitSha: newCommitSha,
          treeSha: newTreeSha,
          filesCommitted: files.length
        },
        message: `Successfully committed ${files.length} files in single atomic commit`
      };
    } catch (error) {
      rethrowIfAuthError(error);
      console.error('❌ GitService.commitAndPushFiles: Error:', error);
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
      rethrowIfAuthError(error);
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
      // No rethrowIfAuthError here — getRepoInfo is used by the health check,
      // which runs before credentials are loaded. A 401 from the health check
      // should update the health indicator, not pop up the auth-expired modal.
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
  /**
   * Get repository tree recursively (all files at once)
   * This is much more efficient than listing directories one by one
   * 
   * @param branchOrCommit - Branch name (e.g., 'main') or commit SHA (40 hex chars)
   * @param recursive - Whether to fetch all files recursively
   */
  async getRepositoryTree(
    branchOrCommit: string = this.config.branch,
    recursive: boolean = true
  ): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      // Detect if branchOrCommit is a commit SHA (40 hex chars) or a branch name
      const isCommitSha = /^[0-9a-f]{40}$/i.test(branchOrCommit);
      let commitSha: string;

      if (isCommitSha) {
        // Direct commit SHA provided
        commitSha = branchOrCommit;
        console.log(`📦 GitService.getRepositoryTree: Using commit SHA directly: ${commitSha.substring(0, 8)}`);
      } else {
        // Branch name - resolve to commit SHA
        console.log(`📦 GitService.getRepositoryTree: Fetching tree for ${owner}/${repo}@${branchOrCommit} (recursive: ${recursive})`);
        const refResponse = await this.octokit.git.getRef({
          owner,
          repo,
          ref: `heads/${branchOrCommit}`
        });
        commitSha = refResponse.data.object.sha;
        console.log(`📦 GitService.getRepositoryTree: Branch HEAD at commit ${commitSha.substring(0, 8)}`);
      }

      // Get commit to find tree SHA
      const commitResponse = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha
      });
      const treeSha = commitResponse.data.tree.sha;
      console.log(`📦 GitService.getRepositoryTree: Tree SHA: ${treeSha.substring(0, 8)}`);

      // Get entire tree in ONE API call
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
      rethrowIfAuthError(error);
      console.error('❌ GitService.getRepositoryTree: Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to fetch repository tree'
      };
    }
  }

  /**
   * Get the current HEAD commit SHA for a branch
   * Used for checking if remote is ahead of local
   */
  async getRemoteHeadSha(branch: string = this.config.branch): Promise<string | null> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      const refResponse = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
      });
      
      return refResponse.data.object.sha;
    } catch (error) {
      rethrowIfAuthError(error);
      console.error('❌ GitService.getRemoteHeadSha: Error:', error);
      return null;
    }
  }

  /**
   * Get blob content by SHA (more efficient than fetching by path)
   * @param sha - The blob SHA
   * @param binary - If true, returns raw base64 content (for images/binary files). Default false.
   */
  async getBlobContent(sha: string, binary: boolean = false): Promise<GitOperationResult> {
    try {
      const owner = this.currentRepo?.owner || this.config.repoOwner;
      const repo = this.currentRepo?.repo || this.currentRepo?.name || this.config.repoName;

      console.log(`📦 GitService.getBlobContent: Fetching blob ${sha.substring(0, 8)} for ${owner}/${repo} (binary: ${binary})`);

      const blobResponse = await this.octokit.git.getBlob({
        owner,
        repo,
        file_sha: sha
      });

      let content: string;
      
      if (binary) {
        // For binary files, return raw base64 content (caller will decode)
        content = blobResponse.data.content;
      } else {
        // For text files, decode base64 to string
        // Use fetch with data URL to properly decode (atob corrupts binary/UTF-8)
        const base64 = blobResponse.data.content.replace(/[\s\r\n]/g, '');
        try {
          const response = await fetch(`data:text/plain;base64,${base64}`);
          content = await response.text();
        } catch {
          // Fallback to atob for simple ASCII
          content = atob(blobResponse.data.content);
        }
      }

      return {
        success: true,
        data: {
          sha,
          content,
          encoding: binary ? 'base64' : 'utf-8',
          size: blobResponse.data.size
        },
        message: 'Successfully fetched blob'
      };
    } catch (error) {
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
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
      rethrowIfAuthError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to update branch ${branch}`
      };
    }
  }

  /**
   * Check which files have been changed on the remote
   * Returns array of file paths that have different SHAs
   * 
   * OPTIMIZED: Uses a single tree fetch instead of checking each file individually
   */
  async checkFilesChangedOnRemote(
    files: Array<{ path: string; sha?: string }>,
    branch: string,
    basePath?: string
  ): Promise<string[]> {
    const startTime = performance.now();
    const changedFiles: string[] = [];
    
    // Filter to only files that have SHAs (exist remotely)
    const filesToCheck = files.filter(f => f.sha);
    if (filesToCheck.length === 0) {
      console.log(`GitService.checkFilesChangedOnRemote: No files with SHAs to check`);
      return [];
    }
    
    console.log(`GitService.checkFilesChangedOnRemote: Checking ${filesToCheck.length} files...`);
        
        try {
      // Fetch the entire tree in ONE API call
      const treeFetchStart = performance.now();
      const treeResult = await this.getRepositoryTree(branch, true);
      console.log(`GitService.checkFilesChangedOnRemote: Tree fetch took ${(performance.now() - treeFetchStart).toFixed(0)}ms`);
          
      if (!treeResult.success || !treeResult.data?.tree) {
        console.warn('GitService.checkFilesChangedOnRemote: Could not fetch tree, skipping remote check');
        return [];
      }
      
      // Build a map of paths to SHAs from the tree
      // Paths in tree are relative to repo root, so prepend basePath if provided
      const remoteShaMap = new Map<string, string>();
      for (const item of treeResult.data.tree) {
        if (item.type === 'blob' && item.path && item.sha) {
          // Store with the path relative to basePath for comparison
          const relativePath = basePath && item.path.startsWith(basePath + '/')
            ? item.path.substring(basePath.length + 1)
            : item.path;
          remoteShaMap.set(relativePath, item.sha);
        }
      }
      
      // Compare local SHAs against remote tree
      for (const file of filesToCheck) {
        const remoteSha = remoteShaMap.get(file.path);
        
        if (remoteSha && remoteSha !== file.sha) {
              // File has been changed on remote
              changedFiles.push(file.path);
            }
        // If remoteSha is undefined, file doesn't exist on remote (will be created)
          }
      
      const elapsed = performance.now() - startTime;
      console.log(`GitService.checkFilesChangedOnRemote: Checked ${filesToCheck.length} files, ${changedFiles.length} changed (total: ${elapsed.toFixed(0)}ms)`);
      
        } catch (error) {
      rethrowIfAuthError(error);
      console.error('GitService.checkFilesChangedOnRemote: Error fetching tree:', error);
      // Fall back gracefully - don't block commit
      return [];
    }
    
    return changedFiles;
  }
}

// Export singleton instance
export const gitService = new GitService();