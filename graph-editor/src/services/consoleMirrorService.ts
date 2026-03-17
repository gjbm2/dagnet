/**
 * consoleMirrorService
 *
 * Dev-only utility: mirrors browser console logs into a local file via the Vite dev server
 * so Cursor can read them without copy/paste.
 *
 * - Opt-in (default off): localStorage["dagnet:console-mirror"] = "1"
 * - Marks: window.dagnetMark("action label", { ...meta })
 *
 * Data format (JSONL, written by Vite middleware):
 *   { kind: "log"|"mark", ts_ms: number, level: "...", args: any[], ... }
 */
type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

type MirrorEntry =
  | {
      kind: 'log';
      ts_ms: number;
      level: ConsoleLevel;
      args: unknown[];
      page?: { href?: string };
    }
  | {
      kind: 'mark';
      ts_ms: number;
      label: string;
      meta?: Record<string, unknown>;
      page?: { href?: string };
    };

import { graphSnapshotService } from './graphSnapshotService';
import { sessionLogService } from './sessionLogService';
import { sessionLogMirrorService } from './sessionLogMirrorService';
import { redactDeep } from '../lib/redact';

const STORAGE_KEY = 'dagnet:console-mirror';
const DEFAULT_ENDPOINT = '/__dagnet/console-log';
const DEV_LOG_SYNC_START_LABEL = 'log sync start';
const DEV_LOG_SYNC_STOP_LABEL = 'log sync stop';

function safeSerialiseArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    try {
      if (a === undefined) return { __type: 'undefined' };
      if (typeof a === 'bigint') return { __type: 'bigint', value: a.toString() };
      const redacted = redactDeep(a);
      JSON.stringify(redacted);
      return redacted;
    } catch {
      try {
        return String(a);
      } catch {
        return { __type: 'unserialisable' };
      }
    }
  });
}

class ConsoleMirrorService {
  private installed = false;
  private enabled = false;
  private endpoint = DEFAULT_ENDPOINT;
  private flushTimer: number | null = null;
  private queue: MirrorEntry[] = [];
  private originals: Partial<Record<ConsoleLevel, (...args: any[]) => void>> = {};

  install(): void {
    if (this.installed) return;
    this.installed = true;

    // Expose mark globally for quick “action boundaries” during repros.
    if (typeof window !== 'undefined') {
      (window as any).dagnetMark = (label: string, meta?: Record<string, unknown>) => {
        this.mark(label, meta);
      };
      (window as any).dagnetConsoleMirror = {
        enable: () => {
          this.enable();
          sessionLogMirrorService.enable();
          // Mark start in BOTH streams (console mark + session log entry)
          void this.markNow(DEV_LOG_SYNC_START_LABEL);
          sessionLogService.info('session', 'DEV_LOG_SYNC_START', DEV_LOG_SYNC_START_LABEL);
        },
        disable: () => {
          // Mark stop in BOTH streams while mirroring is still enabled
          void this.markNow(DEV_LOG_SYNC_STOP_LABEL);
          sessionLogService.info('session', 'DEV_LOG_SYNC_STOP', DEV_LOG_SYNC_STOP_LABEL);
          sessionLogMirrorService.disable();
          this.disable();
        },
        isEnabled: () => this.isEnabled(),
      };
    }

    // Auto-enable if user opted in.
    try {
      this.enabled = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      this.enabled = false;
    }

    if (this.enabled) this.hookConsole();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(endpoint?: string): void {
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.enabled = true;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    this.hookConsole();
  }

  disable(): void {
    this.enabled = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    this.unhookConsole();
  }

  mark(label: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.enqueue({
      kind: 'mark',
      ts_ms: Date.now(),
      label,
      meta,
      page: typeof window !== 'undefined' ? { href: window.location?.href } : undefined,
    });

    // Also capture the current active graph (if any) into /debug/graph-snapshots/
    void graphSnapshotService.snapshotAtMark(label);

    // Dump FileRegistry state for parameter files → debug/tmp.registry-dump.json
    void this.dumpFileRegistryOnMark(label);
  }

  /**
   * On mark, snapshot FileRegistry + IDB parameter file state to a debug file.
   * This enables offline investigation of planner coverage bugs without polluting
   * console or session logs.
   */
  private async dumpFileRegistryOnMark(markLabel: string): Promise<void> {
    try {
      // Lazy import to avoid circular deps at module scope
      const { fileRegistry } = await import('../contexts/TabContext');
      const { db } = await import('../db/appDatabase');

      // Collect all parameter files from FileRegistry
      const regFiles: Record<string, any> = {};
      const allFiles = typeof fileRegistry.getAllFiles === 'function'
        ? fileRegistry.getAllFiles()
        : [];
      for (const f of allFiles) {
        if (f.type !== 'parameter') continue;
        const vals = f.data?.values;
        regFiles[f.fileId] = {
          exists: true,
          type: f.type,
          path: f.source?.path,
          valuesCount: Array.isArray(vals) ? vals.length : (vals === undefined ? 'undefined' : typeof vals),
          cohortCount: Array.isArray(vals)
            ? vals.filter((v: any) => v.cohort_from || v.cohort_to || (v.sliceDSL && v.sliceDSL.includes('cohort('))).length
            : 0,
          signedCount: Array.isArray(vals)
            ? vals.filter((v: any) => !!v.query_signature).length
            : 0,
        };
      }

      // Also check IDB for parameter files
      const idbParamFiles = await db.files
        .filter((f: any) => f.type === 'parameter')
        .toArray();
      const idbSummary = idbParamFiles.map((f: any) => ({
        fileId: f.fileId,
        path: f.source?.path,
        valuesCount: Array.isArray(f.data?.values) ? f.data.values.length : 'no-values',
        repo: f.source?.repository,
        branch: f.source?.branch,
      }));

      const dump = {
        mark: markLabel,
        ts: Date.now(),
        fileRegistry: {
          totalFiles: allFiles.length,
          parameterFiles: regFiles,
        },
        idb: {
          totalParamFiles: idbParamFiles.length,
          files: idbSummary,
        },
      };

      await fetch('/__dagnet/registry-dump', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dump, null, 2),
        keepalive: true,
      });
    } catch {
      // best-effort — never break mark functionality
    }
  }

  /**
   * Send a mark immediately (bypasses batching), so "stop" marks aren't lost when disabling.
   */
  async markNow(label: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    const entry: MirrorEntry = {
      kind: 'mark',
      ts_ms: Date.now(),
      label,
      meta,
      page: typeof window !== 'undefined' ? { href: window.location?.href } : undefined,
    };
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: 'console', entries: [entry] }),
        keepalive: true,
      });
    } catch {
      // best-effort
    }
    // Keep snapshots consistent with mark() behaviour.
    void graphSnapshotService.snapshotAtMark(label);
  }

  private hookConsole(): void {
    if (!this.enabled) return;
    const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of levels) {
      if (this.originals[level]) continue;
      this.originals[level] = console[level].bind(console);
      console[level] = (...args: any[]) => {
        // Always call original console immediately
        this.originals[level]?.(...args);
        if (!this.enabled) return;
        this.enqueue({
          kind: 'log',
          ts_ms: Date.now(),
          level,
          args: safeSerialiseArgs(args),
          page: typeof window !== 'undefined' ? { href: window.location?.href } : undefined,
        });
      };
    }
  }

  private unhookConsole(): void {
    const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of levels) {
      if (this.originals[level]) {
        console[level] = this.originals[level] as any;
      }
    }
    this.originals = {};
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
  }

  private enqueue(entry: MirrorEntry): void {
    this.queue.push(entry);
    // Flush quickly but batch to reduce network spam.
    if (this.queue.length >= 50) {
      this.flushSoon(0);
    } else {
      this.flushSoon(250);
    }
  }

  private flushSoon(delayMs: number): void {
    if (this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (!this.enabled) return;
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: batch }),
        keepalive: true,
      });
    } catch {
      // If it fails, drop silently (we don’t want to create feedback loops).
    }
  }
}

export const consoleMirrorService = new ConsoleMirrorService();


