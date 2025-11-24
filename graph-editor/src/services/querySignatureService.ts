/**
 * Query Signature Service
 * 
 * Centralizes data query signature generation and validation.
 * Ensures consistency across adapters and incremental fetch logic.
 * 
 * Signatures are for DATA QUERY SPECS, not user DSL queries or slice keys.
 */

import type { ParsedConstraints } from '../lib/queryDSL';

export interface DataQuerySpec {
  // Connection
  connectionId: string;
  connectionType: 'amplitude' | 'sheets' | 'statsig' | 'optimizely';
  
  // Graph topology (as seen by adapter)
  fromNode: string;
  toNode: string;
  visited: string[];
  excluded: string[];
  cases: Array<{ key: string; value: string }>;
  
  // Context filters (as transformed for this source)
  contextFilters: Array<{
    key: string;
    value: string;
    sourceField: string;      // e.g., "utm_source"
    sourcePredicate: string;  // e.g., "utm_source == 'google'"
  }>;
  
  // Time handling
  granularity: 'daily' | 'aggregate';
  // For 'aggregate' mode: include window bounds
  // For 'daily' mode: EXCLUDE window bounds (partial windows remain valid)
  windowBounds?: { start: string; end: string };
  
  // Adapter-specific config
  adapterOptions: Record<string, any>;  // Deterministically ordered
}

export class QuerySignatureService {
  /**
   * Build signature for a daily-capable query.
   * Excludes date bounds so partial windows remain valid.
   */
  async buildDailySignature(spec: Omit<DataQuerySpec, 'windowBounds'>): Promise<string> {
    const normalized = this.normalizeSpec({ ...spec, granularity: 'daily' });
    return await this.hashSpec(normalized);
  }
  
  /**
   * Build signature for an aggregate-only query.
   * Includes date bounds since the slice is tied to that specific window.
   */
  async buildAggregateSignature(spec: DataQuerySpec): Promise<string> {
    if (spec.granularity !== 'aggregate') {
      throw new Error('buildAggregateSignature requires granularity: aggregate');
    }
    const normalized = this.normalizeSpec(spec);
    return await this.hashSpec(normalized);
  }
  
  /**
   * Check if stored signature matches current query spec.
   * Returns { valid: boolean; reason?: string }
   */
  async validateSignature(
    storedSignature: string,
    currentSpec: DataQuerySpec
  ): Promise<{ valid: boolean; reason?: string }> {
    const currentSig = currentSpec.granularity === 'daily'
      ? await this.buildDailySignature(currentSpec)
      : await this.buildAggregateSignature(currentSpec);
    
    if (storedSignature === currentSig) {
      return { valid: true };
    }
    
    return { 
      valid: false, 
      reason: 'Data query spec changed (topology, connection, or context mappings differ)' 
    };
  }
  
  /**
   * Normalize spec to deterministic form for hashing.
   * - Sort arrays (visited, excluded, contextFilters)
   * - Remove undefined/null fields
   * - Order object keys
   */
  private normalizeSpec(spec: Partial<DataQuerySpec>): Record<string, any> {
    const normalized: Record<string, any> = {};
    
    // Add fields in alphabetical order for determinism
    if (spec.adapterOptions) {
      // Sort adapter options keys
      const sortedOptions: Record<string, any> = {};
      Object.keys(spec.adapterOptions).sort().forEach(key => {
        sortedOptions[key] = spec.adapterOptions![key];
      });
      normalized.adapterOptions = sortedOptions;
    }
    
    if (spec.cases) {
      normalized.cases = [...spec.cases].sort((a, b) => 
        a.key.localeCompare(b.key) || a.value.localeCompare(b.value)
      );
    }
    
    if (spec.connectionId) normalized.connectionId = spec.connectionId;
    if (spec.connectionType) normalized.connectionType = spec.connectionType;
    
    if (spec.contextFilters) {
      normalized.contextFilters = [...spec.contextFilters].sort((a, b) =>
        a.key.localeCompare(b.key) || a.value.localeCompare(b.value)
      );
    }
    
    if (spec.excluded) {
      normalized.excluded = [...spec.excluded].sort();
    }
    
    if (spec.fromNode) normalized.fromNode = spec.fromNode;
    if (spec.granularity) normalized.granularity = spec.granularity;
    if (spec.toNode) normalized.toNode = spec.toNode;
    
    if (spec.visited) {
      normalized.visited = [...spec.visited].sort();
    }
    
    // Include windowBounds only if present (for aggregate mode)
    if (spec.windowBounds) {
      normalized.windowBounds = spec.windowBounds;
    }
    
    return normalized;
  }
  
  /**
   * Hash normalized spec using SHA-256.
   */
  private async hashSpec(normalized: Record<string, any>): Promise<string> {
    const canonical = JSON.stringify(normalized);
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  }
}

export const querySignatureService = new QuerySignatureService();

