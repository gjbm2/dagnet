/**
 * Lag Recompute Service — API client for /api/lag/recompute-models.
 *
 * Calls the Python backend to fit lag models from snapshot DB evidence.
 * Gated by FORECASTING_PARALLEL_RUN flag.
 *
 * See analysis-forecasting.md §5.
 */

import { buildForecastingSettings, type ForecastingSettings } from '../constants/latency';
import { computeShortCoreHash } from './coreHashService';
import { fileRegistry } from '../contexts/TabContext';
import { sessionLogService } from './sessionLogService';
import { compareModelFits, type FEModelParams } from './forecastingParityService';
import { parseUKDate } from '../lib/dateFormat';

/** Python API base URL (same pattern as snapshotWriteService). */
const PYTHON_API_BASE = import.meta.env.DEV 
  ? (import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:9000')  // Local Python dev server
  : '';                                                                 // Vercel serverless (same origin)

/** Whether parallel-run comparison is enabled. */
export const FORECASTING_PARALLEL_RUN = true;

export interface RecomputeSubject {
  subject_id: string;
  param_id: string;
  core_hash: string;
  slice_keys: string[];
  anchor_from: string; // ISO date
  anchor_to: string;   // ISO date
  target: {
    targetId: string;
    slot?: string;
    conditionalIndex?: number;
  };
  /**
   * The onset the FE actually used for fitting mu/sigma.
   *
   * Derived from: median_lag_days - exp(mu).
   * The BE must use this value (not the graph edge's onset_delta_days, which
   * may be stale from a previous topo pass or a user override that the FE
   * fitting intentionally does not consume).
   */
  onset_delta_days?: number;
}

export interface RecomputeResult {
  subject_id: string;
  success: boolean;
  mu?: number;
  sigma?: number;
  model_trained_at?: string;
  t95_days?: number;
  onset_delta_days?: number;
  quality_ok?: boolean;
  total_k?: number;
  quality_failure_reason?: string;
  training_window?: { anchor_from?: string; anchor_to?: string };
  settings_signature?: string;
  evidence_anchor_days?: number;
  error?: string;
}

export interface RecomputeResponse {
  success: boolean;
  subjects: RecomputeResult[];
}

/**
 * Call the backend recompute-models API.
 *
 * Returns null if the backend is unreachable (graceful degradation).
 */
export async function recomputeLagModels(
  subjects: RecomputeSubject[],
  graph: any,
  opts?: {
    trainingAnchorFrom?: string;
    trainingAnchorTo?: string;
    asAt?: string;
    baseUrl?: string;
  },
): Promise<RecomputeResponse | null> {
  if (!FORECASTING_PARALLEL_RUN) return null;
  if (!subjects.length) return null;

  const settings = buildForecastingSettings();
  const url = `${opts?.baseUrl || PYTHON_API_BASE}/api/lag/recompute-models`;

  const body: Record<string, any> = {
    subjects,
    graph,
    forecasting_settings: settings,
  };
  if (opts?.trainingAnchorFrom) body.training_anchor_from = opts.trainingAnchorFrom;
  if (opts?.trainingAnchorTo) body.training_anchor_to = opts.trainingAnchorTo;
  if (opts?.asAt) body.as_at = opts.asAt;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn(`[lagRecomputeService] Backend returned ${resp.status}`);
      return null;
    }
    return await resp.json() as RecomputeResponse;
  } catch (err) {
    // Offline / backend unreachable — graceful degradation.
    console.warn('[lagRecomputeService] Backend unreachable:', err);
    return null;
  }
}

/**
 * Run the parallel parity comparison: FE mu/sigma vs BE mu/sigma.
 *
 * Enumerates latency-enabled edges on the graph, builds recompute subjects
 * from the graph + parameter files, calls the backend, and compares results.
 *
 * No-op when FORECASTING_PARALLEL_RUN is false.
 */
export async function runParityComparison(args: {
  graph: any;
  workspace: { repository: string; branch: string };
}): Promise<void> {
  if (!FORECASTING_PARALLEL_RUN) return;

  console.log('[lagRecomputeService] runParityComparison ENTERED — version: FIXED_SLICEKEYS_V2');

  const { graph, workspace } = args;
  const edges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];

  // Collect FE model params and build recompute subjects.
  const feModels: FEModelParams[] = [];
  const subjects: RecomputeSubject[] = [];

  for (const edge of edges) {
    const lat = edge?.p?.latency;
    if (!lat?.latency_parameter) continue;
    if (typeof lat.mu !== 'number' || typeof lat.sigma !== 'number') continue;

    const paramId = edge?.p?.id;
    if (!paramId) continue;
    const edgeUuid = edge.uuid || edge.id || '';

    // FE model params (already on the graph from the topo pass).
    feModels.push({
      edgeUuid,
      mu: lat.mu,
      sigma: lat.sigma,
      t95: lat.t95 ?? 0,
      onset_delta_days: lat.onset_delta_days ?? 0,
      completeness: lat.completeness ?? 0,
    });

    // Build subject for backend recompute.
    // MUST use the same slice family/signature as the FE fitter used for mu/sigma fitting:
    // - FE fits from cohort() full-history evidence (cohortsAll), not window().
    const fileId = `parameter-${paramId}`;
    const file = fileRegistry.getFile(fileId);
    const values: any[] = file?.data?.values || [];

    // Prefer cohort() slice entry (full-history fit basis).
    //
    // For MECE unions (common in prod): some params have ONLY cohort()+context slices (no uncontexted cohort slice).
    // In that case, FE effectively fits from the union of context slices; BE must receive ALL those slice keys.
    const cohortValues = values.filter((v: any) =>
      v?.query_signature && (typeof v.sliceDSL === 'string' && v.sliceDSL.startsWith('cohort('))
    );
    const uncontextedCohortValue = cohortValues.find((v: any) => {
      const dsl = String(v.sliceDSL || '');
      return !dsl.includes('.context(') && !dsl.includes('contextAny(');
    });
    const windowValue = values.find((v: any) =>
      v?.query_signature && (typeof v.sliceDSL === 'string' && v.sliceDSL.startsWith('window('))
    );
    const chosenValues: any[] =
      uncontextedCohortValue
        ? [uncontextedCohortValue]
        : (cohortValues.length > 0 ? cohortValues : (windowValue ? [windowValue] : []));
    if (!chosenValues.length || !chosenValues[0]?.query_signature) continue;

    // All chosen slices must belong to the same signature family (same core_hash), otherwise
    // we cannot query the snapshot DB in a single recompute call safely.
    let coreHash: string;
    try {
      coreHash = await computeShortCoreHash(chosenValues[0].query_signature);
      for (const v of chosenValues.slice(1)) {
        const ch = await computeShortCoreHash(v.query_signature);
        if (ch !== coreHash) {
          console.warn(
            `[lagRecomputeService] Skipping parity subject for ${paramId}: ` +
            `MECE union spans multiple core_hash families (first=${coreHash.substring(0, 8)}..., other=${ch.substring(0, 8)}...)`
          );
          coreHash = '';
          break;
        }
      }
      if (!coreHash) continue;
    } catch {
      continue;
    }

    // Use the chosen slice's date range and sliceDSL.
    const anchorFrom =
      chosenValues[0].cohort_from ||
      chosenValues[0].window_from ||
      '';
    const anchorTo =
      chosenValues[0].cohort_to ||
      chosenValues[0].window_to ||
      '';

    // Use the exact sliceDSL as the slice key — NOT broad [''].
    // This ensures the BE queries the same signature family and slice semantics.
    const sliceKeys: string[] = chosenValues
      .map(v => (typeof v.sliceDSL === 'string' ? v.sliceDSL : ''))
      .filter(Boolean);
    if (!sliceKeys.length) continue;

    // Convert UK dates (d-MMM-yy) to ISO for the API.
    const toISO = (ukDate: string): string => {
      if (!ukDate) return '';
      try {
        const d = parseUKDate(ukDate);
        return d.toISOString().split('T')[0];
      } catch { /* fall through */ }
      // Fallback: already ISO?
      if (/^\d{4}-\d{2}-\d{2}/.test(ukDate)) return ukDate.substring(0, 10);
      return ukDate;
    };

    const isoFrom = toISO(anchorFrom);
    const isoTo = toISO(anchorTo);

    console.log(
      `[lagRecomputeService] Subject: edge=${edgeUuid.substring(0, 8)}, param=${paramId}, ` +
      `sliceKeys=${sliceKeys.length}, anchorFrom=${anchorFrom} → ${isoFrom}, anchorTo=${anchorTo} → ${isoTo}, ` +
      `source=${uncontextedCohortValue ? 'cohort' : cohortValues.length > 0 ? 'cohort_mece' : windowValue ? 'window' : 'none'}`
    );

    // Determine the onset the FE actually used for fitting mu/sigma.
    //
    // The FE topo pass computes onset from window() slice histogram data.
    // If window slices have onset → it's written to the edge → we read it.
    // If no window slices have onset → the FE used 0 → the edge may have
    // a stale value from a previous pass, so we must NOT read it blindly.
    //
    // Check the same source the topo pass checks: do the parameter file's
    // window() slices have latency.onset_delta_days?
    const windowSlicesWithOnset = values.filter((v: any) => {
      const dsl = String(v.sliceDSL ?? '');
      return dsl.includes('window(') && typeof v.latency?.onset_delta_days === 'number';
    });
    const feFittingOnset =
      windowSlicesWithOnset.length > 0
        ? (typeof lat.onset_delta_days === 'number' && Number.isFinite(lat.onset_delta_days) && lat.onset_delta_days >= 0
            ? lat.onset_delta_days
            : 0)
        : 0;  // No window onset data → FE used 0

    subjects.push({
      subject_id: edgeUuid,
      param_id: `${workspace.repository}-${workspace.branch}-${paramId}`,
      core_hash: coreHash,
      slice_keys: sliceKeys,
      anchor_from: isoFrom,
      anchor_to: isoTo,
      target: { targetId: edgeUuid },
      onset_delta_days: feFittingOnset,
    });
  }

  if (!subjects.length || !feModels.length) {
    console.log('[lagRecomputeService] No latency edges with mu/sigma for parity comparison');
    return;
  }

  sessionLogService.info(
    'graph', 'FORECASTING_PARITY_START',
    `Starting parity comparison for ${subjects.length} latency edges`,
    undefined,
    {
      subjects: subjects.map(s => ({
        subject_id: s.subject_id.substring(0, 8),
        param_id: s.param_id,
        core_hash: s.core_hash.substring(0, 12),
        slice_keys: s.slice_keys,
        anchor_from: s.anchor_from,
        anchor_to: s.anchor_to,
      })),
    },
  );

  // Call backend.
  // Important: send as_at so BE uses the same “now” reference FE used for recency weighting.
  const response = await recomputeLagModels(subjects, graph, { asAt: new Date().toISOString() });
  if (!response) {
    sessionLogService.warning(
      'graph', 'FORECASTING_PARITY_SKIPPED',
      'Backend unreachable — skipping parity comparison',
    );
    return;
  }

  // Compare.
  // Attach the exact request-subject used for each BE result so mismatch logs can
  // include core_hash/slice_keys/anchor range (critical for debugging selection bugs).
  const subjById = new Map<string, RecomputeSubject>();
  for (const s of subjects) subjById.set(s.subject_id, s);
  const beWithReq = response.subjects.map((r: any) => ({
    ...r,
    __parity_request_subject: subjById.get(r.subject_id),
  }));
  compareModelFits(feModels, beWithReq);

  sessionLogService.info(
    'graph', 'FORECASTING_PARITY_DONE',
    `Parity comparison complete for ${subjects.length} edges`,
  );
}
