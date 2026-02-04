import type { Graph, DateRange } from '../types';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate, formatDateUK } from '../lib/dateFormat';
import { sessionLogService } from './sessionLogService';
import { buildFetchPlanProduction } from './fetchPlanBuilderService';
import type { FetchPlan, FetchPlanItem } from './fetchPlanTypes';
import { summarisePlan } from './fetchPlanTypes';
import { dataOperationsService } from './dataOperationsService';
import { fetchDataService } from './fetchDataService';

export interface FetchOrchestratorBuildPlanResult {
  plan: FetchPlan;
  window: DateRange;
}

export interface FetchOrchestratorExecutionResult {
  plan: FetchPlan;
  executedItemKeys: string[];
  skippedCoveredItemKeys: string[];
  skippedUnfetchableItemKeys: string[];
  errors: Array<{ itemKey: string; message: string }>;
}

/**
 * Canonical orchestration entrypoint for "plan → execute exactly" workflows.
 *
 * This service is intentionally narrow:
 * - It does NOT implement adapter logic or persistence directly.
 * - It composes existing primitives:
 *   - FetchPlan builder (pure)
 *   - DataOperationsService (execution + persistence)
 *   - fetchDataService.from-file refresh (cache read + Stage‑2 when enabled)
 */
class FetchOrchestratorService {
  private static instance: FetchOrchestratorService;
  static getInstance(): FetchOrchestratorService {
    if (!FetchOrchestratorService.instance) {
      FetchOrchestratorService.instance = new FetchOrchestratorService();
    }
    return FetchOrchestratorService.instance;
  }

  extractWindowFromDSL(dsl: string): DateRange | null {
    try {
      const constraints = parseConstraints(dsl);
      if (constraints.cohort?.start) {
        return {
          start: resolveRelativeDate(constraints.cohort.start),
          end: constraints.cohort.end ? resolveRelativeDate(constraints.cohort.end) : formatDateUK(new Date()),
        };
      }
      if (constraints.window?.start) {
        return {
          start: resolveRelativeDate(constraints.window.start),
          end: constraints.window.end ? resolveRelativeDate(constraints.window.end) : formatDateUK(new Date()),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async buildPlan(input: {
    graph: Graph;
    dsl: string;
    bustCache?: boolean;
    referenceNow?: string;
    parentLogId?: string;
    skipSignatureComputation?: boolean;
  }): Promise<FetchOrchestratorBuildPlanResult> {
    const { graph, dsl, bustCache, referenceNow, parentLogId, skipSignatureComputation } = input;
    const window = this.extractWindowFromDSL(dsl);
    if (!window) {
      throw new Error('Cannot build plan: no window/cohort range in DSL');
    }
    const now = referenceNow ?? new Date().toISOString();
    const { plan } = await buildFetchPlanProduction(graph, dsl, window, { bustCache, referenceNow: now, skipSignatureComputation });

    if (parentLogId) {
      const s = summarisePlan(plan);
      sessionLogService.addChild(
        parentLogId,
        'info',
        'FETCH_PLAN_BUILT',
        `Plan built: ${s.fetchItems} fetch, ${s.coveredItems} covered, ${s.unfetchableItems} unfetchable`,
        undefined,
        { summary: s, dsl: plan.dsl, createdAt: plan.createdAt, referenceNow: plan.referenceNow } as any
      );
    }

    return { plan, window };
  }

  /**
   * Execute a plan exactly (plan interpreter mode).
   *
   * - Covered/unfetchable items are not executed.
   * - Parameter items execute with overrideFetchWindows + skipCohortBounding.
   * - Case items execute via the existing versioned snapshot path.
   * - When simulate=true, disables external HTTP and blocks all writes/graph mutation.
   */
  async executePlan(input: {
    plan: FetchPlan;
    graph: Graph;
    setGraph: (g: Graph | null) => void;
    bustCache?: boolean;
    simulate?: boolean;
    parentLogId?: string;
  }): Promise<FetchOrchestratorExecutionResult> {
    const { plan, graph, setGraph, bustCache = false, simulate = false, parentLogId } = input;

    let currentGraph: Graph | null = graph;
    const trackingSetGraph = (g: Graph | null) => {
      currentGraph = g;
      if (!simulate) setGraph(g);
    };

    const executedItemKeys: string[] = [];
    const skippedCoveredItemKeys: string[] = [];
    const skippedUnfetchableItemKeys: string[] = [];
    const errors: Array<{ itemKey: string; message: string }> = [];

    for (const item of plan.items) {
      if (item.classification === 'covered') {
        skippedCoveredItemKeys.push(item.itemKey);
        continue;
      }
      if (item.classification === 'unfetchable') {
        skippedUnfetchableItemKeys.push(item.itemKey);
        continue;
      }

      const g = currentGraph;
      if (!g) break;

      try {
        if (item.type === 'case') {
          await dataOperationsService.getFromSource({
            objectType: 'case',
            objectId: item.objectId,
            targetId: item.targetId,
            graph: g,
            setGraph: simulate ? undefined : trackingSetGraph,
            bustCache,
            currentDSL: plan.dsl,
            dontExecuteHttp: simulate,
          } as any);
        } else {
          await dataOperationsService.getFromSource({
            objectType: 'parameter',
            objectId: item.objectId,
            targetId: item.targetId,
            graph: g,
            setGraph: simulate ? undefined : trackingSetGraph,
            paramSlot: item.slot,
            conditionalIndex: item.conditionalIndex,
            bustCache,
            currentDSL: plan.dsl,
            targetSlice: plan.dsl,
            dontExecuteHttp: simulate,
            // Plan interpreter: execute exactly these windows.
            skipCohortBounding: true,
            overrideFetchWindows: item.windows.map((w) => ({ start: w.start, end: w.end })),
          } as any);
        }
        executedItemKeys.push(item.itemKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ itemKey: item.itemKey, message: msg });
        if (parentLogId) {
          sessionLogService.addChild(parentLogId, 'error', 'PLAN_ITEM_FAILED', `Plan item failed: ${item.itemKey}`, msg);
        }
      }
    }

    if (parentLogId) {
      sessionLogService.addChild(
        parentLogId,
        errors.length > 0 ? 'warning' : 'success',
        'PLAN_EXECUTION_COMPLETE',
        `Plan execution complete (executed=${executedItemKeys.length}, covered=${skippedCoveredItemKeys.length}, unfetchable=${skippedUnfetchableItemKeys.length}, errors=${errors.length})`,
        undefined,
        { executedItemKeys, skippedCoveredItemKeys, skippedUnfetchableItemKeys, errors } as any
      );
    }

    return {
      plan,
      executedItemKeys,
      skippedCoveredItemKeys,
      skippedUnfetchableItemKeys,
      errors,
    };
  }

  /**
   * From-file refresh for a given DSL. Intended for share/live boot and other cache-only flows.
   * When skipStage2=false this will run Stage‑2 once (graph-level) inside fetchDataService.
   */
  async refreshFromFiles(input: {
    graph: Graph;
    setGraph: (g: Graph | null) => void;
    dsl: string;
    skipStage2?: boolean;
    parentLogId?: string;
  }): Promise<void> {
    const { graph, setGraph, dsl, skipStage2 = false, parentLogId } = input;
    const items = fetchDataService.getItemsForFromFileLoad(graph);
    if (items.length === 0) return;

    await fetchDataService.fetchItems(
      items,
      { mode: 'from-file', skipStage2, parentLogId, suppressBatchToast: true } as any,
      graph,
      setGraph,
      dsl,
      () => graph
    );
  }

  /**
   * From-file refresh with small bounded retries.
   * Intended for share/live boot and scenario regeneration, where file hydration can race.
   */
  async refreshFromFilesWithRetries(input: {
    graphGetter: () => Graph | null;
    setGraph: (g: Graph | null) => void;
    dsl: string;
    skipStage2?: boolean;
    parentLogId?: string;
    attempts?: number;
    delayMs?: number;
  }): Promise<{ attempts: number; failures: number }> {
    const {
      graphGetter,
      setGraph,
      dsl,
      skipStage2 = false,
      parentLogId,
      attempts = 6,
      delayMs = 75,
    } = input;

    let lastFailures = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const g = graphGetter();
      if (!g) return { attempts: attempt, failures: 0 };
      const items = fetchDataService.getItemsForFromFileLoad(g);
      if (items.length === 0) return { attempts: attempt, failures: 0 };

      const results = await fetchDataService.fetchItems(
        items,
        { mode: 'from-file', skipStage2, parentLogId, suppressBatchToast: true } as any,
        g,
        setGraph,
        dsl,
        () => graphGetter() as any
      );
      const failures = results.filter((r: any) => !r?.success);
      lastFailures = failures.length;
      if (failures.length === 0) return { attempts: attempt, failures: 0 };
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return { attempts, failures: lastFailures };
  }
}

export const fetchOrchestratorService = FetchOrchestratorService.getInstance();


