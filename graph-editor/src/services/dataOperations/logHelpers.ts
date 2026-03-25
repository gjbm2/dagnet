/**
 * Logging and formatting helpers for data operations.
 *
 * Provides human-readable formatters for session log output, plus
 * the deprecated exclude-query compilation function.
 *
 * Extracted from dataOperationsService.ts (Clusters B + C) during slimdown.
 */

import type { Graph } from '../../types';

import { PYTHON_API_BASE } from '../../lib/pythonApiBase';

/**
 * Format edge identifier in human-readable form for logging
 * Shows: "from → to (paramId)" or "from → to" if no param
 */
export function formatEdgeForLog(edge: any, graph: Graph | null): string {
  if (!edge) return 'unknown edge';

  // Find source and target nodes to get human-readable names
  const fromNode = graph?.nodes?.find((n: any) => n.uuid === edge.from || n.id === edge.from);
  const toNode = graph?.nodes?.find((n: any) => n.uuid === edge.to || n.id === edge.to);

  const fromName = fromNode?.id || fromNode?.label || edge.from?.substring(0, 8) || '?';
  const toName = toNode?.id || toNode?.label || edge.to?.substring(0, 8) || '?';
  const paramId = edge.p?.id;

  return paramId
    ? `${fromName} → ${toName} (${paramId})`
    : `${fromName} → ${toName}`;
}

/**
 * Format node identifier in human-readable form for logging
 */
export function formatNodeForLog(node: any): string {
  if (!node) return 'unknown node';
  return node.id || node.label || node.uuid?.substring(0, 8) || '?';
}

/**
 * Compile a query with excludes() to minus/plus form for providers that don't support native excludes.
 * Calls Python MSMDC API to perform the compilation.
 *
 * @param queryString - Original query string with excludes() terms
 * @param graph - Graph for topology analysis
 * @returns Compiled query string with minus/plus terms, or original if compilation fails
 */
interface CompileExcludeResult {
  compiled_query: string;
  was_compiled: boolean;
  success: boolean;
  error?: string;
  terms_count?: number;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPRECATED: 4-Dec-25 - EXCLUDE QUERY COMPILATION
 *
 * This function compiled exclude() queries to minus/plus form via Python API.
 * This was required because we believed Amplitude didn't support native exclude filters.
 *
 * REPLACEMENT: Native segment filters in Amplitude adapter (connections.yaml)
 * The adapter now converts excludes to segment filters with `op: "="`, `value: 0`.
 *
 * This function will NOT be called for Amplitude because the adapter handles
 * excludes natively before this code path is reached.
 *
 * DO NOT DELETE until native segment filters are confirmed working in production.
 * Target deletion: After 2 weeks of production validation.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function compileExcludeQuery(queryString: string, graph: any): Promise<{ compiled: string; wasCompiled: boolean; error?: string }> {
  try {
    // Call Python API endpoint to compile the query
    const response = await fetch(`${PYTHON_API_BASE}/api/compile-exclude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryString,
        graph: graph
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[compileExcludeQuery] API error:', errorText);
      return { compiled: queryString, wasCompiled: false, error: `API error: ${errorText}` };
    }

    const result: CompileExcludeResult = await response.json();

    // CRITICAL: Check was_compiled flag to detect silent failures
    // The API returns the original query on failure, so we can't just check compiled_query !== queryString
    if (!result.success) {
      console.error('[compileExcludeQuery] Compilation failed:', result.error);
      return { compiled: queryString, wasCompiled: false, error: result.error || 'Unknown compilation error' };
    }

    if (!result.was_compiled) {
      // No excludes found (shouldn't happen if we pre-checked, but handle gracefully)
      console.warn('[compileExcludeQuery] No excludes found in query - nothing to compile');
      return { compiled: queryString, wasCompiled: false };
    }

    if (result.compiled_query) {
      console.log('[compileExcludeQuery] Successfully compiled:', {
        original: queryString,
        compiled: result.compiled_query,
        termsCount: result.terms_count
      });
      return { compiled: result.compiled_query, wasCompiled: true };
    }

    console.warn('[compileExcludeQuery] No compiled_query in response:', result);
    return { compiled: queryString, wasCompiled: false, error: 'No compiled_query in response' };
  } catch (error) {
    console.error('[compileExcludeQuery] Failed to call compile API:', error);
    return { compiled: queryString, wasCompiled: false, error: error instanceof Error ? error.message : String(error) };
  }
}
