// Git Repository Configuration
export interface GitConfig {
  repoOwner: string;
  repoName: string;
  branch: string;
  graphsPath: string;
  paramsPath: string;
  githubApiBase: string;
  githubToken?: string;
  devMode: boolean;
  debugGitOperations: boolean;
}

// Default configuration
const defaultConfig: GitConfig = {
  repoOwner: 'gjbm2',
  repoName: 'dagnet',
  branch: 'main',
  graphsPath: 'graphs',
  paramsPath: 'param-registry',
  githubApiBase: 'https://api.github.com',
  githubToken: undefined,
  devMode: true,
  debugGitOperations: false,
};

// Load configuration from environment variables
export function loadGitConfig(): GitConfig {
  const config: GitConfig = {
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

  if (config.debugGitOperations) {
    console.log('Git Configuration:', config);
  }

  return config;
}

// Export the loaded configuration
export const gitConfig = loadGitConfig();
