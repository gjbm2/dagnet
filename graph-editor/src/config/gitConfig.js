// Default configuration - FORCE VERCEL REBUILD
const defaultConfig = {
    repoOwner: 'gjbm2',
    repoName: 'nous-conversion', // FORCE VERCEL REBUILD
    branch: 'main',
    graphsPath: 'graphs',
    paramsPath: 'params',
    githubApiBase: 'https://api.github.com',
    githubToken: undefined,
    devMode: true,
    debugGitOperations: false,
};
// Load configuration from environment variables
export function loadGitConfig() {
    const config = {
        repoOwner: import.meta.env.VITE_GIT_REPO_OWNER || defaultConfig.repoOwner,
        repoName: import.meta.env.VITE_GIT_REPO_NAME || defaultConfig.repoName,
        branch: import.meta.env.VITE_GIT_REPO_BRANCH || defaultConfig.branch,
        graphsPath: import.meta.env.VITE_GIT_GRAPHS_PATH || defaultConfig.graphsPath,
        paramsPath: import.meta.env.VITE_GIT_PARAMS_PATH || defaultConfig.paramsPath,
        githubApiBase: import.meta.env.VITE_GITHUB_API_BASE || defaultConfig.githubApiBase,
        githubToken: import.meta.env.VITE_GITHUB_TOKEN || undefined,
        devMode: import.meta.env.VITE_DEV_MODE === 'true' || defaultConfig.devMode,
        debugGitOperations: import.meta.env.VITE_DEBUG_GIT_OPERATIONS === 'true' || defaultConfig.debugGitOperations,
    };
    // Always log for debugging
    console.log('Git Configuration:', config);
    console.log('Environment variables available:', {
        VITE_GIT_REPO_OWNER: import.meta.env.VITE_GIT_REPO_OWNER,
        VITE_GIT_REPO_NAME: import.meta.env.VITE_GIT_REPO_NAME,
        VITE_GIT_REPO_BRANCH: import.meta.env.VITE_GIT_REPO_BRANCH,
        VITE_GIT_GRAPHS_PATH: import.meta.env.VITE_GIT_GRAPHS_PATH,
        VITE_GITHUB_TOKEN: import.meta.env.VITE_GITHUB_TOKEN ? '***SET***' : 'NOT SET',
    });
    console.log('Raw VITE_GITHUB_TOKEN:', import.meta.env.VITE_GITHUB_TOKEN);
    console.log('All import.meta.env:', import.meta.env);
    console.log('=== FORCE VERCEL REBUILD - CHECKING REPO NAME ===');
    console.log('Final repoName:', config.repoName);
    console.log('Final repoOwner:', config.repoOwner);
    return config;
}
// Export the loaded configuration
export const gitConfig = loadGitConfig();
