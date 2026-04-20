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

import { PYTHON_API_BASE as API_BASE_URL } from './pythonApiBase';
import { buildForecastingSettings } from '../constants/latency';

const USE_MOCK = (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_USE_MOCK_COMPUTE === 'true');

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

function snapshotSubjectsSignature(subjects?: SnapshotSubjectPayload[]): string {
  const arr = Array.isArray(subjects) ? subjects : [];
  if (arr.length === 0) return '';
  return arr
    .map(s => [
      s.subject_id || '',
      s.core_hash || '',
      s.read_mode || '',
      s.anchor_from || '',
      s.anchor_to || '',
      s.as_at || '',
      s.sweep_from || '',
      s.sweep_to || '',
      Array.isArray(s.slice_keys) ? s.slice_keys.join(',') : '',
      Array.isArray(s.equivalent_hashes) ? s.equivalent_hashes.map(e => e.core_hash).sort().join(',') : '',
    ].join('|'))
    .sort()
    .join('||');
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
  private readonly COHORT_MATURITY_CACHE_VERSION = 19;

  constructor(baseUrl: string = API_BASE_URL, useMock: boolean = USE_MOCK) {
    this.baseUrl = baseUrl;
    this.useMock = useMock;
  }

  /** Safe URL search params — returns empty params in Node / CLI. */
  private getUrlSearchParams(): URLSearchParams {
    if (typeof window === 'undefined') return new URLSearchParams();
    try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
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
      const params = this.getUrlSearchParams();
      return params.get('nocache') === '1' || params.get('no-cache') === '1' || params.get('compute_nocache') === '1';
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
   * Snapshot backend "no data" envelope:
   * { success:false, scenarios:[{ subjects:[{ success:false, error:"No snapshot data found" }] }] }
   *
   * Treat this as an empty-but-valid analysis result for snapshot charts.
   */
  private isSnapshotNoDataEnvelope(raw: any): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];
    if (scenarios.length === 0) return false;

    let sawAnySubject = false;
    for (const sc of scenarios) {
      const subjects = Array.isArray(sc?.subjects) ? sc.subjects : [];
      for (const sub of subjects) {
        sawAnySubject = true;
        if (sub?.success === true) return false;
        const msg = String(sub?.error || '').toLowerCase();
        if (!msg.includes('no snapshot data')) return false;
      }
    }

    return sawAnySubject;
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
        if (r.analysis_type === 'cohort_maturity' || r.analysis_type === 'cohort_maturity_v2' || r.analysis_type === 'cohort_maturity_v1') return true;
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
      if (!anyCohort && requestedType !== 'cohort_maturity' && requestedType !== 'cohort_maturity_v2' && requestedType !== 'cohort_maturity_v1') return null;

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

      const dayDiffUTC = (asAtISO: string, anchorToISO: string): number | null => {
        const t1 = Date.parse(`${asAtISO}T00:00:00Z`);
        const t0 = Date.parse(`${anchorToISO}T00:00:00Z`);
        if (Number.isNaN(t1) || Number.isNaN(t0)) return null;
        return Math.floor((t1 - t0) / (24 * 60 * 60 * 1000));
      };

      // For CSV export / forensics: keep the fully detailed cohort points
      // (one row per snapshot_date × anchor_day).
      const cohortPointsByKey = new Map<string, Record<string, any>>();

      for (const b of blocks) {
        const r = b.result;
        if (!isCohortMaturityResult(r)) continue;
        const frames: any[] = Array.isArray(r.frames) ? r.frames : [];
        if (import.meta.env?.DEV) {
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
          const asAt = f?.snapshot_date || f?.as_at_date || f?.retrieved_at_date || f?.date;
          if (!asAt) continue;
          const points: any[] = Array.isArray(f?.data_points) ? f.data_points : [];
          for (const p of points) {
            const x = Number(p?.x ?? 0);
            const y = Number(p?.y ?? 0);
            const a = Number(p?.a ?? 0);

            // Detailed export row (per cohort anchor_day).
            const anchorDay = String(p?.anchor_day || '');
            if (!anchorDay) continue;

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
              snapshot_date: String(asAt),
              anchor_day: anchorDay,
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
              completeness: (p?.completeness === null || p?.completeness === undefined) ? null : Number(p.completeness),
              layer: p?.layer ?? null,
              evidence_y: (p?.evidence_y === null || p?.evidence_y === undefined) ? null : Number(p.evidence_y),
              forecast_y: (p?.forecast_y === null || p?.forecast_y === undefined) ? null : Number(p.forecast_y),
              projected_y: (p?.projected_y === null || p?.projected_y === undefined) ? null : Number(p.projected_y),
              is_synthetic: Boolean((f as any)?.is_synthetic),
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
      }

      // Collect model CDF curves from backend results, keyed by
      // composite `${scenario_id}::${subject_id}`.
      //
      // Each scenario passes its own re-projected graph (via reprojectPosteriorForDsl)
      // and the BE computes model curves from that scenario's edge — so different
      // scenarios on the same edge legitimately produce different model curves
      // (different posterior slices for different contexts, different alpha/beta
      // for window vs cohort, etc.). Keying by subject_id alone collapses these
      // distinct curves into one — wrong for multi-scenario charts.
      //
      // When multiple epochs collapse into one (scenario, subject) pair, keep the
      // longest curve (the gap epoch typically has a short or empty curve).
      const _modelCurveKey = (scenarioId: string, subjectId: string): string =>
        `${scenarioId}::${subjectId}`;
      const modelCurveByKey = new Map<string, { scenario_id: string; subject_id: string; curve: Array<{ tau_days: number; model_rate: number }>; params: Record<string, number>; bayesCurve?: Array<{ tau_days: number; model_rate: number }>; bayesParams?: Record<string, number>; sourceModelCurves?: Record<string, any>; promotedSource?: string }>();
      for (const b of blocks) {
        const r = b.result;
        if (r?.model_curve && Array.isArray(r.model_curve) && r.model_curve.length > 0) {
          const key = _modelCurveKey(b.scenario_id, b.subject_id);
          const existing = modelCurveByKey.get(key);
          if (!existing || r.model_curve.length > existing.curve.length) {
            const entry: any = {
              scenario_id: b.scenario_id,
              subject_id: b.subject_id,
              curve: r.model_curve,
              params: r.model_curve_params || {},
            };
            // Bayesian posterior overlay curve (if posteriors exist on this edge)
            if (r?.model_curve_bayes && Array.isArray(r.model_curve_bayes) && r.model_curve_bayes.length > 0) {
              entry.bayesCurve = r.model_curve_bayes;
              entry.bayesParams = r.model_curve_bayes_params || {};
            }
            // Bayesian confidence band (upper/lower envelope)
            if (r?.model_curve_bayes_band_upper && Array.isArray(r.model_curve_bayes_band_upper) && r.model_curve_bayes_band_upper.length > 0) {
              entry.bayesBandUpper = r.model_curve_bayes_band_upper;
              entry.bayesBandLower = r.model_curve_bayes_band_lower;
            }
            // Method B comparison curve (old onset approach)
            if (r?.model_curve_method_b && Array.isArray(r.model_curve_method_b) && r.model_curve_method_b.length > 0) {
              entry.methodBCurve = r.model_curve_method_b;
              entry.methodBParams = r.model_curve_method_b_params || {};
            }
            // Per-source model curves (analytic, analytic_be, bayesian)
            if (r?.source_model_curves && typeof r.source_model_curves === 'object') {
              entry.sourceModelCurves = r.source_model_curves;
              entry.promotedSource = r.promoted_source || 'best_available';
            }
            modelCurveByKey.set(key, entry);
          }
        }
      }

      // ── Per-τ rows: BE-computed ──────────────────────────────────────
      // The BE computes complete per-τ rows (rate, midpoint, fan bounds)
      // in compute_cohort_maturity_rows using proper upstream x forecasting
      // and Bayesian dispersion.  The FE just passes them through.
      // Scenario and subject IDs are added here from the request context.
      const data: Array<Record<string, any>> = [];

      // Derive iteration keys from BOTH request snapshot_subjects AND response
      // blocks. When the BE uses analytics_dsl (doc 31), response subject IDs
      // use a different format (resolved:uuid:N) than request subject IDs
      // (parameter:objectId:edgeUuid:p:). We need both sets so matching works
      // regardless of which path the BE used.
      const scenarioSubjectKeys = Array.from(new Set([
        ...Array.from(subjectPayloadsByScenarioSubject.keys()),
        ...blocks.map(b => `${b.scenario_id}||${b.subject_id}`),
      ]));
      for (const ssKey of scenarioSubjectKeys) {
        const [scenarioId, subjectId] = ssKey.split('||');

        // Collect maturity_rows from ALL matching blocks (epoch stitching).
        // Each epoch produces its own maturity_rows covering its sweep range.
        const matchingBlocks = blocks.filter((b) =>
          String(b.scenario_id) === String(scenarioId) && String(b.subject_id) === String(subjectId)
        );
        // Deduplicate overlapping tau_days across epochs.
        // Later epochs (more recent cohorts) have more mature data at
        // lower taus, so their rows take precedence.  Use a Map keyed
        // by tau_days to keep only one row per tau per subject.
        const rowByTau = new Map<number, Record<string, any>>();
        for (const block of matchingBlocks) {
          const beRows: Array<Record<string, any>> = block?.result?.maturity_rows || [];
          for (const row of beRows) {
            const tau = Number(row.tau_days ?? -1);
            const existing = rowByTau.get(tau);
            if (!existing || (row.cohorts_expected ?? 0) > (existing.cohorts_expected ?? 0)) {
              rowByTau.set(tau, {
                analysis_type: 'cohort_maturity',
                scenario_id: scenarioId,
                subject_id: subjectId,
                ...row,
              });
            }
          }
        }
        for (const row of rowByTau.values()) {
          data.push(row);
        }
      }

      data.sort((a, b) => {
        const sa = String(a.scenario_id || '');
        const sb = String(b.scenario_id || '');
        if (sa !== sb) return sa.localeCompare(sb);
        const ua = String(a.subject_id || '');
        const ub = String(b.subject_id || '');
        if (ua !== ub) return ua.localeCompare(ub);
        return Number(a.tau_days ?? 0) - Number(b.tau_days ?? 0);
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
          // Promoted model source — used by chart hint rendering.
          // Read from the first subject's model curve entry.
          promoted_source: (() => {
            for (const [, entry] of modelCurveByKey) {
              if (entry.promotedSource) return entry.promotedSource;
            }
            return undefined;
          })(),
          // Model CDF curves keyed by `${scenario_id}::${subject_id}` (for
          // overlay on maturity chart). Per-scenario keys preserve the
          // distinction when scenarios resolve to different posterior slices
          // (different contexts, window vs cohort, etc.).
          model_curves: Object.fromEntries(modelCurveByKey),
          // Export-only tables (avoid polluting the primary `data` rows used by charts).
          export_tables: {
            cohort_maturity_points: Array.from(cohortPointsByKey.values()).sort((a: any, b: any) => {
              const sa = String(a.scenario_id || '').localeCompare(String(b.scenario_id || ''));
              if (sa !== 0) return sa;
              const su = String(a.subject_id || '').localeCompare(String(b.subject_id || ''));
              if (su !== 0) return su;
              const ad = String(a.snapshot_date || '').localeCompare(String(b.snapshot_date || ''));
              if (ad !== 0) return ad;
              return String(a.anchor_day || '').localeCompare(String(b.anchor_day || ''));
            }),
          },
        },
        semantics: {
          dimensions: [
            { id: 'tau_days', name: 'Age (days)', type: 'number', role: 'primary' },
            { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
            { id: 'subject_id', name: 'Subject', type: 'categorical', role: 'filter' },
          ],
          metrics: [
            { id: 'rate', name: 'Conversion rate', type: 'ratio', format: 'percent', role: 'primary' },
            { id: 'projected_rate', name: 'Projected conversion rate', type: 'ratio', format: 'percent', role: 'secondary' },
            { id: 'x_covered', name: 'Cohort size (at this age)', type: 'count', format: 'number', role: 'secondary' },
            { id: 'y_base', name: 'Evidenced conversions', type: 'count', format: 'number', role: 'secondary' },
            { id: 'y_projected', name: 'Projected conversions', type: 'count', format: 'number', role: 'secondary' },
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

      // Build dimension values from request scenarios (used by both empty and non-empty returns).
      const scenarioDimensionValues: Record<string, DimensionValueMeta> = {};
      for (const s of request.scenarios || []) {
        if (!s?.scenario_id) continue;
        scenarioDimensionValues[s.scenario_id] = {
          name: s.name || s.scenario_id,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        };
      }

      // Snapshot DB no-data envelope: convert to a valid empty result.
      if (this.isSnapshotNoDataEnvelope(raw)) {
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
              completeness: row.completeness != null ? Number(row.completeness) : null,
              layer: row.layer ?? null,
              evidence_y: row.evidence_y != null ? Number(row.evidence_y) : null,
              forecast_y: row.forecast_y != null ? Number(row.forecast_y) : null,
              projected_y: row.projected_y != null ? Number(row.projected_y) : null,
              forecast_bands: row.forecast_bands ?? null,
              latency_bands: row.latency_bands ?? null,
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

      // Promoted source from first block that has it (for hint rendering)
      const dcPromotedSource = blocks.find(b => b.result?.promoted_source)?.result?.promoted_source;

      const result: AnalysisResult = {
        analysis_type: 'daily_conversions',
        analysis_name: 'Daily Conversions',
        analysis_description: 'Daily conversion rate by cohort',
        metadata: {
          source: 'snapshot_db',
          date_range: { from: globalDateFrom, to: globalDateTo },
          total_conversions: globalTotalConversions,
          promoted_source: dcPromotedSource,
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
   * Normalise conversion_rate snapshot response (doc 49 Part B).
   *
   * Backend returns per-scenario/per-subject blocks with:
   *   { analysis_type: 'conversion_rate', bin_size, slice_key,
   *     data: [{bin_start, bin_end, x, y, rate, epistemic?}], ... }
   *
   * Flattens into rows with scenario_id/subject_id added.
   */
  private normaliseSnapshotConversionRateResponse(
    raw: any,
    request: AnalysisRequest,
  ): AnalysisResponse | null {
    try {
      if (request?.analysis_type !== 'conversion_rate') return null;

      const scenarioDimensionValues: Record<string, DimensionValueMeta> = {};
      for (const s of request.scenarios || []) {
        if (!s?.scenario_id) continue;
        scenarioDimensionValues[s.scenario_id] = {
          name: s.name || s.scenario_id,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        };
      }

      if (this.isSnapshotNoDataEnvelope(raw)) {
        const emptyResult: AnalysisResult = {
          analysis_type: 'conversion_rate',
          analysis_name: 'Conversion Rate',
          analysis_description: 'No snapshot data found for this query and date range',
          metadata: { source: 'snapshot_db', empty: true },
          semantics: {
            dimensions: [],
            metrics: [],
            chart: { recommended: 'conversion_rate', alternatives: [] },
          },
          dimension_values: { scenario_id: scenarioDimensionValues },
          data: [],
        };
        return { success: true, result: emptyResult, query_dsl: request.query_dsl };
      }

      const isConversionRateResult = (r: any): boolean =>
        r && typeof r === 'object' && r.analysis_type === 'conversion_rate';

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
      } else if (raw?.success === true && isConversionRateResult(raw?.result)) {
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'base';
        const subjectId = raw.subject_id || 'subject';
        blocks.push({ scenario_id: scenarioId, subject_id: subjectId, result: raw.result });
      }

      if (blocks.length === 0) return null;
      if (!blocks.some(b => isConversionRateResult(b.result))) return null;

      const data: Array<Record<string, any>> = [];
      let globalDateFrom: string | null = null;
      let globalDateTo: string | null = null;
      let binSize: string | null = null;
      let sliceKey: string | null = null;

      for (const b of blocks) {
        const r = b.result;
        if (!isConversionRateResult(r)) continue;
        if (binSize == null && r.bin_size) binSize = r.bin_size;
        if (sliceKey == null && r.slice_key) sliceKey = r.slice_key;
        const dateRange = r.date_range;
        if (dateRange?.from && (!globalDateFrom || dateRange.from < globalDateFrom)) {
          globalDateFrom = dateRange.from;
        }
        if (dateRange?.to && (!globalDateTo || dateRange.to > globalDateTo)) {
          globalDateTo = dateRange.to;
        }
        for (const row of (r.data || [])) {
          data.push({
            scenario_id: b.scenario_id,
            subject_id: b.subject_id,
            bin_start: row.bin_start,
            bin_end: row.bin_end,
            x: Number(row.x ?? 0),
            y: Number(row.y ?? 0),
            rate: row.rate != null && Number.isFinite(Number(row.rate)) ? Number(row.rate) : null,
            epistemic: row.epistemic ?? null,
          });
        }
      }

      const subjectDimValues = Object.fromEntries(
        Array.from(new Set(data.map(d => String(d.subject_id)))).map((id, i) => [
          id,
          { name: humaniseSubjectId(id), order: i },
        ])
      );

      const result: AnalysisResult = {
        analysis_type: 'conversion_rate',
        analysis_name: 'Conversion Rate',
        analysis_description: 'Per-bin observed rate with Bayesian epistemic uncertainty',
        metadata: {
          source: 'snapshot_db',
          date_range: { from: globalDateFrom, to: globalDateTo },
          bin_size: binSize,
          slice_key: sliceKey,
        },
        semantics: {
          dimensions: [
            { id: 'bin_start', name: 'Bin', type: 'time', role: 'primary' },
            { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
            { id: 'subject_id', name: 'Subject', type: 'categorical', role: 'filter' },
          ],
          metrics: [
            { id: 'rate', name: 'Conversion rate', type: 'ratio', format: 'percent', role: 'primary' },
            { id: 'x', name: 'Cohort size', type: 'count', format: 'number', role: 'secondary' },
            { id: 'y', name: 'Conversions', type: 'count', format: 'number', role: 'secondary' },
          ],
          chart: { recommended: 'conversion_rate', alternatives: ['table'] },
        },
        dimension_values: {
          scenario_id: scenarioDimensionValues,
          subject_id: subjectDimValues,
        },
        data,
      };

      return { success: true, result, query_dsl: request.query_dsl };
    } catch (err) {
      console.error('[GraphComputeClient] Conversion rate normalisation CRASHED:', err);
      return null;
    }
  }

  /**
   * Normalise branch_comparison snapshot response into a time-series branch split result.
   *
   * Backend shape is the same snapshot envelope as daily_conversions, but each subject
   * corresponds to a child branch. We flatten successful subject results into rows keyed by
   * (date, scenario_id, branch).
   */
  private normaliseSnapshotBranchComparisonResponse(
    raw: any,
    request: AnalysisRequest,
  ): AnalysisResponse | null {
    try {
      if (request?.analysis_type !== 'branch_comparison') return null;

      const scenarioDimensionValues: Record<string, DimensionValueMeta> = {};
      for (const s of request.scenarios || []) {
        if (!s?.scenario_id) continue;
        scenarioDimensionValues[s.scenario_id] = {
          name: s.name || s.scenario_id,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
          probability_label: s.visibility_mode === 'f' ? 'Forecast Probability' : s.visibility_mode === 'e' ? 'Evidence Probability' : 'Probability',
        };
      }

      if (this.isSnapshotNoDataEnvelope(raw)) {
        const emptyResult: AnalysisResult = {
          analysis_type: 'branch_comparison',
          analysis_name: 'Branch Comparison',
          analysis_description: 'No snapshot data found for this query and date range',
          metadata: {
            source: 'snapshot_db',
            empty: true,
            node_ids: [],
          },
          semantics: {
            dimensions: [],
            metrics: [],
            chart: {
              recommended: 'time_series',
              alternatives: ['bar_grouped', 'pie', 'table'],
            },
          },
          dimension_values: {
            scenario_id: scenarioDimensionValues,
            branch: {},
          },
          data: [],
        };
        return { success: true, result: emptyResult, query_dsl: request.query_dsl };
      }

      type Block = { scenario_id: string; subject_id: string; result: any };
      const blocks: Block[] = [];

      const isDailyResult = (r: any): boolean => {
        if (!r || typeof r !== 'object') return false;
        return r.analysis_type === 'daily_conversions' || Array.isArray(r.rate_by_cohort) || (Array.isArray(r.data) && r.data[0]?.conversions !== undefined);
      };

      if (raw && Array.isArray(raw.scenarios)) {
        for (const sc of raw.scenarios) {
          const scenarioId = sc?.scenario_id;
          if (!scenarioId || !Array.isArray(sc?.subjects)) continue;
          for (const sub of sc.subjects) {
            if (sub?.success !== true) continue;
            blocks.push({ scenario_id: scenarioId, subject_id: sub?.subject_id || 'branch', result: sub?.result });
          }
        }
      } else if (raw && Array.isArray(raw.subjects)) {
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'current';
        for (const sub of raw.subjects) {
          if (sub?.success !== true) continue;
          blocks.push({ scenario_id: scenarioId, subject_id: sub?.subject_id || 'branch', result: sub?.result });
        }
      } else if (raw?.success === true && isDailyResult(raw?.result)) {
        const scenarioId = raw.scenario_id || request?.scenarios?.[0]?.scenario_id || 'current';
        const subjectId = raw.subject_id || 'branch';
        blocks.push({ scenario_id: scenarioId, subject_id: subjectId, result: raw.result });
      }

      if (blocks.length === 0) return null;

      const branchLabelLookup = new Map<string, string>();
      const branchKeyByScenarioAndSubject = new Map<string, string>();
      for (const sc of request.scenarios || []) {
        const graph: any = sc.graph || {};
        const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
        const nodeByUuid = new Map(nodes.map((n: any) => [String(n.uuid || n.id || ''), n]));
        const edgeByUuid = new Map(edges.map((e: any) => [String(e.uuid || e.id || ''), e]));
        for (const subj of sc.snapshot_subjects || []) {
          const subjectId = String(subj.subject_id || '');
          if (!subjectId) continue;
          let branchKey = '';
          let branchName = '';
          const targetEdge = edgeByUuid.get(String(subj?.target?.targetId || ''));
          const childNode = targetEdge ? nodeByUuid.get(String(targetEdge.to || '')) : null;
          if (childNode) {
            branchKey = String(childNode.id || childNode.uuid || subjectId);
            branchName = String(childNode.label || childNode.id || branchKey);
          } else if (subj.subject_label) {
            branchKey = subjectId;
            branchName = subj.subject_label;
          } else {
            branchKey = subjectId;
            branchName = humaniseSubjectId(subjectId);
          }
          branchLabelLookup.set(branchKey, branchName);
          branchKeyByScenarioAndSubject.set(`${sc.scenario_id}||${subjectId}`, branchKey);
        }
      }

      const data: Array<Record<string, any>> = [];
      for (const b of blocks) {
        const r = b.result;
        if (!isDailyResult(r)) continue;
        const rateRows: any[] = Array.isArray(r.rate_by_cohort) ? r.rate_by_cohort : [];
        const branchKey = branchKeyByScenarioAndSubject.get(`${b.scenario_id}||${b.subject_id}`) || b.subject_id;
        for (const row of rateRows) {
          data.push({
            scenario_id: b.scenario_id,
            branch: branchKey,
            date: row.date,
            x: Number(row.x ?? 0),
            y: Number(row.y ?? 0),
            rate: row.rate != null && Number.isFinite(Number(row.rate)) ? Number(row.rate) : null,
            completeness: row.completeness != null ? Number(row.completeness) : null,
            layer: row.layer ?? null,
            evidence_y: row.evidence_y != null ? Number(row.evidence_y) : null,
            forecast_y: row.forecast_y != null ? Number(row.forecast_y) : null,
            projected_y: row.projected_y != null ? Number(row.projected_y) : null,
          });
        }
      }

      if (data.length === 0) {
        const emptyResult: AnalysisResult = {
          analysis_type: 'branch_comparison',
          analysis_name: 'Branch Comparison',
          analysis_description: 'No snapshot data found for this query and date range',
          metadata: {
            source: 'snapshot_db',
            empty: true,
            node_ids: [],
          },
          semantics: {
            dimensions: [],
            metrics: [],
            chart: {
              recommended: 'time_series',
              alternatives: ['bar_grouped', 'pie', 'table'],
            },
          },
          dimension_values: {
            scenario_id: scenarioDimensionValues,
            branch: {},
          },
          data: [],
        };
        return { success: true, result: emptyResult, query_dsl: request.query_dsl };
      }

      // If exactly one child branch has snapshot rows but the selected parent has exactly two
      // immediate children, derive the missing branch as the complement so split-by-child remains
      // intelligible in time-series mode.
      try {
        const query = request.analytics_dsl || request.query_dsl || '';
        const match = /visited\(([^)]+)\)/.exec(query);
        const selectedParentId = match?.[1] ? String(match[1]).trim() : '';
        const firstGraph: any = request.scenarios?.[0]?.graph || {};
        const nodes: any[] = Array.isArray(firstGraph?.nodes) ? firstGraph.nodes : [];
        const edges: any[] = Array.isArray(firstGraph?.edges) ? firstGraph.edges : [];
        const parentNode = nodes.find((n: any) => String(n.id || '') === selectedParentId || String(n.uuid || '') === selectedParentId);
        if (parentNode) {
          const childNodes = edges
            .filter((e: any) => String(e.from || '') === String(parentNode.uuid || parentNode.id || ''))
            .map((e: any) => nodes.find((n: any) => String(n.uuid || n.id || '') === String(e.to || '')))
            .filter(Boolean);
          const expectedBranches = childNodes.map((n: any) => ({
            key: String(n.id || n.uuid || ''),
            name: String(n.label || n.id || n.uuid || ''),
          }));
          const presentByScenarioAndDate = new Map<string, Set<string>>();
          for (const row of data) {
            const key = `${row.scenario_id}||${row.date}`;
            if (!presentByScenarioAndDate.has(key)) presentByScenarioAndDate.set(key, new Set());
            presentByScenarioAndDate.get(key)!.add(String(row.branch));
          }
          const derivedRows: Array<Record<string, any>> = [];
          if (expectedBranches.length === 2) {
            for (const [key, present] of presentByScenarioAndDate.entries()) {
              if (present.size !== 1) continue;
              const [scenarioId, date] = key.split('||');
              const missing = expectedBranches.find(bm => !present.has(bm.key));
              const known = expectedBranches.find(bm => present.has(bm.key));
              if (!missing || !known) continue;
              const knownRow = data.find(r => String(r.scenario_id) === scenarioId && String(r.date) === date && String(r.branch) === known.key);
              if (!knownRow) continue;
              const x = Number(knownRow.x ?? 0);
              const knownEvidence = typeof knownRow.evidence_y === 'number'
                ? knownRow.evidence_y
                : (typeof knownRow.y === 'number' ? knownRow.y : null);
              const knownProjected = typeof knownRow.projected_y === 'number'
                ? knownRow.projected_y
                : (typeof knownRow.y === 'number' ? knownRow.y : null);
              const evidenceY = typeof knownEvidence === 'number' ? Math.max(0, x - knownEvidence) : null;
              const projectedY = typeof knownProjected === 'number' ? Math.max(0, x - knownProjected) : null;
              const forecastY = projectedY != null && evidenceY != null ? Math.max(0, projectedY - evidenceY) : null;
              derivedRows.push({
                scenario_id: scenarioId,
                branch: missing.key,
                date,
                x,
                y: projectedY ?? null,
                rate: projectedY != null && x > 0 ? projectedY / x : null,
                completeness: knownRow.completeness != null ? Number(knownRow.completeness) : null,
                layer: knownRow.layer ?? null,
                evidence_y: evidenceY,
                forecast_y: forecastY,
                projected_y: projectedY,
              });
              branchLabelLookup.set(missing.key, missing.name);
            }
          }
          if (derivedRows.length > 0) data.push(...derivedRows);
        }
      } catch {
        // Keep the observed rows if complement derivation fails.
      }

      const branchIds = Array.from(new Set(data.map(d => String(d.branch)).filter(Boolean)));
      const branchDimensionValues: Record<string, DimensionValueMeta> = Object.fromEntries(
        branchIds.map((id, i) => [id, { name: branchLabelLookup.get(id) || humaniseSubjectId(id), order: i }]),
      );

      const result: AnalysisResult = {
        analysis_type: 'branch_comparison',
        analysis_name: 'Branch Comparison',
        analysis_description: 'Traffic split by child over time',
        metadata: {
          source: 'snapshot_db',
          node_ids: branchIds,
        },
        semantics: {
          dimensions: [
            { id: 'date', name: 'Cohort date', type: 'time', role: 'primary' },
            { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
            { id: 'branch', name: 'Branch', type: 'node', role: 'filter' },
          ],
          metrics: [
            { id: 'rate', name: 'Conversion rate', type: 'ratio', format: 'percent', role: 'primary' },
            { id: 'x', name: 'Cohort size', type: 'count', format: 'number' },
            { id: 'y', name: 'Conversions', type: 'count', format: 'number' },
            { id: 'evidence_y', name: 'Evidence conversions', type: 'count', format: 'number' },
            { id: 'forecast_y', name: 'Forecast conversions', type: 'count', format: 'number' },
            { id: 'projected_y', name: 'Projected conversions', type: 'count', format: 'number' },
            { id: 'completeness', name: 'Completeness', type: 'ratio', format: 'percent' },
          ],
          chart: {
            recommended: 'time_series',
            alternatives: ['bar_grouped', 'pie', 'table'],
          },
        },
        dimension_values: {
          scenario_id: scenarioDimensionValues,
          branch: branchDimensionValues,
        },
        data,
      };

      return { success: true, result, query_dsl: request.query_dsl };
    } catch (err) {
      console.error('[GraphComputeClient] Branch comparison snapshot normalisation CRASHED:', err);
      return null;
    }
  }

  /**
   * Normalise multi-scenario surprise_gauge response.
   *
   * The backend returns one `{variables: [p, completeness]}` per subject
   * nested under scenarios[].subjects[].result. The gauge renderer reads
   * `result.variables` directly; it does not consume row/metric data.
   * This normaliser unwraps the envelope and — for multi-scenario
   * requests — merges variables across scenarios into a single result
   * (falling back to the first successful subject's variables when no
   * merge strategy applies). Single-scenario requests take the first
   * successful subject result directly.
   */
  private normaliseSnapshotSurpriseGaugeResponse(
    raw: any,
    request: AnalysisRequest,
  ): AnalysisResponse | null {
    try {
      if (request?.analysis_type !== 'surprise_gauge') return null;

      // Already a flat AnalysisResponse? Leave it alone.
      if (raw?.success === true && raw?.result?.analysis_type === 'surprise_gauge') {
        return null;
      }

      const scenarios: any[] = raw?.scenarios || [];
      if (scenarios.length === 0) return null;

      // Take the first successful subject's result as the representative
      // gauge for this request. If multiple scenarios are in play, the
      // gauge UI currently renders one dial per request; multi-scenario
      // horizontal bands can layer on top when a future builder supports
      // it.
      for (const sc of scenarios) {
        const subjects: any[] = sc?.subjects || [];
        for (const subj of subjects) {
          if (subj?.success && subj?.result?.analysis_type === 'surprise_gauge') {
            const r = subj.result;
            return {
              success: true,
              result: {
                analysis_type: 'surprise_gauge',
                analysis_name: r.analysis_name || 'Expectation Gauge',
                analysis_description: r.analysis_description,
                metadata: r.metadata || {},
                semantics: {
                  dimensions: [{ id: 'variable', name: 'Variable', type: 'categorical', role: 'primary' }],
                  metrics: [{ id: 'quantile', name: 'Quantile', type: 'number', role: 'primary' }],
                  chart: { recommended: 'surprise_gauge', alternatives: ['table'] },
                },
                dimension_values: {},
                data: r.variables || [],
                // Pass through the gauge-specific fields the builder reads
                variables: r.variables,
                reference_source: r.reference_source,
                hint: r.hint,
              } as any,
              query_dsl: request.query_dsl,
            } as AnalysisResponse;
          }
        }
      }
      return null;
    } catch (err) {
      console.error('[GraphComputeClient] Surprise gauge normalisation failed:', err);
      return null;
    }
  }

  /**
   * Normalise multi-scenario lag_fit response.
   *
   * The backend returns the result pre-tabulated (data rows with row_type), so
   * normalisation is just unwrapping the scenario/subject envelope.  For single-
   * scenario requests the first subject result is used directly.
   */
  private normaliseSnapshotLagFitResponse(
    raw: any,
    request: AnalysisRequest,
  ): AnalysisResponse | null {
    try {
      if (request?.analysis_type !== 'lag_fit') return null;

      // Already a flat AnalysisResponse? Leave it alone.
      if (raw?.success === true && raw?.result?.analysis_type === 'lag_fit' && Array.isArray(raw.result.data)) {
        return null;
      }

      // Unwrap multi-scenario envelope
      const scenarios: any[] = raw?.scenarios || [];
      if (scenarios.length === 0) return null;

      // Take the first successful subject result
      for (const sc of scenarios) {
        const subjects: any[] = sc?.subjects || [];
        for (const subj of subjects) {
          if (subj?.success && subj?.result?.analysis_type === 'lag_fit') {
            const r = subj.result;
            return {
              success: true,
              result: {
                analysis_type: 'lag_fit',
                analysis_name: r.analysis_name || 'Lag Fit',
                analysis_description: r.analysis_description,
                metadata: r.metadata || {},
                semantics: {
                  dimensions: [],
                  metrics: [],
                  chart: { recommended: 'lag_fit', alternatives: ['table'] },
                },
                dimension_values: {},
                data: r.data || [],
              },
              query_dsl: request.query_dsl,
            } as AnalysisResponse;
          }
        }
      }
      return null;
    } catch (err) {
      console.error('[GraphComputeClient] Lag fit normalisation failed:', err);
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
    analyticsDsl?: string,
    effectiveQueryDsl?: string,
    scenarioId: string = 'base',
    scenarioName: string = 'Current',
    scenarioColour: string = '#3b82f6',
    analysisType?: string,
    visibilityMode: 'f+e' | 'f' | 'e' = 'f+e',
    candidateRegimesByEdge?: Record<string, Array<{ core_hash: string; equivalent_hashes: string[] }>>,
    displaySettings?: Record<string, unknown>,
    meceDimensions?: string[],
  ): Promise<AnalysisResponse> {
    const bypassCache = this.shouldBypassCache();
    const testFixture = this.getUrlSearchParams().get('test_fixture');

    const displaySig = displaySettings ? JSON.stringify(displaySettings) : '';
    const cacheKey =
      this.generateCacheKey(graph, analyticsDsl, analysisType, [scenarioId])
      + `|eqdsl:${this.hashString(effectiveQueryDsl || '')}`
      + `|vis:${visibilityMode}`
      + ((analysisType === 'cohort_maturity' || analysisType === 'cohort_maturity_v2' || analysisType === 'cohort_maturity_v1') ? `|cmv:${this.COHORT_MATURITY_CACHE_VERSION}` : '')
      + (displaySig ? `|ds:${this.hashString(displaySig)}` : '')
      + (testFixture ? `|tf:${testFixture}:${this.getUrlSearchParams().toString()}` : '');
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
        query_dsl: analyticsDsl,
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
      ...(effectiveQueryDsl ? { effective_query_dsl: effectiveQueryDsl } : {}),
      ...(candidateRegimesByEdge ? { candidate_regimes_by_edge: candidateRegimesByEdge } : {}),
    };

    // Collect test fixture override params from URL (?tf_onset=2&tf_mu=1.2 etc.)
    const tfOverrides: Record<string, string> = {};
    if (testFixture) {
      const sp = this.getUrlSearchParams();
      for (const k of ['tf_onset', 'tf_mu', 'tf_sigma', 'tf_factor']) {
        const v = sp.get(k);
        if (v) tfOverrides[k] = v;
      }
    }

    const diagnosticsRequested = !!(globalThis as any).__dagnetDiagnostics;

    const request: AnalysisRequest = {
      scenarios: [scenarioEntry],
      analytics_dsl: analyticsDsl,
      analysis_type: analysisType,
      ...(meceDimensions?.length ? { mece_dimensions: meceDimensions } : {}),
      ...(displaySettings ? { display_settings: displaySettings } : {}),
      ...(testFixture ? { test_fixture: testFixture, ...tfOverrides } : {}),
      ...(diagnosticsRequested ? { _diagnostics: true } : {}),
      forecasting_settings: buildForecastingSettings(),
    };

    const analyzeUrl = bypassCache
      ? `${this.baseUrl}/api/runner/analyze?no-cache=1`
      : `${this.baseUrl}/api/runner/analyze`;
    const response = await fetch(analyzeUrl, {
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
    if (import.meta.env?.DEV && (request.analysis_type === 'cohort_maturity' || request.analysis_type === 'cohort_maturity_v2' || request.analysis_type === 'cohort_maturity_v1')) {
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
          snapshot_date: f0?.snapshot_date,
          total_y: f0?.total_y,
          dataPointsCount: pts.length,
          dataPointsKeys: pts[0] ? Object.keys(pts[0]) : [],
          firstPoint: pts[0],
          sampleValues: pts.slice(0, 3).map((p: any) => ({ x: p?.x, y: p?.y, rate: p?.rate, anchor_day: p?.anchor_day })),
        });
      }
      // Log maturity_rows sample — the actual chart data contract
      const rows = Array.isArray(raw?.result?.maturity_rows) ? raw.result.maturity_rows : [];
      if (rows.length > 0) {
        const sampleTaus = [0, 5, 10, 15, 20, 25, 30];
        const sampleRows = rows.filter((r: any) => sampleTaus.includes(r?.tau_days));
        console.log('[GraphComputeClient] maturity_rows sample:', {
          totalRows: rows.length,
          tau_solid_max: rows[0]?.tau_solid_max,
          tau_future_max: rows[0]?.tau_future_max,
          rows: sampleRows.map((r: any) => ({
            tau: r.tau_days,
            rate: r.rate != null ? +r.rate.toFixed(4) : null,
            mid: r.midpoint != null ? +r.midpoint.toFixed(4) : null,
            fan_lo: r.fan_lower != null ? +r.fan_lower.toFixed(4) : null,
            fan_hi: r.fan_upper != null ? +r.fan_upper.toFixed(4) : null,
            model_mid: r.model_midpoint != null ? +r.model_midpoint.toFixed(4) : null,
            ev_x: r.evidence_x,
            ev_y: r.evidence_y,
          })),
        });
      }
    }

    const normalised =
      this.normaliseSnapshotCohortMaturityResponse(raw, request)
      ?? this.normaliseSnapshotDailyConversionsResponse(raw, request)
      ?? this.normaliseSnapshotConversionRateResponse(raw, request)
      ?? this.normaliseSnapshotBranchComparisonResponse(raw, request)
      ?? this.normaliseSnapshotLagFitResponse(raw, request)
      ?? this.normaliseSnapshotSurpriseGaugeResponse(raw, request);

    if (import.meta.env?.DEV && (request.analysis_type === 'cohort_maturity' || request.analysis_type === 'cohort_maturity_v2' || request.analysis_type === 'cohort_maturity_v1')) {
      console.log('[GraphComputeClient] Normalisation result:', {
        didNormalise: !!normalised,
        normalisedAnalysisType: normalised?.result?.analysis_type,
        normalisedDataCount: Array.isArray(normalised?.result?.data) ? normalised.result.data.length : 'N/A',
        fallbackAnalysisType: !normalised ? raw?.result?.analysis_type : 'N/A',
      });
    }

    const result = normalised ?? raw;

    // Preserve BE diagnostics through normalisation
    if (diagnosticsRequested && raw?._diagnostics && result) {
      (result as any)._diagnostics = raw._diagnostics;
    }

    // Patch dimension_values.scenario_id with name/colour from request.
    if (result?.result && scenarioId) {
      if (!result.result.dimension_values) result.result.dimension_values = {};
      if (!result.result.dimension_values.scenario_id) result.result.dimension_values.scenario_id = {};
      const existing = result.result.dimension_values.scenario_id[scenarioId] || {};
      result.result.dimension_values.scenario_id[scenarioId] = {
        ...existing,
        name: existing.name || scenarioName,
        colour: existing.colour || scenarioColour,
        visibility_mode: existing.visibility_mode || visibilityMode,
      };
    }
    
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
    scenarios: Array<{
      scenario_id: string; name: string; graph: any; colour?: string;
      visibility_mode?: 'f+e' | 'f' | 'e';
      candidate_regimes_by_edge?: Record<string, Array<{ core_hash: string; equivalent_hashes: string[] }>>;
      effective_query_dsl?: string;
    }>,
    analyticsDsl?: string,
    analysisType?: string,
    displaySettings?: Record<string, unknown>,
    meceDimensions?: string[],
  ): Promise<AnalysisResponse> {
    const bypassCache = this.shouldBypassCache();

    // Generate cache key that includes ALL scenarios' data (not just first)
    // This ensures cache invalidates when any scenario's data changes
    const scenarioIds = scenarios.map(s => s.scenario_id);
    const visibilityModes = scenarios.map(s => `${s.scenario_id}:${s.visibility_mode || 'f+e'}`).join(',');

    // Cache key incorporates ALL scenario graphs + per-scenario effective DSL
    const scenarioGraphKey = scenarios
      .map(s => `${s.scenario_id}:${this.hashString(this.graphSignature(s.graph))}:${this.hashString(s.effective_query_dsl || '')}`)
      .join(',');

    const multiTestFixture = this.getUrlSearchParams().get('test_fixture');
    const multiDisplaySig = displaySettings ? JSON.stringify(displaySettings) : '';
    const cacheKey =
      `multi|graphs:${scenarioGraphKey}|adsl:${analyticsDsl || ''}|type:${analysisType || ''}|scenarios:${scenarioIds.join(',')}`
      + `|vis:${visibilityModes}`
      + ((analysisType === 'cohort_maturity' || analysisType === 'cohort_maturity_v2' || analysisType === 'cohort_maturity_v1') ? `|cmv:${this.COHORT_MATURITY_CACHE_VERSION}` : '')
      + (multiDisplaySig ? `|ds:${this.hashString(multiDisplaySig)}` : '')
      + (multiTestFixture ? `|tf:${multiTestFixture}:${this.getUrlSearchParams().toString()}` : '');
    
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
        query_dsl: analyticsDsl,
      };
      this.analysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    const multiTfOverrides: Record<string, string> = {};
    if (multiTestFixture) {
      const sp = this.getUrlSearchParams();
      for (const k of ['tf_onset', 'tf_mu', 'tf_sigma', 'tf_factor']) {
        const v = sp.get(k);
        if (v) multiTfOverrides[k] = v;
      }
    }

    const request: AnalysisRequest = {
      scenarios: scenarios.map(s => ({
        scenario_id: s.scenario_id,
        name: s.name,
        colour: s.colour,
        visibility_mode: s.visibility_mode || 'f+e',
        graph: s.graph,
        ...(s.candidate_regimes_by_edge ? { candidate_regimes_by_edge: s.candidate_regimes_by_edge } : {}),
        ...(s.effective_query_dsl ? { effective_query_dsl: s.effective_query_dsl } : {}),
      })),
      analytics_dsl: analyticsDsl,
      analysis_type: analysisType,
      ...(meceDimensions?.length ? { mece_dimensions: meceDimensions } : {}),
      ...(displaySettings ? { display_settings: displaySettings } : {}),
      ...(multiTestFixture ? { test_fixture: multiTestFixture, ...multiTfOverrides } : {}),
      forecasting_settings: buildForecastingSettings(),
    };

    // DEV/forensics: make the exact compute boundary payload easy to copy without
    // using the Network tab (useful for diagnosing share-link discrepancies).
    if (import.meta.env?.DEV && typeof window !== 'undefined') {
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

    const multiAnalyzeUrl = bypassCache
      ? `${this.baseUrl}/api/runner/analyze?no-cache=1`
      : `${this.baseUrl}/api/runner/analyze`;
    const response = await fetch(multiAnalyzeUrl, {
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
      ?? this.normaliseSnapshotDailyConversionsResponse(raw, request)
      ?? this.normaliseSnapshotConversionRateResponse(raw, request)
      ?? this.normaliseSnapshotBranchComparisonResponse(raw, request)
      ?? this.normaliseSnapshotLagFitResponse(raw, request)
      ?? this.normaliseSnapshotSurpriseGaugeResponse(raw, request);
    const result = normalised ?? raw;

    // Patch dimension_values.scenario_id with names/colours from request.
    // The backend may return raw scenario_ids without display metadata.
    if (result?.result && request.scenarios?.length) {
      if (!result.result.dimension_values) result.result.dimension_values = {};
      if (!result.result.dimension_values.scenario_id) result.result.dimension_values.scenario_id = {};
      for (const s of request.scenarios) {
        if (!s?.scenario_id) continue;
        const existing = result.result.dimension_values.scenario_id[s.scenario_id] || {};
        result.result.dimension_values.scenario_id[s.scenario_id] = {
          ...existing,
          name: existing.name || s.name || s.scenario_id,
          colour: existing.colour || s.colour,
          visibility_mode: existing.visibility_mode || s.visibility_mode,
        };
      }
    }

    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      try {
        const g: any = window as any;
        g.__dagnetLastAnalyzeResponse = result;
      } catch {
        // ignore
      }
      console.log('[DagNet][Compute] /api/runner/analyze response payload (copy window.__dagnetLastAnalyzeResponse):', result);
    }
    
    // Cache the result unless bypassed. Never cache empty/null results — they
    // produce stale cache hits that prevent subsequent retries from reaching
    // the backend (e.g. lag_histogram returning no result on first attempt).
    if (!bypassCache) {
      if (result?.result) {
        this.analysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
        this.pruneCache(this.analysisCache);
        console.log('[GraphComputeClient] Cached analyzeMultipleScenarios result');
      } else {
        console.log('[GraphComputeClient] NOT caching analyzeMultipleScenarios — no result in response');
      }
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
      const snapBypass = this.shouldBypassCache();
      const snapAnalyzeUrl = snapBypass
        ? `${this.baseUrl}/api/runner/analyze?no-cache=1`
        : `${this.baseUrl}/api/runner/analyze`;
      const response = await fetch(snapAnalyzeUrl, {
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
  /** Analysis subject DSL (from/to/visited). Constant across scenarios. */
  analytics_dsl?: string;
  /** DEPRECATED — use analytics_dsl. Kept for backward compat. */
  query_dsl?: string;
  analysis_type?: string;
  /** MECE dimension names for regime selection aggregation safety (doc 30). */
  mece_dimensions?: string[];
  /** Forecasting settings from buildForecastingSettings(). Sent for snapshot analyses. */
  forecasting_settings?: import('../constants/latency').ForecastingSettings;
  /** Compute-affecting display settings (e.g. bayes_band_level). */
  display_settings?: Record<string, unknown>;
  /** Test fixture name — when set, BE loads synthetic data instead of snapshot DB. */
  test_fixture?: string;
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
  /** FE-computed hash-family closure from hash-mappings.json. */
  equivalent_hashes: Array<{ core_hash: string; operation: string; weight: number }>;
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
  /** True when this stage represents a visitedAny group (disjoint branch alternatives). */
  is_group?: boolean;
  /** Member node IDs for grouped stages. */
  members?: string[];
  /** Map of member ID → human-readable label for grouped stages. */
  member_labels?: Record<string, string>;
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
  analytics_dsl?: string;
  /** DEPRECATED — use analytics_dsl. Kept for backward compat. */
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
  /** Known chart kinds for this analysis type (populated FE-side from static mapping). */
  chart_kinds?: string[];
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
  analysis_type: 'lag_histogram' | 'daily_conversions' | 'conversion_rate';
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

