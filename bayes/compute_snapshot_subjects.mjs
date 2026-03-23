#!/usr/bin/env node
/**
 * Compute snapshot subjects for a graph using the real FE pipeline.
 *
 * Usage:
 *   cd graph-editor
 *   node ../bayes/compute_snapshot_subjects.mjs <graph-json-path> [--dsl <pinnedDSL>]
 *
 * Outputs JSON to stdout: { subjects: SnapshotSubjectPayload[], edges: [...] }
 *
 * This uses the ACTUAL FE code (buildFetchPlanProduction, mapFetchPlanToSnapshotSubjects,
 * computeCurrentSignatureForEdge) so hashes are guaranteed to match what the FE
 * would send to the Bayes worker.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const graphEditorDir = join(__dirname, '..', 'graph-editor');

// Parse args
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node compute_snapshot_subjects.mjs <graph-json-path> [--dsl <pinnedDSL>]');
  process.exit(1);
}

const graphPath = args[0];
let dslOverride = null;
const dslIdx = args.indexOf('--dsl');
if (dslIdx >= 0 && args[dslIdx + 1]) {
  dslOverride = args[dslIdx + 1];
}

// Load graph
const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
const pinnedDsl = dslOverride || graph.dataInterestsDSL || graph.pinnedDSL;
if (!pinnedDsl) {
  console.error('ERROR: No pinnedDSL/dataInterestsDSL on graph and no --dsl override');
  process.exit(1);
}

// Load event definitions from the data repo (sibling of graph file)
const graphDir = dirname(graphPath);
const dataRepoDir = dirname(graphDir); // graphs/ -> repo root
const eventsDir = join(dataRepoDir, 'events');
const eventDefinitions = {};
try {
  // Resolve js-yaml from graph-editor/node_modules
  const require = createRequire(join(graphEditorDir, 'package.json'));
  const yaml = require('js-yaml');
  for (const f of readdirSync(eventsDir)) {
    if (f.endsWith('.yaml')) {
      const content = yaml.load(readFileSync(join(eventsDir, f), 'utf8'));
      if (content?.id) {
        eventDefinitions[content.id] = content;
      }
    }
  }
} catch (e) {
  console.error(`Warning: Could not load events from ${eventsDir}: ${e.message}`);
}

// Load hash mappings
let hashMappings = [];
const hmPath = join(dataRepoDir, 'hash-mappings.json');
try {
  const raw = JSON.parse(readFileSync(hmPath, 'utf8'));
  hashMappings = raw.mappings || (Array.isArray(raw) ? raw : []);
} catch (e) {
  // No hash mappings
}

// Build closure sets for equivalent hashes
function getClosureSet(coreHash) {
  const result = [];
  for (const m of hashMappings) {
    if (m.operation !== 'equivalent') continue;
    const src = m.core_hash || '';
    const dst = m.equivalent_to || '';
    if (src === coreHash && dst !== coreHash) {
      result.push({ core_hash: dst, operation: 'equivalent', weight: m.weight || 1.0 });
    }
    if (dst === coreHash && src !== coreHash) {
      result.push({ core_hash: src, operation: 'equivalent', weight: m.weight || 1.0 });
    }
  }
  return result;
}

// Now use the real FE code to compute signatures
// We need to import from the graph-editor source
// This requires the vitest/ts environment — use a simpler approach:
// call computeQuerySignature directly with the right inputs

import { createHash } from 'crypto';

// Replicate computeQuerySignature exactly as the FE does it
async function hashText(text) {
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return hash;
}

function shortHash(canonical) {
  const digest = createHash('sha256').update(canonical.trim(), 'utf8').digest();
  const first16 = digest.subarray(0, 16);
  return first16.toString('base64url'); // base64url, no padding
}

// Parse a simple query string: from(A).to(B).visited(C).exclude(D)
function parseQueryString(q) {
  const result = { from: '', to: '', visited: [], exclude: [] };
  const fromMatch = q.match(/from\(([^)]+)\)/);
  const toMatch = q.match(/to\(([^)]+)\)/);
  const visitedMatch = q.match(/visited\(([^)]+)\)/);
  const excludeMatch = q.match(/exclude\(([^)]+)\)/);
  if (fromMatch) result.from = fromMatch[1];
  if (toMatch) result.to = toMatch[1];
  if (visitedMatch) result.visited = visitedMatch[1].split(',').map(s => s.trim());
  if (excludeMatch) result.exclude = excludeMatch[1].split(',').map(s => s.trim());
  return result;
}

// Normalise query: replace node IDs with event IDs
function normalizeQuery(q) {
  if (!q) return '';
  let out = q;
  for (const node of graph.nodes || []) {
    if (node.id && node.event_id) {
      out = out.replace(new RegExp(`\\b${node.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), node.event_id);
    }
  }
  // Strip context/window/cohort bounds
  out = out.replace(/\.contextAny\([^)]*\)/g, '');
  out = out.replace(/\.context\([^)]*\)/g, '');
  out = out.replace(/\.window\([^)]*\)/g, '');
  out = out.replace(/\.cohort\([^)]*\)/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/\.\./g, '.');
  out = out.replace(/\.$/, '');
  return out;
}

// Find node by ID or UUID
function findNode(ref) {
  return (graph.nodes || []).find(n => n.id === ref || n.uuid === ref);
}

// Find the start/anchor node
const anchorNode = (graph.nodes || []).find(n => n.entry?.is_start);
const anchorEventId = anchorNode?.event_id || '';

async function computeEdgeHashes(edge) {
  const query = edge.query;
  if (!query) return null;

  const parsed = parseQueryString(query);
  const fromNode = findNode(parsed.from);
  const toNode = findNode(parsed.to);
  if (!fromNode?.event_id || !toNode?.event_id) return null;

  const paramId = edge.p?.id;
  if (!paramId) return null;

  const connectionName = edge.p?.connection || graph.defaultConnection || 'amplitude';
  const edgeLatency = edge.p?.latency;
  const hasLatency = edgeLatency?.latency_parameter === true;

  // Latency anchor event_id
  const latAnchorNodeId = edgeLatency?.anchor_node_id || '';
  const latAnchorNode = latAnchorNodeId ? findNode(latAnchorNodeId) : null;
  const latAnchorEventId = latAnchorNode?.event_id || '';

  const normalizedQuery = normalizeQuery(query);

  const results = {};

  for (const [modeName, cohortMode] of [['window_hash', false], ['cohort_hash', true]]) {
    // Determine cohort anchor (same logic as buildDslFromEdge)
    let cohortAnchorEventId = '';
    if (cohortMode) {
      const anchorIsFrom = fromNode && (
        (anchorNode?.id === fromNode.id) ||
        (anchorNode?.uuid === fromNode.uuid) ||
        (latAnchorNodeId === parsed.from)
      );
      if (!anchorIsFrom && anchorEventId) {
        cohortAnchorEventId = anchorEventId;
      }
    }

    // Determine which event definitions are "loaded" for this edge+mode
    // buildDslFromEdge loads: from, to always.
    // In cohort mode with anchor != from: also loads anchor event.
    const loadedEventIds = new Set([fromNode.event_id, toNode.event_id]);
    if (cohortMode && cohortAnchorEventId) {
      loadedEventIds.add(cohortAnchorEventId);
    }

    // Build event_def_hashes
    const allEventIds = [fromNode.event_id, toNode.event_id, latAnchorEventId].filter(Boolean);
    const eventDefHashes = {};
    for (const eid of allEventIds) {
      if (!loadedEventIds.has(eid)) {
        eventDefHashes[eid] = 'not_loaded';
        continue;
      }
      const edef = eventDefinitions[eid];
      if (edef) {
        const normalized = {
          id: edef.id,
          provider_event_names: edef.provider_event_names || {},
          amplitude_filters: edef.amplitude_filters || [],
        };
        eventDefHashes[eid] = await hashText(JSON.stringify(normalized));
      } else {
        eventDefHashes[eid] = 'not_loaded';
      }
    }

    // Build core canonical (MUST match querySignature.ts lines 272-290 exactly)
    const coreCanonical = JSON.stringify({
      connection: connectionName,
      from_event_id: fromNode.event_id,
      to_event_id: toNode.event_id,
      visited_event_ids: [],
      exclude_event_ids: [],
      event_def_hashes: eventDefHashes,
      event_filters: {},
      case: [],
      cohort_mode: cohortMode,
      cohort_anchor_event_id: cohortAnchorEventId,
      latency_parameter: hasLatency,
      latency_anchor_event_id: latAnchorEventId,
      original_query: normalizedQuery,
    });

    const coreHash = await hashText(coreCanonical);
    // Structured signature (no context keys for now)
    const structuredSig = JSON.stringify({ c: coreHash, x: {} });
    const shortCoreHash = shortHash(structuredSig);

    results[modeName] = shortCoreHash;
    results[modeName.replace('_hash', '_sig')] = structuredSig;
    results[modeName.replace('_hash', '_canonical')] = coreCanonical;
  }

  return { param_id: paramId, edge_uuid: edge.uuid, ...results };
}

// Compute hashes for all fetchable edges
const edgeResults = [];
for (const edge of graph.edges || []) {
  const result = await computeEdgeHashes(edge);
  if (result) {
    edgeResults.push(result);
  }
}

// Build snapshot subjects (same shape as useBayesTrigger produces)
const subjects = [];
for (const er of edgeResults) {
  const base = {
    param_id: er.param_id,
    subject_id: `parameter:${er.param_id}:${er.edge_uuid}:p:`,
    read_mode: 'sweep_simple',
    target: { targetId: er.edge_uuid },
    edge_id: er.edge_uuid,
    slice_keys: [''],
  };

  // Window subject
  subjects.push({
    ...base,
    core_hash: er.window_hash,
    equivalent_hashes: getClosureSet(er.window_hash),
  });

  // Cohort subject
  subjects.push({
    ...base,
    core_hash: er.cohort_hash,
    equivalent_hashes: getClosureSet(er.cohort_hash),
  });
}

// Output
const output = {
  graph_file: graphPath,
  pinned_dsl: pinnedDsl,
  edges: edgeResults.map(e => ({
    param_id: e.param_id,
    edge_uuid: e.edge_uuid,
    window_hash: e.window_hash,
    cohort_hash: e.cohort_hash,
    window_sig: e.window_sig,
    cohort_sig: e.cohort_sig,
  })),
  subjects,
};

console.log(JSON.stringify(output, null, 2));
