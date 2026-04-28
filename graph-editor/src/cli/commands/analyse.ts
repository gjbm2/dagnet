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

import { log, isDiagnostic, exit } from '../logger';
import { SCENARIO_COLOURS } from '../constants';
import { parseScenarioFlags, type ScenarioSpec } from '../scenarioParser';
import { getSnapshotContract } from '../analysisTypeRegistry';
import { aggregateAndPopulateGraph } from '../aggregate';
import { bootstrap } from '../bootstrap';
import {
  prepareAnalysisComputeInputs,
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
} from '../../services/analysisComputePreparationService';
import type { Graph, ScenarioVisibilityMode } from '../../types';

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
    --no-snapshot-cache      Bypass BE snapshot service cache. Use after synth_gen
                             or any DB repopulation to avoid stale cached results.
    --allow-external-fetch   Fetch live from external sources (e.g. Amplitude)
    --display <json>          Display settings JSON (e.g. '{"show_latency_bands":true}')
    --bayes-vars <path>      Inject Bayesian posteriors from a .bayes-vars.json
                             sidecar into the graph in-memory before analysis.
                             No disk writes.
    --force-vars             With --bayes-vars, bypass the rhat/ess quality
                             gates so low-quality posteriors still apply.
    --no-cache               Bypass disk bundle cache
    --diagnostic, --diag     Show detailed pipeline trace (per-edge state at each stage)
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
      'no-snapshot-cache': { type: 'boolean' },
      display: { type: 'string' },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    exit(1, 'usage');
  }

  const { bundle, queryDsl, workspace, getKey, format, flags, extraArgs } = ctx;
  const analysisType = (extraArgs.type as string) || 'graph_overview';
  const subject = extraArgs.subject as string | undefined;

  // Parse --display JSON for chart settings
  let cliDisplaySettings: Record<string, unknown> | undefined;
  if (extraArgs.display) {
    try {
      cliDisplaySettings = JSON.parse(extraArgs.display as string);
    } catch {
      log.error(`Invalid --display JSON: ${extraArgs.display}`);
      exit(1, 'invalid --display JSON');
    }
  }

  // Bypass the BE snapshot service in-memory cache. Essential during synth
  // gen cycles where the DB is repopulated between runs.
  if (extraArgs['no-snapshot-cache']) {
    (globalThis as any).__dagnetComputeNoCache = true;
  }
  if (isDiagnostic()) {
    (globalThis as any).__dagnetDiagnostics = true;
  }

  // Build scenario list: --scenario flags, or --query as single scenario
  const scenarios: ScenarioSpec[] = scenarioSpecs.length > 0
    ? scenarioSpecs
    : [{ name: 'Scenario 1', queryDsl, colour: SCENARIO_COLOURS[0], visibilityMode: 'f+e' as const }];

  // Determine whether this analysis type needs snapshots.
  // conditioned_forecast always needs snapshots (it IS the snapshot-based
  // forecast) even though it's not a registered analysis type.
  const needsSnapshots = analysisType === 'conditioned_forecast' || !!getSnapshotContract(analysisType);

  // Aggregate each scenario independently and preserve the enriched graph
  const scenarioEntries: Array<{
    id: string;
    name: string;
    colour: string;
    visibilityMode: ScenarioVisibilityMode;
    queryDsl: string;
    graph: Graph;
  }> = [];

  // 'from-file' = cache only; 'versioned' = cache first, API if stale/missing
  const fetchMode = flags.allowExternalFetch ? 'versioned' as const : 'from-file' as const;

  // Keep analysis preparation rooted in the original baseline graph.
  // Scenario-specific state enters through per-scenario enriched graphs.
  const baseGraph = bundle.graph;
  const usedExternalScenarioIds = new Set<string>();
  const resolveExternalScenarioId = (spec: ScenarioSpec, index: number): string => {
    const candidate = (spec.id || spec.name || '').trim() || `scenario-${index + 1}`;
    let suffix = 2;
    let unique = candidate;
    while (usedExternalScenarioIds.has(unique)) {
      unique = `${candidate}-${suffix}`;
      suffix += 1;
    }
    if (unique !== candidate) {
      log.warn(`Duplicate scenario id '${candidate}' remapped to '${unique}'. Pass id=... to keep it stable.`);
    }
    usedExternalScenarioIds.add(unique);
    return unique;
  };

  for (let i = 0; i < scenarios.length; i++) {
    const spec = scenarios[i];
    const externalId = resolveExternalScenarioId(spec, i);
    log.info(`Aggregating scenario '${spec.name}' (${spec.queryDsl}, mode: ${fetchMode})...`);
    const { graph: populatedGraph, warnings } = await aggregateAndPopulateGraph(bundle, spec.queryDsl, {
      mode: fetchMode,
      workspace,
      scenarioId: externalId,
    });
    for (const w of warnings) {
      log.warn(`[${spec.name}]: ${w}`);
    }
    scenarioEntries.push({
      id: externalId,
      name: spec.name,
      colour: spec.colour,
      visibilityMode: spec.visibilityMode,
      queryDsl: spec.queryDsl,
      graph: populatedGraph,
    });
  }

  log.info(`${scenarioEntries.length} scenario(s) prepared`);

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

  const prepared = await prepareAnalysisComputeInputs({
    mode: 'custom',
    graph: baseGraph,
    analysisType,
    analyticsDsl,
    currentDSL: '',
    needsSnapshots,
    workspace,
    customScenarios: scenarioEntries.map((entry) => ({
      scenario_id: entry.id,
      name: entry.name,
      colour: entry.colour,
      visibility_mode: entry.visibilityMode,
      graph: entry.graph,
      effective_dsl: entry.queryDsl,
    })),
    hiddenScenarioIds: [],
    frozenWhatIfDsl: null,
    display: cliDisplaySettings,
    // Doc 73b §3.2a / Stage 4(a): per-scenario request graphs context off
    // the parameter-file slice library. The CLI shares
    // analysisComputePreparationService with the FE, so the same wiring
    // contract applies — without this, CLI runs would lose per-scenario
    // posterior projection after Stage 4(b) removes the persistent stash.
    resolveParameterFile: (paramId: string) => bundle.parameters.get(paramId),
  });

  if (prepared.status === 'blocked') {
    log.error(`Analysis preparation blocked — ${prepared.reason}`);
    if (prepared.missingFileIds?.length) {
      log.error(`Missing files: ${prepared.missingFileIds.join(', ')}`);
    }
    exit(1, `analysis preparation blocked — ${prepared.reason}`);
  }

  log.info(`Analysis prepared (type: ${prepared.analysisType}, scenarios: ${prepared.scenarios.length})`);

  // Doc 73e §8.3 Stage 5 item 6 — surface incomplete materialisation. The
  // session log entry is the contract (already emitted by the helper); the
  // CLI's rendering of that signal is a non-zero exit listing the affected
  // scenarios. Analysis output is still produced before exit so the user
  // sees the best-effort result.
  const incompleteScenarios = prepared.scenarios.filter((s) => s.not_fully_materialised);
  for (const sc of incompleteScenarios) {
    const failureSummary = (sc.materialisation_failures || [])
      .map((f) => `${f.itemName}: ${f.message}`)
      .join('; ') || 'unknown';
    log.warn(`Scenario '${sc.name}' (${sc.scenario_id}) not fully materialised — ${failureSummary}`);
  }

  // Diagnostic: prepared analysis detail
  if (isDiagnostic()) {
    log.diag('── Analysis preparation detail ──');
    log.diag(`  analysisType=${prepared.analysisType}  analyticsDsl=${prepared.analyticsDsl}`);
    log.diag(`  status=${prepared.status}  scenarios=${prepared.scenarios.length}`);
    for (const sc of prepared.scenarios) {
      const nSubjects = Array.isArray(sc.snapshot_subjects) ? sc.snapshot_subjects.length : 0;
      log.diag(`  scenario ${sc.scenario_id}:`);
      log.diag(`    analytics_dsl="${sc.analytics_dsl || '—'}"`);
      log.diag(`    effective_query_dsl="${sc.effective_query_dsl || '—'}"`);
      log.diag(`    snapshot_subjects=${nSubjects}`);
      if (nSubjects > 0 && isDiagnostic()) {
        for (const subj of sc.snapshot_subjects!) {
          log.diag(`      subject: ${subj.subject_id || subj.core_hash || '—'}  edge=${(subj as any).edge_id || subj.target?.targetId || '—'}`);
        }
      }
    }
  }

  // Dispatch to BE through the shared prepared-analysis path. CF (doc 73e
  // §8.3 Stage 2 / 73b §7.1) is routed inside runPreparedAnalysis to
  // /api/forecast/conditioned with display_settings forwarded; standard
  // analyses go to /api/runner/analyze. The CLI no longer hand-rolls a
  // separate CF payload.
  const result: any = await runPreparedAnalysis(prepared as PreparedAnalysisComputeReady);

  if (!result.success) {
    log.fatal(`Analysis failed: ${(result as any).error || 'unknown error'}`);
  }

  log.info(`Analysis complete (type: ${result.result?.analysis_type || analysisType})`);

  // Diagnostic: BE-side diagnostics (regime selection, evidence binding)
  if (isDiagnostic() && (result as any)._diagnostics) {
    const diag = (result as any)._diagnostics;
    log.diag('── BE diagnostics ──');
    for (const [k, v] of Object.entries(diag)) {
      log.diag(`  ${k}: ${JSON.stringify(v)}`);
    }
  }

  // --get: extract a single value via dot-path
  if (getKey) {
    const value = resolveDotPath(result, getKey);
    if (value === undefined) {
      log.error(`key '${getKey}' not found in analysis result`);
      log.info(`Top-level keys: ${Object.keys(result).join(', ')}`);
      if (result.result) {
        log.info(`result.* keys: ${Object.keys(result.result).join(', ')}`);
      }
      exit(1, `key '${getKey}' not found in analysis result`);
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

  // Doc 73e §8.3 Stage 5 item 6 — exit non-zero AFTER printing output if any
  // scenario was not fully materialised, so the user sees the best-effort
  // result and the failure signal in the same run.
  if (incompleteScenarios.length > 0) {
    const ids = incompleteScenarios.map((s) => s.scenario_id).join(', ');
    exit(2, `${incompleteScenarios.length} scenario(s) not fully materialised: ${ids}`);
  }
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
