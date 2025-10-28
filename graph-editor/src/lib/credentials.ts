/**
 * Credentials Library
 * 
 * Pure library for loading credentials with strict precedence logic.
 * Works in both browser and serverless environments.
 * 
 * Precedence (exclusive, no blending):
 * 1. URL credentials (temporary, not persisted)
 * 2. System secret credentials (temporary, not persisted)  
 * 3. IndexedDB credentials (persistent, user saved)
 * 4. No credentials (public access)
 */

import { CredentialsData, CredentialLoadResult, CredentialSource } from '../types/credentials';

export class CredentialsManager {
  private static instance: CredentialsManager;
  private currentCredentials: CredentialsData | null = null;
  private currentSource: CredentialSource | null = null;

  private constructor() {}

  static getInstance(): CredentialsManager {
    if (!CredentialsManager.instance) {
      CredentialsManager.instance = new CredentialsManager();
    }
    return CredentialsManager.instance;
  }

  /**
   * Load credentials with strict precedence logic
   * This is the main entry point for all credential loading
   */
  async loadCredentials(): Promise<CredentialLoadResult> {
    try {
      // Check if all data was cleared - if so, don't load any credentials
      if (typeof window !== 'undefined' && sessionStorage.getItem('dagnet_cleared_all') === 'true') {
        console.log('CredentialsManager: All data was cleared, not loading credentials');
        sessionStorage.removeItem('dagnet_cleared_all'); // Clear the flag
        return { success: false, error: 'All data was cleared', source: 'none' };
      }

      // 1. Check URL credentials first (highest precedence)
      const urlResult = await this.loadFromURL();
      if (urlResult.success && urlResult.credentials) {
        this.currentCredentials = urlResult.credentials;
        this.currentSource = 'url';
        console.log('CredentialsManager: Loaded credentials from URL');
        return urlResult;
      }

      // 2. Check system secret credentials (only if no URL secret was provided)
      // System credentials should only be loaded when explicitly requested with a secret
      // For now, skip automatic system credential loading
      // const systemResult = await this.loadFromSystemSecret();
      // if (systemResult.success && systemResult.credentials) {
      //   this.currentCredentials = systemResult.credentials;
      //   this.currentSource = 'system';
      //   console.log('CredentialsManager: Loaded credentials from system secret');
      //   return systemResult;
      // }

      // 3. Check IndexedDB credentials (browser only)
      if (this.isBrowserEnvironment()) {
        const indexedDBResult = await this.loadFromIndexedDB();
        if (indexedDBResult.success && indexedDBResult.credentials) {
          this.currentCredentials = indexedDBResult.credentials;
          this.currentSource = 'user';
          console.log('CredentialsManager: Loaded credentials from IndexedDB');
          return indexedDBResult;
        }
      }

      // 4. No credentials available (public access)
      console.log('CredentialsManager: No credentials available, using public access');
      return {
        success: true,
        credentials: null,
        source: 'public'
      };

    } catch (error) {
      console.error('CredentialsManager: Failed to load credentials:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        source: null
      };
    }
  }

  /**
   * Get currently loaded credentials
   */
  getCurrentCredentials(): CredentialsData | null {
    return this.currentCredentials;
  }

  /**
   * Get current credential source
   */
  getCurrentSource(): CredentialSource | null {
    return this.currentSource;
  }

  /**
   * Check if current credentials should be persisted
   * URL credentials should never be persisted
   */
  shouldPersistCredentials(): boolean {
    return this.currentSource !== 'url';
  }

  /**
   * Get default Git repository credentials
   */
  getDefaultGitCredentials(): CredentialsData['git'][0] | null {
    if (!this.currentCredentials?.git?.length) return null;
    
    const defaultRepo = this.currentCredentials.defaultGitRepo || 'nous-conversion';
    return this.currentCredentials.git.find(repo => repo.name === defaultRepo) || this.currentCredentials.git[0];
  }

  /**
   * Load credentials from URL parameters
   * Supports: ?secret=<secret_key> or ?creds=<json_credentials>
   */
  private async loadFromURL(): Promise<CredentialLoadResult> {
    if (!this.isBrowserEnvironment()) {
      return { success: false, error: 'URL credentials not available in serverless environment', source: 'url' };
    }

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const secret = urlParams.get('secret');
      const creds = urlParams.get('creds');
      
      // Check for secret key first
      if (secret) {
        console.log('🔧 CredentialsManager: Found secret in URL, loading system credentials...');
        return await this.loadFromSystemSecret(secret);
      }
      
      // Check for direct JSON credentials
      if (creds) {
        console.log('🔧 CredentialsManager: Found credentials in URL...');
        let credentials: CredentialsData;
        
        try {
          // Try to parse as JSON first
          credentials = JSON.parse(creds);
        } catch (parseError) {
          // If JSON parsing fails, try to decrypt
          console.log('🔧 CredentialsManager: JSON parse failed, trying decryption...');
          credentials = await this.decryptCredentials(creds);
        }
        
        if (!this.validateCredentials(credentials)) {
          return { success: false, error: 'Invalid credentials format in URL', source: 'url' };
        }

        return {
          success: true,
          credentials,
          source: 'url'
        };
      }
      
      return { success: false, error: 'No credentials or secret in URL', source: 'url' };
    } catch (error) {
      console.error('CredentialsManager: Failed to load from URL:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load URL credentials',
        source: 'url'
      };
    }
  }

  /**
   * Load credentials from system secret
   * This would be implemented in serverless functions
   */
  private async loadFromSystemSecret(providedSecret?: string): Promise<CredentialLoadResult> {
    try {
      console.log('🔧 CredentialsManager: Loading from system secret...');
      // Check for credentials JSON in environment variables
      const credentialsJson = import.meta.env.VITE_CREDENTIALS_JSON;
      const credentialsSecret = import.meta.env.VITE_CREDENTIALS_SECRET;
      
      console.log('🔧 CredentialsManager: VITE_CREDENTIALS_JSON exists:', !!credentialsJson);
      console.log('🔧 CredentialsManager: VITE_CREDENTIALS_SECRET exists:', !!credentialsSecret);
      console.log('🔧 CredentialsManager: Raw JSON (first 100 chars):', credentialsJson?.substring(0, 100));
      
      if (!credentialsJson) {
        console.log('🔧 CredentialsManager: No credentials JSON in environment');
        return { success: false, error: 'No credentials JSON in environment', source: 'system' };
      }

      // If a secret is provided via URL, validate it against the environment secret
      if (providedSecret) {
        if (!credentialsSecret) {
          console.log('🔧 CredentialsManager: No environment secret configured for validation');
          return { success: false, error: 'No environment secret configured for validation', source: 'system' };
        }
        
        if (providedSecret !== credentialsSecret) {
          console.log('🔧 CredentialsManager: Provided secret does not match environment secret');
          return { success: false, error: 'Invalid secret key', source: 'system' };
        }
        
        console.log('🔧 CredentialsManager: Secret validation successful');
      }

      // Parse the credentials JSON
      let credentials: CredentialsData;
      try {
        console.log('🔧 CredentialsManager: Parsing JSON...');
        credentials = JSON.parse(credentialsJson);
        console.log('🔧 CredentialsManager: Parsed credentials:', credentials);
      } catch (parseError) {
        console.error('🔧 CredentialsManager: JSON parse error:', parseError);
        return {
          success: false,
          error: 'Invalid credentials JSON format',
          source: 'system'
        };
      }

      // Validate that we have the expected structure
      if (!credentials.git || !Array.isArray(credentials.git)) {
        return {
          success: false,
          error: 'Invalid credentials structure - missing git array',
          source: 'system'
        };
      }

      console.log(`CredentialsManager: Loaded ${credentials.git.length} repositories from system credentials`);
      
      return {
        success: true,
        credentials,
        source: 'system'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load system credentials',
        source: 'system'
      };
    }
  }

  /**
   * Load credentials from IndexedDB (browser only)
   */
  private async loadFromIndexedDB(): Promise<CredentialLoadResult> {
    if (!this.isBrowserEnvironment()) {
      return { success: false, error: 'IndexedDB not available in serverless environment', source: 'user' };
    }

    try {
      console.log('🔧 CredentialsManager: Loading from IndexedDB...');
      // Dynamic import to avoid issues in serverless
      const { db } = await import('../db/appDatabase');
      
      // Load credentials from the files table (stored as credentials-credentials file)
      const credentialsFile = await db.files.get('credentials-credentials');
      console.log('🔧 CredentialsManager: Credentials file from IndexedDB:', credentialsFile);
      
      if (!credentialsFile || !credentialsFile.data) {
        console.log('🔧 CredentialsManager: No credentials file found in IndexedDB');
        return { success: false, error: 'No credentials file in IndexedDB', source: 'user' };
      }

      const credentials = credentialsFile.data;
      
      if (!this.validateCredentials(credentials)) {
        console.log('🔧 CredentialsManager: Invalid credentials format in IndexedDB');
        return { success: false, error: 'Invalid credentials format in IndexedDB', source: 'user' };
      }

      console.log(`🔧 CredentialsManager: Loaded ${credentials.git?.length || 0} repositories from IndexedDB`);
      
      return {
        success: true,
        credentials,
        source: 'user'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load IndexedDB credentials',
        source: 'user'
      };
    }
  }

  /**
   * Decrypt credentials from encrypted URL parameter
   * Future implementation for time-limited credential sharing
   */
  private async decryptCredentials(encrypted: string): Promise<CredentialsData> {
    // This would decrypt using the encryption key
    // For now, throw not implemented
    throw new Error('Credential decryption not yet implemented');
  }

  /**
   * Validate credentials structure
   */
  private validateCredentials(credentials: any): credentials is CredentialsData {
    if (!credentials || typeof credentials !== 'object') return false;
    if (!Array.isArray(credentials.git)) return false;
    if (credentials.git.length === 0) return false;
    
    // Validate each Git credential
    for (const gitCred of credentials.git) {
      if (!gitCred.name || !gitCred.owner || !gitCred.repo || !gitCred.token) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Check if running in browser environment
   */
  private isBrowserEnvironment(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  }

  /**
   * Check if running in serverless environment
   */
  private isServerlessEnvironment(): boolean {
    return typeof process !== 'undefined' && process.env.VERCEL === '1';
  }
}

// Export singleton instance
export const credentialsManager = CredentialsManager.getInstance();
