import { explodeDSL } from '../lib/dslExplosion';
import type { GraphData } from '../types';
import { completeProgressToast, showProgressToast } from '../components/ProgressToast';
import { dataOperationsService, setBatchMode, type CacheAnalysisResult } from './dataOperationsService';
import { sessionLogService } from './sessionLogService';
import { retrieveAllSlicesPlannerService } from './retrieveAllSlicesPlannerService';

/**
 * Current item cache status - reported immediately after cache analysis, before API fetch.
 */
export interface CurrentItemCacheStatus {
  /** True if fully cached (no API call needed) */
  cacheHit: boolean;
  /** Days to fetch from API (0 if cache hit) */
  daysToFetch: number;
  /** Number of gaps to fill */
  gapCount: number;
}

export interface RetrieveAllSlicesProgress {
  currentSlice: number;
  totalSlices: number;
  currentItem: number;
  totalItems: number;
  currentSliceDSL?: string;
  
  /** Current item's cache status (set when cache analysis completes) */
  currentItemStatus?: CurrentItemCacheStatus;
  
  /** Running totals across all processed items */
  runningCacheHits: number;
  runningApiFetches: number;
  runningDaysFetched: number;
  runningTotalProcessed: number;
}

/** Per-slice statistics */
export interface SliceStat {
  slice: string;
  items: number;
  cached: number;
  fetched: number;
  daysFetched: number;
  errors: number;
}

export interface RetrieveAllSlicesResult {
  totalSlices: number;
  totalItems: number;
  totalSuccess: number;
  totalErrors: number;
  aborted: boolean;
  
  /** Items fully served from cache (no API call) */
  totalCacheHits: number;
  /** Items requiring API calls */
  totalApiFetches: number;
  /** Total days fetched from API */
  totalDaysFetched: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Per-slice breakdown */
  sliceStats: SliceStat[];
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

    const startTime = performance.now();
    
    const emptyResult: RetrieveAllSlicesResult = {
      totalSlices: 0,
      totalItems: 0,
      totalSuccess: 0,
      totalErrors: 0,
      aborted: false,
      totalCacheHits: 0,
      totalApiFetches: 0,
      totalDaysFetched: 0,
      durationMs: 0,
      sliceStats: [],
    };

    const initialGraph = getGraph();
    if (!initialGraph) {
      return { ...emptyResult, durationMs: performance.now() - startTime };
    }

    let effectiveSlices: string[] = slices ?? [];
    if (effectiveSlices.length === 0) {
      const dsl = initialGraph.dataInterestsDSL || '';
      if (!dsl) {
        sessionLogService.warning('data-fetch', 'BATCH_ALL_SLICES_SKIPPED', 'Retrieve All Slices skipped: no pinned query');
        return { ...emptyResult, durationMs: performance.now() - startTime };
      }
      effectiveSlices = await explodeDSL(dsl);
    }

    const totalSlices = effectiveSlices.length;
    if (totalSlices === 0) {
      return { ...emptyResult, durationMs: performance.now() - startTime };
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
    let totalCacheHits = 0;
    let totalApiFetches = 0;
    let totalDaysFetched = 0;
    let aborted = false;
    const sliceStats: SliceStat[] = [];

    // For progress reporting
    let runningTotalProcessed = 0;

    const reportProgress = (p: RetrieveAllSlicesProgress) => {
      onProgress?.(p);
    };

    try {
      reportProgress({
        currentSlice: 0,
        totalSlices,
        currentItem: 0,
        totalItems: 0,
        runningCacheHits: 0,
        runningApiFetches: 0,
        runningDaysFetched: 0,
        runningTotalProcessed: 0,
      });

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

        // Track per-slice stats
        let sliceCached = 0;
        let sliceFetched = 0;
        let sliceDaysFetched = 0;
        let sliceSuccess = 0;
        let sliceErrors = 0;

        reportProgress({
          currentSlice: sliceIdx + 1,
          totalSlices,
          currentItem: 0,
          totalItems: batchItems.length,
          currentSliceDSL: sliceDSL,
          runningCacheHits: totalCacheHits,
          runningApiFetches: totalApiFetches,
          runningDaysFetched: totalDaysFetched,
          runningTotalProcessed,
        });

        for (let itemIdx = 0; itemIdx < batchItems.length; itemIdx++) {
          if (shouldAbort?.()) {
            aborted = true;
            break;
          }

          const item = batchItems[itemIdx];
          
          // Track current item's cache status (will be set by onCacheAnalysis callback)
          let currentItemStatus: CurrentItemCacheStatus | undefined;
          
          const onCacheAnalysis = (analysis: CacheAnalysisResult) => {
            currentItemStatus = {
              cacheHit: analysis.cacheHit,
              daysToFetch: analysis.daysToFetch,
              gapCount: analysis.gapCount,
            };
            
            // Report progress with current item status (before fetch starts)
            reportProgress({
              currentSlice: sliceIdx + 1,
              totalSlices,
              currentItem: itemIdx + 1,
              totalItems: batchItems.length,
              currentSliceDSL: sliceDSL,
              currentItemStatus,
              runningCacheHits: totalCacheHits,
              runningApiFetches: totalApiFetches,
              runningDaysFetched: totalDaysFetched,
              runningTotalProcessed,
            });
          };

          try {
            const currentGraph = getGraph();
            if (!currentGraph) continue;

            let result;
            if (item.type === 'parameter') {
              result = await dataOperationsService.getFromSource({
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
                onCacheAnalysis,
              });
            } else {
              result = await dataOperationsService.getFromSource({
                objectType: 'case',
                objectId: item.objectId,
                targetId: item.targetId,
                graph: currentGraph,
                setGraph: simulate ? (() => {}) : setGraph,
                bustCache,
                currentDSL: sliceDSL,
                dontExecuteHttp: simulate,
                onCacheAnalysis,
              });
            }
            
            sliceSuccess++;
            runningTotalProcessed++;
            
            // Aggregate stats from result
            if (result.cacheHit) {
              sliceCached++;
              totalCacheHits++;
            } else {
              sliceFetched++;
              totalApiFetches++;
              sliceDaysFetched += result.daysFetched;
              totalDaysFetched += result.daysFetched;
            }
            
            // Report progress after item completes
            reportProgress({
              currentSlice: sliceIdx + 1,
              totalSlices,
              currentItem: itemIdx + 1,
              totalItems: batchItems.length,
              currentSliceDSL: sliceDSL,
              runningCacheHits: totalCacheHits,
              runningApiFetches: totalApiFetches,
              runningDaysFetched: totalDaysFetched,
              runningTotalProcessed,
            });
            
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
            runningTotalProcessed++;
          }
        }

        totalSuccess += sliceSuccess;
        totalErrors += sliceErrors;
        
        // Record slice stats
        sliceStats.push({
          slice: sliceDSL,
          items: batchItems.length,
          cached: sliceCached,
          fetched: sliceFetched,
          daysFetched: sliceDaysFetched,
          errors: sliceErrors,
        });

        sessionLogService.addChild(
          logOpId,
          sliceErrors > 0 ? 'warning' : 'success',
          'SLICE_COMPLETE',
          `Slice "${sliceDSL}": ${sliceCached} cached, ${sliceFetched} fetched (${sliceDaysFetched}d), ${sliceErrors} errors`,
          undefined,
          { cached: sliceCached, fetched: sliceFetched, daysFetched: sliceDaysFetched, errors: sliceErrors }
        );

        if (aborted) break;
      }

      // On a fully successful run, stamp a graph-level marker so other devices that pull
      // can suppress retrieve-all nudges (nightly cron is the primary driver).
      if (!simulate && !aborted && totalErrors === 0) {
        try {
          const g = getGraph();
          if (g && typeof g === 'object') {
            const next: any = { ...(g as any) };
            next.metadata = { ...(next.metadata || {}), last_retrieve_all_slices_success_at_ms: Date.now() };
            setGraph(next);
          }
        } catch {
          // Best-effort only; do not fail the run because a marker could not be written.
        }
      }

      const durationMs = performance.now() - startTime;
      
      // Add summary table to session log
      this.addSummaryToSessionLog(logOpId, sliceStats, {
        totalCacheHits,
        totalApiFetches,
        totalDaysFetched,
        totalErrors,
        durationMs,
        aborted,
      });

      sessionLogService.endOperation(
        logOpId,
        totalErrors > 0 ? 'warning' : 'success',
        aborted
          ? `Retrieve All aborted: ${totalCacheHits} cached, ${totalApiFetches} fetched (${totalDaysFetched}d), ${totalErrors} errors`
          : `Retrieve All complete: ${totalCacheHits} cached, ${totalApiFetches} fetched (${totalDaysFetched}d)${totalErrors > 0 ? `, ${totalErrors} errors` : ''}`,
        { 
          cached: totalCacheHits, 
          fetched: totalApiFetches, 
          daysFetched: totalDaysFetched, 
          errors: totalErrors,
          duration: Math.round(durationMs),
        }
      );

      return {
        totalSlices,
        totalItems,
        totalSuccess,
        totalErrors,
        aborted,
        totalCacheHits,
        totalApiFetches,
        totalDaysFetched,
        durationMs,
        sliceStats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sessionLogService.endOperation(logOpId, 'error', `All Slices failed: ${errorMessage}`, { errors: totalErrors + 1 });
      throw error;
    } finally {
      setBatchMode(false);
    }
  }
  
  /**
   * Add a summary table to the session log
   */
  private addSummaryToSessionLog(
    logOpId: string,
    sliceStats: SliceStat[],
    totals: {
      totalCacheHits: number;
      totalApiFetches: number;
      totalDaysFetched: number;
      totalErrors: number;
      durationMs: number;
      aborted: boolean;
    }
  ): void {
    const lines: string[] = [];
    lines.push('');
    lines.push('RETRIEVE ALL SUMMARY');
    lines.push('─'.repeat(70));
    lines.push('Slice                                    Items  Cached  Fetched  Days  Errors');
    lines.push('─'.repeat(70));
    
    for (const stat of sliceStats) {
      const sliceName = stat.slice.length > 40 ? stat.slice.slice(0, 37) + '...' : stat.slice.padEnd(40);
      const items = String(stat.items).padStart(5);
      const cached = String(stat.cached).padStart(6);
      const fetched = String(stat.fetched).padStart(7);
      const days = String(stat.daysFetched).padStart(5);
      const errors = String(stat.errors).padStart(6);
      lines.push(`${sliceName} ${items} ${cached} ${fetched} ${days} ${errors}`);
    }
    
    lines.push('─'.repeat(70));
    const totalItems = sliceStats.reduce((sum, s) => sum + s.items, 0);
    lines.push(`${'TOTAL'.padEnd(40)} ${String(totalItems).padStart(5)} ${String(totals.totalCacheHits).padStart(6)} ${String(totals.totalApiFetches).padStart(7)} ${String(totals.totalDaysFetched).padStart(5)} ${String(totals.totalErrors).padStart(6)}`);
    lines.push('─'.repeat(70));
    lines.push(`Duration: ${(totals.durationMs / 1000).toFixed(1)}s`);
    if (totals.aborted) {
      lines.push('⚠️ Operation was aborted');
    }
    
    sessionLogService.addChild(
      logOpId,
      totals.totalErrors > 0 ? 'warning' : 'success',
      'BATCH_SUMMARY',
      'Retrieve All Summary',
      lines.join('\n'),
      {
        totalItems,
        cached: totals.totalCacheHits,
        fetched: totals.totalApiFetches,
        daysFetched: totals.totalDaysFetched,
        errors: totals.totalErrors,
        duration: Math.round(totals.durationMs),
      }
    );
  }
}

export const retrieveAllSlicesService = RetrieveAllSlicesService.getInstance();

export async function executeRetrieveAllSlicesWithProgressToast(
  options: RetrieveAllSlicesWithProgressToastOptions
): Promise<RetrieveAllSlicesResult> {
  const { toastId, toastLabel, onProgress, ...rest } = options;
  let toastShown = false;
  let lastProgress: RetrieveAllSlicesProgress | undefined;

  const handleProgress = (p: RetrieveAllSlicesProgress) => {
    lastProgress = p;
    
    if (p.totalSlices > 0) {
      // Build detailed progress label
      let label = toastLabel || 'Retrieve All';
      
      // Show current slice info
      if (p.currentSliceDSL) {
        // Extract short slice name (e.g., "channel:influencer.window" from full DSL)
        const shortSlice = p.currentSliceDSL.length > 30 
          ? p.currentSliceDSL.slice(0, 27) + '...' 
          : p.currentSliceDSL;
        label = `Slice ${p.currentSlice}/${p.totalSlices}: ${shortSlice}`;
      }
      
      // Show current item status if available
      if (p.currentItemStatus) {
        if (p.currentItemStatus.cacheHit) {
          label += `\nItem ${p.currentItem}/${p.totalItems}: cached ✓`;
        } else if (p.currentItemStatus.gapCount > 1) {
          label += `\nItem ${p.currentItem}/${p.totalItems}: fetching ${p.currentItemStatus.daysToFetch}d across ${p.currentItemStatus.gapCount} gaps`;
        } else {
          label += `\nItem ${p.currentItem}/${p.totalItems}: fetching ${p.currentItemStatus.daysToFetch}d`;
        }
      } else if (p.currentItem > 0) {
        label += `\nItem ${p.currentItem}/${p.totalItems}`;
      }
      
      // Show running totals
      if (p.runningTotalProcessed > 0) {
        label += `\n${p.runningCacheHits} cached, ${p.runningApiFetches} fetched`;
      }
      
      showProgressToast(toastId, p.currentSlice, p.totalSlices, label);
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
      const durationStr = (result.durationMs / 1000).toFixed(1);
      
      let message: string;
      if (result.aborted) {
        message = `Retrieve All aborted (${result.totalCacheHits} cached, ${result.totalApiFetches} fetched, ${result.totalErrors} errors)`;
      } else if (result.totalErrors > 0) {
        message = `Retrieve All: ${result.totalCacheHits} cached, ${result.totalApiFetches} fetched (${result.totalDaysFetched}d), ${result.totalErrors} failed`;
      } else {
        message = `Retrieve All complete (${durationStr}s)\n${result.totalCacheHits} cached, ${result.totalApiFetches} fetched (${result.totalDaysFetched}d new)`;
      }
      
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
