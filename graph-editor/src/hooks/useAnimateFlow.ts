/**
 * Hook for managing the animate flow preference.
 * Controls whether chevron animations are shown on edges.
 */
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';

export function useAnimateFlow() {
  const viewPrefs = useViewPreferencesContext();
  
  const animateFlow = viewPrefs?.animateFlow ?? true;
  const setAnimateFlow = viewPrefs?.setAnimateFlow ?? (() => {});
  
  const toggleAnimateFlow = () => {
    setAnimateFlow(!animateFlow);
  };
  
  return {
    animateFlow,
    setAnimateFlow,
    toggleAnimateFlow
  };
}

