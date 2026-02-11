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

/**
 * Parity thresholds (temporary; Feb 2026).
 *
 * Rationale:
 * In dev we expect FE vs BE drift when the snapshot DB contains a different evidence
 * history than the parameter files (forecast development). This is usually harmless.
 *
 * Therefore:
 * - warn on relative drift > 0.1%
 * - hard error on relative drift > 1%
 *
 * This applies to mu/sigma only. We keep an absolute guard for t95 (days) to avoid
 * noisy percent-based warnings on a days-scale metric.
 */
const MU_SIGMA_WARN_REL = 0.001;  // 0.1%
const MU_SIGMA_ERROR_REL = 0.01; // 1%

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

  const mismatches: Array<{
    edgeUuid: string;
    field: string;
    fe: number;
    be: number;
    delta: number;
    tol: number;
  }> = [];

  for (const be of beResults) {
    if (!be.success || be.mu === undefined || be.sigma === undefined) continue;

    // Match by subject_id → edgeUuid.
    // subject_id from the recompute API uses the same target.targetId as the edge UUID.
    const fe = feModels.find(f => f.edgeUuid === be.subject_id);
    if (!fe) continue;

    const checks: Array<{ field: string; fe: number; be: number; tol: number; mode: 'relative' | 'absolute' }> = [
      { field: 'mu', fe: fe.mu, be: be.mu, tol: MU_SIGMA_ERROR_REL, mode: 'relative' },
      { field: 'sigma', fe: fe.sigma, be: be.sigma!, tol: MU_SIGMA_ERROR_REL, mode: 'relative' },
    ];
    if (be.t95_days !== undefined) {
      checks.push({ field: 't95_days', fe: fe.t95, be: be.t95_days, tol: T95_TOLERANCE, mode: 'absolute' });
    }

    for (const check of checks) {
      const absDelta = Math.abs(check.fe - check.be);
      const relDelta = absDelta / Math.max(1e-12, Math.abs(check.fe));
      const isMuSigma = (check.field === 'mu' || check.field === 'sigma');

      const shouldWarn =
        check.mode === 'relative'
          ? (relDelta > MU_SIGMA_WARN_REL)
          : false;

      const shouldError =
        check.mode === 'relative'
          ? (relDelta > MU_SIGMA_ERROR_REL)
          : (absDelta > check.tol);

      if (shouldWarn || shouldError) {
        const reqSubj = (be as any)?.__parity_request_subject as any | undefined;
        const driftPart =
          check.mode === 'relative'
            ? `abs=${absDelta.toFixed(6)} rel=${(relDelta * 100).toFixed(3)}%`
            : `abs=${absDelta.toFixed(6)} tol=${check.tol}`;
        const msg = `[FORECASTING_PARITY] Drift: ${check.field} for edge ${fe.edgeUuid}` +
          ` | FE=${check.fe.toFixed(6)} BE=${check.be.toFixed(6)}` +
          ` | ${driftPart}` +
          ` | onset_delta=${fe.onset_delta_days}`;

        const ctx = {
          edgeUuid: fe.edgeUuid,
          conditionalIndex: fe.conditionalIndex,
          field: check.field,
          fe_value: check.fe,
          be_value: check.be,
          abs_delta: absDelta,
          rel_delta: check.mode === 'relative' ? relDelta : undefined,
          thresholds: check.mode === 'relative' ? { warn_rel: MU_SIGMA_WARN_REL, error_rel: MU_SIGMA_ERROR_REL } : { error_abs: check.tol },
          fe_onset_delta: fe.onset_delta_days,
          be_onset_delta: be.onset_delta_days,
          be_quality_ok: be.quality_ok,
          be_total_k: be.total_k,
          be_evidence_anchor_days: (be as any).evidence_anchor_days,
          be_training_window: (be as any).training_window,
          be_settings_signature: (be as any).settings_signature,
          request_subject: reqSubj
            ? {
                subject_id: reqSubj.subject_id,
                param_id: reqSubj.param_id,
                core_hash: reqSubj.core_hash,
                slice_keys: reqSubj.slice_keys,
                anchor_from: reqSubj.anchor_from,
                anchor_to: reqSubj.anchor_to,
                onset_delta_days: reqSubj.onset_delta_days,
              }
            : undefined,
        };

        if (shouldError || !isMuSigma) {
          console.error(msg);
          sessionLogService.error('graph', 'FORECASTING_PARITY_MISMATCH', msg, undefined, ctx);
          mismatches.push({
            edgeUuid: fe.edgeUuid,
            field: check.field,
            fe: check.fe,
            be: check.be,
            delta: absDelta,
            tol: check.tol,
          });
        } else {
          sessionLogService.warning('graph', 'FORECASTING_PARITY_DRIFT', msg, undefined, ctx);
        }
      }
    }
  }

  // Structural parity check: when enabled, mismatches are a hard failure.
  if (mismatches.length) {
    const head = mismatches.slice(0, 5).map(m =>
      `${m.edgeUuid}:${m.field} FE=${m.fe.toFixed(6)} BE=${m.be.toFixed(6)} Δ=${m.delta.toFixed(6)} tol=${m.tol}`
    ).join(' | ');
    throw new Error(
      `[FORECASTING_PARITY] Hard fail: ${mismatches.length} mismatch(es). ${head}`
    );
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
