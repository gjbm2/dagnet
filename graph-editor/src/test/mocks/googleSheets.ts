/**
 * Mock for Google Sheets API and authentication
 * 
 * Provides test doubles for:
 * - Service account authentication
 * - OAuth token generation
 * - Sheets API calls
 */

import { vi } from 'vitest';

/**
 * Mock service account credentials
 */
export const mockServiceAccount = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nMOCK_PRIVATE_KEY\n-----END PRIVATE KEY-----\n',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  client_id: '123456789',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com',
};

/**
 * Mock access token response
 */
export const mockTokenResponse = {
  access_token: 'mock_access_token_12345',
  expires_in: 3600,
  token_type: 'Bearer',
};

/**
 * Mock Google Sheets data response
 */
export const mockSheetData = {
  range: 'Sheet1!A1:B10',
  majorDimension: 'ROWS',
  values: [
    ['Parameter', 'Value'],
    ['conversion_rate', '0.25'],
    ['bounce_rate', '0.45'],
    ['avg_session_duration', '180'],
  ],
};

/**
 * Mock fetch for Google OAuth token endpoint
 */
export function mockGoogleTokenFetch() {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokenResponse),
        text: () => Promise.resolve(JSON.stringify(mockTokenResponse)),
      });
    }
    
    if (url.includes('sheets.googleapis.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSheetData),
        text: () => Promise.resolve(JSON.stringify(mockSheetData)),
      });
    }
    
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

/**
 * Mock fetch for Google Sheets API with custom data
 */
export function mockGoogleSheetsFetch(customData?: any) {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokenResponse),
      });
    }
    
    if (url.includes('sheets.googleapis.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(customData || mockSheetData),
      });
    }
    
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

/**
 * Mock fetch for failed authentication
 */
export function mockGoogleAuthFailure() {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'invalid_grant' }),
        text: () => Promise.resolve('{"error":"invalid_grant"}'),
      });
    }
    
    return Promise.reject(new Error('Unexpected URL'));
  });
}

/**
 * Mock fetch for failed Sheets API call
 */
export function mockGoogleSheetsFailure() {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokenResponse),
      });
    }
    
    if (url.includes('sheets.googleapis.com')) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: { message: 'Sheet not found' } }),
        text: () => Promise.resolve('{"error":{"message":"Sheet not found"}}'),
      });
    }
    
    return Promise.reject(new Error('Unexpected URL'));
  });
}

/**
 * Mock SubtleCrypto for JWT signing
 */
export function mockSubtleCrypto() {
  return {
    importKey: vi.fn(() =>
      Promise.resolve({} as CryptoKey)
    ),
    sign: vi.fn(() =>
      Promise.resolve(new ArrayBuffer(64))
    ),
  };
}

/**
 * Create a complete mock environment for Google Sheets tests
 */
export function setupGoogleSheetsMocks() {
  const originalFetch = global.fetch;
  const originalCrypto = global.crypto;
  
  global.fetch = mockGoogleTokenFetch() as any;
  global.crypto = {
    ...global.crypto,
    subtle: mockSubtleCrypto() as any,
  };
  
  return {
    restore: () => {
      global.fetch = originalFetch;
      global.crypto = originalCrypto;
    },
    mockFetch: global.fetch as any,
  };
}

