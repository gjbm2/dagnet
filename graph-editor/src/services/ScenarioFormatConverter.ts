/**
 * ScenarioFormatConverter
 * 
 * Converts scenario parameters between different formats:
 * - YAML/JSON (syntax)
 * - Nested/Flat (structure)
 * - CSV (export only)
 */

import * as yaml from 'js-yaml';
import { ScenarioParams } from '../types/scenarios';

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
 * Parse YAML content to scenario params
 * Both nested and flat formats use HRN notation and parse to flat key/value
 */
export function fromYAML(content: string, structure: 'nested' | 'flat' = 'flat'): ScenarioParams {
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
  
  // Both formats parse to flat HRN keys, then unflatten
  const flat = structure === 'nested' ? parseNestedHRN(parsed) : parsed;
  return unflattenParams(flat);
}

/**
 * Parse JSON content to scenario params
 * Both nested and flat formats use HRN notation and parse to flat key/value
 */
export function fromJSON(content: string, structure: 'nested' | 'flat' = 'flat'): ScenarioParams {
  const parsed = JSON.parse(content);
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON: must be an object');
  }
  
  // Both formats parse to flat HRN keys, then unflatten
  const flat = structure === 'nested' ? parseNestedHRN(parsed) : parsed;
  return unflattenParams(flat);
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
 * Per SCENARIOS_MANAGER_SPEC.md Appendix A.1:
 * - Edges: e.<edgeId>.<path>
 * - Nodes: n.<nodeId>.<path>
 * - Case variants: n.<nodeId>.case(<caseId>:<variantName>).weight
 * 
 * Example:
 *   { edges: { 'edge-1': { p: { mean: 0.5 } } }, nodes: { 'node-1': { case: { variants: [{name: 'control', weight: 0.5}] } } } }
 * →
 *   { 'e.edge-1.p.mean': 0.5, 'n.node-1.case(node-1:control).weight': 0.5 }
 */
function flattenParams(params: ScenarioParams): Record<string, any> {
  const flat: Record<string, any> = {};
  
  // Flatten edges with 'e.' prefix
  if (params.edges) {
    for (const [edgeId, edgeParams] of Object.entries(params.edges)) {
      flattenObject(edgeParams, `e.${edgeId}`, flat);
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
 * Per SCENARIOS_MANAGER_SPEC.md Appendix A.1:
 * - e.<edgeId>.<path> → edges: { <edgeId>: { <path> } }
 * - n.<nodeId>.<path> → nodes: { <nodeId>: { <path> } }
 * - n.<nodeId>.case(<caseId>:<variantName>).weight → nodes: { <nodeId>: { case: { variants: [{name, weight}] } } }
 * 
 * Example:
 *   { 'e.edge-1.p.mean': 0.5, 'n.node-1.case(node-1:control).weight': 0.5 }
 * →
 *   { edges: { 'edge-1': { p: { mean: 0.5 } } }, nodes: { 'node-1': { case: { variants: [{name: 'control', weight: 0.5}] } } } }
 */
function unflattenParams(flat: Record<string, any>): ScenarioParams {
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



