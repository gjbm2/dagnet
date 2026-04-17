/**
 * bayes command — commission a Bayes fit using the same payload
 * construction as the FE (useBayesTrigger), stripped of browser concerns.
 *
 * Modes:
 *   (default)    Write payload JSON to stdout
 *   --output     Write payload JSON to file
 *   --preflight  POST with binding_receipt: "gate", display receipt, exit
 *   --submit     POST, poll until done, display result
 *
 * Requires the Python BE to be running for --preflight and --submit.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log, isDiagnostic } from '../logger';
import { bootstrap } from '../bootstrap';
import { fileRegistry } from '../../contexts/TabContext';
import { PYTHON_API_BASE } from '../../lib/pythonApiBase';
import { engorgeGraphEdges } from '../../lib/bayesEngorge';

const LOCAL_SUBMIT_URL = `${PYTHON_API_BASE}/api/bayes/submit`;
const LOCAL_STATUS_URL = `${PYTHON_API_BASE}/api/bayes/status`;

const USAGE = `
dagnet-cli bayes

  Commission a Bayes fit using the same payload construction as the
  browser FE. By default, writes the payload JSON to stdout. With
  --submit, posts to the local Python server and polls until done.

  Options:
    --graph, -g              Path to data repo directory
    --name,  -n              Graph name (filename without .json in graphs/)
    --preflight              POST with binding_receipt: "gate", display receipt
    --submit                 POST, poll until done, display result
    --apply-patch <path>     Apply a Bayes patch JSON to the graph on disk
    --output <path>          Write payload JSON to file instead of stdout
    --format, -f             Output format: json (default), yaml
    --no-cache               Bypass disk bundle cache
    --diagnostic, --diag     Show detailed pipeline trace (per-edge state at each stage)
    --verbose, -v            Show all console.log/warn output
    --help, -h               Show this help

  Environment:
    PYTHON_API_URL   Python BE URL (default: http://localhost:9000)

  Examples:
    # Write payload to stdout
    bash graph-ops/scripts/bayes.sh my-graph

    # Write payload to file
    bash graph-ops/scripts/bayes.sh my-graph --output payload.json

    # Preflight check (dry run against server)
    bash graph-ops/scripts/bayes.sh my-graph --preflight

    # Full submit + poll
    bash graph-ops/scripts/bayes.sh my-graph --submit

    # Apply Bayes results to graph files on disk
    npx tsx src/cli/bayes.ts --graph /path/to/repo --name my-graph --apply-patch /tmp/patch.json
`;

export async function run() {
  try {
    await runBayes();
  } catch (err: any) {
    log.fatal(err.message || String(err));
  }
}

async function runBayes() {
  const ctx = await bootstrap({
    queryOptional: true,
    extraOptions: {
      preflight: { type: 'boolean', default: false },
      submit: { type: 'boolean', default: false },
      'apply-patch': { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, workspace, format, extraArgs } = ctx;
  const preflight = !!extraArgs.preflight;
  const submit = !!extraArgs.submit;
  const applyPatchPath = extraArgs['apply-patch'] as string | undefined;
  const outputPath = extraArgs.output as string | undefined;

  const graphId = `graph-${bundle.graphName}`;
  const graphData = bundle.graph;
  const graphEdges: any[] = graphData?.edges ?? [];

  // -----------------------------------------------------------------------
  // 1. Collect referenced parameter IDs from graph edges
  // -----------------------------------------------------------------------
  const referencedParamIds = new Set<string>();
  for (const edge of graphEdges) {
    for (const slot of ['p', 'cost_gbp', 'labour_cost']) {
      const pid = (edge as any)[slot]?.id;
      if (pid) referencedParamIds.add(pid);
    }
    for (const cp of (edge.conditional_p ?? [])) {
      const cpId = cp?.id;
      if (cpId) referencedParamIds.add(cpId);
    }
  }

  log.info(`Graph has ${referencedParamIds.size} referenced parameter IDs`);

  // -----------------------------------------------------------------------
  // 2. Collect matching parameter files from fileRegistry
  // -----------------------------------------------------------------------
  const parameterFiles: Record<string, unknown> = {};
  const allFiles = fileRegistry.getAllFiles();
  for (const f of allFiles) {
    if (f.type === 'parameter' && f.data) {
      const rawId = f.fileId.replace(/^parameter-/, '');
      if (referencedParamIds.has(rawId)) {
        parameterFiles[f.fileId] = f.data;
      }
    }
  }

  log.info(`Matched ${Object.keys(parameterFiles).length} parameter files`);

  // -----------------------------------------------------------------------
  // 2b. Engorge graph edges — inject observations and priors from param
  //     files onto graph edges (doc 14 §9A). During the parity phase we
  //     still send param files alongside the engorged graph so the BE can
  //     compare both paths.
  // -----------------------------------------------------------------------
  engorgeGraphEdges(graphData, parameterFiles);
  log.info('Engorged graph edges with observations and priors');

  // -----------------------------------------------------------------------
  // 3. Load parameters-index from disk (best-effort)
  // -----------------------------------------------------------------------
  let parametersIndex: unknown = {};
  try {
    const indexPath = join(bundle.graphDir, 'parameters-index.yaml');
    const raw = await readFile(indexPath, 'utf-8');
    const YAML = (await import('js-yaml')).default;
    parametersIndex = YAML.load(raw) ?? {};
  } catch {
    // Non-fatal: index not strictly required
    log.info('No parameters-index.yaml found — using empty index');
  }

  // -----------------------------------------------------------------------
  // 4. Build snapshot subjects from pinned DSL
  // -----------------------------------------------------------------------
  let snapshotSubjects: any[] = [];
  const pinnedDsl = graphData?.dataInterestsDSL;

  if (pinnedDsl && typeof pinnedDsl === 'string' && pinnedDsl.trim()) {
    try {
      const { explodeDSL } = await import('../../lib/dslExplosion');
      const { buildFetchPlanProduction } = await import('../../services/fetchPlanBuilderService');
      const { mapFetchPlanToSnapshotSubjects } = await import('../../services/snapshotDependencyPlanService');
      const { parseConstraints } = await import('../../lib/queryDSL');
      const { resolveRelativeDate, formatDateUK } = await import('../../lib/dateFormat');

      const explodedSlices = await explodeDSL(pinnedDsl);
      log.info(`Pinned DSL exploded into ${explodedSlices.length} slices`);

      for (const sliceDsl of explodedSlices) {
        const constraints = parseConstraints(sliceDsl);
        let dslWindow: { start: string; end: string } | null = null;
        if (constraints.cohort?.start) {
          dslWindow = {
            start: resolveRelativeDate(constraints.cohort.start),
            end: constraints.cohort.end ? resolveRelativeDate(constraints.cohort.end) : formatDateUK(new Date()),
          };
        } else if (constraints.window?.start) {
          dslWindow = {
            start: resolveRelativeDate(constraints.window.start),
            end: constraints.window.end ? resolveRelativeDate(constraints.window.end) : formatDateUK(new Date()),
          };
        }

        if (!dslWindow) continue;

        const { plan } = await buildFetchPlanProduction(graphData, sliceDsl, dslWindow);
        const resolved = await mapFetchPlanToSnapshotSubjects({
          plan,
          analysisType: 'bayes_fit',
          graph: graphData,
          selectedEdgeUuids: [],
          workspace,
          queryDsl: sliceDsl,
        });
        if (resolved?.subjects) {
          snapshotSubjects.push(...resolved.subjects);
        }
      }

      // Flatten target.targetId → edge_id for worker compatibility
      const { getClosureSet } = await import('../../services/hashMappingsService');
      for (const subj of snapshotSubjects) {
        if (subj.target?.targetId && !subj.edge_id) {
          subj.edge_id = subj.target.targetId;
        }
        if (subj.core_hash && !subj.equivalent_hashes?.length) {
          subj.equivalent_hashes = getClosureSet(subj.core_hash);
        }
      }

      log.info(`Built ${snapshotSubjects.length} snapshot subjects`);
    } catch (err: any) {
      log.warn(`Could not build snapshot subjects: ${err.message} — falling back to param files`);
    }
  } else {
    log.info('No dataInterestsDSL on graph — snapshot evidence not available');
  }

  // -----------------------------------------------------------------------
  // 5. Load forecasting settings (best-effort)
  // -----------------------------------------------------------------------
  let forecastingSettings: Record<string, unknown> = {};
  try {
    const { forecastingSettingsService } = await import('../../services/forecastingSettingsService');
    forecastingSettings = await forecastingSettingsService.getForecastingModelSettings() as any;
  } catch {
    // Non-fatal: compiler uses defaults
  }

  // -----------------------------------------------------------------------
  // 6. Build candidate regimes + MECE dimensions
  // -----------------------------------------------------------------------
  let candidateRegimesByEdge: Record<string, Array<{ core_hash: string; equivalent_hashes: string[] }>> = {};
  let meceDimensions: string[] = [];
  try {
    const { buildCandidateRegimesByEdge, computeMeceDimensions } = await import('../../services/candidateRegimeService');
    [candidateRegimesByEdge, meceDimensions] = await Promise.all([
      buildCandidateRegimesByEdge(graphData, workspace, parameterFiles),
      computeMeceDimensions(graphData, workspace),
    ]);
    log.info(`Candidate regimes: ${Object.keys(candidateRegimesByEdge).length} edges, ${meceDimensions.length} MECE dims`);

    // 6b. Add supplementary snapshot subjects for hash families discovered
    // from stored param file slices (Step 5 of buildCandidateRegimesByEdge).
    // The DSL-based subjects (Step 4) only cover hashes from the current
    // pinned DSL. Supplementary regimes from historical/alternative context
    // configurations need corresponding subjects so the DB query returns
    // their rows.
    const existingHashes = new Set(snapshotSubjects.map((s: any) => s.core_hash));
    let nSupplementary = 0;
    for (const [edgeId, regimes] of Object.entries(candidateRegimesByEdge)) {
      for (const regime of regimes) {
        if (existingHashes.has(regime.core_hash)) continue;
        // This regime was discovered from param file slices — no subject exists.
        // Add a minimal subject so the worker queries the DB for this hash.
        snapshotSubjects.push({
          subject_id: `supp_${edgeId}_${regime.core_hash}`,
          param_id: '',  // resolved by worker from edge → param mapping
          core_hash: regime.core_hash,
          equivalent_hashes: (regime.equivalent_hashes ?? []).map(
            (h: string) => ({ core_hash: h })
          ),
          edge_id: edgeId,
          target: { targetId: edgeId },
          read_mode: 'raw_snapshots',
          slice_keys: [],
        });
        existingHashes.add(regime.core_hash);
        nSupplementary++;
      }
    }
    if (nSupplementary > 0) {
      log.info(`Added ${nSupplementary} supplementary snapshot subjects from stored param file slices`);
    }
  } catch (err: any) {
    log.warn(`Failed to build candidate regimes (non-blocking): ${err.message}`);
  }

  // -----------------------------------------------------------------------
  // 7. Fetch Bayes config for db_connection
  // -----------------------------------------------------------------------
  let dbConnection = '';
  if (preflight || submit) {
    try {
      const { fetchBayesConfig } = await import('../../services/bayesService');
      const config = await fetchBayesConfig();
      dbConnection = config.db_connection;
    } catch (err: any) {
      log.warn(`Could not fetch Bayes config: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // 8. Assemble payload
  // -----------------------------------------------------------------------
  const payload: Record<string, unknown> = {
    graph_id: graphId,
    repo: workspace.repository,
    branch: workspace.branch,
    graph_file_path: `${graphId}.yaml`,
    graph_snapshot: graphData,
    parameters_index: parametersIndex,
    parameter_files: parameterFiles,
    settings: forecastingSettings,
    callback_token: '',
    db_connection: dbConnection,
    webhook_url: '',
  };

  if (snapshotSubjects.length > 0) {
    payload.snapshot_subjects = snapshotSubjects;
  }
  if (Object.keys(candidateRegimesByEdge).length > 0) {
    payload.candidate_regimes_by_edge = candidateRegimesByEdge;
  }
  if (meceDimensions.length > 0) {
    payload.mece_dimensions = meceDimensions;
  }

  // Diagnostic: payload summary
  if (isDiagnostic()) {
    log.diag('── Bayes payload detail ──');
    log.diag(`  graph_id=${payload.graph_id}  repo=${payload.repo}  branch=${payload.branch}`);
    log.diag(`  edges=${graphEdges.length}  referenced_param_ids=${referencedParamIds.size}  matched_param_files=${Object.keys(parameterFiles).length}`);
    log.diag(`  snapshot_subjects=${snapshotSubjects.length}  candidate_regime_edges=${Object.keys(candidateRegimesByEdge).length}  mece_dims=[${meceDimensions.join(',')}]`);
    for (const [paramFileId, paramFileData] of Object.entries(parameterFiles)) {
      const data = paramFileData as any;
      const nValues = data?.values?.length ?? 0;
      const nDates = data?.values?.[0]?.dates?.length ?? 0;
      log.diag(`    param_file ${paramFileId}: ${nValues} value set(s), ${nDates} dates`);
    }
  }

  // -----------------------------------------------------------------------
  // 9. Mode dispatch
  // -----------------------------------------------------------------------

  // --apply-patch: apply a Bayes patch file to the graph on disk using the
  // production applyPatch code path (bayesPatchService). This enriches the
  // graph and parameter files with model_vars, posteriors, and promoted
  // latency values — identical to what happens when a webhook result lands
  // in the browser.
  if (applyPatchPath) {
    log.info(`Apply-patch mode — reading patch from ${applyPatchPath}`);

    const patchRaw = await readFile(applyPatchPath, 'utf-8');
    const patchData = JSON.parse(patchRaw);

    // The patch may be a full BayesPatchFile or the raw worker result.
    // If it has webhook_payload_edges (raw result), wrap it.
    const { applyPatch } = await import('../../services/bayesPatchService');
    const { writeBackToDisk } = await import('../diskLoader.js');

    let patch: any;
    if (patchData.webhook_payload_edges) {
      // Raw worker result — wrap into BayesPatchFile shape
      patch = {
        job_id: patchData.job_id || patchData._job_id || 'cli-enrich',
        graph_id: `graph-${bundle.graphName}`,
        graph_file_path: `graph-${bundle.graphName}.yaml`,
        fitted_at: patchData.fitted_at || new Date().toISOString(),
        fingerprint: patchData.fingerprint || '',
        model_version: patchData.model_version ?? 1,
        quality: patchData.quality || { max_rhat: null, min_ess: null, converged_pct: 0 },
        edges: patchData.webhook_payload_edges,
        skipped: patchData.skipped || [],
      };
    } else {
      // Already a BayesPatchFile — ensure graph_id matches the loaded graph
      patch = { ...patchData, graph_id: `graph-${bundle.graphName}` };
    }

    const edgesUpdated = await applyPatch(patch);
    log.info(`Patch applied: ${edgesUpdated}/${patch.edges.length} edges updated`);

    // Write enriched files back to disk
    const written = await writeBackToDisk(bundle);
    log.info(`Written to disk: graph=${written.graph}, ${written.parameters.length} parameter files`);

    // Print per-edge summary to stdout
    const summary: any[] = [];
    for (const edge of patch.edges) {
      const graphEdge = bundle.graph.edges?.find((e: any) => e.p?.id === edge.param_id);
      const mv = graphEdge?.p?.model_vars?.find((m: any) => m.source === 'bayesian');
      summary.push({
        param_id: edge.param_id,
        slices: Object.keys(edge.slices || {}),
        model_vars_source: mv?.source ?? 'none',
        promoted_mu: graphEdge?.p?.latency?.mu,
        promoted_sigma: graphEdge?.p?.latency?.sigma,
        promoted_t95: graphEdge?.p?.latency?.promoted_t95,
      });
    }
    process.stdout.write(JSON.stringify({ edges_updated: edgesUpdated, edges: summary }, null, 2) + '\n');
    return;
  }

  if (preflight) {
    log.info('Preflight mode — submitting with binding_receipt: "preflight"');
    (payload.settings as Record<string, unknown>).binding_receipt = 'preflight';

    const { submitBayesFit, pollUntilDone } = await import('../../services/bayesService');

    const jobId = await submitBayesFit(payload as any, LOCAL_SUBMIT_URL);
    log.info(`Submitted, job_id: ${jobId} — polling for receipt…`);

    const finalStatus = await pollUntilDone(
      jobId,
      (status) => {
        if (status.progress) {
          log.info(`[${Math.max(0, status.progress.pct)}%] ${status.progress.detail || status.progress.stage || 'running'}`);
        }
      },
      2_000,     // poll every 2s (preflight is fast — no MCMC)
      120 * 1000, // 120s timeout (DB query + evidence binding)
      LOCAL_STATUS_URL,
    );

    // Extract binding receipt from the result if present
    const result = finalStatus.result as Record<string, unknown> | undefined;
    const receipt = result?.binding_receipt ?? finalStatus;

    const output = format === 'yaml'
      ? (await import('js-yaml')).default.dump(receipt, { lineWidth: -1 })
      : JSON.stringify(receipt, null, 2);

    if (finalStatus.status === 'complete' && !finalStatus.error) {
      log.info('Preflight passed');
    } else {
      log.error(`Preflight: ${finalStatus.error || finalStatus.status}`);
    }

    process.stdout.write(output + '\n');
    return;
  }

  if (submit) {
    log.info('Submit mode — posting to local Python server and polling');
    const { submitBayesFit, pollUntilDone } = await import('../../services/bayesService');

    const jobId = await submitBayesFit(payload as any, LOCAL_SUBMIT_URL);
    log.info(`Submitted, job_id: ${jobId}`);

    const finalStatus = await pollUntilDone(
      jobId,
      (status) => {
        if (status.progress) {
          const pct = Math.max(0, status.progress.pct);
          log.info(`[${pct}%] ${status.progress.detail || status.progress.stage || 'running'}`);
        }
      },
      5_000,
      10 * 60 * 1000,
      LOCAL_STATUS_URL,
    );

    if (finalStatus.status === 'complete') {
      log.info('Bayes fit complete');
    } else {
      log.error(`Bayes fit ${finalStatus.status}: ${finalStatus.error || 'unknown error'}`);
    }

    const output = format === 'yaml'
      ? (await import('js-yaml')).default.dump(finalStatus, { lineWidth: -1 })
      : JSON.stringify(finalStatus, null, 2);

    process.stdout.write(output + '\n');
    return;
  }

  // Default: output payload to stdout or file.
  // Payload is always JSON — it's a machine-readable artefact consumed by
  // the Python server or test harness. The --format flag only affects
  // display output (receipt, result), not the payload itself.
  const payloadJson = JSON.stringify(payload, null, 2);

  if (outputPath) {
    await writeFile(outputPath, payloadJson + '\n', 'utf-8');
    log.info(`Payload written to ${outputPath}`);
  } else {
    process.stdout.write(payloadJson + '\n');
  }
}
