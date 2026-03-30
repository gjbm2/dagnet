#!/usr/bin/env npx tsx
/**
 * compute-hash — Compute core_hash for edges in a graph.
 *
 * Calls the ACTUAL production TypeScript code (computeQuerySignature +
 * computeShortCoreHash) with a filesystem-based context/event loader.
 * No reimplementation — same code path as the app, different I/O layer.
 *
 * Usage:
 *   cd graph-editor
 *   npx tsx scripts/compute-hash.ts \
 *     --graph path/to/graph.json \
 *     --events-dir path/to/events/ \
 *     --contexts-dir path/to/contexts/ \
 *     [--edge edge-id] \
 *     [--connection amplitude] \
 *     [--json]
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// ─────────────────────────────────────────────────────────────────────────────
// Monkey-patch contextRegistry BEFORE calling computeQuerySignature.
// Replaces IDB/FileRegistry loader with filesystem loader.
// ─────────────────────────────────────────────────────────────────────────────

let contextsDir: string | undefined;
const contextCache = new Map<string, any>();

async function loadContextFromDisk(id: string): Promise<any | undefined> {
  if (contextCache.has(id)) return contextCache.get(id);
  if (!contextsDir) return undefined;

  // Try direct filename: {id}.yaml / {id}.yml
  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.join(contextsDir, `${id}${ext}`);
    if (fs.existsSync(filePath)) {
      const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
      contextCache.set(id, parsed);
      return parsed;
    }
  }

  // Scan all YAML files for matching id field
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

// Patch the singleton
import { contextRegistry } from '../src/services/contextRegistry';
(contextRegistry as any).getContext = async (id: string) => loadContextFromDisk(id);

// Production functions
import { computeQuerySignature } from '../src/services/dataOperations/querySignature';
import { computeShortCoreHash } from '../src/services/coreHashService';

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem loaders
// ─────────────────────────────────────────────────────────────────────────────

function loadEventDefinitions(eventsDir: string): Record<string, any> {
  const defs: Record<string, any> = {};
  if (!fs.existsSync(eventsDir)) return defs;

  for (const file of fs.readdirSync(eventsDir).filter(f => /\.ya?ml$/.test(f))) {
    const parsed = yaml.load(fs.readFileSync(path.join(eventsDir, file), 'utf8')) as any;
    if (parsed?.id) {
      defs[parsed.id] = parsed;
    }
  }
  return defs;
}

function loadGraph(graphPath: string): any {
  return JSON.parse(fs.readFileSync(graphPath, 'utf8'));
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

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let graphPath = '', edgeId: string | undefined, eventsDir = '', ctxDir = '';
  let connection = 'amplitude', jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--graph': graphPath = args[++i]; break;
      case '--edge': edgeId = args[++i]; break;
      case '--events-dir': eventsDir = args[++i]; break;
      case '--contexts-dir': ctxDir = args[++i]; break;
      case '--connection': connection = args[++i]; break;
      case '--json': jsonOutput = true; break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!graphPath || !eventsDir || !ctxDir) {
    console.error('Usage: npx tsx scripts/compute-hash.ts --graph <path> --events-dir <path> --contexts-dir <path> [--edge <id>] [--connection <name>] [--json]');
    process.exit(1);
  }

  return { graphPath, edgeId, eventsDir, ctxDir, connection, jsonOutput };
}

async function main() {
  const { graphPath, edgeId, eventsDir, ctxDir, connection, jsonOutput } = parseArgs();
  contextsDir = path.resolve(ctxDir);

  const graph = loadGraph(graphPath);
  const eventDefs = loadEventDefinitions(eventsDir);

  const edges: any[] = edgeId
    ? (graph.edges || []).filter((e: any) => e.id === edgeId)
    : (graph.edges || []).filter((e: any) => e.query);

  if (edges.length === 0) {
    console.error(edgeId ? `Edge '${edgeId}' not found.` : 'No edges with queries in graph.');
    process.exit(1);
  }

  const results: any[] = [];

  for (const edge of edges) {
    if (!edge.query) continue;

    const contextKeys = extractContextKeys(graph, edge);

    try {
      const signature = await computeQuerySignature(
        { context: contextKeys.map(k => ({ key: k })), event_filters: {}, case: [] },
        connection,
        graph,
        edge,
        contextKeys,
        undefined,
        eventDefs,
      );
      const coreHash = await computeShortCoreHash(signature);

      const result = {
        edge: edge.id,
        query: edge.query,
        core_hash: coreHash,
        signature,
        context_keys: contextKeys,
      };
      results.push(result);

      if (!jsonOutput) {
        console.log(`edge:          ${result.edge}`);
        console.log(`query:         ${result.query}`);
        console.log(`core_hash:     ${result.core_hash}`);
        console.log(`signature:     ${result.signature}`);
        if (contextKeys.length > 0) {
          console.log(`context_keys:  ${contextKeys.join(', ')}`);
        }
        console.log('');
      }
    } catch (err: any) {
      console.error(`ERROR [${edge.id}]: ${err.message}`);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
