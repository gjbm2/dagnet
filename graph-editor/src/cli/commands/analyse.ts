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
    --topo-pass              Run BE topo pass on each scenario graph before analysis.
                             Populates promoted latency stats (mu_sd, sigma_sd, etc.)
                             needed by cohort_maturity_v2 fan charts.
    --no-snapshot-cache      Bypass BE snapshot service cache. Use after synth_gen
                             or any DB repopulation to avoid stale cached results.
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
      'topo-pass': { type: 'boolean' },
      'no-snapshot-cache': { type: 'boolean' },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, queryDsl, workspace, getKey, format, flags, extraArgs } = ctx;
  const analysisType = (extraArgs.type as string) || 'graph_overview';
  const subject = extraArgs.subject as string | undefined;

  // Bypass the BE snapshot service in-memory cache. Essential during synth
  // gen cycles where the DB is repopulated between runs.
  if (extraArgs['no-snapshot-cache']) {
    (globalThis as any).__dagnetComputeNoCache = true;
  }

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

  // Track the last populated graph — used as the base graph for analysis
  // preparation (carries model_vars, promoted fields from the FE topo pass
  // that runs inside aggregateAndPopulateGraph).
  let baseGraph = bundle.graph;

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
    // Use the last scenario's populated graph as the base — it has the
    // most complete data (model_vars, promoted fields, evidence).
    baseGraph = populatedGraph;
  }

  log.info(`${scenarioEntries.length} scenario(s) prepared`);

  // ── Optional BE topo pass ─────────────────────────────────────
  // Populates promoted latency stats (mu_sd, sigma_sd, path_mu, etc.)
  // on the base graph. Required for cohort_maturity_v2 fan charts when
  // the graph hasn't been opened in the FE (which runs the topo pass
  // automatically on graph open).
  if (extraArgs['topo-pass']) {
    log.info('Running BE topo pass...');

    // Build cohort_data from bundle.parameters — the topo pass needs
    // per-date cohort observations to fit latency distributions.
    const cohortData: Record<string, any[]> = {};
    const paramIdToEdgeUuid = new Map<string, string>();
    for (const edge of (baseGraph.edges || [])) {
      const eid = edge.uuid || edge.id;
      const edgeId = edge.id || '';
      // Map edge ID → UUID (param files use edge ID as their file ID)
      paramIdToEdgeUuid.set(edgeId, eid);
    }
    for (const [paramId, paramData] of bundle.parameters) {
      const edgeUuid = paramIdToEdgeUuid.get(paramId);
      if (!edgeUuid) continue;
      const vals = paramData.values || [];
      if (vals.length === 0) continue;
      // Use the first values entry (window or cohort — both have the daily arrays)
      const v = vals[0];
      const nDaily: number[] = v.n_daily || [];
      const kDaily: number[] = v.k_daily || [];
      const dates: string[] = v.dates || [];
      const medianLagDaily: number[] = v.median_lag_days || [];
      const meanLagDaily: number[] = v.mean_lag_days || [];
      const anchorMedianDaily: number[] = v.anchor_median_lag_days || [];
      const anchorMeanDaily: number[] = v.anchor_mean_lag_days || [];
      // Convert parallel arrays to per-date CohortData records
      const cohorts: any[] = [];
      for (let d = 0; d < dates.length; d++) {
        if ((nDaily[d] || 0) === 0) continue;
        cohorts.push({
          date: dates[d],
          age: dates.length - d, // days from observation to end
          n: nDaily[d] || 0,
          k: kDaily[d] || 0,
          median_lag_days: medianLagDaily[d] ?? null,
          mean_lag_days: meanLagDaily[d] ?? null,
          anchor_median_lag_days: anchorMedianDaily[d] ?? null,
          anchor_mean_lag_days: anchorMeanDaily[d] ?? null,
        });
      }
      if (cohorts.length > 0) {
        cohortData[edgeUuid] = cohorts;
      }
    }
    log.info(`Built cohort data for ${Object.keys(cohortData).length} edges from parameter files`);

    const { PYTHON_API_BASE } = await import('../../lib/pythonApiBase');
    const topoUrl = `${PYTHON_API_BASE}/api/lag/topo-pass`;
    const topoResponse = await fetch(topoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: baseGraph, cohort_data: cohortData }),
    });
    if (!topoResponse.ok) {
      log.error(`Topo pass failed: ${topoResponse.status} ${topoResponse.statusText}`);
      process.exit(1);
    }
    const topoResult = await topoResponse.json() as {
      success: boolean;
      edges: Array<{
        edge_uuid: string;
        mu_sd?: number; sigma_sd?: number; onset_sd?: number; onset_mu_corr?: number;
        path_mu_sd?: number; path_sigma_sd?: number; path_onset_sd?: number;
        mu?: number; sigma?: number; onset_delta_days?: number;
        t95?: number; path_t95?: number; path_mu?: number; path_sigma?: number;
        path_onset_delta_days?: number; completeness?: number;
        p_infinity?: number; p_evidence?: number; blended_mean?: number;
      }>;
      summary: { edges_processed: number; edges_with_lag: number };
    };
    if (!topoResult.success) {
      log.error('Topo pass returned success=false');
      process.exit(1);
    }
    // Write promoted fields onto the base graph edges
    const edgeMap = new Map(topoResult.edges.map(e => [e.edge_uuid, e]));
    for (const edge of (baseGraph.edges || [])) {
      const eid = edge.uuid || edge.id;
      const te = edgeMap.get(eid);
      if (!te) continue;
      const lat = ((edge.p ??= {}).latency ??= {});
      if (te.t95 != null) lat.promoted_t95 = te.t95;
      if (te.onset_delta_days != null) lat.promoted_onset_delta_days = te.onset_delta_days;
      if (te.mu_sd != null) lat.promoted_mu_sd = te.mu_sd;
      if (te.sigma_sd != null) lat.promoted_sigma_sd = te.sigma_sd;
      if (te.onset_sd != null) lat.promoted_onset_sd = te.onset_sd;
      if (te.onset_mu_corr != null) lat.promoted_onset_mu_corr = te.onset_mu_corr;
      if (te.path_mu_sd != null) lat.promoted_path_mu_sd = te.path_mu_sd;
      if (te.path_sigma_sd != null) lat.promoted_path_sigma_sd = te.path_sigma_sd;
      if (te.path_onset_sd != null) lat.promoted_path_onset_sd = te.path_onset_sd;
      if (te.path_t95 != null) lat.promoted_path_t95 = te.path_t95;
      if (te.path_mu != null) lat.promoted_path_mu = te.path_mu;
      if (te.path_sigma != null) lat.promoted_path_sigma = te.path_sigma;
      if (te.path_onset_delta_days != null) lat.promoted_path_onset_delta_days = te.path_onset_delta_days;
      if (te.mu != null) lat.promoted_mu = te.mu;
      if (te.sigma != null) lat.promoted_sigma = te.sigma;
    }
    log.info(`Topo pass complete: ${topoResult.summary.edges_processed} edges processed, ${topoResult.summary.edges_with_lag} with lag`);
  }

  // ── Split combined DSL into subject + temporal ──────────────────
  // The user may pass a single DSL like "from(x).to(y).cohort(1-Jan-26:1-Mar-26)".
  // The FE preparation service expects these as two separate fields:
  //   analyticsDsl  = subject only  (from/to/visited/visitedAny/exclude)
  //   currentDSL    = temporal only (window/cohort/asat/sweep + anything else)
  // If --subject is explicit, use it as-is and leave the query DSL untouched.
  // Otherwise, parse the combined DSL and split here in the CLI before it
  // reaches the FE — avoids the BE concatenating subject + full DSL = doubling.
  let analyticsDsl = subject || '';
  const splitDsl = (dsl: string): { subject: string; temporal: string } => {
    const subjectRe = /\b(from|to|visited|visitedAny|exclude)\([^)]*\)/g;
    const subjectParts: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = subjectRe.exec(dsl)) !== null) {
      subjectParts.push(match[0]);
    }
    const temporal = dsl.replace(subjectRe, '').replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
    return { subject: subjectParts.join('.'), temporal };
  };

  if (!analyticsDsl && queryDsl) {
    const parts = splitDsl(queryDsl);
    if (parts.subject) {
      analyticsDsl = parts.subject;
    }
  }

  // When subject was extracted from the DSL (no explicit --subject), strip
  // subject clauses from each scenario's queryDsl so only temporal remains.
  // This prevents the BE from seeing subject twice (once in analyticsDsl,
  // once embedded in effective_query_dsl).
  if (!subject && analyticsDsl) {
    for (const entry of scenarioEntries) {
      const parts = splitDsl(entry.queryDsl);
      entry.queryDsl = parts.temporal;
    }
  }

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
    graph: baseGraph,
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
