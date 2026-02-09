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

/**
 * Derive a human-readable display name from a raw subject_id (itemKey).
 * Format: `parameter:objectId:targetUUID:slot:condIdx`
 * Returns objectId with hyphens replaced by spaces, e.g. "registration to success".
 * Falls back to the raw id if parsing fails.
 */
function humaniseSubjectId(rawId: string): string {
  const parts = rawId.split(':');
  // parts[0] = type, parts[1] = objectId (human-readable slug), parts[2] = UUID, ...
  if (parts.length >= 3 && parts[1]) {
    return parts[1].replace(/-/g, ' ');
  }
  return rawId;
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
   * Snapshot cohort maturity responses are not returned in the standard AnalysisResponse/AnalysisResult
   * shape (and multi-scenario snapshot reads return `scenarios[]` rather than `result`).
   *
   * For UI charting we normalise them into a single AnalysisResult with tabular `data` rows.
   */
  private normaliseSnapshotCohortMaturityResponse(
    raw: any,
    request: AnalysisRequest,
  ): AnalysisResponse | null {
    try {
      // If it already looks like a standard AnalysisResponse with tabular data, leave it alone.
      if (raw && typeof raw === 'object' && raw.success === true && raw.result && Array.isArray(raw.result.data)) {
        return null;
      }

      const requestedType = request?.analysis_type;

      // Helper to detect a cohort maturity "result-like" payload.
      const isCohortMaturityResult = (r: any): boolean => {
        if (!r || typeof r !== 'object') return false;
        if (r.analysis_type === 'cohort_maturity') return true;
        // Some snapshot paths may omit analysis_type but include frames.
        return Array.isArray(r.frames) && r.frames.length >= 0;
      };

      // Extract all scenario/subject blocks regardless of response shape.
      type ScenarioSubjectBlock = { scenario_id: string; subject_id: string; result: any };
      const blocks: ScenarioSubjectBlock[] = [];

      // Multi-scenario snapshot shape: { success, scenarios: [{scenario_id, subjects:[{subject_id, success, result}]}] }
      if (raw && typeof raw === 'object' && Array.isArray(raw.scenarios)) {
        for (const sc of raw.scenarios) {
          const scenarioId = sc?.scenario_id;
          if (!scenarioId || !Array.isArray(sc?.subjects)) continue;
          for (const sub of sc.subjects) {
            if (sub?.success !== true) continue;
            blocks.push({ scenario_id: scenarioId, subject_id: sub?.subject_id || 'subject', result: sub?.result });
          }
        }
      } else if (raw && typeof raw === 'object' && Array.isArray(raw.subjects)) {
        // Single scenario, multiple subjects: { success, scenario_id, subjects: [{subject_id, success, result}] }
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        for (const sub of raw.subjects) {
          if (sub?.success !== true) continue;
          blocks.push({ scenario_id: scenarioId, subject_id: sub?.subject_id || 'subject', result: sub?.result });
        }
      } else if (raw && typeof raw === 'object' && raw.result && isCohortMaturityResult(raw.result)) {
        // Single subject flattened shape: { success, scenario_id, subject_id, result: {...frames...} }
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        const subjectId = raw.subject_id || 'subject';
        blocks.push({ scenario_id: scenarioId, subject_id: subjectId, result: raw.result });
      } else if (raw && typeof raw === 'object' && isCohortMaturityResult(raw)) {
        // Extremely flattened: { analysis_type, frames, ... } (rare)
        const scenarioId = request?.scenarios?.[0]?.scenario_id || 'base';
        blocks.push({ scenario_id: scenarioId, subject_id: 'subject', result: raw });
      }

      if (blocks.length === 0) return null;

      // Only normalise when the request intends cohort maturity (or payload looks like it).
      const anyCohort = blocks.some(b => isCohortMaturityResult(b.result));
      if (!anyCohort && requestedType !== 'cohort_maturity') return null;

      // Build dimension values from request scenarios (names/colours/visibility modes).
      const scenarioDimensionValues: Record<string, DimensionValueMeta> = {};
      for (const s of request.scenarios || []) {
        if (!s?.scenario_id) continue;
        scenarioDimensionValues[s.scenario_id] = {
          name: s.name || s.scenario_id,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        };
      }

      // Aggregate to tabular rows for charting:
      // One row per (scenario_id, subject_id, as_at_date)
      const data: Array<Record<string, any>> = [];

      // Prefer metadata from the first valid block.
      const firstMeta = (() => {
        const b = blocks.find(bb => isCohortMaturityResult(bb.result));
        return b?.result || null;
      })();

      for (const b of blocks) {
        const r = b.result;
        if (!isCohortMaturityResult(r)) continue;
        const frames: any[] = Array.isArray(r.frames) ? r.frames : [];
        if (import.meta.env.DEV) {
          console.log('[GraphComputeClient] cohort_maturity block:', {
            scenario_id: b.scenario_id,
            subject_id: b.subject_id,
            framesCount: frames.length,
            frame0Keys: frames[0] ? Object.keys(frames[0]) : [],
            frame0DataPointsCount: frames[0]?.data_points?.length ?? 'N/A',
            frame0Sample: frames[0]?.data_points?.[0],
          });
        }
        for (const f of frames) {
          const asAt = f?.as_at_date || f?.retrieved_at_date || f?.date;
          if (!asAt) continue;
          const points: any[] = Array.isArray(f?.data_points) ? f.data_points : [];
          let xTotal = 0;
          let yTotal = 0;
          for (const p of points) {
            const x = Number(p?.x ?? 0);
            const y = Number(p?.y ?? 0);
            if (Number.isFinite(x)) xTotal += x;
            if (Number.isFinite(y)) yTotal += y;
          }
          const rate = xTotal > 0 ? yTotal / xTotal : null;
          if (import.meta.env.DEV) {
            console.log('[GraphComputeClient] cohort_maturity frame:', {
              asAt, pointsCount: points.length, xTotal, yTotal, rate,
            });
          }
          data.push({
            analysis_type: 'cohort_maturity',
            scenario_id: b.scenario_id,
            subject_id: b.subject_id,
            as_at_date: asAt,
            x: xTotal,
            y: yTotal,
            rate,
          });
        }
      }

      if (data.length === 0) {
        // Return a proper empty cohort maturity result (not null) so the chart
        // component receives the correct shape and can show a "no data" message
        // instead of silently falling back to the raw frames-format response.
        console.warn('[GraphComputeClient] Cohort maturity normalisation: 0 data rows from', blocks.length, 'blocks. Raw frames may be empty.');
        const emptyResult: AnalysisResult = {
          analysis_type: 'cohort_maturity',
          analysis_name: 'Cohort Maturity',
          analysis_description: 'No snapshot data found for this query and date range',
          metadata: {
            anchor_from: firstMeta?.anchor_range?.from ?? firstMeta?.anchor_from,
            anchor_to: firstMeta?.anchor_range?.to ?? firstMeta?.anchor_to,
            sweep_from: firstMeta?.sweep_range?.from ?? firstMeta?.sweep_from,
            sweep_to: firstMeta?.sweep_range?.to ?? firstMeta?.sweep_to,
            source: 'snapshot_db',
            empty: true,
          },
          semantics: {
            dimensions: [],
            metrics: [],
            chart: { recommended: 'cohort_maturity', alternatives: [] },
          },
          dimension_values: { scenario_id: scenarioDimensionValues },
          data: [],
        };
        return { success: true, result: emptyResult, query_dsl: request.query_dsl };
      }

      const dimensionValues: Record<string, Record<string, DimensionValueMeta>> = {
        scenario_id: scenarioDimensionValues,
      };

      // Add subject dimension values using human-readable labels from the request.
      // Build a lookup from subject_id → subject_label provided by the frontend.
      const subjectLabelLookup = new Map<string, string>();
      for (const sc of request.scenarios || []) {
        for (const subj of sc.snapshot_subjects || []) {
          if (subj.subject_label) {
            subjectLabelLookup.set(subj.subject_id, subj.subject_label);
          }
        }
      }
      dimensionValues.subject_id = Object.fromEntries(
        Array.from(new Set(data.map(d => String(d.subject_id)))).map((id, i) => [
          id,
          { name: subjectLabelLookup.get(id) || humaniseSubjectId(id), order: i },
        ])
      );

      const result: AnalysisResult = {
        analysis_type: 'cohort_maturity',
        analysis_name: 'Cohort Maturity',
        analysis_description: 'How conversion rates evolved over time for a cohort range',
        metadata: {
          // Preserve raw-ish metadata for debugging and future richer UI.
          anchor_from: firstMeta?.anchor_from,
          anchor_to: firstMeta?.anchor_to,
          sweep_from: firstMeta?.sweep_from,
          sweep_to: firstMeta?.sweep_to,
          // Hint to UIs that this came from snapshot reads.
          source: 'snapshot_db',
        },
        semantics: {
          dimensions: [
            { id: 'as_at_date', name: 'As-at date', type: 'time', role: 'primary' },
            { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
            { id: 'subject_id', name: 'Subject', type: 'categorical', role: 'filter' },
          ],
          metrics: [
            { id: 'rate', name: 'Conversion rate', type: 'ratio', format: 'percent', role: 'primary' },
            { id: 'x', name: 'Cohort size', type: 'count', format: 'number', role: 'secondary' },
            { id: 'y', name: 'Conversions', type: 'count', format: 'number', role: 'secondary' },
          ],
          chart: {
            recommended: 'cohort_maturity',
            alternatives: ['table'],
          },
        },
        dimension_values: dimensionValues,
        data,
      };

      return {
        success: true,
        result,
        query_dsl: request.query_dsl,
      };
    } catch (err) {
      console.error('[GraphComputeClient] Cohort maturity normalisation CRASHED:', err);
      return null;
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

    const raw = await response.json();

    // DEV diagnostic: log the raw backend response shape for snapshot analysis debugging
    if (import.meta.env.DEV && request.analysis_type === 'cohort_maturity') {
      const frames = Array.isArray(raw?.result?.frames) ? raw.result.frames : [];
      console.log('[GraphComputeClient] RAW cohort_maturity response:', {
        success: raw?.success,
        hasResult: !!raw?.result,
        resultKeys: raw?.result ? Object.keys(raw.result) : null,
        resultAnalysisType: raw?.result?.analysis_type,
        framesCount: frames.length,
        hasScenarios: Array.isArray(raw?.scenarios),
        scenariosCount: Array.isArray(raw?.scenarios) ? raw.scenarios.length : 0,
        rowsAnalysed: raw?.rows_analysed,
        error: raw?.error,
        subjectId: raw?.subject_id,
        scenarioId: raw?.scenario_id,
      });
      // Log first frame contents so we can see actual data values
      if (frames.length > 0) {
        const f0 = frames[0];
        const pts = Array.isArray(f0?.data_points) ? f0.data_points : [];
        console.log('[GraphComputeClient] cohort_maturity frame[0]:', {
          as_at_date: f0?.as_at_date,
          total_y: f0?.total_y,
          dataPointsCount: pts.length,
          dataPointsKeys: pts[0] ? Object.keys(pts[0]) : [],
          firstPoint: pts[0],
          sampleValues: pts.slice(0, 3).map((p: any) => ({ x: p?.x, y: p?.y, rate: p?.rate, anchor_day: p?.anchor_day })),
        });
      }
    }

    const normalised = this.normaliseSnapshotCohortMaturityResponse(raw, request);

    if (import.meta.env.DEV && request.analysis_type === 'cohort_maturity') {
      console.log('[GraphComputeClient] Normalisation result:', {
        didNormalise: !!normalised,
        normalisedAnalysisType: normalised?.result?.analysis_type,
        normalisedDataCount: Array.isArray(normalised?.result?.data) ? normalised.result.data.length : 'N/A',
        fallbackAnalysisType: !normalised ? raw?.result?.analysis_type : 'N/A',
      });
    }

    const result = normalised ?? raw;
    
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

    const raw = await response.json();
    const normalised = this.normaliseSnapshotCohortMaturityResponse(raw, request);
    const result = normalised ?? raw;

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
  /** Human-readable label for display (e.g. "registration → success") */
  subject_label?: string;
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

