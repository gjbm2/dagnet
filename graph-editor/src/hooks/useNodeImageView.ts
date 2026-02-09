/**
 * Hook for managing the "Show Node Images" view preference.
 * Controls whether nodes display their first attached image as the node body.
 * 
 * When used inside GraphEditor (with ViewPreferencesContext), uses the context directly.
 * When used at app shell level (ViewMenu), falls back to tab state if context not available.
 */
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useTabContext } from '../contexts/TabContext';

export function useNodeImageView() {
  const viewPrefs = useViewPreferencesContext();
  const { activeTabId, tabs, operations } = useTabContext();
  
  const activeTab = tabs.find(t => t.id === activeTabId);
  
  // Use context if available, fallback to active tab state
  const showNodeImages = viewPrefs?.showNodeImages ?? (activeTab?.editorState?.showNodeImages ?? true);
  
  const setShowNodeImages = (value: boolean) => {
    if (viewPrefs) {
      viewPrefs.setShowNodeImages(value);
    } else if (activeTabId) {
      operations.updateTabState(activeTabId, { showNodeImages: value });
    }
  };
  
  const toggleNodeImageView = () => {
    setShowNodeImages(!showNodeImages);
  };
  
  return {
    showNodeImages,
    setShowNodeImages,
    toggleNodeImageView
  };
}
