/**
 * hydrate command — run FE aggregation + promotion + BE topo pass on a
 * graph, then write the hydrated graph back to disk.
 *
 * Produces a graph JSON that is equivalent to what the FE would have
 * after opening the graph, loading parameter data, and running the
 * full Stage 2 topo pass. This is essential for testing: without
 * hydration, synth graphs lack p.mean, p.forecast.mean, path params,
 * completeness, and other fields that the live system populates.
 *
 * Usage:
 *   npx tsx src/cli/commands/hydrate.ts --name synth-mirror-4step --query "window(-90d:)"
 *
 * Requires the Python BE to be running.
 */

import { log } from '../logger';
import { bootstrap } from '../bootstrap';
import { aggregateAndPopulateGraph } from '../aggregate';
import { runCliTopoPass } from '../topoPass';
import { writeFileSync } from 'fs';
import { join } from 'path';

const USAGE = `
dagnet-cli hydrate

  Hydrate a graph: aggregate param data, run promotion + FE topo pass +
  BE topo pass, write the populated graph back to disk.

  Options:
    --name,  -n              Graph name (filename without .json in graphs/)
    --query, -q              Query DSL expression (e.g. "window(-90d:)")
    --allow-external-fetch   Allow fetching from external sources
    --diagnostic, --diag     Show detailed pipeline trace (per-edge state at each stage)
    --verbose, -v            Show all console.log/warn output
    --help, -h               Show this help

  Environment:
    PYTHON_API_URL   Python BE URL (default: http://localhost:9000)

  Examples:
    npx tsx src/cli/commands/hydrate.ts --name synth-mirror-4step --query "window(-90d:)"
    npx tsx src/cli/commands/hydrate.ts -n my-graph -q "cohort(-30d:)"
`;

export async function runHydrate(): Promise<void> {
  const ctx = await bootstrap();
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }
  const { bundle, queryDsl, workspace, flags } = ctx;

  if (!queryDsl) {
    console.error(USAGE);
    process.exit(1);
  }

  // Aggregate + FE LAG pass (same as param-pack)
  const fetchMode = flags.allowExternalFetch ? 'versioned' as const : 'from-file' as const;
  log.info(`Hydrating graph (mode: ${fetchMode}, query: ${queryDsl})...`);
  const { graph: populatedGraph, warnings } = await aggregateAndPopulateGraph(bundle, queryDsl, { mode: fetchMode });
  for (const w of warnings) {
    log.warn(w);
  }

  // BE topo pass — engine-computed completeness, blended rate, dispersions
  log.info('Running BE topo pass...');
  await runCliTopoPass(populatedGraph, bundle.parameters, queryDsl, workspace);

  // Write back to disk
  const graphPath = join(bundle.graphDir, 'graphs', `${bundle.graphName}.json`);
  writeFileSync(graphPath, JSON.stringify(populatedGraph, null, 2) + '\n');
  log.info(`Wrote hydrated graph to ${graphPath}`);

  // Summary
  let edgesWithMean = 0;
  let edgesWithPath = 0;
  for (const edge of populatedGraph.edges || []) {
    const p = edge.p || {};
    if (p.mean != null) edgesWithMean++;
    if (p.latency?.path_mu != null) edgesWithPath++;
  }
  log.info(`  ${edgesWithMean} edges with p.mean, ${edgesWithPath} edges with path params`);
}

// Direct execution
runHydrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
