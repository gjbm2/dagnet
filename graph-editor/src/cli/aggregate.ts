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

export interface AggregateOptions {
  /** Fetch mode — 'from-file' (default) reads cached parameter files only;
   *  'versioned' tries cache first, fetches from external sources if stale/missing;
   *  'direct' always hits external sources (bypasses cache). */
  mode?: FetchMode;
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

  // Run the exact same fetch pipeline the browser uses
  try {
    const results = await fetchItems(
      items,
      {
        mode,
        suppressMissingDataToast: true,
        suppressBatchToast: true,
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

  return { graph: currentGraph, warnings };
}
