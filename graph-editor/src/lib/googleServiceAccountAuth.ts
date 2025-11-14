/**
 * Google Service Account Authentication
 * 
 * Generates OAuth access tokens from service account credentials.
 * Tokens are cached and auto-refreshed when expired.
 */

import { SignJWT, importPKCS8 } from 'jose';

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

interface TokenCacheEntry {
  access_token: string;
  expires_at: number; // Unix timestamp in milliseconds
}

// In-memory token cache (per service account email)
const tokenCache = new Map<string, TokenCacheEntry>();

// Token expiry buffer: refresh 5 minutes before actual expiry
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Generate an OAuth access token from a service account.
 * 
 * @param serviceAccountJson - The service account JSON object
 * @param scopes - OAuth scopes (defaults to Sheets read-only)
 * @returns Access token valid for ~1 hour
 */
export async function getServiceAccountAccessToken(
  serviceAccountJson: ServiceAccountCredentials,
  scopes: string[] = ['https://www.googleapis.com/auth/spreadsheets.readonly']
): Promise<string> {
  const cacheKey = serviceAccountJson.client_email;
  
  // Check cache first
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now() + EXPIRY_BUFFER_MS) {
    console.log('[GoogleAuth] Using cached token');
    return cached.access_token;
  }
  
  console.log('[GoogleAuth] Generating new access token...');
  
  try {
    // Step 1: Create JWT
    const now = Math.floor(Date.now() / 1000);
    const jwt = await createJWT(serviceAccountJson, scopes, now);
    
    // Step 2: Exchange JWT for access token
    const tokenResponse = await fetch(serviceAccountJson.token_uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} - ${errorText}`);
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 3600; // Default to 1 hour
    
    // Cache the token
    tokenCache.set(cacheKey, {
      access_token: accessToken,
      expires_at: Date.now() + expiresIn * 1000,
    });
    
    console.log(`[GoogleAuth] New token generated, expires in ${expiresIn}s`);
    return accessToken;
    
  } catch (error) {
    throw new Error(
      `Failed to generate service account token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Create a signed JWT for service account authentication.
 */
async function createJWT(
  serviceAccount: ServiceAccountCredentials,
  scopes: string[],
  now: number
): Promise<string> {
  // Import the private key
  const privateKey = await importPKCS8(serviceAccount.private_key, 'RS256');
  
  // Create JWT claims
  const jwt = await new SignJWT({
    scope: scopes.join(' '),
  })
    .setProtectedHeader({ alg: 'RS256', kid: serviceAccount.private_key_id })
    .setIssuer(serviceAccount.client_email)
    .setSubject(serviceAccount.client_email)
    .setAudience(serviceAccount.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600) // 1 hour from now
    .sign(privateKey);
  
  return jwt;
}

/**
 * Decode base64-encoded service account JSON and generate access token.
 * 
 * @param base64ServiceAccount - Base64-encoded service account JSON
 * @param scopes - OAuth scopes
 * @returns Access token
 */
export async function getAccessTokenFromBase64(
  base64ServiceAccount: string,
  scopes?: string[]
): Promise<string> {
  try {
    // Decode base64
    const jsonString = atob(base64ServiceAccount);
    const serviceAccount = JSON.parse(jsonString) as ServiceAccountCredentials;
    
    // Validate required fields
    if (!serviceAccount.private_key || !serviceAccount.client_email || !serviceAccount.token_uri) {
      throw new Error('Invalid service account JSON: missing required fields');
    }
    
    return await getServiceAccountAccessToken(serviceAccount, scopes);
  } catch (error) {
    throw new Error(
      `Failed to decode service account: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Clear the token cache (useful for testing or forcing refresh).
 */
export function clearTokenCache(): void {
  tokenCache.clear();
  console.log('[GoogleAuth] Token cache cleared');
}



