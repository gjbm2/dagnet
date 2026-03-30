/**
 * Bayes Prior Service
 *
 * Provides reset-priors and delete-history operations for Bayesian posteriors.
 * Used by: BayesPosteriorCard (single edge), Data Menu (bulk, all edges).
 *
 * See: docs/current/project-bayes/19-model-vars-production-consumption-separation.md §4.5
 */

import { fileRegistry } from '../contexts/TabContext';
import { sessionLogService } from './sessionLogService';
import type { GraphData } from '../types';

/**
 * Set `latency.bayes_reset: true` on a single parameter file.
 * Non-destructive: previous posterior remains in fit_history.
 * The evidence binder will ignore the bayesian posterior on the next run
 * and fall back to analytic-derived priors.
 */
export async function resetPriorsForParam(paramId: string): Promise<boolean> {
  const fileId = `parameter-${paramId}`;
  const entry = fileRegistry.getFile(fileId);
  if (!entry) {
    sessionLogService.warning('data-update', 'BAYES_RESET_SKIP',
      `Cannot reset priors: parameter file not loaded (${paramId})`);
    return false;
  }

  const doc = { ...entry.data };
  if (!doc.latency) doc.latency = {};
  doc.latency = { ...doc.latency, bayes_reset: true };

  await fileRegistry.updateFile(fileId, doc);
  sessionLogService.info('data-update', 'BAYES_RESET_SET',
    `Set bayes_reset on ${paramId} — next run will use analytic priors`);
  return true;
}

/**
 * Clear `latency.bayes_reset` flag on a single parameter file.
 * Called automatically after a successful Bayesian fit.
 */
export async function clearBayesResetForParam(paramId: string): Promise<void> {
  const fileId = `parameter-${paramId}`;
  const entry = fileRegistry.getFile(fileId);
  if (!entry) return;

  if (entry.data?.latency?.bayes_reset) {
    const doc = { ...entry.data };
    const lat = { ...doc.latency };
    delete lat.bayes_reset;
    doc.latency = lat;
    await fileRegistry.updateFile(fileId, doc);
    sessionLogService.info('data-update', 'BAYES_RESET_CLEARED',
      `Cleared bayes_reset on ${paramId} after successful fit`);
  }
}

/**
 * Delete all fit_history from a single parameter file's posterior block.
 * Destructive: fit_history is used for volatility/meta-dispersion estimation.
 * Caller should confirm with the user before calling.
 */
export async function deleteHistoryForParam(paramId: string): Promise<boolean> {
  const fileId = `parameter-${paramId}`;
  const entry = fileRegistry.getFile(fileId);
  if (!entry) {
    sessionLogService.warning('data-update', 'BAYES_HISTORY_DELETE_SKIP',
      `Cannot delete history: parameter file not loaded (${paramId})`);
    return false;
  }

  if (entry.data?.posterior?.fit_history) {
    const doc = { ...entry.data };
    const posterior = { ...doc.posterior };
    delete posterior.fit_history;
    doc.posterior = posterior;
    await fileRegistry.updateFile(fileId, doc);
    sessionLogService.info('data-update', 'BAYES_HISTORY_DELETED',
      `Deleted fit_history from ${paramId}`);
    return true;
  }
  return false;
}

/**
 * Bulk: set `bayes_reset` on all parameter files referenced by graph edges.
 * Returns the number of parameters updated.
 */
export async function resetPriorsForAllParams(
  getGraph: () => GraphData | null,
): Promise<number> {
  const graph = getGraph();
  if (!graph?.edges) return 0;

  const logOpId = sessionLogService.startOperation(
    'info', 'data-update', 'BAYES_RESET_ALL',
    'Reset Bayesian priors for all parameters');

  let count = 0;
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const paramId = (edge as any).p?.id;
    if (!paramId || seen.has(paramId)) continue;
    seen.add(paramId);

    const ok = await resetPriorsForParam(paramId);
    if (ok) {
      count++;
      sessionLogService.addChild(logOpId, 'info', 'BAYES_RESET_EDGE',
        `Reset priors: ${paramId}`);
    }
  }

  sessionLogService.endOperation(logOpId, 'success',
    `Reset Bayesian priors on ${count} parameter(s)`);
  return count;
}

/**
 * Bulk: delete fit_history from all parameter files referenced by graph edges.
 * Returns the number of parameters updated.
 */
export async function deleteHistoryForAllParams(
  getGraph: () => GraphData | null,
): Promise<number> {
  const graph = getGraph();
  if (!graph?.edges) return 0;

  const logOpId = sessionLogService.startOperation(
    'info', 'data-update', 'BAYES_HISTORY_DELETE_ALL',
    'Delete Bayesian fit history for all parameters');

  let count = 0;
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const paramId = (edge as any).p?.id;
    if (!paramId || seen.has(paramId)) continue;
    seen.add(paramId);

    const ok = await deleteHistoryForParam(paramId);
    if (ok) {
      count++;
      sessionLogService.addChild(logOpId, 'info', 'BAYES_HISTORY_DELETE_EDGE',
        `Deleted history: ${paramId}`);
    }
  }

  sessionLogService.endOperation(logOpId, 'success',
    `Deleted fit history from ${count} parameter(s)`);
  return count;
}
