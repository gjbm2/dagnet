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
import { log, isDiagnostic } from './logger';
import { fileRegistry } from '../contexts/TabContext';
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
    diagnostic: boolean;
    sessionLog: boolean;
    showSignatures: boolean;
    allowExternalFetch: boolean;
    /** Emit per-edge model_vars blocks as JSON on stdout for diagnostics. */
    diagModelVars: boolean;
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
  'diag-model-vars': { type: 'boolean' as const, default: false },
  'no-cache': { type: 'boolean' as const, default: false },
  'bayes-vars': { type: 'string' as const },
  'force-vars': { type: 'boolean' as const, default: false },
  verbose: { type: 'boolean' as const, short: 'v', default: false },
  diagnostic: { type: 'boolean' as const, default: false },
  diag: { type: 'boolean' as const, default: false },
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

  // Diagnostic: detailed graph + parameter inventory
  if (isDiagnostic()) {
    log.diag('── Graph load detail ──');
    for (const node of (bundle.graph.nodes || [])) {
      log.diag(`  node: ${node.id || node.uuid} (label: ${node.label || node.name || '—'})`);
    }
    for (const edge of (bundle.graph.edges || [])) {
      const eid = edge.id || edge.uuid;
      const pId = edge.p?.id || '—';
      const hasMean = edge.p?.mean != null;
      const hasLatency = edge.p?.latency != null;
      const hasModelVars = Array.isArray(edge.p?.model_vars) && edge.p.model_vars.length > 0;
      log.diag(`  edge: ${eid}  param_id=${pId}  p.mean=${hasMean ? edge.p.mean : '—'}  latency=${hasLatency}  model_vars=${hasModelVars}`);
    }
    log.diag(`  parameter files: ${Array.from(bundle.parameters.keys()).join(', ') || '(none)'}`);
    for (const [paramId, paramData] of Array.from(bundle.parameters)) {
      const vals = paramData.values || [];
      const v = vals[0];
      const nDates = v?.dates?.length ?? 0;
      const nDaily = v?.n_daily?.length ?? 0;
      log.diag(`    ${paramId}: ${vals.length} value set(s), ${nDates} dates, ${nDaily} daily obs`);
    }
  }

  // ── Bayesian sidebar vars injection ──────────────────────────────────────
  // When --bayes-vars <path> is supplied, replay the sidecar through the
  // same applyPatch codepath the browser uses when a webhook patch lands.
  // The mutation is in-memory only — no disk writes — and propagates to
  // bundle.graph + bundle.parameters so every downstream command sees the
  // enriched graph as its base. --force-vars bypasses the rhat/ess gates.
  const bayesVarsPath = args['bayes-vars'] as string | undefined;
  if (bayesVarsPath) {
    const { readFile: readFileAsync } = await import('node:fs/promises');
    const { applyPatchAndCascade, wrapPatchIfRaw, setQualityGateOverride } =
      await import('../services/bayesPatchService.js');

    log.info(`Injecting Bayesian vars from ${bayesVarsPath}`);
    const patchRaw = await readFileAsync(bayesVarsPath, 'utf-8');
    const patchData = JSON.parse(patchRaw);
    const graphId = `graph-${graphName}`;
    const patch = wrapPatchIfRaw(patchData, graphId);

    if (args['force-vars']) {
      log.info('--force-vars set: bypassing rhat/ess quality gates');
      setQualityGateOverride(true);
    }
    try {
      // Use the same applyPatchAndCascade entry point as the FE
      // (useBayesTrigger → fetchAndApplyPatch → applyPatchAndCascade).
      // Tier 2 (GraphStore cascade) no-ops in CLI because no store is
      // mounted; Tier 1 writes posteriors + _bayes + model_vars to the
      // in-memory fileRegistry identically to the browser.
      const { edgesUpdated } = await applyPatchAndCascade(patch, graphId);
      log.info(`Bayes vars applied: ${edgesUpdated}/${patch.edges.length} edges updated`);
    } finally {
      // Always reset the override so a long-lived process (tests, REPL)
      // does not leak the bypass state across runs.
      if (args['force-vars']) setQualityGateOverride(false);
    }

    // applyPatch calls fileRegistry.updateFile(...), which replaces file.data
    // with the new object reference. bundle.graph and bundle.parameters were
    // pointing at the pre-injection objects, so re-bind them from the registry
    // to keep downstream consumers aligned with the enriched state.
    const enrichedGraph = fileRegistry.getFile(graphId)?.data;
    if (enrichedGraph) {
      bundle.graph = enrichedGraph;
    }
    for (const id of Array.from(bundle.parameters.keys())) {
      const enrichedParam = fileRegistry.getFile(`parameter-${id}`)?.data;
      if (enrichedParam) {
        bundle.parameters.set(id, enrichedParam);
      }
    }
  }

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
      diagnostic: !!args.diagnostic || !!args.diag,
      sessionLog: !!args['session-log'],
      showSignatures: !!args['show-signatures'],
      allowExternalFetch: !!args['allow-external-fetch'],
      diagModelVars: !!args['diag-model-vars'],
    },
    extraArgs,
  };
}
