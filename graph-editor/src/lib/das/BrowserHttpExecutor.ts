import type { HttpExecutor, HttpRequest, HttpResponse } from './HttpExecutor';

interface BrowserHttpExecutorOptions {
  defaultTimeoutMs?: number;
  useProxy?: boolean;
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

export class BrowserHttpExecutor implements HttpExecutor {
  private readonly useProxy: boolean;
  
  constructor(private readonly options: BrowserHttpExecutorOptions = {}) {
    // Use proxy by default in browser environment
    this.useProxy = options.useProxy ?? true;
  }

  async execute(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeout ?? this.options.defaultTimeoutMs ?? 30_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      
      if (this.useProxy) {
        // Send request through our proxy to avoid CORS issues
        console.log(`[BrowserHttpExecutor] Proxying ${request.method} request to:`, maskUrl(request.url));
        console.log(`[BrowserHttpExecutor] Request headers:`, maskHeaders(request.headers || {}));
        console.log(`[BrowserHttpExecutor] Request body:`, request.body?.substring(0, 200));
        
        const proxyResponse = await fetch('/api/das-proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: request.body,
          }),
          signal: controller.signal,
        });
        
        if (!proxyResponse.ok) {
          const errorData = await proxyResponse.json().catch(() => ({}));
          throw new Error(errorData.error || `Proxy request failed with status ${proxyResponse.status}`);
        }
        
        response = proxyResponse;
      } else {
        // Direct request (for local development or when proxy is disabled)
        console.log(`[BrowserHttpExecutor] Direct ${request.method} request to:`, maskUrl(request.url));
        response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      }
      
      const rawBody = await response.text();
      const parsedBody = this.parseBody(rawBody, response.headers.get('content-type') ?? undefined);

      // Convert Headers to plain object
      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });
      
      return {
        status: response.status,
        headers: headersObj,
        body: parsedBody,
        rawBody,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseBody(body: string, contentType?: string): unknown {
    if (!body) {
      return null;
    }

    const mime = contentType?.split(';')[0].trim().toLowerCase();
    if (mime === 'application/json' || mime === 'text/json' || body.trim().startsWith('{') || body.trim().startsWith('[')) {
      try {
        return JSON.parse(body);
      } catch {
        // fall through to text
      }
    }
    return body;
  }
}


