import { useDashboardMode as useDashboardModeFromContext } from '../contexts/DashboardModeContext';

/**
 * Centralised hook for dashboard mode.
 * Keeps URL parameter behaviour out of menu files and other UI access points.
 */
export function useDashboardMode() {
  return useDashboardModeFromContext();
}


