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
 */
export function toYAML(params: ScenarioParams, structure: 'nested' | 'flat' = 'nested'): string {
  const formatted = structure === 'flat' ? flattenParams(params) : params;
  return yaml.dump(formatted, { 
    indent: 2, 
    lineWidth: 120,
    noRefs: true 
  });
}

/**
 * Convert scenario params to JSON
 */
export function toJSON(params: ScenarioParams, structure: 'nested' | 'flat' = 'nested'): string {
  const formatted = structure === 'flat' ? flattenParams(params) : params;
  return JSON.stringify(formatted, null, 2);
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
 */
export function fromYAML(content: string, structure: 'nested' | 'flat' = 'nested'): ScenarioParams {
  const parsed = yaml.load(content) as any;
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML: must be an object');
  }
  
  return structure === 'flat' ? unflattenParams(parsed) : parsed;
}

/**
 * Parse JSON content to scenario params
 */
export function fromJSON(content: string, structure: 'nested' | 'flat' = 'nested'): ScenarioParams {
  const parsed = JSON.parse(content);
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON: must be an object');
  }
  
  return structure === 'flat' ? unflattenParams(parsed) : parsed;
}

/**
 * Flatten nested params to dot-notation keys
 * 
 * Example:
 *   { edges: { 'edge-1': { p: { mean: 0.5 } } } }
 * →
 *   { 'edges.edge-1.p.mean': 0.5 }
 */
function flattenParams(params: ScenarioParams): Record<string, any> {
  const flat: Record<string, any> = {};
  
  function flatten(obj: any, prefix: string = '') {
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      
      if (value === null || value === undefined) {
        flat[newKey] = value;
      } else if (Array.isArray(value)) {
        flat[newKey] = value;
      } else if (typeof value === 'object') {
        flatten(value, newKey);
      } else {
        flat[newKey] = value;
      }
    }
  }
  
  flatten(params);
  return flat;
}

/**
 * Unflatten dot-notation keys to nested structure
 * 
 * Example:
 *   { 'edges.edge-1.p.mean': 0.5 }
 * →
 *   { edges: { 'edge-1': { p: { mean: 0.5 } } } }
 */
function unflattenParams(flat: Record<string, any>): ScenarioParams {
  const nested: any = {};
  
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = nested;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current[parts[parts.length - 1]] = value;
  }
  
  return nested;
}

/**
 * Detect format and structure from content string
 */
export function detectFormat(content: string): { syntax: 'yaml' | 'json'; structure: 'nested' | 'flat' } {
  const trimmed = content.trim();
  
  // Detect syntax
  const syntax = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'yaml';
  
  // Detect structure (simplified heuristic)
  // If we see dot-notation keys at top level, it's flat
  const structure = /^[\w-]+\.[\w-]+\./.test(trimmed) ? 'flat' : 'nested';
  
  return { syntax, structure };
}

