/**
 * Hook for managing the Data Values view preference.
 * Controls whether edge beads display n/k counts instead of percentage rates.
 *
 * When used inside GraphEditor (with ViewPreferencesContext), uses the context directly.
 * When used at app shell level (ViewMenu), falls back to tab state if context not available.
 */
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useTabContext } from '../contexts/TabContext';

export function useDataValuesView() {
  const viewPrefs = useViewPreferencesContext();
  const { activeTabId, tabs, operations } = useTabContext();

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Use context if available, fallback to active tab state
  const useDataValuesView = viewPrefs?.useDataValuesView ?? (activeTab?.editorState?.useDataValuesView ?? false);

  const setUseDataValuesView = (value: boolean) => {
    if (viewPrefs) {
      viewPrefs.setUseDataValuesView(value);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { useDataValuesView: value });
    }
  };

  const toggleDataValuesView = () => {
    setUseDataValuesView(!useDataValuesView);
  };

  return {
    useDataValuesView,
    setUseDataValuesView,
    toggleDataValuesView
  };
}
