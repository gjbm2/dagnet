/**
 * Hook for managing the Sankey view preference.
 * Controls whether the graph is displayed in Sankey mode with flow-proportional node heights.
 * 
 * When used inside GraphEditor (with ViewPreferencesContext), uses the context directly.
 * When used at app shell level (ViewMenu), falls back to tab state if context not available.
 */
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useTabContext } from '../contexts/TabContext';

export function useSankeyView() {
  const viewPrefs = useViewPreferencesContext();
  const { activeTabId, tabs, operations } = useTabContext();
  
  const activeTab = tabs.find(t => t.id === activeTabId);
  
  // Use context if available, fallback to active tab state
  const useSankeyView = viewPrefs?.useSankeyView ?? (activeTab?.editorState?.useSankeyView ?? false);
  
  const setUseSankeyView = (value: boolean) => {
    if (viewPrefs) {
      viewPrefs.setUseSankeyView(value);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { useSankeyView: value });
    }
  };
  
  const toggleSankeyView = () => {
    setUseSankeyView(!useSankeyView);
  };
  
  return {
    useSankeyView,
    setUseSankeyView,
    toggleSankeyView
  };
}

