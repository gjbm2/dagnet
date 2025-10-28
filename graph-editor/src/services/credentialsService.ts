/**
 * Credentials Service
 * 
 * Manages authentication credentials for external services.
 * Supports three-tier authentication: public, user, and system.
 */

import { CredentialsData, SystemCredentials, CredentialLoadResult, CredentialSource } from '../types/credentials';
import { db } from '../db/appDatabase';

export class CredentialsService {
  private static instance: CredentialsService;
  private userCredentials: CredentialsData | null = null;
  private systemCredentials: SystemCredentials | null = null;
  private isInitialized = false;

  private constructor() {}

  static getInstance(): CredentialsService {
    if (!CredentialsService.instance) {
      CredentialsService.instance = new CredentialsService();
    }
    return CredentialsService.instance;
  }

  /**
   * Initialize credentials service
   * Loads user credentials from IndexedDB and system credentials from environment
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Load user credentials from IndexedDB
      await this.loadUserCredentials();
      
      // Load system credentials from environment (if available)
      await this.loadSystemCredentials();
      
      this.isInitialized = true;
      console.log('CredentialsService: Initialized successfully');
    } catch (error) {
      console.error('CredentialsService: Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Load user credentials from IndexedDB
   */
  private async loadUserCredentials(): Promise<void> {
    try {
      const credentials = await db.credentials.toArray();
      if (credentials.length > 0) {
        // Use the most recent credentials
        this.userCredentials = credentials[credentials.length - 1];
        console.log('CredentialsService: Loaded user credentials from IndexedDB');
      } else {
        console.log('CredentialsService: No user credentials found in IndexedDB');
      }
    } catch (error) {
      console.error('CredentialsService: Failed to load user credentials:', error);
    }
  }

  /**
   * Load system credentials from environment variables
   * This would be called by Vercel functions in production
   */
  private async loadSystemCredentials(): Promise<void> {
    try {
      // In browser environment, we can't access Vercel env vars directly
      // This would be implemented in the Vercel function layer
      if (typeof window !== 'undefined') {
        console.log('CredentialsService: System credentials not available in browser environment');
        return;
      }

      // This would be implemented in serverless functions
      console.log('CredentialsService: System credentials loading not implemented for browser');
    } catch (error) {
      console.error('CredentialsService: Failed to load system credentials:', error);
    }
  }

  /**
   * Get current credentials (user or system)
   */
  getCredentials(): CredentialsData | null {
    return this.userCredentials;
  }

  /**
   * Get system credentials (for API operations)
   */
  getSystemCredentials(): SystemCredentials | null {
    return this.systemCredentials;
  }

  /**
   * Save user credentials to IndexedDB
   */
  async saveUserCredentials(credentials: CredentialsData): Promise<void> {
    try {
      // Add timestamp and source
      const credentialsWithMeta = {
        ...credentials,
        id: `user-${Date.now()}`,
        source: 'user' as CredentialSource,
        timestamp: Date.now()
      };

      await db.credentials.add(credentialsWithMeta);
      this.userCredentials = credentials;
      
      console.log('CredentialsService: Saved user credentials to IndexedDB');
    } catch (error) {
      console.error('CredentialsService: Failed to save user credentials:', error);
      throw error;
    }
  }

  /**
   * Clear all user credentials
   */
  async clearUserCredentials(): Promise<void> {
    try {
      await db.credentials.clear();
      this.userCredentials = null;
      console.log('CredentialsService: Cleared all user credentials');
    } catch (error) {
      console.error('CredentialsService: Failed to clear user credentials:', error);
    }
  }

  /**
   * Get default Git repository credentials
   */
  getDefaultGitCredentials(): CredentialsData['git'][0] | null {
    if (!this.userCredentials?.git?.length) return null;
    
    const defaultRepo = this.userCredentials.defaultGitRepo || 'nous-conversion';
    return this.userCredentials.git.find(repo => repo.name === defaultRepo) || this.userCredentials.git[0];
  }

  /**
   * Validate credentials structure
   */
  validateCredentials(credentials: any): credentials is CredentialsData {
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
   * Load credentials from URL parameter (future feature)
   */
  async loadCredentialsFromURL(encryptedData: string): Promise<CredentialLoadResult> {
    try {
      // This would decrypt the URL data using the encryption key
      // For now, return not implemented
      return {
        success: false,
        error: 'URL credential loading not yet implemented',
        source: 'url'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        source: 'url'
      };
    }
  }
}

// Export singleton instance
export const credentialsService = CredentialsService.getInstance();
