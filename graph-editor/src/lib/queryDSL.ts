/**
 * Query DSL Constants
 * 
 * Schema Authority: /public/schemas/query-dsl-1.0.0.json
 * 
 * This file defines constants derived from the schema.
 * ALL query DSL parsing, validation, and Monaco configuration MUST use these constants.
 */

/**
 * Valid query DSL function names.
 * 
 * MUST match schema: query-dsl-1.0.0.json → $defs.QueryFunctionName.enum
 */
export const QUERY_FUNCTIONS = [
  'from',
  'to', 
  'visited',
  'visitedAny',
  'exclude',
  'context',
  'case',
  'minus',
  'plus'
] as const;

export type QueryFunctionName = typeof QUERY_FUNCTIONS[number];

/**
 * Type guard for query function names.
 */
export function isQueryFunction(name: string): name is QueryFunctionName {
  return QUERY_FUNCTIONS.includes(name as QueryFunctionName);
}

/**
 * Parsed query structure matching schema.
 */
export interface ParsedQueryFunction {
  name: QueryFunctionName;
  args: string[];
}

export interface ParsedQuery {
  raw: string;
  functions: ParsedQueryFunction[];
}

/**
 * Basic query pattern for validation.
 * Must start with from() or to(), then have any number of functions.
 */
export const QUERY_PATTERN = /^(from|to)\([a-z0-9_-]+\)\.(from|to|visited|visitedAny|exclude|context|case|minus|plus)\([^)]*\)(\.(visited|visitedAny|exclude|context|case|minus|plus)\([^)]*\))*$/;

/**
 * Validate query string structure.
 * 
 * @param query - Query string to validate
 * @returns true if valid structure, false otherwise
 */
export function validateQueryStructure(query: string): boolean {
  if (!query || !query.trim()) return false;
  
  const cleanQuery = query.trim().replace(/^\.+|\.+$/g, '');
  if (!cleanQuery) return false;
  
  // Must have from() and to()
  if (!cleanQuery.includes('from(') || !cleanQuery.includes('to(')) {
    return false;
  }
  
  // Check all function names are valid
  const functionPattern = /\b([a-z_-]+)\s*\(/g;
  let match;
  while ((match = functionPattern.exec(cleanQuery)) !== null) {
    if (!isQueryFunction(match[1])) {
      return false;
    }
  }
  
  return true;
}

/**
 * Parse query string into structured format (basic implementation).
 * 
 * For full parsing with validation, use the Python backend.
 */
export function parseQueryBasic(query: string): ParsedQuery | null {
  if (!validateQueryStructure(query)) return null;
  
  const functions: ParsedQueryFunction[] = [];
  const functionRegex = /(from|to|visited|visitedAny|exclude|context|case)\(([^)]+)\)/g;
  
  let match;
  while ((match = functionRegex.exec(query)) !== null) {
    const name = match[1] as QueryFunctionName;
    const argsStr = match[2];
    const args = argsStr.split(',').map(s => s.trim()).filter(s => s);
    
    functions.push({ name, args });
  }
  
  return {
    raw: query,
    functions
  };
}

