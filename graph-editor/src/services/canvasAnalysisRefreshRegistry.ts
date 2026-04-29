import { graphComputeClient } from '../lib/graphComputeClient';

const refreshFns = new Map<string, () => void>();

export function registerCanvasAnalysisRefresh(analysisId: string, fn: () => void): void {
  refreshFns.set(analysisId, fn);
}

export function unregisterCanvasAnalysisRefresh(analysisId: string, fn: () => void): void {
  if (refreshFns.get(analysisId) === fn) refreshFns.delete(analysisId);
}

// User-initiated full refresh: purge every cache and trigger recompute.
// Why: the previous wiring dispatched a window event that only the canvas
// node component listened for; when the listener wasn't where the
// dispatcher expected (mount race, alternate surface, stale closure) the
// click silently no-op'd. A direct function call surfaces failure: if no
// hook is registered we log a warning instead of swallowing the request.
export function refreshCanvasAnalysis(analysisId: string): void {
  graphComputeClient.clearCache();
  try { (window as any).__dagnetComputeNoCacheOnce = true; } catch { /* ignore */ }
  const fn = refreshFns.get(analysisId);
  if (fn) {
    fn();
  } else {
    console.warn(`[canvasAnalysisRefresh] No compute hook registered for ${analysisId}; caches purged but nothing to recompute until a node mounts.`);
  }
}
