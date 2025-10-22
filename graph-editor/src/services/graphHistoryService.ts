import { Graph } from '../lib/types';

export interface HistoryState {
  id: string;
  timestamp: number;
  graph: Graph;
  action: string;
  nodeId?: string;
  edgeId?: string;
}

export class GraphHistoryService {
  private history: HistoryState[] = [];
  private currentIndex = -1;
  private maxSize = 50;
  private isUndoRedo = false; // Prevent saving state during undo/redo operations

  /**
   * Save a new state to the history
   */
  saveState(graph: Graph, action: string, nodeId?: string, edgeId?: string): void {
    // Don't save during undo/redo operations
    if (this.isUndoRedo) return;

    // Remove any states after current index (when user makes new changes after undo)
    if (this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    // Create new state
    const newState: HistoryState = {
      id: `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      graph: structuredClone(graph), // Deep clone to prevent mutations
      action,
      nodeId,
      edgeId
    };

    // Add to history
    this.history.push(newState);
    this.currentIndex = this.history.length - 1;

    // Limit history size
    if (this.history.length > this.maxSize) {
      this.history.shift();
      this.currentIndex--;
    }
  }

  /**
   * Undo to previous state
   */
  undo(): Graph | null {
    if (!this.canUndo()) return null;

    this.isUndoRedo = true;
    this.currentIndex--;
    const previousState = this.history[this.currentIndex];
    
    // Defensive check to ensure previousState exists
    if (!previousState) {
      console.error('Undo failed: previousState is undefined');
      this.isUndoRedo = false;
      return null;
    }
    
    // Reset flag after a brief delay to allow state to settle
    setTimeout(() => {
      this.isUndoRedo = false;
    }, 100);

    return structuredClone(previousState.graph);
  }

  /**
   * Redo to next state
   */
  redo(): Graph | null {
    if (!this.canRedo()) return null;

    this.isUndoRedo = true;
    this.currentIndex++;
    const nextState = this.history[this.currentIndex];
    
    // Defensive check to ensure nextState exists
    if (!nextState) {
      console.error('Redo failed: nextState is undefined');
      this.isUndoRedo = false;
      return null;
    }
    
    // Reset flag after a brief delay to allow state to settle
    setTimeout(() => {
      this.isUndoRedo = false;
    }, 100);

    return structuredClone(nextState.graph);
  }

  /**
   * Check if undo is possible
   */
  canUndo(): boolean {
    return this.currentIndex > 0;
  }

  /**
   * Check if redo is possible
   */
  canRedo(): boolean {
    return this.currentIndex < this.history.length - 1;
  }

  /**
   * Get current state info
   */
  getCurrentState(): HistoryState | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length) {
      return this.history[this.currentIndex];
    }
    return null;
  }

  /**
   * Get recent history for UI display
   */
  getRecentHistory(limit = 10): HistoryState[] {
    const start = Math.max(0, this.currentIndex - limit + 1);
    return this.history.slice(start, this.currentIndex + 1);
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.history = [];
    this.currentIndex = -1;
  }

  /**
   * Get history statistics
   */
  getStats() {
    return {
      totalStates: this.history.length,
      currentIndex: this.currentIndex,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      maxSize: this.maxSize,
      currentState: this.history[this.currentIndex] ? this.history[this.currentIndex].action : 'none',
      previousState: this.history[this.currentIndex - 1] ? this.history[this.currentIndex - 1].action : 'none'
    };
  }

  /**
   * Set maximum history size
   */
  setMaxSize(size: number): void {
    this.maxSize = Math.max(1, size);
    
    // Trim history if it exceeds new max size
    if (this.history.length > this.maxSize) {
      const excess = this.history.length - this.maxSize;
      this.history = this.history.slice(excess);
      this.currentIndex = Math.max(0, this.currentIndex - excess);
    }
  }
}

// Export singleton instance
export const graphHistoryService = new GraphHistoryService();
