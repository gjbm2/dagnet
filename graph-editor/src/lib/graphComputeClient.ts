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

export interface HealthResponse {
  status: string;
  service?: string;
  env?: string;
}

export interface StatsEnhanceRequest {
  raw: {
    method: string;
    n: number;
    k: number;
    mean: number;
    stdev: number;
    raw_data?: Array<{
      date: string;
      n: number;
      k: number;
      p: number;
    }>;
    window: {
      start: string;
      end: string;
    };
    days_included: number;
    days_missing: number;
  };
  method: string;
}

export interface StatsEnhanceResponse {
  method: string;
  n: number;
  k: number;
  mean: number;
  stdev: number;
  confidence_interval?: [number, number] | null;
  trend?: {
    direction: 'increasing' | 'decreasing' | 'stable';
    slope: number;
    significance: number;
  } | null;
  metadata: {
    raw_method: string;
    enhancement_method: string;
    data_points: number;
  };
  success?: boolean;
}

// ============================================================
// GraphComputeClient
// ============================================================

// Cache entry with TTL
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class GraphComputeClient {
  private baseUrl: string;
  private useMock: boolean;
  
  // Analysis results cache - persists across component mounts
  private analysisCache: Map<string, CacheEntry<AnalysisResponse>> = new Map();
  private availableAnalysesCache: Map<string, CacheEntry<AvailableAnalysesResponse>> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 50; // Prevent unbounded growth

  constructor(baseUrl: string = API_BASE_URL, useMock: boolean = USE_MOCK) {
    this.baseUrl = baseUrl;
    this.useMock = useMock;
  }
  
  /**
   * Fast, stable hash to keep cache keys short (FNV-1a 32-bit).
   */
  private hashString(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // h *= 16777619 (with 32-bit overflow)
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16);
  }

  /**
   * Generate a stable cache key from analysis inputs
   * Uses node/edge IDs AND probability values to ensure What-If changes invalidate cache
   */
  private graphSignature(graph: any): string {
    // Extract stable identifiers from graph
    const nodeIds = (graph?.nodes || []).map((n: any) => n.id || n.uuid).sort().join(',');
    const edgeIds = (graph?.edges || []).map((e: any) => e.id || e.uuid).sort().join(',');

    // IMPORTANT: Include edge probabilities so What-If changes invalidate cache
    // This ensures that when What-If modifies probabilities, we don't return stale results
    const edgeProbs = (graph?.edges || [])
      .map((e: any) => `${e.id || e.uuid}:${(e.p?.mean ?? 0).toFixed(6)}`)
      .sort()
      .join(',');

    // Also include case variant weights for case nodes
    const caseWeights = (graph?.nodes || [])
      .filter((n: any) => n.type === 'case' && n.case?.variants)
      .map((n: any) => {
        const weights = (n.case.variants || [])
          .map((v: any) => `${v.name}:${(v.weight ?? 0).toFixed(4)}`)
          .join(';');
        return `${n.id || n.uuid}=[${weights}]`;
      })
      .sort()
      .join(',');

    return `nodes:${nodeIds}|edges:${edgeIds}|probs:${edgeProbs}|cases:${caseWeights}`;
  }

  private generateCacheKey(
    graph: any,
    queryDsl?: string,
    analysisType?: string,
    scenarioIds?: string[]
  ): string {
    const graphKey = this.hashString(this.graphSignature(graph));
    const parts = [
      `graph:${graphKey}`,
      `dsl:${queryDsl || ''}`,
      `type:${analysisType || ''}`,
      `scenarios:${(scenarioIds || []).sort().join(',')}`,
    ];
    return parts.join('|');
  }
  
  /**
   * Prune old entries if cache exceeds max size
   */
  private pruneCache<T>(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size <= this.MAX_CACHE_SIZE) return;
    
    // Remove oldest entries
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
  }
  
  /**
   * Clear all caches (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.analysisCache.clear();
    this.availableAnalysesCache.clear();
    console.log('[GraphComputeClient] Cache cleared');
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
    // Python server returns nested structure: { parsed: {...}, valid: true, ... }
    // Extract the parsed object
    return data.parsed || data;
  }

  /**
   * Generate MSMDC queries for all parameters in graph
   * Also computes anchor_node_id for each edge (furthest upstream START node)
   */
  async generateAllParameters(
    graph: any,
    downstreamOf?: string,
    literalWeights?: { visited: number; exclude: number },
    preserveCondition?: boolean,
    edgeId?: string,  // Optional: filter to specific edge
    conditionalIndex?: number  // Optional: filter to specific conditional (requires edgeId)
  ): Promise<{ parameters: ParameterQuery[]; anchors: Record<string, string | null> }> {
    if (this.useMock) {
      return { parameters: [], anchors: {} };
    }

    const response = await fetch(`${this.baseUrl}/api/generate-all-parameters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        downstream_of: downstreamOf,
        literal_weights: literalWeights,
        preserve_condition: preserveCondition,
        edge_id: edgeId,
        conditional_index: conditionalIndex
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Parameter generation failed: ${error.detail || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Enhance raw aggregation with statistical methods (MCMC, Bayesian, trend-aware, robust)
   */
  async enhanceStats(
    raw: StatsEnhanceRequest['raw'],
    method: string
  ): Promise<StatsEnhanceResponse> {
    if (this.useMock) {
      // Mock response
      return {
        method,
        n: raw.n,
        k: raw.k,
        mean: raw.mean,
        stdev: raw.stdev,
        confidence_interval: null,
        trend: null,
        metadata: {
          raw_method: raw.method,
          enhancement_method: method,
          data_points: raw.days_included,
        },
      };
    }

    const response = await fetch(`${this.baseUrl}/api/stats-enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw,
        method,
      } as StatsEnhanceRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Stats enhancement failed: ${error.detail || error.error || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Run analytics based on a DSL query
   * Results are cached to avoid expensive recomputation on re-renders
   * 
   * @param graph - Graph data (nodes, edges, policies, metadata)
   * @param queryDsl - DSL query string (e.g. "from(a).to(b).visited(c)")
   * @param scenarioId - Optional scenario identifier
   * @param analysisType - Optional analysis type override
   */
  async analyzeSelection(
    graph: any,
    queryDsl?: string,
    scenarioId: string = 'base',
    scenarioName: string = 'Current',
    scenarioColour: string = '#3b82f6',
    analysisType?: string,
    visibilityMode: 'f+e' | 'f' | 'e' = 'f+e',
    snapshotSubjects?: SnapshotSubjectPayload[]
  ): Promise<AnalysisResponse> {
    const bypassCache = (() => {
      try {
        if (typeof window === 'undefined') return false;
        const g: any = window as any;
        if (g.__dagnetComputeNoCacheOnce === true) {
          g.__dagnetComputeNoCacheOnce = false;
          return true;
        }
        if (g.__dagnetComputeNoCache === true) return true;
        const params = new URLSearchParams(window.location.search);
        return params.get('nocache') === '1' || params.get('compute_nocache') === '1';
      } catch {
        return false;
      }
    })();

    // Check cache first.
    //
    // IMPORTANT:
    // The frontend prepares analysis graphs per scenario and (when requested) bakes the chosen
    // probability basis into `edge.p.mean` (including E/F residual allocation semantics).
    //
    // Therefore the cache key should depend on:
    // - the prepared graph (including p.mean values)
    // - the query DSL + analysis type + scenario id
    // - the requested visibility mode (for labelling and runner metadata)
    const cacheKey =
      this.generateCacheKey(graph, queryDsl, analysisType, [scenarioId]) + `|vis:${visibilityMode}`;
    if (!bypassCache) {
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        console.log('[GraphComputeClient] Cache hit for analyzeSelection');
        return cached.data;
      }
    } else {
      console.log('[GraphComputeClient] Cache bypass for analyzeSelection (nocache=1)');
    }
    
    if (this.useMock) {
      // Mock response with new schema
      const result: AnalysisResponse = {
        success: true,
        result: {
          analysis_type: analysisType || 'graph_overview',
          analysis_name: 'Graph Overview',
          analysis_description: 'Mock analysis result',
          metadata: {},
          data: [{ mock: true }],
        },
        query_dsl: queryDsl,
      };
      if (!bypassCache) {
        this.analysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
      }
      return result;
    }

    const scenarioEntry: ScenarioData = {
      scenario_id: scenarioId,
      name: scenarioName,
      colour: scenarioColour,
      visibility_mode: visibilityMode,
      graph,
      ...(snapshotSubjects?.length ? { snapshot_subjects: snapshotSubjects } : {}),
    };

    const request: AnalysisRequest = {
      scenarios: [scenarioEntry],
      query_dsl: queryDsl,
      analysis_type: analysisType,
    };

    const response = await fetch(`${this.baseUrl}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
      const error = await response.json();
      throw new Error(`Analysis failed: ${error.detail || error.error || response.statusText}`);
      } else {
        throw new Error(`Analysis API unavailable (${response.status}). Ensure Python backend is running or serverless functions are deployed.`);
      }
    }

    const result = await response.json();
    
    // Cache the result unless bypassed.
    if (!bypassCache) {
      this.analysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
      this.pruneCache(this.analysisCache);
      console.log('[GraphComputeClient] Cached analyzeSelection result');
    } else {
      console.log('[GraphComputeClient] Skipped caching analyzeSelection result (nocache=1)');
    }
    
    return result;
  }

  /**
   * Run analytics across multiple scenarios
   * Results are cached to avoid expensive recomputation on re-renders
   * 
   * Each scenario should have its parameters already baked into the graph.
   * Use buildGraphForLayer() from CompositionService to prepare scenario graphs.
   * 
   * @param scenarios - Array of scenario graphs with metadata
   * @param queryDsl - DSL query string
   * @param analysisType - Optional analysis type override
   */
  async analyzeMultipleScenarios(
    scenarios: Array<{ scenario_id: string; name: string; graph: any; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e'; snapshot_subjects?: SnapshotSubjectPayload[] }>,
    queryDsl?: string,
    analysisType?: string,
  ): Promise<AnalysisResponse> {
    const bypassCache = (() => {
      try {
        if (typeof window === 'undefined') return false;
        const g: any = window as any;
        if (g.__dagnetComputeNoCacheOnce === true) {
          g.__dagnetComputeNoCacheOnce = false;
          return true;
        }
        if (g.__dagnetComputeNoCache === true) return true;
        const params = new URLSearchParams(window.location.search);
        return params.get('nocache') === '1' || params.get('compute_nocache') === '1';
      } catch {
        return false;
      }
    })();

    // Generate cache key that includes ALL scenarios' data (not just first)
    // This ensures cache invalidates when any scenario's data changes
    const scenarioIds = scenarios.map(s => s.scenario_id);
    const visibilityModes = scenarios.map(s => `${s.scenario_id}:${s.visibility_mode || 'f+e'}`).join(',');
    
    // CRITICAL:
    // Cache key must incorporate ALL scenario graphs (not just scenarios[0]),
    // otherwise DSL/window changes that only affect non-first scenarios can
    // incorrectly produce cache hits and prevent chart recomputation.
    const scenarioGraphKey = scenarios
      .map(s => `${s.scenario_id}:${this.hashString(this.graphSignature(s.graph))}`)
      .join(',');

    const cacheKey =
      `multi|graphs:${scenarioGraphKey}|dsl:${queryDsl || ''}|type:${analysisType || ''}|scenarios:${scenarioIds.join(',')}`
      + `|vis:${visibilityModes}`;
    
    // Check cache first (unless explicitly bypassed via URL params for debugging).
    if (!bypassCache) {
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        console.log('[GraphComputeClient] Cache hit for analyzeMultipleScenarios');
        return cached.data;
      }
    } else {
      console.log('[GraphComputeClient] Cache bypass for analyzeMultipleScenarios (nocache=1)');
    }
    
    if (this.useMock) {
      // Mock response with new schema
      const result: AnalysisResponse = {
        success: true,
        result: {
          analysis_type: analysisType || 'graph_overview',
          analysis_name: 'Graph Overview',
          analysis_description: 'Mock multi-scenario result',
          metadata: {},
          dimension_values: {
            scenario_id: Object.fromEntries(
              scenarios.map(s => [s.scenario_id, { name: s.name, colour: s.colour }])
            )
          },
          data: scenarios.map(s => ({ scenario_id: s.scenario_id, mock: true })),
        },
        query_dsl: queryDsl,
      };
      this.analysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    const request: AnalysisRequest = {
      scenarios: scenarios.map(s => ({
        scenario_id: s.scenario_id,
        name: s.name,
        colour: s.colour,
        visibility_mode: s.visibility_mode || 'f+e',
        graph: s.graph,
        ...(s.snapshot_subjects?.length ? { snapshot_subjects: s.snapshot_subjects } : {}),
      })),
      query_dsl: queryDsl,
      analysis_type: analysisType,
    };

    // DEV/forensics: make the exact compute boundary payload easy to copy without
    // using the Network tab (useful for diagnosing share-link discrepancies).
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      try {
        const g: any = window as any;
        g.__dagnetLastAnalyzeRequest = request;
        g.__dagnetLastAnalyzeAt = Date.now();
        g.__dagnetLastAnalyzeCacheKey = cacheKey;
        // Keep a small rolling history for quick comparisons.
        if (!Array.isArray(g.__dagnetAnalyzeHistory)) g.__dagnetAnalyzeHistory = [];
        g.__dagnetAnalyzeHistory.push({ at: g.__dagnetLastAnalyzeAt, cacheKey, request });
        if (g.__dagnetAnalyzeHistory.length > 10) g.__dagnetAnalyzeHistory.shift();
      } catch {
        // ignore
      }
      // Console log as an object so DevTools can copy it directly.
      console.log('[DagNet][Compute] /api/runner/analyze request payload (copy window.__dagnetLastAnalyzeRequest):', request);
    }

    const response = await fetch(`${this.baseUrl}/api/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Analysis failed: ${error.detail || error.error || response.statusText}`);
    }

    const result = await response.json();

    if (import.meta.env.DEV && typeof window !== 'undefined') {
      try {
        const g: any = window as any;
        g.__dagnetLastAnalyzeResponse = result;
      } catch {
        // ignore
      }
      console.log('[DagNet][Compute] /api/runner/analyze response payload (copy window.__dagnetLastAnalyzeResponse):', result);
    }
    
    // Cache the result unless bypassed.
    if (!bypassCache) {
      this.analysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
      this.pruneCache(this.analysisCache);
      console.log('[GraphComputeClient] Cached analyzeMultipleScenarios result');
    } else {
      console.log('[GraphComputeClient] Skipped caching analyzeMultipleScenarios result (nocache=1)');
    }
    
    return result;
  }

  /**
   * Get available analysis types for a DSL query
   * Results are cached to avoid expensive recomputation on re-renders
   * 
   * @param graph - Graph data
   * @param queryDSL - DSL query string (determines available analyses)
   * @param scenarioCount - Number of scenarios (affects available analyses)
   */
  async getAvailableAnalyses(
    graph: any,
    queryDSL?: string,
    scenarioCount: number = 1
  ): Promise<AvailableAnalysesResponse> {
    // Cache key includes scenario count
    const cacheKey = `available:${this.generateCacheKey(graph, queryDSL, undefined, [])}:sc${scenarioCount}`;
    
    // Check cache first
    const cached = this.availableAnalysesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      console.log('[GraphComputeClient] Cache hit for getAvailableAnalyses');
      return cached.data;
    }
    
    if (this.useMock) {
      const result: AvailableAnalysesResponse = {
        analyses: [{
          id: 'graph_overview',
          name: 'Graph Overview',
          description: 'Mock analysis type',
          is_primary: true,
        }]
      };
      this.availableAnalysesCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    const response = await fetch(`${this.baseUrl}/api/runner/available-analyses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        query_dsl: queryDSL,
        scenario_count: scenarioCount,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to get available analyses: ${error.detail || error.error || response.statusText}`);
    }

    const result = await response.json();
    
    // Cache the result
    this.availableAnalysesCache.set(cacheKey, { data: result, timestamp: Date.now() });
    this.pruneCache(this.availableAnalysesCache);
    console.log('[GraphComputeClient] Cached getAvailableAnalyses result');
    
    return result;
  }

  /**
   * Run snapshot-based analysis (lag histogram or daily conversions).
   * 
   * Queries the snapshot database and derives analytics.
   * Requires snapshot data to exist for the parameter.
   * 
   * @param request - Snapshot analysis request with param_id, date range, and analysis type
   */
  async analyzeSnapshots(request: SnapshotAnalysisRequest): Promise<SnapshotAnalysisResponse> {
    if (this.useMock) {
      console.log('[GraphComputeClient] Mock: analyzeSnapshots', request);
      return {
        success: false,
        error: 'Snapshot analysis not available in mock mode',
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/runner/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const error = await response.json();
          return {
            success: false,
            error: error.detail || error.error || `HTTP ${response.status}`,
          };
        }
        return {
          success: false,
          error: `Snapshot analysis failed: ${response.status}`,
        };
      }

      const result = await response.json();
      return {
        success: result.success ?? true,
        error: result.error,
        result: result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }
}

// ============================================================
// Types
// ============================================================

export interface ParameterQuery {
  paramType: string;
  paramId: string;
  edgeUuid?: string | null;
  edgeKey: string;
  condition?: string;
  query: string;
  nQuery?: string | null;
  stats: { checks: number; literals: number };
}

// ============================================================
// Analytics Runner Types
// ============================================================

export interface ScenarioData {
  scenario_id: string;
  name?: string;
  colour?: string;
  visibility_mode?: 'f+e' | 'f' | 'e';
  graph: any;
  param_overrides?: Record<string, any>;
  /** Per-scenario snapshot DB coordinates (only for analysis types with snapshotContract) */
  snapshot_subjects?: SnapshotSubjectPayload[];
}

export interface AnalysisRequest {
  scenarios: ScenarioData[];
  query_dsl?: string;
  analysis_type?: string;
}

/**
 * Wire-format for snapshot subjects sent to the backend.
 * Mirrors SnapshotSubjectRequest from snapshotDependencyPlanService.
 */
export interface SnapshotSubjectPayload {
  subject_id: string;
  param_id: string;
  canonical_signature: string;
  core_hash: string;
  read_mode: string;
  anchor_from: string;
  anchor_to: string;
  as_at?: string;
  sweep_from?: string;
  sweep_to?: string;
  slice_keys: string[];
  target: {
    targetId: string;
    slot?: string;
    conditionalIndex?: number;
  };
}

export interface DimensionSpec {
  id: string;
  name: string;
  type: string;  // scenario, stage, outcome, node, time, categorical, ordinal
  role: string;  // primary, secondary, filter
}

export interface MetricSpec {
  id: string;
  name: string;
  type: string;  // probability, currency, duration, count, ratio, delta
  format?: string;  // percent, currency_gbp, number
  role?: string;  // primary, secondary
}

export interface ChartSpec {
  recommended: string;  // funnel, bar, bar_grouped, line, table, comparison, single_value
  alternatives?: string[];
  hints?: Record<string, any>;
}

export interface ResultSemantics {
  dimensions: DimensionSpec[];
  metrics: MetricSpec[];
  chart: ChartSpec;
}

export interface DimensionValueMeta {
  name: string;
  colour?: string;
  order?: number;
  visibility_mode?: 'f+e' | 'f' | 'e';
  probability_label?: string;
}

export interface AnalysisResult {
  analysis_type: string;
  analysis_name: string;
  analysis_description: string;
  metadata?: Record<string, any>;
  semantics?: ResultSemantics;
  dimension_values?: Record<string, Record<string, DimensionValueMeta>>;
  data: Record<string, any>[];
}

export interface AnalysisResponse {
  success: boolean;
  result?: AnalysisResult;
  query_dsl?: string;
  error?: {
    error_type: string;
    message: string;
    details?: Record<string, any>;
  };
}

export interface AvailableAnalysis {
  id: string;
  name: string;
  description: string;
  is_primary: boolean;
}

export interface AvailableAnalysesResponse {
  analyses: AvailableAnalysis[];
}

// ============================================================
// Snapshot Analysis Types
// ============================================================

export interface SnapshotAnalysisRequest {
  snapshot_query: {
    param_id: string;
    core_hash?: string;
    anchor_from: string;  // ISO date
    anchor_to: string;    // ISO date
    slice_keys?: string[];
  };
  analysis_type: 'lag_histogram' | 'daily_conversions';
}

export interface LagHistogramResult {
  analysis_type: 'lag_histogram';
  data: Array<{ lag_days: number; conversions: number; pct: number }>;
  total_conversions: number;
  cohorts_analysed: number;
}

export interface DailyConversionsResult {
  analysis_type: 'daily_conversions';
  data: Array<{ date: string; conversions: number }>;
  total_conversions: number;
  date_range: { from: string | null; to: string | null };
}

export interface SnapshotAnalysisResponse {
  success: boolean;
  error?: string;
  result?: LagHistogramResult | DailyConversionsResult;
}

// ============================================================
// Singleton Instance
// ============================================================

export const graphComputeClient = new GraphComputeClient();

