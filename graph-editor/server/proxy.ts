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
    console.log('[DAS Proxy] Received POST request to /api/das-proxy');
    console.log('[DAS Proxy] Content-Type:', req.headers['content-type']);
    console.log('[DAS Proxy] Content-Length:', req.headers['content-length']);
    console.log('[DAS Proxy] Stream readable:', req.readable);
    console.log('[DAS Proxy] Stream readableEnded:', (req as any).readableEnded);
    
    // Read the request body using Promise-based approach (more reliable than for-await)
    let body: string;
    
    // Helper function to read stream to string
    const readStreamToString = (stream: NodeJS.ReadableStream): Promise<string> => {
      return new Promise((resolve, reject) => {
        // If stream is already ended or not readable, reject
        if ((stream as any).readableEnded || !stream.readable) {
          reject(new Error('Stream already consumed or not readable'));
          return;
        }
        
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        stream.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        stream.on('error', reject);
        
        // Ensure stream is in flowing mode
        if ((stream as any).readableFlowing === false) {
          stream.resume();
        }
      });
    };
    
    if ((req as any).body) {
      // Body already parsed (e.g., by body-parser middleware)
      body = typeof (req as any).body === 'string' 
        ? (req as any).body 
        : JSON.stringify((req as any).body);
      console.log('[DAS Proxy] Using pre-parsed body, length:', body.length);
    } else {
      // Read body from stream using Promise-based approach
      try {
        body = await readStreamToString(req);
        console.log('[DAS Proxy] Read body from stream, length:', body.length);
        console.log('[DAS Proxy] Body preview:', body.substring(0, 200));
      } catch (streamError) {
        console.error('[DAS Proxy] Error reading body stream:', streamError);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Failed to read request body',
          details: streamError instanceof Error ? streamError.message : String(streamError),
          streamState: {
            readable: req.readable,
            readableEnded: (req as any).readableEnded,
            readableFlowing: (req as any).readableFlowing
          }
        }));
        return;
      }
    }
    
    if (!body || body.trim() === '') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Request body is required',
        bodyLength: body?.length || 0,
        hasBody: !!(req as any).body
      }));
      return;
    }

    let proxyRequest: ProxyRequest;
    try {
      proxyRequest = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (e) {
      console.error('[DAS Proxy] JSON parse error:', e, 'Body:', body.substring(0, 200));
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Invalid JSON in request body',
        details: e instanceof Error ? e.message : String(e),
        bodyPreview: body.substring(0, 100)
      }));
      return;
    }

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

