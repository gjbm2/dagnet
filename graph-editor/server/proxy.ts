/**
 * DAS Proxy Server Middleware
 * 
 * Handles CORS and authentication for external data sources.
 * This runs in Vite dev server and can be used as middleware.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

interface ProxyRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Only handle requests to /api/das-proxy
  if (!req.url?.startsWith('/api/das-proxy')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Only allow POST for actual proxy requests
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    // Read the request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body is required' }));
      return;
    }

    const proxyRequest: ProxyRequest = JSON.parse(body);

    // Validate request
    if (!proxyRequest.url || !proxyRequest.method) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url and method are required' }));
      return;
    }

    console.log(`[DAS Proxy] ${proxyRequest.method} ${proxyRequest.url}`);
    console.log(`[DAS Proxy] Headers:`, JSON.stringify(proxyRequest.headers, null, 2));
    console.log(`[DAS Proxy] Body length:`, proxyRequest.body?.length || 0);

    // Forward the request
    const fetchOptions: RequestInit = {
      method: proxyRequest.method,
      headers: proxyRequest.headers || {},
    };

    if (proxyRequest.body && proxyRequest.method !== 'GET' && proxyRequest.method !== 'HEAD') {
      fetchOptions.body = proxyRequest.body;
    }

    const response = await fetch(proxyRequest.url, fetchOptions);
    
    // Get response body
    const responseBody = await response.text();
    
    // Forward response headers
    const responseHeaders: Record<string, string> = {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // Forward the response
    res.writeHead(response.status, responseHeaders);
    res.end(responseBody);

    console.log(`[DAS Proxy] Response: ${response.status}`);
    if (!response.ok) {
      console.log(`[DAS Proxy] Error body:`, responseBody.substring(0, 500));
    }
  } catch (error) {
    console.error('[DAS Proxy] Error:', error);
    res.writeHead(500, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ 
      error: 'Proxy request failed',
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

