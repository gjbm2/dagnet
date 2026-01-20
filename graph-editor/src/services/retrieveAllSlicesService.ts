import { explodeDSL } from '../lib/dslExplosion';
import type { GraphData } from '../types';
import { completeProgressToast, showProgressToast } from '../components/ProgressToast';
import { dataOperationsService, setBatchMode } from './dataOperationsService';
import { sessionLogService } from './sessionLogService';
import { retrieveAllSlicesPlannerService } from './retrieveAllSlicesPlannerService';

export interface RetrieveAllSlicesProgress {
  currentSlice: number;
  totalSlices: number;
  currentItem: number;
  totalItems: number;
  currentSliceDSL?: string;
}

export interface RetrieveAllSlicesResult {
  totalSlices: number;
  totalItems: number;
  totalSuccess: number;
  totalErrors: number;
  aborted: boolean;
}

export interface RetrieveAllSlicesOptions {
  /**
   * If provided, service will always read the latest graph via this callback at the start
   * of each slice/item. This avoids stale-closure issues during long runs.
   */
  getGraph: () => GraphData | null;
  /** Apply graph updates (service uses the same setGraph signature as other flows). */
  setGraph: (graph: GraphData | null) => void;

  /** If not provided, derived from graph.dataInterestsDSL. */
  slices?: string[];
  bustCache?: boolean;
  /**
   * If true, run the real Retrieve All execution loop but:
   * - do not execute external HTTP (dry-run request construction only)
   * - do not write files
   * - do not mutate the graph
   *
   * The artefact is the session log trace (including DRY_RUN_HTTP entries).
   */
  simulate?: boolean;

  /** Return true to abort ASAP (checked between items and slices). */
  shouldAbort?: () => boolean;

  /** Optional progress callback (UI can wire progress bars / labels). */
  onProgress?: (p: RetrieveAllSlicesProgress) => void;
}

export interface RetrieveAllSlicesWithProgressToastOptions extends RetrieveAllSlicesOptions {
  toastId: string;
  toastLabel?: string;
}

class RetrieveAllSlicesService {
  private static instance: RetrieveAllSlicesService;

  static getInstance(): RetrieveAllSlicesService {
    if (!RetrieveAllSlicesService.instance) {
      RetrieveAllSlicesService.instance = new RetrieveAllSlicesService();
    }
    return RetrieveAllSlicesService.instance;
  }

  /**
   * Headless-capable "Retrieve All Slices".
   * - Performs real fetches via dataOperationsService.getFromSource for each slice across all connected params/cases.
   * - Handles session logging.
   * - Does NOT show toasts or UI (caller can do that via onProgress).
   */
  async execute(options: RetrieveAllSlicesOptions): Promise<RetrieveAllSlicesResult> {
    const {
      getGraph,
      setGraph,
      slices,
      bustCache = false,
      simulate = false,
      shouldAbort,
      onProgress,
    } = options;

    const initialGraph = getGraph();
    if (!initialGraph) {
      return { totalSlices: 0, totalItems: 0, totalSuccess: 0, totalErrors: 0, aborted: false };
    }

    let effectiveSlices: string[] = slices ?? [];
    if (effectiveSlices.length === 0) {
      const dsl = initialGraph.dataInterestsDSL || '';
      if (!dsl) {
        sessionLogService.warning('data-fetch', 'BATCH_ALL_SLICES_SKIPPED', 'Retrieve All Slices skipped: no pinned query');
        return { totalSlices: 0, totalItems: 0, totalSuccess: 0, totalErrors: 0, aborted: false };
      }
      effectiveSlices = await explodeDSL(dsl);
    }

    const totalSlices = effectiveSlices.length;
    if (totalSlices === 0) {
      return { totalSlices: 0, totalItems: 0, totalSuccess: 0, totalErrors: 0, aborted: false };
    }

    // Enable batch mode to suppress individual toasts (service layer should be safe for headless usage).
    setBatchMode(true);

    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'BATCH_ALL_SLICES',
      `Retrieve All Slices: ${totalSlices} slice(s)`,
      { filesAffected: effectiveSlices }
    );

    let totalSuccess = 0;
    let totalErrors = 0;
    let totalItems = 0;
    let aborted = false;

    const reportProgress = (p: RetrieveAllSlicesProgress) => {
      onProgress?.(p);
    };

    try {
      reportProgress({ currentSlice: 0, totalSlices, currentItem: 0, totalItems: 0 });

      for (let sliceIdx = 0; sliceIdx < effectiveSlices.length; sliceIdx++) {
        if (shouldAbort?.()) {
          aborted = true;
          break;
        }

        const sliceDSL = effectiveSlices[sliceIdx];
        const graphForSlice = getGraph();
        if (!graphForSlice) continue;

        const batchItems = retrieveAllSlicesPlannerService.collectTargets(graphForSlice);
        totalItems += batchItems.length;

        reportProgress({
          currentSlice: sliceIdx + 1,
          totalSlices,
          currentItem: 0,
          totalItems: batchItems.length,
          currentSliceDSL: sliceDSL,
        });

        let sliceSuccess = 0;
        let sliceErrors = 0;

        for (let itemIdx = 0; itemIdx < batchItems.length; itemIdx++) {
          if (shouldAbort?.()) {
            aborted = true;
            break;
          }

          const item = batchItems[itemIdx];
          reportProgress({
            currentSlice: sliceIdx + 1,
            totalSlices,
            currentItem: itemIdx + 1,
            totalItems: batchItems.length,
            currentSliceDSL: sliceDSL,
          });

          try {
            const currentGraph = getGraph();
            if (!currentGraph) continue;

            if (item.type === 'parameter') {
              await dataOperationsService.getFromSource({
                objectType: 'parameter',
                objectId: item.objectId,
                targetId: item.targetId,
                graph: currentGraph,
                setGraph: simulate ? (() => {}) : setGraph,
                paramSlot: item.paramSlot,
                conditionalIndex: item.conditionalIndex,
                bustCache,
                currentDSL: sliceDSL,
                targetSlice: sliceDSL,
                dontExecuteHttp: simulate,
              });
              sliceSuccess++;
            } else {
              await dataOperationsService.getFromSource({
                objectType: 'case',
                objectId: item.objectId,
                targetId: item.targetId,
                graph: currentGraph,
                setGraph: simulate ? (() => {}) : setGraph,
                bustCache,
                currentDSL: sliceDSL,
                dontExecuteHttp: simulate,
              });
              sliceSuccess++;
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            sessionLogService.addChild(
              logOpId,
              'error',
              'ITEM_ERROR',
              `[${sliceDSL}] ${item.name} failed`,
              errorMessage
            );
            sliceErrors++;
          }
        }

        totalSuccess += sliceSuccess;
        totalErrors += sliceErrors;

        sessionLogService.addChild(
          logOpId,
          sliceErrors > 0 ? 'warning' : 'success',
          'SLICE_COMPLETE',
          `Slice "${sliceDSL}": ${sliceSuccess} succeeded, ${sliceErrors} failed`,
          undefined,
          { added: sliceSuccess, errors: sliceErrors }
        );

        if (aborted) break;
      }

      // On a fully successful run, stamp a graph-level marker so other devices that pull
      // can suppress retrieve-all nudges (nightly cron is the primary driver).
      if (!simulate && !aborted && totalErrors === 0) {
        try {
          const g = getGraph();
          if (g && typeof g === 'object' && (g as any).metadata) {
            const next: any = { ...(g as any) };
            next.metadata = { ...(next.metadata || {}), last_retrieve_all_slices_success_at_ms: Date.now() };
            setGraph(next);
          }
        } catch {
          // Best-effort only; do not fail the run because a marker could not be written.
        }
      }

      sessionLogService.endOperation(
        logOpId,
        totalErrors > 0 ? 'warning' : 'success',
        aborted
          ? `All Slices aborted: ${totalSuccess} succeeded, ${totalErrors} failed`
          : `All Slices complete: ${totalSuccess} succeeded, ${totalErrors} failed across ${totalSlices} slice(s)`,
        { added: totalSuccess, errors: totalErrors }
      );

      return { totalSlices, totalItems, totalSuccess, totalErrors, aborted };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sessionLogService.endOperation(logOpId, 'error', `All Slices failed: ${errorMessage}`, { errors: totalErrors + 1 });
      throw error;
    } finally {
      setBatchMode(false);
    }
  }
}

export const retrieveAllSlicesService = RetrieveAllSlicesService.getInstance();

export async function executeRetrieveAllSlicesWithProgressToast(
  options: RetrieveAllSlicesWithProgressToastOptions
): Promise<RetrieveAllSlicesResult> {
  const { toastId, toastLabel, onProgress, ...rest } = options;
  let toastShown = false;

  const handleProgress = (p: RetrieveAllSlicesProgress) => {
    if (p.totalSlices > 0) {
      showProgressToast(toastId, p.currentSlice, p.totalSlices, toastLabel);
      toastShown = true;
    }
    onProgress?.(p);
  };

  try {
    const result = await retrieveAllSlicesService.execute({
      ...rest,
      onProgress: handleProgress,
    });

    if (toastShown) {
      const hasIssues = result.aborted || result.totalErrors > 0;
      const message = result.aborted
        ? `Retrieve All aborted (${result.totalSuccess} succeeded, ${result.totalErrors} failed)`
        : result.totalErrors > 0
          ? `Retrieve All complete (${result.totalSuccess} succeeded, ${result.totalErrors} failed)`
          : `Retrieve All complete (${result.totalSuccess} succeeded)`;
      completeProgressToast(toastId, message, hasIssues);
    }

    return result;
  } catch (error) {
    if (toastShown) {
      const message = error instanceof Error ? error.message : String(error);
      completeProgressToast(toastId, `Retrieve All failed: ${message}`, true);
    }
    throw error;
  }
}


