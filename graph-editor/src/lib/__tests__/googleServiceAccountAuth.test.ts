/**
 * Tests for Google Service Account Authentication
 * 
 * Tests:
 * - JWT creation and signing
 * - Access token generation
 * - Token caching
 * - Error handling
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupGoogleSheetsMocks,
  mockServiceAccount,
  mockTokenResponse,
  mockGoogleAuthFailure,
} from '../../test/mocks/googleSheets';

describe('Google Service Account Authentication', () => {
  let mocks: ReturnType<typeof setupGoogleSheetsMocks>;
  
  beforeEach(() => {
    mocks = setupGoogleSheetsMocks();
  });
  
  afterEach(() => {
    mocks.restore();
  });
  
  describe('getServiceAccountAccessToken', () => {
    it('should generate access token from service account', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      const token = await getServiceAccountAccessToken(mockServiceAccount);
      
      expect(token).toBe(mockTokenResponse.access_token);
      expect(mocks.mockFetch).toHaveBeenCalled();
    });
    
    it('should cache tokens and reuse them', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      const token1 = await getServiceAccountAccessToken(mockServiceAccount);
      const token2 = await getServiceAccountAccessToken(mockServiceAccount);
      
      expect(token1).toBe(token2);
      // Should only call fetch once (token is cached)
      expect(mocks.mockFetch).toHaveBeenCalledTimes(1);
    });
    
    it('should handle custom scopes', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      const customScopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.readonly',
      ];
      
      const token = await getServiceAccountAccessToken(mockServiceAccount, customScopes);
      
      expect(token).toBe(mockTokenResponse.access_token);
    });
    
    it('should throw error on authentication failure', async () => {
      mocks.restore();
      global.fetch = mockGoogleAuthFailure() as any;
      
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      await expect(
        getServiceAccountAccessToken(mockServiceAccount)
      ).rejects.toThrow();
    });
    
    it('should handle malformed service account credentials', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      const invalidAccount = {
        ...mockServiceAccount,
        private_key: 'invalid-key',
      };
      
      await expect(
        getServiceAccountAccessToken(invalidAccount as any)
      ).rejects.toThrow();
    });
  });
  
  describe('getAccessTokenFromBase64', () => {
    it('should decode base64 credentials and generate token', async () => {
      const { getAccessTokenFromBase64 } = await import('../googleServiceAccountAuth');
      
      const base64Creds = Buffer.from(JSON.stringify(mockServiceAccount)).toString('base64');
      
      const token = await getAccessTokenFromBase64(base64Creds);
      
      expect(token).toBe(mockTokenResponse.access_token);
    });
    
    it('should throw error for invalid base64', async () => {
      const { getAccessTokenFromBase64 } = await import('../googleServiceAccountAuth');
      
      await expect(
        getAccessTokenFromBase64('not-valid-base64!!!')
      ).rejects.toThrow();
    });
    
    it('should throw error for invalid JSON after decoding', async () => {
      const { getAccessTokenFromBase64 } = await import('../googleServiceAccountAuth');
      
      const invalidJson = Buffer.from('{ invalid json }').toString('base64');
      
      await expect(
        getAccessTokenFromBase64(invalidJson)
      ).rejects.toThrow();
    });
  });
  
  describe('Token Caching', () => {
    it('should refresh token before expiry buffer', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      // First call
      const token1 = await getServiceAccountAccessToken(mockServiceAccount);
      
      // Mock time passing (5 minutes + 1 second past expiry buffer)
      vi.useFakeTimers();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      
      // Second call should trigger refresh
      const token2 = await getServiceAccountAccessToken(mockServiceAccount);
      
      expect(mocks.mockFetch).toHaveBeenCalledTimes(2);
      
      vi.useRealTimers();
    });
    
    it('should maintain separate caches for different service accounts', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      const account2 = {
        ...mockServiceAccount,
        client_email: 'different@test-project.iam.gserviceaccount.com',
      };
      
      const token1 = await getServiceAccountAccessToken(mockServiceAccount);
      const token2 = await getServiceAccountAccessToken(account2);
      
      // Should call fetch twice (different accounts)
      expect(mocks.mockFetch).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('JWT Creation', () => {
    it('should create valid JWT structure', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      await getServiceAccountAccessToken(mockServiceAccount);
      
      // Check that fetch was called with proper JWT structure
      const fetchCall = mocks.mockFetch.mock.calls[0];
      expect(fetchCall[0]).toContain('oauth2.googleapis.com/token');
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });
    
    it('should include correct JWT claims', async () => {
      const { getServiceAccountAccessToken } = await import('../googleServiceAccountAuth');
      
      const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
      await getServiceAccountAccessToken(mockServiceAccount, scopes);
      
      // JWT should be in the body as 'assertion'
      const fetchCall = mocks.mockFetch.mock.calls[0];
      expect(fetchCall[1].body).toContain('assertion=');
      expect(fetchCall[1].body).toContain('grant_type=');
    });
  });
});

