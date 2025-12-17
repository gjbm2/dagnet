/**
 * DSL Explosion Utilities
 * 
 * Proper recursive descent parsing for compound query expressions.
 * 
 * Equivalences (all produce same atomic slices):
 * - (a;b).c = c.(a;b) = or(a,b).c = or(a.c,b.c) = a.c;b.c
 * - a;b;c = or(a,b,c)
 * - or(a,or(b,c)) = a;b;c
 */

import { parseConstraints, normalizeConstraintString } from './queryDSL';
import { contextRegistry } from '../services/contextRegistry';

/**
 * Explode compound DSL into atomic slices.
 */
/**
 * Explode compound DSL into atomic slices.
 * 
 * Uses parseConstraints from queryDSL.ts for all atomic expressions.
 * This ensures one standard parser throughout the codebase.
 * 
 * @param dsl - Compound expression (may have ;, or(), parentheses)
 * @returns Array of atomic slice DSL strings (normalized)
 */
export async function explodeDSL(dsl: string): Promise<string[]> {
  if (!dsl || !dsl.trim()) return [];
  
  // Step 1: Parse into branches (handles ;, or(), distribution)
  const branches = parseExpression(dsl);
  
  // Step 2: Expand bare keys in each branch (Cartesian product)
  const expanded: string[] = [];
  for (const branch of branches) {
    const slices = await expandBareKeys(branch);
    expanded.push(...slices);
  }
  
  // Step 3: Normalize all slices (uses queryDSL.normalizeConstraintString)
  return expanded.map(s => normalizeConstraintString(s));
}

/**
 * Parse DSL string into expression tree.
 */
function parseExpression(dsl: string): string[] {
  const trimmed = dsl.trim();
  
  // Handle or(...).suffix
  const startsWithOr = (() => {
    if (!trimmed.startsWith('or')) return false;
    let j = 2;
    while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
    return trimmed[j] === '(';
  })();
  if (startsWithOr) {
    let openIndex = 2;
    while (openIndex < trimmed.length && /\s/.test(trimmed[openIndex])) openIndex++;
    const parenEnd = findMatchingParen(trimmed, openIndex);
    if (parenEnd === -1) {
      throw new Error(`Unbalanced parentheses in DSL near: ${trimmed}`);
    }
    const orPart = trimmed.substring(0, parenEnd + 1);
    const suffix = trimmed.substring(parenEnd + 1);
    
    const contents = extractFunctionContents(orPart, 'or');
    const parts = smartSplit(contents, ',');
    const branches: string[] = [];
    for (const part of parts) {
      const partBranches = parseExpression(part);
      // Apply suffix to each branch
      for (const branch of partBranches) {
        // Re-parse after suffix application so suffix expressions like `.or(...)` are handled.
        branches.push(...parseExpression(branch + suffix));
      }
    }
    return branches;
  }
  
  // Handle (...) - Check if outer parens match and can be stripped
  if (trimmed.startsWith('(') && !trimmed.startsWith('or(')) {
    const parenEnd = findMatchingParen(trimmed, 0);
    // If the matching paren is at the end, strip outer parens
    if (parenEnd === trimmed.length - 1) {
      const inner = trimmed.slice(1, -1);
      return parseExpression(inner);
    }
  }
  
  // Handle (...).suffix
  if (trimmed.startsWith('(') || trimmed.startsWith('or(')) {
    const parenEnd = findMatchingParen(trimmed, trimmed.indexOf('('));
    if (parenEnd < trimmed.length - 1 && trimmed[parenEnd + 1] === '.') {
      const prefix = trimmed.substring(0, parenEnd + 1);
      const suffix = trimmed.substring(parenEnd + 1);
      
      // Parse prefix, distribute suffix
      const prefixBranches = parseExpression(prefix);
      return prefixBranches.map(b => b + suffix);
    }
  }
  
  // Handle prefix.(...) 
  const dotParenIndex = (() => {
    let depth = 0;
    for (let i = 0; i < trimmed.length - 1; i++) {
      const ch = trimmed[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && trimmed.startsWith('.(', i)) return i;
    }
    return -1;
  })();
  if (dotParenIndex > 0) {
    const prefix = trimmed.substring(0, dotParenIndex);
    const rest = trimmed.substring(dotParenIndex + 1);
    
    const restBranches = parseExpression(rest);
    return restBranches.map(b => prefix + '.' + b);
  }

  // Handle prefix.or(...)
  // This is a common pattern in pinned DSLs: `or(cohort(...),window(...)).or(context(channel),context(geo))`
  // Semantics: distribute the OR branches as if written `prefix.(a;b)` / `or(prefix.a,prefix.b)`.
  //
  // Without this, the `.or(...)` remains as text and bare-key expansion can incorrectly
  // interpret `context(channel)` and `context(geo)` as simultaneous constraints (Cartesian product).
  const dotOrIndex = (() => {
    let depth = 0;
    for (let i = 0; i < trimmed.length - 4; i++) {
      const ch = trimmed[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth !== 0) continue;
      if (trimmed[i] !== '.') continue;
      // Allow optional whitespace between '.or' and '('
      const rest = trimmed.substring(i + 1);
      if (!rest.startsWith('or')) continue;
      let j = i + 1 + 2; // after 'or'
      while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
      if (trimmed[j] === '(') return i;
    }
    return -1;
  })();
  if (dotOrIndex > 0) {
    const prefix = trimmed.substring(0, dotOrIndex);
    const orStart = dotOrIndex + 1; // points at 'o' in 'or('
    const openParenIndex = trimmed.indexOf('(', orStart);
    const parenEnd = findMatchingParen(trimmed, openParenIndex);
    if (parenEnd === -1) {
      throw new Error(`Unbalanced parentheses in DSL near: ${trimmed.substring(orStart)}`);
    }
    const orPart = trimmed.substring(orStart, parenEnd + 1); // 'or(...)'
    const suffix = trimmed.substring(parenEnd + 1); // may be empty, or include further constraints

    const prefixBranches = parseExpression(prefix);
    const orBranches = parseExpression(orPart);

    const branches: string[] = [];
    for (const pb of prefixBranches) {
      for (const ob of orBranches) {
        branches.push(...parseExpression(`${pb}.${ob}${suffix}`));
      }
    }
    return branches;
  }
  
  // Handle semicolons at top level
  if (trimmed.includes(';')) {
    const parts = smartSplit(trimmed, ';');
    const branches: string[] = [];
    for (const part of parts) {
      branches.push(...parseExpression(part));
    }
    return branches;
  }
  
  // Atomic expression
  return [trimmed];
}

/**
 * Extract contents of function(...)
 */
function extractFunctionContents(str: string, funcName: string): string {
  const start = str.indexOf('(');
  if (start === -1) return '';
  
  const end = findMatchingParen(str, start);
  if (end === -1) {
    throw new Error(`Unbalanced parentheses in ${funcName}() expression: ${str}`);
  }
  return str.substring(start + 1, end);
}

/**
 * Find matching closing paren.
 */
function findMatchingParen(str: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split respecting parentheses.
 */
function smartSplit(str: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  
  for (const char of str) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === sep && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Expand bare context keys (Cartesian product).
 * Uses parseConstraints from queryDSL.ts to parse each atomic expression.
 */
async function expandBareKeys(clause: string): Promise<string[]> {
  const parsed = parseConstraints(clause);
  const bareKeys = parsed.context.filter(ctx => !ctx.value);
  
  if (bareKeys.length === 0) {
    return [clause];
  }
  
  // Load all values for bare keys
  const keyValues: Array<{ key: string; values: any[] }> = [];
  for (const bareKey of bareKeys) {
    const values = await contextRegistry.getValuesForContext(bareKey.key);
    keyValues.push({ key: bareKey.key, values });
  }
  
  // Cartesian product
  const combinations = cartesianProduct(keyValues);
  
  const expanded: string[] = [];
  for (const combo of combinations) {
    let expandedClause = clause;
    for (const { key, value } of combo) {
      expandedClause = expandedClause.replace(
        new RegExp(`context\\(${key}\\)`, 'g'),
        `context(${key}:${value.id})`
      );
    }
    expanded.push(expandedClause);
  }
  
  return expanded;
}

/**
 * Cartesian product.
 */
function cartesianProduct(keyValues: Array<{ key: string; values: any[] }>): Array<Array<{ key: string; value: any }>> {
  if (keyValues.length === 0) return [[]];
  
  const [first, ...rest] = keyValues;
  const restProduct = cartesianProduct(rest);
  
  const result: Array<Array<{ key: string; value: any }>> = [];
  for (const value of first.values) {
    for (const combo of restProduct) {
      result.push([{ key: first.key, value }, ...combo]);
    }
  }
  
  return result;
}

/**
 * Count atomic slices.
 */
export async function countAtomicSlices(dsl: string): Promise<number> {
  const slices = await explodeDSL(dsl);
  return slices.length;
}
