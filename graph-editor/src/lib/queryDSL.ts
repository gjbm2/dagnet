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
 * Parsed constraint components (shared by queries and conditions).
 * Used for constraint-only DSL strings (no from/to required).
 */
export interface ParsedConstraints {
  visited: string[];
  exclude: string[];
  context: Array<{key: string; value: string}>;
  cases: Array<{key: string; value: string}>;
  visitedAny: string[][];
}

/**
 * Parsed full query (extends constraints with from/to).
 * Used for complete query DSL strings.
 */
export interface ParsedFullQuery extends ParsedConstraints {
  from?: string;
  to?: string;
  raw: string;
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

/**
 * Parse constraint-only DSL (no from/to required).
 * Used for conditional probability conditions.
 * 
 * Note: minus() and plus() are excluded from constraints - they are query-only functions.
 * 
 * @param constraint - Constraint string (e.g., "visited(a,b).exclude(c)")
 * @returns Parsed constraints
 */
export function parseConstraints(constraint: string | null | undefined): ParsedConstraints {
  if (!constraint || typeof constraint !== 'string') {
    return {
      visited: [],
      exclude: [],
      context: [],
      cases: [],
      visitedAny: []
    };
  }
  
  // Extract all constraint types using regex (similar to Python _parse_condition)
  const visited: string[] = [];
  const exclude: string[] = [];
  const context: Array<{key: string; value: string}> = [];
  const cases: Array<{key: string; value: string}> = [];
  const visitedAny: string[][] = [];
  
  // Match visited(...) - can appear multiple times
  const visitedMatches = constraint.matchAll(/visited\(([^)]+)\)/g);
  for (const match of visitedMatches) {
    const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
    visited.push(...nodes);
  }
  
  // Match exclude(...)
  const excludeMatches = constraint.matchAll(/exclude\(([^)]+)\)/g);
  for (const match of excludeMatches) {
    const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
    exclude.push(...nodes);
  }
  
  // Match context(key:value)
  const contextMatches = constraint.matchAll(/context\(([^:]+):([^)]+)\)/g);
  for (const match of contextMatches) {
    context.push({ key: match[1].trim(), value: match[2].trim() });
  }
  
  // Match case(key:value)
  const caseMatches = constraint.matchAll(/case\(([^:]+):([^)]+)\)/g);
  for (const match of caseMatches) {
    cases.push({ key: match[1].trim(), value: match[2].trim() });
  }
  
  // Match visitedAny(...)
  const visitedAnyMatches = constraint.matchAll(/visitedAny\(([^)]+)\)/g);
  for (const match of visitedAnyMatches) {
    const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
    if (nodes.length > 0) {
      // Deduplicate within group
      const seen = new Set<string>();
      const group: string[] = [];
      for (const node of nodes) {
        if (!seen.has(node)) {
          seen.add(node);
          group.push(node);
        }
      }
      if (group.length > 0) {
        visitedAny.push(group);
      }
    }
  }
  
  // Deduplicate visited/exclude preserving order
  const visitedDeduped: string[] = [];
  const visitedSeen = new Set<string>();
  for (const node of visited) {
    if (!visitedSeen.has(node)) {
      visitedSeen.add(node);
      visitedDeduped.push(node);
    }
  }
  
  const excludeDeduped: string[] = [];
  const excludeSeen = new Set<string>();
  for (const node of exclude) {
    if (!excludeSeen.has(node)) {
      excludeSeen.add(node);
      excludeDeduped.push(node);
    }
  }
  
  // Deduplicate context/cases (by key-value pair)
  const contextDeduped: Array<{key: string; value: string}> = [];
  const contextSeen = new Set<string>();
  for (const kv of context) {
    const key = `${kv.key}:${kv.value}`;
    if (!contextSeen.has(key)) {
      contextSeen.add(key);
      contextDeduped.push(kv);
    }
  }
  
  const casesDeduped: Array<{key: string; value: string}> = [];
  const casesSeen = new Set<string>();
  for (const kv of cases) {
    const key = `${kv.key}:${kv.value}`;
    if (!casesSeen.has(key)) {
      casesSeen.add(key);
      casesDeduped.push(kv);
    }
  }
  
  return {
    visited: visitedDeduped,
    exclude: excludeDeduped,
    context: contextDeduped,
    cases: casesDeduped,
    visitedAny
  };
}

/**
 * Parse any DSL string (full query OR constraint-only).
 * 
 * @param dsl - DSL string (e.g., "from(a).to(b).visited(c)" or "visited(c).exclude(d)")
 * @returns Parsed structure with all components
 */
export function parseDSL(dsl: string | null | undefined): ParsedFullQuery {
  if (!dsl || typeof dsl !== 'string') {
    return {
      visited: [],
      exclude: [],
      context: [],
      cases: [],
      visitedAny: [],
      raw: ''
    };
  }
  
  // Extract from/to (may not exist for constraint-only)
  const fromMatch = dsl.match(/from\(([^)]+)\)/);
  const toMatch = dsl.match(/to\(([^)]+)\)/);
  
  // Extract constraints (works for both full queries and conditions)
  const constraints = parseConstraints(dsl);
  
  return {
    ...constraints,
    from: fromMatch?.[1],
    to: toMatch?.[1],
    raw: dsl
  };
}

/**
 * Convenience function: Extract visited node IDs from DSL string.
 * Works for both full queries and constraint-only conditions.
 * 
 * @param dsl - DSL string (e.g., "from(a).to(b).visited(c)" or "visited(c)")
 * @returns Array of visited node IDs
 */
export function getVisitedNodeIds(dsl: string | null | undefined): string[] {
  return parseDSL(dsl).visited;
}

/**
 * Evaluate if a constraint DSL is satisfied given runtime state.
 * 
 * @param constraint - Constraint string (e.g., "visited(a).exclude(b)")
 * @param visitedNodes - Set of visited node IDs
 * @param context - Optional context key-value pairs
 * @param caseVariants - Optional case variant key-value pairs
 * @returns true if constraint is satisfied
 */
export function evaluateConstraint(
  constraint: string,
  visitedNodes: Set<string>,
  context?: Record<string, string>,
  caseVariants?: Record<string, string>
): boolean {
  const parsed = parseConstraints(constraint);
  
  // Check visited nodes (all must be in visitedNodes)
  if (parsed.visited.length > 0) {
    const allVisited = parsed.visited.every(nodeId => visitedNodes.has(nodeId));
    if (!allVisited) return false;
  }
  
  // Check exclude nodes (none should be in visitedNodes)
  if (parsed.exclude.length > 0) {
    const anyExcluded = parsed.exclude.some(nodeId => visitedNodes.has(nodeId));
    if (anyExcluded) return false;
  }
  
  // Check visitedAny (at least one group must have at least one visited node)
  if (parsed.visitedAny.length > 0) {
    const anyGroupSatisfied = parsed.visitedAny.some(group => 
      group.some(nodeId => visitedNodes.has(nodeId))
    );
    if (!anyGroupSatisfied) return false;
  }
  
  // Check context (all must match)
  if (parsed.context.length > 0 && context) {
    const allContextMatch = parsed.context.every(({key, value}) => 
      context[key] === value
    );
    if (!allContextMatch) return false;
  }
  
  // Check cases (all must match)
  if (parsed.cases.length > 0 && caseVariants) {
    const allCasesMatch = parsed.cases.every(({key, value}) => 
      caseVariants[key] === value
    );
    if (!allCasesMatch) return false;
  }
  
  return true;
}

/**
 * Normalize a constraint string (sort nodes, canonicalize).
 * Useful for comparison and deduplication.
 * 
 * @param constraint - Constraint string to normalize
 * @returns Normalized constraint string
 */
export function normalizeConstraintString(constraint: string): string {
  const parsed = parseConstraints(constraint);
  const parts: string[] = [];
  
  if (parsed.visited.length > 0) {
    parts.push(`visited(${parsed.visited.sort().join(', ')})`);
  }
  if (parsed.exclude.length > 0) {
    parts.push(`exclude(${parsed.exclude.sort().join(', ')})`);
  }
  if (parsed.context.length > 0) {
    const contextParts = parsed.context
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({key, value}) => `context(${key}:${value})`);
    parts.push(...contextParts);
  }
  if (parsed.cases.length > 0) {
    const caseParts = parsed.cases
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({key, value}) => `case(${key}:${value})`);
    parts.push(...caseParts);
  }
  if (parsed.visitedAny.length > 0) {
    const visitedAnyParts = parsed.visitedAny.map(group =>
      `visitedAny(${group.sort().join(', ')})`
    );
    parts.push(...visitedAnyParts);
  }
  
  return parts.join('.');
}

