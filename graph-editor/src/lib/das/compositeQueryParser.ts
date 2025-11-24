/**
 * Composite Query Parser for Inclusion-Exclusion
 * 
 * Parses DSL queries with minus() and plus() operators for subtractive funnel logic.
 * 
 * Note: This parser handles minus/plus operators. For context/window constraints,
 * it delegates to parseConstraints() from queryDSL.ts (single source of truth).
 */

import { parseConstraints } from '../queryDSL';

export interface ParsedFunnel {
  from: string;
  to: string;
  visited?: string[];
  visitedAny?: string[][];
}

export interface ParsedCompositeQuery {
  base: ParsedFunnel;
  minusTerms: string[][];  // Array of node sets (each inherits base from/to)
  plusTerms: string[][];   // Array of node sets (each inherits base from/to)
}

export interface CompositeQueryTerm {
  funnel: ParsedFunnel;  // Includes from/to from base + visited from term
  coefficient: number;   // +1 for base/plus, -1 for minus
  id: string;
}

/**
 * Parse a DSL query string that may contain minus() and plus() operators.
 * 
 * Examples:
 *   "from(a).to(b)" → { base: {from:'a', to:'b'}, minusTerms: [], plusTerms: [] }
 *   "from(a).to(c).minus(from(a).to(c).visited(d))" → { base, minusTerms: [visited(d)], plusTerms: [] }
 */
export function parseCompositeQuery(dslString: string): ParsedCompositeQuery {
  // Extract minus and plus terms
  const { base, minusStrings, plusStrings } = extractTerms(dslString);
  
  // Parse base funnel
  const baseFunnel = parseSingleFunnel(base);
  
  // Parse each minus/plus term (now just node lists)
  const minusTerms = minusStrings.map(parseNodeList);
  const plusTerms = plusStrings.map(parseNodeList);
  
  return { base: baseFunnel, minusTerms, plusTerms };
}

/**
 * Extract base funnel and minus/plus node lists from a composite query.
 */
function extractTerms(dsl: string): {
  base: string;
  minusStrings: string[];
  plusStrings: string[];
} {
  // Match .minus(node-list) and .plus(node-list)
  // Compact form: just comma-separated nodes, no from/to/visited wrappers
  // ALLOW UPPERCASE LETTERS in event IDs
  const minusRegex = /\.minus\(([a-zA-Z0-9_,-]+)\)/g;
  const plusRegex = /\.plus\(([a-zA-Z0-9_,-]+)\)/g;
  
  const minusStrings: string[] = [];
  const plusStrings: string[] = [];
  
  let match;
  
  // Extract all minus terms
  while ((match = minusRegex.exec(dsl)) !== null) {
    minusStrings.push(match[1]);
  }
  
  // Extract all plus terms  
  while ((match = plusRegex.exec(dsl)) !== null) {
    plusStrings.push(match[1]);
  }
  
  // Remove all minus/plus to get base
  const base = dsl
    .replace(minusRegex, '')
    .replace(plusRegex, '')
    .replace(/\.+$/, '');  // Clean trailing dots
  
  return { base, minusStrings, plusStrings };
}

/**
 * Parse a single funnel expression (from...to...visited...).
 */
function parseSingleFunnel(funnelStr: string): ParsedFunnel {
  // Extract from() and to() - ALLOW UPPERCASE LETTERS in event IDs
  const fromMatch = funnelStr.match(/from\(([a-zA-Z0-9_-]+)\)/);
  const toMatch = funnelStr.match(/to\(([a-zA-Z0-9_-]+)\)/);
  
  if (!fromMatch || !toMatch) {
    throw new Error(`Invalid funnel syntax: ${funnelStr}`);
  }
  
  // Extract visited() nodes - ALLOW UPPERCASE LETTERS in event IDs
  const visitedMatches = [...funnelStr.matchAll(/visited\(([a-zA-Z0-9_-]+)\)/g)];
  const visited = visitedMatches.map(m => m[1]);
  
  // Extract visitedAny() groups
  const visitedAnyMatches = [...funnelStr.matchAll(/visitedAny\(\[?([^\]]+)\]?\)/g)];
  const visitedAny = visitedAnyMatches.map(m => 
    m[1].split(',').map(s => s.trim())
  );
  
  return {
    from: fromMatch[1],
    to: toMatch[1],
    visited: visited.length > 0 ? visited : undefined,
    visitedAny: visitedAny.length > 0 ? visitedAny : undefined
  };
}

/**
 * Parse a node list from minus/plus term (comma-separated node IDs).
 */
function parseNodeList(nodeListStr: string): string[] {
  return nodeListStr.split(',').map(s => s.trim()).filter(s => s);
}

/**
 * Convert a parsed composite query into execution terms with coefficients.
 * 
 * Minus/plus node sets inherit from/to from the base funnel.
 * 
 * Returns array of terms in execution order:
 * - Base funnel (coefficient +1)
 * - Minus terms (coefficient -1, with visited nodes)
 * - Plus terms (coefficient +1, with visited nodes)
 */
export function getExecutionTerms(parsed: ParsedCompositeQuery): CompositeQueryTerm[] {
  const terms: CompositeQueryTerm[] = [];
  
  // Base term (always first, coefficient +1)
  terms.push({
    funnel: parsed.base,
    coefficient: +1,
    id: 'base'
  });
  
  // Minus terms (coefficient -1)
  // Inherit from/to from base, add visited nodes from the minus clause
  parsed.minusTerms.forEach((nodeSet, idx) => {
    terms.push({
      funnel: {
        from: parsed.base.from,
        to: parsed.base.to,
        visited: nodeSet
      },
      coefficient: -1,
      id: `minus_${idx}`
    });
  });
  
  // Plus terms (coefficient +1)
  // Inherit from/to from base, add visited nodes from the plus clause
  parsed.plusTerms.forEach((nodeSet, idx) => {
    terms.push({
      funnel: {
        from: parsed.base.from,
        to: parsed.base.to,
        visited: nodeSet
      },
      coefficient: +1,
      id: `plus_${idx}`
    });
  });
  
  return terms;
}

/**
 * Check if a query string contains composite operators (minus/plus).
 */
export function isCompositeQuery(dslString: string): boolean {
  return /\.(minus|plus)\(/.test(dslString);
}

