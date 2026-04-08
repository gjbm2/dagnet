/**
 * param-pack command — produce a param pack for a graph.
 *
 * Uses shared bootstrap for graph loading + registry seeding,
 * then runs aggregation + LAG pass + param extraction + serialisation.
 */

import { bootstrap } from '../bootstrap';
import { extractParamsFromGraph } from '../../services/GraphParamExtractor';
import { flattenParams, toYAML, toJSON, toCSV } from '../../services/ParamPackDSLService';
import { computePlausibleSignaturesForEdge } from '../../services/snapshotRetrievalsService';
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
    --verbose, -v            Show all console.log/warn output (LAG debug, etc.)
    --session-log            Show session log output
    --allow-external-fetch   Enable external source fetching (not yet implemented)
    --help, -h               Show this help

  Environment:
    PYTHON_API_URL   Python BE URL (default: http://localhost:9000)

  Examples:
    bash graph-ops/scripts/param-pack.sh my-graph "window(1-Dec-25:20-Dec-25)"
    bash graph-ops/scripts/param-pack.sh my-graph "context(channel:google).window(-30d:)" --format json
`;

export async function run() {
  const ctx = await bootstrap();
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }

  const { bundle, queryDsl, getKey, format, flags } = ctx;

  // Signatures diagnostic
  if (flags.showSignatures) {
    console.error(`\n[cli] Computing signatures per edge...`);
    for (const edge of bundle.graph.edges || []) {
      const edgeId = edge.id || edge.uuid;
      try {
        const sigs = await computePlausibleSignaturesForEdge({
          graph: bundle.graph,
          edgeId: edge.uuid || edge.id,
          effectiveDSL: queryDsl,
        });
        console.error(`  ${edgeId}: ${sigs.length} signature(s)`);
        for (const sig of sigs) {
          console.error(`    hash=${sig.coreHash}  keys=[${sig.contextKeys.join(',')}]  dbParam=${sig.dbParamId}`);
        }
      } catch (err: any) {
        console.error(`  ${edgeId}: ERROR — ${err.message}`);
      }
    }
  }

  // Aggregate + LAG pass
  console.error(`[cli] Aggregating parameter data for requested window...`);
  const { graph: populatedGraph, warnings } = aggregateAndPopulateGraph(bundle, queryDsl);
  for (const w of warnings) {
    console.error(`[cli] WARNING: ${w}`);
  }

  // Extract + serialise
  const params = extractParamsFromGraph(populatedGraph);
  const edgeCount = Object.keys(params.edges ?? {}).length;
  const nodeCount = Object.keys(params.nodes ?? {}).length;
  console.error(`[cli] Extracted params: ${edgeCount} edges, ${nodeCount} nodes`);

  // --get: extract a single scalar value
  if (getKey) {
    const flat = flattenParams(params);
    const value = flat[getKey];
    if (value === undefined) {
      console.error(`[cli] ERROR: key '${getKey}' not found in param pack`);
      // Try to suggest: match on edge/node ID (second segment) if present
      const segments = getKey.split('.');
      const edgeOrNodeId = segments.length >= 2 ? segments[1] : getKey;
      const suggestions = Object.keys(flat).filter(k => k.includes(edgeOrNodeId));
      if (suggestions.length > 0) {
        console.error(`[cli] Available keys for '${edgeOrNodeId}':`);
        for (const k of suggestions) console.error(`  ${k}`);
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
