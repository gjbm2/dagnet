import type { HttpExecutor, HttpRequest, HttpResponse } from './HttpExecutor';

interface BrowserHttpExecutorOptions {
  defaultTimeoutMs?: number;
  useProxy?: boolean;
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
        console.log(`[BrowserHttpExecutor] Proxying ${request.method} request to:`, request.url);
        console.log(`[BrowserHttpExecutor] Request headers:`, request.headers);
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
        console.log(`[BrowserHttpExecutor] Direct ${request.method} request to:`, request.url);
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
      }
      
      const rawBody = await response.text();
      const parsedBody = this.parseBody(rawBody, response.headers.get('content-type') ?? undefined);

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
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


