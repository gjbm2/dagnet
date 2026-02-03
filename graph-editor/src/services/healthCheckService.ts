/**
 * Health Check Service
 *
 * Provides a lightweight, centralised "is the app healthy?" probe for UI affordances.
 *
 * Policy:
 * - Never throw: return structured status for UI.
 * - Keep checks cheap and bounded (timeouts).
 * - Same-origin in production; uses graphComputeClient base URL in dev.
 */
import { graphComputeClient } from '../lib/graphComputeClient';
import { checkSnapshotHealth } from './snapshotWriteService';
import { gitService } from './gitService';

export type HealthMode = 'offline' | 'ok' | 'error';

export interface HealthCheckResult {
  mode: HealthMode;
  updatedAtMs: number;
  /**
   * True when we believe the user's network is offline (best-effort).
   * If false, we are in "online mode" and expect services to be reachable.
   */
  isOnline: boolean;
  checks: {
    /** Can reach the frontend origin (same-origin fetch). */
    vercel: { ok: boolean; detail?: string };
    /** Can reach Python compute endpoints (parse-query). */
    python: { ok: boolean; detail?: string };
    /** Can reach snapshot DB via python snapshot health endpoint. */
    db: { ok: boolean; detail?: string };
    /** Can reach GitHub API for the configured repo (requires token for private repos). */
    git: { ok: boolean; detail?: string };
  };
}

function boolToMode(isOnline: boolean, allOk: boolean): HealthMode {
  if (!isOnline) return 'offline';
  return allOk ? 'ok' : 'error';
}

async function fetchWithTimeout(url: string, opts: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout =
    controller
      ? setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // ignore
          }
        }, timeoutMs)
      : null;
  try {
    return await fetch(url, { ...opts, signal: controller?.signal });
  } finally {
    if (timeout) clearTimeout(timeout as any);
  }
}

/**
 * Best-effort "online" signal.
 *
 * Use navigator.onLine as a hint only — it can be wrong (esp. captive portals).
 */
export function getIsOnlineHint(): boolean {
  try {
    if (typeof navigator === 'undefined') return true;
    if (typeof navigator.onLine === 'boolean') return navigator.onLine;
    return true;
  } catch {
    return true;
  }
}

/**
 * Run the full health check.
 *
 * Checks:
 * - Vercel/origin: GET /
 * - Python: POST /api/parse-query (empty-ish safe query)
 * - DB: GET /api/snapshots/health (via snapshotWriteService helper)
 * - Git: GET repo info via GitHub API
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const isOnline = getIsOnlineHint();

  const result: HealthCheckResult = {
    mode: 'offline',
    updatedAtMs: Date.now(),
    isOnline,
    checks: {
      vercel: { ok: false },
      python: { ok: false },
      db: { ok: false },
      git: { ok: false },
    },
  };

  // If the browser says we're offline, don't spam network; just return offline.
  if (!isOnline) {
    result.mode = 'offline';
    result.checks.vercel.detail = 'navigator.onLine=false';
    return result;
  }

  // 1) Origin/Vercel: same-origin GET /
  try {
    const resp = await fetchWithTimeout('/', { method: 'GET', timeoutMs: 6000 });
    result.checks.vercel.ok = resp.ok;
    if (!resp.ok) result.checks.vercel.detail = `HTTP ${resp.status}`;
  } catch (e: any) {
    result.checks.vercel.ok = false;
    result.checks.vercel.detail = e?.message ? String(e.message) : 'network error';
  }

  // 2) Python compute: parse-query with a tiny valid query
  try {
    // Use graphComputeClient so dev/prod base URL logic is consistent.
    await graphComputeClient.parseQuery('from(a).to(b)');
    result.checks.python.ok = true;
  } catch (e: any) {
    result.checks.python.ok = false;
    result.checks.python.detail = e?.message ? String(e.message) : 'python unreachable';
  }

  // 3) Snapshot DB
  try {
    const dbResp = await checkSnapshotHealth();
    const ok = dbResp.status === 'ok' || dbResp.db === 'disabled';
    result.checks.db.ok = ok;
    if (!ok) result.checks.db.detail = dbResp.error || dbResp.db;
  } catch (e: any) {
    result.checks.db.ok = false;
    result.checks.db.detail = e?.message ? String(e.message) : 'db check failed';
  }

  // 4) GitHub
  try {
    const gitResp = await gitService.getRepoInfo();
    result.checks.git.ok = !!gitResp.success;
    if (!gitResp.success) result.checks.git.detail = gitResp.error || gitResp.message || 'git unavailable';
  } catch (e: any) {
    result.checks.git.ok = false;
    result.checks.git.detail = e?.message ? String(e.message) : 'git check failed';
  }

  const allOk = Object.values(result.checks).every((c) => c.ok);
  result.mode = boolToMode(isOnline, allOk);
  return result;
}

