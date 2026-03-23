/**
 * Forecasting Parity Service — compare analytic (FE) vs analytic_be (BE) model vars.
 *
 * After both the FE topo pass and BE topo pass have written their respective
 * model_vars entries ('analytic' and 'analytic_be'), this service reads both
 * from the graph and logs divergences to session log.
 *
 * No network calls — everything is local graph state comparison.
 */

import { sessionLogService } from './sessionLogService';
import type { ModelVarsEntry } from '../types';

// ── Thresholds ──────────────────────────────────────────────────────────────

const MU_SIGMA_WARN_REL = 0.001;   // 0.1%
const MU_SIGMA_ERROR_REL = 0.01;   // 1%
const T95_TOLERANCE = 0.5;         // days

/** Whether parity comparison is enabled. */
export const FORECASTING_PARALLEL_RUN = true;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParityMismatch {
  edgeUuid: string;
  field: string;
  fe: number;
  be: number;
  delta: number;
}

// ── Main comparison ─────────────────────────────────────────────────────────

/**
 * Compare analytic vs analytic_be model_vars entries across all edges.
 *
 * Reads from edge.p.model_vars[] directly. Logs mismatches to session log.
 * Returns the list of mismatches (empty = parity OK).
 */
export function compareModelVarsSources(graph: any): ParityMismatch[] {
  if (!FORECASTING_PARALLEL_RUN) return [];

  const edges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
  const mismatches: ParityMismatch[] = [];
  let compared = 0;

  for (const edge of edges) {
    const modelVars: ModelVarsEntry[] | undefined = edge?.p?.model_vars;
    if (!modelVars || modelVars.length === 0) continue;

    const fe = modelVars.find(e => e.source === 'analytic');
    const be = modelVars.find(e => e.source === 'analytic_be');
    if (!fe || !be) continue;

    const edgeUuid = edge.uuid || edge.id || '';
    compared++;

    // Compare probability
    _check(mismatches, edgeUuid, 'p.mean', fe.probability.mean, be.probability.mean, 'relative');

    // Compare latency if both have it
    if (fe.latency && be.latency) {
      _check(mismatches, edgeUuid, 'mu', fe.latency.mu, be.latency.mu, 'relative');
      _check(mismatches, edgeUuid, 'sigma', fe.latency.sigma, be.latency.sigma, 'relative');
      _check(mismatches, edgeUuid, 't95', fe.latency.t95, be.latency.t95, 'absolute');

      // Path-level if both have it
      if (fe.latency.path_mu != null && be.latency.path_mu != null) {
        _check(mismatches, edgeUuid, 'path_mu', fe.latency.path_mu, be.latency.path_mu, 'relative');
      }
      if (fe.latency.path_sigma != null && be.latency.path_sigma != null) {
        _check(mismatches, edgeUuid, 'path_sigma', fe.latency.path_sigma, be.latency.path_sigma, 'relative');
      }
      if (fe.latency.path_t95 != null && be.latency.path_t95 != null) {
        _check(mismatches, edgeUuid, 'path_t95', fe.latency.path_t95, be.latency.path_t95, 'absolute');
      }
    }
  }

  // Log summary
  if (compared > 0) {
    if (mismatches.length === 0) {
      sessionLogService.success(
        'graph', 'ANALYTIC_PARITY_OK',
        `FE↔BE analytic parity: ${compared} edges compared, all within tolerance`,
      );
    } else {
      const uniqueEdges = new Set(mismatches.map(m => m.edgeUuid));
      sessionLogService.error(
        'graph', 'ANALYTIC_PARITY_MISMATCH',
        `FE↔BE analytic parity: ${mismatches.length} mismatches across ${uniqueEdges.size} edges (of ${compared} compared)`,
        mismatches.slice(0, 10).map(m =>
          `${m.edgeUuid.substring(0, 8)}:${m.field} FE=${m.fe.toFixed(4)} BE=${m.be.toFixed(4)} Δ=${m.delta.toFixed(4)}`
        ).join('\n'),
        { mismatches: mismatches.slice(0, 20) },
      );
    }
  }

  return mismatches;
}

// ── Internal ────────────────────────────────────────────────────────────────

function _check(
  out: ParityMismatch[],
  edgeUuid: string,
  field: string,
  fe: number,
  be: number,
  mode: 'relative' | 'absolute',
): void {
  const absDelta = Math.abs(fe - be);

  if (mode === 'relative') {
    const relDelta = absDelta / Math.max(1e-12, Math.abs(fe));
    if (relDelta > MU_SIGMA_ERROR_REL) {
      out.push({ edgeUuid, field, fe, be, delta: absDelta });
    } else if (relDelta > MU_SIGMA_WARN_REL) {
      sessionLogService.warning(
        'graph', 'ANALYTIC_PARITY_DRIFT',
        `${edgeUuid.substring(0, 8)}:${field} FE=${fe.toFixed(6)} BE=${be.toFixed(6)} rel=${(relDelta * 100).toFixed(3)}%`,
      );
    }
  } else {
    if (absDelta > T95_TOLERANCE) {
      out.push({ edgeUuid, field, fe, be, delta: absDelta });
    }
  }
}
