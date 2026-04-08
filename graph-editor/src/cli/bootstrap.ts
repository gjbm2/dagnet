/**
 * CLI bootstrap — shared infrastructure for all dagnet-cli commands.
 *
 * Handles:
 *   1. Console suppression (before any module-level logging)
 *   2. fake-indexeddb setup (before Dexie)
 *   3. Graph loading from disk
 *   4. fileRegistry + contextRegistry seeding
 *
 * Each command module exports an async `run(context)` function that
 * receives the loaded graph bundle and parsed args.
 */

import type { GraphBundle } from './diskLoader';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface CLIContext {
  bundle: GraphBundle;
  graphDir: string;
  graphName: string;
  queryDsl: string;
  /** Single key to extract (bare scalar output). Overrides format. */
  getKey: string | undefined;
  format: 'yaml' | 'json' | 'csv';
  flags: {
    verbose: boolean;
    sessionLog: boolean;
    showSignatures: boolean;
    allowExternalFetch: boolean;
  };
}

export interface CLICommandOptions {
  /** Additional parseArgs options beyond the shared ones */
  extraOptions?: Record<string, { type: 'string' | 'boolean'; short?: string; default?: any }>;
  /** If true, --query is not required */
  queryOptional?: boolean;
}

// ------------------------------------------------------------------
// Shared option definitions
// ------------------------------------------------------------------

export const SHARED_OPTIONS = {
  graph: { type: 'string' as const, short: 'g' },
  name: { type: 'string' as const, short: 'n' },
  query: { type: 'string' as const, short: 'q' },
  get: { type: 'string' as const },
  format: { type: 'string' as const, short: 'f', default: 'yaml' },
  'allow-external-fetch': { type: 'boolean' as const, default: false },
  'show-signatures': { type: 'boolean' as const, default: false },
  'no-cache': { type: 'boolean' as const, default: false },
  verbose: { type: 'boolean' as const, short: 'v', default: false },
  'session-log': { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, short: 'h', default: false },
} as const;

// ------------------------------------------------------------------
// Bootstrap + load
// ------------------------------------------------------------------

/**
 * Parse shared CLI args, load graph from disk, seed registries.
 * Returns a CLIContext ready for command-specific logic.
 */
export async function bootstrap(
  commandOptions?: CLICommandOptions,
): Promise<CLIContext & { extraArgs: Record<string, any> }> {
  const { parseArgs } = await import('node:util');

  const allOptions: Record<string, any> = { ...SHARED_OPTIONS };
  if (commandOptions?.extraOptions) {
    Object.assign(allOptions, commandOptions.extraOptions);
  }

  const { values: args } = parseArgs({ options: allOptions, strict: true });

  if (args.help || !args.graph || !args.name || (!args.query && !commandOptions?.queryOptional)) {
    return null as any; // caller checks and prints usage
  }

  const { loadGraphFromDisk, loadGraphFromDiskCached, seedFileRegistry } = await import('./diskLoader.js');

  const graphDir = args.graph as string;
  const graphName = args.name as string;
  const queryDsl = (args.query as string) || '';
  const getKey = (args.get as string) || undefined;
  const noCache = !!args['no-cache'];
  const format = ((args.format as string) || 'yaml') as 'yaml' | 'json' | 'csv';

  console.error(`[cli] Loading graph '${graphName}' from ${graphDir}...`);
  const bundle = noCache
    ? await loadGraphFromDisk(graphDir, graphName)
    : await loadGraphFromDiskCached(graphDir, graphName);
  seedFileRegistry(bundle);

  console.error(`[cli] Loaded: ${bundle.events.size} events, ${bundle.contexts.size} contexts, ${bundle.parameters.size} parameters`);
  console.error(`[cli] Graph has ${bundle.graph.nodes?.length ?? 0} nodes, ${bundle.graph.edges?.length ?? 0} edges`);
  if (queryDsl) console.error(`[cli] Query DSL: ${queryDsl}`);

  // Extract extra args (command-specific options)
  const extraArgs: Record<string, any> = {};
  if (commandOptions?.extraOptions) {
    for (const key of Object.keys(commandOptions.extraOptions)) {
      extraArgs[key] = args[key];
    }
  }

  return {
    bundle,
    graphDir,
    graphName,
    queryDsl,
    getKey,
    format,
    flags: {
      verbose: !!args.verbose,
      sessionLog: !!args['session-log'],
      showSignatures: !!args['show-signatures'],
      allowExternalFetch: !!args['allow-external-fetch'],
    },
    extraArgs,
  };
}
