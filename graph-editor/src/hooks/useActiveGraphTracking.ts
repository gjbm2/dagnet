import { useEffect } from 'react';
import type { GraphData } from '../types';
import { activeGraphTrackerService } from '../services/activeGraphTrackerService';

/**
 * Dev-only hook: tracks the currently active graph in a central service so other tooling
 * (e.g. mark-driven snapshots) can access it without reaching into React internals.
 */
export function useActiveGraphTracking(params: {
  fileId: string;
  tabId?: string;
  graph: GraphData | null;
  isActive: boolean;
}): void {
  const { fileId, tabId, graph, isActive } = params;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!isActive) return;
    activeGraphTrackerService.setActiveGraph(fileId, graph, tabId);
  }, [fileId, tabId, graph, isActive]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (isActive) return;
    activeGraphTrackerService.clearIfActive(fileId);
  }, [fileId, isActive]);
}


