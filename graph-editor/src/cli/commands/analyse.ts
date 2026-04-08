/**
 * analyse command — run a graph analysis via the same preparation +
 * dispatch path the FE uses (prepareAnalysisComputeInputs →
 * runPreparedAnalysis). No shortcuts, no parallel implementation.
 *
 * Supports multiple scenarios: each --scenario flag produces a
 * separately-aggregated graph injected into the live scenario
 * machinery as if the user had created live scenarios in the FE.
 *
 * Requires the Python BE to be running.
 */

import { log } from '../logger';
import { SCENARIO_COLOURS } from '../constants';
import { parseScenarioFlags, type ScenarioSpec } from '../scenarioParser';
import { getSnapshotContract } from '../analysisTypeRegistry';
import { aggregateAndPopulateGraph } from '../aggregate';
import { bootstrap } from '../bootstrap';
import { extractParamsFromGraph } from '../../services/GraphParamExtractor';
import {
  prepareAnalysisComputeInputs,
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
} from '../../services/analysisComputePreparationService';
import type { ScenarioVisibilityMode } from '../../types';

const USAGE = `
dagnet-cli analyse

  Run a graph analysis via the Python backend and return the result
  JSON — the same payload that feeds ECharts in the browser.

  Uses the same preparation path as the FE (prepareAnalysisComputeInputs
  → runPreparedAnalysis) including snapshot subject resolution,
  display settings, and MECE dimensions.

  Options:
    --graph, -g              Path to data repo directory
    --name,  -n              Graph name (filename without .json in graphs/)
    --query, -q              Query DSL (shorthand for single scenario)
    --scenario <spec>        Scenario specification (repeatable). Format:
                               "<dsl>"
                               "name=<name>,<dsl>"
                               "name=<name>,colour=<hex>,<dsl>"
    --type                   Analysis type (e.g. graph_overview, cohort_maturity,
                             daily_conversions, lag_histogram, surprise, bridge)
    --subject <dsl>          Analysis subject (e.g. from(x).to(y)), shared across scenarios
    --get <key>              Extract a single value from the result using dot-path
    --format, -f             Output format: json (default), yaml
    --allow-external-fetch   Fetch live from external sources (e.g. Amplitude)
    --no-cache               Bypass disk bundle cache
    --verbose, -v            Show all console.log/warn output
    --help, -h               Show this help

  Environment:
    PYTHON_API_URL   Python BE URL (default: http://localhost:9000)

  Amplitude credentials are auto-loaded from .env.amplitude.local
  at the repo root. No manual env setup needed.

  Examples:
    # Single scenario
    bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" --type graph_overview

    # Single scenario with subject in DSL
    bash graph-ops/scripts/analyse.sh my-graph \\
      "from(x).to(y).window(-90d:)" --type cohort_maturity

    # Two scenarios for bridge comparison
    bash graph-ops/scripts/analyse.sh my-graph \\
      --scenario "name=Before,window(1-Nov-25:30-Nov-25)" \\
      --scenario "name=After,window(1-Dec-25:31-Dec-25)" \\
      --type bridge --subject "from(x).to(y)"
`;

export async function run() {
  try {
    await runAnalyse();
  } catch (err: any) {
    log.fatal(err.message || String(err));
  }
}

async function runAnalyse() {
  const scenarioSpecs = parseScenarioFlags(process.argv.slice(2));

  const ctx = await bootstrap({
    queryOptional: scenarioSpecs.length > 0,
    extraOptions: {
      type: { type: 'string' },
      subject: { type: 'string' },
      scenario: { type: 'string', multiple: true },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, queryDsl, workspace, getKey, format, flags, extraArgs } = ctx;
  const analysisType = (extraArgs.type as string) || 'graph_overview';
  const subject = extraArgs.subject as string | undefined;

  // Build scenario list: --scenario flags, or --query as single scenario
  const scenarios: ScenarioSpec[] = scenarioSpecs.length > 0
    ? scenarioSpecs
    : [{ name: 'Scenario 1', queryDsl, colour: SCENARIO_COLOURS[0], visibilityMode: 'f+e' as const }];

  // Determine whether this analysis type needs snapshots
  const needsSnapshots = !!getSnapshotContract(analysisType);

  // Aggregate each scenario independently and extract params
  const scenarioEntries: Array<{
    id: string;
    name: string;
    colour: string;
    visibilityMode: ScenarioVisibilityMode;
    queryDsl: string;
    params: any;
  }> = [];

  // 'from-file' = cache only; 'versioned' = cache first, API if stale/missing
  const fetchMode = flags.allowExternalFetch ? 'versioned' as const : 'from-file' as const;

  for (let i = 0; i < scenarios.length; i++) {
    const spec = scenarios[i];
    log.info(`Aggregating scenario '${spec.name}' (${spec.queryDsl}, mode: ${fetchMode})...`);
    const { graph: populatedGraph, warnings } = await aggregateAndPopulateGraph(bundle, spec.queryDsl, { mode: fetchMode });
    for (const w of warnings) {
      log.warn(`[${spec.name}]: ${w}`);
    }
    const params = extractParamsFromGraph(populatedGraph);
    scenarioEntries.push({
      id: spec.name === 'Scenario 1' && scenarios.length === 1 ? 'current' : (i === scenarios.length - 1 ? 'current' : `scenario-${i + 1}`),
      name: spec.name,
      colour: spec.colour,
      visibilityMode: spec.visibilityMode,
      queryDsl: spec.queryDsl,
      params,
    });
  }

  log.info(`${scenarioEntries.length} scenario(s) prepared`);

  // Build the effective analytics DSL (subject + first scenario's window)
  const baseDsl = scenarios[0]?.queryDsl || queryDsl;
  const analyticsDsl = subject ? `${subject}.${baseDsl}` : baseDsl;

  // Build scenariosContext to inject CLI scenarios into live mode.
  // The last scenario is always 'current'. Earlier ones are live scenarios.
  const currentEntry = scenarioEntries[scenarioEntries.length - 1];
  const nonCurrentEntries = scenarioEntries.slice(0, -1);

  const scenarioLikes = nonCurrentEntries.map(e => ({
    id: e.id,
    params: e.params,
    name: e.name,
    colour: e.colour,
    meta: {
      isLive: true,
      queryDSL: e.queryDsl,
      lastEffectiveDSL: e.queryDsl,
    },
  }));

  const visibleScenarioIds = scenarioEntries.map(e => e.id);

  const prepared = await prepareAnalysisComputeInputs({
    mode: 'live',
    graph: bundle.graph,
    analysisType,
    analyticsDsl,
    currentDSL: currentEntry.queryDsl,
    needsSnapshots,
    workspace,
    rawScenarioStateLoaded: true,
    visibleScenarioIds,
    scenariosContext: {
      scenarios: scenarioLikes,
      baseParams: {},
      currentParams: currentEntry.params,
      scenariosReady: true,
    },
    whatIfDSL: null,
    getScenarioVisibilityMode: (id: string) => {
      const entry = scenarioEntries.find(e => e.id === id);
      return entry?.visibilityMode || 'f+e';
    },
    getScenarioName: (id: string) => {
      const entry = scenarioEntries.find(e => e.id === id);
      return entry?.name || id;
    },
    getScenarioColour: (id: string) => {
      const entry = scenarioEntries.find(e => e.id === id);
      return entry?.colour || '#808080';
    },
  });

  if (prepared.status === 'blocked') {
    log.error(`Analysis preparation blocked — ${prepared.reason}`);
    if (prepared.missingFileIds?.length) {
      log.error(`Missing files: ${prepared.missingFileIds.join(', ')}`);
    }
    process.exit(1);
  }

  log.info(`Analysis prepared (type: ${prepared.analysisType}, scenarios: ${prepared.scenarios.length})`);

  // Dispatch to BE via the same path the FE uses
  const result = await runPreparedAnalysis(prepared as PreparedAnalysisComputeReady);

  if (!result.success) {
    log.fatal('Analysis failed');
  }

  log.info(`Analysis complete (type: ${result.result?.analysis_type || analysisType})`);

  // --get: extract a single value via dot-path
  if (getKey) {
    const value = resolveDotPath(result, getKey);
    if (value === undefined) {
      log.error(`key '${getKey}' not found in analysis result`);
      log.info(`Top-level keys: ${Object.keys(result).join(', ')}`);
      if (result.result) {
        log.info(`result.* keys: ${Object.keys(result.result).join(', ')}`);
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
// Helpers
// ---------------------------------------------------------------------------

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
