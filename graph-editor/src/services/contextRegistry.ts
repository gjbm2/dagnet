/**
 * Context Registry
 * 
 * Wrapper service for context-specific operations.
 * Wraps paramRegistryService with context-aware logic (otherPolicy, source mappings).
 */

import { paramRegistryService } from './paramRegistryService';
import { fileRegistry } from '../contexts/TabContext';

export interface ContextDefinition {
  id: string;
  name: string;
  description: string;
  type: 'categorical' | 'ordinal' | 'continuous';
  otherPolicy?: 'null' | 'computed' | 'explicit' | 'undefined';
  values: ContextValue[];
  metadata: {
    category?: string;
    data_source?: string;
    created_at: string;
    updated_at?: string;
    version: string;
    status: 'active' | 'deprecated' | 'draft';
    author?: string;
    deprecation_notice?: string;
    replacement_context_id?: string;
  };
}

export interface ContextValue {
  id: string;
  label: string;
  description?: string;
  order?: number;
  aliases?: string[];
  sources?: Record<string, SourceMapping>;
}

export interface SourceMapping {
  field?: string;
  filter?: string;
  pattern?: string;
  patternFlags?: string;
}

export class ContextRegistry {
  private cache: Map<string, ContextDefinition> = new Map();
  
  /**
   * Get context definition (loads and caches).
   * Checks workspace first, then falls back to param registry.
   */
  async getContext(id: string): Promise<ContextDefinition | undefined> {
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }
    
    try {
      // Scan ALL context files in workspace to find matching id
      const allFiles = Array.from((fileRegistry as any).files?.values() || []) as any[];
      for (const file of allFiles) {
        if (file.type === 'context' && file.data?.id === id) {
          console.log(`[ContextRegistry] Found ${id} in workspace as ${file.fileId}`);
          const context = file.data as ContextDefinition;
          this.cache.set(id, context);
          return context;
        }
      }
      
      // Fall back to param registry (git/filesystem)
      console.log(`[ContextRegistry] Context ${id} not in workspace, trying param registry`);
      const context = await paramRegistryService.loadContext(id) as ContextDefinition;
      this.cache.set(id, context);
      return context;
    } catch (error) {
      console.error(`Failed to load context '${id}':`, error);
      return undefined;
    }
  }
  
  /**
   * Get values for a context, respecting otherPolicy.
   * Returns values that should appear in UI dropdowns.
   */
  async getValuesForContext(contextId: string): Promise<ContextValue[]> {
    const ctx = await this.getContext(contextId);
    if (!ctx) return [];
    
    const policy = ctx.otherPolicy || 'undefined';
    const hasOther = ctx.values.some(v => v.id === 'other');
    
    console.log(`[ContextRegistry] getValuesForContext(${contextId}):`, {
      otherPolicy: policy,
      totalValues: ctx.values.length,
      hasOther,
      valueIds: ctx.values.map(v => v.id)
    });
    
    let values = [...ctx.values];
    
    switch (policy) {
      case 'null':
      case 'undefined':
        // Exclude "other" if present (not queryable for these policies)
        values = values.filter(v => v.id !== 'other');
        break;
        
      case 'computed':
        // "other" should exist; auto-create if missing
        if (!hasOther) {
          console.log(`[ContextRegistry] Auto-creating 'other' value for computed policy`);
          values.push({
            id: 'other',
            label: 'Other',
            description: `All ${contextId} values not explicitly listed`
          });
        }
        // Include all values (explicit + other)
        break;
        
      case 'explicit':
        // "other" must exist with explicit filter
        if (!hasOther) {
          console.error(`[ContextRegistry] otherPolicy='explicit' but no 'other' value defined for ${contextId}`);
        }
        // Include all values
        break;
    }
    
    console.log(`[ContextRegistry] Returning values (policy=${policy}):`, values.map(v => v.id));
    return values;
  }
  
  /**
   * Get source mapping for a specific (key, value, source) combination.
   */
  async getSourceMapping(
    contextKey: string,
    value: string,
    source: string
  ): Promise<SourceMapping | undefined> {
    const ctx = await this.getContext(contextKey);
    if (!ctx) return undefined;
    
    const valueObj = ctx.values.find(v => v.id === value);
    if (!valueObj || !valueObj.sources) return undefined;
    
    return valueObj.sources[source];
  }
  
  /**
   * Get all context keys from workspace files.
   * Scans fileRegistry for context-* files.
   */
  async getAllContextKeys(): Promise<Array<{ id: string; type: string; status: string; fileId?: string }>> {
    const contextKeys: Array<{ id: string; type: string; status: string; fileId?: string }> = [];
    
    // Scan fileRegistry for context files
    const allFiles = Array.from((fileRegistry as any).files?.values() || []) as any[];
    console.log('[ContextRegistry] Scanning fileRegistry, total files:', allFiles.length);
    const contextFiles = allFiles.filter((f: any) => f.type === 'context');
    console.log('[ContextRegistry] Context files found:', contextFiles.map((f: any) => ({ fileId: f.fileId, dataId: f.data?.id })));
    
    for (const file of allFiles) {
      if (file.type === 'context' && file.data?.id) {
        console.log('[ContextRegistry] Found context file:', file.fileId, 'with id:', file.data.id);
        contextKeys.push({
          id: file.data.id,
          type: file.data.type || 'categorical',
          status: file.data.metadata?.status || 'active',
          fileId: file.fileId
        });
      }
    }
    
    // Fall back to param registry if no workspace contexts found
    if (contextKeys.length === 0) {
      try {
        console.log('[ContextRegistry] No workspace contexts, trying param registry');
        const index = await paramRegistryService.loadContextsIndex();
        return index.contexts || [];
      } catch (error) {
        console.warn('No contexts in workspace or registry:', error);
        return [];
      }
    }
    
    console.log('[ContextRegistry] Found contexts in workspace:', contextKeys);
    return contextKeys;
  }
  
  /**
   * Detect if windows form a MECE partition for a context key.
   * 
   * @param windows - Windows to check
   * @param contextKey - Context key to check against
   * @returns MECE status, completeness, and aggregation safety
   */
  async detectMECEPartition(
    windows: Array<{ sliceDSL?: string }>,
    contextKey: string
  ): Promise<{
    isMECE: boolean;
    isComplete: boolean;
    canAggregate: boolean;
    missingValues: string[];
    policy: string;
  }> {
    const contextDef = await this.getContext(contextKey);
    if (!contextDef) {
      return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'unknown' };
    }
    
    const policy = contextDef.otherPolicy || 'undefined';
    
    // Get expected values based on otherPolicy
    const expectedValues = await this.getExpectedValues(contextDef);
    
    // Extract values from windows
    const { parseConstraints } = await import('../lib/queryDSL');
    const windowValues = new Set<string>();
    for (const window of windows) {
      const parsed = parseConstraints(window.sliceDSL || '');
      const contextConstraint = parsed.context.find(c => c.key === contextKey);
      if (contextConstraint) {
        windowValues.add(contextConstraint.value);
      }
    }
    
    // Check for duplicates (non-MECE)
    if (windowValues.size < windows.length) {
      return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy };
    }
    
    // Check for extras (values not in registry)
    const hasExtras = Array.from(windowValues).some(v => !expectedValues.has(v));
    if (hasExtras) {
      return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy };
    }
    
    // Check completeness
    const missingValues = Array.from(expectedValues).filter(v => !windowValues.has(v));
    const isComplete = missingValues.length === 0;
    
    // Determine if aggregation is safe
    const canAggregate = this.determineAggregationSafety(policy, isComplete);
    
    return {
      isMECE: true,
      isComplete,
      canAggregate,
      missingValues,
      policy
    };
  }
  
  /**
   * Get expected values for a context based on its otherPolicy.
   */
  private async getExpectedValues(contextDef: ContextDefinition): Promise<Set<string>> {
    const values = new Set<string>();
    const policy = contextDef.otherPolicy || 'undefined';
    
    switch (policy) {
      case 'null':
        // Only explicit values; no "other"
        for (const v of contextDef.values) {
          if (v.id !== 'other') values.add(v.id);
        }
        break;
        
      case 'computed':
      case 'explicit':
        // All values including "other"
        for (const v of contextDef.values) {
          values.add(v.id);
        }
        break;
        
      case 'undefined':
        // Only explicit values; no "other"; NOT MECE
        for (const v of contextDef.values) {
          if (v.id !== 'other') values.add(v.id);
        }
        break;
    }
    
    return values;
  }
  
  /**
   * Determine if aggregation across a key is safe (treats result as complete).
   */
  private determineAggregationSafety(policy: string, isComplete: boolean): boolean {
    switch (policy) {
      case 'null':
      case 'computed':
      case 'explicit':
        // MECE assured; safe to treat as complete only if we have all values
        return isComplete;
        
      case 'undefined':
        // NOT MECE; never safe to treat aggregation as complete
        return false;
        
      default:
        return false;
    }
  }
  
  /**
   * Clear cache (useful for testing or when registry updated).
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export const contextRegistry = new ContextRegistry();

