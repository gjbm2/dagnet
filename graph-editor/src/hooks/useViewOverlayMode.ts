/**
 * Hook for managing the view overlay mode preference.
 * Controls canvas-wide visual overlays (e.g. forecast quality colour-coding).
 *
 * When used inside GraphEditor (with ViewPreferencesContext), uses the context directly.
 * When used at app shell level (ViewMenu), falls back to tab state if context not available.
 */
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useTabContext } from '../contexts/TabContext';
import type { ViewOverlayMode } from '../types';

export function useViewOverlayMode() {
  const viewPrefs = useViewPreferencesContext();
  const { activeTabId, tabs, operations } = useTabContext();

  const activeTab = tabs.find(t => t.id === activeTabId);

  const viewOverlayMode: ViewOverlayMode = viewPrefs?.viewOverlayMode
    ?? (activeTab?.editorState?.viewOverlayMode as ViewOverlayMode ?? 'none');

  const setViewOverlayMode = (value: ViewOverlayMode) => {
    if (viewPrefs) {
      viewPrefs.setViewOverlayMode(value);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { viewOverlayMode: value });
    }
  };

  const toggleForecastQuality = () => {
    setViewOverlayMode(viewOverlayMode === 'forecast-quality' ? 'none' : 'forecast-quality');
  };

  const toggleDataDepth = () => {
    setViewOverlayMode(viewOverlayMode === 'data-depth' ? 'none' : 'data-depth');
  };

  return {
    viewOverlayMode,
    setViewOverlayMode,
    toggleForecastQuality,
    toggleDataDepth,
    isForecastQuality: viewOverlayMode === 'forecast-quality',
    isDataDepth: viewOverlayMode === 'data-depth',
  };
}
