/**
 * sessionLogMirrorService
 *
 * Dev-only utility: streams sessionLogService entries into a repo file (JSONL) via Vite dev server.
 * This avoids copy/paste of the in-app Session Log when debugging with Cursor.
 */
import { sessionLogService, type LogEntry } from './sessionLogService';

type MirrorEntry = {
  kind: 'session';
  ts_ms: number;
  entryId: string;
  parentId?: string;
  level: string;
  category: string;
  operation: string;
  message: string;
  details?: string;
  context?: Record<string, unknown>;
};

const DEFAULT_ENDPOINT = '/__dagnet/console-log';

function toTsMs(entry: LogEntry): number {
  try {
    const t = entry.timestamp instanceof Date ? entry.timestamp.getTime() : Date.now();
    return Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

function flatten(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  const walk = (e: LogEntry) => {
    out.push(e);
    if (Array.isArray(e.children)) {
      for (const c of e.children) walk(c);
    }
  };
  for (const e of entries) walk(e);
  return out;
}

class SessionLogMirrorService {
  private installed = false;
  private enabled = false;
  private endpoint = DEFAULT_ENDPOINT;
  private seenIds = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  install(): void {
    if (this.installed) return;
    this.installed = true;

    // Subscribe immediately, but only send when enabled.
    this.unsubscribe = sessionLogService.subscribe((entries) => {
      if (!this.enabled) return;
      const flat = flatten(entries);
      const newOnes = flat.filter((e) => !this.seenIds.has(e.id));
      if (newOnes.length === 0) return;

      for (const e of newOnes) this.seenIds.add(e.id);
      void this.flush(newOnes);
    });
  }

  enable(endpoint?: string): void {
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async flush(entries: LogEntry[]): Promise<void> {
    try {
      const payload: MirrorEntry[] = entries.map((e) => ({
        kind: 'session',
        ts_ms: toTsMs(e),
        entryId: e.id,
        parentId: e.parentId,
        level: e.level,
        category: e.category,
        operation: e.operation,
        message: e.message,
        details: e.details,
        context: e.context as any,
      }));

      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: 'session', entries: payload }),
        keepalive: true,
      });
    } catch {
      // Silent in dev; never interfere with app behaviour
    }
  }
}

export const sessionLogMirrorService = new SessionLogMirrorService();


