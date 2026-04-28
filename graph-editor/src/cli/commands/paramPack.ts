/**
 * param-pack command — produce a param pack for a graph.
 *
 * Uses shared bootstrap for graph loading + registry seeding,
 * then runs aggregation + LAG pass + param extraction + serialisation.
 */

import { log, isDiagnostic, exit } from '../logger';
import { bootstrap } from '../bootstrap';
import { extractParamsFromGraph } from '../../services/GraphParamExtractor';
import { flattenParams, toYAML, toJSON, toCSV } from '../../services/ParamPackDSLService';
import { computePlausibleSignaturesForEdge } from '../../services/snapshotRetrievalsService';
import { sessionLogService } from '../../services/sessionLogService';
import { aggregateAndPopulateGraph } from '../aggregate';

const USAGE = `
dagnet-cli param-pack

  Produce a param pack (edge probabilities, latency, evidence/forecast)
  for a graph, evaluated against a query DSL expression.

  Options:
    --graph, -g              Path to data repo directory
    --name,  -n              Graph name (filename without .json in graphs/)
    --query, -q              Query DSL expression (e.g. "window(1-Dec-25:20-Dec-25)")
    --get <key>              Extract a single value (bare scalar to stdout)
    --format, -f             Output format: yaml (default), json, csv
    --show-signatures        Show computed signatures per edge (diagnostic)
    --diag-model-vars        Emit per-edge model_vars blocks as JSON on stdout.
                             Suppresses the normal param-pack output.
    --bayes-vars <path>      Inject Bayesian posteriors from a .bayes-vars.json
                             sidecar into the graph in-memory before aggregation.
                             No disk writes.
    --force-vars             With --bayes-vars, bypass the rhat/ess quality
                             gates so low-quality posteriors still apply.
    --diagnostic, --diag     Show detailed pipeline trace (per-edge state at each stage)
    --verbose, -v            Show all console.log/warn output (LAG debug, etc.)
    --session-log            Show session log output
    --allow-external-fetch   Allow fetching from external sources if cache is stale/missing
    --no-snapshot-cache      Bypass the BE snapshot service in-memory TTL cache
                             (essential during synth-gen cycles or after BE code edits)
    --no-be                  Suppress every BE-bound call in the run.
                             Functionally equivalent to running offline. For
                             param-pack the only BE call today is the conditioned
                             forecast, so --no-be makes p.mean / completeness
                             reflect FE-topo Step 2 provisional values only.
                             Pack metadata records be_skipped: true.
    --help, -h               Show this help

  Environment:
    PYTHON_API_URL   Python BE URL (default: http://localhost:9000)

  Amplitude credentials are auto-loaded from .env.amplitude.local
  at the repo root. No manual env setup needed.

  Examples:
    bash graph-ops/scripts/param-pack.sh my-graph "window(1-Dec-25:20-Dec-25)"
    bash graph-ops/scripts/param-pack.sh my-graph "context(channel:google).window(-30d:)" --format json
`;

export async function run() {
  try {
    await runParamPack();
  } catch (err: any) {
    log.fatal(err.message || String(err));
  }
}

async function runParamPack() {
  const ctx = await bootstrap({
    extraOptions: {
      'no-snapshot-cache': { type: 'boolean' },
      'no-be': { type: 'boolean' },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    exit(1, 'usage');
  }

  const { bundle, queryDsl, getKey, format, flags, workspace, extraArgs } = ctx;

  // Bypass the BE snapshot service in-memory cache. Essential during
  // synth-gen cycles and for test correctness when BE Python edits may
  // have left stale cached results behind.
  if (extraArgs['no-snapshot-cache']) {
    (globalThis as any).__dagnetComputeNoCache = true;
  }

  // Signatures diagnostic
  if (flags.showSignatures) {
    log.info('Computing signatures per edge...');
    for (const edge of bundle.graph.edges || []) {
      const edgeId = edge.id || edge.uuid;
      try {
        const sigs = await computePlausibleSignaturesForEdge({
          graph: bundle.graph,
          edgeId: edge.uuid || edge.id,
          effectiveDSL: queryDsl,
        });
        log.info(`  ${edgeId}: ${sigs.length} signature(s)`);
        for (const sig of sigs) {
          log.info(`    hash=${sig.identityHash}  keys=[${sig.contextKeys.join(',')}]  dbParam=${sig.dbParamId}`);
        }
      } catch (err: any) {
        log.error(`  ${edgeId}: ${err.message}`);
      }
    }
  }

  // Aggregate + LAG pass
  // 'from-file' = cache only; 'versioned' = cache first, API if stale/missing
  const fetchMode = flags.allowExternalFetch ? 'versioned' as const : 'from-file' as const;
  // Doc 73e §8.3 Stage 6 — `--no-be` suppresses every BE-bound call.
  // For param-pack the only BE call today is CF; with the flag set,
  // p.mean and completeness reflect FE-topo Step 2 provisional values only.
  const skipBackendCalls = !!extraArgs['no-be'];
  if (skipBackendCalls) {
    log.info('--no-be set: BE calls disabled; output reflects FE-topo provisional values only');
    sessionLogService.info('session', 'NO_BE_FLAG',
      'param-pack: --no-be set; output reflects FE-topo provisional values only',
      'be_disabled_by_flag');
  }
  log.info(`Aggregating parameter data for requested window (mode: ${fetchMode})...`);
  const { graph: populatedGraph, warnings } = await aggregateAndPopulateGraph(bundle, queryDsl, {
    mode: fetchMode,
    workspace,
    skipBackendCalls,
  });
  for (const w of warnings) {
    log.warn(w);
  }

  // NOTE: FE topo, BE topo, conditioned forecast, promotion cascade, and
  // UpdateManager all ran inside `aggregateAndPopulateGraph` via
  // `fetchItems → runStage2EnhancementsAndInboundN`. This is the same
  // code path the browser uses — the CLI simulates exactly what the app
  // would produce. Doc 45 §Delivery model requires a single pipeline.
  //
  // A previous bespoke `runCliTopoPass` call here invoked BE topo a
  // second time and bypassed the promotion cascade by writing directly
  // to `edge.p.latency.*`. It was redundant and inconsistent with the
  // browser, and is now removed.

  // --diag-model-vars: emit per-edge model_vars blocks as JSON, then exit.
  if (flags.diagModelVars) {
    const perEdge: Record<string, unknown[]> = {};
    for (const edge of populatedGraph.edges || []) {
      const key = (edge as any).uuid || (edge as any).id;
      if (!key) continue;
      perEdge[key] = (edge as any).p?.model_vars ?? [];
    }
    process.stdout.write(JSON.stringify({ model_vars_by_edge: perEdge }, null, 2) + '\n');
    return;
  }

  // Extract + serialise
  const params = extractParamsFromGraph(populatedGraph);
  const edgeCount = Object.keys(params.edges ?? {}).length;
  const nodeCount = Object.keys(params.nodes ?? {}).length;
  log.info(`Extracted params: ${edgeCount} edges, ${nodeCount} nodes`);

  // Diagnostic: full extracted param pack inventory
  if (isDiagnostic()) {
    log.diag('── Param extraction: full key inventory ──');
    const flat = flattenParams(params);
    const allKeys = Object.keys(flat).sort();
    for (const key of allKeys) {
      log.diag(`  ${key} = ${JSON.stringify(flat[key])}`);
    }
    log.diag(`  ${allKeys.length} keys total`);
  }

  // --get: extract a single scalar value
  if (getKey) {
    const flat = flattenParams(params);
    const value = flat[getKey];
    if (value === undefined) {
      log.error(`key '${getKey}' not found in param pack`);
      // Try to suggest: match on edge/node ID (second segment) if present
      const segments = getKey.split('.');
      const edgeOrNodeId = segments.length >= 2 ? segments[1] : getKey;
      const suggestions = Object.keys(flat).filter(k => k.includes(edgeOrNodeId));
      if (suggestions.length > 0) {
        log.info(`Available keys for '${edgeOrNodeId}':`);
        for (const k of suggestions) log.info(`  ${k}`);
      }
      exit(1, `key '${getKey}' not found in param pack`);
    }
    process.stdout.write(String(value) + '\n');
    return;
  }

  // Full param pack output
  let output: string;
  switch (format) {
    case 'json':
      output = toJSON(params, 'flat');
      break;
    case 'csv':
      output = toCSV(params);
      break;
    case 'yaml':
    default:
      output = toYAML(params, 'flat');
      break;
  }

  if (skipBackendCalls) {
    output = injectBeSkippedMeta(output, format);
  }

  process.stdout.write(output + '\n');
}

/**
 * Doc 73e §8.3 Stage 6 item 6 — inject `meta.be_skipped: true` into the
 * serialised param-pack output when the run was produced under `--no-be`.
 * Downstream consumers cannot otherwise distinguish FE-topo provisional
 * `p.mean` from a BE-authoritative CF value.
 *
 * Format-aware so we don't re-implement serialisation. The key lives in
 * the `meta.*` namespace which never collides with edge or node fields
 * (`e.*` / `n.*`).
 *
 * Exported for unit testing.
 */
export function injectBeSkippedMeta(output: string, format: 'yaml' | 'json' | 'csv'): string {
  switch (format) {
    case 'json': {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      return JSON.stringify({ 'meta.be_skipped': true, ...parsed }, null, 2);
    }
    case 'csv':
      return output.replace(/^key,value\n/, 'key,value\nmeta.be_skipped,true\n');
    case 'yaml':
    default:
      return `meta.be_skipped: true\n${output}`;
  }
}
