/**
 * Forecasting Parity Service — parallel-run comparison of FE vs BE model fitting.
 *
 * Compares frontend-computed mu/sigma (from the topo/LAG pass) against
 * backend-computed mu/sigma (from the recompute API). Emits detailed diagnostic
 * errors to session log and console on mismatch.
 *
 * Gated by FORECASTING_PARALLEL_RUN flag.
 *
 * See analysis-forecasting.md §7.0 (parallel-run migration strategy).
 */

import { sessionLogService } from './sessionLogService';
import { FORECASTING_PARALLEL_RUN, type RecomputeResult } from './lagRecomputeService';

/** Tolerance for mu/sigma comparison (absolute). */
const MU_SIGMA_TOLERANCE = 1e-4;

/** Tolerance for t95 comparison (days). */
const T95_TOLERANCE = 0.5;

/** Tolerance for completeness comparison (absolute). */
const COMPLETENESS_TOLERANCE = 1e-3;

export interface FEModelParams {
  edgeUuid: string;
  conditionalIndex?: number;
  mu: number;
  sigma: number;
  t95: number;
  onset_delta_days: number;
  completeness: number;
}

/**
 * Compare FE-computed model params against BE recompute results.
 *
 * For each subject with a matching FE edge, compares mu, sigma, t95.
 * Logs detailed diagnostics on mismatch. No-op when flag is off or BE is null.
 */
export function compareModelFits(
  feModels: FEModelParams[],
  beResults: RecomputeResult[] | null,
): void {
  if (!FORECASTING_PARALLEL_RUN) return;
  if (!beResults) return;

  for (const be of beResults) {
    if (!be.success || be.mu === undefined || be.sigma === undefined) continue;

    // Match by subject_id → edgeUuid.
    // subject_id from the recompute API uses the same target.targetId as the edge UUID.
    const fe = feModels.find(f => f.edgeUuid === be.subject_id);
    if (!fe) continue;

    const checks: Array<{ field: string; fe: number; be: number; tol: number }> = [
      { field: 'mu', fe: fe.mu, be: be.mu, tol: MU_SIGMA_TOLERANCE },
      { field: 'sigma', fe: fe.sigma, be: be.sigma!, tol: MU_SIGMA_TOLERANCE },
    ];
    if (be.t95_days !== undefined) {
      checks.push({ field: 't95_days', fe: fe.t95, be: be.t95_days, tol: T95_TOLERANCE });
    }

    for (const check of checks) {
      const delta = Math.abs(check.fe - check.be);
      if (delta > check.tol) {
        const msg = `[FORECASTING_PARITY] Mismatch: ${check.field} for edge ${fe.edgeUuid}` +
          ` | FE=${check.fe.toFixed(6)} BE=${check.be.toFixed(6)}` +
          ` | delta=${delta.toFixed(6)} tol=${check.tol}` +
          ` | onset_delta=${fe.onset_delta_days}`;

        console.error(msg);
        sessionLogService.error(
          'graph',
          'FORECASTING_PARITY_MISMATCH',
          msg,
          undefined,
          {
            edgeUuid: fe.edgeUuid,
            conditionalIndex: fe.conditionalIndex,
            field: check.field,
            fe_value: check.fe,
            be_value: check.be,
            delta,
            tolerance: check.tol,
            fe_onset_delta: fe.onset_delta_days,
            be_onset_delta: be.onset_delta_days,
            be_quality_ok: be.quality_ok,
            be_total_k: be.total_k,
          },
        );
      }
    }
  }
}

/**
 * Compare per-anchor-day completeness from BE analysis response against FE computation.
 *
 * For each data point, compares BE completeness against FE-computed completeness.
 * Logs diagnostics on mismatch. No-op when flag is off.
 */
export function compareCompleteness(
  subjectId: string,
  beDataPoints: Array<{ anchor_day: string; completeness?: number }>,
  feCompleteness: Map<string, number>, // anchor_day → FE completeness
): void {
  if (!FORECASTING_PARALLEL_RUN) return;

  for (const bp of beDataPoints) {
    if (bp.completeness === undefined || bp.completeness === null) continue;
    const feC = feCompleteness.get(bp.anchor_day);
    if (feC === undefined) continue;

    const delta = Math.abs(feC - bp.completeness);
    if (delta > COMPLETENESS_TOLERANCE) {
      const msg = `[FORECASTING_PARITY] Completeness mismatch: ${subjectId} anchor=${bp.anchor_day}` +
        ` | FE=${feC.toFixed(6)} BE=${bp.completeness.toFixed(6)}` +
        ` | delta=${delta.toFixed(6)} tol=${COMPLETENESS_TOLERANCE}`;

      console.error(msg);
      sessionLogService.error(
        'graph',
        'FORECASTING_PARITY_COMPLETENESS',
        msg,
        undefined,
        {
          subjectId,
          anchor_day: bp.anchor_day,
          fe_completeness: feC,
          be_completeness: bp.completeness,
          delta,
          tolerance: COMPLETENESS_TOLERANCE,
        },
      );
    }
  }
}
