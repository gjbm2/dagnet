import { explodeDSL } from '../lib/dslExplosion';
import type { GraphData } from '../types';
import { completeProgressToast, showProgressToast } from '../components/ProgressToast';
import { dataOperationsService, setBatchMode, type CacheAnalysisResult } from './dataOperationsService';
import { sessionLogService } from './sessionLogService';
import { retrieveAllSlicesPlannerService } from './retrieveAllSlicesPlannerService';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate, formatDateUK, parseUKDate } from '../lib/dateFormat';
import { buildFetchPlanProduction } from './fetchPlanBuilderService';
import { summarisePlan, type FetchPlan, type FetchPlanItem, type FetchWindow } from './fetchPlanTypes';
import { fetchDataService, type FetchItem } from './fetchDataService';
import { lagHorizonsService } from './lagHorizonsService';
import { rateLimiter, getEffectiveRateLimitCooloffMinutes } from './rateLimiter';
import { countdownService } from './countdownService';
import { batchAnchorCoverage, type BatchAnchorCoverageSubject } from './snapshotWriteService';
import { getClosureSet } from './hashMappingsService';
import { computeShortCoreHash } from './coreHashService';

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

  /**
   * If true, this is an automated (cron) run. On rate limit:
   * - Automated: wait 61 minutes and retry
   * - Manual (false/undefined): abort immediately with explanation
   * 
   * Set automatically by executeRetrieveAllSlicesWithProgressToast().
   */
  isAutomated?: boolean;

  /** Return true to abort ASAP (checked between items and slices). */
  shouldAbort?: () => boolean;

  /** Optional progress callback (UI can wire progress bars / labels). */
  onProgress?: (p: RetrieveAllSlicesProgress) => void;

  /**
   * Optional: after a successful (non-simulated) Retrieve All run, perform one
   * final from-file refresh for this DSL (to update graph scalars + Stage‑2/LAG once).
   *
   * IMPORTANT:
   * - This must remain a service-layer post-pass (no bespoke UI orchestration).
   * - This must never run in simulate mode.
   */
  postRunRefreshDsl?: string;

  /**
   * If true, run a DB coverage preflight before each slice to detect historic
   * anchor-day gaps in the snapshot DB (caused by hash drift or late-start
   * snapshotting). Detected gaps are unioned into the plan as `db_missing` windows.
   *
   * Default: false (manual runs). Automated overnight runs set this to true.
   *
   * See docs/current/project-db/bd-pre-fetch-pass.md for design.
   */
  checkDbCoverageFirst?: boolean;

  /**
   * Workspace identity (repository + branch), needed for DB coverage preflight
   * to construct workspace-prefixed param_ids.
   *
   * If `checkDbCoverageFirst` is true but `workspace` is not provided, the
   * preflight is silently skipped with a warning log.
   */
  workspace?: { repository: string; branch: string };
}

export interface RetrieveAllSlicesWithProgressToastOptions extends RetrieveAllSlicesOptions {
  toastId: string;
  toastLabel?: string;
}

/**
 * Run a rate limit cooldown with countdown.
 * Returns 'expired' when the countdown completes, 'aborted' if shouldStop returns true.
 */
async function runRateLimitCooldown(opts: {
  cooldownMinutes: number;
  shouldStop: () => boolean;
  logOpId: string;
}): Promise<'expired' | 'aborted'> {
  const { cooldownMinutes, shouldStop, logOpId } = opts;
  const totalSeconds = cooldownMinutes * 60;
  const key = `automation:ratelimit:cooldown:${Date.now()}`;

  sessionLogService.addChild(
    logOpId,
    'warning',
    'RATE_LIMIT_COOLDOWN_START',
    `Rate limit hit - waiting ${cooldownMinutes} minutes before resuming`,
    undefined,
    { cooldownMinutes, totalSeconds }
  );

  return new Promise((resolve) => {
    let resolved = false;

    const checkAbort = setInterval(() => {
      if (resolved) return;
      if (shouldStop()) {
        resolved = true;
        clearInterval(checkAbort);
        countdownService.cancelCountdown(key);
        resolve('aborted');
      }
    }, 1000);

    countdownService.startCountdown({
      key,
      durationSeconds: totalSeconds,
      onExpire: () => {
        if (resolved) return;
        resolved = true;
        clearInterval(checkAbort);
        sessionLogService.addChild(
          logOpId,
          'info',
          'RATE_LIMIT_COOLDOWN_EXPIRED',
          `Rate limit cooldown complete - resuming retrieval`
        );
        resolve('expired');
      },
      audit: {
        operationType: 'data-fetch',
        startCode: 'RATE_LIMIT_COOLDOWN_START',
        cancelCode: 'RATE_LIMIT_COOLDOWN_CANCEL',
        expireCode: 'RATE_LIMIT_COOLDOWN_EXPIRE',
        message: `Rate limit cooldown (${cooldownMinutes} minutes)`,
        metadata: { cooldownMinutes },
      },
    });
  });
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
      isAutomated = false,
      shouldAbort,
      onProgress,
      postRunRefreshDsl,
      checkDbCoverageFirst = false,
      workspace,
    } = options;

    const startTime = performance.now();
    // Batch bracketing: freeze a reference "now" once for the entire run.
    // This prevents staleness semantics drifting mid-run due to wall-clock movement.
    const batchReferenceNow = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Retrieval batch timestamps at scope S (key-fixes.md §2.1 + cooldown semantics).
    // -------------------------------------------------------------------------
    // Scope S (fetch-time): param × slice × hash
    // - param: planItem.objectId
    // - slice: mode (window|cohort) + context/case dimensions (args discarded)
    // - hash: querySignature (canonical signature string)
    //
    // We memoise one Date per S so all writes for the same (param, slice, hash)
    // within a retrieve-all run share the same retrieved_at.
    //
    // On automated rate-limit cooldown, we MUST restart S with a NEW retrieved_at
    // and (optionally) re-fetch from the start of S to avoid long splits (61+ mins).
    const batchAtByScopeS = new Map<string, Date>();
    const forceBustCacheByScopeS = new Set<string>();

    const getScopeSKey = (planItem: FetchPlanItem): string => {
      // Only parameters participate in snapshot DB writes; cases have no querySignature.
      // If querySignature is missing, fall back to itemKey to avoid accidentally
      // coalescing distinct hashes.
      const sig = (planItem.querySignature && planItem.querySignature.trim().length > 0)
        ? planItem.querySignature.trim()
        : planItem.itemKey;
      const sliceFamily = typeof planItem.sliceFamily === 'string' ? planItem.sliceFamily : '';
      const mode = planItem.mode || 'window';
      return `p:${planItem.objectId}::${mode}::${sliceFamily}::sig:${sig}`;
    };

    const getBatchAtForScopeS = (scopeSKey: string): Date => {
      let ts = batchAtByScopeS.get(scopeSKey);
      if (!ts) {
        ts = new Date();
        batchAtByScopeS.set(scopeSKey, ts);
      }
      return ts;
    };
    
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
      { filesAffected: effectiveSlices, referenceNow: batchReferenceNow }
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

        // -------------------------------------------------------------------
        // PLAN ONCE PER SLICE (single-plan contract)
        // -------------------------------------------------------------------
        const window = this.extractWindowFromDSL(sliceDSL);
        if (!window) {
          sessionLogService.addChild(
            logOpId,
            'warning',
            'SLICE_SKIPPED_NO_WINDOW',
            `Skipping slice "${sliceDSL}" (no window/cohort range)`,
            undefined,
            { sliceDSL }
          );
          continue;
        }

        const { plan: fetchPlan, diagnostics: planDiagnostics } = await buildFetchPlanProduction(
          graphForSlice as any,
          sliceDSL,
          window,
          { bustCache, referenceNow: batchReferenceNow }
        );

        totalItems += fetchPlan.items.length;

        // Track per-slice stats
        let sliceCached = 0;
        let sliceFetched = 0;
        let sliceDaysFetched = 0;
        let sliceSuccess = 0;
        let sliceErrors = 0;
        const sliceUnfetchable = fetchPlan.items.filter(i => i.classification === 'unfetchable').length;

        // Log the plan artefact (deterministic ordering)
        try {
          const summary = summarisePlan(fetchPlan);
          sessionLogService.addChild(
            logOpId,
            'info',
            'FETCH_PLAN_BUILT',
            `Plan built for slice: ${summary.fetchItems} fetch, ${summary.coveredItems} covered, ${summary.unfetchableItems} unfetchable`,
            this.formatFetchPlanTable(fetchPlan),
            {
              sliceDSL,
              referenceNow: batchReferenceNow,
              summary,
              diagnostics: planDiagnostics,
            } as any
          );
        } catch {
          // Best-effort only: do not fail the slice because the table renderer errored.
        }

        // ---------------------------------------------------------------
        // DB COVERAGE PREFLIGHT (bd-pre-fetch-pass.md)
        // ---------------------------------------------------------------
        if (checkDbCoverageFirst && workspace) {
          try {
            sessionLogService.addChild(
              logOpId, 'info', 'DB_COVERAGE_PREFLIGHT_START',
              `DB coverage preflight: ${fetchPlan.items.filter(i => i.type === 'parameter').length} subjects`,
              undefined,
              { sliceDSL, anchor_from: window.start, anchor_to: window.end }
            );

            // Build coverage subjects from parameter plan items
            const coverageSubjects: BatchAnchorCoverageSubject[] = [];
            const subjectIndexToItemIndex: number[] = []; // maps coverage result index → fetchPlan.items index
            const subjectIndexToItemKey: string[] = [];   // maps coverage result index → itemKey (for diagnostics)
            let anchorFromISOForCall: string | null = null;
            let anchorToISOForCall: string | null = null;
            let skippedNonParameter = 0;
            let skippedNoSignature = 0;
            let skippedHashFail = 0;

            for (let ii = 0; ii < fetchPlan.items.length; ii++) {
              const item = fetchPlan.items[ii];
              if (item.type !== 'parameter') { skippedNonParameter++; continue; }
              if (!item.querySignature) { skippedNoSignature++; continue; }

              let coreHash: string;
              try {
                coreHash = await computeShortCoreHash(item.querySignature);
              } catch {
                skippedHashFail++;
                continue; // skip items where hash computation fails
              }

              const paramId = `${workspace.repository}-${workspace.branch}-${item.objectId}`;
              const modeClause = item.mode === 'cohort' ? 'cohort()' : 'window()';
              const sliceKeys = item.sliceFamily
                ? [`${item.sliceFamily}.${modeClause}`]
                : [modeClause];

              // Convert UK dates to ISO for the backend
              const anchorFromISO = (() => { try { return parseUKDate(resolveRelativeDate(window.start)).toISOString().split('T')[0]; } catch { return window.start; } })();
              const anchorToISO = (() => { try { return parseUKDate(resolveRelativeDate(window.end)).toISOString().split('T')[0]; } catch { return window.end; } })();
              if (!anchorFromISOForCall) anchorFromISOForCall = anchorFromISO;
              if (!anchorToISOForCall) anchorToISOForCall = anchorToISO;

              coverageSubjects.push({
                param_id: paramId,
                core_hash: coreHash,
                slice_keys: sliceKeys,
                anchor_from: anchorFromISO,
                anchor_to: anchorToISO,
                equivalent_hashes: getClosureSet(coreHash),
              });
              subjectIndexToItemIndex.push(ii);
              subjectIndexToItemKey.push(item.itemKey);
            }

            if (coverageSubjects.length > 0) {
              const coverageResults = await batchAnchorCoverage(coverageSubjects, {
                diagnostic: sessionLogService.getDiagnosticLoggingEnabled() === true,
              });
              const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled() === true;

              if (diagnosticOn) {
                // Mirror the Amplitude/DAS diagnostic approach: record full request/response shape.
                const maxSubjectsToDump = 200;
                const requestDump = coverageSubjects.length <= maxSubjectsToDump
                  ? coverageSubjects
                  : coverageSubjects.slice(0, maxSubjectsToDump);

                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'DB_COVERAGE_PREFLIGHT_SHAPE',
                  'DB preflight shape (how subjects were built)',
                  [
                    `slice=${sliceDSL}`,
                    `workspace=${workspace.repository}/${workspace.branch}`,
                    `window_uk=${window.start}→${window.end}`,
                    `anchor_from_iso=${anchorFromISOForCall ?? ''}`,
                    `anchor_to_iso=${anchorToISOForCall ?? ''}`,
                    `subjects_sent=${coverageSubjects.length}`,
                    `skipped_non_parameter=${skippedNonParameter}`,
                    `skipped_no_query_signature=${skippedNoSignature}`,
                    `skipped_core_hash_failed=${skippedHashFail}`,
                    '',
                    'subject shape:',
                    '- param_id (workspace-prefixed)',
                    '- core_hash (short)',
                    '- slice_keys (family.mode())',
                    '- anchor_from/to (ISO date)',
                    '- equivalent_hashes (closure set)',
                  ].join('\n'),
                  {
                    sliceDSL,
                    subjects_sent: coverageSubjects.length,
                    skippedNonParameter,
                    skippedNoSignature,
                    skippedHashFail,
                  } as any
                );

                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'DB_COVERAGE_PREFLIGHT_REQUEST',
                  `DB preflight request payload (${Math.min(coverageSubjects.length, maxSubjectsToDump)}/${coverageSubjects.length})`,
                  JSON.stringify(
                    {
                      diagnostic: true,
                      subjects: requestDump,
                      truncated: coverageSubjects.length > maxSubjectsToDump,
                      maxSubjectsToDump,
                    },
                    null,
                    2
                  ),
                  {
                    sliceDSL,
                    subjects: coverageSubjects.length,
                    truncated: coverageSubjects.length > maxSubjectsToDump,
                    maxSubjectsToDump,
                  } as any
                );

                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'DB_COVERAGE_PREFLIGHT_RESPONSE',
                  `DB preflight response payload (${Math.min(coverageResults.length, maxSubjectsToDump)}/${coverageResults.length})`,
                  JSON.stringify(
                    {
                      results: coverageResults.length <= maxSubjectsToDump
                        ? coverageResults
                        : coverageResults.slice(0, maxSubjectsToDump),
                      truncated: coverageResults.length > maxSubjectsToDump,
                      maxSubjectsToDump,
                    },
                    null,
                    2
                  ),
                  {
                    sliceDSL,
                    results: coverageResults.length,
                    truncated: coverageResults.length > maxSubjectsToDump,
                    maxSubjectsToDump,
                  } as any
                );

                const maxRows = 50;
                const rows = coverageResults.slice(0, maxRows).map((cr, i) => {
                  const subj = coverageSubjects[i];
                  const itemKey = subjectIndexToItemKey[i] || '(unknown)';
                  const missCount = Array.isArray(cr?.missing_anchor_ranges) ? cr.missing_anchor_ranges.length : 0;
                  const missPreview =
                    missCount > 0
                      ? ` missing=${missCount} [${cr.missing_anchor_ranges.slice(0, 4).map(r => `${r.start}→${r.end}`).join(', ')}${missCount > 4 ? ', …' : ''}]`
                      : '';
                  const presCount = Array.isArray((cr as any)?.present_anchor_ranges) ? (cr as any).present_anchor_ranges.length : 0;
                  const presPreview =
                    presCount > 0
                      ? ` present_ranges=${presCount} [${(cr as any).present_anchor_ranges.slice(0, 3).map((r: any) => `${r.start}→${r.end}`).join(', ')}${presCount > 3 ? ', …' : ''}]`
                      : '';
                  const eq = (cr as any)?.equivalence_resolution;
                  const eqHashes = Array.isArray(eq?.core_hashes) ? eq.core_hashes : [];
                  const eqPids = Array.isArray(eq?.param_ids) ? eq.param_ids : [];
                  const eqHashN = eqHashes.length;
                  const eqPidN = eqPids.length;
                  const eqHashesPreview = eqHashN > 0 ? ` [${eqHashes.slice(0, 6).join(', ')}${eqHashN > 6 ? ', …' : ''}]` : '';
                  const eqPidsPreview = eqPidN > 0 ? ` [${eqPids.slice(0, 6).join(', ')}${eqPidN > 6 ? ', …' : ''}]` : '';
                  const counts = `present=${(cr as any)?.present_anchor_day_count ?? '?'} expected=${(cr as any)?.expected_anchor_day_count ?? '?'}`;
                  const sel = `slice_keys=[${(subj?.slice_keys || []).join(', ')}]`;
                  const subjId = `param_id=${subj?.param_id ?? ''} core_hash=${subj?.core_hash ?? ''}`;
                  const subjFlags = `has_closure=${(subj?.equivalent_hashes?.length ?? 0) > 0} anchor=${subj?.anchor_from ?? ''}→${subj?.anchor_to ?? ''}`;
                  const normSel = Array.isArray((cr as any)?.slice_keys_normalised)
                    ? ` norm=[${(cr as any).slice_keys_normalised.join(', ')}]`
                    : '';
                  const sfk = (cr as any)?.slice_filter_kind ? ` slice_filter=${(cr as any).slice_filter_kind}` : '';
                  const eqSummary = `eq_hashes=${eqHashN}${eqHashesPreview} eq_params=${eqPidN}${eqPidsPreview}`;
                  const ok = cr?.coverage_ok === true ? 'OK' : 'MISSING';
                  return `${ok} ${itemKey} :: ${counts} :: ${subjId} :: ${subjFlags} :: ${sel}${normSel}${sfk} :: ${eqSummary}${presPreview}${missPreview}`;
                });
                const truncated = coverageResults.length > maxRows ? `\n… truncated: ${coverageResults.length - maxRows} more subject(s)` : '';

                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'DB_COVERAGE_PREFLIGHT_DETAIL',
                  `DB preflight detail (${Math.min(coverageResults.length, maxRows)}/${coverageResults.length})`,
                  [
                    `slice=${sliceDSL}`,
                    `anchor_from_iso=${anchorFromISOForCall ?? ''}`,
                    `anchor_to_iso=${anchorToISOForCall ?? ''}`,
                    `workspace=${workspace.repository}/${workspace.branch}`,
                    '',
                    ...rows,
                    truncated,
                  ].join('\n'),
                  {
                    sliceDSL,
                    subjects: coverageResults.length,
                    truncated: coverageResults.length > maxRows,
                    maxRows,
                  } as any
                );
              }

              let widenedCount = 0;
              let totalDbMissingDays = 0;

              for (let ci = 0; ci < coverageResults.length; ci++) {
                const cr = coverageResults[ci];
                const itemIdx = subjectIndexToItemIndex[ci];
                const planItem = fetchPlan.items[itemIdx];
                const noop = cr.coverage_ok || !cr.missing_anchor_ranges || cr.missing_anchor_ranges.length === 0;

                if (diagnosticOn) {
                  sessionLogService.addChild(
                    logOpId,
                    noop ? 'success' : 'info',
                    noop ? 'DB_COVERAGE_ITEM_NOOP' : 'DB_COVERAGE_ITEM_MISSING',
                    `${planItem.itemKey}: ${noop ? 'coverage ok (no plan change)' : 'missing ranges (will widen plan)'}`,
                    JSON.stringify(
                      {
                        subject: coverageSubjects[ci],
                        result: cr,
                        plan_before: {
                          classification: planItem.classification,
                          windows: planItem.windows,
                        },
                      },
                      null,
                      2
                    )
                  );
                }

                if (noop) continue;

                // Convert ISO missing ranges to FetchWindows with reason 'db_missing'
                const dbWindows: FetchWindow[] = cr.missing_anchor_ranges.map(range => {
                  const startDate = new Date(range.start + 'T00:00:00Z');
                  const endDate = new Date(range.end + 'T00:00:00Z');
                  const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
                  // Convert to UK date format for consistency with existing windows
                  const fmtStart = formatDateUK(startDate);
                  const fmtEnd = formatDateUK(endDate);
                  return { start: fmtStart, end: fmtEnd, reason: 'db_missing' as const, dayCount };
                });

                // Merge DB-missing windows into existing plan item windows
                const existingWindows = planItem.windows;
                const allWindows = [...existingWindows, ...dbWindows].sort((a, b) => a.start.localeCompare(b.start));
                planItem.windows = allWindows;

                // If item was 'covered', upgrade to 'fetch'
                if (planItem.classification === 'covered') {
                  planItem.classification = 'fetch';
                }

                widenedCount++;
                totalDbMissingDays += dbWindows.reduce((sum, w) => sum + w.dayCount, 0);

                sessionLogService.addChild(
                  logOpId, 'info', 'DB_COVERAGE_ITEM_WIDENED',
                  `${planItem.itemKey}: +${dbWindows.length} DB-missing window(s), ${dbWindows.reduce((s, w) => s + w.dayCount, 0)} days`,
                  undefined,
                  {
                    itemKey: planItem.itemKey,
                    param_id: coverageSubjects[ci].param_id,
                    core_hash: coverageSubjects[ci].core_hash,
                    slice_keys: coverageSubjects[ci].slice_keys,
                    missing_ranges: cr.missing_anchor_ranges,
                    equivalence_resolution: cr.equivalence_resolution,
                    original_windows: existingWindows.length,
                    final_windows: allWindows.length,
                  } as any
                );

                if (diagnosticOn) {
                  sessionLogService.addChild(
                    logOpId,
                    'info',
                    'DB_COVERAGE_ITEM_AFTER',
                    `${planItem.itemKey}: plan updated from DB coverage`,
                    JSON.stringify(
                      {
                        db_windows_added: dbWindows,
                        plan_after: {
                          classification: planItem.classification,
                          windows: planItem.windows,
                        },
                      },
                      null,
                      2
                    )
                  );
                }
              }

              sessionLogService.addChild(
                logOpId,
                widenedCount > 0 ? 'info' : 'success',
                'DB_COVERAGE_PREFLIGHT_RESULT',
                widenedCount > 0
                  ? `DB preflight: ${widenedCount} item(s) widened, ${totalDbMissingDays} DB-missing days added`
                  : `DB preflight: all ${coverageSubjects.length} subject(s) fully covered`,
                undefined,
                { subjects: coverageSubjects.length, widenedCount, totalDbMissingDays }
              );
            }
          } catch (preflightErr) {
            // Graceful degradation: proceed with file-only plan
            const errMsg = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
            sessionLogService.addChild(
              logOpId, 'warning', 'DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK',
              `DB coverage preflight failed — proceeding with file-only plan: ${errMsg}`,
              undefined,
              { error: errMsg }
            );
          }
        } else if (checkDbCoverageFirst && !workspace) {
          sessionLogService.addChild(
            logOpId, 'warning', 'DB_COVERAGE_PREFLIGHT_SKIP',
            'DB coverage preflight requested but workspace identity not provided — skipped'
          );
        }

        reportProgress({
          currentSlice: sliceIdx + 1,
          totalSlices,
          currentItem: 0,
          totalItems: fetchPlan.items.length,
          currentSliceDSL: sliceDSL,
          runningCacheHits: totalCacheHits,
          runningApiFetches: totalApiFetches,
          runningDaysFetched: totalDaysFetched,
          runningTotalProcessed,
        });

        // Track graph updates across sequential fetches (avoid stale closure)
        let currentGraph: GraphData | null = graphForSlice;
        const trackingSetGraph = (g: GraphData | null) => {
          currentGraph = g;
          if (!simulate) setGraph(g);
        };

        // Per-item execution accumulator for deterministic "what we did" artefact
        const executionRows: Array<{
          itemKey: string;
          classificationPlanned: FetchPlanItem['classification'];
          classificationExecuted: 'covered' | 'unfetchable' | 'executed' | 'failed';
          plannedWindows: Array<{ start: string; end: string; reason: string; dayCount: number }>;
          errorKind?: string;
          errorMessage?: string;
          cacheHit?: boolean;
          daysFetched?: number;
          dryRun?: boolean;
        }> = [];

        for (let itemIdx = 0; itemIdx < fetchPlan.items.length; itemIdx++) {
          if (shouldAbort?.()) {
            aborted = true;
            break;
          }

          const planItem = fetchPlan.items[itemIdx];

          // Progress status derived from the plan (deterministic; avoids per-item replanning)
          const plannedDaysToFetch = planItem.windows.reduce((sum, w) => sum + (w.dayCount || 0), 0);
          const plannedGapCount = planItem.windows.length;
          const plannedStatus: CurrentItemCacheStatus = {
            cacheHit: planItem.classification === 'covered',
            daysToFetch: planItem.classification === 'fetch' ? plannedDaysToFetch : 0,
            gapCount: planItem.classification === 'fetch' ? plannedGapCount : 0,
          };

          reportProgress({
            currentSlice: sliceIdx + 1,
            totalSlices,
            currentItem: itemIdx + 1,
            totalItems: fetchPlan.items.length,
            currentSliceDSL: sliceDSL,
            currentItemStatus: plannedStatus,
            runningCacheHits: totalCacheHits,
            runningApiFetches: totalApiFetches,
            runningDaysFetched: totalDaysFetched,
            runningTotalProcessed,
          });

          try {
            const g = currentGraph;
            if (!g) continue;

            // Covered / unfetchable: follow the plan (no executor call)
            if (planItem.classification === 'covered') {
              sliceCached++;
              totalCacheHits++;
              sliceSuccess++;
              runningTotalProcessed++;
              executionRows.push({
                itemKey: planItem.itemKey,
                classificationPlanned: planItem.classification,
                classificationExecuted: 'covered',
                plannedWindows: planItem.windows.map(w => ({ ...w })),
                cacheHit: true,
                daysFetched: 0,
              });
            } else if (planItem.classification === 'unfetchable') {
              // Unfetchable is not an execution error; it is a plan classification.
              sliceSuccess++;
              runningTotalProcessed++;
              executionRows.push({
                itemKey: planItem.itemKey,
                classificationPlanned: planItem.classification,
                classificationExecuted: 'unfetchable',
                plannedWindows: planItem.windows.map(w => ({ ...w })),
              });
              // Diagnostic-only info logging for event_id skip reasons
              if (sessionLogService.getDiagnosticLoggingEnabled() && planItem.unfetchableReason) {
                const reason = planItem.unfetchableReason;
                if (reason === 'no_event_ids' || reason === 'partial_event_ids') {
                  sessionLogService.addChild(logOpId, 'info', 'SKIP_NO_EVENT_ID',
                    `Skipped ${planItem.itemKey}: ${reason}`,
                    undefined,
                    { itemKey: planItem.itemKey, reason } as any
                  );
                }
              }
            } else {
              // Fetch: execute the plan.
              // Parameters are executed in plan-interpreter mode (override windows).
              // Cases are executed via the existing "versioned schedule snapshot" behaviour.
              const [type, objectId, targetId, slot, conditionalIndexStr] = planItem.itemKey.split(':');
              const conditionalIndex =
                typeof conditionalIndexStr === 'string' && conditionalIndexStr !== ''
                  ? Number(conditionalIndexStr)
                  : undefined;
              const onCacheAnalysis = (_analysis: CacheAnalysisResult) => {
                // In batch mode we drive progress from the plan. Cache analysis remains useful for logs only.
              };

              const scopeSKey = getScopeSKey(planItem);
              const itemRetrievalBatchAt = getBatchAtForScopeS(scopeSKey);
              const bustCacheForThisCall = bustCache || forceBustCacheByScopeS.has(scopeSKey);

              const result =
                planItem.type === 'case'
                  ? await dataOperationsService.getFromSource({
                      objectType: 'case',
                      objectId,
                      targetId,
                      graph: g,
                      setGraph: simulate ? (() => {}) : trackingSetGraph,
                      bustCache: bustCacheForThisCall,
                      currentDSL: sliceDSL,
                      dontExecuteHttp: simulate,
                      onCacheAnalysis,
                      // For retrieve-all automation: enforce atomicity at scope S and
                      // ensure rate-limit interruptions trigger cooldown + restart.
                      enforceAtomicityScopeS: isAutomated === true,
                      retrievalBatchAt: itemRetrievalBatchAt,
                    } as any)
                  : await dataOperationsService.getFromSource({
                      objectType: 'parameter',
                      objectId,
                      targetId,
                      graph: g,
                      setGraph: simulate ? (() => {}) : trackingSetGraph,
                      paramSlot: slot || undefined,
                      conditionalIndex,
                      bustCache: bustCacheForThisCall,
                      currentDSL: sliceDSL,
                      targetSlice: sliceDSL,
                      dontExecuteHttp: simulate,
                      // First-principles: plan already computed correct windows.
                      skipCohortBounding: true,
                      overrideFetchWindows: planItem.windows.map((w) => ({ start: w.start, end: w.end })),
                      onCacheAnalysis,
                      // For retrieve-all automation: enforce atomicity at scope S and
                      // ensure rate-limit interruptions trigger cooldown + restart.
                      enforceAtomicityScopeS: isAutomated === true,
                      retrievalBatchAt: itemRetrievalBatchAt,
                    } as any);

              // If this scope previously requested a "restart from start" bust, clear it
              // after a successful execution so later duplicate plan items don't refetch.
              forceBustCacheByScopeS.delete(scopeSKey);

              sliceSuccess++;
              runningTotalProcessed++;

              // Stats:
              // - In simulate mode, reflect "would fetch" using the plan (not the post-call result).
              // - In live mode, classify as cached vs fetched based on result.cacheHit.
              if (simulate) {
                sliceFetched++;
                totalApiFetches++;
                sliceDaysFetched += plannedDaysToFetch;
                totalDaysFetched += plannedDaysToFetch;
              } else if (result.cacheHit) {
                sliceCached++;
                totalCacheHits++;
              } else {
                sliceFetched++;
                totalApiFetches++;
                sliceDaysFetched += result.daysFetched;
                totalDaysFetched += result.daysFetched;
              }

              executionRows.push({
                itemKey: planItem.itemKey,
                classificationPlanned: planItem.classification,
                classificationExecuted: 'executed',
                plannedWindows: planItem.windows.map(w => ({ ...w })),
                cacheHit: simulate ? false : result.cacheHit,
                daysFetched: simulate ? plannedDaysToFetch : result.daysFetched,
                dryRun: simulate,
              });
            }

            // Report progress after item completes
            reportProgress({
              currentSlice: sliceIdx + 1,
              totalSlices,
              currentItem: itemIdx + 1,
              totalItems: fetchPlan.items.length,
              currentSliceDSL: sliceDSL,
              runningCacheHits: totalCacheHits,
              runningApiFetches: totalApiFetches,
              runningDaysFetched: totalDaysFetched,
              runningTotalProcessed,
            });
            
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            
            // Check if this is a rate limit error
            if (rateLimiter.isRateLimitError(errorMessage)) {
              if (isAutomated) {
                // Automated (cron) run: wait 61 minutes and retry
                const cooldownMinutes = getEffectiveRateLimitCooloffMinutes();
                sessionLogService.addChild(
                  logOpId,
                  'warning',
                  'RATE_LIMIT_HIT',
                  `[${sliceDSL}] ${planItem.itemKey} hit rate limit - initiating ${cooldownMinutes}min cooldown`,
                  errorMessage,
                  { itemKey: planItem.itemKey, cooldownMinutes }
                );
                
                // Run cooldown with countdown
                const cooldownResult = await runRateLimitCooldown({
                  cooldownMinutes,
                  shouldStop: shouldAbort ?? (() => false),
                  logOpId,
                });
                
                if (cooldownResult === 'aborted') {
                  aborted = true;
                  break;
                }
                
                // After 61+ min cooloff, restart S (param × slice × hash):
                // - mint a NEW retrieved_at (batch timestamp)
                // - re-fetch from the start of S (ignore cache) so S does not
                //   get split across a long pause where real-world conversions
                //   may have occurred.
                const scopeSKey = getScopeSKey(planItem);
                batchAtByScopeS.delete(scopeSKey);
                forceBustCacheByScopeS.add(scopeSKey);

                // Retry the same item by decrementing the index
                // The loop will increment it back, effectively retrying this item
                itemIdx--;
                continue;
              } else {
                // Manual run: abort immediately with clear explanation
                const remainingInSlice = fetchPlan.items.length - itemIdx - 1;
                const remainingSlices = effectiveSlices.length - sliceIdx - 1;
                
                sessionLogService.addChild(
                  logOpId,
                  'error',
                  'RATE_LIMIT_ABORT',
                  `Hit Amplitude rate limit - aborting`,
                  `Amplitude limits API requests per day. ${remainingInSlice} items remaining in this slice, ${remainingSlices} slices not yet started.\n\n` +
                  `All data fetched so far has been saved to files and the snapshot DB. ` +
                  `Run "Retrieve All" again later to continue from where you left off (already-fetched items will be skipped).\n\n` +
                  `Error: ${errorMessage}`,
                  { 
                    itemKey: planItem.itemKey, 
                    remainingInSlice,
                    remainingSlices,
                    completedSlices: sliceIdx,
                  }
                );
                
                sliceErrors++;
                aborted = true;
                break;
              }
            }
            
            // Not a rate limit error - record the failure and continue
            sessionLogService.addChild(
              logOpId,
              'error',
              'ITEM_ERROR',
              `[${sliceDSL}] ${planItem.itemKey} failed`,
              errorMessage
            );
            sliceErrors++;
            runningTotalProcessed++;
            executionRows.push({
              itemKey: planItem.itemKey,
              classificationPlanned: planItem.classification,
              classificationExecuted: 'failed',
              plannedWindows: planItem.windows.map(w => ({ ...w })),
              errorKind: 'EXECUTION_ERROR',
              errorMessage,
            });
          }
        }

        totalSuccess += sliceSuccess;
        totalErrors += sliceErrors;
        
        // Record slice stats
        sliceStats.push({
          slice: sliceDSL,
          items: fetchPlan.items.length,
          cached: sliceCached,
          fetched: sliceFetched,
          daysFetched: sliceDaysFetched,
          errors: sliceErrors,
        });

        // Emit deterministic "what we did" artefact per slice
        try {
          sessionLogService.addChild(
            logOpId,
            sliceErrors > 0 ? 'warning' : 'success',
            'WHAT_WE_DID',
            `Slice "${sliceDSL}": processed=${fetchPlan.items.length}, cached=${sliceCached}, fetched=${sliceFetched}, unfetchable=${sliceUnfetchable}, daysFetched=${sliceDaysFetched}, errors=${sliceErrors}`,
            this.formatExecutionTable({ sliceDSL, plan: fetchPlan, rows: executionRows }),
            {
              sliceDSL,
              processed: fetchPlan.items.length,
              cached: sliceCached,
              fetched: sliceFetched,
              unfetchable: sliceUnfetchable,
              daysFetched: sliceDaysFetched,
              errors: sliceErrors,
              planSummary: summarisePlan(fetchPlan),
              rows: executionRows,
            } as any
          );
        } catch {
          // best-effort
        }

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

      // -------------------------------------------------------------------
      // Batch end post-pass: refresh graph scalars + Stage‑2 once, service-layer only.
      // -------------------------------------------------------------------
      if (!simulate && !aborted && totalSuccess > 0 && postRunRefreshDsl && postRunRefreshDsl.trim()) {
        const topoLogId = sessionLogService.startOperation(
          'info',
          'data-fetch',
          'POST_RETRIEVE_TOPO_PASS',
          'Post-retrieve topo pass (from-file refresh + Stage‑2)',
          { dsl: postRunRefreshDsl }
        );
        try {
          const g = getGraph();
          if (g) {
            const targets = retrieveAllSlicesPlannerService.collectTargets(g);
            const topoItems: FetchItem[] = targets
              .filter((t): t is Extract<typeof t, { type: 'parameter' }> => t.type === 'parameter')
              .map((t) => ({
                id: typeof (t as any).conditionalIndex === 'number'
                  ? `param-${t.objectId}-conditional_p[${(t as any).conditionalIndex}]-${t.targetId}`
                  : `param-${t.objectId}-${t.paramSlot ?? 'p'}-${t.targetId}`,
                type: 'parameter',
                name: t.name,
                objectId: t.objectId,
                targetId: t.targetId,
                paramSlot: t.paramSlot,
                conditionalIndex: (t as any).conditionalIndex,
              }));

            if (topoItems.length > 0) {
              await fetchDataService.fetchItems(
                topoItems,
                { mode: 'from-file', parentLogId: topoLogId, suppressBatchToast: true, skipStage2: false } as any,
                g as any,
                (next: any) => setGraph(next),
                postRunRefreshDsl,
                () => getGraph() as any
              );
            }
          }
          sessionLogService.endOperation(topoLogId, 'success', 'Post-retrieve topo pass complete');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sessionLogService.endOperation(topoLogId, 'error', `Post-retrieve topo pass failed: ${msg}`);
        }
      }

      // -------------------------------------------------------------------
      // Post-retrieve: recompute + persist GLOBAL horizons (uncontexted, recency-weighted).
      //
      // This is the canonical time to "improve the horizon model", because Retrieve All
      // has just populated the widest slice cache coverage we have.
      // -------------------------------------------------------------------
      if (!simulate && !aborted && totalSuccess > 0) {
        try {
          await lagHorizonsService.recomputeHorizons({
            mode: 'global',
            getGraph,
            setGraph,
            reason: 'retrieve-all-slices',
          });
        } catch {
          // Best-effort: do not fail retrieve-all because horizon persistence failed.
        }
      }

      // On a fully successful run, stamp a graph-level marker so other devices that pull
      // can suppress retrieve-all nudges (nightly cron is the primary driver).
      let stampedMarkerAtMs: number | undefined;
      if (!simulate && !aborted && totalErrors === 0) {
        try {
          const g = getGraph();
          if (g && typeof g === 'object') {
            const next: any = { ...(g as any) };
            stampedMarkerAtMs = Date.now();
            next.metadata = { ...(next.metadata || {}), last_retrieve_all_slices_success_at_ms: stampedMarkerAtMs };
            setGraph(next);
            sessionLogService.addChild(
              logOpId,
              'success',
              'RETRIEVE_MARKER_STAMPED',
              'Stamped graph retrieve marker (last successful Retrieve All)',
              undefined,
              { markerMs: stampedMarkerAtMs }
            );
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

      // Run-level structured artefact (machine-readable metadata + compact string).
      sessionLogService.addChild(
        logOpId,
        totalErrors > 0 ? 'warning' : 'success',
        'BATCH_WHAT_WE_DID',
        'Retrieve All: run artefact',
        [
          '',
          'BATCH WHAT WE DID',
          '─'.repeat(70),
          `slices=${totalSlices} items=${totalItems} cached=${totalCacheHits} fetched=${totalApiFetches} daysFetched=${totalDaysFetched} errors=${totalErrors} aborted=${aborted}`,
          `referenceNow=${batchReferenceNow}`,
          '─'.repeat(70),
        ].join('\n'),
        {
          referenceNow: batchReferenceNow,
          totalSlices,
          totalItems,
          totalCacheHits,
          totalApiFetches,
          totalDaysFetched,
          totalErrors,
          aborted,
          sliceStats,
        } as any
      );

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
          markerMs: stampedMarkerAtMs,
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

  private extractWindowFromDSL(dsl: string): { start: string; end: string } | null {
    try {
      const constraints = parseConstraints(dsl);
      if (constraints.cohort?.start) {
        const start = resolveRelativeDate(constraints.cohort.start);
        const end = constraints.cohort.end ? resolveRelativeDate(constraints.cohort.end) : formatDateUK(new Date());
        return { start, end };
      }
      if (constraints.window?.start) {
        const start = resolveRelativeDate(constraints.window.start);
        const end = constraints.window.end ? resolveRelativeDate(constraints.window.end) : formatDateUK(new Date());
        return { start, end };
      }
      return null;
    } catch {
      return null;
    }
  }

  private formatFetchPlanTable(plan: FetchPlan): string {
    const lines: string[] = [];
    const summary = summarisePlan(plan);
    lines.push('');
    lines.push('FETCH PLAN');
    lines.push('─'.repeat(90));
    lines.push(`DSL: ${plan.dsl}`);
    lines.push(`createdAt: ${plan.createdAt}`);
    lines.push(`referenceNow: ${plan.referenceNow}`);
    lines.push(`items: ${summary.totalItems} (fetch=${summary.fetchItems}, covered=${summary.coveredItems}, unfetchable=${summary.unfetchableItems})`);
    lines.push(`windows: ${summary.totalWindows} (days=${summary.totalDaysToFetch}, missingDays=${summary.missingDays}, staleDays=${summary.staleDays})`);
    lines.push('─'.repeat(90));
    lines.push('ItemKey                                                     Class        Windows');
    lines.push('─'.repeat(90));
    for (const item of plan.items) {
      const key = (item.itemKey || '').padEnd(60);
      const cls = item.classification.padEnd(12);
      const win =
        item.windows.length === 0
          ? '-'
          : item.windows.map(w => `${w.start}→${w.end}(${w.reason},${w.dayCount}d)`).join(' | ');
      lines.push(`${key} ${cls} ${win}`);
    }
    lines.push('─'.repeat(90));
    return lines.join('\n');
  }

  private formatExecutionTable(input: {
    sliceDSL: string;
    plan: FetchPlan;
    rows: Array<{
      itemKey: string;
      classificationPlanned: FetchPlanItem['classification'];
      classificationExecuted: 'covered' | 'unfetchable' | 'executed' | 'failed';
      plannedWindows: Array<{ start: string; end: string; reason: string; dayCount: number }>;
      errorKind?: string;
      errorMessage?: string;
      cacheHit?: boolean;
      daysFetched?: number;
      dryRun?: boolean;
    }>;
  }): string {
    const { sliceDSL, plan, rows } = input;
    const lines: string[] = [];
    lines.push('');
    lines.push('WHAT WE DID (per slice)');
    lines.push('─'.repeat(110));
    lines.push(`Slice: ${sliceDSL}`);
    lines.push('─'.repeat(110));
    lines.push('ItemKey                                                     Planned       Executed      Days  Notes');
    lines.push('─'.repeat(110));
    for (const r of rows) {
      const key = (r.itemKey || '').padEnd(60);
      const planned = (r.classificationPlanned || '').padEnd(12);
      const executed = (r.classificationExecuted || '').padEnd(12);
      const days = String(r.daysFetched ?? 0).padStart(4);
      const notes =
        r.classificationExecuted === 'failed'
          ? `${r.errorKind || 'ERROR'}: ${r.errorMessage || ''}`
          : (r.classificationExecuted === 'unfetchable'
              ? 'unfetchable'
              : (r.dryRun
                  ? 'dry-run'
                  : (r.cacheHit
                      ? 'cacheHit'
                      : ((r.classificationExecuted === 'executed' &&
                          (r.daysFetched ?? 0) === 0 &&
                          (r.plannedWindows?.length ?? 0) > 0)
                          ? 'no-data'
                          : ''))));
      lines.push(`${key} ${planned} ${executed} ${days}  ${notes}`);
    }
    lines.push('─'.repeat(110));
    // Plan table is emitted separately via FETCH_PLAN_BUILT; don't duplicate it here.
    return lines.join('\n');
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
      isAutomated: true,  // Toast wrapper is used by automated runs - use 61-min cooldown on rate limit
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
