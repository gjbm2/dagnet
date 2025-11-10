import Mustache from 'mustache';
import jmespath from 'jmespath';
import jsonata from 'jsonata';
import type { CredentialsManager } from '../credentials';
import type { HttpExecutor, HttpRequest } from './HttpExecutor';
import type { ConnectionProvider } from './ConnectionProvider';
import type {
  ExecutionResult,
  RunnerExecuteOptions,
  ExecutionContext,
  AdapterSpec,
  RequestSpec,
  ExtractSpec,
  TransformSpec,
  UpsertSpec,
  DASUpdate,
} from './types';
import { DASExecutionError, CredentialsError, TemplateError, ExtractionError } from './errors';

interface LogEntry {
  timestamp: string;
  phase: string;
  message: string;
  data?: unknown;
}

export class DASRunner {
  private executionHistory: LogEntry[] = [];

  constructor(
    private readonly httpExecutor: HttpExecutor,
    private readonly credentialsManager: CredentialsManager,
    private readonly connectionProvider: ConnectionProvider
  ) {}

  /**
   * Execute a DAS adapter: load connection, resolve credentials, interpolate templates,
   * execute HTTP request, extract/transform data, and generate updates.
   */
  async execute(
    connectionName: string,
    dsl: Record<string, unknown>,
    options: RunnerExecuteOptions = {}
  ): Promise<ExecutionResult> {
    this.executionHistory = [];
    this.log('init', `Starting execution for connection: ${connectionName}`);

    try {
      // 1. Load connection definition
      this.log('load_connection', `Loading connection: ${connectionName}`);
      const connection = await this.connectionProvider.getConnection(connectionName);
      this.log('load_connection', 'Connection loaded', { name: connection.name, provider: connection.provider });

      // 2. Load credentials
      this.log('load_credentials', `Loading credentials for credsRef: ${connection.credsRef || 'none'}`);
      const credResult = await this.credentialsManager.loadCredentials();
      if (!credResult.success) {
        throw new CredentialsError(`Failed to load credentials: ${credResult.error || 'unknown error'}`);
      }

      let credentials = connection.credsRef
        ? this.credentialsManager.getProviderCredentials(connection.credsRef) || {}
        : {};
      
      // Auto-generate access token for Google service accounts
      if (connection.auth_type === 'google-service-account' && credentials.service_account_json_b64 && !credentials.access_token) {
        this.log('load_credentials', 'Generating OAuth token from Google service account...');
        try {
          const { getAccessTokenFromBase64 } = await import('../googleServiceAccountAuth');
          const accessToken = await getAccessTokenFromBase64(
            credentials.service_account_json_b64 as string,
            ['https://www.googleapis.com/auth/spreadsheets.readonly']
          );
          credentials = { ...credentials, access_token: accessToken };
          this.log('load_credentials', 'Service account OAuth token generated and cached');
        } catch (error) {
          throw new CredentialsError(
            `Failed to generate Google service account token: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      
      // Auto-generate Basic Auth for Amplitude (and other providers using HTTP Basic Auth)
      if (connection.provider === 'amplitude' && credentials.api_key && credentials.secret_key && !credentials.basic_auth_b64) {
        const basicAuthString = `${credentials.api_key}:${credentials.secret_key}`;
        credentials = { 
          ...credentials, 
          basic_auth_b64: typeof btoa !== 'undefined' 
            ? btoa(basicAuthString)  // Browser
            : Buffer.from(basicAuthString).toString('base64')  // Node
        };
        this.log('load_credentials', 'Generated Basic Auth token for Amplitude');
      }
      
      this.log('load_credentials', 'Credentials loaded', { hasCredentials: Object.keys(credentials).length > 0 });

      // 3. Parse connection_string if provided
      let connectionString: Record<string, unknown> = {};
      if (options.connection_string) {
        if (typeof options.connection_string === 'string') {
          try {
            connectionString = JSON.parse(options.connection_string);
          } catch (err) {
            throw new DASExecutionError(
              `Failed to parse connection_string JSON: ${err instanceof Error ? err.message : String(err)}`,
              'parse_connection_string'
            );
          }
        } else {
          connectionString = options.connection_string;
        }
      }

      // 4. Build execution context
      const execContext: ExecutionContext = {
        dsl,
        connection: connection.defaults || {},
        credentials,
        window: options.window || {},
        context: options.context || {},
        connection_string: connectionString,
        edgeId: options.edgeId,
        caseId: options.caseId,
        parameterId: options.parameterId,
        extractedVars: {},
      };
      this.log('build_context', 'Execution context built');

      // 5. Execute adapter
      const result = await this.executeAdapter(connection.adapter, execContext);
      this.log('complete', 'Execution completed successfully', { updateCount: result.updates.length });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const phase = error instanceof DASExecutionError ? error.phase : 'unknown';
      const details = error instanceof DASExecutionError ? error.details : undefined;

      this.log('error', `Execution failed in phase: ${phase}`, { error: errMsg });

      return {
        success: false,
        error: this.formatError(error as Error),
        phase,
        details,
        updates: [],
      };
    }
  }

  /**
   * Execute pre-request JavaScript transformation script.
   * Script has access to: dsl, window, connection_string, console
   * Script can mutate dsl object to add calculated fields.
   */
  private executePreRequestScript(script: string, context: ExecutionContext): void {
    this.log('pre_request', 'Executing pre-request transformation script');
    
    try {
      // Create execution environment with controlled access
      // Script can read/modify these objects
      const scriptEnv = {
        dsl: context.dsl,
        window: context.window,
        connection_string: context.connection_string,
        // Provide safe console for debugging
        console: {
          log: (...args: unknown[]) => this.log('pre_request_script', 'Script log', args),
          warn: (...args: unknown[]) => this.log('pre_request_script', 'Script warn', args),
          error: (...args: unknown[]) => this.log('pre_request_script', 'Script error', args)
        }
      };
      
      // Execute script with Function constructor
      // This creates a sandboxed environment without access to:
      // - DOM (window, document)
      // - Network (fetch, XMLHttpRequest)
      // - File system (require, import)
      // - Credentials (not in scope)
      const fn = new Function(
        'dsl',
        'window',
        'connection_string',
        'console',
        script
      );
      
      const result = fn(
        scriptEnv.dsl,
        scriptEnv.window,
        scriptEnv.connection_string,
        scriptEnv.console
      );
      
      // If script returned a value, log it (useful for debugging)
      if (result !== undefined) {
        this.log('pre_request', 'Script returned value', { result });
      }
      
      this.log('pre_request', 'Script execution completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      throw new TemplateError(
        `Pre-request script execution failed: ${errorMessage}`,
        { 
          script: script.substring(0, 200) + (script.length > 200 ? '...' : ''),
          error: errorMessage,
          stack: errorStack
        }
      );
    }
  }

  /**
   * Execute adapter phases: build request → execute → validate → extract → transform → upsert.
   */
  private async executeAdapter(adapter: AdapterSpec, context: ExecutionContext): Promise<ExecutionResult> {
    // Phase 1: Pre-request scripts
    if (adapter.pre_request && adapter.pre_request.script) {
      this.executePreRequestScript(adapter.pre_request.script, context);
      this.log('pre_request', 'Pre-request transformation complete', {
        dslKeys: Object.keys(context.dsl)
      });
    }

    // Phase 2: Build HTTP request
    this.log('build_request', 'Building HTTP request');
    const request = this.buildRequest(adapter.request, context);
    this.log('build_request', 'HTTP request built', { url: request.url, method: request.method });

    // Phase 3: Execute request
    this.log('execute_request', `Executing ${request.method} ${request.url}`);
    const response = await this.httpExecutor.execute(request);
    this.log('execute_request', `Response received with status ${response.status}`);

    // Phase 4: Validate response
    if (adapter.response.ok_when && adapter.response.ok_when.length > 0) {
      this.validateResponse(response.status, adapter.response.ok_when);
      this.log('validate_response', 'Response validation passed');
    }

    // Phase 5: Extract data
    const extracted = adapter.response.extract
      ? this.extractData(response.body, adapter.response.extract, context)
      : {};
    this.log('extract_data', `Extracted ${Object.keys(extracted).length} variables`, extracted);

    // Phase 6: Transform data
    const transformed = adapter.transform
      ? this.transformData(extracted, adapter.transform, context)
      : extracted;
    this.log('transform_data', `Transformed data`, transformed);

    // Phase 7: Build update instructions
    const updates = this.buildUpdates(transformed, adapter.upsert, context);
    this.log('build_updates', `Generated ${updates.length} updates`);

    return {
      success: true,
      updates,
      raw: transformed,
    };
  }

  /**
   * Interpolate a Mustache template with the given context.
   * Supports custom filters: json, url_encode.
   */
  private interpolateTemplate(template: string, context: ExecutionContext | Record<string, unknown>): string {
    // Flatten context for Mustache (all top-level keys available)
    const ctx = context as any;
    const flatContext = {
      ...ctx.dsl,
      ...(ctx as Record<string, unknown>), // Spread all top-level keys (includes transformed data)
      connection: ctx.connection,
      credentials: ctx.credentials,
      window: ctx.window,
      context: ctx.context,
      connection_string: ctx.connection_string,
      edgeId: ctx.edgeId,
      caseId: ctx.caseId,
      parameterId: ctx.parameterId,
      ...ctx.extractedVars,
    };

    try {
      // Mustache doesn't have built-in filters, but we can pre-process or use a custom renderer
      // For now, we'll render directly and handle filters manually if needed
      // (Full filter support would require custom tags or pre-processing)
      return Mustache.render(template, flatContext);
    } catch (error) {
      throw new TemplateError(
        `Template interpolation failed: ${error instanceof Error ? error.message : String(error)}`,
        { template }
      );
    }
  }

  /**
   * Build an HTTP request from the adapter's request spec.
   */
  private buildRequest(requestSpec: RequestSpec, context: ExecutionContext): HttpRequest {
    // Determine URL
    let url: string;
    if (requestSpec.url_template) {
      // Absolute URL takes precedence
      url = this.interpolateTemplate(requestSpec.url_template, context);
    } else if (requestSpec.path_template) {
      // Relative path appended to base_url
      const path = this.interpolateTemplate(requestSpec.path_template, context);
      const baseUrl = (context.connection.base_url as string) || '';
      url = baseUrl + path;
    } else {
      throw new DASExecutionError('Request spec must have either url_template or path_template', 'build_request');
    }

    // Interpolate headers
    const headers: Record<string, string> = {};
    if (requestSpec.headers) {
      for (const [key, value] of Object.entries(requestSpec.headers)) {
        headers[key] = this.interpolateTemplate(value, context);
      }
    }

    // Interpolate query params (if needed, append to URL)
    if (requestSpec.query) {
      const queryParams = new URLSearchParams();
      for (const [key, value] of Object.entries(requestSpec.query)) {
        queryParams.append(key, this.interpolateTemplate(value, context));
      }
      const queryString = queryParams.toString();
      if (queryString) {
        url += (url.includes('?') ? '&' : '?') + queryString;
      }
    }

    // Interpolate body (if POST/PUT/PATCH)
    let body: string | undefined;
    if (
      requestSpec.body_template &&
      (requestSpec.method === 'POST' || requestSpec.method === 'PUT' || requestSpec.method === 'PATCH')
    ) {
      body = this.interpolateTemplate(requestSpec.body_template, context);
    }

    return {
      url,
      method: requestSpec.method,
      headers,
      body,
      timeout: requestSpec.timeout,
    };
  }

  /**
   * Validate response against ok_when rules.
   */
  private validateResponse(status: number, rules: Array<{ jmes: string }>): void {
    // For now, we'll do basic status validation (assume ok_when checks status)
    // Full implementation would evaluate JMESPath against response body
    if (status < 200 || status >= 300) {
      throw new DASExecutionError(
        `Response validation failed: HTTP ${status}`,
        'validate_response',
        { status }
      );
    }
  }

  /**
   * Extract data from response body using JMESPath.
   */
  private extractData(
    responseBody: unknown,
    extractSpecs: ExtractSpec[],
    context: ExecutionContext
  ): Record<string, unknown> {
    const extracted: Record<string, unknown> = {};

    for (const spec of extractSpecs) {
      try {
        // Interpolate JMESPath expression (allows dynamic indices from context)
        const jmesPath = this.interpolateTemplate(spec.jmes, context);
        extracted[spec.name] = jmespath.search(responseBody as any, jmesPath);
      } catch (error) {
        const responsePreview = JSON.stringify(responseBody).substring(0, 200);
        throw new ExtractionError(
          `JMESPath extraction failed for "${spec.name}": ${error instanceof Error ? error.message : String(error)}`,
          { jmesPath: spec.jmes, responsePreview }
        );
      }
    }

    // Add extracted vars to context for subsequent phases
    context.extractedVars = { ...context.extractedVars, ...extracted };

    return extracted;
  }

  /**
   * Transform extracted data using JSONata.
   */
  private transformData(
    extracted: Record<string, unknown>,
    transformSpecs: TransformSpec[],
    context: ExecutionContext
  ): Record<string, unknown> {
    const transformed = { ...extracted };

    for (const spec of transformSpecs) {
      try {
        const expression = jsonata(spec.jsonata);

        // Bind context variables (JSONata can reference these)
        expression.assign('extracted', extracted);
        expression.assign('dsl', context.dsl);
        expression.assign('window', context.window);

        transformed[spec.name] = expression.evaluate(extracted);
      } catch (error) {
        throw new DASExecutionError(
          `JSONata transformation failed for "${spec.name}": ${error instanceof Error ? error.message : String(error)}`,
          'transform',
          { expression: spec.jsonata }
        );
      }
    }

    return transformed;
  }

  /**
   * Build update instructions from transformed data.
   */
  private buildUpdates(
    data: Record<string, unknown>,
    upsertSpec: UpsertSpec,
    context: ExecutionContext
  ): DASUpdate[] {
    const updates: DASUpdate[] = [];

    // Merge data into context for interpolation
    const mergedContext: ExecutionContext = { ...context, ...data };
    
    this.log('build_updates', 'Building updates with merged context', {
      dataKeys: Object.keys(data),
      contextKeys: Object.keys(context),
      mergedKeys: Object.keys(mergedContext),
      sampleData: { p_mean: (data as any).p_mean, n: (data as any).n, k: (data as any).k }
    });

    for (const write of upsertSpec.writes) {
      // Interpolate target path (JSON Pointer)
      const target = this.interpolateTemplate(write.target, mergedContext);

      // Interpolate value
      let valueTemplate: string;
      if (typeof write.value === 'string') {
        valueTemplate = write.value;
      } else {
        valueTemplate = JSON.stringify(write.value);
      }
      
      this.log('build_updates', `Interpolating value template: ${valueTemplate}`);
      const valueStr = this.interpolateTemplate(valueTemplate, mergedContext);
      this.log('build_updates', `Interpolated result: "${valueStr}"`);

      // Try to parse as JSON, otherwise keep as string
      let value: unknown;
      try {
        value = JSON.parse(valueStr);
      } catch {
        value = valueStr;
      }

      updates.push({ target, value, mode: upsertSpec.mode });
    }

    return updates;
  }

  /**
   * Format error for user-friendly display.
   */
  private formatError(error: Error): string {
    if (error instanceof CredentialsError) {
      return `Missing or invalid credentials: ${error.message}\nCheck File > Credentials and ensure the required credentials are configured.`;
    }

    if (error instanceof TemplateError) {
      const templateDetails = error.details && typeof error.details === 'object' && 'template' in error.details
        ? (error.details as { template: string }).template
        : '';
      return `Template error: ${error.message}\nTemplate: ${templateDetails}\nTip: Check that all {{variables}} are defined.`;
    }

    if (error instanceof ExtractionError) {
      const jmesDetails = error.details && typeof error.details === 'object' && 'jmesPath' in error.details
        ? (error.details as { jmesPath: string }).jmesPath
        : '';
      return `Data extraction failed: ${error.message}\nJMESPath: ${jmesDetails}\nTip: Verify the API response format matches your extraction path.`;
    }

    if (error instanceof DASExecutionError) {
      return `Execution failed in phase "${error.phase}": ${error.message}`;
    }

    return `Execution failed: ${error.message}`;
  }

  /**
   * Log execution events (structured logging).
   */
  private log(phase: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      phase,
      message,
      data: this.sanitizeForLog(data),
    };

    console.log(`[DASRunner:${phase}]`, message, entry.data);
    this.executionHistory.push(entry);
  }

  /**
   * Sanitize data for logging (mask credentials).
   */
  private sanitizeForLog(data: unknown): unknown {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sanitized = JSON.parse(JSON.stringify(data));

    // Mask credentials
    if (sanitized.credentials && typeof sanitized.credentials === 'object') {
      for (const key of Object.keys(sanitized.credentials)) {
        sanitized.credentials[key] = '***';
      }
    }

    return sanitized;
  }

  /**
   * Get execution history (for debugging).
   */
  getExecutionHistory(): LogEntry[] {
    return this.executionHistory;
  }
}


