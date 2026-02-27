import { useEffect, useMemo, useRef, useState } from 'react';
import { runHealthCheck, type HealthCheckResult, type HealthMode, getIsOnlineHint } from '../services/healthCheckService';

export interface UseHealthStatusOptions {
  /** Poll interval in ms (default 5 minutes). */
  pollIntervalMs?: number;
}

export interface UseHealthStatusResult {
  mode: HealthMode;
  lastResult: HealthCheckResult | null;
  isChecking: boolean;
  refresh: () => Promise<void>;
  tooltip: string;
}

function buildTooltip(result: HealthCheckResult | null): string {
  if (!result) return 'Health: unknown';

  const header =
    !result.isOnline
      ? 'Health: offline'
      : result.mode === 'ok'
        ? 'Health: OK'
        : 'Health: error';

  const order: Array<keyof HealthCheckResult['checks']> = ['vercel', 'python', 'db', 'git'];
  const lines: string[] = [];
  for (const k of order) {
    const c = result.checks[k];
    const status = c.ok ? 'OK' : 'ERROR';
    const detail = c.ok ? '' : ` — ${c.detail || 'unavailable'}`;
    lines.push(`${k}: ${status}${detail}`);
  }

  return [header, ...lines].join('\n');
}

export function useHealthStatus(options: UseHealthStatusOptions = {}): UseHealthStatusResult {
  const pollIntervalMs = options.pollIntervalMs ?? 5 * 60_000;

  const [lastResult, setLastResult] = useState<HealthCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const inflightRef = useRef<Promise<void> | null>(null);

  const refresh = async () => {
    // Avoid concurrent checks (keeps network calm).
    if (inflightRef.current) return inflightRef.current;

    const p = (async () => {
      setIsChecking(true);
      try {
        const r = await runHealthCheck();
        setLastResult(r);
      } finally {
        setIsChecking(false);
        inflightRef.current = null;
      }
    })();

    inflightRef.current = p;
    return p;
  };

  useEffect(() => {
    // Initial check
    void refresh();

    // Poll
    const id = globalThis.setInterval(() => {
      void refresh();
    }, pollIntervalMs);

    // React promptly when browser online status changes
    const onOnlineChange = () => {
      // If we just came online, refresh quickly; if we went offline, update state fast.
      if (!getIsOnlineHint()) {
        setLastResult({
          mode: 'offline',
          updatedAtMs: Date.now(),
          isOnline: false,
          checks: {
            vercel: { ok: false, detail: 'offline' },
            python: { ok: false, detail: 'offline' },
            db: { ok: false, detail: 'offline' },
            git: { ok: false, detail: 'offline' },
          },
        });
        return;
      }
      void refresh();
    };

    // Re-check after OAuth connect (token changed, git status likely different)
    const onTokenApplied = () => void refresh();

    globalThis.addEventListener?.('online', onOnlineChange);
    globalThis.addEventListener?.('offline', onOnlineChange);
    globalThis.addEventListener?.('dagnet:oauthTokenApplied', onTokenApplied);
    return () => {
      globalThis.clearInterval(id);
      globalThis.removeEventListener?.('online', onOnlineChange);
      globalThis.removeEventListener?.('offline', onOnlineChange);
      globalThis.removeEventListener?.('dagnet:oauthTokenApplied', onTokenApplied);
    };
  }, [pollIntervalMs]);

  const mode: HealthMode = lastResult?.mode ?? 'offline';
  const tooltip = useMemo(() => buildTooltip(lastResult), [lastResult]);

  return { mode, lastResult, isChecking, refresh, tooltip };
}

