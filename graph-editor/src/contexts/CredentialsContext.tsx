/**
 * Credentials Context
 * 
 * Provides credentials management throughout the app.
 * Handles loading, saving, and validation of user credentials.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { CredentialsData, CredentialLoadResult } from '../types/credentials';
import { credentialsService } from '../services/credentialsService';

interface CredentialsContextValue {
  credentials: CredentialsData | null;
  isLoading: boolean;
  error: string | null;
  
  // Operations
  saveCredentials: (credentials: CredentialsData) => Promise<void>;
  clearCredentials: () => Promise<void>;
  refreshCredentials: () => Promise<void>;
  
  // Validation
  validateCredentials: (credentials: any) => boolean;
  
  // Default repo
  getDefaultGitCredentials: () => CredentialsData['git'][0] | null;
}

const CredentialsContext = createContext<CredentialsContextValue | null>(null);

/**
 * Credentials Provider
 */
export function CredentialsProvider({ children }: { children: React.ReactNode }) {
  const [credentials, setCredentials] = useState<CredentialsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Initialize credentials service and load user credentials
   */
  useEffect(() => {
    const initialize = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        await credentialsService.initialize();
        const loadedCredentials = credentialsService.getCredentials();
        
        setCredentials(loadedCredentials);
        console.log('CredentialsContext: Initialized with credentials:', !!loadedCredentials);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to initialize credentials';
        setError(errorMessage);
        console.error('CredentialsContext: Initialization failed:', errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    initialize();
  }, []);

  /**
   * Save credentials
   */
  const saveCredentials = useCallback(async (newCredentials: CredentialsData) => {
    try {
      setError(null);
      
      // Validate credentials
      if (!credentialsService.validateCredentials(newCredentials)) {
        throw new Error('Invalid credentials format');
      }
      
      await credentialsService.saveUserCredentials(newCredentials);
      setCredentials(newCredentials);
      
      console.log('CredentialsContext: Credentials saved successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to save credentials';
      setError(errorMessage);
      console.error('CredentialsContext: Save failed:', errorMessage);
      throw err;
    }
  }, []);

  /**
   * Clear credentials
   */
  const clearCredentials = useCallback(async () => {
    try {
      setError(null);
      
      await credentialsService.clearUserCredentials();
      setCredentials(null);
      
      console.log('CredentialsContext: Credentials cleared successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to clear credentials';
      setError(errorMessage);
      console.error('CredentialsContext: Clear failed:', errorMessage);
      throw err;
    }
  }, []);

  /**
   * Refresh credentials from storage
   */
  const refreshCredentials = useCallback(async () => {
    try {
      setError(null);
      
      await credentialsService.initialize();
      const loadedCredentials = credentialsService.getCredentials();
      
      setCredentials(loadedCredentials);
      console.log('CredentialsContext: Credentials refreshed');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to refresh credentials';
      setError(errorMessage);
      console.error('CredentialsContext: Refresh failed:', errorMessage);
    }
  }, []);

  /**
   * Validate credentials
   */
  const validateCredentials = useCallback((credentials: any) => {
    return credentialsService.validateCredentials(credentials);
  }, []);

  /**
   * Get default Git credentials
   */
  const getDefaultGitCredentials = useCallback(() => {
    return credentialsService.getDefaultGitCredentials();
  }, [credentials]);

  const value: CredentialsContextValue = {
    credentials,
    isLoading,
    error,
    saveCredentials,
    clearCredentials,
    refreshCredentials,
    validateCredentials,
    getDefaultGitCredentials
  };

  return (
    <CredentialsContext.Provider value={value}>
      {children}
    </CredentialsContext.Provider>
  );
}

/**
 * Use credentials context
 */
export function useCredentials(): CredentialsContextValue {
  const context = useContext(CredentialsContext);
  if (!context) {
    throw new Error('useCredentials must be used within a CredentialsProvider');
  }
  return context;
}
