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

class GitService {
  private config = gitConfig;
  private credentials: CredentialsData | null = null;
  private currentRepo: GitRepositoryCredential | null = null;

  constructor(credentials?: CredentialsData) {
    this.credentials = credentials || null;
    this.setCurrentRepo();
  }

  /**
   * Set current repository from credentials
   */
  private setCurrentRepo(): void {
    if (!this.credentials?.git?.length) {
      this.currentRepo = null;
      return;
    }

    // Use default repo or first available
    const defaultRepo = this.credentials.defaultGitRepo || 'nous-conversion';
    this.currentRepo = this.credentials.git.find(repo => repo.name === defaultRepo) || this.credentials.git[0];
  }

  /**
   * Update credentials and current repo
   */
  setCredentials(credentials: CredentialsData): void {
    this.credentials = credentials;
    this.setCurrentRepo();
  }

  /**
   * Get base URL dynamically to support repo switching
   */
  private getBaseUrl(repoOwner?: string, repoName?: string): string {
    const owner = repoOwner || this.currentRepo?.owner || this.config.repoOwner;
    const name = repoName || this.currentRepo?.repo || this.config.repoName;
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
      const response = await this.makeRequest(`/contents/${path}?ref=${branch}`);
      const file: GitFile = await response.json();
      
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
      // Encode content to base64
      const encodedContent = btoa(content);
      
      const body = {
        message,
        content: encodedContent,
        branch,
        ...(sha && { sha }) // Include sha for updates
      };

      if (this.config.debugGitOperations) {
        console.log(`Creating/updating file ${path}:`, { message, branch, sha: !!sha });
      }

      const response = await this.makeRequest(`/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });

      const result = await response.json();
      
      return {
        success: true,
        data: result,
        message: `Successfully ${sha ? 'updated' : 'created'} ${path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Failed to ${sha ? 'update' : 'create'} file ${path}`
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
}

// Export singleton instance
export const gitService = new GitService();