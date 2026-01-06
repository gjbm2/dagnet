import type { GraphData } from '../types';

type ActiveGraphSnapshot = {
  ts_ms: number;
  fileId: string;
  tabId?: string;
  graph: GraphData | null;
};

class ActiveGraphTrackerService {
  private active: ActiveGraphSnapshot | null = null;

  setActiveGraph(fileId: string, graph: GraphData | null, tabId?: string): void {
    this.active = {
      ts_ms: Date.now(),
      fileId,
      tabId,
      graph: graph ? structuredClone(graph) : null,
    };
  }

  clearIfActive(fileId: string): void {
    if (this.active?.fileId === fileId) {
      this.active = null;
    }
  }

  getActiveGraph(): ActiveGraphSnapshot | null {
    return this.active ? structuredClone(this.active) : null;
  }
}

export const activeGraphTrackerService = new ActiveGraphTrackerService();


