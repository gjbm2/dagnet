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
      // 1. Check URL credentials first (highest precedence)
      const urlResult = await this.loadFromURL();
      if (urlResult.success && urlResult.credentials) {
        this.currentCredentials = urlResult.credentials;
        this.currentSource = 'url';
        console.log('CredentialsManager: Loaded credentials from URL');
        return urlResult;
      }

      // 2. Check system secret credentials
      const systemResult = await this.loadFromSystemSecret();
      if (systemResult.success && systemResult.credentials) {
        this.currentCredentials = systemResult.credentials;
        this.currentSource = 'system';
        console.log('CredentialsManager: Loaded credentials from system secret');
        return systemResult;
      }

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
   * Get default Git repository credentials
   */
  getDefaultGitCredentials(): CredentialsData['git'][0] | null {
    if (!this.currentCredentials?.git?.length) return null;
    
    const defaultRepo = this.currentCredentials.defaultGitRepo || '<private-repo>';
    return this.currentCredentials.git.find(repo => repo.name === defaultRepo) || this.currentCredentials.git[0];
  }

  /**
   * Load credentials from URL parameters
   * Format: ?creds=<encrypted_credentials>
   */
  private async loadFromURL(): Promise<CredentialLoadResult> {
    if (!this.isBrowserEnvironment()) {
      return { success: false, error: 'URL credentials not available in serverless environment', source: 'url' };
    }

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const encryptedCreds = urlParams.get('creds');
      
      if (!encryptedCreds) {
        return { success: false, error: 'No credentials in URL', source: 'url' };
      }

      // Decrypt credentials (future implementation)
      const credentials = await this.decryptCredentials(encryptedCreds);
      
      if (!this.validateCredentials(credentials)) {
        return { success: false, error: 'Invalid credentials format in URL', source: 'url' };
      }

      return {
        success: true,
        credentials,
        source: 'url'
      };
    } catch (error) {
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
  private async loadFromSystemSecret(): Promise<CredentialLoadResult> {
    try {
      // In serverless environment, this would check for system secret
      if (!this.isServerlessEnvironment()) {
        return { success: false, error: 'System secret not available in browser', source: 'system' };
      }

      // This would be implemented in Vercel functions
      // For now, return not implemented
      return {
        success: false,
        error: 'System secret loading not implemented',
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
      // Dynamic import to avoid issues in serverless
      const { db } = await import('../db/appDatabase');
      const credentials = await db.credentials.toArray();
      
      if (credentials.length === 0) {
        return { success: false, error: 'No credentials in IndexedDB', source: 'user' };
      }

      // Use the most recent credentials
      const latestCredentials = credentials[credentials.length - 1];
      
      if (!this.validateCredentials(latestCredentials)) {
        return { success: false, error: 'Invalid credentials format in IndexedDB', source: 'user' };
      }

      return {
        success: true,
        credentials: latestCredentials,
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
