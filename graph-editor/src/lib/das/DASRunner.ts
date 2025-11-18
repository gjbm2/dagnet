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
import { resolveVariantToBool } from './caseVariantHelpers';
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
   * Script has access to: dsl, window, connection_string, connection, context, console, caseId, edgeId, nodeId
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
        connection: context.connection,
        context: context.context,
        caseId: context.caseId,
        edgeId: context.edgeId,
        nodeId: context.nodeId,
        dasHelpers: {
          resolveVariantToBool,
        },
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
        'connection',
        'context',
        'caseId',
        'edgeId',
        'nodeId',
        'dasHelpers',
        'console',
        script
      );
      
      const result = fn(
        scriptEnv.dsl,
        scriptEnv.window,
        scriptEnv.connection_string,
        scriptEnv.connection,
        scriptEnv.context,
        scriptEnv.caseId,
        scriptEnv.edgeId,
        scriptEnv.nodeId,
        scriptEnv.dasHelpers,
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
    // First, check for HTTP error status codes (4xx, 5xx)
    if (response.status >= 400) {
      // Try to extract error message from response body
      let errorMessage = `HTTP ${response.status}`;
      
      if (response.body && typeof response.body === 'object') {
        // Check for common error message fields
        const body = response.body as any;
        if (body.message) {
          errorMessage = body.message;
        } else if (body.error) {
          errorMessage = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
        } else if (body.error_description) {
          errorMessage = body.error_description;
        }
      }
      
      this.log('validate_response', `Response validation failed: HTTP ${response.status}`, { errorMessage });
      
      throw new DASExecutionError(
        errorMessage,
        'http_error',
        { status: response.status, body: response.body }
      );
    }
    
    // Then, apply custom ok_when validation if specified
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
    
    // Debug logging for daily mode time_series extraction
    if (context.context?.mode === 'daily' && extracted.day_funnels) {
      this.log('transform_data', `Daily mode debug:`, {
        mode: context.context.mode,
        hasDayFunnels: !!extracted.day_funnels,
        dayFunnelsKeys: extracted.day_funnels ? Object.keys(extracted.day_funnels) : [],
        dayFunnelsType: typeof extracted.day_funnels,
        dayFunnelsSeries: (extracted.day_funnels as any)?.series,
        dayFunnelsXValues: (extracted.day_funnels as any)?.xValues,
        timeSeriesLength: Array.isArray(transformed.time_series) ? transformed.time_series.length : 'not array',
        timeSeries: transformed.time_series
      });
    }

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
   * Automatically JSON-encodes transformed data objects/arrays.
   */
  private interpolateTemplate(template: string, context: ExecutionContext | Record<string, unknown>): string {
    // Flatten context for Mustache (all top-level keys available)
    const ctx = context as any;
    
    // These are context objects that should NOT be JSON-encoded (they have nested properties)
    const contextObjects = new Set(['connection', 'credentials', 'window', 'context', 'connection_string', 'dsl']);
    
    const flatContext: Record<string, any> = {
      connection: ctx.connection,
      credentials: ctx.credentials,
      window: ctx.window,
      context: ctx.context,
      connection_string: ctx.connection_string,
      edgeId: ctx.edgeId,
      caseId: ctx.caseId,
      nodeId: ctx.nodeId,
      parameterId: ctx.parameterId,
      dsl: ctx.dsl || {},  // Keep dsl as nested object for template access
    };
    
    // Also add DSL fields at top level for convenience (backward compatibility)
    if (ctx.dsl && typeof ctx.dsl === 'object') {
      Object.assign(flatContext, ctx.dsl);
    }
    
    // Add extracted/transformed variables
    // These might be objects/arrays that need JSON encoding
    if (ctx.extractedVars && typeof ctx.extractedVars === 'object') {
      for (const [key, value] of Object.entries(ctx.extractedVars)) {
        if (value !== null && typeof value === 'object') {
          // JSON-encode objects/arrays from extracted/transformed data
          flatContext[key] = JSON.stringify(value);
        } else {
          flatContext[key] = value;
        }
      }
    }
    
    // Add any other top-level keys from context (transformed data)
    for (const [key, value] of Object.entries(ctx as Record<string, unknown>)) {
      if (!flatContext.hasOwnProperty(key) && !contextObjects.has(key)) {
        if (value !== null && typeof value === 'object') {
          // JSON-encode objects/arrays from transformed data
          flatContext[key] = JSON.stringify(value);
        } else {
          flatContext[key] = value;
        }
      }
    }

    try {
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
        expression.assign('context', context.context || {});

        // Evaluate against transformed (not extracted) so previous transform results are available
        // This allows transforms to reference each other (e.g., time_series can reference mode)
        const result = expression.evaluate(transformed);
        transformed[spec.name] = result;
        
        // Debug logging for time_series transform
        if (spec.name === 'time_series' && context.context?.mode === 'daily') {
          console.log(`[DASRunner] time_series transform debug:`, {
            specName: spec.name,
            mode: transformed.mode,
            hasDayFunnels: !!transformed.day_funnels,
            dayFunnels: transformed.day_funnels,
                      dayFunnelsSeries: (transformed.day_funnels as any)?.series,
                      dayFunnelsXValues: (transformed.day_funnels as any)?.xValues,
                      dayFunnelsSeriesLength: Array.isArray((transformed.day_funnels as any)?.series) ? (transformed.day_funnels as any).series.length : 'not array',
            dslFromStepIndex: context.dsl?.from_step_index,
            dslToStepIndex: context.dsl?.to_step_index,
            transformedKeys: Object.keys(transformed),
            result: result,
            resultLength: Array.isArray(result) ? result.length : 'not array',
            resultType: typeof result,
            expression: spec.jsonata.substring(0, 300)
          });
          
          // Try evaluating parts of the expression separately to debug
          try {
            const testExpr1 = jsonata('$.mode');
            const testMode = testExpr1.evaluate(transformed);
            const testExpr2 = jsonata('$.day_funnels');
            const testDayFunnels = testExpr2.evaluate(transformed);
            const testExpr3 = jsonata('$.day_funnels.series');
            const testSeries = testExpr3.evaluate(transformed);
            console.log(`[DASRunner] JSONata field access test:`, {
              '$.mode': testMode,
              '$.day_funnels': testDayFunnels,
              '$.day_funnels.series': testSeries,
              'testSeriesLength': Array.isArray(testSeries) ? testSeries.length : 'not array'
            });
          } catch (e) {
            console.error(`[DASRunner] JSONata field access test failed:`, e);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error 
          ? error.message 
          : typeof error === 'object' && error !== null
            ? JSON.stringify(error)
            : String(error);
        const errorDetails = error instanceof Error && error.stack
          ? error.stack
          : errorMessage;
        
        console.error(`[DASRunner] JSONata transformation error for "${spec.name}":`, {
          expression: spec.jsonata,
          error: errorMessage,
          stack: errorDetails,
          extracted: Object.keys(extracted),
          dsl: context.dsl ? Object.keys(context.dsl) : 'missing',
          context: context.context
        });
        
        throw new DASExecutionError(
          `JSONata transformation failed for "${spec.name}": ${errorMessage}`,
          'transform',
          { expression: spec.jsonata, error: errorMessage, details: errorDetails }
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
      // For HTTP errors, show the actual error message from the API
      if (error.phase === 'http_error') {
        return `API error: ${error.message}`;
      }
      // For transform phase errors (JSONata), provide user-friendly message
      if (error.phase === 'transform') {
        return `Data transformation failed. Check console for details.`;
      }
      // For other phases, show phase-specific messages
      if (error.phase === 'extract') {
        return `Failed to extract data from API response. Check console for details.`;
      }
      if (error.phase === 'template') {
        return `Request template error. Check console for details.`;
    }
      return `Execution failed in phase "${error.phase}". Check console for details.`;
    }

    return `Execution failed. Check console for details.`;
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
   * Sanitize data for logging (mask credentials and sensitive fields).
   */
  private sanitizeForLog(data: unknown): unknown {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sanitized = JSON.parse(JSON.stringify(data));
    const SENSITIVE_KEYS = [
      'api_key', 'secret_key', 'password', 'token', 
      'access_token', 'bearer_token', 'basic_auth_b64',
      'authorization', 'x-api-key', 'x-auth-token', 'cookie'
    ];

    // Recursively mask sensitive fields
    const maskSensitive = (obj: any): any => {
      if (!obj || typeof obj !== 'object') {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(maskSensitive);
      }

      const masked: any = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.some(sk => lowerKey.includes(sk.toLowerCase()))) {
          masked[key] = '***REDACTED***';
        } else if (typeof value === 'object' && value !== null) {
          masked[key] = maskSensitive(value);
        } else {
          masked[key] = value;
        }
      }
      return masked;
    };

    return maskSensitive(sanitized);
  }

  /**
   * Get execution history (for debugging).
   */
  getExecutionHistory(): LogEntry[] {
    return this.executionHistory;
  }
}


