/**
 * GraphComputeClient
 * 
 * Client for Python graph compute API with automatic environment detection.
 * 
 * Local dev: Uses VITE_PYTHON_API_URL (default: http://localhost:9000)
 * Production: Uses /api (Vercel serverless functions)
 * Mock mode: Returns stubbed responses (VITE_USE_MOCK_COMPUTE=true)
 * 
 * Configuration:
 * - Set VITE_PYTHON_API_URL in .env to change local Python server URL
 * - Set VITE_PYTHON_API_PORT in .env to change port (used by dev-server.py)
 * - Set VITE_USE_MOCK_COMPUTE=true for frontend-only development
 */

// Environment-aware base URL
const API_BASE_URL = import.meta.env.DEV 
  ? (import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:9000')  // Local Python dev server
  : '';                                                                 // Vercel serverless (same origin)

const USE_MOCK = import.meta.env.VITE_USE_MOCK_COMPUTE === 'true';

// ============================================================
// Request/Response Types
// ============================================================

export interface QueryParseRequest {
  query: string;
}

export interface KeyValuePair {
  key: string;
  value: string;
}

export interface QueryParseResponse {
  from_node: string;
  to_node: string;
  exclude: string[];
  visited: string[];
  context: KeyValuePair[];
  cases: KeyValuePair[];
}

export interface MSMDCRequest {
  graph: any;  // Graph type
  edge_id: string;
  condition_index: number;
}

export interface MSMDCResponse {
  query: string;
  explanation: string;
}

export interface MutationRequest {
  graph: any;
  mutation_type: 'rebalance' | 'propagate_color' | 'add_complementary';
  params: Record<string, any>;
}

export interface MutationResponse {
  graph: any;
  changes: Array<{
    entity_id: string;
    field: string;
    old_value: any;
    new_value: any;
  }>;
}

export interface AnalyticsRequest {
  graph: any;
}

export interface AnalyticsResponse {
  stats: Record<string, any>;
}

export interface HealthResponse {
  status: string;
  service?: string;
  env?: string;
}

// ============================================================
// GraphComputeClient
// ============================================================

export class GraphComputeClient {
  private baseUrl: string;
  private useMock: boolean;

  constructor(baseUrl: string = API_BASE_URL, useMock: boolean = USE_MOCK) {
    this.baseUrl = baseUrl;
    this.useMock = useMock;
  }

  /**
   * Health check
   */
  async health(): Promise<HealthResponse> {
    if (this.useMock) {
      return { status: 'ok', service: 'dagnet-graph-compute', env: 'mock' };
    }

    const response = await fetch(`${this.baseUrl}/`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Parse a query DSL string into its components
   */
  async parseQuery(queryString: string): Promise<QueryParseResponse> {
    if (this.useMock) {
      // Mock response
      return {
        from_node: 'a',
        to_node: 'b',
        exclude: [],
        visited: [],
        context: [],
        cases: [],
      };
    }

    const response = await fetch(`${this.baseUrl}/api/parse-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryString } as QueryParseRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Query parsing failed: ${error.detail || error.error || response.statusText}`);
    }

    const data = await response.json();
    return data.parsed;
  }

  /**
   * Generate MSMDC query for conditional probability
   */
  async generateMSMDCQuery(
    graph: any,
    edgeId: string,
    conditionIndex: number
  ): Promise<MSMDCResponse> {
    if (this.useMock) {
      return {
        query: `from(mock-a).to(mock-b).visited(mock-c)`,
        explanation: '[MOCK] MSMDC query generated',
      };
    }

    const response = await fetch(`${this.baseUrl}/api/msmdc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        edge_id: edgeId,
        condition_index: conditionIndex,
      } as MSMDCRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`MSMDC generation failed: ${error.detail || error.error || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Apply graph mutation (rebalancing, propagation, etc.)
   */
  async applyMutation(
    graph: any,
    mutationType: MutationRequest['mutation_type'],
    params: Record<string, any>
  ): Promise<MutationResponse> {
    if (this.useMock) {
      return {
        graph,
        changes: [],
      };
    }

    const response = await fetch(`${this.baseUrl}/api/mutations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        mutation_type: mutationType,
        params,
      } as MutationRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Mutation failed: ${error.detail || error.error || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get graph analytics/stats
   */
  async getAnalytics(graph: any): Promise<AnalyticsResponse> {
    if (this.useMock) {
      return {
        stats: {
          node_count: 0,
          edge_count: 0,
        },
      };
    }

    const response = await fetch(`${this.baseUrl}/api/analytics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph } as AnalyticsRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Analytics failed: ${error.detail || error.error || response.statusText}`);
    }

    return response.json();
  }
}

// ============================================================
// Singleton Instance
// ============================================================

export const graphComputeClient = new GraphComputeClient();

