export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RetrySpec {
  max_attempts: number;
  backoff_ms?: number;
}

export interface RequestSpec {
  method: HttpMethod;
  /** Absolute URL template. Takes precedence over path_template + connection.defaults.base_url */
  url_template?: string;
  /** Relative path template that will be appended to connection.defaults.base_url */
  path_template?: string;
  /** Optional record of query string templates */
  query?: Record<string, string>;
  /** Optional record of header templates */
  headers?: Record<string, string>;
  /** Body template (typically JSON) */
  body_template?: string;
  /** Request timeout override in milliseconds */
  timeout?: number;
  /** Optional retry configuration */
  retry?: RetrySpec;
}

export interface ResponseValidationRule {
  /** JMESPath expression that must evaluate truthy */
  jmes: string;
}

export interface ExtractSpec {
  name: string;
  /** JMESPath expression */
  jmes: string;
}

export interface TransformSpec {
  name: string;
  /** JSONata expression */
  jsonata: string;
}

export interface UpsertWriteSpec {
  /** JSON pointer template describing the update target */
  target: string;
  /**
   * Template for the value. String templates will be interpolated.
   * Objects will be stringified before interpolation.
   */
  value: string | Record<string, unknown> | number | boolean | null;
}

export interface UpsertSpec {
  mode: 'merge' | 'replace';
  writes: UpsertWriteSpec[];
}

export interface PreRequestScript {
  name?: string;
  /** JavaScript body returning a value or mutating context */
  script: string;
}

export interface ResponseSpec {
  ok_when?: ResponseValidationRule[];
  extract?: ExtractSpec[];
}

export interface AdapterSpec {
  pre_request?: PreRequestScript;  // Single script, not array (as per connections.yaml schema)
  request: RequestSpec;
  response: ResponseSpec;
  transform?: TransformSpec[];
  upsert: UpsertSpec;
}

export type ConnectionKind = 'http' | 'sql';
export type AuthType = 'google-service-account' | 'oauth' | 'basic' | 'api-key';

export interface ConnectionDefinition {
  name: string;
  provider: string;
  kind: ConnectionKind;
  auth_type?: AuthType; // Optional: how to handle authentication
  enabled?: boolean;
  credsRef?: string;
  description?: string;
  defaults?: Record<string, unknown>;
  connection_string_schema?: Record<string, unknown>;
  adapter: AdapterSpec;
  metadata?: Record<string, unknown>;
  tags?: string[];
  requires_event_ids?: boolean; // Optional: if false, skip DSL building and event_id validation (default: true)
}

export interface ConnectionFile {
  version?: string;
  connections: ConnectionDefinition[];
}

export interface ExecutionContext {
  queryPayload: Record<string, unknown>;  // Structured query data (NOT a DSL string)
  connection: Record<string, unknown>;
  credentials: Record<string, unknown>;
  window: Record<string, unknown>;
  context: Record<string, unknown>;
  connection_string: Record<string, unknown>;
  edgeId?: string;
  caseId?: string;
  nodeId?: string;  // For node-level fetches (future extensibility)
  parameterId?: string;
  extractedVars?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DASUpdate {
  target: string;
  value: unknown;
  mode: 'merge' | 'replace';
}

export interface ExecutionSuccess {
  success: true;
  updates: DASUpdate[];
  raw: Record<string, unknown>;
}

export interface ExecutionFailure {
  success: false;
  error: string;
  phase?: string;
  details?: unknown;
  updates: [];
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

export interface RunnerExecuteOptions {
  window?: { start?: string; end?: string; [key: string]: unknown };
  context?: Record<string, unknown>;
  connection_string?: string | Record<string, unknown>;
  edgeId?: string;
  caseId?: string;
  nodeId?: string;  // For node-level fetches (future extensibility)
  parameterId?: string;
  eventDefinitions?: Record<string, any>;  // Event file data for adapter to resolve provider names + filters
}


