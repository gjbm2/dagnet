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
    // MUST use the WINDOW slice (not cohort, not broad) — the FE fits from window data only.
    const fileId = `parameter-${paramId}`;
    const file = fileRegistry.getFile(fileId);
    const values: any[] = file?.data?.values || [];

    // Find the window value entry: has window_from/window_to, or sliceDSL starts with 'window('.
    const windowValue = values.find((v: any) =>
      v?.query_signature && (
        v.window_from ||
        (typeof v.sliceDSL === 'string' && v.sliceDSL.startsWith('window('))
      )
    );
    if (!windowValue?.query_signature) continue;

    let coreHash: string;
    try {
      coreHash = await computeShortCoreHash(windowValue.query_signature);
    } catch {
      continue;
    }

    // Use the window slice's date range and sliceDSL.
    const anchorFrom = windowValue.window_from || '';
    const anchorTo = windowValue.window_to || '';
    // Use the exact sliceDSL as the slice key — NOT broad [''].
    // This ensures the BE queries the same rows the FE aggregated.
    const sliceKey = typeof windowValue.sliceDSL === 'string' && windowValue.sliceDSL
      ? windowValue.sliceDSL
      : '';

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

    console.log(`[lagRecomputeService] Subject: edge=${edgeUuid.substring(0, 8)}, param=${paramId}, sliceKey=${sliceKey}, anchorFrom=${anchorFrom} → ${isoFrom}, anchorTo=${anchorTo} → ${isoTo}`);

    subjects.push({
      subject_id: edgeUuid,
      param_id: `${workspace.repository}-${workspace.branch}-${paramId}`,
      core_hash: coreHash,
      slice_keys: [sliceKey],
      anchor_from: isoFrom,
      anchor_to: isoTo,
      target: { targetId: edgeUuid },
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
  const response = await recomputeLagModels(subjects, graph);
  if (!response) {
    sessionLogService.warning(
      'graph', 'FORECASTING_PARITY_SKIPPED',
      'Backend unreachable — skipping parity comparison',
    );
    return;
  }

  // Compare.
  compareModelFits(feModels, response.subjects);

  sessionLogService.info(
    'graph', 'FORECASTING_PARITY_DONE',
    `Parity comparison complete for ${subjects.length} edges`,
  );
}
