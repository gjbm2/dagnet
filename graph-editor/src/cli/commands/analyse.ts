/**
 * analyse command — run a graph analysis via the Python BE and return
 * the result JSON (the same payload that feeds ECharts in the browser).
 *
 * Supports multiple scenarios: each --scenario flag produces a
 * separately-aggregated graph that goes into the BE request as a
 * ScenarioData entry. The same scenario machinery the browser uses.
 *
 * Requires the Python BE to be running.
 */

import { bootstrap, type CLIContext } from '../bootstrap';
import { aggregateAndPopulateGraph } from '../aggregate';
import { PYTHON_API_BASE } from '../../lib/pythonApiBase';
import type { GraphBundle } from '../diskLoader';

const USAGE = `
dagnet-cli analyse

  Run a graph analysis via the Python backend and return the result
  JSON — the same payload that feeds ECharts in the browser.

  Options:
    --graph, -g              Path to data repo directory
    --name,  -n              Graph name (filename without .json in graphs/)
    --query, -q              Query DSL (shorthand for single scenario named "base")
    --scenario <spec>        Scenario specification (repeatable). Format:
                               "<dsl>"
                               "name=<name>,<dsl>"
                               "name=<name>,colour=<hex>,<dsl>"
    --type                   Analysis type (e.g. graph_overview, cohort_maturity,
                             daily_conversions, lag_histogram, surprise, bridge)
    --subject <id>           Analysis subject (edge or node ID, for types that need one)
    --get <key>              Extract a single value from the result using dot-path
    --format, -f             Output format: json (default), yaml
    --no-cache               Bypass disk bundle cache
    --verbose, -v            Show all console.log/warn output
    --help, -h               Show this help

  Environment:
    PYTHON_API_URL   Python BE URL (default: http://localhost:9000)

  Examples:
    # Single scenario (--query shorthand)
    bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" --type graph_overview

    # Two scenarios for bridge comparison
    bash graph-ops/scripts/analyse.sh my-graph \\
      --scenario "name=before,window(1-Nov-25:30-Nov-25)" \\
      --scenario "name=after,window(1-Dec-25:31-Dec-25)" \\
      --type bridge --subject "e.my-edge-id"

    # Cohort maturity
    bash graph-ops/scripts/analyse.sh my-graph "cohort(1-Jan-26:1-Apr-26)" --type cohort_maturity
`;

// Default scenario colours (same palette the browser uses)
const SCENARIO_COLOURS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

interface ScenarioSpec {
  name: string;
  queryDsl: string;
  colour: string;
  visibilityMode: 'f+e' | 'f' | 'e';
}

export async function run() {
  // Parse --scenario flags from raw argv (parseArgs doesn't support repeated flags)
  const scenarioSpecs = parseScenarioFlags(process.argv.slice(2));

  const ctx = await bootstrap({
    queryOptional: scenarioSpecs.length > 0, // --query not required if --scenario present
    extraOptions: {
      type: { type: 'string' },
      subject: { type: 'string' },
      scenario: { type: 'string', multiple: true }, // parsed separately from raw argv
    },
  });
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, queryDsl, getKey, format, extraArgs } = ctx;
  const analysisType = (extraArgs.type as string) || 'graph_overview';
  const subject = extraArgs.subject as string | undefined;

  // Build scenario list: --scenario flags, or --query as single scenario
  const scenarios: ScenarioSpec[] = scenarioSpecs.length > 0
    ? scenarioSpecs
    : [{ name: 'Scenario 1', queryDsl, colour: SCENARIO_COLOURS[0], visibilityMode: 'f+e' }];

  // Aggregate each scenario independently
  const scenarioEntries: any[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    const spec = scenarios[i];
    console.error(`[cli] Aggregating scenario '${spec.name}' (${spec.queryDsl})...`);
    const { graph: populatedGraph, warnings } = aggregateAndPopulateGraph(bundle, spec.queryDsl);
    for (const w of warnings) {
      console.error(`[cli] WARNING [${spec.name}]: ${w}`);
    }
    scenarioEntries.push({
      scenario_id: spec.name,
      name: spec.name,
      colour: spec.colour,
      visibility_mode: spec.visibilityMode,
      graph: populatedGraph,
    });
  }

  console.error(`[cli] ${scenarioEntries.length} scenario(s) prepared`);

  // Build request payload (mirrors graphComputeClient.analyzeMultipleScenarios)
  //
  // query_dsl sent to BE = subject + first scenario's window/cohort.
  // The subject (from/to/visited) is constant across scenarios.
  // For single-scenario with subject in the DSL, this is a no-op merge.
  // For multi-scenario with --subject, the subject is prepended.
  const baseDsl = scenarios[0]?.queryDsl || queryDsl;
  const effectiveQueryDsl = subject
    ? `${subject}.${baseDsl}`
    : baseDsl;

  const request: any = {
    scenarios: scenarioEntries,
    query_dsl: effectiveQueryDsl,
    analysis_type: analysisType,
  };

  // POST to Python BE
  const url = `${PYTHON_API_BASE}/api/runner/analyze`; // US spelling — API endpoint name
  console.error(`[cli] Calling ${url} (analysis_type: ${analysisType}, scenarios: ${scenarioEntries.length})...`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err: any) {
    console.error(`[cli] ERROR: Could not reach Python BE at ${url}`);
    console.error(`[cli] Ensure the Python backend is running (python dev-server.py)`);
    console.error(`[cli] ${err.message}`);
    process.exit(1);
  }

  if (!response.ok) {
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const error = await response.json();
      console.error(`[cli] ERROR: Analysis failed — ${error.detail || error.error || response.statusText}`);
    } else {
      console.error(`[cli] ERROR: Analysis API returned ${response.status}`);
    }
    process.exit(1);
  }

  const result = await response.json();
  console.error(`[cli] Analysis complete (type: ${result.result?.analysis_type || analysisType})`);

  // --get: extract a single value via dot-path
  if (getKey) {
    const value = resolveDotPath(result, getKey);
    if (value === undefined) {
      console.error(`[cli] ERROR: key '${getKey}' not found in analysis result`);
      console.error(`[cli] Top-level keys: ${Object.keys(result).join(', ')}`);
      if (result.result) {
        console.error(`[cli] result.* keys: ${Object.keys(result.result).join(', ')}`);
      }
      process.exit(1);
    }
    process.stdout.write(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    process.stdout.write('\n');
    return;
  }

  // Full output
  const output = format === 'yaml'
    ? (await import('js-yaml')).default.dump(result, { lineWidth: -1 })
    : JSON.stringify(result, null, 2);

  process.stdout.write(output + '\n');
}

// ---------------------------------------------------------------------------
// Scenario parsing
// ---------------------------------------------------------------------------

/**
 * Parse --scenario flags from raw argv.
 *
 * Each --scenario value is a spec string:
 *   "window(1-Nov-25:30-Nov-25)"
 *   "name=before,window(1-Nov-25:30-Nov-25)"
 *   "name=before,colour=#ff0000,visibility=f,window(1-Nov-25:30-Nov-25)"
 *
 * Parsing: split on commas, key=value pairs are named properties,
 * the remaining bare string is the query DSL.
 */
function parseScenarioFlags(argv: string[]): ScenarioSpec[] {
  const specs: ScenarioSpec[] = [];
  let counter = 0;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--scenario') continue;
    const val = argv[i + 1];
    if (!val || val.startsWith('-')) continue;

    const spec = parseScenarioSpec(val, counter);
    specs.push(spec);
    counter++;
  }

  return specs;
}

function parseScenarioSpec(raw: string, index: number): ScenarioSpec {
  // Split on commas that are NOT inside parentheses (DSL contains commas in args)
  const parts = splitOutsideParens(raw);

  let name: string | undefined;
  let colour: string | undefined;
  let visibilityMode: 'f+e' | 'f' | 'e' = 'f+e';
  const dslParts: string[] = [];

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      const value = part.slice(eqIdx + 1).trim();
      switch (key) {
        case 'name': name = value; break;
        case 'colour':
        case 'color': colour = value; break;
        case 'visibility':
        case 'visibility_mode': visibilityMode = value as any; break;
        default:
          // Unknown key=value — treat as part of DSL (e.g. context(key:value))
          dslParts.push(part);
      }
    } else {
      dslParts.push(part);
    }
  }

  return {
    name: name || `Scenario ${index + 1}`,
    queryDsl: dslParts.join(','),
    colour: colour || SCENARIO_COLOURS[index % SCENARIO_COLOURS.length],
    visibilityMode,
  };
}

/**
 * Split a string on commas, but not commas inside parentheses.
 * "name=before,context(a,b).window(1-Jan:2-Jan)" → ["name=before", "context(a,b).window(1-Jan:2-Jan)"]
 */
function splitOutsideParens(s: string): string[] {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a dot-separated path into a nested object. */
function resolveDotPath(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    const idx = Number(part);
    current = Number.isNaN(idx) ? current[part] : current[idx];
  }
  return current;
}
