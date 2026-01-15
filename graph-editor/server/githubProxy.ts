/**
 * GitHub Proxy Server Middleware (Dev)
 *
 * Motivation:
 * Browser → https://api.github.com with `Authorization` triggers an OPTIONS preflight.
 * GitHub does not reliably CORS-allow that preflight, causing live share to hard-fail.
 *
 * Fix:
 * Proxy GitHub API calls through same-origin (/api/github-proxy/*) in dev server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const GITHUB_API_BASE = 'https://api.github.com';
const PREFIX = '/api/github-proxy';

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return undefined;
}

function pickForwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = [
    'accept',
    'authorization',
    'content-type',
    'if-none-match',
    'if-modified-since',
  ];
  for (const k of allow) {
    const v = getHeader(req, k);
    if (v) out[k] = v;
  }
  // GitHub can be picky; provide a UA if none present (server-side only).
  out['user-agent'] = out['user-agent'] || 'DagNet-Dev-GitHub-Proxy';
  return out;
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleGithubProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url?.startsWith(PREFIX)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Basic CORS support (helps embeds calling our proxy endpoint).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, If-None-Match, If-Modified-Since');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  const rest = req.url.substring(PREFIX.length) || '/';
  const targetUrl = `${GITHUB_API_BASE}${rest.startsWith('/') ? '' : '/'}${rest}`;

  try {
    const headers = pickForwardHeaders(req);

    const init: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      const body = await readBody(req);
      if (body && body.length > 0) init.body = body;
    }

    const upstream = await fetch(targetUrl, init);
    const text = await upstream.text();

    // Forward minimal headers
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', contentType);
    const etag = upstream.headers.get('etag');
    if (etag) res.setHeader('ETag', etag);

    res.writeHead(upstream.status);
    res.end(text);
  } catch (e: any) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GitHub proxy failed', message: e?.message || String(e) }));
  }
}


