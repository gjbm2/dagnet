/**
 * Dev-only E2E hooks for Playwright.
 *
 * Rationale:
 * - Real browser E2E must be deterministic and must not rely on long timeouts
 *   or focus/visibility heuristics.
 * - These hooks are opt-in (query param) and do not run in production.
 *
 * IMPORTANT:
 * - This is not a public API. It is only for local/CI E2E automation.
 * - Keep surface area minimal.
 */

import { liveShareSyncService } from '../services/liveShareSyncService';

export function installE2eHooks(): void {
  if (!import.meta.env.DEV) return;

  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('e2e')) return;

    (window as any).dagnetE2e = {
      /**
       * Trigger share-live refresh immediately (no countdown / no modal).
       * This exercises the real refresh pipeline:
       * - minimal fetch
       * - overwrite seed
       * - dagnet:liveShareRefreshed dispatch (chart recompute listeners)
       */
      refreshLiveShareToLatest: async () => {
        return await liveShareSyncService.refreshToLatest();
      },
    };
  } catch {
    // Best-effort only.
  }
}

