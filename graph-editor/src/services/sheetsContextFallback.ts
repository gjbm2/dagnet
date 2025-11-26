/**
 * Sheets Context Fallback Logic
 * 
 * Handles fallback from contexted HRNs to uncontexted when data not available.
 * Policy: Fallback with warning (Option B from design).
 */

import { parseConstraints } from '../lib/queryDSL';

export interface SheetsFallbackResult {
  value: number | null;
  warning?: string;
  usedFallback: boolean;
}

/**
 * Resolve a Sheets parameter HRN with context fallback.
 * 
 * Strategy:
 * 1. Try exact match first
 * 2. If not found and policy is 'fallback', try uncontexted version
 * 3. Show UI warning if fallback was used
 * 
 * @param hrn - HRN to resolve (e.g., "e.edge-id.context(channel:google).p.mean")
 * @param paramPack - Param pack from Sheets
 * @param fallbackPolicy - 'strict' (no fallback) or 'fallback' (try uncontexted)
 * @returns Value and optional warning
 */
export function resolveSheetParameter(
  hrn: string,
  paramPack: Record<string, unknown>,
  fallbackPolicy: 'strict' | 'fallback' = 'fallback'
): SheetsFallbackResult {
  // Try exact match first
  if (hrn in paramPack) {
    const value = paramPack[hrn];
    return {
      value: typeof value === 'number' ? value : parseFloat(String(value)),
      usedFallback: false
    };
  }
  
  if (fallbackPolicy === 'strict') {
    return {
      value: null,
      warning: `Exact match for ${hrn} not found (strict mode)`,
      usedFallback: false
    };
  }
  
  // Fallback: try uncontexted version
  const uncontextedHrn = removeContextFromHRN(hrn);
  if (uncontextedHrn !== hrn && uncontextedHrn in paramPack) {
    const value = paramPack[uncontextedHrn];
    return {
      value: typeof value === 'number' ? value : parseFloat(String(value)),
      warning: `Using uncontexted fallback for ${hrn} → ${uncontextedHrn}`,
      usedFallback: true
    };
  }
  
  return {
    value: null,
    warning: `No data found for ${hrn} (contexted or uncontexted)`,
    usedFallback: false
  };
}

/**
 * Remove all context(...) and contextAny(...) and window(...) clauses from an HRN.
 * 
 * @param hrn - HRN with contexts (e.g., "e.edge-id.context(channel:google).p.mean")
 * @returns HRN without contexts (e.g., "e.edge-id.p.mean")
 */
export function removeContextFromHRN(hrn: string): string {
  // Remove all context(...), contextAny(...), and window(...) clauses
  // Pattern: match the constraint functions and their arguments
  let result = hrn;
  
  // Remove context(...) - handles nested values
  result = result.replace(/\.context\([^)]+\)/g, '');
  
  // Remove contextAny(...) - handles comma-separated values
  result = result.replace(/\.contextAny\([^)]+\)/g, '');
  
  // Remove window(...) - handles date ranges
  result = result.replace(/\.window\([^)]+\)/g, '');
  
  return result;
}

/**
 * Extract context constraints from an HRN.
 * 
 * @param hrn - HRN to parse
 * @returns Parsed context constraints or null if none
 */
export function extractContextsFromHRN(hrn: string): {
  contexts: Array<{key: string; value: string}>;
  contextAnys: Array<{ pairs: Array<{key: string; value: string}> }>;
  window: { start?: string; end?: string } | null;
} | null {
  // Extract the condition part (between edge/node ID and .p.)
  // Pattern: e.<id>.<conditions>.p.<field>
  const match = hrn.match(/^[en]\.([^.]+)\.((?:visited|visitedAny|context|contextAny|window|case|exclude)\([^)]+\)(?:\.(?:visited|visitedAny|context|contextAny|window|case|exclude)\([^)]+\))*)\.p\.(.+)$/);
  
  if (!match) {
    return null;
  }
  
  const conditionString = match[2];
  
  try {
    const parsed = parseConstraints(conditionString);
    return {
      contexts: parsed.context,
      contextAnys: parsed.contextAny,
      window: parsed.window
    };
  } catch (error) {
    console.error('[sheetsContextFallback] Failed to parse conditions:', conditionString, error);
    return null;
  }
}

/**
 * Check if an HRN contains context constraints.
 * 
 * @param hrn - HRN to check
 * @returns True if HRN has context constraints
 */
export function hasContextConstraints(hrn: string): boolean {
  return hrn.includes('.context(') || hrn.includes('.contextAny(') || hrn.includes('.window(');
}


