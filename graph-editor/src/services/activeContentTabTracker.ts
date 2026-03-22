/**
 * Shared tracker for the active content tab index per canvas analysis.
 *
 * CanvasAnalysisNode broadcasts tab changes via dagnet:analysisActiveTabChanged.
 * This module listens globally and maintains a Map<analysisId, tabIndex> that
 * any component can query synchronously — no need for per-component event listeners.
 */

const activeTabMap = new Map<string, number>();

/** Get the active content tab index for an analysis (0 if not tracked). */
export function getActiveContentTabIndex(analysisId: string): number {
  return activeTabMap.get(analysisId) ?? 0;
}

/** Install the global listener. Call once at app startup. */
export function installActiveContentTabTracker(): () => void {
  const handler = (e: Event) => {
    const { analysisId, activeContentIndex } = (e as CustomEvent).detail || {};
    if (analysisId != null) {
      activeTabMap.set(analysisId, activeContentIndex ?? 0);
    }
  };
  window.addEventListener('dagnet:analysisActiveTabChanged', handler);
  return () => window.removeEventListener('dagnet:analysisActiveTabChanged', handler);
}

// Auto-install in browser environments
if (typeof window !== 'undefined') {
  installActiveContentTabTracker();
}
