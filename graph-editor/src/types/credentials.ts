/**
 * Credentials Types
 * 
 * TypeScript interfaces for the credentials system.
 * Supports both user credentials (browser storage) and system credentials (environment variables).
 */

export interface GitRepositoryCredential {
  name: string;
  owner: string;
  repo: string;
  token: string;
  basePath?: string;
  branch?: string;
  graphsPath?: string;
  paramsPath?: string;
  contextsPath?: string;
  casesPath?: string;
}

export interface StatsigCredential {
  token: string;
}

export interface GoogleSheetsCredential {
  token: string;
}

export interface CredentialsData {
  version?: string;
  defaultGitRepo?: string;
  git: GitRepositoryCredential[];
  statsig?: StatsigCredential;
  googleSheets?: GoogleSheetsCredential;
}

/**
 * System credentials loaded from environment variables
 * Used by Vercel functions and serverless operations
 */
export interface SystemCredentials {
  git: GitRepositoryCredential[];
  statsig?: StatsigCredential;
  googleSheets?: GoogleSheetsCredential;
  webhookSecret?: string;
}

/**
 * Credential source types
 */
export type CredentialSource = 'user' | 'system' | 'url';

/**
 * Credential loading result
 */
export interface CredentialLoadResult {
  success: boolean;
  credentials?: CredentialsData;
  error?: string;
  source?: CredentialSource;
}

/**
 * API request with credentials
 */
export interface CredentialedRequest {
  credentials: CredentialsData;
  webhookSecret?: string;
}
