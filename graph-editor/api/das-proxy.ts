/**
 * DAS Proxy API - Vercel Serverless Function
 * 
 * Handles CORS and authentication for external data sources in production.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

interface ProxyRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Mask sensitive values in headers for logging.
 */
function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'x-auth-token', 'cookie'];
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.some(h => lowerKey.includes(h))) {
      masked[key] = '***REDACTED***';
    } else {
      masked[key] = value;
    }
  }
  
  return masked;
}

/**
 * Mask sensitive values in URL (query params, auth tokens).
 */
function maskUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Mask auth in URL if present
    if (urlObj.username || urlObj.password) {
      urlObj.username = '***';
      urlObj.password = '***';
    }
    // Mask sensitive query params
    const sensitiveParams = ['token', 'api_key', 'secret', 'auth', 'password', 'key'];
    urlObj.searchParams.forEach((value, key) => {
      if (sensitiveParams.some(p => key.toLowerCase().includes(p))) {
        urlObj.searchParams.set(key, '***REDACTED***');
      }
    });
    return urlObj.toString();
  } catch {
    // If URL parsing fails, return as-is (might be relative)
    return url;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Parse request body (Vercel may or may not auto-parse depending on Content-Type)
    let proxyRequest: ProxyRequest;
    if (typeof req.body === 'string') {
      try {
        proxyRequest = JSON.parse(req.body);
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON in request body', details: e instanceof Error ? e.message : String(e) });
        return;
      }
    } else if (req.body && typeof req.body === 'object') {
      proxyRequest = req.body as ProxyRequest;
    } else {
      res.status(400).json({ error: 'Request body is required' });
      return;
    }

    // Validate request
    if (!proxyRequest.url || !proxyRequest.method) {
      res.status(400).json({ 
        error: 'url and method are required',
        received: { url: proxyRequest.url, method: proxyRequest.method, bodyType: typeof req.body }
      });
      return;
    }

    // Log with masked sensitive data
    console.log(`[DAS Proxy] ${proxyRequest.method} ${maskUrl(proxyRequest.url)}`);
    if (proxyRequest.headers) {
      console.log(`[DAS Proxy] Headers:`, maskHeaders(proxyRequest.headers));
    }

    // Forward the request
    const fetchOptions: RequestInit = {
      method: proxyRequest.method,
      headers: proxyRequest.headers || {},
    };

    if (proxyRequest.body && proxyRequest.method !== 'GET' && proxyRequest.method !== 'HEAD') {
      fetchOptions.body = proxyRequest.body;
    }

    const response = await fetch(proxyRequest.url, fetchOptions);
    
    // Get response body as text
    const responseBody = await response.text();
    
    // Forward response headers
    const contentType = response.headers.get('content-type') || 'application/json';

    console.log(`[DAS Proxy] Response: ${response.status}`);

    // Forward the response with original content type
    res.setHeader('Content-Type', contentType);
    res.status(response.status).send(responseBody);
  } catch (error) {
    console.error('[DAS Proxy] Error:', error);
    res.status(500).json({ 
      error: 'Proxy request failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

