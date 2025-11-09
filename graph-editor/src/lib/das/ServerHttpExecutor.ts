import type { HttpExecutor, HttpRequest, HttpResponse } from './HttpExecutor';

interface ServerHttpExecutorOptions {
  defaultTimeoutMs?: number;
}

export class ServerHttpExecutor implements HttpExecutor {
  constructor(private readonly options: ServerHttpExecutorOptions = {}) {}

  async execute(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeout ?? this.options.defaultTimeoutMs ?? 30_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchImpl = await this.getFetchImplementation();
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const rawBody = await response.text();
      const parsedBody = this.parseBody(rawBody, response.headers.get('content-type') ?? undefined);

      // Node.js Headers doesn't have .entries() method, iterate manually
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        headers,
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

  // eslint-disable-next-line class-methods-use-this
  private async getFetchImplementation(): Promise<typeof fetch> {
    if (typeof fetch !== 'undefined') {
      return fetch;
    }
    throw new Error('Global fetch API is not available in this environment.');
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


