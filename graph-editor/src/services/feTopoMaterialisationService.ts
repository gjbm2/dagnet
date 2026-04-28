/**
 * FE topo materialisation helper — doc 73e §8.3 Stage 5 item 7.
 *
 * Wraps `fetchDataService.fetchItems` so the same Stage 2 enrichment that
 * runs inside the live fetch pipeline (`enhanceGraphLatencies` plus the
 * Step 2 promotion / current-answer derivation) becomes callable from any
 * materialisation site after projection lands.
 *
 * Used by the four laggard callers identified in §8.2.1b:
 *   - params-only custom recipe
 *   - graph-bearing custom recipe
 *   - fixed recipe
 *   - CLI `analyse` (re-run after re-context to match browser semantics)
 *
 * The four already-materialised callers (current edit, live regeneration,
 * refresh-all/boot, share restore) keep invoking FE topo through the fetch
 * pipeline; this helper is the same code, just usable outside it.
 *
 * Read-only materialisation only: CF dispatch is suppressed via
 * `skipConditionedForecast: true`. The graph-mutating CF lifecycle stays
 * on the fetch pipeline for callers that own it.
 *
 * Failure observability (Stage 5 item 6):
 *   When a fetchable item fails (parameter file absent, slice missing for
 *   the effective DSL, etc.), the helper emits a single `warning`-level
 *   session log entry naming the scenario, the affected items, and the
 *   missing inputs, and returns `notFullyMaterialised: true` on the result.
 *   Downstream surfacing reads that signal; it does not invent it.
 */

import type { Graph } from '../types';
import {
  fetchItems,
  getItemsForFromFileLoad,
  type FetchItem,
  type FetchMode,
} from './fetchDataService';
import { createConditionedForecastSupersessionState } from './conditionedForecastSupersessionState';
import { sessionLogService } from './sessionLogService';

export interface MaterialisationFailureDetail {
  /** The fetch item that failed. */
  itemId: string;
  /** Human-readable item name (parameter id, edge id, etc.). */
  itemName: string;
  /** The fetch item type — 'parameter', 'edge', etc. */
  itemType?: string;
  /** Error message returned by the fetch pipeline. */
  message: string;
}

export interface MaterialiseScenarioFeTopoOptions {
  /** Scenario id used for diagnostic context. */
  scenarioId?: string;
  /** Scenario name used for session-log message. */
  scenarioName?: string;
  /** Workspace identity for from-file lookups (CLI / non-browser callers). */
  workspace?: { repository: string; branch: string };
  /**
   * Override fetch mode. Defaults to `'from-file'` — the materialisation
   * path is read-only, no external sources. Pass `'versioned'` if a
   * caller needs cache+external semantics (CLI `--allow-external-fetch`).
   */
  mode?: FetchMode;
  /**
   * Override the analysis-date used for cohort age calculations. Mainly
   * for tests; defaults to `new Date()`.
   */
  queryDate?: Date;
  /**
   * Suppress the per-call session log warning when materialisation fails.
   * The marker on the returned object is unaffected. Default false.
   */
  suppressFailureLog?: boolean;
}

export interface MaterialiseScenarioFeTopoResult {
  /** The graph after Stage 2 enrichment applied. Same identity as input. */
  graph: Graph;
  /**
   * True when one or more fetchable items did not complete. The graph is
   * still usable but downstream surfaces (chart badge, share banner, CLI
   * non-zero exit) MUST surface the signal as defined per surface in
   * §8.3 Stage 5 item 6.
   */
  notFullyMaterialised: boolean;
  /** Per-item failure details for downstream rendering. */
  failures: MaterialisationFailureDetail[];
}

/**
 * Materialise FE topo state on a scenario graph that has already been
 * composed and posterior-projected for its effective DSL.
 *
 * Mutates `graph` via the same `setGraph` callback shape `fetchItems`
 * uses. Returns the final graph reference plus the materialisation
 * verdict.
 */
export async function materialiseScenarioFeTopo(
  graph: Graph,
  effectiveQueryDsl: string,
  options: MaterialiseScenarioFeTopoOptions = {},
): Promise<MaterialiseScenarioFeTopoResult> {
  const items: FetchItem[] = getItemsForFromFileLoad(graph);
  const failures: MaterialisationFailureDetail[] = [];

  if (items.length === 0) {
    // No fetchable items — nothing to do and nothing to fail. Caller's
    // graph is already as materialised as it is going to get.
    return { graph, notFullyMaterialised: false, failures };
  }

  // Mutable graph reference — fetchItems calls setGraph to update it.
  let currentGraph: Graph = graph;
  const setGraph = (g: Graph | null) => {
    if (g) currentGraph = g;
  };

  const cfSupersessionState = createConditionedForecastSupersessionState();

  try {
    const results = await fetchItems(
      items,
      {
        mode: options.mode ?? 'from-file',
        suppressMissingDataToast: true,
        suppressBatchToast: true,
        suppressPipelineToast: true,
        awaitBackgroundPromises: true,
        skipConditionedForecast: true,
        scenarioId: options.scenarioId,
        scenarioLabel: options.scenarioName,
        cfSupersessionState,
        workspace: options.workspace,
        queryDate: options.queryDate,
      } as any,
      currentGraph,
      setGraph,
      effectiveQueryDsl,
      () => currentGraph,
    );

    for (const result of results) {
      if (!result.success) {
        failures.push({
          itemId: result.item.id,
          itemName: result.item.name || result.item.id,
          itemType: result.item.type,
          message: result.error?.message || 'unknown failure',
        });
      }
    }
  } catch (err: any) {
    failures.push({
      itemId: '<pipeline>',
      itemName: 'fetch pipeline',
      message: err?.message || String(err),
    });
  }

  if (failures.length > 0 && !options.suppressFailureLog) {
    const scenarioLabel = options.scenarioName || options.scenarioId || 'unknown';
    const detail = failures
      .map((f) => `${f.itemName}: ${f.message}`)
      .join('; ');
    sessionLogService.warning(
      'data-fetch',
      'MATERIALISATION_INCOMPLETE',
      `Scenario '${scenarioLabel}' not fully materialised — ${failures.length} item${failures.length === 1 ? '' : 's'} failed`,
      detail,
      { scenarioId: options.scenarioId, dsl: effectiveQueryDsl } as any,
    );
  }

  return {
    graph: currentGraph,
    notFullyMaterialised: failures.length > 0,
    failures,
  };
}
