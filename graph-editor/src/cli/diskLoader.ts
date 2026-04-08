/**
 * diskLoader — loads graph data from the data repo on disk and seeds
 * fileRegistry so the existing orchestration modules (signature computation,
 * fetch planning, param extraction, etc.) work identically to the browser.
 *
 * This is the CLI's replacement for the IDB/FileRegistry loading path.
 * It reads YAML/JSON files from a directory and calls
 * fileRegistry.seedFileInMemory() for each one.
 */

import { readFile, readdir, writeFile, stat, mkdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import { createHash } from 'crypto';
import YAML from 'js-yaml';
import { log } from './logger';
import { CACHE_HASH_LENGTH, FINGERPRINT_HASH_LENGTH } from './constants';
import { fileRegistry } from '../contexts/TabContext';
import { contextRegistry } from '../services/contextRegistry';
import type { ContextDefinition } from '../services/contextRegistry';

export interface GraphBundle {
  graphDir: string;
  graphName: string;
  graph: any;
  events: Map<string, any>;
  contexts: Map<string, ContextDefinition>;
  parameters: Map<string, any>;
  cases: Map<string, any>;
  connections: any;
  hashMappings: { version: number; mappings: any[] };
}

/**
 * Load a graph and all its associated files from a data repo directory.
 *
 * Expected directory structure:
 *   {dir}/graphs/{name}.json
 *   {dir}/events/*.yaml
 *   {dir}/contexts/*.yaml
 *   {dir}/parameters/*.yaml
 *   {dir}/cases/*.yaml           (optional)
 *   {dir}/connections.yaml
 *   {dir}/hash-mappings.json     (optional)
 *
 * @param dir  Path to the data repo root (or graph workspace root)
 * @param graphName  Name of the graph file (without extension) inside graphs/
 */
export async function loadGraphFromDisk(dir: string, graphName: string): Promise<GraphBundle> {
  // 1. Load the graph JSON
  const graphPath = join(dir, 'graphs', `${graphName}.json`);
  const graphRaw = await readFile(graphPath, 'utf-8');
  const graph = JSON.parse(graphRaw);

  // 2. Load YAML directories
  const events = await loadYamlDirectory(join(dir, 'events'));
  const contexts = await loadYamlDirectory(join(dir, 'contexts')) as Map<string, ContextDefinition>;
  const parameters = await loadYamlDirectory(join(dir, 'parameters'));
  const cases = await loadYamlDirectory(join(dir, 'cases')).catch(() => new Map<string, any>());

  // 3. Load connections.yaml
  const connectionsPath = join(dir, 'connections.yaml');
  const connectionsRaw = await readFile(connectionsPath, 'utf-8').catch(() => '');
  const connections = connectionsRaw ? YAML.load(connectionsRaw) : { connections: [] };

  // 4. Load hash-mappings.json (may be YAML despite the extension)
  const hashMappingsPath = join(dir, 'hash-mappings.json');
  const hashMappingsRaw = await readFile(hashMappingsPath, 'utf-8').catch(() => '');
  let hashMappings: { version: number; mappings: any[] } = { version: 1, mappings: [] };
  if (hashMappingsRaw) {
    try {
      hashMappings = JSON.parse(hashMappingsRaw);
    } catch {
      // File may be YAML despite the .json extension
      hashMappings = YAML.load(hashMappingsRaw) as any ?? { version: 1, mappings: [] };
    }
  }

  return {
    graphDir: dir,
    graphName,
    graph,
    events,
    contexts,
    parameters,
    cases,
    connections,
    hashMappings,
  };
}

// ---------------------------------------------------------------------------
// Cached loading — avoids re-parsing ~500 YAML files on repeated calls
// ---------------------------------------------------------------------------

import { tmpdir, homedir } from 'os';

/** Cache lives in ~/.cache/dagnet-cli/ (doesn't pollute the data repo). */
const CACHE_DIR = join(homedir(), '.cache', 'dagnet-cli');

/**
 * Load a graph with disk caching. On first call, loads from YAML and
 * writes a JSON cache file. On subsequent calls, checks source file
 * mtimes — if unchanged, loads from cache (~10× faster for large repos).
 *
 * Cache files live in `{dir}/.dagnet-cache/{graphName}.json`.
 * Pass `noCache: true` to bypass.
 */
export async function loadGraphFromDiskCached(
  dir: string,
  graphName: string,
  opts?: { noCache?: boolean },
): Promise<GraphBundle> {
  if (opts?.noCache) return loadGraphFromDisk(dir, graphName);

  // Use a hash of the dir path to namespace cache files per data repo
  const dirHash = createHash('sha256').update(dir).digest('hex').slice(0, CACHE_HASH_LENGTH);
  const cachePath = join(CACHE_DIR, `${dirHash}-${graphName}.bundle.json`);
  const fingerprintPath = join(CACHE_DIR, `${dirHash}-${graphName}.fingerprint`);

  // Compute fingerprint from source file mtimes
  const currentFingerprint = await computeFingerprint(dir, graphName);

  // Check if cache is valid
  try {
    const storedFingerprint = await readFile(fingerprintPath, 'utf-8');
    if (storedFingerprint === currentFingerprint) {
      const cached = await readFile(cachePath, 'utf-8');
      const raw = JSON.parse(cached);
      const bundle = deserialiseBundle(raw);
      log.info(`Loaded from cache (${cachePath})`);
      return bundle;
    }
  } catch {
    // Cache miss — load fresh
  }

  // Load fresh
  const bundle = await loadGraphFromDisk(dir, graphName);

  // Write cache
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, serialiseBundle(bundle), 'utf-8');
    await writeFile(fingerprintPath, currentFingerprint, 'utf-8');
    log.info(`Wrote cache (${cachePath})`);
  } catch (err: any) {
    log.warn(`Could not write cache: ${err.message}`);
  }

  return bundle;
}

/**
 * Compute a fingerprint from mtimes of all source files that feed the
 * bundle. If any file changes, the fingerprint changes.
 */
async function computeFingerprint(dir: string, graphName: string): Promise<string> {
  const mtimes: string[] = [];

  // Graph file
  try {
    const s = await stat(join(dir, 'graphs', `${graphName}.json`));
    mtimes.push(`graph:${s.mtimeMs}`);
  } catch { /* missing */ }

  // Directories: collect mtime of each file
  for (const subdir of ['events', 'contexts', 'parameters', 'cases']) {
    try {
      const entries = await readdir(join(dir, subdir));
      for (const entry of entries.sort()) {
        try {
          const s = await stat(join(dir, subdir, entry));
          mtimes.push(`${subdir}/${entry}:${s.mtimeMs}`);
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
  }

  // connections.yaml
  try {
    const s = await stat(join(dir, 'connections.yaml'));
    mtimes.push(`connections:${s.mtimeMs}`);
  } catch { /* missing */ }

  // hash-mappings.json
  try {
    const s = await stat(join(dir, 'hash-mappings.json'));
    mtimes.push(`hash-mappings:${s.mtimeMs}`);
  } catch { /* missing */ }

  return createHash('sha256').update(mtimes.join('\n')).digest('hex').slice(0, FINGERPRINT_HASH_LENGTH);
}

/** Serialise a GraphBundle to JSON (Maps → plain objects). */
function serialiseBundle(bundle: GraphBundle): string {
  return JSON.stringify({
    graphDir: bundle.graphDir,
    graphName: bundle.graphName,
    graph: bundle.graph,
    events: Object.fromEntries(bundle.events),
    contexts: Object.fromEntries(bundle.contexts),
    parameters: Object.fromEntries(bundle.parameters),
    cases: Object.fromEntries(bundle.cases),
    connections: bundle.connections,
    hashMappings: bundle.hashMappings,
  });
}

/** Deserialise a cached JSON back to a GraphBundle (objects → Maps). */
function deserialiseBundle(raw: any): GraphBundle {
  return {
    graphDir: raw.graphDir,
    graphName: raw.graphName,
    graph: raw.graph,
    events: new Map(Object.entries(raw.events || {})),
    contexts: new Map(Object.entries(raw.contexts || {})) as Map<string, ContextDefinition>,
    parameters: new Map(Object.entries(raw.parameters || {})),
    cases: new Map(Object.entries(raw.cases || {})),
    connections: raw.connections,
    hashMappings: raw.hashMappings,
  };
}

/**
 * Seed the loaded graph bundle into fileRegistry so that all existing
 * orchestration modules (computePlausibleSignaturesForEdge, getMappingsFile,
 * buildDslFromEdge, etc.) find files via fileRegistry.getFile() as normal.
 *
 * Also pre-loads contextRegistry so DSL explosion resolves context values.
 *
 * @param workspace  Optional workspace scope. computePlausibleSignaturesForEdge
 *   reads source.repository and source.branch from the file to build the
 *   workspace-qualified param ID for snapshot DB lookups. If not supplied,
 *   defaults to { repository: 'cli', branch: 'local' }.
 */
export function seedFileRegistry(
  bundle: GraphBundle,
  workspace?: { repository: string; branch: string },
): void {
  const ws = workspace ?? { repository: 'cli', branch: 'local' };
  const source = { repository: ws.repository, branch: ws.branch, path: '' };

  // Graph
  fileRegistry.seedFileInMemory(`graph-${bundle.graphName}`, 'graph', bundle.graph, source);

  // Events
  for (const [id, data] of bundle.events) {
    fileRegistry.seedFileInMemory(`event-${id}`, 'event', data, source);
  }

  // Contexts
  for (const [id, data] of bundle.contexts) {
    fileRegistry.seedFileInMemory(`context-${id}`, 'context', data, source);
  }

  // Parameters
  for (const [id, data] of bundle.parameters) {
    fileRegistry.seedFileInMemory(`parameter-${id}`, 'parameter', data, source);
  }

  // Cases
  for (const [id, data] of bundle.cases) {
    fileRegistry.seedFileInMemory(`case-${id}`, 'case', data, source);
  }

  // Connections
  fileRegistry.seedFileInMemory('connections-connections', 'connections', bundle.connections, source);

  // Hash mappings
  fileRegistry.seedFileInMemory('hash-mappings', 'hash-mappings', bundle.hashMappings, source);

  // Pre-load context registry (avoids IDB fallback)
  contextRegistry.preloadContexts(bundle.contexts);
}

/**
 * Create an EventLoader function compatible with buildDslFromEdge.
 * Looks up events from the loaded bundle.
 */
export function createEventLoader(bundle: GraphBundle): (eventId: string) => Promise<any> {
  return async (eventId: string) => {
    const data = bundle.events.get(eventId);
    if (!data) throw new Error(`Event definition '${eventId}' not found on disk`);
    return data;
  };
}

/**
 * Create a FileStateAccessor compatible with fetchPlanBuilderService.
 * Looks up parameter and case files from the loaded bundle.
 */
export function createFileStateAccessor(bundle: GraphBundle) {
  return {
    getParameterFile(objectId: string) {
      const data = bundle.parameters.get(objectId);
      return data ? { data } : undefined;
    },
    getCaseFile(objectId: string) {
      const data = bundle.cases.get(objectId);
      return data ? { data } : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load all YAML files from a directory into a Map keyed by the `id` field
 * within each file (falling back to filename without extension).
 */
async function loadYamlDirectory(dirPath: string): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return result; // Directory doesn't exist — fine for optional dirs
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;

    const filePath = join(dirPath, entry);
    const raw = await readFile(filePath, 'utf-8');
    const data = YAML.load(raw) as any;
    if (!data) continue;

    // Key by the id field if present, otherwise by filename stem
    const id = data.id || basename(entry, ext);
    result.set(id, data);
  }

  return result;
}
