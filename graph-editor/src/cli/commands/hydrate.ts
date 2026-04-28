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
    --no-be                  Accepted for CLI surface uniformity. Hydrate's
                             contract is to materialise the graph the live
                             system would produce, which includes BE-driven
                             CF; this flag is a no-op here. (Doc 73e §8.3
                             Stage 6 item 3.)
    --bayes-vars <path>      Inject Bayesian posteriors from a .bayes-vars.json
                             sidecar before hydration. The hydrated graph
                             written to disk will carry the injected posteriors.
    --force-vars             With --bayes-vars, bypass the rhat/ess quality
                             gates so low-quality posteriors still apply.
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
  // Doc 73e §8.3 Stage 6 item 3 — accept `--no-be` silently as a no-op
  // for CLI surface uniformity. Hydrate's contract is to materialise
  // the graph the live system would produce, which includes BE-driven CF;
  // disabling BE during hydrate would break that contract.
  const ctx = await bootstrap({
    extraOptions: {
      'no-be': { type: 'boolean' },
    },
  });
  if (!ctx) {
    console.error(USAGE);
    process.exit(1);
  }
  const { bundle, queryDsl, flags, workspace } = ctx;

  if (!queryDsl) {
    console.error(USAGE);
    process.exit(1);
  }

  // Aggregate → FE topo + CF + promotion + UpdateManager.
  // aggregateAndPopulateGraph delegates to fetchItems which runs the
  // exact same Stage-2 pipeline the browser uses, with
  // awaitBackgroundPromises so the CF subsequent-overwrite .then()
  // finishes before returning. No bespoke CLI topo call is needed —
  // the previous `runCliTopoPass` here was a redundant second round-trip
  // that bypassed the shared pipeline.
  const fetchMode = flags.allowExternalFetch ? 'versioned' as const : 'from-file' as const;
  log.info(`Hydrating graph (mode: ${fetchMode}, query: ${queryDsl})...`);
  const { graph: populatedGraph, warnings } = await aggregateAndPopulateGraph(bundle, queryDsl, {
    mode: fetchMode,
    workspace,
  });
  for (const w of warnings) {
    log.warn(w);
  }

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
