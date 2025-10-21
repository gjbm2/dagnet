import { gitConfig } from '../config/gitConfig';
class GitService {
    constructor() {
        this.config = gitConfig;
        this.baseUrl = `${this.config.githubApiBase}/repos/${this.config.repoOwner}/${this.config.repoName}`;
    }
    async makeRequest(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            ...options.headers,
        };
        console.log('GitService config:', this.config);
        console.log('GitService githubToken:', this.config.githubToken ? 'SET' : 'NOT SET');
        if (this.config.githubToken && this.config.githubToken.trim() !== '') {
            headers['Authorization'] = `token ${this.config.githubToken}`;
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
    async getBranches() {
        try {
            const response = await this.makeRequest('/branches');
            const branches = await response.json();
            if (this.config.debugGitOperations) {
                console.log('Available branches:', branches.map(b => b.name));
            }
            return {
                success: true,
                data: branches,
                message: `Found ${branches.length} branches`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Failed to fetch branches'
            };
        }
    }
    // Get files in a directory
    async getDirectoryContents(path, branch = this.config.branch) {
        try {
            const response = await this.makeRequest(`/contents/${path}?ref=${branch}`);
            const files = await response.json();
            if (this.config.debugGitOperations) {
                console.log(`Directory contents for ${path}:`, files);
            }
            return {
                success: true,
                data: files,
                message: `Found ${files.length} items in ${path}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to fetch directory contents for ${path}`
            };
        }
    }
    // Get a specific file
    async getFile(path, branch = this.config.branch) {
        try {
            const response = await this.makeRequest(`/contents/${path}?ref=${branch}`);
            const file = await response.json();
            if (this.config.debugGitOperations) {
                console.log(`File contents for ${path}:`, file);
            }
            return {
                success: true,
                data: file,
                message: `Successfully fetched ${path}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to fetch file ${path}`
            };
        }
    }
    // Get file content (decoded)
    async getFileContent(path, branch = this.config.branch) {
        try {
            const fileResult = await this.getFile(path, branch);
            if (!fileResult.success || !fileResult.data) {
                return fileResult;
            }
            const file = fileResult.data;
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
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to decode file content for ${path}`
            };
        }
    }
    // Create or update a file
    async createOrUpdateFile(path, content, message, branch = this.config.branch, sha) {
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
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to ${sha ? 'update' : 'create'} file ${path}`
            };
        }
    }
    // Delete a file
    async deleteFile(path, message, branch = this.config.branch) {
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
            const file = fileResult.data;
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
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to delete file ${path}`
            };
        }
    }
    // Get commit history for a file
    async getFileHistory(path, branch = this.config.branch) {
        try {
            const response = await this.makeRequest(`/commits?path=${path}&sha=${branch}`);
            const commits = await response.json();
            if (this.config.debugGitOperations) {
                console.log(`Commit history for ${path}:`, commits.length, 'commits');
            }
            return {
                success: true,
                data: commits,
                message: `Found ${commits.length} commits for ${path}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to fetch commit history for ${path}`
            };
        }
    }
    // Get repository info
    async getRepoInfo() {
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
        }
        catch (error) {
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
