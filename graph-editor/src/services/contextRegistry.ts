/**
 * Context Registry
 * 
 * Wrapper service for context-specific operations.
 * Wraps paramRegistryService with context-aware logic (otherPolicy, source mappings).
 */

import { paramRegistryService } from './paramRegistryService';
import { fileRegistry } from '../contexts/TabContext';
import { db } from '../db/appDatabase';

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

export interface ContextSection {
  id: string;
  name: string;
  values: ContextValue[];
  otherPolicy?: ContextDefinition['otherPolicy'];
}

export class ContextRegistry {
  private cache: Map<string, ContextDefinition> = new Map();
  
  private cacheKey(id: string, workspace?: { repository: string; branch: string }): string {
    if (!workspace) return id;
    return `${workspace.repository}/${workspace.branch}:${id}`;
  }
  
  /**
   * Clear the cache to force reload from source.
   */
  clearCache(): void {
    console.log('[ContextRegistry] Clearing cache');
    this.cache.clear();
  }
  
  /**
   * Get context definition (loads and caches).
   * Tries param registry (filesystem) first for fresh data, then falls back to workspace.
   */
  async getContext(
    id: string,
    options?: { workspace?: { repository: string; branch: string } }
  ): Promise<ContextDefinition | undefined> {
    const key = this.cacheKey(id, options?.workspace);
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    
    try {
      // Try param registry FIRST (loads from filesystem - always fresh)
      try {
        console.log(`[ContextRegistry] Loading ${id} from param registry (filesystem)...`);
        const context = await paramRegistryService.loadContext(id) as ContextDefinition;
        if (context) {
          console.log(`[ContextRegistry] Loaded ${id} from filesystem`);
          this.cache.set(key, context);
          return context;
        }
      } catch (fsError) {
        console.log(`[ContextRegistry] Could not load ${id} from filesystem:`, fsError);
      }
      
      // Fall back to workspace (IndexedDB) if filesystem load failed
      const allFiles = Array.from((fileRegistry as any).files?.values() || []) as any[];
      for (const file of allFiles) {
        if (file.type === 'context' && file.data?.id === id) {
          console.log(`[ContextRegistry] Found ${id} in workspace as ${file.fileId}`);
          const context = file.data as ContextDefinition;
          this.cache.set(key, context);
          return context;
        }
      }

      // Fall back to IndexedDB records for the current workspace even if the file isn't loaded into FileRegistry.
      // This is critical for WindowSelector's "+ Contexts" flow: when the pinned DSL has no contexts, we still need
      // to list all available contexts without requiring the user to open context files first.
      try {
        const allContextFiles = await db.files.where('type').equals('context').toArray();
        const scoped = options?.workspace
          ? allContextFiles.filter(f =>
              f.source?.repository === options.workspace!.repository &&
              f.source?.branch === options.workspace!.branch
            )
          : allContextFiles;
        
        const match = scoped.find(f => (f as any).data?.id === id);
        if (match?.data) {
          console.log(`[ContextRegistry] Found ${id} in IndexedDB as ${match.fileId}`);
          const context = match.data as any as ContextDefinition;
          this.cache.set(key, context);
          return context;
        }
      } catch (idbError) {
        console.warn(`[ContextRegistry] Could not load ${id} from IndexedDB:`, idbError);
      }
      
      console.error(`[ContextRegistry] Context ${id} not found in filesystem or workspace`);
      return undefined;
    } catch (error) {
      console.error(`Failed to load context '${id}':`, error);
      return undefined;
    }
  }
  
  /**
   * Get values for a context, respecting otherPolicy.
   * Returns values that should appear in UI dropdowns.
   */
  async getValuesForContext(
    contextId: string,
    options?: { workspace?: { repository: string; branch: string } }
  ): Promise<ContextValue[]> {
    const ctx = await this.getContext(contextId, options);
    if (!ctx) return [];
    
    const policy = ctx.otherPolicy || 'undefined';
    const rawValues = Array.isArray((ctx as any).values) ? (ctx as any).values as ContextValue[] : [];
    if (!Array.isArray((ctx as any).values)) {
      console.warn(`[ContextRegistry] Context ${contextId} has no values array; treating as empty`);
    }
    const hasOther = rawValues.some(v => v.id === 'other');
    
    console.log(`[ContextRegistry] getValuesForContext(${contextId}):`, {
      otherPolicy: policy,
      totalValues: rawValues.length,
      hasOther,
      valueIds: rawValues.map(v => v.id)
    });
    
    let values = [...rawValues];
    
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
   * Build a UI section object for a context key.
   * Returns null if the context can't be loaded.
   */
  async getContextSection(
    contextId: string,
    options?: { workspace?: { repository: string; branch: string } }
  ): Promise<ContextSection | null> {
    const context = await this.getContext(contextId, options);
    if (!context) return null;

    const values = await this.getValuesForContext(contextId, options);
    return {
      id: contextId,
      name: contextId.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      values,
      otherPolicy: context.otherPolicy,
    };
  }

  /**
   * Build UI sections for a list of context keys.
   * Uses all-settled semantics so a single malformed context can't break the whole dropdown.
   */
  async getContextSections(
    keys: Array<{ id: string }>,
    options?: { workspace?: { repository: string; branch: string } }
  ): Promise<ContextSection[]> {
    const results = await Promise.allSettled(
      keys.map(k => this.getContextSection(k.id, options))
    );

    const sections: ContextSection[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        sections.push(r.value);
      }
    }
    return sections;
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
   * Get all context keys.
   * Tries param registry (filesystem) first, then falls back to workspace.
   */
  async getAllContextKeys(options?: { workspace?: { repository: string; branch: string } }): Promise<Array<{ id: string; type: string; status: string; fileId?: string }>> {
    // Try param registry FIRST (loads from filesystem - always fresh)
    try {
      console.log('[ContextRegistry] Loading contexts index from param registry (filesystem)...');
      const index = await paramRegistryService.loadContextsIndex();
      if (index.contexts && index.contexts.length > 0) {
        console.log('[ContextRegistry] Found contexts from filesystem:', index.contexts.map((c: any) => c.id));
        return index.contexts;
      }
    } catch (fsError) {
      console.log('[ContextRegistry] Could not load contexts index from filesystem:', fsError);
    }
    
    // Fall back to workspace sources.
    // Prefer IndexedDB (source of truth for files) because FileRegistry only contains a subset (open tabs).
    const contextKeys: Array<{ id: string; type: string; status: string; fileId?: string }> = [];
    
    try {
      const allContextFiles = await db.files.where('type').equals('context').toArray();
      const scoped = options?.workspace
        ? allContextFiles.filter(f =>
            f.source?.repository === options.workspace!.repository &&
            f.source?.branch === options.workspace!.branch
          )
        : allContextFiles;
      for (const file of scoped) {
        const data: any = (file as any).data;
        if (!data?.id) continue;
        contextKeys.push({
          id: data.id,
          type: data.type || 'categorical',
          status: data.metadata?.status || 'active',
          fileId: file.fileId,
        });
      }
    } catch (idbError) {
      console.warn('[ContextRegistry] Could not load contexts from IndexedDB, falling back to FileRegistry scan:', idbError);
      
      const allFiles = Array.from((fileRegistry as any).files?.values() || []) as any[];
      console.log('[ContextRegistry] Scanning fileRegistry, total files:', allFiles.length);
      for (const file of allFiles) {
        if (file.type === 'context' && file.data?.id) {
          contextKeys.push({
            id: file.data.id,
            type: file.data.type || 'categorical',
            status: file.data.metadata?.status || 'active',
            fileId: file.fileId
          });
        }
      }
    }
    
    // Deduplicate by id (IDB can contain both prefixed and unprefixed copies).
    const deduped = new Map<string, { id: string; type: string; status: string; fileId?: string }>();
    for (const entry of contextKeys) {
      const existing = deduped.get(entry.id);
      if (!existing) {
        deduped.set(entry.id, entry);
        continue;
      }
      const existingFileId = existing.fileId || '';
      const nextFileId = entry.fileId || '';
      // Prefer unprefixed fileIds (usually start with "context-"), otherwise prefer the shorter one.
      const existingIsUnprefixed = existingFileId.startsWith('context-');
      const nextIsUnprefixed = nextFileId.startsWith('context-');
      const shouldReplace =
        (nextIsUnprefixed && !existingIsUnprefixed) ||
        (!existingIsUnprefixed && !nextIsUnprefixed && nextFileId.length > 0 && nextFileId.length < existingFileId.length);
      if (shouldReplace) {
        deduped.set(entry.id, entry);
      }
    }
    
    const result = Array.from(deduped.values());
    console.log('[ContextRegistry] Found contexts in workspace:', result);
    return result;
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
  
}

export const contextRegistry = new ContextRegistry();

