/**
 * Build DataQuerySpec for query signature generation
 * 
 * Used by adapters to generate signatures for stored data.
 */

import type { QueryPayload } from './buildDslFromEdge';
import type { DataQuerySpec } from '../../services/querySignatureService';
import { contextRegistry } from '../../services/contextRegistry';
import type { ParsedConstraints } from '../queryDSL';

/**
 * Build a DataQuerySpec from a QueryPayload and connection info.
 * This spec can then be passed to querySignatureService to generate a signature.
 * 
 * @param queryPayload - QueryPayload from buildDslFromEdge
 * @param connectionId - Connection ID
 * @param connectionType - Connection type (e.g., "amplitude")
 * @param constraints - Original parsed constraints (for context info)
 * @param granularity - 'daily' or 'aggregate'
 * @returns DataQuerySpec for signature generation
 */
export async function buildDataQuerySpec(
  queryPayload: QueryPayload,
  connectionId: string,
  connectionType: 'amplitude' | 'sheets' | 'statsig' | 'optimizely',
  constraints?: ParsedConstraints,
  granularity: 'daily' | 'aggregate' = 'daily'
): Promise<DataQuerySpec> {
  // Build context filters array
  const contextFilters: DataQuerySpec['contextFilters'] = [];
  
  if (constraints) {
    // Process context(...) constraints
    for (const ctx of constraints.context) {
      const mapping = await contextRegistry.getSourceMapping(ctx.key, ctx.value, connectionType);
      if (mapping) {
        contextFilters.push({
          key: ctx.key,
          value: ctx.value,
          sourceField: mapping.field || ctx.key,
          sourcePredicate: mapping.filter || mapping.pattern || ''
        });
      }
    }
    
    // Process contextAny(...) constraints
    for (const ctxAny of constraints.contextAny) {
      for (const pair of ctxAny.pairs) {
        const mapping = await contextRegistry.getSourceMapping(pair.key, pair.value, connectionType);
        if (mapping) {
          contextFilters.push({
            key: pair.key,
            value: pair.value,
            sourceField: mapping.field || pair.key,
            sourcePredicate: mapping.filter || mapping.pattern || ''
          });
        }
      }
    }
  }
  
  const spec: DataQuerySpec = {
    connectionId,
    connectionType,
    fromNode: queryPayload.from,
    toNode: queryPayload.to,
    visited: queryPayload.visited || [],
    excluded: queryPayload.exclude || [],
    cases: queryPayload.case || [],
    contextFilters,
    granularity,
    adapterOptions: {}
  };
  
  // Include window bounds only for aggregate mode
  if (granularity === 'aggregate' && queryPayload.start && queryPayload.end) {
    spec.windowBounds = {
      start: queryPayload.start,
      end: queryPayload.end
    };
  }
  
  return spec;
}


