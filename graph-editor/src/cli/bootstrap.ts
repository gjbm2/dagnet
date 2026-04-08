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

import { execSync } from 'node:child_process';
import { log } from './logger';
import type { GraphBundle } from './diskLoader';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface CLIContext {
  bundle: GraphBundle;
  graphDir: string;
  graphName: string;
  queryDsl: string;
  /** Workspace identity derived from data repo git state.
   *  Used for workspace-prefixed param_ids in snapshot DB lookups. */
  workspace: { repository: string; branch: string };
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
  extraOptions?: Record<string, { type: 'string' | 'boolean'; short?: string; default?: any; multiple?: boolean }>;
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

  log.info(`Loading graph '${graphName}' from ${graphDir}...`);
  const bundle = noCache
    ? await loadGraphFromDisk(graphDir, graphName)
    : await loadGraphFromDiskCached(graphDir, graphName);

  // Detect workspace from data repo git state for correct param_id prefixing
  let workspace = { repository: 'cli', branch: 'local' };
  try {
    const repoName = execSync('basename $(git remote get-url origin) .git', { cwd: graphDir, encoding: 'utf-8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: graphDir, encoding: 'utf-8' }).trim();
    if (repoName && branch) {
      workspace = { repository: repoName, branch };
    }
  } catch {
    log.info('Could not detect workspace from git — using cli/local');
  }

  seedFileRegistry(bundle, workspace);

  log.info(`Loaded: ${bundle.events.size} events, ${bundle.contexts.size} contexts, ${bundle.parameters.size} parameters`);
  log.info(`Graph has ${bundle.graph.nodes?.length ?? 0} nodes, ${bundle.graph.edges?.length ?? 0} edges`);
  log.info(`Workspace: ${workspace.repository}/${workspace.branch}`);
  if (queryDsl) log.info(`Query DSL: ${queryDsl}`);

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
    workspace,
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
