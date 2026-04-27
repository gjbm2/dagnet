/**
 * Scenario spec parsing — shared between the analyse command and tests.
 *
 * Parses --scenario flag values like:
 *   "window(-30d:)"
 *   "name=Before,window(1-Nov-25:30-Nov-25)"
 *   "name=After,colour=#ef4444,window(1-Dec-25:31-Dec-25)"
 */

import type { ScenarioVisibilityMode } from '../types';
import { SCENARIO_COLOURS } from './constants';

export interface ScenarioSpec {
  id?: string;
  name: string;
  queryDsl: string;
  colour: string;
  visibilityMode: ScenarioVisibilityMode;
}

/**
 * Extract all --scenario flag values from argv and parse them.
 */
export function parseScenarioFlags(argv: string[]): ScenarioSpec[] {
  const specs: ScenarioSpec[] = [];
  let counter = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--scenario') continue;
    const val = argv[i + 1];
    if (!val || val.startsWith('-')) continue;
    specs.push(parseScenarioSpec(val, counter));
    counter++;
  }
  return specs;
}

/**
 * Parse a single scenario spec string into its components.
 *
 * Format: comma-separated key=value pairs and DSL fragments.
 * Commas inside parentheses are preserved (they're part of DSL).
 *
 * Recognised keys: id/scenario_id, name, colour/color, visibility/visibility_mode.
 * Everything else is treated as DSL.
 */
export function parseScenarioSpec(raw: string, index: number): ScenarioSpec {
  const parts = splitOutsideParens(raw);
  let id: string | undefined;
  let name: string | undefined;
  let colour: string | undefined;
  let visibilityMode: ScenarioVisibilityMode = 'f+e';
  const dslParts: string[] = [];

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      const value = part.slice(eqIdx + 1).trim();
      switch (key) {
        case 'id':
        case 'scenario_id': id = value; break;
        case 'name': name = value; break;
        case 'colour':
        case 'color': colour = value; break;
        case 'visibility':
        case 'visibility_mode': visibilityMode = value as ScenarioVisibilityMode; break;
        default: dslParts.push(part);
      }
    } else {
      dslParts.push(part);
    }
  }

  return {
    id,
    name: name || `Scenario ${index + 1}`,
    queryDsl: dslParts.join(','),
    colour: colour || SCENARIO_COLOURS[index % SCENARIO_COLOURS.length],
    visibilityMode,
  };
}

/**
 * Split a string by commas, but only at the top level (not inside
 * parentheses). This preserves DSL expressions like
 * `context(channel:google,device:mobile)`.
 */
export function splitOutsideParens(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.filter(p => p.length > 0);
}
