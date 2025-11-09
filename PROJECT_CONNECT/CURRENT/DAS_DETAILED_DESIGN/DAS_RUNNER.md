# DAS Runner - Detailed Design

**Component:** DAS Runner (Declarative Adapter System Execution Engine)  
**Status:** 🔵 Design Complete  
**Implementation Time:** 13-15 hours (Phase 2a + 2b)

---

## 1. Overview

The DAS Runner is the core execution engine that:
1. Loads connections and credentials
2. Resolves node IDs to event IDs
3. Interpolates templates with runtime values
4. Executes HTTP requests to external APIs
5. Extracts and transforms response data
6. Generates update instructions for UpdateManager

---

## 2. Portable Architecture

### 2.1 Dependency Injection

```typescript
// graph-editor/src/lib/das/DASRunner.ts
export class DASRunner {
  constructor(
    private httpExecutor: HttpExecutor,
    private credentialsManager: CredentialsManager,  // Existing!
    private connectionProvider: ConnectionProvider
  ) {}
}
```

### 2.2 Factory Pattern

```typescript
// graph-editor/src/lib/das/DASRunnerFactory.ts
export function createDASRunner(): DASRunner {
  const isBrowser = typeof window !== 'undefined';
  
  const httpExecutor = isBrowser 
    ? new BrowserHttpExecutor()
    : new ServerHttpExecutor();
  
  const connectionProvider = isBrowser
    ? new IndexedDBConnectionProvider()
    : new FileSystemConnectionProvider();
  
  // Reuse existing CredentialsManager (already portable!)
  const credentialsManager = CredentialsManager.getInstance();
  
  return new DASRunner(httpExecutor, credentialsManager, connectionProvider);
}
```

---

## 3. HttpExecutor Interface

### 3.1 Interface Definition

```typescript
// graph-editor/src/lib/das/HttpExecutor.ts
export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string;  // JSON stringified
  timeout?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: any;  // Parsed JSON
}

export interface HttpExecutor {
  execute(request: HttpRequest): Promise<HttpResponse>;
}
```

### 3.2 Browser Implementation

```typescript
export class BrowserHttpExecutor implements HttpExecutor {
  constructor(private options: { timeout?: number } = {}) {}
  
  async execute(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      req.timeout || this.options.timeout || 30000
    );
    
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${req.timeout}ms`);
      }
      throw error;
    }
  }
}
```

### 3.3 Server Implementation

```typescript
export class ServerHttpExecutor implements HttpExecutor {
  async execute(req: HttpRequest): Promise<HttpResponse> {
    // Use native fetch in Node 18+ or node-fetch
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    
    // Same logic as BrowserHttpExecutor
    // ... (implementation identical)
  }
}
```

---

## 4. ConnectionProvider Interface

### 4.1 Interface Definition

```typescript
// graph-editor/src/lib/das/ConnectionProvider.ts
export interface Connection {
  name: string;
  provider: string;
  kind: 'http' | 'sql';
  enabled: boolean;
  credsRef?: string;
  defaults?: Record<string, any>;
  connection_string_schema?: object;
  adapter: Adapter;
}

export interface ConnectionProvider {
  getConnection(name: string): Promise<Connection>;
  getAllConnections(): Promise<Connection[]>;
}
```

### 4.2 IndexedDB Implementation

```typescript
export class IndexedDBConnectionProvider implements ConnectionProvider {
  async getConnection(name: string): Promise<Connection> {
    const { db } = await import('../../db/appDatabase');
    const file = await db.files.get('connections-connections');
    
    if (!file || !file.data) {
      throw new Error('No connections.yaml file found');
    }
    
    const connection = file.data.connections.find(c => c.name === name);
    
    if (!connection) {
      const available = file.data.connections.map(c => c.name).join(', ');
      throw new Error(
        `Connection "${name}" not found. Available: ${available}`
      );
    }
    
    if (!connection.enabled) {
      throw new Error(`Connection "${name}" is disabled`);
    }
    
    return connection;
  }
  
  async getAllConnections(): Promise<Connection[]> {
    const { db } = await import('../../db/appDatabase');
    const file = await db.files.get('connections-connections');
    return file?.data?.connections || [];
  }
}
```

### 4.3 FileSystem Implementation (Server)

```typescript
export class FileSystemConnectionProvider implements ConnectionProvider {
  private connectionsPath: string;
  
  constructor(connectionsPath = './config/connections.yaml') {
    this.connectionsPath = connectionsPath;
  }
  
  async getConnection(name: string): Promise<Connection> {
    const yaml = await import('js-yaml');
    const fs = await import('fs/promises');
    
    const content = await fs.readFile(this.connectionsPath, 'utf8');
    const parsed = yaml.load(content) as any;
    
    const connection = parsed.connections.find(c => c.name === name);
    
    if (!connection) {
      throw new Error(`Connection "${name}" not found`);
    }
    
    return connection;
  }
  
  // ... getAllConnections()
}
```

---

## 5. DAS Runner Core Logic

### 5.1 Main Execute Method

```typescript
export class DASRunner {
  async execute(
    connectionName: string,
    dsl: any,
    context: {
      window?: {start: string; end: string};
      context?: Record<string, any>;
      connection_string?: string;
    }
  ): Promise<ExecutionResult> {
    try {
      // 1. Load connection
      const connection = await this.connectionProvider.getConnection(connectionName);
      
      // 2. Load credentials
      const credResult = await this.credentialsManager.loadCredentials();
      const credentials = credResult.data?.[connection.credsRef || ''] || {};
      
      // 3. Parse connection_string if provided
      const connectionString = context.connection_string 
        ? JSON.parse(context.connection_string)
        : {};
      
      // 4. Build execution context
      const execContext = {
        dsl,
        connection: connection.defaults || {},
        credentials,
        window: context.window || {},
        context: context.context || {},
        connection_string: connectionString
      };
      
      // 5. Execute adapter
      return await this.executeAdapter(connection.adapter, execContext);
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        updates: []
      };
    }
  }
}
```

### 5.2 Adapter Execution

```typescript
private async executeAdapter(
  adapter: Adapter,
  context: ExecutionContext
): Promise<ExecutionResult> {
  // Phase 1: Pre-request scripts (v2 - skip for v1)
  // const preRequestVars = await this.runPreRequestScripts(adapter.pre_request, context);
  
  // Phase 2: Build HTTP request
  const request = this.buildRequest(adapter.request, context);
  
  // Phase 3: Execute request
  const response = await this.httpExecutor.execute(request);
  
  // Phase 4: Validate response
  this.validateResponse(response, adapter.response.ok_when);
  
  // Phase 5: Extract data
  const extracted = this.extractData(response.body, adapter.response.extract, context);
  
  // Phase 6: Transform data
  const transformed = this.transformData(extracted, adapter.transform, context);
  
  // Phase 7: Build update instructions
  const updates = this.buildUpdates(transformed, adapter.upsert, context);
  
  return {
    success: true,
    updates,
    raw: transformed
  };
}
```

### 5.3 Template Interpolation

```typescript
private interpolateTemplate(template: string, context: ExecutionContext): string {
  const Mustache = require('mustache');
  
  // Flatten context for Mustache
  const flatContext = {
    ...context.dsl,
    connection: context.connection,
    credentials: context.credentials,
    window: context.window,
    context: context.context,
    connection_string: context.connection_string,
    ...context.extractedVars  // From previous phases
  };
  
  // Register custom filters
  Mustache.filters = {
    json: (value) => JSON.stringify(value),
    url_encode: (value) => encodeURIComponent(value)
  };
  
  try {
    return Mustache.render(template, flatContext);
  } catch (error) {
    throw new Error(`Template interpolation failed: ${error.message}`);
  }
}
```

### 5.4 Request Building

```typescript
private buildRequest(
  requestSpec: RequestSpec,
  context: ExecutionContext
): HttpRequest {
  // Interpolate path
  const path = this.interpolateTemplate(requestSpec.path_template, context);
  const baseUrl = context.connection.base_url || '';
  const url = baseUrl + path;
  
  // Interpolate headers
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestSpec.headers || {})) {
    headers[key] = this.interpolateTemplate(value, context);
  }
  
  // Interpolate body (if POST/PUT)
  let body: string | undefined;
  if (requestSpec.body_template && ['POST', 'PUT'].includes(requestSpec.method)) {
    body = this.interpolateTemplate(requestSpec.body_template, context);
  }
  
  return {
    url,
    method: requestSpec.method,
    headers,
    body,
    timeout: requestSpec.timeout
  };
}
```

### 5.5 Data Extraction (JMESPath)

```typescript
private extractData(
  responseBody: any,
  extractSpecs: Array<{name: string; jmes: string}>,
  context: ExecutionContext
): Record<string, any> {
  const jmespath = require('jmespath');
  const extracted: Record<string, any> = {};
  
  for (const spec of extractSpecs) {
    // Interpolate JMESPath expression (allows dynamic indices)
    const jmesPath = this.interpolateTemplate(spec.jmes, context);
    
    try {
      extracted[spec.name] = jmespath.search(responseBody, jmesPath);
    } catch (error) {
      throw new Error(
        `JMESPath extraction failed for "${spec.name}": ${error.message}\n` +
        `Path: ${jmesPath}\n` +
        `Response: ${JSON.stringify(responseBody).substring(0, 200)}`
      );
    }
  }
  
  // Add extracted vars to context for next phase
  context.extractedVars = extracted;
  
  return extracted;
}
```

### 5.6 Data Transformation (JSONata)

```typescript
private transformData(
  extracted: Record<string, any>,
  transformSpecs: Array<{name: string; jsonata: string}>,
  context: ExecutionContext
): Record<string, any> {
  const jsonata = require('jsonata');
  const transformed = {...extracted};
  
  for (const spec of transformSpecs) {
    try {
      const expression = jsonata(spec.jsonata);
      
      // Bind variables for JSONata expression
      expression.assign('extracted', extracted);
      expression.assign('context', context);
      
      transformed[spec.name] = expression.evaluate(extracted);
    } catch (error) {
      throw new Error(
        `JSONata transformation failed for "${spec.name}": ${error.message}\n` +
        `Expression: ${spec.jsonata}`
      );
    }
  }
  
  return transformed;
}
```

### 5.7 Update Generation

```typescript
private buildUpdates(
  data: Record<string, any>,
  upsertSpec: UpsertSpec,
  context: ExecutionContext
): Update[] {
  const updates: Update[] = [];
  
  for (const write of upsertSpec.writes) {
    // Interpolate target path (JSON Pointer)
    const target = this.interpolateTemplate(write.target, context);
    
    // Interpolate value
    const valueTemplate = typeof write.value === 'string' 
      ? write.value
      : JSON.stringify(write.value);
    const valueStr = this.interpolateTemplate(valueTemplate, {...context, ...data});
    
    // Parse value (may be JSON)
    let value: any;
    try {
      value = JSON.parse(valueStr);
    } catch {
      value = valueStr;  // Keep as string
    }
    
    updates.push({target, value, mode: upsertSpec.mode});
  }
  
  return updates;
}
```

---

## 6. Error Handling

### 6.1 Error Types

```typescript
export class DASExecutionError extends Error {
  constructor(
    message: string,
    public phase: string,
    public details?: any
  ) {
    super(message);
    this.name = 'DASExecutionError';
  }
}

export class CredentialsError extends DASExecutionError {
  constructor(message: string, details?: any) {
    super(message, 'credentials', details);
  }
}

export class TemplateError extends DASExecutionError {
  constructor(message: string, template: string) {
    super(message, 'template', {template});
  }
}

export class ExtractionError extends DASExecutionError {
  constructor(message: string, jmesPath: string, response: any) {
    super(message, 'extraction', {jmesPath, response});
  }
}
```

### 6.2 User-Friendly Errors

```typescript
private formatError(error: Error): string {
  if (error instanceof CredentialsError) {
    return `Missing or invalid credentials: ${error.message}\n` +
           `Check File > Credentials and ensure the required credentials are configured.`;
  }
  
  if (error instanceof TemplateError) {
    return `Template error: ${error.message}\n` +
           `Template: ${error.details.template}\n` +
           `Tip: Check that all {{variables}} are defined.`;
  }
  
  if (error instanceof ExtractionError) {
    return `Data extraction failed: ${error.message}\n` +
           `JMESPath: ${error.details.jmesPath}\n` +
           `Tip: Verify the API response format matches your extraction path.`;
  }
  
  return `Execution failed: ${error.message}`;
}
```

---

## 7. Logging & Debugging

### 7.1 Structured Logging

```typescript
private log(phase: string, message: string, data?: any) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    phase,
    message,
    data: this.sanitizeForLog(data)  // Mask credentials
  };
  
  console.log(`[DASRunner:${phase}]`, message, data);
  
  // Store in execution history (for debugging)
  this.executionHistory.push(logEntry);
}

private sanitizeForLog(data: any): any {
  if (!data) return data;
  
  const sanitized = JSON.parse(JSON.stringify(data));
  
  // Mask credentials
  if (sanitized.credentials) {
    for (const key of Object.keys(sanitized.credentials)) {
      sanitized.credentials[key] = '***';
    }
  }
  
  return sanitized;
}
```

---

## 8. Testing Strategy

See `../IMPLEMENTATION_PLAN.md` Section "Testing Strategy" for:
- Unit tests for each method
- Mock implementations
- Integration tests
- Contract tests with golden fixtures

---

## 9. Performance Considerations

### 9.1 Caching (v2)

```typescript
// Future: Add simple in-memory cache
private cache = new Map<string, {data: any; timestamp: number}>();

private getCacheKey(connection: string, dsl: any, window: any): string {
  return `${connection}:${JSON.stringify(dsl)}:${JSON.stringify(window)}`;
}
```

### 9.2 Timeout Handling

- Default timeout: 30 seconds
- Configurable per connection
- Abort controller for cleanup

### 9.3 Memory Management

- Clear execution history after N entries
- Streaming for large responses (v2)
- Pagination support (v2)

---

## 10. Implementation Checklist

Phase 2a (3 hours):
- [ ] HttpExecutor interface + BrowserHttpExecutor
- [ ] ConnectionProvider interface + IndexedDBConnectionProvider
- [ ] DASRunnerFactory with environment detection

Phase 2b (10-12 hours):
- [ ] DASRunner core class
- [ ] Mustache template interpolation
- [ ] JMESPath extraction
- [ ] JSONata transformation
- [ ] Request building logic
- [ ] Update generation
- [ ] Error handling
- [ ] Logging

**Total: 13-15 hours**

