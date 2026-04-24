/**
 * CLI aggregation — calls the SAME fetchDataService.fetchItems() codepath
 * the browser uses. No parallel implementation.
 *
 * The browser's from-file flow:
 *   getItemsForFromFileLoad(graph) → fetchItems(items, { mode: 'from-file' }, graph, setGraph, dsl)
 *
 * This populates graph edges with evidence, forecast, latency, scope_from/to,
 * and runs the Stage 2 LAG topological pass — identical to the FE.
 */

import type { Graph } from '../types';
import { fetchItems, getItemsForFromFileLoad } from '../services/fetchDataService';
import type { FetchMode } from '../services/fetchDataService';
import type { GraphBundle } from './diskLoader';
import { log, isDiagnostic } from './logger';

export interface AggregateOptions {
  /** Fetch mode — 'from-file' (default) reads cached parameter files only;
   *  'versioned' tries cache first, fetches from external sources if stale/missing;
   *  'direct' always hits external sources (bypasses cache). */
  mode?: FetchMode;
  /** Workspace identity for snapshot-backed CLI passes (CF regime discovery). */
  workspace?: { repository: string; branch: string };
}

/**
 * Aggregate parameter file data for the requested DSL window and populate
 * graph edge fields using the real FE codepath (fetchDataService.fetchItems).
 *
 * By default uses mode='from-file' (local parameter files). Pass
 * `{ mode: 'versioned' }` to allow external fetching when cache is
 * stale or missing, or `{ mode: 'direct' }` to always hit external sources.
 *
 * Returns the populated graph. The graph is mutated in place by the fetch
 * pipeline (via setGraph), then returned.
 */
export async function aggregateAndPopulateGraph(
  bundle: GraphBundle,
  queryDsl: string,
  options?: AggregateOptions,
): Promise<{ graph: any; warnings: string[] }> {
  const graph: Graph = structuredClone(bundle.graph);
  const warnings: string[] = [];

  // Collect all fetchable items from the graph (topologically sorted)
  const items = getItemsForFromFileLoad(graph);

  if (isDiagnostic()) {
    log.diag('── Aggregation: fetchable items ──');
    for (const item of items) {
      log.diag(`  ${item.name || item.id}: type=${item.type || '—'}`);
    }
  }

  if (items.length === 0) {
    warnings.push('No fetchable items found in graph');
    return { graph, warnings };
  }

  // Mutable graph reference — fetchItems calls setGraph to update it
  let currentGraph: Graph = graph;
  const setGraph = (g: Graph | null) => {
    if (g) currentGraph = g;
  };

  const mode = options?.mode ?? 'from-file';

  // Run the exact same fetch pipeline the browser uses.
  // awaitBackgroundPromises: true — the CLI wants deterministic final
  // state before returning so param pack / diagnostics see the final
  // result of CF (including the CF slow-path overwrite of p.mean).
  // The browser leaves this false for fast first render.
  try {
    const results = await fetchItems(
      items,
      {
        mode,
        suppressMissingDataToast: true,
        suppressBatchToast: true,
        awaitBackgroundPromises: true,
        workspace: options?.workspace,
      },
      currentGraph,
      setGraph,
      queryDsl,
      () => currentGraph, // getUpdatedGraph — return current mutable ref
    );

    // Collect warnings from failed items
    for (const result of results) {
      if (!result.success) {
        const msg = result.error?.message || `Failed: ${result.item.name}`;
        warnings.push(`${result.item.name}: ${msg}`);
      }
    }
  } catch (err: any) {
    warnings.push(`Fetch pipeline error: ${err.message}`);
  }

  // Diagnostic: post-aggregation edge state
  if (isDiagnostic()) {
    log.diag('── Aggregation: post-aggregation edge state ──');
    for (const edge of (currentGraph.edges || [])) {
      const eid = edge.id || edge.uuid;
      const p = edge.p || {};
      const lat = p.latency || {};
      log.diag(`  ${eid}:`);
      log.diag(`    p.mean=${p.mean ?? '—'}  p.stdev=${p.stdev ?? '—'}`);
      log.diag(`    evidence: n=${p.evidence?.n ?? '—'} k=${p.evidence?.k ?? '—'} mean=${p.evidence?.mean ?? '—'}`);
      log.diag(`    forecast.mean=${p.forecast?.mean ?? '—'}`);
      log.diag(`    latency: completeness=${lat.completeness ?? '—'} t95=${lat.t95 ?? '—'} median_lag=${lat.median_lag_days ?? '—'}`);
      if (lat.mu != null || lat.sigma != null) {
        log.diag(`    latency fit: mu=${lat.mu ?? '—'} sigma=${lat.sigma ?? '—'} onset=${lat.onset_delta_days ?? '—'}`);
      }
      const latKeys = Object.keys(lat);
      if (latKeys.length > 0) {
        log.diag(`    latency keys: [${latKeys.join(', ')}]`);
      }
    }
  }

  return { graph: currentGraph, warnings };
}
