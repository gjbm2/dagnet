/**
 * useDSLReaggregation — graph-level hook for reactive DSL re-aggregation.
 *
 * Extracted from WindowSelector. Watches currentDSL on the graph store and
 * when it changes:
 *   1. Runs windowFetchPlannerService.analyse() to check coverage
 *   2. If covered (stable or stale): re-aggregates from file automatically
 *   3. If not covered: exposes plannerResult for UI (Fetch button in WindowSelector)
 *
 * Lives at GraphEditor level — always mounted, works in dashboard mode.
 *
 * Does NOT:
 * - Trigger API fetches (that's the WindowSelector's Fetch button)
 * - Parse/display DSL (that's the WindowSelector)
 * - Know about views or scenarios (those set currentDSL; this reacts to it)
 */

import React, { useEffect, useRef, useState, useCallback, useContext, createContext } from 'react';
import { windowFetchPlannerService, type PlannerResult } from '../services/windowFetchPlannerService';
import {
  fetchDataService,
  createFetchItem,
  type FetchItem,
  initPipelineOp,
  setPipelineStep,
  completePipelineOp,
} from '../services/fetchDataService';
import { operationRegistryService } from '../services/operationRegistryService';
import { useFetchData } from './useFetchData';
import { contextLiveGraphForCurrentDsl } from '../services/posteriorSliceContexting';
import { fileRegistry } from '../contexts/TabContext';
import type { Graph } from '../types';
import toast from 'react-hot-toast';

export type { PlannerResult };

export interface UseDSLReaggregationOptions {
  /** The graph — reactive value from the graph store. */
  graph: Graph | null;
  /** Setter for graph — should go through graphMutationService pipeline. */
  setGraph: (graph: Graph | null) => void;
  /** Graph store API — for reading currentDSL imperatively. */
  graphStoreApi: { getState: () => { currentDSL: string; setCurrentDSL: (dsl: string) => void } };
  /** Whether this is a temporary/historical file (skip planner). */
  isTemporaryFile?: boolean;
}

export interface UseDSLReaggregationReturn {
  /** Latest planner analysis result (null until first analysis). */
  plannerResult: PlannerResult | null;
  /** True while auto-aggregation is running. */
  isAggregating: boolean;
  /** The DSL that was last successfully auto-aggregated. */
  lastAggregatedDSL: string | null;
}

export function useDSLReaggregation({
  graph,
  setGraph,
  graphStoreApi,
  isTemporaryFile = false,
}: UseDSLReaggregationOptions): UseDSLReaggregationReturn {
  const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null);
  const [isAggregating, setIsAggregating] = useState(false);

  // Refs for dedup and batch tracking
  const lastAnalysedDSLRef = useRef<string | null>(null);
  const lastAutoAggregatedDSLRef = useRef<string | null>(null);
  const lastAggregatedDSLRef = useRef<string | null>(null);
  const lastContextedDSLRef = useRef<string | null>(null);
  const isAggregatingRef = useRef(false);
  const isInitialMountRef = useRef(true);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Fetch hook — uses refs for batch operations to avoid stale closures
  const { fetchItems } = useFetchData({
    graph: () => graphRef.current,
    setGraph: (g) => {
      if (g) {
        graphRef.current = g;
        // Only commit to React state if not in batch mode
        if (!isAggregatingRef.current) {
          setGraph(g);
        }
      }
    },
    currentDSL: () => graphStoreApi.getState().currentDSL || '',
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE-EDGE CONTEXTING — refresh `p.posterior.*` and `p.latency.posterior.*`
  // (and the conditional_p mirrors) on `currentDSL` change.
  //
  // Doc 73b §3.2a / Stage 4(e). After Stage 4(b) removes the persistent
  // `_posteriorSlices` stash, the live edge no longer carries the
  // multi-context slice library — so on every `currentDSL` change the
  // matching slice must be re-projected from the parameter file. Without
  // this step, canvas displays that read the promoted/projected posterior
  // (the `'f'` mode chart, ModelRateChart, edge labels) would silently
  // stale on DSL change once Stage 4(c) removes CF's compensating
  // `forecast.mean = p_mean` write.
  //
  // Pure orchestration around the shared slice helper — match rules and
  // fallbacks live in `posteriorSliceResolution.ts`.
  // ═══════════════════════════════════════════════════════════════════════════
  const currentDSL = graphStoreApi.getState().currentDSL;
  useEffect(() => {
    if (isAggregatingRef.current) return;
    if (isTemporaryFile) return;
    if (!graph) return;

    const authoritativeDSL = graphStoreApi.getState().currentDSL || '';
    if (!authoritativeDSL) return;

    if (lastContextedDSLRef.current === authoritativeDSL) return;
    lastContextedDSLRef.current = authoritativeDSL;

    // Mutate a clone so React reconciliation sees a new reference (anti-pattern 3).
    const cloned = structuredClone(graph) as Graph;
    contextLiveGraphForCurrentDsl(
      cloned,
      (paramId: string) => fileRegistry.getFile(`parameter-${paramId}`)?.data,
      authoritativeDSL,
    );
    setGraph(cloned);
  }, [graph, currentDSL, isTemporaryFile, graphStoreApi, setGraph]);

  // ═══════════════════════════════════════════════════════════════════════════
  // POSTERIOR-LANDED RE-CONTEXT
  //
  // applyPatch / UpdateManager mappings both pick the bare `window()` slice
  // when projecting onto live edges — neither knows the active DSL. The
  // LIVE-EDGE CONTEXTING effect above is the single DSL-aware projection
  // path, but it is gated on `currentDSL` actually changing. After a fresh
  // fit lands, the DSL is unchanged so that effect skips, and the edges
  // hold the bare aggregate even when the user is on a context-qualified
  // or cohort() DSL. Stage 4(b) (removal of `_posteriorSlices`) plus
  // contexted Bayes outputs together created this hole.
  //
  // This listener fires when applyPatchAndCascade signals new posteriors,
  // invalidates the gating ref, and re-projects against the active DSL.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const handler = () => {
      if (isAggregatingRef.current) return;
      if (isTemporaryFile) return;
      const liveGraph = graphRef.current;
      if (!liveGraph) return;
      const authoritativeDSL = graphStoreApi.getState().currentDSL || '';
      if (!authoritativeDSL) return;
      const cloned = structuredClone(liveGraph) as Graph;
      contextLiveGraphForCurrentDsl(
        cloned,
        (paramId: string) => fileRegistry.getFile(`parameter-${paramId}`)?.data,
        authoritativeDSL,
      );
      lastContextedDSLRef.current = authoritativeDSL;
      setGraph(cloned);
    };
    window.addEventListener('dagnet:bayesPosteriorsUpdated', handler);
    return () => window.removeEventListener('dagnet:bayesPosteriorsUpdated', handler);
  }, [isTemporaryFile, graphStoreApi, setGraph]);


  useEffect(() => {
    if (isAggregatingRef.current) return;
    if (isTemporaryFile) return;

    const authoritativeDSL = graphStoreApi.getState().currentDSL || '';
    if (!authoritativeDSL || !graph) return;

    // Only run when DSL actually changes
    if (lastAnalysedDSLRef.current === authoritativeDSL) return;
    lastAnalysedDSLRef.current = authoritativeDSL;

    const trigger = isInitialMountRef.current ? 'initial_load' : 'dsl_change';

    windowFetchPlannerService.analyse(graph, authoritativeDSL, trigger)
      .then(result => {
        setPlannerResult(result);
        isInitialMountRef.current = false;

        if (result.summaries.showToast && result.summaries.toastMessage
            && result.analysisContext?.trigger !== 'initial_load') {
          // Route the "needs fetch" prompt through the operation registry
          // as a terminal pipeline op with a Fetch action button, rather
          // than a plain react-hot-toast. This keeps the indicator
          // machinery consistent (single column of ops at the bottom of
          // the viewport) and gives the user a one-click path to execute
          // the fetch without hunting for the WindowSelector button.
          const needsFetchOpId = 'dsl-planner-needs-fetch';
          // Remove any prior instance so a re-fired planner (e.g. the
          // user changed DSL again) doesn't stack up identical prompts.
          operationRegistryService.remove(needsFetchOpId);
          initPipelineOp(needsFetchOpId);
          setPipelineStep(needsFetchOpId, 'plan', 'complete',
            result.summaries.toastMessage);
          completePipelineOp(needsFetchOpId, 'warning',
            result.summaries.toastMessage,
            {
              label: 'Fetch',
              onClick: async () => {
                // Clear the prompt so the incoming fetch-pipeline op is
                // the only visible indicator.
                operationRegistryService.remove(needsFetchOpId);
                try {
                  await windowFetchPlannerService.executeFetchPlan(
                    graphRef.current as Graph,
                    (g) => { if (g) setGraph(g); },
                    graphStoreApi.getState().currentDSL || '',
                  );
                } catch (err: any) {
                  console.error('[useDSLReaggregation] Fetch action failed:', err);
                  toast.error(`Fetch failed: ${err?.message || err}`);
                }
              },
            });
        }
      })
      .catch(err => {
        console.error('[useDSLReaggregation] Planner analysis failed:', err);
      });
  }, [graph, currentDSL, isTemporaryFile, graphStoreApi]);

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-AGGREGATION — runs when planner says covered
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!plannerResult || plannerResult.status !== 'complete') return;
    // On initial load, trust persisted graph state
    if (plannerResult.analysisContext?.trigger === 'initial_load') return;
    // Only auto-aggregate when covered (stable or stale), not when not_covered
    if (plannerResult.outcome === 'not_covered') return;
    if (plannerResult.autoAggregationItems.length === 0) return;
    if (isAggregatingRef.current) return;

    const authoritativeDSL = graphStoreApi.getState().currentDSL || '';
    if (!authoritativeDSL) return;

    // Deduplicate — don't re-aggregate for the same DSL
    if (lastAutoAggregatedDSLRef.current === authoritativeDSL) return;

    isAggregatingRef.current = true;
    setIsAggregating(true);

    const items = plannerResult.autoAggregationItems.map(i =>
      createFetchItem(i.type, i.objectId, i.targetId, { paramSlot: i.paramSlot })
    );

    fetchItems(items, { mode: 'from-file' })
      .then(() => {
        // Commit accumulated graph changes to React state
        const updatedGraph = graphRef.current;
        if (updatedGraph) {
          setGraph(updatedGraph);
        }

        lastAutoAggregatedDSLRef.current = authoritativeDSL;
        lastAggregatedDSLRef.current = authoritativeDSL;
      })
      .finally(() => {
        isAggregatingRef.current = false;
        setIsAggregating(false);
      });
  }, [plannerResult, graphStoreApi, setGraph, fetchItems]);

  return {
    plannerResult,
    isAggregating,
    lastAggregatedDSL: lastAggregatedDSLRef.current,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Context — allows WindowSelector to read plannerResult without prop drilling
// ═══════════════════════════════════════════════════════════════════════════

const DSLReaggregationContext = createContext<UseDSLReaggregationReturn | null>(null);

export function DSLReaggregationProvider({
  value,
  children,
}: {
  value: UseDSLReaggregationReturn;
  children: React.ReactNode;
}) {
  return React.createElement(DSLReaggregationContext.Provider, { value }, children);
}

export function useDSLReaggregationContext(): UseDSLReaggregationReturn | null {
  return useContext(DSLReaggregationContext);
}
