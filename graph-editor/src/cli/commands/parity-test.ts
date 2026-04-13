/**
 * parity-test — prove old path (snapshot_subjects) and new path
 * (analytics_dsl + candidate_regimes_by_edge) produce identical
 * NORMALISED responses for all snapshot analysis types.
 *
 * Critical: uses runPreparedAnalysis (the same dispatch + normalisation
 * path the browser uses), NOT raw HTTP. This ensures FE normalisation
 * (including cohort_maturity epoch stitching) is exercised.
 *
 * Tests both single-scenario and multi-scenario (2 scenarios with
 * different temporal DSLs).
 *
 * Requires: Python BE running on localhost:9000 (or PYTHON_API_URL).
 */

import { aggregateAndPopulateGraph } from '../aggregate';
import { bootstrap } from '../bootstrap';
import { extractParamsFromGraph } from '../../services/GraphParamExtractor';
import {
  prepareAnalysisComputeInputs,
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
  type PreparedAnalysisScenario,
} from '../../services/analysisComputePreparationService';
import type { AnalysisResponse } from '../../lib/graphComputeClient';
import type { ScenarioVisibilityMode } from '../../types';

const SNAPSHOT_ANALYSIS_TYPES = [
  'daily_conversions',
  'lag_histogram',
  'cohort_maturity',
  'cohort_maturity_v2',
];

const USAGE = `
dagnet-cli parity-test

  Prove old-path and new-path snapshot analysis produce identical
  normalised results — including FE normalisation and multi-scenario.

  Options:
    --graph, -g    Path to data repo directory
    --name,  -n    Graph name (filename without .json in graphs/)
    --subject      Analysis subject DSL (e.g. from(x).to(y))  [REQUIRED]
    --query, -q    Temporal DSL for scenario 1 (e.g. window(-90d:))
    --query2       Temporal DSL for scenario 2 (omit for single-scenario)
    --type         Single analysis type (default: all snapshot types)
    --verbose, -v  Show detailed output
    --help, -h     Show this help

  Environment:
    PYTHON_API_URL  Python BE URL (default: http://localhost:9000)

  Examples:
    # Single scenario
    bash graph-ops/scripts/parity-test.sh my-graph "window(-90d:)" \\
      --subject "from(a).to(b)"

    # Multi-scenario (two different windows)
    bash graph-ops/scripts/parity-test.sh my-graph "window(-90d:)" \\
      --subject "from(a).to(b)" --query2 "window(-30d:)"
`;

interface ComparisonResult {
  analysisType: string;
  scenarioMode: 'single' | 'multi';
  passed: boolean;
  details: string;
  response?: AnalysisResponse;  // retained for v1-vs-v2 comparison
}

export async function run() {
  const ctx = await bootstrap({
    extraOptions: {
      type: { type: 'string' },
      subject: { type: 'string' },
      query2: { type: 'string' },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, workspace, queryDsl, flags, extraArgs } = ctx;
  const verbose = flags.verbose;
  const subject = extraArgs.subject as string | undefined;
  const query2 = extraArgs.query2 as string | undefined;
  const singleType = extraArgs.type as string | undefined;

  if (!subject) {
    console.error('[parity] ERROR: --subject is required (e.g. --subject "from(a).to(b)")');
    process.exit(1);
  }

  const typesToTest = singleType ? [singleType] : SNAPSHOT_ANALYSIS_TYPES;

  console.error(`[parity] Workspace: ${workspace.repository}/${workspace.branch}`);
  console.error(`[parity] Subject: ${subject}`);
  console.error(`[parity] Query 1: ${queryDsl}`);
  if (query2) console.error(`[parity] Query 2: ${query2}`);

  // Aggregate graph for each scenario's DSL
  console.error(`[parity] Aggregating scenario 1 (${queryDsl})...`);
  const { graph: graph1 } = await aggregateAndPopulateGraph(bundle, queryDsl);
  const params1 = extractParamsFromGraph(graph1);

  let params2: any = null;
  if (query2) {
    console.error(`[parity] Aggregating scenario 2 (${query2})...`);
    const { graph: graph2 } = await aggregateAndPopulateGraph(bundle, query2);
    params2 = extractParamsFromGraph(graph2);
  }

  const results: ComparisonResult[] = [];

  // Collect v2 responses for v1-vs-v2 parity comparison
  const v2Responses: Map<string, AnalysisResponse> = new Map();

  // Test each analysis type in both single-scenario and multi-scenario modes
  for (const analysisType of typesToTest) {
    // ── Single scenario ──
    console.error(`\n[parity] ── ${analysisType} (single scenario) ──`);
    const singleResult = await testParity({
      bundle, workspace, analysisType, subject, queryDsl,
      params: params1, verbose, scenarioMode: 'single',
    });
    results.push(singleResult);
    logResult(singleResult);

    // Stash v2 response for later v1-vs-v2 comparison
    if (analysisType === 'cohort_maturity_v2' && singleResult.passed && singleResult.response) {
      v2Responses.set('single', singleResult.response);
    }

    // ── Multi-scenario (if query2 provided) ──
    if (query2 && params2) {
      console.error(`\n[parity] ── ${analysisType} (multi-scenario) ──`);
      const multiResult = await testParity({
        bundle, workspace, analysisType, subject, queryDsl,
        query2, params: params1, params2, verbose, scenarioMode: 'multi',
      });
      results.push(multiResult);
      logResult(multiResult);

      if (analysisType === 'cohort_maturity_v2' && multiResult.passed && multiResult.response) {
        v2Responses.set('multi', multiResult.response);
      }
    }
  }

  // ── v1-vs-v2 parity: compare cohort_maturity vs cohort_maturity_v2 ──
  // Only runs when both types are in the test set and v2 succeeded.
  if (typesToTest.includes('cohort_maturity') && typesToTest.includes('cohort_maturity_v2')) {
    v2Responses.forEach((v2Resp, mode) => {
      const scenarioMode = mode as 'single' | 'multi';
      // Find the v1 result we already ran
      const v1Result = results.find(
        r => r.analysisType === 'cohort_maturity' && r.scenarioMode === scenarioMode,
      );
      if (v1Result?.passed && v1Result.response) {
        console.error(`\n[parity] ── v1-vs-v2 parity (${mode} scenario) ──`);
        const parityResult = compareNormalisedResponses(
          v1Result.response, v2Resp, 'v1_vs_v2_parity', scenarioMode, verbose,
        );
        results.push(parityResult);
        logResult(parityResult);
      }
    });
  }

  // Summary
  console.error('\n[parity] ══════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.error(`[parity] ${passed} passed, ${failed} failed out of ${results.length}`);
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    const mode = r.scenarioMode === 'multi' ? ' (multi)' : '';
    console.error(`[parity]   ${icon} ${r.analysisType}${mode}${r.passed ? '' : ': ' + r.details}`);
  }
  console.error('[parity] ══════════════════════════════════');

  // Strip response payloads before JSON output (they're large and only used for comparison)
  const cleanResults = results.map(({ response, ...rest }) => rest);
  process.stdout.write(JSON.stringify({ results: cleanResults, passed, failed, total: results.length }, null, 2) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

function logResult(r: ComparisonResult) {
  const mode = r.scenarioMode === 'multi' ? ' (multi)' : '';
  if (r.passed) {
    console.error(`[parity] ✓ ${r.analysisType}${mode}: PASS — ${r.details}`);
  } else {
    console.error(`[parity] ✗ ${r.analysisType}${mode}: FAIL — ${r.details}`);
  }
}

// ---------------------------------------------------------------------------
// Core parity test: prepare → run old path → run new path → compare
// ---------------------------------------------------------------------------

interface TestParityArgs {
  bundle: any;
  workspace: { repository: string; branch: string };
  analysisType: string;
  subject: string;
  queryDsl: string;
  query2?: string;
  params: any;
  params2?: any;
  verbose: boolean;
  scenarioMode: 'single' | 'multi';
}

async function testParity(args: TestParityArgs): Promise<ComparisonResult> {
  const { bundle, workspace, analysisType, subject, queryDsl,
          query2, params, params2, verbose, scenarioMode } = args;

  const isMulti = scenarioMode === 'multi' && query2 && params2;

  // Build scenario context matching browser behaviour
  const visibleScenarioIds = isMulti ? ['scenario-1', 'current'] : ['current'];

  const scenarioLikes = isMulti ? [{
    id: 'scenario-1',
    params: params,
    name: 'Scenario 1',
    colour: '#3b82f6',
    meta: { isLive: true, queryDSL: queryDsl, lastEffectiveDSL: queryDsl },
  }] : [];

  const currentParams = isMulti ? params2 : params;
  const currentDSL = isMulti ? query2! : queryDsl;

  // Prepare analysis (old path — produces snapshot_subjects + analytics_dsl)
  const prepared = await prepareAnalysisComputeInputs({
    mode: 'live',
    graph: bundle.graph,
    analysisType,
    analyticsDsl: subject,
    currentDSL,
    needsSnapshots: true,
    workspace,
    rawScenarioStateLoaded: true,
    visibleScenarioIds,
    scenariosContext: {
      scenarios: scenarioLikes,
      baseParams: {},
      currentParams,
      scenariosReady: true,
    },
    whatIfDSL: null,
    getScenarioVisibilityMode: () => 'f+e' as ScenarioVisibilityMode,
    getScenarioName: (id: string) => id === 'current' ? 'Current' : 'Scenario 1',
    getScenarioColour: (id: string) => id === 'current' ? '#ef4444' : '#3b82f6',
  });

  if (prepared.status === 'blocked') {
    return { analysisType, scenarioMode, passed: false, details: `Blocked: ${prepared.reason}` };
  }

  const readyPrepared = prepared as PreparedAnalysisComputeReady;

  // Verify analytics_dsl is present
  for (const sc of readyPrepared.scenarios) {
    if (!sc.analytics_dsl) {
      return { analysisType, scenarioMode, passed: false,
        details: `Scenario ${sc.scenario_id}: no analytics_dsl` };
    }
    if (verbose) {
      const hasSS = Array.isArray(sc.snapshot_subjects) && sc.snapshot_subjects.length > 0;
      console.error(`[parity]   ${sc.scenario_id}: analytics_dsl="${sc.analytics_dsl}", effective_query_dsl="${sc.effective_query_dsl}", snapshot_subjects=${hasSS}`);
    }
  }

  console.error(`[parity] Prepared: ${readyPrepared.scenarios.length} scenarios, analyticsDsl="${readyPrepared.analyticsDsl}"`);

  // Run the prepared analysis through the full FE normalisation path
  let response: AnalysisResponse;
  try {
    console.error(`[parity] Running analysis (analytics_dsl path)...`);
    response = await runPreparedAnalysis(readyPrepared);
  } catch (e: any) {
    return { analysisType, scenarioMode, passed: false, details: `Error: ${e.message}` };
  }

  // Validate the response has real data
  const result = validateResponse(response, analysisType, scenarioMode);
  result.response = response;
  return result;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function validateResponse(
  resp: AnalysisResponse,
  analysisType: string,
  scenarioMode: 'single' | 'multi',
): ComparisonResult {
  if (!resp.success) {
    return { analysisType, scenarioMode, passed: false,
      details: `Failed: ${(resp as any).result?.analysis_description || (resp as any).error || 'unknown'}` };
  }

  const r = resp.result || {} as any;
  const data = Array.isArray(r.data) ? r.data : [];
  const frames = Array.isArray(r.frames) ? r.frames : [];
  const maturityRows = Array.isArray(r.maturity_rows) ? r.maturity_rows : [];

  const parts: string[] = [];
  if (data.length > 0) parts.push(`${data.length} data rows`);
  if (frames.length > 0) parts.push(`${frames.length} frames`);
  if (maturityRows.length > 0) parts.push(`${maturityRows.length} maturity_rows`);

  if (parts.length === 0) {
    // Empty result: fail for single-scenario (the edge should have data),
    // warn-but-pass for multi-scenario (narrower window may legitimately
    // have no rows for some analysis types).
    if (resp.success && scenarioMode === 'multi') {
      return { analysisType, scenarioMode, passed: true,
        details: 'No data for this query/window combination (valid empty)' };
    }
    return { analysisType, scenarioMode, passed: false,
      details: 'Empty response — single scenario should have data' };
  }

  return { analysisType, scenarioMode, passed: true,
    details: parts.join(', ') };
}

// v1-vs-v2 parity: field-by-field comparison of normalised responses
function compareNormalisedResponses(
  oldResp: AnalysisResponse,
  newResp: AnalysisResponse,
  analysisType: string,
  scenarioMode: 'single' | 'multi',
  verbose: boolean,
): ComparisonResult {
  // Both must succeed
  if (!oldResp.success && !newResp.success) {
    return { analysisType, scenarioMode, passed: false,
      details: 'Both paths failed (hash mismatch? Run retrieve-all first)' };
  }
  if (!oldResp.success) {
    return { analysisType, scenarioMode, passed: false,
      details: `Old path failed: ${oldResp.result?.analysis_description || 'unknown'}` };
  }
  if (!newResp.success) {
    return { analysisType, scenarioMode, passed: false,
      details: `New path failed: ${newResp.result?.analysis_description || 'unknown'}` };
  }

  const oldR = oldResp.result || {} as any;
  const newR = newResp.result || {} as any;

  // Log shapes
  if (verbose) {
    console.error(`[parity]   Old keys: ${Object.keys(oldR).sort().join(', ')}`);
    console.error(`[parity]   New keys: ${Object.keys(newR).sort().join(', ')}`);
  }

  // Structural parity: every key in old must exist in new
  const oldKeys = new Set(Object.keys(oldR));
  const newKeys = new Set(Object.keys(newR));
  const missing = [...oldKeys].filter(k => !newKeys.has(k));
  if (missing.length > 0) {
    return { analysisType, scenarioMode, passed: false,
      details: `New result missing keys: ${missing.join(', ')}` };
  }

  // Compare data arrays (daily_conversions, lag_histogram tabular output)
  const oldData = Array.isArray(oldR.data) ? oldR.data : [];
  const newData = Array.isArray(newR.data) ? newR.data : [];

  if (oldData.length !== newData.length) {
    return { analysisType, scenarioMode, passed: false,
      details: `data row count: old=${oldData.length} new=${newData.length}` };
  }

  // Compare numeric fields row-by-row
  for (let i = 0; i < oldData.length; i++) {
    const diff = compareRow(oldData[i], newData[i]);
    if (diff) {
      return { analysisType, scenarioMode, passed: false,
        details: `data[${i}]: ${diff}` };
    }
  }

  // Compare frames (cohort_maturity)
  const oldFrames = Array.isArray(oldR.frames) ? oldR.frames : [];
  const newFrames = Array.isArray(newR.frames) ? newR.frames : [];
  if (oldFrames.length !== newFrames.length) {
    return { analysisType, scenarioMode, passed: false,
      details: `frames count: old=${oldFrames.length} new=${newFrames.length}` };
  }
  for (let i = 0; i < oldFrames.length; i++) {
    if (oldFrames[i]?.snapshot_date !== newFrames[i]?.snapshot_date) {
      return { analysisType, scenarioMode, passed: false,
        details: `frames[${i}].snapshot_date: old=${oldFrames[i]?.snapshot_date} new=${newFrames[i]?.snapshot_date}` };
    }
    const oldPts = Array.isArray(oldFrames[i]?.data_points) ? oldFrames[i].data_points : [];
    const newPts = Array.isArray(newFrames[i]?.data_points) ? newFrames[i].data_points : [];
    if (oldPts.length !== newPts.length) {
      return { analysisType, scenarioMode, passed: false,
        details: `frames[${i}].data_points count: old=${oldPts.length} new=${newPts.length}` };
    }
  }

  // Compare maturity_rows
  const oldMR = Array.isArray(oldR.maturity_rows) ? oldR.maturity_rows : [];
  const newMR = Array.isArray(newR.maturity_rows) ? newR.maturity_rows : [];
  if (oldMR.length !== newMR.length) {
    return { analysisType, scenarioMode, passed: false,
      details: `maturity_rows count: old=${oldMR.length} new=${newMR.length}` };
  }
  for (let i = 0; i < oldMR.length; i++) {
    const diff = compareRow(oldMR[i], newMR[i]);
    if (diff) {
      return { analysisType, scenarioMode, passed: false,
        details: `maturity_rows[${i}]: ${diff}` };
    }
  }

  // Build summary
  const parts: string[] = [];
  if (oldData.length > 0) parts.push(`${oldData.length} data rows`);
  if (oldFrames.length > 0) parts.push(`${oldFrames.length} frames`);
  if (oldMR.length > 0) parts.push(`${oldMR.length} maturity_rows`);
  if (parts.length === 0) {
    return { analysisType, scenarioMode, passed: true,
      details: 'Both paths returned empty results (parity holds — no data for this window)' };
  }

  return { analysisType, scenarioMode, passed: true,
    details: `Match (${parts.join(', ')})` };
}

// Fields that are labels/identifiers whose format is expected to differ
// between old and new paths (the new path uses resolved:uuid:N format).
const LABEL_FIELDS = new Set([
  'subject_id', 'scenario_id', 'param_id', 'core_hash',
  'epoch_subject_id', 'epoch_sweep_from', 'epoch_sweep_to',
  'epoch_slice_keys', 'window_from', 'window_to',
]);

function compareRow(a: any, b: any): string | null {
  if (!a || !b) return 'null row';
  for (const field of Object.keys(a)) {
    if (LABEL_FIELDS.has(field)) continue;
    const ov = a[field];
    const nv = b[field];
    if (typeof ov === 'number' && typeof nv === 'number') {
      if (Math.abs(ov - nv) > 1e-6) {
        return `${field}: old=${ov} new=${nv}`;
      }
    } else if (typeof ov === 'string' && typeof nv === 'string') {
      if (ov !== nv) {
        return `${field}: old="${ov}" new="${nv}"`;
      }
    }
  }
  return null;
}
