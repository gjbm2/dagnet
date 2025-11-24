/**
 * Variable Aggregation Cache
 * 
 * In-memory cache for context-to-window lookups.
 * Provides O(1) lookup after initial O(n) build.
 */

import type { ParameterValue } from './paramRegistryService';
import { parseConstraints } from '../lib/queryDSL';
import type { ContextCombination } from './contextAggregationService';

export class VariableAggregationCache {
  private contextIndexByVar: Map<string, Map<string, ParameterValue>> = new Map();
  
  /**
   * Get window for a specific context combo (O(1) after first build).
   */
  getWindowForContext(
    variableId: string,
    windows: ParameterValue[],
    contextCombo: ContextCombination
  ): ParameterValue | undefined {
    
    // Build index lazily on first access
    if (!this.contextIndexByVar.has(variableId)) {
      this.buildIndexForVariable(variableId, windows);
    }
    
    const index = this.contextIndexByVar.get(variableId)!;
    const key = this.contextComboToKey(contextCombo);
    
    return index.get(key);
  }
  
  /**
   * Build index for a variable (called lazily).
   */
  private buildIndexForVariable(variableId: string, windows: ParameterValue[]): void {
    const index = new Map<string, ParameterValue>();
    
    for (const window of windows) {
      const parsed = parseConstraints(window.sliceDSL || '');
      const combo: ContextCombination = {};
      
      for (const ctx of parsed.context) {
        combo[ctx.key] = ctx.value;
      }
      
      const key = this.contextComboToKey(combo);
      index.set(key, window);
    }
    
    this.contextIndexByVar.set(variableId, index);
  }
  
  /**
   * Convert context combination to cache key.
   */
  private contextComboToKey(combo: ContextCombination): string {
    if (Object.keys(combo).length === 0) {
      return '';  // Empty key for uncontexted
    }
    
    // Sort keys for deterministic key
    const sorted = Object.entries(combo).sort(([a], [b]) => a.localeCompare(b));
    return sorted.map(([k, v]) => `${k}:${v}`).join('|');
  }
  
  /**
   * Invalidate cache for a variable (when windows change).
   */
  invalidate(variableId: string): void {
    this.contextIndexByVar.delete(variableId);
  }
  
  /**
   * Clear entire cache.
   */
  clearAll(): void {
    this.contextIndexByVar.clear();
  }
}

export const variableAggregationCache = new VariableAggregationCache();

