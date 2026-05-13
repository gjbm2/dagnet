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
import { fileRegistry } from '../contexts/TabContext';
import type { Graph } from '../types';
import toast from 'react-hot-toast';

/**
 * Drift detection: returns descriptors for any edge whose
 * `model_vars[bayesian].fit_diagnostics.probability` lags the parameter
 * file's `posterior.{fitted_at, fingerprint}`. Drift signals (any one is
 * sufficient):
 *   • file has a fit but the edge has no bayesian source ledger entry
 *   • file's fitted_at is newer than the edge's
 *   • fingerprints differ
 *
 * `resolveParameterFile` returns the parameter file's `data` for a given
 * paramId, or undefined/null when the file is not registered. Parameterised
 * (rather than calling `fileRegistry` directly) so the function is testable
 * as a pure unit.
 *
 * When `filterParamId` is given, only edges referencing that paramId are
 * inspected (used by the post-write subscription path so a single file
 * change doesn't trigger a graph-wide re-fetch).
 *
 * Returns descriptors only; the caller builds FetchItems via
 * createFetchItem(type, objectId, targetId, { paramSlot }).
 */
export function collectDriftedBayesEdges(
  graph: Graph | null,
  resolveParameterFile: (paramId: string) => any,
  filterParamId?: string,
): Array<{ paramId: string; edgeId: string }> {
  if (!graph?.edges) return [];
  const out: Array<{ paramId: string; edgeId: string }> = [];
  for (const edge of graph.edges as any[]) {
    const paramId: string | undefined = edge?.p?.id;
    if (!paramId) continue;
    if (filterParamId && paramId !== filterParamId) continue;

    const file = resolveParameterFile(paramId);
    const fileFitted: string | undefined = file?.posterior?.fitted_at;
    if (!fileFitted) continue; // file has no bayes — nothing to drift against

    const edgeBayes = Array.isArray(edge?.p?.model_vars)
      ? edge.p.model_vars.find((mv: any) => mv?.source === 'bayesian')
      : undefined;
    const edgeFitted: string | undefined = edgeBayes?.fit_diagnostics?.probability?.fitted_at;
    const edgeFingerprint: string | undefined = edgeBayes?.fit_diagnostics?.probability?.fingerprint;
    const fileFingerprint: string | undefined = file?.posterior?.fingerprint;

    const drifted =
      !edgeFitted
      || edgeFitted < fileFitted
      || (fileFingerprint != null && edgeFingerprint !== fileFingerprint);

    if (drifted) {
      out.push({ paramId, edgeId: edge.uuid || edge.id });
    }
  }
  return out;
}

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

  // currentDSL is read once per render so the planner effect's dep array
  // can react to DSL changes. The bayes projection that used to live here
  // (LIVE-EDGE CONTEXTING + POSTERIOR-LANDED listener) has moved into
  // `getParameterFromFile` so every file→graph fetch produces a complete
  // projection — analytic AND bayesian — in one place. DSL change runs
  // the planner-driven fetch below; fresh-fit lands invoke the same fetch
  // via `bayesPatchService.applyPatchAndCascade` Tier 2.
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
  // AUTO-AGGREGATION — runs FE topo on every DSL change, regardless of coverage.
  //
  // Contract:
  //   - DSL change ⇒ run FE topo against currently-cached file data (always).
  //   - Live API retrieval ⇒ user clicks the Fetch button (toast/op-indicator
  //     registered in the planner-result effect above, which calls
  //     executeFetchPlan).
  //
  // "Uncovered" items still flow through from-file aggregation: they get
  // whatever days are cached and surface a "missing data" warning. Empty
  // scoped evidence (n=0 in the DSL window) is a NATURAL DEGENERATE of the
  // FE topo blend formula — it returns forecastMean (the prior) cleanly,
  // since the prior pseudo-count is always present in the conjugate blend.
  // "Absence of evidence is not evidence of absence." See
  // computeBlendedMean / computePerDayBlendedMean in
  // statisticalEnhancementService.ts.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!plannerResult || plannerResult.status !== 'complete') return;
    // On initial load, trust persisted graph state
    if (plannerResult.analysisContext?.trigger === 'initial_load') return;
    const aggregationCandidates = [
      ...plannerResult.autoAggregationItems,
      ...plannerResult.fetchPlanItems,
    ];
    if (aggregationCandidates.length === 0) return;
    if (isAggregatingRef.current) return;

    const authoritativeDSL = graphStoreApi.getState().currentDSL || '';
    if (!authoritativeDSL) return;

    // Deduplicate — don't re-aggregate for the same DSL
    if (lastAutoAggregatedDSLRef.current === authoritativeDSL) return;

    isAggregatingRef.current = true;
    setIsAggregating(true);

    const items = aggregationCandidates.map(i =>
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

  // ═══════════════════════════════════════════════════════════════════════════
  // BAYES DRIFT DETECTION (α: graph-load, β: post-merge)
  //
  // Two ways for a graph edge's bayesian projection to fall behind its
  // parameter file's posterior:
  //
  //   α. On graph load, the saved `model_vars[bayesian]` is older than the
  //      file's `posterior.fitted_at` — e.g. a fit ran in a previous session
  //      but the cascade didn't reach this edge for whatever reason (race,
  //      no-tab fit, scope mismatch). Trust-saved-state is otherwise the
  //      design — see auto-aggregation's `initial_load` skip — but bayes
  //      specifically can be detected as stale by fingerprint comparison.
  //
  //   β. After a clean pull (3-way merge succeeds without conflicts), the
  //      parameter file's data is updated in FileRegistry but the graph
  //      edge isn't automatically refreshed (workspaceService.pullLatest
  //      returns without a cascade by design; only usePullAll triggers one,
  //      and only post-conflict-resolution). Subscribing to per-file
  //      notifications closes that gap — conflicted pulls don't fire
  //      because they don't modify file data (pull semantics).
  //
  // Both reuse the established fetchItems → getParameterFromFile path,
  // which now projects bayes correctly. No new UI machinery; toast feedback
  // is the standard "✓ Updated from {paramId}.yaml".
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!graph || isTemporaryFile) return;

    const resolveParameterFile = (paramId: string) =>
      fileRegistry.getFile(`parameter-${paramId}`)?.data;

    const runDriftCheck = (filterParamId?: string) => {
      if (isAggregatingRef.current) return;
      const liveGraph = graphRef.current;
      if (!liveGraph) return;

      const drifted = collectDriftedBayesEdges(liveGraph, resolveParameterFile, filterParamId);
      if (drifted.length === 0) return;

      const items = drifted.map(d =>
        createFetchItem('parameter', d.paramId, d.edgeId, { paramSlot: 'p' })
      );

      isAggregatingRef.current = true;
      setIsAggregating(true);
      fetchItems(items, { mode: 'from-file' })
        .then(() => {
          const updated = graphRef.current;
          if (updated) setGraph(updated);
        })
        .finally(() => {
          isAggregatingRef.current = false;
          setIsAggregating(false);
        });
    };

    // β: subscribe to each unique paramId so a successful merge (which
    // updates the file's data via fileRegistry.updateFile → notifyListeners)
    // triggers a per-edge drift check. Conflicted pulls don't modify file
    // data and therefore don't fire this path.
    const paramIds = new Set<string>();
    for (const edge of graph.edges || []) {
      const pid = (edge as any)?.p?.id;
      if (pid) paramIds.add(pid);
    }
    const unsubs: Array<() => void> = [];
    for (const paramId of paramIds) {
      unsubs.push(
        fileRegistry.subscribe(`parameter-${paramId}`, () => runDriftCheck(paramId))
      );
    }

    // α: initial check at mount. Files already in FileRegistry are
    // inspected synchronously; files that hydrate after the subscriptions
    // are set up will trigger the β path on arrival.
    runDriftCheck();

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [graph, isTemporaryFile, fetchItems, setGraph]);

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
