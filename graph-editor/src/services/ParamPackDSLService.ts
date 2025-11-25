/**
 * ParamPackDSLService
 *
 * Canonical engine for:
 * - Converting between param packs and ScenarioParams
 * - Parsing HRN-style flat keys (e./n. prefixes) into structured params
 * - Applying graph-aware scoping to ScenarioParams diffs
 *
 * Historically this logic lived in `ScenarioFormatConverter`; it has been
 * generalized and renamed here for use by both scenarios and external
 * ingestion flows (e.g. Sheets).
 */

import * as yaml from 'js-yaml';
import { ScenarioParams } from '../types/scenarios';
import type { Graph } from '../types';
import { resolveAllHRNs, resolveConditionalHRN, resolveEdgeHRN, resolveNodeHRN } from './HRNResolver';

/**
 * Convert scenario params to YAML
 * Both flat and nested use HRN notation (e., n. prefixes)
 * Difference is only in layout/repetition
 */
export function toYAML(params: ScenarioParams, structure: 'nested' | 'flat' = 'flat'): string {
  const flat = flattenParams(params);
  
  if (structure === 'flat') {
    // Fully flat: every line has complete path
    return yaml.dump(flat, { 
      indent: 2, 
      lineWidth: 120,
      noRefs: true 
    });
  } else {
    // Nested: strategic indentation to reduce repetition
    return formatNestedHRN(flat);
  }
}

/**
 * Convert scenario params to JSON
 * Both flat and nested use HRN notation (e., n. prefixes)
 * Difference is only in layout/repetition
 */
export function toJSON(params: ScenarioParams, structure: 'nested' | 'flat' = 'flat'): string {
  const flat = flattenParams(params);
  
  if (structure === 'flat') {
    // Fully flat: every line has complete path
    return JSON.stringify(flat, null, 2);
  } else {
    // For JSON, nested format is same as flat (JSON doesn't support strategic indentation)
    return JSON.stringify(flat, null, 2);
  }
}

/**
 * Convert scenario params to CSV (flat format only)
 * Two-column format: key, value
 */
export function toCSV(params: ScenarioParams): string {
  const flat = flattenParams(params);
  const rows: string[] = ['key,value'];
  
  for (const [key, value] of Object.entries(flat)) {
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Escape commas and quotes in CSV
    const escapedValue = valueStr.includes(',') || valueStr.includes('"')
      ? `"${valueStr.replace(/"/g, '""')}"`
      : valueStr;
    rows.push(`${key},${escapedValue}`);
  }
  
  return rows.join('\n');
}

/**
 * Format flat HRN keys into minimally repetitious nested structure
 * Groups keys by common prefixes and uses indentation to show hierarchy
 */
function formatNestedHRN(flat: Record<string, any>): string {
  const lines: string[] = [];
  const sortedKeys = Object.keys(flat).sort();
  
  // Group by top-level prefix (e or n)
  const edgeKeys = sortedKeys.filter(k => k.startsWith('e.'));
  const nodeKeys = sortedKeys.filter(k => k.startsWith('n.'));
  
  if (edgeKeys.length > 0) {
    lines.push('e:');
    formatGroup(edgeKeys, flat, 'e', lines);
  }
  
  if (nodeKeys.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('n:');
    formatGroup(nodeKeys, flat, 'n', lines);
  }
  
  return lines.join('\n');
}

/**
 * Format a group of keys with common prefix, using strategic indentation
 */
function formatGroup(keys: string[], values: Record<string, any>, prefix: string, lines: string[]) {
  // Remove the prefix and initial dot from all keys
  const strippedKeys = keys.map(k => k.substring(prefix.length));
  
  // Group by first segment (edgeId or nodeId)
  const grouped: Record<string, string[]> = {};
  for (let i = 0; i < strippedKeys.length; i++) {
    const stripped = strippedKeys[i];
    const firstDot = stripped.indexOf('.', 1); // Skip leading dot
    const entityId = firstDot > 0 ? stripped.substring(0, firstDot) : stripped;
    
    if (!grouped[entityId]) {
      grouped[entityId] = [];
    }
    grouped[entityId].push(keys[i]);
  }
  
  // Format each entity group
  for (const [entityId, entityKeys] of Object.entries(grouped)) {
    if (entityKeys.length === 1) {
      // Single key: put on one line
      const key = entityKeys[0];
      const suffix = key.substring(prefix.length);
      // Strip leading dot for cleaner YAML (dot is just visual formatting)
      const cleanSuffix = suffix.startsWith('.') ? suffix.slice(1) : suffix;
      lines.push(`  ${cleanSuffix}: ${formatValue(values[key])}`);
    } else {
      // Multiple keys: use sub-indentation
      // Strip leading dot for cleaner YAML (dot is just visual formatting)
      const cleanEntityId = entityId.startsWith('.') ? entityId.slice(1) : entityId;
      lines.push(`  ${cleanEntityId}`);
      const commonPrefix = prefix + entityId;
      
      for (const key of entityKeys) {
        const suffix = key.substring(commonPrefix.length);
        // Strip leading dot for cleaner YAML (dot is just visual formatting)
        const cleanSuffix = suffix.startsWith('.') ? suffix.slice(1) : suffix;
        lines.push(`    ${cleanSuffix}: ${formatValue(values[key])}`);
      }
    }
  }
}

/**
 * Format a value for YAML output
 */
function formatValue(value: any): string {
  if (typeof value === 'string') {
    // Quote strings that need it
    if (value.includes(':') || value.includes('#') || value.includes('\n')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  // For objects/arrays, use JSON
  return JSON.stringify(value);
}

/**
 * Parse YAML content to scenario params
 * Both nested and flat formats use HRN notation and parse to flat key/value
 */
export function fromYAML(
  content: string,
  structure: 'nested' | 'flat' = 'flat',
  graph?: Graph | null
): ScenarioParams {
  let parsed: any;
  try {
    // Trim content and remove any leading/trailing whitespace
    const trimmedContent = content.trim();
    parsed = yaml.load(trimmedContent) as any;
  } catch (err: any) {
    throw new Error(`Failed to parse YAML: ${err.message || err}`);
  }
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML: must be an object');
  }
  
  // Both formats parse to flat HRN keys, then go through the canonical
  // flat-HRN → ScenarioParams engine. If a graph is provided, HRNs are
  // resolved to canonical IDs/UUIDs as part of this step.
  const flat = structure === 'nested' ? parseNestedHRN(parsed) : parsed;
  const { params } = parseFlatHRNToParams(flat as Record<string, any>, graph);
  return params;
}

/**
 * Parse JSON content to scenario params
 * Both nested and flat formats use HRN notation and parse to flat key/value
 */
export function fromJSON(
  content: string,
  structure: 'nested' | 'flat' = 'flat',
  graph?: Graph | null
): ScenarioParams {
  const parsed = JSON.parse(content);
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON: must be an object');
  }
  
  // Both formats parse to flat HRN keys, then go through the canonical
  // flat-HRN → ScenarioParams engine. If a graph is provided, HRNs are
  // resolved to canonical IDs/UUIDs as part of this step.
  const flat = structure === 'nested' ? parseNestedHRN(parsed) : parsed;
  const { params } = parseFlatHRNToParams(flat as Record<string, any>, graph);
  return params;
}

/**
 * Parse nested HRN structure back to flat key/value pairs
 * Handles the minimally repetitious format with indentation
 */
function parseNestedHRN(nested: any): Record<string, any> {
  const flat: Record<string, any> = {};
  
  // Handle top-level 'e' and 'n' keys
  if (nested.e) {
    parseEntityGroup(nested.e, 'e', flat);
  }
  if (nested.n) {
    parseEntityGroup(nested.n, 'n', flat);
  }
  
  return flat;
}

/**
 * Parse an entity group (edges or nodes) back to flat keys
 */
function parseEntityGroup(group: any, prefix: string, result: Record<string, any>) {
  if (typeof group !== 'object' || group === null) return;
  
  for (const [key, value] of Object.entries(group)) {
    // Strip leading dot if present (visual formatting in nested mode)
    const cleanKey = key.startsWith('.') ? key.slice(1) : key;
    
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested object: expand all sub-keys
      for (const [subKey, subValue] of Object.entries(value)) {
        const cleanSubKey = subKey.startsWith('.') ? subKey.slice(1) : subKey;
        const fullKey = `${prefix}.${cleanKey}.${cleanSubKey}`;
        if (typeof subValue === 'object' && subValue !== null && !Array.isArray(subValue)) {
          // Recursively flatten deeper nesting
          flattenDeep(subValue, fullKey, result);
        } else {
          result[fullKey] = subValue;
        }
      }
    } else {
      // Scalar value: key is complete
      result[`${prefix}.${cleanKey}`] = value;
    }
  }
}

/**
 * Recursively flatten deep nested structures
 */
function flattenDeep(obj: any, prefix: string, result: Record<string, any>) {
  for (const [key, value] of Object.entries(obj)) {
    // Strip leading dot if present (visual formatting in nested mode)
    const cleanKey = key.startsWith('.') ? key.slice(1) : key;
    const fullKey = `${prefix}.${cleanKey}`;
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      flattenDeep(value, fullKey, result);
    } else {
      result[fullKey] = value;
    }
  }
}

/**
 * Flatten nested params to HRN dot-notation keys per spec
 * 
 * Canonical DSL format:
 * - Base probability: e.<edgeId>.p.<field>
 * - Conditional probability: e.<edgeId>.<condition>.p.<field>
 * - Edge costs: e.<edgeId>.cost_gbp.<field>, e.<edgeId>.cost_time.<field>
 * - Case variants: n.<nodeId>.case(<caseId>:<variantName>).weight
 * 
 * Note: conditional_p uses the condition string directly in the path (no "conditional_p" segment).
 * This matches the format used in Apps Script (dagCalc) and conditionalReferences.ts.
 * 
 * Example:
 *   { edges: { 'edge-1': { p: { mean: 0.5 }, conditional_p: { 'visited(promo)': { mean: 0.7 } } } } }
 * →
 *   { 'e.edge-1.p.mean': 0.5, 'e.edge-1.visited(promo).p.mean': 0.7 }
 */
export function flattenParams(params: ScenarioParams): Record<string, any> {
  const flat: Record<string, any> = {};
  
  // Flatten edges with 'e.' prefix
  if (params.edges) {
    for (const [edgeId, edgeParams] of Object.entries(params.edges)) {
      // Handle conditional_p specially: e.<edgeId>.<condition>.p.<field>
      if (edgeParams.conditional_p) {
        for (const [condition, condValue] of Object.entries(edgeParams.conditional_p)) {
          if (condValue && typeof condValue === 'object') {
            for (const [field, value] of Object.entries(condValue)) {
              flat[`e.${edgeId}.${condition}.p.${field}`] = value;
            }
          }
        }
      }
      
      // Flatten other edge params (p, cost_gbp, cost_time, weight_default)
      const { conditional_p, ...otherParams } = edgeParams;
      flattenObject(otherParams, `e.${edgeId}`, flat);
    }
  }
  
  // Flatten nodes with 'n.' prefix
  if (params.nodes) {
    for (const [nodeId, nodeParams] of Object.entries(params.nodes)) {
      // Special handling for case variants
      if (nodeParams.case?.variants) {
        // Extract case ID from node structure (assume it's the nodeId for now)
        const caseId = nodeId;
        for (const variant of nodeParams.case.variants) {
          const variantName = variant.name;
          flat[`n.${nodeId}.case(${caseId}:${variantName}).weight`] = variant.weight;
        }
        // Flatten rest of node params excluding case.variants
        const { case: caseData, ...restParams } = nodeParams;
        const { variants, ...restCase } = caseData || {};
        if (Object.keys(restCase).length > 0) {
          flattenObject({ case: restCase }, `n.${nodeId}`, flat);
        }
        flattenObject(restParams, `n.${nodeId}`, flat);
      } else {
        flattenObject(nodeParams, `n.${nodeId}`, flat);
      }
    }
  }
  
  return flat;
}

/**
 * Helper: Recursively flatten an object into dot-notation keys
 */
function flattenObject(obj: any, prefix: string, result: Record<string, any>) {
  for (const [key, value] of Object.entries(obj)) {
    const newKey = `${prefix}.${key}`;
    
    if (value === null || value === undefined) {
      result[newKey] = value;
    } else if (Array.isArray(value)) {
      // Arrays other than case.variants: keep as-is (edge case)
      result[newKey] = value;
    } else if (typeof value === 'object') {
      flattenObject(value, newKey, result);
    } else {
      result[newKey] = value;
    }
  }
}

/**
 * Unflatten HRN dot-notation keys to nested structure per spec
 * 
 * Canonical DSL format:
 * - Base probability: e.<edgeId>.p.<field> → edges[edgeId].p[field]
 * - Conditional: e.<edgeId>.<condition>.p.<field> → edges[edgeId].conditional_p[condition][field]
 * - Edge costs: e.<edgeId>.cost_gbp.<field> → edges[edgeId].cost_gbp[field]
 * - Case variants: n.<nodeId>.case(<caseId>:<variantName>).weight → nodes[nodeId].case.variants[...]
 * 
 * The key challenge: distinguishing between:
 * - e.<edgeId>.p.<field> (base probability)
 * - e.<edgeId>.<condition>.p.<field> (conditional probability)
 * 
 * We detect conditionals by checking if the segment before ".p." matches a condition pattern
 * (contains constraint keywords: visited, context, case, exclude).
 * 
 * Example:
 *   { 'e.edge-1.p.mean': 0.5, 'e.edge-1.visited(promo).p.mean': 0.7 }
 * →
 *   { edges: { 'edge-1': { p: { mean: 0.5 }, conditional_p: { 'visited(promo)': { mean: 0.7 } } } } }
 */
export function unflattenParams(flat: Record<string, any>): ScenarioParams {
  const params: ScenarioParams = {
    edges: {},
    nodes: {}
  };
  
  for (const [key, value] of Object.entries(flat)) {
    // Check for case variant format: n.<nodeId>.case(<caseId>:<variantName>).weight
    const caseMatch = key.match(/^n\.([^.]+)\.case\(([^:]+):([^)]+)\)\.weight$/);
    if (caseMatch) {
      const [, nodeId, , variantName] = caseMatch;
      
      if (!params.nodes![nodeId]) {
        params.nodes![nodeId] = {};
      }
      if (!params.nodes![nodeId].case) {
        params.nodes![nodeId].case = { variants: [] };
      }
      
      // Add or update variant
      const variants = params.nodes![nodeId].case!.variants!;
      const existing = variants.find(v => v.name === variantName);
      if (existing) {
        existing.weight = value;
      } else {
        variants.push({ name: variantName, weight: value });
      }
      continue;
    }
    
    // Check for conditional probability format: e.<edgeId>.<condition>.p.<field>
    // Condition patterns contain: visited(, context(, contextAny(, window(, case(, exclude(
    const conditionalMatch = key.match(/^e\.([^.]+)\.((?:visited|visitedAny|context|contextAny|window|case|exclude)\([^)]+\)(?:\.(?:visited|visitedAny|context|contextAny|window|case|exclude)\([^)]+\))*)\.p\.(.+)$/);
    if (conditionalMatch) {
      const [, edgeId, condition, field] = conditionalMatch;
      
      if (!params.edges![edgeId]) {
        params.edges![edgeId] = {};
      }
      if (!params.edges![edgeId].conditional_p) {
        params.edges![edgeId].conditional_p = {};
      }
      if (!params.edges![edgeId].conditional_p![condition]) {
        params.edges![edgeId].conditional_p![condition] = {};
      }
      
      // Set the field value
      setNestedValue(params.edges![edgeId].conditional_p![condition], field.split('.'), value);
      continue;
    }
    
    // Check for edge format: e.<edgeId>.<path>
    if (key.startsWith('e.')) {
      const parts = key.substring(2).split('.');
      const edgeId = parts[0];
      const path = parts.slice(1);
      
      if (!params.edges![edgeId]) {
        params.edges![edgeId] = {};
      }
      
      setNestedValue(params.edges![edgeId], path, value);
      continue;
    }
    
    // Check for node format: n.<nodeId>.<path>
    if (key.startsWith('n.')) {
      const parts = key.substring(2).split('.');
      const nodeId = parts[0];
      const path = parts.slice(1);
      
      if (!params.nodes![nodeId]) {
        params.nodes![nodeId] = {};
      }
      
      setNestedValue(params.nodes![nodeId], path, value);
      continue;
    }
    
    // Legacy format without e./n. prefix (fallback)
    console.warn(`Unrecognized flat key format: ${key} (expected e. or n. prefix)`);
  }
  
  return params;
}

/**
 * Canonical entrypoint for converting a flat HRN map into ScenarioParams,
 * including graph-aware HRN resolution when a graph is provided.
 *
 * Responsibilities:
 * - HRN → graph ID/UUID resolution for edges and nodes (via HRNResolver)
 * - Normalization of conditional_p condition keys (visited(node-id) → visited(node-uuid))
 * - Structural parsing of flat HRN keys → ScenarioParams shape
 *
 * The key insight: HRN resolution must happen BEFORE structural parsing (unflattenParams),
 * because unflattenParams does naive dot-splitting which breaks HRNs like "from(a).to(b)".
 * So we:
 * 1. Resolve HRN entity identifiers in the flat keys themselves (rewrite keys)
 * 2. Normalize conditional keys within those rewritten keys
 * 3. Then unflatten the now-UUID-based flat map
 *
 * NOTE: When no graph is provided, this function still performs structural
 * parsing but skips HRN resolution and conditional normalization.
 */
export interface HRNParseResult {
  params: ScenarioParams;
  unresolvedHRNs: string[];
}

export function parseFlatHRNToParams(
  flat: Record<string, any>,
  graph?: Graph | null
): HRNParseResult {
  if (!graph) {
    // No graph: we cannot resolve HRNs, so return structural params only.
    const struct = unflattenParams(flat);
    return { params: struct, unresolvedHRNs: [] };
  }

  // 1) Resolve HRNs in the flat keys themselves, producing a new flat map
  //    with entity identifiers rewritten to UUIDs or canonical IDs.
  const resolvedFlat: Record<string, any> = {};
  const unresolvedHRNs: string[] = [];

  for (const [key, value] of Object.entries(flat)) {
    const resolvedKey = resolveFlatKey(key, graph, unresolvedHRNs);
    resolvedFlat[resolvedKey] = value;
  }

  // 2) Now unflatten the resolved keys (which are now UUID-based and safe to split)
  const params = unflattenParams(resolvedFlat);

  return {
    params,
    unresolvedHRNs,
  };
}

/**
 * Resolve and validate HRNs within a flat key.
 * 
 * Strategy:
 * - If entity is a simple ID that exists, keep it (e.g., "checkout-to-purchase" stays as-is)
 * - If entity is an HRN like from().to(), resolve to the edge's ID (prefer ID over UUID)
 * - Normalize condition node references (visited(promo) → visited(promo) but validate it exists)
 * 
 * Examples:
 * - "e.checkout-to-purchase.p.mean" → "e.checkout-to-purchase.p.mean" (ID exists, kept)
 * - "e.from(checkout).to(purchase).p.mean" → "e.checkout-to-purchase.p.mean" (resolved to ID)
 * - "e.edge-id.visited(promo).p.mean" → "e.edge-id.visited(promo).p.mean" (condition validated)
 */
function resolveFlatKey(
  key: string,
  graph: Graph,
  unresolvedHRNs: string[]
): string {
  // Edge keys: e.<edgeHRN>.<rest>
  if (key.startsWith('e.')) {
    const rest = key.substring(2); // Remove "e."
    
    const { entityPart, pathPart } = extractEntityAndPath(rest);
    
    // Resolve to validate and get UUID
    const resolvedUuid = resolveEdgeHRN(entityPart, graph);
    if (!resolvedUuid) {
      unresolvedHRNs.push(`edges.${entityPart}`);
      return key; // Keep original if invalid
    }
    
    // Get the edge and prefer ID
    const edge = graph.edges?.find(e => e.uuid === resolvedUuid);
    const canonicalId = edge?.id || resolvedUuid;
    
    // Normalize condition strings in the path
    const normalizedPath = normalizeConditionalInPath(pathPart, graph, unresolvedHRNs);
    
    return `e.${canonicalId}${normalizedPath}`;
  }

  // Node keys: n.<nodeHRN>.<rest>
  if (key.startsWith('n.')) {
    const rest = key.substring(2); // Remove "n."
    
    const { entityPart, pathPart } = extractEntityAndPath(rest);
    
    // Resolve to validate and get UUID
    const resolvedUuid = resolveNodeHRN(entityPart, graph);
    if (!resolvedUuid) {
      unresolvedHRNs.push(`nodes.${entityPart}`);
      return key;
    }
    
    // Get the node and prefer ID
    const node = graph.nodes?.find(n => n.uuid === resolvedUuid);
    const canonicalId = node?.id || resolvedUuid;
    
    // Normalize condition strings in the path
    const normalizedPath = normalizeConditionalInPath(pathPart, graph, unresolvedHRNs);
    
    return `n.${canonicalId}${normalizedPath}`;
  }

  // Not an HRN key; return as-is
  return key;
}

/**
 * Extract the entity identifier and the remaining path from a key.
 * 
 * The entity identifier can contain parentheses (for HRNs like "from(a).to(b)"),
 * so we can't just split on the first dot. Instead, we parse carefully:
 * - If it starts with "from(", parse until we find the closing "))" from ".to(...)".
 * - If it starts with "uuid(", parse until we find ")".
 * - Otherwise, take everything up to the first dot as a simple ID.
 */
function extractEntityAndPath(rest: string): { entityPart: string; pathPart: string } {
  // Check for from(...).to(...) pattern
  if (rest.startsWith('from(')) {
    // Find the end of the to(...) part
    // Pattern: from(...).to(...)
    let depth = 0;
    let inFrom = false;
    let inTo = false;
    let toStartIdx = -1;
    
    for (let i = 0; i < rest.length; i++) {
      const char = rest[i];
      
      if (char === '(') {
        depth++;
        if (i >= 4 && rest.substring(i - 4, i) === 'from') {
          inFrom = true;
        }
        if (i >= 2 && rest.substring(i - 2, i) === 'to') {
          inTo = true;
          toStartIdx = i - 2;
        }
      } else if (char === ')') {
        depth--;
        if (inTo && depth === 0) {
          // End of to(...); this completes the HRN
          const entityPart = rest.substring(0, i + 1);
          const pathPart = rest.substring(i + 1); // May start with "." or be empty
          return { entityPart, pathPart };
        }
      }
    }
  }
  
  // Check for uuid(...) pattern
  if (rest.startsWith('uuid(')) {
    const closeIdx = rest.indexOf(')', 5);
    if (closeIdx !== -1) {
      const entityPart = rest.substring(0, closeIdx + 1);
      const pathPart = rest.substring(closeIdx + 1);
      return { entityPart, pathPart };
    }
  }
  
  // Simple ID: everything up to the first dot (or entire string if no dot)
  const dotIdx = rest.indexOf('.');
  if (dotIdx === -1) {
    return { entityPart: rest, pathPart: '' };
  }
  
  const entityPart = rest.substring(0, dotIdx);
  const pathPart = rest.substring(dotIdx); // Includes the leading "."
  return { entityPart, pathPart };
}

/**
 * Normalize conditional condition strings within a path segment.
 * 
 * The condition string sits between the edge ID and ".p.<field>":
 * - ".visited(promo).p.mean" → ".visited(promo-uuid).p.mean"
 * - ".context(device:mobile).p.mean" → unchanged (context values don't resolve to nodes)
 * - ".visited(a).exclude(b).p.mean" → ".visited(a-uuid).exclude(b-uuid).p.mean"
 * 
 * We use resolveConditionalHRN to normalize each constraint clause that references nodes.
 */
function normalizeConditionalInPath(
  pathPart: string,
  graph: Graph,
  unresolvedHRNs: string[]
): string {
  // Match constraint patterns: visited(...), exclude(...), context(...), case(...)
  // These appear between the edge ID and ".p." in conditional probability keys
  const constraintPattern = /(visited|exclude)\(([^)]+)\)/g;
  
  return pathPart.replace(constraintPattern, (match, keyword, nodeRef) => {
    // For visited/exclude, resolve the node reference to UUID
    const fullCondition = match; // e.g., "visited(promo)"
    const normalized = resolveConditionalHRN(fullCondition, graph);
    if (normalized === null) {
      unresolvedHRNs.push(`condition.${fullCondition}`);
      return match; // Keep original if can't resolve
    }
    return normalized;
  });
}

/**
 * Narrow a full ScenarioParams object to a particular scope.
 *
 * Scope kinds:
 * - kind: 'graph'          → no narrowing (entire ScenarioParams)
 * - kind: 'edge-param'     → only a single edge + param slot (p / cost_gbp / cost_time)
 * - kind: 'edge-conditional' → a single conditional_p entry for a given edge + condition
 * - kind: 'node'           → a single node (all node-level params)
 * - kind: 'case'           → case variants on a single node (optionally one variant)
 *
 * NOTE: Events are not first-class in ScenarioParams today; when they are added,
 * an additional scope kind can be implemented here.
 */
export type ParamSlot = 'p' | 'cost_gbp' | 'cost_time';

export interface EdgeParamScope {
  kind: 'edge-param';
  edgeUuid?: string;
  edgeId?: string;
  slot: ParamSlot;
}

export interface EdgeConditionalScope {
  kind: 'edge-conditional';
  edgeUuid?: string;
  edgeId?: string;
  condition: string;
}

export interface NodeScope {
  kind: 'node';
  nodeUuid?: string;
  nodeId?: string;
}

export interface CaseScope {
  kind: 'case';
  nodeUuid?: string;
  nodeId?: string;
  caseId?: string;
  variantName?: string;
}

export type ParamScope =
  | { kind: 'graph' }
  | EdgeParamScope
  | EdgeConditionalScope
  | NodeScope
  | CaseScope;

export function applyScopeToParams(
  params: ScenarioParams,
  scope: ParamScope,
  graph?: Graph | null
): ScenarioParams {
  if (!scope || scope.kind === 'graph') {
    // No narrowing; return params as-is
    return params;
  }

  if (scope.kind === 'edge-param') {
    const result: ScenarioParams = {};

    if (!graph) {
      return result;
    }

    // Resolve the edge by UUID or id; this uses the same identity layer as elsewhere.
    const edge = graph.edges?.find(
      (e: any) => (scope.edgeUuid && e.uuid === scope.edgeUuid) || (scope.edgeId && e.id === scope.edgeId)
    );
    if (!edge) {
      return result;
    }

    // Params may be keyed by either UUID or ID (depending on how they were resolved)
    // Try both to find the edge params
    const edgeParamsByUuid = params.edges?.[edge.uuid];
    const edgeParamsById = edge.id ? params.edges?.[edge.id] : undefined;
    const edgeParams = edgeParamsByUuid || edgeParamsById;
    
    if (!edgeParams) {
      return result;
    }

    // Use the key that exists in params
    const paramKey = edgeParamsByUuid ? edge.uuid : (edge.id || edge.uuid);
    
    result.edges = {};
    result.edges[paramKey] = {};

    if (scope.slot === 'p' && edgeParams.p) {
      result.edges[paramKey].p = edgeParams.p;
    } else if (scope.slot === 'cost_gbp' && edgeParams.cost_gbp) {
      result.edges[paramKey].cost_gbp = edgeParams.cost_gbp;
    } else if (scope.slot === 'cost_time' && edgeParams.cost_time) {
      result.edges[paramKey].cost_time = edgeParams.cost_time;
    }

    return result;
  }

  if (scope.kind === 'edge-conditional') {
    const result: ScenarioParams = {};

    if (!graph) {
      return result;
    }

    const edge = graph.edges?.find(
      (e: any) => (scope.edgeUuid && e.uuid === scope.edgeUuid) || (scope.edgeId && e.id === scope.edgeId)
    );
    if (!edge) {
      return result;
    }

    // Params may be keyed by either UUID or ID
    const edgeParamsByUuid = params.edges?.[edge.uuid];
    const edgeParamsById = edge.id ? params.edges?.[edge.id] : undefined;
    const edgeParams = edgeParamsByUuid || edgeParamsById;
    
    if (!edgeParams || !edgeParams.conditional_p) {
      return result;
    }

    const condMap = edgeParams.conditional_p;
    let conditionKey = scope.condition;
    let condValue = condMap[conditionKey];

    // If direct match fails, try normalized condition (e.g. visited(promo) → visited(promo-uuid))
    if (!condValue && graph) {
      const normalized = resolveConditionalHRN(conditionKey, graph);
      if (normalized && condMap[normalized]) {
        conditionKey = normalized;
        condValue = condMap[normalized];
      }
    }

    if (!condValue) {
      return result;
    }

    const paramKey = edgeParamsByUuid ? edge.uuid : (edge.id || edge.uuid);
    
    result.edges = {};
    result.edges[paramKey] = {
      conditional_p: {
        [conditionKey]: condValue,
      },
    };

    return result;
  }

  if (scope.kind === 'node') {
    const result: ScenarioParams = {};

    if (!graph) {
      return result;
    }

    const node = graph.nodes?.find(
      (n: any) => (scope.nodeUuid && n.uuid === scope.nodeUuid) || (scope.nodeId && n.id === scope.nodeId)
    );
    if (!node) {
      return result;
    }

    // Params may be keyed by either UUID or ID
    const nodeParamsByUuid = params.nodes?.[node.uuid];
    const nodeParamsById = node.id ? params.nodes?.[node.id] : undefined;
    const nodeParams = nodeParamsByUuid || nodeParamsById;
    
    if (!nodeParams) {
      return result;
    }

    const paramKey = nodeParamsByUuid ? node.uuid : (node.id || node.uuid);

    result.nodes = {};
    result.nodes[paramKey] = nodeParams;
    return result;
  }

  if (scope.kind === 'case') {
    const result: ScenarioParams = {};

    if (!graph) {
      return result;
    }

    const node = graph.nodes?.find(
      (n: any) => (scope.nodeUuid && n.uuid === scope.nodeUuid) || (scope.nodeId && n.id === scope.nodeId)
    );
    if (!node) {
      return result;
    }

    // Params may be keyed by either UUID or ID
    const nodeParamsByUuid = params.nodes?.[node.uuid];
    const nodeParamsById = node.id ? params.nodes?.[node.id] : undefined;
    const nodeParams = nodeParamsByUuid || nodeParamsById;
    
    if (!nodeParams || !nodeParams.case || !nodeParams.case.variants) {
      return result;
    }

    const allVariants = nodeParams.case.variants;
    let scopedVariants = allVariants;

    // Today, flatten/HRN semantics assume caseId === nodeId; we ignore caseId in narrowing.
    if (scope.variantName) {
      scopedVariants = allVariants.filter(v => v.name === scope.variantName);
      if (scopedVariants.length === 0) {
        return result;
      }
    }

    const paramKey = nodeParamsByUuid ? node.uuid : (node.id || node.uuid);

    result.nodes = {};
    result.nodes[paramKey] = {
      case: {
        variants: scopedVariants,
      },
    };

    return result;
  }

  // Fallback: for any unknown scope kind, return empty.
  return {};
}

/**
 * Convenience helper: from a flat HRN map and a scope, produce a scoped
 * ScenarioParams diff. This is the canonical entry point for external
 * ingestion flows (e.g. Sheets) that need to apply scoping.
 *
 * For Sheets and similar sources:
 * - Accepts both absolute HRNs (e.*, n.*) and relative keys (mean, p.mean, etc.)
 * - Normalizes relative keys into full HRNs based on the provided scope
 * - Then delegates to unflattenParams + applyScopeToParams
 *
 * Scenarios generally call unflattenParams(flat) + composeParams directly
 * with implicit 'graph' scope.
 */
export function buildScopedParamsFromFlatPack(
  flatPack: Record<string, unknown> | null | undefined,
  scope: ParamScope,
  graph?: Graph | null
): ScenarioParams {
  if (!flatPack || Object.keys(flatPack).length === 0) {
    return {};
  }

  if (!graph) {
    return {};
  }

  // Normalize relative keys into full HRNs based on scope
  const normalizedFlat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(flatPack)) {
    if (key.startsWith('e.') || key.startsWith('n.')) {
      // Already absolute HRN; keep as-is
      normalizedFlat[key] = value;
      continue;
    }

    // Relative key: interpret in scope context
    if (scope.kind === 'edge-param') {
      const edge = graph.edges?.find(
        (e: any) => (scope.edgeUuid && e.uuid === scope.edgeUuid) || (scope.edgeId && e.id === scope.edgeId)
      );
      if (!edge) continue;

      const edgeId = edge.id || edge.uuid;
      const slot = scope.slot;

      const lower = key.toLowerCase();
      const parts = lower.split('.');
      const last = parts[parts.length - 1];
      const first = parts[0];

      const isBareField = parts.length === 1 && (last === 'mean' || last === 'stdev' || last === 'n' || last === 'k');
      const isSlotPrefixedField =
        (first === 'p' || first === 'cost_gbp' || first === 'cost_time') &&
        (last === 'mean' || last === 'stdev' || last === 'n' || last === 'k');

      if (isBareField) {
        normalizedFlat[`e.${edgeId}.${slot}.${last}`] = value;
      } else if (isSlotPrefixedField && first === slot) {
        normalizedFlat[`e.${edgeId}.${slot}.${last}`] = value;
      }
      // else: out of scope, drop
    } else if (scope.kind === 'edge-conditional') {
      const edge = graph.edges?.find(
        (e: any) => (scope.edgeUuid && e.uuid === scope.edgeUuid) || (scope.edgeId && e.id === scope.edgeId)
      );
      if (!edge) continue;

      const edgeId = edge.id || edge.uuid;
      const condition = scope.condition;

      const lower = key.toLowerCase();
      const parts = lower.split('.');
      const last = parts[parts.length - 1];

      // Normalize contextual keys to the canonical conditional DSL format:
      // e.<edgeId>.<condition>.p.<field>
      if (last === 'mean' || last === 'stdev' || last === 'n' || last === 'k') {
        normalizedFlat[`e.${edgeId}.${condition}.p.${last}`] = value;
      }
    } else if (scope.kind === 'case') {
      const node = graph.nodes?.find(
        (n: any) => (scope.nodeUuid && n.uuid === scope.nodeUuid) || (scope.nodeId && n.id === scope.nodeId)
      );
      if (!node) continue;

      const nodeId = node.id || node.uuid;

      // Case keys are already expected to be in HRN form for cases; if not, skip
      // (relative case keys are uncommon; HRN is the standard form)
      if (key.includes('case(')) {
        normalizedFlat[key] = value;
      }
    } else if (scope.kind === 'node') {
      const node = graph.nodes?.find(
        (n: any) => (scope.nodeUuid && n.uuid === scope.nodeUuid) || (scope.nodeId && n.id === scope.nodeId)
      );
      if (!node) continue;

      const nodeId = node.id || node.uuid;

      // Node-level relative keys (entry.weight, etc.)
      if (!key.startsWith('e.') && !key.startsWith('n.')) {
        normalizedFlat[`n.${nodeId}.${key}`] = value;
      } else {
        normalizedFlat[key] = value;
      }
    }
    // For 'graph' scope, we shouldn't get relative keys; they should already be HRNs
  }

  const { params: full } = parseFlatHRNToParams(
    normalizedFlat as Record<string, any>,
    graph ?? null
  );
  return applyScopeToParams(full, scope, graph ?? null);
}

/**
 * Helper: Set a value at a nested path
 */
function setNestedValue(obj: any, path: string[], value: any) {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (!current[part]) {
      current[part] = {};
    }
    current = current[part];
  }
  current[path[path.length - 1]] = value;
}

/**
 * Detect format and structure from content string
 */
export function detectFormat(content: string): { syntax: 'yaml' | 'json'; structure: 'nested' | 'flat' } {
  const trimmed = content.trim();
  
  // Detect syntax
  const syntax = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'yaml';
  
  // Detect structure
  // Flat format uses HRN notation: e.<edgeId> or n.<nodeId>
  const structure = /^[en]\.[\w-]+\./.test(trimmed) ? 'flat' : 'nested';
  
  return { syntax, structure };
}

