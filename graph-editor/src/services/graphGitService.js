import { gitService } from './gitService';
import { gitConfig } from '../config/gitConfig';
class GraphGitService {
    constructor() {
        this.config = gitConfig;
    }
    // Get all available graphs
    async getAvailableGraphs(branch = this.config.branch) {
        try {
            const result = await gitService.getDirectoryContents(this.config.graphsPath, branch);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: `Failed to fetch graphs from ${branch}`
                };
            }
            const files = result.data.filter((file) => file.type === 'file' &&
                (file.name.endsWith('.json') || file.name.endsWith('.yaml') || file.name.endsWith('.yml')));
            return {
                success: true,
                data: files,
                message: `Found ${files.length} graph files in ${branch}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Failed to fetch available graphs'
            };
        }
    }
    // Get a specific graph
    async getGraph(graphName, branch = this.config.branch) {
        try {
            // Ensure .json extension
            const fileName = graphName.endsWith('.json') ? graphName : `${graphName}.json`;
            const filePath = `${this.config.graphsPath}/${fileName}`;
            const result = await gitService.getFileContent(filePath, branch);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: `Failed to fetch graph ${graphName} from ${branch}`
                };
            }
            const file = result.data;
            let graphData;
            try {
                graphData = JSON.parse(file.content);
            }
            catch (parseError) {
                return {
                    success: false,
                    error: 'Invalid JSON',
                    message: `Graph ${graphName} contains invalid JSON`
                };
            }
            return {
                success: true,
                data: {
                    name: graphName,
                    path: filePath,
                    sha: file.sha,
                    size: file.size,
                    content: graphData,
                    lastModified: file.lastModified || new Date().toISOString(),
                    branch: branch
                },
                message: `Successfully loaded graph ${graphName}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to load graph ${graphName}`
            };
        }
    }
    // Save a graph
    async saveGraph(graphName, graphData, message, branch = this.config.branch) {
        try {
            // Ensure .json extension
            const fileName = graphName.endsWith('.json') ? graphName : `${graphName}.json`;
            const filePath = `${this.config.graphsPath}/${fileName}`;
            // Check if file exists to determine if this is an update
            const existingFile = await gitService.getFile(filePath, branch);
            const isUpdate = existingFile.success && existingFile.data;
            const content = JSON.stringify(graphData, null, 2);
            const commitMessage = isUpdate
                ? `Update graph: ${message}`
                : `Add graph: ${message}`;
            const result = await gitService.createOrUpdateFile(filePath, content, commitMessage, branch, isUpdate ? existingFile.data.sha : undefined);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: `Failed to save graph ${graphName}`
                };
            }
            return {
                success: true,
                data: {
                    name: graphName,
                    path: filePath,
                    sha: result.data.content.sha,
                    size: content.length,
                    content: graphData,
                    lastModified: new Date().toISOString(),
                    branch: branch
                },
                message: `Successfully ${isUpdate ? 'updated' : 'saved'} graph ${graphName}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to save graph ${graphName}`
            };
        }
    }
    // Delete a graph
    async deleteGraph(graphName, message, branch = this.config.branch) {
        try {
            const fileName = graphName.endsWith('.json') ? graphName : `${graphName}.json`;
            const filePath = `${this.config.graphsPath}/${fileName}`;
            const result = await gitService.deleteFile(filePath, `Delete graph: ${message}`, branch);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: `Failed to delete graph ${graphName}`
                };
            }
            return {
                success: true,
                data: { name: graphName, path: filePath },
                message: `Successfully deleted graph ${graphName}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to delete graph ${graphName}`
            };
        }
    }
    // Get graph history
    async getGraphHistory(graphName, branch = this.config.branch) {
        try {
            const fileName = graphName.endsWith('.json') ? graphName : `${graphName}.json`;
            const filePath = `${this.config.graphsPath}/${fileName}`;
            const result = await gitService.getFileHistory(filePath, branch);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: `Failed to fetch history for graph ${graphName}`
                };
            }
            return {
                success: true,
                data: result.data,
                message: `Found ${result.data.length} commits for graph ${graphName}`
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to fetch history for graph ${graphName}`
            };
        }
    }
    // Get all branches
    async getBranches() {
        try {
            const result = await gitService.getBranches();
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: 'Failed to fetch branches'
                };
            }
            return {
                success: true,
                data: result.data,
                message: `Found ${result.data.length} branches`
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
    // Create a new branch
    async createBranch(branchName, fromBranch = this.config.branch) {
        try {
            // This would require more complex Git operations
            // For now, we'll return a not implemented error
            return {
                success: false,
                error: 'Not implemented',
                message: 'Branch creation not yet implemented'
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to create branch ${branchName}`
            };
        }
    }
    // Get repository info
    async getRepoInfo() {
        try {
            const result = await gitService.getRepoInfo();
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    message: 'Failed to fetch repository info'
                };
            }
            return {
                success: true,
                data: result.data,
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
export const graphGitService = new GraphGitService();
