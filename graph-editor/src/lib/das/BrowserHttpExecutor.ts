import type { HttpExecutor, HttpRequest, HttpResponse } from './HttpExecutor';

interface BrowserHttpExecutorOptions {
  defaultTimeoutMs?: number;
}

export class BrowserHttpExecutor implements HttpExecutor {
  constructor(private readonly options: BrowserHttpExecutorOptions = {}) {}

  async execute(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeout ?? this.options.defaultTimeoutMs ?? 30_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log('[BrowserHttpExecutor] About to fetch:', {
        url: request.url,
        urlType: typeof request.url,
        urlLength: request.url?.length,
        urlCharCodes: request.url?.split('').map(c => c.charCodeAt(0)).join(',')
      });
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
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


