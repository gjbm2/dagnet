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
import { devDiagnosticService } from './devDiagnosticService';
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

    // Expose mark globally for quick action boundaries during repros.
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

    // Auto-enable if user opted in (localStorage) or via URL param (?consolemirror).
    try {
      const lsEnabled = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
      let urlEnabled = false;
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        urlEnabled = params.has('consolemirror');
      }
      this.enabled = lsEnabled || urlEnabled;
    } catch {
      this.enabled = false;
    }

    if (this.enabled) {
      this.hookConsole();
      // If enabled via URL param, auto-fire a boot mark so the entire startup is captured.
      if (typeof window !== 'undefined') {
        try {
          const params = new URLSearchParams(window.location.search);
          if (params.has('consolemirror')) {
            const markLabel = params.get('consolemirror') || 'boot';
            this.markNow(markLabel);
            sessionLogMirrorService.enable();
            sessionLogService.info('session', 'DEV_LOG_SYNC_START', `Auto-started via ?consolemirror=${markLabel}`);
          }
        } catch { /* ignore */ }
      }
    }
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
    // Always dump diagnostic state on mark, even when JSONL mirroring is off
    void devDiagnosticService.dumpOnMark(label);

    if (!this.enabled) {
      // Surface that mirroring is off so user knows to re-enable
      const w = this.originals.warn || console.warn;
      w('[consoleMirror] mark() - JSONL mirroring is off. label:', label,
        '- diagnostic dump still written. Toggle Console checkbox to enable JSONL.');
      return;
    }
    this.enqueue({
      kind: 'mark',
      ts_ms: Date.now(),
      label,
      meta,
      page: typeof window !== 'undefined' ? { href: window.location?.href } : undefined,
    });

    // Also capture the current active graph (if any) into /debug/graph-snapshots/
    void graphSnapshotService.snapshotAtMark(label);
  }

  /**
   * Send a mark immediately (bypasses batching), so stop marks are not lost when disabling.
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
    // SELF-INSTRUMENTATION (TEMP): every enqueue logs to the ORIGINAL
    // console (bypassing the mirror proxy) so we can see in DevTools whether
    // entries from a specific code path are reaching the queue. Tag is the
    // first arg if it's a string starting with '['.
    try {
      const w = this.originals.log;
      if (w && entry.kind === 'log') {
        const firstArg = entry.args[0];
        const tag = typeof firstArg === 'string' ? firstArg.slice(0, 60) : '<non-string>';
        w(`[consoleMirror.enqueue] q=${this.queue.length} tag=${tag}`);
      }
    } catch { /* ignore */ }
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

    // Pack a batch by SERIALISED BODY SIZE, not entry count.
    //
    // Why: the previous version capped at 500 entries with `keepalive: true`.
    // The fetch spec limits keepalive request bodies to 64 KB, so any flooded
    // batch (e.g. 461 SHA warnings ~250 B each) produced a body well over that
    // limit, the POST was rejected, the catch path requeued, and the queue
    // stalled forever.
    //
    // Fix: drop `keepalive: true` on regular flushes (we don't need page-unload
    // survival here), and pack against the server middleware's 2 MB hard cap.
    const BODY_CAP = 1_500_000;
    const w = this.originals.warn || console.warn;
    const lg = this.originals.log;

    const batch: MirrorEntry[] = [];
    const parts: string[] = [];
    let bodyLen = '{"entries":[]}'.length;
    let dropped = 0;
    while (this.queue.length > 0) {
      const e = this.queue[0];
      let s: string;
      try {
        s = JSON.stringify(e);
      } catch {
        // Per-entry stringify guard: drop just this one rather than sinking the batch.
        this.queue.shift();
        dropped++;
        continue;
      }
      // +1 for comma separator (none before first entry).
      const incr = s.length + (batch.length === 0 ? 0 : 1);
      if (batch.length > 0 && bodyLen + incr > BODY_CAP) break;
      // Defensive: a single oversize entry would otherwise loop forever.
      if (batch.length === 0 && bodyLen + incr > BODY_CAP) {
        this.queue.shift();
        dropped++;
        w(`[consoleMirror] dropped oversize entry (${s.length}B)`);
        continue;
      }
      batch.push(e);
      parts.push(s);
      bodyLen += incr;
      this.queue.shift();
    }
    if (batch.length === 0) return;
    if (this.queue.length > 0) this.flushSoon(0);
    if (dropped > 0) lg?.(`[consoleMirror.flush] dropped ${dropped} unserialisable entries`);

    const body = `{"entries":[${parts.join(',')}]}`;
    lg?.(`[consoleMirror.flush] posting ${batch.length} entries (${body.length}B)`);
    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!resp.ok) {
        // Requeue on server failure. Use concat (NOT `unshift(...batch)`) —
        // the spread form throws RangeError "too many arguments" for large
        // batches in some browsers.
        this.queue = batch.concat(this.queue);
        w(`[consoleMirror] flush failed: ${resp.status}; requeued ${batch.length} entries (q=${this.queue.length})`);
        this.flushSoon(1000);
      } else {
        lg?.(`[consoleMirror.flush] ok ${batch.length} entries`);
      }
    } catch (err) {
      this.queue = batch.concat(this.queue);
      w(`[consoleMirror] flush error; requeued ${batch.length} entries (q=${this.queue.length}):`, err);
      this.flushSoon(1000);
    }
  }
}

export const consoleMirrorService = new ConsoleMirrorService();
