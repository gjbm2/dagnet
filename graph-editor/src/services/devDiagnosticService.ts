/**
 * Dev Diagnostic Service
 *
 * Dev-only infrastructure for inspecting browser state without user intervention.
 * Provides:
 *
 * 1. **State dumps on mark** — when console mirroring is enabled and a mark is placed,
 *    comprehensive browser state (FileRegistry, IDB, planner results) is written to
 *    `debug/tmp.diag-state.json` via the Vite dev server.
 *
 * 2. **On-demand inspection** — `window.dagnetDump()` triggers a state dump at any time.
 *    `window.dagnetDiag` exposes the last planner result and diagnostic trace.
 *
 * 3. **Planner capture** — the planner calls `capturePlannerDiagnostics()` after each
 *    analysis run, storing per-item diagnostics (value counts, signatures, coverage).
 *
 * All output goes to `/__dagnet/diag-dump` endpoint → `debug/tmp.diag-state.json`.
 * Errors are logged to the REAL console (pre-hook), never swallowed.
 *
 * This service is installed in main.tsx alongside consoleMirrorService.
 */

import type { FetchPlanDiagnostics } from './fetchPlanBuilderService';

// Use the registry-dump endpoint which is already registered in the running Vite server.
// The vite.config.ts also accepts /__dagnet/diag-dump as an alias (after server restart).
const DIAG_ENDPOINT = '/__dagnet/registry-dump';

interface PlannerCapture {
  ts: number;
  dsl: string;
  trigger: string;
  durationMs: number;
  diagnostics: FetchPlanDiagnostics;
  querySignatures?: Record<string, string>;
  itemSummaries: Array<{
    itemKey: string;
    objectId: string;
    classification: string;
    mode: string;
    missingDates: number;
    notes: string[];
    // Coverage fields
    fileExists?: boolean;
    filePath?: string;
    allValuesCount?: number;
    modeFilteredCount?: number;
    shouldFilterBySignature?: boolean;
    valuesForCoverageCount?: number;
    currentSignature?: string;
    hasFullHeaderCoverage?: boolean;
    cifNeedsFetch?: boolean;
    cifMatchType?: string;
  }>;
}

class DevDiagnosticService {
  private installed = false;
  private lastPlannerCapture: PlannerCapture | null = null;
  private plannerCaptureHistory: PlannerCapture[] = [];
  private maxHistory = 5;

  install(): void {
    if (this.installed) return;
    if (!import.meta.env.DEV) return;
    this.installed = true;

    if (typeof window !== 'undefined') {
      // On-demand state dump — callable from DevTools
      (window as any).dagnetDump = (label?: string) => {
        void this.dumpState(label || 'manual-dump');
        console.log('[dagnetDump] State dump triggered. Check debug/tmp.diag-state.json');
      };

      // Diagnostic object — inspect planner state from DevTools
      (window as any).dagnetDiag = {
        lastPlanner: () => this.lastPlannerCapture,
        plannerHistory: () => this.plannerCaptureHistory,
        dumpState: (label?: string) => void this.dumpState(label || 'manual-dump'),
      };
    }
  }

  /**
   * Called by windowFetchPlannerService after each analysis run.
   */
  capturePlannerDiagnostics(capture: PlannerCapture): void {
    this.lastPlannerCapture = capture;
    this.plannerCaptureHistory.push(capture);
    if (this.plannerCaptureHistory.length > this.maxHistory) {
      this.plannerCaptureHistory.shift();
    }
  }

  /**
   * Called by consoleMirrorService on each mark.
   * Dumps comprehensive browser state to the debug endpoint.
   */
  async dumpOnMark(markLabel: string): Promise<void> {
    await this.dumpState(markLabel);
  }

  /**
   * Core dump: FileRegistry + IDB + last planner result → debug/tmp.diag-state.json
   */
  private async dumpState(label: string): Promise<void> {
    // Phase 1: imports
    let fileRegistry: any;
    let db: any;
    try {
      const tabCtx = await import('../contexts/TabContext');
      fileRegistry = tabCtx.fileRegistry;
    } catch (err) {
      console.warn(`[devDiag] import TabContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const appDb = await import('../db/appDatabase');
      db = appDb.db;
    } catch (err) {
      console.warn(`[devDiag] import appDatabase failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Phase 2: FileRegistry snapshot
    let regFiles: Record<string, any> = {};
    let allFiles: any[] = [];
    try {
      allFiles = typeof fileRegistry.getAllFiles === 'function'
        ? fileRegistry.getAllFiles()
        : [];

      for (const f of allFiles) {
        if (f.type !== 'parameter') continue;
        const vals = f.data?.values;
        regFiles[f.fileId] = {
          type: f.type,
          path: f.source?.path,
          valuesCount: Array.isArray(vals) ? vals.length : (vals === undefined ? 'undefined' : typeof vals),
          cohortCount: Array.isArray(vals)
            ? vals.filter((v: any) => v.cohort_from || v.cohort_to || (v.sliceDSL && v.sliceDSL.includes('cohort('))).length
            : 0,
          signedCount: Array.isArray(vals)
            ? vals.filter((v: any) => !!v.query_signature).length
            : 0,
          valueSummaries: Array.isArray(vals)
            ? vals.slice(0, 50).map((v: any, i: number) => ({
                idx: i,
                sliceDSL: v.sliceDSL ?? '',
                window_from: v.window_from,
                window_to: v.window_to,
                cohort_from: v.cohort_from,
                cohort_to: v.cohort_to,
                hasSig: !!v.query_signature,
                sigPrefix: v.query_signature ? String(v.query_signature).slice(0, 40) + '…' : undefined,
                hasData: !!(v.n_daily || v.k_daily || v.data_source),
              }))
            : [],
        };
      }
    } catch (err) {
      console.warn(`[devDiag] FileRegistry snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      regFiles = { _error: err instanceof Error ? err.message : String(err) };
    }

    // Phase 3: IDB snapshot
    let idbSummary: any[] = [];
    try {
      const idbParamFiles = await db.files
        .filter((f: any) => f.type === 'parameter')
        .toArray();
      idbSummary = idbParamFiles.map((f: any) => ({
        fileId: f.fileId,
        path: f.source?.path,
        valuesCount: Array.isArray(f.data?.values) ? f.data.values.length : 'no-values',
        repo: f.source?.repository,
        branch: f.source?.branch,
      }));
    } catch (idbErr) {
      idbSummary = [{ error: String(idbErr) }];
    }

    // Phase 4: Build + send
    try {
      const dump = {
        label,
        ts: Date.now(),
        tsISO: new Date().toISOString(),
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        fileRegistry: {
          totalFiles: allFiles.length,
          parameterFileCount: Object.keys(regFiles).length,
          parameterFiles: regFiles,
        },
        idb: {
          totalParamFiles: idbSummary.length,
          files: idbSummary,
        },
        planner: this.lastPlannerCapture
          ? {
              ts: this.lastPlannerCapture.ts,
              dsl: this.lastPlannerCapture.dsl,
              trigger: this.lastPlannerCapture.trigger,
              durationMs: this.lastPlannerCapture.durationMs,
              summary: {
                totalItems: this.lastPlannerCapture.diagnostics.totalItems,
                needsFetch: this.lastPlannerCapture.diagnostics.itemsNeedingFetch,
                covered: this.lastPlannerCapture.diagnostics.itemsCovered,
                unfetchable: this.lastPlannerCapture.diagnostics.itemsUnfetchable,
              },
              items: this.lastPlannerCapture.itemSummaries,
              querySignatures: this.lastPlannerCapture.querySignatures,
            }
          : null,
      };

      // No keepalive — dump payload can exceed the 64KB keepalive limit.
      const resp = await fetch(DIAG_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dump, null, 2),
      });

      if (!resp.ok) {
        console.warn(`[devDiag] Dump endpoint returned ${resp.status}: ${await resp.text()}`);
      }
    } catch (err) {
      console.warn(`[devDiag] Build/send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const devDiagnosticService = new DevDiagnosticService();
