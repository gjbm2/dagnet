/**
 * Hook for managing the bead display mode preference.
 * Controls how probability beads render: edge-rate (%), data-values (k/n), or path-rate (path %).
 *
 * When used inside GraphEditor (with ViewPreferencesContext), uses the context directly.
 * When used at app shell level (ViewMenu), falls back to tab state if context not available.
 */
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useTabContext } from '../contexts/TabContext';
import type { BeadDisplayMode } from '../types';

export function useBeadDisplayMode() {
  const viewPrefs = useViewPreferencesContext();
  const { activeTabId, tabs, operations } = useTabContext();

  const activeTab = tabs.find(t => t.id === activeTabId);

  const beadDisplayMode: BeadDisplayMode = viewPrefs?.beadDisplayMode
    ?? (activeTab?.editorState?.beadDisplayMode as BeadDisplayMode)
    ?? 'edge-rate';

  const setBeadDisplayMode = (value: BeadDisplayMode) => {
    if (viewPrefs) {
      viewPrefs.setBeadDisplayMode(value);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { beadDisplayMode: value });
    }
  };

  return {
    beadDisplayMode,
    setBeadDisplayMode,
    isDataValues: beadDisplayMode === 'data-values',
    isPathRate: beadDisplayMode === 'path-rate',
    isEdgeRate: beadDisplayMode === 'edge-rate',
  };
}
