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

// ── Graph preference revert (internal) ──────────────────────────────────────

/**
 * Invalidate the bayesian model_vars entry on matching edges so that
 * bayesianIfGated() falls through to analytic on the next promotion.
 *
 * Sets quality.gate_passed = false (entry stays for reference/display).
 * Also clears any explicit bayesian pin so the preference resolves via
 * best_available → bayesianIfGated() → gate fails → analytic.
 *
 * When `clearPosterior` is true, also removes edge.p.posterior so that
 * the forecast quality overlay immediately reflects no-data (grey).
 */
function invalidateBayesianOnEdges(
  graph: GraphData,
  paramId: string,
  opts?: { clearPosterior?: boolean },
): boolean {
  let changed = false;
  for (const edge of (graph.edges ?? []) as any[]) {
    if (edge.p?.id !== paramId) continue;

    // Clear explicit bayesian pin
    if (edge.p.model_source_preference === 'bayesian' ||
        edge.p.model_source_preference_overridden) {
      delete edge.p.model_source_preference;
      delete edge.p.model_source_preference_overridden;
      changed = true;
    }

    // Fail the gate on the bayesian model_vars entry
    if (Array.isArray(edge.p.model_vars)) {
      const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
      if (bayesEntry) {
        if (!bayesEntry.quality) bayesEntry.quality = {};
        bayesEntry.quality.gate_passed = false;
        changed = true;
      }
    }

    // Remove posterior + stashed slices from the live graph edge so
    // forecast quality view immediately shows no-data, and the
    // re-projection pipeline doesn't resurrect stale posterior data.
    if (opts?.clearPosterior) {
      if (edge.p.posterior) { delete edge.p.posterior; changed = true; }
      if (edge.p._posteriorSlices) { delete edge.p._posteriorSlices; changed = true; }
      if (edge.p.latency?.posterior) { delete edge.p.latency.posterior; changed = true; }
    }
  }
  return changed;
}

// ── Single-param operations ─────────────────────────────────────────────────

/**
 * Set `latency.bayes_reset: true` on a single parameter file and revert
 * the edge's model source preference away from bayesian.
 *
 * Non-destructive: previous posterior remains in fit_history.
 * The evidence binder will ignore the bayesian posterior on the next run
 * and fall back to analytic-derived priors.
 *
 * When `graphMutation` is provided the service also clears any bayesian
 * pin on the matching graph edge(s), so the next stats pass promotes the
 * analytic entry (with fresh latency values) instead of the stale
 * bayesian entry.
 */
export async function resetPriorsForParam(
  paramId: string,
  graphMutation?: {
    graph: GraphData;
    setGraph: (g: GraphData) => void;
  },
): Promise<boolean> {
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

  // Invalidate bayesian entry directly on the live graph (in-place).
  // The caller triggers a from-file fetch immediately after, which clones
  // this graph — the clone inherits the invalidated gates.
  if (graphMutation) {
    if (invalidateBayesianOnEdges(graphMutation.graph, paramId)) {
      sessionLogService.info('data-update', 'BAYES_RESET_GATE_INVALIDATED',
        `Invalidated bayesian gate for ${paramId} — analytic will be promoted`);
    }
  }

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
 * Delete the entire posterior block from a single parameter file.
 * Destructive: removes posterior, fit_history, and all diagnostics.
 * Caller should confirm with the user before calling.
 *
 * When `graphMutation` is provided, also invalidates the bayesian
 * model_vars entry and clears any bayesian pin on matching edges,
 * so the forecast quality view immediately reflects no-data state.
 */
export async function deleteHistoryForParam(
  paramId: string,
  graphMutation?: {
    graph: GraphData;
    setGraph: (g: GraphData) => void;
  },
): Promise<boolean> {
  const fileId = `parameter-${paramId}`;
  const entry = fileRegistry.getFile(fileId);
  if (!entry) {
    sessionLogService.warning('data-update', 'BAYES_HISTORY_DELETE_SKIP',
      `Cannot delete history: parameter file not loaded (${paramId})`);
    return false;
  }

  if (entry.data?.posterior) {
    const doc = { ...entry.data };
    delete doc.posterior;
    await fileRegistry.updateFile(fileId, doc);
    sessionLogService.info('data-update', 'BAYES_HISTORY_DELETED',
      `Deleted posterior from ${paramId}`);

    // Invalidate bayesian entry and clear posterior on the live graph
    // so forecast quality view immediately shows no-data.
    if (graphMutation) {
      if (invalidateBayesianOnEdges(graphMutation.graph, paramId, { clearPosterior: true })) {
        sessionLogService.info('data-update', 'BAYES_HISTORY_DELETE_GATE_INVALIDATED',
          `Invalidated bayesian gate and cleared posterior for ${paramId}`);
      }
    }

    return true;
  }
  return false;
}

// ── Bulk operations ─────────────────────────────────────────────────────────

/**
 * Bulk: set `bayes_reset` on all parameter files referenced by graph edges
 * and revert any edge-level bayesian pins.
 *
 * When `setGraph` is provided, also reverts graph-level preference if it
 * is 'bayesian', ensuring the whole graph falls back to analytic.
 *
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

    // Param file flag only — graph preference is reverted in bulk below
    const ok = await resetPriorsForParam(paramId);
    if (ok) {
      count++;
      sessionLogService.addChild(logOpId, 'debug', 'BAYES_RESET_EDGE',
        `Reset priors: ${paramId}`);
    }
  }

  // Invalidate bayesian entries + clear bayesian pins directly on the live graph.
  //
  // CRITICAL: Mutate in-place rather than clone+setGraph.  The caller will
  // immediately trigger a from-file fetch that clones this graph, runs the
  // stats pass + applyPromotion, and calls setGraph with the enhanced result.
  // If we clone+setGraph here, the fetch's final setGraph overwrites our
  // changes (race condition observed in production).  In-place mutation
  // ensures the fetch's clone inherits the invalidated gates.
  if (count > 0) {
    const liveGraph = getGraph();
    if (liveGraph) {
      for (const edge of (liveGraph.edges ?? []) as any[]) {
        // Clear explicit bayesian pin
        if (edge.p?.model_source_preference === 'bayesian' ||
            edge.p?.model_source_preference_overridden) {
          delete edge.p.model_source_preference;
          delete edge.p.model_source_preference_overridden;
        }

        // Fail the gate on bayesian model_vars entry
        if (Array.isArray(edge.p?.model_vars)) {
          const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
          if (bayesEntry) {
            if (!bayesEntry.quality) bayesEntry.quality = {};
            bayesEntry.quality.gate_passed = false;
          }
        }
      }

      // Graph-level: revert to best_available if pinned to bayesian
      if ((liveGraph as any).model_source_preference === 'bayesian') {
        (liveGraph as any).model_source_preference = 'best_available';
      }

      sessionLogService.info('data-update', 'BAYES_RESET_ALL_GATES_INVALIDATED',
        'Invalidated bayesian gates on all edges — analytic will be promoted');
    }
  }

  sessionLogService.endOperation(logOpId, 'success',
    `Reset Bayesian priors on ${count} parameter(s)`);
  return count;
}

/**
 * Bulk: delete posterior from all parameter files referenced by graph edges.
 * Also invalidates bayesian model_vars entries and clears bayesian pins
 * on the live graph so forecast quality view reflects no-data immediately.
 * Returns the number of parameters updated.
 */
export async function deleteHistoryForAllParams(
  getGraph: () => GraphData | null,
): Promise<number> {
  const graph = getGraph();
  if (!graph?.edges) return 0;

  const logOpId = sessionLogService.startOperation(
    'info', 'data-update', 'BAYES_HISTORY_DELETE_ALL',
    'Delete Bayesian posteriors for all parameters');

  let count = 0;
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const paramId = (edge as any).p?.id;
    if (!paramId || seen.has(paramId)) continue;
    seen.add(paramId);

    // Param file deletion only — graph edges invalidated in bulk below
    const ok = await deleteHistoryForParam(paramId);
    if (ok) {
      count++;
      sessionLogService.addChild(logOpId, 'debug', 'BAYES_HISTORY_DELETE_EDGE',
        `Deleted posterior: ${paramId}`);
    }
  }

  // ALWAYS invalidate bayesian entries + clear posterior data on the live
  // graph (in-place), regardless of whether param files had anything to
  // delete. The graph edges may still carry stale posterior/slices from a
  // previous hydration even after param files were cleaned in an earlier run.
  const liveGraph = getGraph();
  let edgesCleared = false;
  if (liveGraph) {
    for (const edge of (liveGraph.edges ?? []) as any[]) {
      // Clear explicit bayesian pin
      if (edge.p?.model_source_preference === 'bayesian' ||
          edge.p?.model_source_preference_overridden) {
        delete edge.p.model_source_preference;
        delete edge.p.model_source_preference_overridden;
        edgesCleared = true;
      }

      // Fail the gate on bayesian model_vars entry
      if (Array.isArray(edge.p?.model_vars)) {
        const bayesEntry = edge.p.model_vars.find((v: any) => v.source === 'bayesian');
        if (bayesEntry) {
          if (!bayesEntry.quality) bayesEntry.quality = {};
          bayesEntry.quality.gate_passed = false;
          edgesCleared = true;
        }
      }

      // Clear posterior + stashed slices so forecast quality view shows
      // no-data and re-projection doesn't resurrect stale data
      if (edge.p?.posterior) { delete edge.p.posterior; edgesCleared = true; }
      if (edge.p?._posteriorSlices) { delete edge.p._posteriorSlices; edgesCleared = true; }
      if (edge.p?.latency?.posterior) { delete edge.p.latency.posterior; edgesCleared = true; }
    }

    if (edgesCleared) {
      sessionLogService.info('data-update', 'BAYES_HISTORY_DELETE_ALL_EDGES_CLEARED',
        'Cleared posteriors and bayesian gates on all edges');
    }
  }

  sessionLogService.endOperation(logOpId, 'success',
    `Deleted posteriors from ${count} parameter(s)`);
  // Return max of count and edgesCleared so caller knows work was done
  return edgesCleared ? Math.max(count, 1) : count;
}
