import { useSyncExternalStore } from 'react';
import { automationRunService, type AutomationRunState } from '../services/automationRunService';

export function useAutomationRunState(): AutomationRunState {
  return useSyncExternalStore(
    (listener) => automationRunService.subscribe(listener),
    () => automationRunService.getState(),
    () => automationRunService.getState()
  );
}


