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
  // Cache-buster for cohort maturity normalisation semantics. Increment when the
  // cohort_maturity result interpretation changes (e.g. progress curve / axis semantics).
  private readonly COHORT_MATURITY_CACHE_VERSION = 8;

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
   * Check whether the current compute should bypass cache.
   * Respects: clearCache() timestamp, one-shot flag, permanent flag, URL params.
   */
  private shouldBypassCache(): boolean {
    try {
      if (typeof window === 'undefined') return false;
      const g: any = globalThis as any;

      // One-shot flag (set by clearCache or refresh button).
      if (g.__dagnetComputeNoCacheOnce === true) {
        g.__dagnetComputeNoCacheOnce = false;
        return true;
      }

      // Timestamp-based: clearCache() records a timestamp. Any cache entry
      // created before that timestamp is stale. We treat this as "bypass for
      // 5 seconds after clear" so all in-flight / debounced runs bypass.
      const clearedAt = typeof g.__dagnetCacheClearedAtMs === 'number' ? g.__dagnetCacheClearedAtMs : 0;
      if (clearedAt > 0 && Date.now() - clearedAt < 5000) {
        return true;
      }

      // Permanent flag (DevTools: window.__dagnetComputeNoCache = true).
      if (g.__dagnetComputeNoCache === true) return true;

      // URL params.
      const params = new URLSearchParams(window.location.search);
      return params.get('nocache') === '1' || params.get('compute_nocache') === '1';
    } catch {
      return false;
    }
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

      // Cohort maturity epoch stitching:
      // Frontend may send multiple epoch-specific snapshot_subjects per logical subject.
      // Epoch subjects are encoded as "<baseId>::epoch:<n>" and must be stitched back
      // into a single curve for charting by collapsing subject_id to baseId.
      const collapseEpochSubjectId = (id: string): string => {
        const s = String(id || '');
        const idx = s.indexOf('::epoch:');
        return idx >= 0 ? s.slice(0, idx) : s;
      };

      // Multi-scenario snapshot shape: { success, scenarios: [{scenario_id, subjects:[{subject_id, success, result}]}] }
      if (raw && typeof raw === 'object' && Array.isArray(raw.scenarios)) {
        for (const sc of raw.scenarios) {
          const scenarioId = sc?.scenario_id;
          if (!scenarioId || !Array.isArray(sc?.subjects)) continue;
          for (const sub of sc.subjects) {
            if (sub?.success !== true) continue;
            blocks.push({ scenario_id: scenarioId, subject_id: collapseEpochSubjectId(sub?.subject_id || 'subject'), result: sub?.result });
          }
        }
      } else if (raw && typeof raw === 'object' && Array.isArray(raw.subjects)) {
        // Single scenario, multiple subjects: { success, scenario_id, subjects: [{subject_id, success, result}] }
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        for (const sub of raw.subjects) {
          if (sub?.success !== true) continue;
          blocks.push({ scenario_id: scenarioId, subject_id: collapseEpochSubjectId(sub?.subject_id || 'subject'), result: sub?.result });
        }
      } else if (raw && typeof raw === 'object' && raw.result && isCohortMaturityResult(raw.result)) {
        // Single subject flattened shape: { success, scenario_id, subject_id, result: {...frames...} }
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        const subjectId = collapseEpochSubjectId(raw.subject_id || 'subject');
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
      // One row per (scenario_id, subject_id, as_at_date).
      // If epochs overlap (should not happen), later rows overwrite deterministically.
      const dataByKey = new Map<string, Record<string, any>>();

      // Prefer metadata from the first valid block.
      const firstMeta = (() => {
        const b = blocks.find(bb => isCohortMaturityResult(bb.result));
        return b?.result || null;
      })();

      // Map (scenario_id, collapsed subject_id) → request subject payload metadata.
      const subjectPayloadByScenarioSubject = new Map<string, SnapshotSubjectPayload>();
      const subjectPayloadsByScenarioSubject = new Map<string, SnapshotSubjectPayload[]>();
      for (const sc of request.scenarios || []) {
        const scenarioId = String(sc?.scenario_id || '');
        for (const subj of sc.snapshot_subjects || []) {
          if (!subj?.subject_id) continue;
          const collapsed = collapseEpochSubjectId(subj.subject_id);
          const key = `${scenarioId}||${collapsed}`;
          subjectPayloadByScenarioSubject.set(key, subj);
          if (!subjectPayloadsByScenarioSubject.has(key)) subjectPayloadsByScenarioSubject.set(key, []);
          subjectPayloadsByScenarioSubject.get(key)!.push(subj);
        }
      }

      const pickEpochPayloadForAsAt = (key: string, asAt: string): SnapshotSubjectPayload | null => {
        const payloads = subjectPayloadsByScenarioSubject.get(key) || [];
        const candidates = payloads.filter((p) => {
          const sf = String(p?.sweep_from || '');
          const st = String(p?.sweep_to || '');
          if (!sf || !st) return false;
          // sweep_from/to are ISO dates; string compare is safe.
          return sf <= asAt && asAt <= st;
        });
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];
        // Prefer the narrowest epoch (smallest sweep span).
        const spanDays = (p: SnapshotSubjectPayload): number => {
          const sf = Date.parse(`${String(p?.sweep_from)}T00:00:00Z`);
          const st = Date.parse(`${String(p?.sweep_to)}T00:00:00Z`);
          if (Number.isNaN(sf) || Number.isNaN(st)) return Number.POSITIVE_INFINITY;
          return Math.max(0, Math.floor((st - sf) / (24 * 60 * 60 * 1000)));
        };
        return candidates.slice().sort((a, b) => spanDays(a) - spanDays(b))[0] || candidates[0];
      };

      const readLatencyDays = (graph: any, targetId: string | undefined): { t95Days: number | null; pathT95Days: number | null } => {
        if (!graph || !targetId) return { t95Days: null, pathT95Days: null };
        const edges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
        const e = edges.find((x: any) => String(x?.uuid || x?.id || '') === String(targetId));
        const t95 = e?.p?.latency?.t95 ?? e?.p?.t95 ?? null;
        const pathT95 = e?.p?.latency?.path_t95 ?? e?.p?.path_t95 ?? null;
        const t95Days = (typeof t95 === 'number' && Number.isFinite(t95)) ? t95 : null;
        const pathT95Days = (typeof pathT95 === 'number' && Number.isFinite(pathT95)) ? pathT95 : null;
        return { t95Days, pathT95Days };
      };

      const dayDiffUTC = (asAtISO: string, anchorToISO: string): number | null => {
        const t1 = Date.parse(`${asAtISO}T00:00:00Z`);
        const t0 = Date.parse(`${anchorToISO}T00:00:00Z`);
        if (Number.isNaN(t1) || Number.isNaN(t0)) return null;
        return Math.floor((t1 - t0) / (24 * 60 * 60 * 1000));
      };

      // Collect frames per (scenario, subject) so we can compute a fixed denominator X*.
      type FrameAgg = { asAt: string; x: number; y: number; a: number; pointsCount: number };
      const framesByScenarioSubject = new Map<string, FrameAgg[]>();
      // For CSV export / forensics: keep the fully detailed cohort points
      // (one row per as_at_date × anchor_day).
      const cohortPointsByKey = new Map<string, Record<string, any>>();

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
          let aTotal = 0;
          for (const p of points) {
            const x = Number(p?.x ?? 0);
            const y = Number(p?.y ?? 0);
            const a = Number(p?.a ?? 0);
            if (Number.isFinite(x)) xTotal += x;
            if (Number.isFinite(y)) yTotal += y;
            if (Number.isFinite(a)) aTotal += a;

            // Detailed export row (per cohort anchor_day).
            const anchorDay = String(p?.anchor_day || '');
            if (anchorDay) {
              const ssKey = `${b.scenario_id}||${b.subject_id}`;
              const epochPayload = pickEpochPayloadForAsAt(ssKey, String(asAt));
              const windowFrom = epochPayload?.anchor_from || firstMeta?.anchor_range?.from || firstMeta?.anchor_from;
              const windowTo = epochPayload?.anchor_to || firstMeta?.anchor_range?.to || firstMeta?.anchor_to;
              const cohortAgeDays = dayDiffUTC(String(asAt), anchorDay);
              const cohortAgeAtWindowEndDays = (windowTo && typeof windowTo === 'string')
                ? dayDiffUTC(windowTo, anchorDay)
                : null;
              const exportRow = {
                scenario_id: b.scenario_id,
                subject_id: b.subject_id,
                as_at_date: String(asAt),
                anchor_day: anchorDay,
                // Rebased time axes for chart design:
                // - cohort_age_days: "days since from-node for this cohort" at this as-at
                // - cohort_age_at_window_end_days: the max age this cohort could have reached by the window end
                //   (for the earliest cohort, this is exactly window_to - window_from).
                cohort_age_days: cohortAgeDays,
                cohort_age_at_window_end_days: cohortAgeAtWindowEndDays,
                window_from: windowFrom,
                window_to: windowTo,
                x: Number.isFinite(x) ? x : null,
                y: Number.isFinite(y) ? y : null,
                a: Number.isFinite(a) ? a : null,
                rate: (p?.rate === null || p?.rate === undefined) ? null : Number(p.rate),
                median_lag_days: (p?.median_lag_days === null || p?.median_lag_days === undefined) ? null : Number(p.median_lag_days),
                mean_lag_days: (p?.mean_lag_days === null || p?.mean_lag_days === undefined) ? null : Number(p.mean_lag_days),
                onset_delta_days: (p?.onset_delta_days === null || p?.onset_delta_days === undefined) ? null : Number(p.onset_delta_days),
                epoch_subject_id: epochPayload?.subject_id,
                epoch_sweep_from: epochPayload?.sweep_from,
                epoch_sweep_to: epochPayload?.sweep_to,
                epoch_slice_keys: Array.isArray(epochPayload?.slice_keys) ? epochPayload.slice_keys.join(' | ') : undefined,
                param_id: epochPayload?.param_id,
                core_hash: epochPayload?.core_hash,
              };
              const exportKey = `${b.scenario_id}||${b.subject_id}||${String(asAt)}||${anchorDay}`;
              cohortPointsByKey.set(exportKey, exportRow);
            }
          }
          if (import.meta.env.DEV) {
            console.log('[GraphComputeClient] cohort_maturity frame:', {
              asAt, pointsCount: points.length, xTotal, yTotal,
            });
          }
          const key = `${b.scenario_id}||${b.subject_id}`;
          if (!framesByScenarioSubject.has(key)) framesByScenarioSubject.set(key, []);
          framesByScenarioSubject.get(key)!.push({
            asAt: String(asAt),
            x: Number.isFinite(xTotal) ? xTotal : 0,
            y: Number.isFinite(yTotal) ? yTotal : 0,
            a: Number.isFinite(aTotal) ? aTotal : 0,
            pointsCount: points.length,
          });
        }
      }

      // Build rows using fixed denominator X* (per scenario+subject), and phase styling (A/B/C).
      for (const [ssKey, frames] of framesByScenarioSubject.entries()) {
        const [scenarioId, subjectId] = ssKey.split('||');
        const payloadKey = `${scenarioId}||${subjectId}`;
        const payload = subjectPayloadByScenarioSubject.get(payloadKey);
        const payloads = subjectPayloadsByScenarioSubject.get(payloadKey) || [];
        const anchorFrom =
          payloads.find((p) => typeof p?.anchor_from === 'string' && p.anchor_from)?.anchor_from
          || payload?.anchor_from
          || firstMeta?.anchor_range?.from
          || firstMeta?.anchor_from;
        const anchorTo =
          payloads.find((p) => typeof p?.anchor_to === 'string' && p.anchor_to)?.anchor_to
          || payload?.anchor_to
          || firstMeta?.anchor_range?.to
          || firstMeta?.anchor_to;
        const latency = readLatencyDays(
          (request.scenarios || []).find((s) => String(s?.scenario_id) === String(scenarioId))?.graph,
          payload?.target?.targetId,
        );

        const framesSorted = frames.slice().sort((a, b) => a.asAt.localeCompare(b.asAt));

        // Choose X*:
        // - Prefer the max X observed in the "closed" region (ageDays > path_t95) if available.
        // - Else fall back to max X overall in the sweep.
        const ages = (anchorTo && typeof anchorTo === 'string')
          ? framesSorted.map((f) => ({ asAt: f.asAt, ageDays: dayDiffUTC(f.asAt, anchorTo) }))
          : [];
        const closed = (anchorTo && latency.pathT95Days !== null)
          ? framesSorted.filter((f) => {
              const age = dayDiffUTC(f.asAt, anchorTo);
              return age !== null && age > (latency.pathT95Days as number);
            })
          : [];
        const xStar = Math.max(
          0,
          ...((closed.length > 0 ? closed : framesSorted).map((f) => f.x)),
        );

        // Enforce monotonic progress on Y (belief revision can otherwise make the curve "fall").
        let yProgress = 0;

        for (const f of framesSorted) {
          yProgress = Math.max(yProgress, f.y);
          const rateObserved = f.x > 0 ? (f.y / f.x) : null;
          const rateProgress = xStar > 0 ? (yProgress / xStar) : null;

          let phase: 'closed' | 'maturing' | 'incomplete' = 'incomplete';
          if (anchorTo && (latency.t95Days !== null || latency.pathT95Days !== null)) {
            const age = dayDiffUTC(f.asAt, anchorTo);
            if (age !== null) {
              if (latency.pathT95Days !== null && age > latency.pathT95Days) phase = 'closed';
              else if (latency.t95Days !== null && age > latency.t95Days) phase = 'maturing';
              else phase = 'incomplete';
            }
          }

          const row = {
            analysis_type: 'cohort_maturity',
            scenario_id: scenarioId,
            subject_id: subjectId,
            as_at_date: f.asAt,
            // Observed totals (as of that retrieval).
            x: f.x,
            y: f.y,
            a: f.a,
            // Progress curve fields:
            x_star: xStar,
            y_progress: yProgress,
            rate_observed: rateObserved,
            rate: rateProgress,
            // Phase for chart styling:
            cohort_phase: phase,
            anchor_from: anchorFrom,
            anchor_to: anchorTo,
            t95_days: latency.t95Days,
            path_t95_days: latency.pathT95Days,
          } as Record<string, any>;

          const k = `${scenarioId}||${subjectId}||${f.asAt}`;
          dataByKey.set(k, row);
        }
      }

      const data: Array<Record<string, any>> = Array.from(dataByKey.values())
        .sort((a, b) => {
          const sa = String(a.scenario_id || '');
          const sb = String(b.scenario_id || '');
          if (sa !== sb) return sa.localeCompare(sb);
          const ua = String(a.subject_id || '');
          const ub = String(b.subject_id || '');
          if (ua !== ub) return ua.localeCompare(ub);
          return String(a.as_at_date || '').localeCompare(String(b.as_at_date || ''));
        });

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
            subjectLabelLookup.set(collapseEpochSubjectId(subj.subject_id), subj.subject_label);
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
          anchor_from: firstMeta?.anchor_range?.from ?? firstMeta?.anchor_from,
          anchor_to: firstMeta?.anchor_range?.to ?? firstMeta?.anchor_to,
          sweep_from: firstMeta?.sweep_range?.from ?? firstMeta?.sweep_from,
          sweep_to: firstMeta?.sweep_range?.to ?? firstMeta?.sweep_to,
          // Hint to UIs that this came from snapshot reads.
          source: 'snapshot_db',
          // Export-only tables (avoid polluting the primary `data` rows used by charts).
          export_tables: {
            cohort_maturity_points: Array.from(cohortPointsByKey.values()).sort((a: any, b: any) => {
              const sa = String(a.scenario_id || '').localeCompare(String(b.scenario_id || ''));
              if (sa !== 0) return sa;
              const su = String(a.subject_id || '').localeCompare(String(b.subject_id || ''));
              if (su !== 0) return su;
              const ad = String(a.as_at_date || '').localeCompare(String(b.as_at_date || ''));
              if (ad !== 0) return ad;
              return String(a.anchor_day || '').localeCompare(String(b.anchor_day || ''));
            }),
          },
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
   * Normalise multi-scenario / multi-subject daily_conversions responses into a single
   * AnalysisResult with tabular `data` rows — one row per (scenario_id, subject_id, date).
   *
   * Each row contains { date, x, y, rate } from the backend's `rate_by_cohort` output.
   * Falls back to the raw `data` (ΔY counts) if `rate_by_cohort` is not present.
   */
  private normaliseSnapshotDailyConversionsResponse(
    raw: any,
    request: AnalysisRequest,
  ): AnalysisResponse | null {
    try {
      const requestedType = request?.analysis_type;
      if (requestedType !== 'daily_conversions') return null;

      // If it already looks like a normalised AnalysisResult, leave it alone.
      if (raw?.success === true && raw?.result?.analysis_type === 'daily_conversions'
          && Array.isArray(raw.result.data) && raw.result.data[0]?.scenario_id) {
        return null;
      }

      const isDailyConversionsResult = (r: any): boolean => {
        if (!r || typeof r !== 'object') return false;
        if (r.analysis_type === 'daily_conversions') return true;
        return Array.isArray(r.rate_by_cohort) || (Array.isArray(r.data) && r.data[0]?.conversions !== undefined);
      };

      // Extract all scenario/subject blocks (same shapes as cohort maturity).
      type Block = { scenario_id: string; subject_id: string; result: any };
      const blocks: Block[] = [];

      if (raw && Array.isArray(raw.scenarios)) {
        for (const sc of raw.scenarios) {
          const scenarioId = sc?.scenario_id;
          if (!scenarioId || !Array.isArray(sc?.subjects)) continue;
          for (const sub of sc.subjects) {
            if (sub?.success !== true) continue;
            blocks.push({ scenario_id: scenarioId, subject_id: sub?.subject_id || 'subject', result: sub?.result });
          }
        }
      } else if (raw && Array.isArray(raw.subjects)) {
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        for (const sub of raw.subjects) {
          if (sub?.success !== true) continue;
          blocks.push({ scenario_id: scenarioId, subject_id: sub?.subject_id || 'subject', result: sub?.result });
        }
      } else if (raw?.success === true && isDailyConversionsResult(raw?.result)) {
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        const subjectId = raw.subject_id || 'subject';
        blocks.push({ scenario_id: scenarioId, subject_id: subjectId, result: raw.result });
      }

      if (blocks.length === 0) return null;
      if (!blocks.some(b => isDailyConversionsResult(b.result))) return null;

      // Build dimension values from request scenarios.
      const scenarioDimensionValues: Record<string, DimensionValueMeta> = {};
      for (const s of request.scenarios || []) {
        if (!s?.scenario_id) continue;
        scenarioDimensionValues[s.scenario_id] = {
          name: s.name || s.scenario_id,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        };
      }

      // Flatten into tabular data rows.
      const data: Array<Record<string, any>> = [];
      let globalDateFrom: string | null = null;
      let globalDateTo: string | null = null;
      let globalTotalConversions = 0;

      for (const b of blocks) {
        const r = b.result;
        if (!isDailyConversionsResult(r)) continue;

        globalTotalConversions += r.total_conversions || 0;
        const dateRange = r.date_range;
        if (dateRange?.from && (!globalDateFrom || dateRange.from < globalDateFrom)) {
          globalDateFrom = dateRange.from;
        }
        if (dateRange?.to && (!globalDateTo || dateRange.to > globalDateTo)) {
          globalDateTo = dateRange.to;
        }

        // Prefer rate_by_cohort (Y/X per anchor_day) for charting.
        const rateRows: any[] = Array.isArray(r.rate_by_cohort) ? r.rate_by_cohort : [];
        if (rateRows.length > 0) {
          for (const row of rateRows) {
            data.push({
              scenario_id: b.scenario_id,
              subject_id: b.subject_id,
              date: row.date,
              x: Number(row.x ?? 0),
              y: Number(row.y ?? 0),
              rate: row.rate != null && Number.isFinite(Number(row.rate)) ? Number(row.rate) : null,
            });
          }
        } else {
          // Fallback: use the ΔY count data (rate not available).
          for (const row of (r.data || [])) {
            data.push({
              scenario_id: b.scenario_id,
              subject_id: b.subject_id,
              date: row.date,
              conversions: Number(row.conversions ?? 0),
              x: 0,
              y: 0,
              rate: null,
            });
          }
        }
      }

      if (data.length === 0) {
        const emptyResult: AnalysisResult = {
          analysis_type: 'daily_conversions',
          analysis_name: 'Daily Conversions',
          analysis_description: 'No snapshot data found for this query and date range',
          metadata: { source: 'snapshot_db', empty: true },
          semantics: {
            dimensions: [],
            metrics: [],
            chart: { recommended: 'daily_conversions', alternatives: [] },
          },
          dimension_values: { scenario_id: scenarioDimensionValues },
          data: [],
        };
        return { success: true, result: emptyResult, query_dsl: request.query_dsl };
      }

      // Subject dimension values.
      const subjectLabelLookup = new Map<string, string>();
      for (const sc of request.scenarios || []) {
        for (const subj of sc.snapshot_subjects || []) {
          if (subj.subject_label) {
            subjectLabelLookup.set(subj.subject_id, subj.subject_label);
          }
        }
      }
      const subjectDimValues = Object.fromEntries(
        Array.from(new Set(data.map(d => String(d.subject_id)))).map((id, i) => [
          id,
          { name: subjectLabelLookup.get(id) || humaniseSubjectId(id), order: i },
        ])
      );

      const result: AnalysisResult = {
        analysis_type: 'daily_conversions',
        analysis_name: 'Daily Conversions',
        analysis_description: 'Daily conversion rate by cohort',
        metadata: {
          source: 'snapshot_db',
          date_range: { from: globalDateFrom, to: globalDateTo },
          total_conversions: globalTotalConversions,
        },
        semantics: {
          dimensions: [
            { id: 'date', name: 'Cohort date', type: 'time', role: 'primary' },
            { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
            { id: 'subject_id', name: 'Subject', type: 'categorical', role: 'filter' },
          ],
          metrics: [
            { id: 'rate', name: 'Conversion rate', type: 'ratio', format: 'percent', role: 'primary' },
            { id: 'x', name: 'Cohort size', type: 'count', format: 'number', role: 'secondary' },
            { id: 'y', name: 'Conversions', type: 'count', format: 'number', role: 'secondary' },
          ],
          chart: {
            recommended: 'daily_conversions',
            alternatives: ['table'],
          },
        },
        dimension_values: {
          scenario_id: scenarioDimensionValues,
          subject_id: subjectDimValues,
        },
        data,
      };

      return { success: true, result, query_dsl: request.query_dsl };
    } catch (err) {
      console.error('[GraphComputeClient] Daily conversions normalisation CRASHED:', err);
      return null;
    }
  }

  /**
   * Clear all caches (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.analysisCache.clear();
    this.availableAnalysesCache.clear();
    // Set a global timestamp so ALL GraphComputeClient instances (including
    // stale HMR singletons) will bypass cache until a fresh compute completes.
    try {
      (globalThis as any).__dagnetCacheClearedAtMs = Date.now();
    } catch { /* ignore */ }
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
    const bypassCache = this.shouldBypassCache();

    const cacheKey =
      this.generateCacheKey(graph, queryDsl, analysisType, [scenarioId])
      + `|vis:${visibilityMode}`
      + (analysisType === 'cohort_maturity' ? `|cmv:${this.COHORT_MATURITY_CACHE_VERSION}` : '');
    if (!bypassCache) {
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        console.log('[GraphComputeClient] Cache hit for analyzeSelection');
        return cached.data;
      }
    } else {
      console.log('[GraphComputeClient] Cache bypass for analyzeSelection');
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

    const normalised =
      this.normaliseSnapshotCohortMaturityResponse(raw, request)
      ?? this.normaliseSnapshotDailyConversionsResponse(raw, request);

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
    const bypassCache = this.shouldBypassCache();

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
      + `|vis:${visibilityModes}`
      + (analysisType === 'cohort_maturity' ? `|cmv:${this.COHORT_MATURITY_CACHE_VERSION}` : '');
    
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
    const normalised =
      this.normaliseSnapshotCohortMaturityResponse(raw, request)
      ?? this.normaliseSnapshotDailyConversionsResponse(raw, request);
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
  rate_by_cohort?: Array<{ date: string; x: number; y: number; rate: number | null }>;
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

