/**
 * param-pack command — produce a param pack for a graph.
 *
 * Uses shared bootstrap for graph loading + registry seeding,
 * then runs aggregation + LAG pass + param extraction + serialisation.
 */

import { log, isDiagnostic } from '../logger';
import { bootstrap } from '../bootstrap';
import { extractParamsFromGraph } from '../../services/GraphParamExtractor';
import { flattenParams, toYAML, toJSON, toCSV } from '../../services/ParamPackDSLService';
import { computePlausibleSignaturesForEdge } from '../../services/snapshotRetrievalsService';
import { aggregateAndPopulateGraph } from '../aggregate';
import { runCliTopoPass } from '../topoPass';

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
    --diagnostic, --diag     Show detailed pipeline trace (per-edge state at each stage)
    --verbose, -v            Show all console.log/warn output (LAG debug, etc.)
    --session-log            Show session log output
    --allow-external-fetch   Allow fetching from external sources if cache is stale/missing
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
  const ctx = await bootstrap();
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, queryDsl, workspace, getKey, format, flags } = ctx;

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
  log.info(`Aggregating parameter data for requested window (mode: ${fetchMode})...`);
  const { graph: populatedGraph, warnings } = await aggregateAndPopulateGraph(bundle, queryDsl, { mode: fetchMode });
  for (const w of warnings) {
    log.warn(w);
  }

  // BE topo pass — engine-computed completeness, blended rate, dispersions.
  // Overwrites FE-only values with engine values. Falls back gracefully
  // if the BE is unreachable.
  log.info('Running BE topo pass...');
  await runCliTopoPass(populatedGraph, bundle.parameters, queryDsl, workspace);

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
      process.exit(1);
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

  process.stdout.write(output + '\n');
}
