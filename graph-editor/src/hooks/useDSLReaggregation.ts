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
import { fetchDataService, createFetchItem, type FetchItem } from '../services/fetchDataService';
import { useFetchData } from './useFetchData';
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
  // PLANNER ANALYSIS — runs when currentDSL changes
  // ═══════════════════════════════════════════════════════════════════════════
  const currentDSL = graphStoreApi.getState().currentDSL;
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
          toast(result.summaries.toastMessage, { icon: '⚠️', duration: 4000 });
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
