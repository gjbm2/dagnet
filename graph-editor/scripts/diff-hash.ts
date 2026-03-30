#!/usr/bin/env npx tsx
/**
 * diff-hash — Compare hashes before and after a file change.
 *
 * Computes old hashes (from git baseline) and new hashes (from working copy)
 * for all edges affected by a changed event/context file.
 *
 * Usage:
 *   cd graph-editor
 *   npx tsx scripts/diff-hash.ts \
 *     --file path/to/changed-event.yaml \
 *     --graph path/to/graph.json \
 *     --events-dir path/to/events/ \
 *     --contexts-dir path/to/contexts/ \
 *     [--baseline HEAD]
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

// ─────────────────────────────────────────────────────────────────────────────
// Patch contextRegistry (same as compute-hash.ts)
// ─────────────────────────────────────────────────────────────────────────────

let contextsDir: string | undefined;
const contextCache = new Map<string, any>();
let contextOverride: { id: string; data: any } | undefined;

async function loadContextFromDisk(id: string): Promise<any | undefined> {
  // If we have an override for this id (old version from git), use it
  if (contextOverride?.id === id) return contextOverride.data;
  if (contextCache.has(id)) return contextCache.get(id);
  if (!contextsDir) return undefined;

  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.join(contextsDir, `${id}${ext}`);
    if (fs.existsSync(filePath)) {
      const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
      contextCache.set(id, parsed);
      return parsed;
    }
  }

  const files = fs.readdirSync(contextsDir).filter(f => /\.ya?ml$/.test(f));
  for (const file of files) {
    const filePath = path.join(contextsDir, file);
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
    if (parsed?.id === id) {
      contextCache.set(id, parsed);
      return parsed;
    }
  }
  return undefined;
}

import { contextRegistry } from '../src/services/contextRegistry';
(contextRegistry as any).getContext = async (id: string) => loadContextFromDisk(id);

import { computeQuerySignature } from '../src/services/dataOperations/querySignature';
import { computeShortCoreHash } from '../src/services/coreHashService';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadEventDefinitions(eventsDir: string): Record<string, any> {
  const defs: Record<string, any> = {};
  if (!fs.existsSync(eventsDir)) return defs;
  for (const file of fs.readdirSync(eventsDir).filter(f => /\.ya?ml$/.test(f))) {
    const parsed = yaml.load(fs.readFileSync(path.join(eventsDir, file), 'utf8')) as any;
    if (parsed?.id) defs[parsed.id] = parsed;
  }
  return defs;
}

function extractContextKeys(graph: any, edge?: any): string[] {
  const keys = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/context\(([^):]+)/g)) keys.add(m[1]);
  };
  if (graph.dataInterestsDSL) scan(graph.dataInterestsDSL);
  if (edge?.query) scan(edge.query);
  return Array.from(keys).sort();
}

function getGitBaseline(filePath: string, baseline: string): string | null {
  try {
    // Get the path relative to the git repo root
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: path.dirname(filePath),
      encoding: 'utf8',
    }).trim();
    const relPath = path.relative(repoRoot, filePath);
    return execSync(`git show ${baseline}:${relPath}`, {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    return null; // File doesn't exist in baseline (new file)
  }
}

async function computeEdgeHash(
  graph: any,
  edge: any,
  connection: string,
  eventDefs: Record<string, any>,
): Promise<string> {
  const contextKeys = extractContextKeys(graph, edge);
  const signature = await computeQuerySignature(
    { context: contextKeys.map(k => ({ key: k })), event_filters: {}, case: [] },
    connection,
    graph, edge, contextKeys, undefined, eventDefs,
  );
  return computeShortCoreHash(signature);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = '', graphPath = '', eventsDir = '', ctxDir = '';
  let baseline = 'HEAD', connection = 'amplitude';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file': filePath = args[++i]; break;
      case '--graph': graphPath = args[++i]; break;
      case '--events-dir': eventsDir = args[++i]; break;
      case '--contexts-dir': ctxDir = args[++i]; break;
      case '--baseline': baseline = args[++i]; break;
      case '--connection': connection = args[++i]; break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!filePath || !graphPath || !eventsDir || !ctxDir) {
    console.error('Usage: npx tsx scripts/diff-hash.ts --file <path> --graph <path> --events-dir <path> --contexts-dir <path> [--baseline HEAD]');
    process.exit(1);
  }

  return { filePath: path.resolve(filePath), graphPath, eventsDir, ctxDir, baseline, connection };
}

async function main() {
  const { filePath, graphPath, eventsDir, ctxDir, baseline, connection } = parseArgs();
  contextsDir = path.resolve(ctxDir);

  // Determine file type (event or context)
  const currentContent = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
  const fileId = currentContent?.id;
  if (!fileId) {
    console.error(`Cannot determine id from ${filePath}`);
    process.exit(1);
  }

  const isContext = fs.readdirSync(contextsDir).some(f =>
    path.join(contextsDir!, f) === filePath || currentContent?.values !== undefined
  );
  const isEvent = !isContext;

  // Load baseline version
  const baselineContent = getGitBaseline(filePath, baseline);
  if (baselineContent === null) {
    console.log(`File is new (not in ${baseline}). No hash comparison needed.`);
    process.exit(0);
  }
  const baselineParsed = yaml.load(baselineContent) as any;

  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

  // Find affected edges
  const affectedEdges = (graph.edges || []).filter((edge: any) => {
    if (!edge.query) return false;
    if (isEvent) {
      // Edge is affected if any node it references uses this event
      const nodes = graph.nodes || [];
      return nodes.some((n: any) =>
        n.event_id === fileId && edge.query.includes(n.id)
      );
    } else {
      // Context: edge is affected if graph's dataInterestsDSL or edge query references this context
      const contextKeys = extractContextKeys(graph, edge);
      return contextKeys.includes(fileId);
    }
  });

  if (affectedEdges.length === 0) {
    console.log(`No edges in this graph reference ${isEvent ? 'event' : 'context'} '${fileId}'.`);
    process.exit(0);
  }

  console.log(`Changed file:  ${path.basename(filePath)} (${isEvent ? 'event' : 'context'}: ${fileId})`);
  console.log(`Baseline:      ${baseline}`);
  console.log(`Affected edges in ${path.basename(graphPath)}:`);
  console.log('');

  let changedCount = 0;

  for (const edge of affectedEdges) {
    // Compute OLD hash (with baseline file content)
    const eventDefsOld = loadEventDefinitions(eventsDir);
    if (isEvent) {
      eventDefsOld[fileId] = baselineParsed;
    }
    if (isContext) {
      contextOverride = { id: fileId, data: baselineParsed };
      contextCache.delete(fileId);
    }
    const oldHash = await computeEdgeHash(graph, edge, connection, eventDefsOld);

    // Compute NEW hash (with current file content)
    const eventDefsNew = loadEventDefinitions(eventsDir);
    if (isEvent) {
      eventDefsNew[fileId] = currentContent;
    }
    contextOverride = undefined;
    contextCache.delete(fileId);
    const newHash = await computeEdgeHash(graph, edge, connection, eventDefsNew);

    const changed = oldHash !== newHash;
    if (changed) changedCount++;

    console.log(`  ${edge.id}:`);
    console.log(`    ${oldHash} → ${newHash}  ${changed ? 'CHANGED' : 'unchanged'}`);
  }

  console.log('');
  console.log(`${changedCount} of ${affectedEdges.length} edge(s) have changed hashes.`);

  if (changedCount > 0) {
    console.log('');
    console.log('Run add-mapping.ts for each changed edge to preserve historical snapshot access.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
