#!/usr/bin/env node
/**
 * Export a graph (graphs/*.json) plus all referenced supporting files into a new directory.
 *
 * Designed for occasional use when you want to copy a single graph out of a larger
 * content repo and turn it into a new, minimal repo.
 *
 * What it copies (best-effort):
 * - The graph JSON itself
 * - Referenced parameter files (edge.p.id, edge.cost_gbp.id, edge.labour_cost.id, conditional_p[*].p.id)
 * - Referenced event files (node.event_id or node.event.id)
 * - Referenced case files (node.type === 'case' && node.case.id)
 * - Referenced context definitions (keys found in graph.{dataInterestsDSL,currentQueryDSL,baseDSL})
 * - Filtered index files at repo root (parameters-index.yaml, events-index.yaml, cases-index.yaml, contexts-index.yaml)
 *
 * Usage:
 *   node graph-editor/scripts/export-graph-bundle.js \
 *     --repo /path/to/source-repo \
 *     --graph graphs/my-graph.json \
 *     --out /path/to/output-repo
 *
 * Notes:
 * - This script intentionally does NOT attempt to rewrite IDs or rename files.
 * - It aims for a minimal, runnable subset, but will warn (and continue) on missing files.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

function parseArgs(argv) {
  const out = { repo: '', graphs: [], out: '', initGit: false, commit: false, commitMessage: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i] ?? '';
    else if (a === '--graph') out.graphs.push(argv[++i] ?? '');
    else if (a === '--graphs') {
      const v = argv[++i] ?? '';
      for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) out.graphs.push(part);
    }
    else if (a === '--out') out.out = argv[++i] ?? '';
    else if (a === '--init-git') out.initGit = true;
    else if (a === '--commit') out.commit = true;
    else if (a === '--commit-message') out.commitMessage = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      // ignore unknown args for now
    }
  }
  return out;
}

function extractContextKeysFromDSL(dsl) {
  if (!dsl || typeof dsl !== 'string') return new Set();
  const keys = new Set();

  // context(key) or context(key:value)
  for (const m of dsl.matchAll(/context\(\s*([^:)]+)\s*(?::[^)]*)?\)/g)) {
    if (m[1]) keys.add(m[1].trim());
  }

  // contextAny(key:value,key:value,...)
  for (const m of dsl.matchAll(/contextAny\(\s*([^)]+)\)/g)) {
    const inner = m[1] ?? '';
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const colon = p.indexOf(':');
      if (colon > 0) {
        keys.add(p.slice(0, colon).trim());
      }
    }
  }

  return keys;
}

function collectGraphDependencies(graphJson) {
  const parameterIds = new Set();
  const eventIds = new Set();
  const caseIds = new Set();
  const contextKeys = new Set();
  const nodeIds = new Set();

  // Context keys from persisted DSL fields (if present)
  for (const k of extractContextKeysFromDSL(graphJson?.dataInterestsDSL)) contextKeys.add(k);
  for (const k of extractContextKeysFromDSL(graphJson?.currentQueryDSL)) contextKeys.add(k);
  for (const k of extractContextKeysFromDSL(graphJson?.baseDSL)) contextKeys.add(k);

  const nodes = Array.isArray(graphJson?.nodes) ? graphJson.nodes : [];
  for (const n of nodes) {
    // Prefer stable human IDs when present; fall back to uuid when not.
    if (typeof n?.id === 'string' && n.id.trim()) nodeIds.add(n.id.trim());
    else if (typeof n?.uuid === 'string' && n.uuid.trim()) nodeIds.add(n.uuid.trim());

    const eid = n?.event_id || n?.event?.id;
    if (typeof eid === 'string' && eid.trim()) eventIds.add(eid.trim());
    if (n?.type === 'case') {
      const cid = n?.case?.id;
      if (typeof cid === 'string' && cid.trim()) caseIds.add(cid.trim());
    }
  }

  const edges = Array.isArray(graphJson?.edges) ? graphJson.edges : [];
  for (const e of edges) {
    const pId = e?.p?.id;
    if (typeof pId === 'string' && pId.trim()) parameterIds.add(pId.trim());

    const costId = e?.cost_gbp?.id;
    if (typeof costId === 'string' && costId.trim()) parameterIds.add(costId.trim());

    const labourId = e?.labour_cost?.id;
    if (typeof labourId === 'string' && labourId.trim()) parameterIds.add(labourId.trim());

    const cond = Array.isArray(e?.conditional_p) ? e.conditional_p : [];
    for (const c of cond) {
      const cpId = c?.p?.id;
      if (typeof cpId === 'string' && cpId.trim()) parameterIds.add(cpId.trim());
    }
  }

  return { parameterIds, eventIds, caseIds, contextKeys, nodeIds };
}

function mergeDeps(acc, next) {
  for (const v of next.parameterIds) acc.parameterIds.add(v);
  for (const v of next.eventIds) acc.eventIds.add(v);
  for (const v of next.caseIds) acc.caseIds.add(v);
  for (const v of next.contextKeys) acc.contextKeys.add(v);
  for (const v of next.nodeIds) acc.nodeIds.add(v);
  return acc;
}

function normaliseGraphArg(graphArg) {
  if (!graphArg || typeof graphArg !== 'string') return null;
  const g = graphArg.trim();
  if (!g) return null;
  // If user passed an ID like "conversion-flow-x", assume graphs/<id>.json
  if (!g.includes('/') && !g.endsWith('.json')) return `graphs/${g}.json`;
  // If user passed "graphs/foo" (no extension), assume .json
  if (g.startsWith('graphs/') && !g.endsWith('.json')) return `${g}.json`;
  return g;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function copyFileEnsureDir(src, dst) {
  await ensureDir(path.dirname(dst));
  await fs.copyFile(src, dst);
}

async function loadIndexMap(sourceRoot, indexFileName, listKey) {
  const indexPath = path.join(sourceRoot, indexFileName);
  if (!(await fileExists(indexPath))) return { indexPath: null, data: null, idToPath: new Map() };

  const text = await fs.readFile(indexPath, 'utf8');
  const data = yaml.load(text);
  const list = data && typeof data === 'object' ? data[listKey] : null;
  const idToPath = new Map();
  if (Array.isArray(list)) {
    for (const entry of list) {
      const id = entry?.id;
      const fp = entry?.file_path;
      if (typeof id === 'string' && typeof fp === 'string') {
        idToPath.set(id, fp);
      }
    }
  }
  return { indexPath, data, idToPath };
}

function filterIndexData(originalData, listKey, idsToKeep) {
  if (!originalData || typeof originalData !== 'object') return null;
  const cloned = structuredClone(originalData);
  const list = cloned[listKey];
  if (!Array.isArray(list)) {
    // Keep structure; just return as-is if it doesn't match expected shape.
    return cloned;
  }
  cloned[listKey] = list.filter((e) => typeof e?.id === 'string' && idsToKeep.has(e.id));
  return cloned;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.repo || !args.out || !Array.isArray(args.graphs) || args.graphs.length === 0) {
    console.log(
      [
        'export-graph-bundle',
        '',
        'Usage:',
        '  node graph-editor/scripts/export-graph-bundle.js --repo <sourceRepo> --graph <graphs/foo.json|graph-id> [--graph <...>] --out <outDir> [--init-git] [--commit] [--commit-message "<msg>"]',
        '  node graph-editor/scripts/export-graph-bundle.js --repo <sourceRepo> --graphs "<g1,g2,...>" --out <outDir> [--init-git] [--commit] [--commit-message "<msg>"]',
        '',
      ].join('\n')
    );
    process.exit(args.help ? 0 : 1);
  }

  const sourceRoot = path.resolve(args.repo);
  const outRoot = path.resolve(args.out);

  const graphRels = args.graphs
    .map(normaliseGraphArg)
    .filter(Boolean)
    .map((g) => g.replace(/^[\\/]+/, ''));
  if (graphRels.length === 0) throw new Error('No valid --graph arguments provided');

  const deps = {
    parameterIds: new Set(),
    eventIds: new Set(),
    caseIds: new Set(),
    contextKeys: new Set(),
    nodeIds: new Set(),
  };

  // Read + union deps for all requested graphs.
  const graphsToCopy = [];
  for (const graphRel of graphRels) {
    const graphSrcPath = path.join(sourceRoot, graphRel);
    if (!(await fileExists(graphSrcPath))) {
      throw new Error(`Graph file not found: ${graphSrcPath}`);
    }
    const graphText = await fs.readFile(graphSrcPath, 'utf8');
    const graphJson = JSON.parse(graphText);
    mergeDeps(deps, collectGraphDependencies(graphJson));
    graphsToCopy.push({ graphRel, graphSrcPath });
  }

  // Load index maps (when present) so we can resolve non-standard file paths.
  const parametersIndex = await loadIndexMap(sourceRoot, 'parameters-index.yaml', 'parameters');
  const eventsIndex = await loadIndexMap(sourceRoot, 'events-index.yaml', 'events');
  const casesIndex = await loadIndexMap(sourceRoot, 'cases-index.yaml', 'cases');
  const contextsIndex = await loadIndexMap(sourceRoot, 'contexts-index.yaml', 'contexts');
  const nodesIndex = await loadIndexMap(sourceRoot, 'nodes-index.yaml', 'nodes');

  // Start copying.
  await ensureDir(outRoot);
  for (const g of graphsToCopy) {
    await copyFileEnsureDir(g.graphSrcPath, path.join(outRoot, g.graphRel));
  }

  const missing = [];
  const copiedCounts = {
    parameters: 0,
    events: 0,
    cases: 0,
    contexts: 0,
    nodes: 0,
  };

  const resolveOrDefault = (idToPath, id, defaultRel) => {
    const fp = idToPath.get(id);
    return fp ? fp : defaultRel;
  };

  for (const id of deps.parameterIds) {
    const rel = resolveOrDefault(parametersIndex.idToPath, id, `parameters/${id}.yaml`);
    const src = path.join(sourceRoot, rel);
    const dst = path.join(outRoot, rel);
    if (await fileExists(src)) {
      await copyFileEnsureDir(src, dst);
      copiedCounts.parameters += 1;
    }
    else missing.push({ kind: 'parameter', id, expected: rel });
  }

  for (const id of deps.eventIds) {
    const rel = resolveOrDefault(eventsIndex.idToPath, id, `events/${id}.yaml`);
    const src = path.join(sourceRoot, rel);
    const dst = path.join(outRoot, rel);
    if (await fileExists(src)) {
      await copyFileEnsureDir(src, dst);
      copiedCounts.events += 1;
    }
    else missing.push({ kind: 'event', id, expected: rel });
  }

  for (const id of deps.caseIds) {
    const rel = resolveOrDefault(casesIndex.idToPath, id, `cases/${id}.yaml`);
    const src = path.join(sourceRoot, rel);
    const dst = path.join(outRoot, rel);
    if (await fileExists(src)) {
      await copyFileEnsureDir(src, dst);
      copiedCounts.cases += 1;
    }
    else missing.push({ kind: 'case', id, expected: rel });
  }

  for (const key of deps.contextKeys) {
    const rel = resolveOrDefault(contextsIndex.idToPath, key, `contexts/${key}.yaml`);
    const src = path.join(sourceRoot, rel);
    const dst = path.join(outRoot, rel);
    if (await fileExists(src)) {
      await copyFileEnsureDir(src, dst);
      copiedCounts.contexts += 1;
    }
    else missing.push({ kind: 'context', id: key, expected: rel });
  }

  for (const id of deps.nodeIds) {
    const mappedRel = nodesIndex.idToPath.get(id);
    const rel = mappedRel ? mappedRel : `nodes/${id}.yaml`;
    const src = path.join(sourceRoot, rel);
    const dst = path.join(outRoot, rel);

    if (await fileExists(src)) {
      await copyFileEnsureDir(src, dst);
      copiedCounts.nodes += 1;
    } else if (mappedRel) {
      // Only warn when the registry/index claims this node exists in a file.
      // Many graphs contain nodes that are graph-local only (no nodes/*.yaml).
      missing.push({ kind: 'node', id, expected: rel });
    }
  }

  // Filter and write index files (if they exist in source).
  const writeIndexIfPresent = async (indexInfo, listKey, idsToKeep, fileName) => {
    if (!indexInfo.indexPath || !indexInfo.data) return;
    const filtered = filterIndexData(indexInfo.data, listKey, idsToKeep);
    if (!filtered) return;
    const outPath = path.join(outRoot, fileName);
    const text = yaml.dump(filtered, { lineWidth: 120, noRefs: true });
    await fs.writeFile(outPath, text, 'utf8');
  };

  await writeIndexIfPresent(parametersIndex, 'parameters', deps.parameterIds, 'parameters-index.yaml');
  await writeIndexIfPresent(eventsIndex, 'events', deps.eventIds, 'events-index.yaml');
  await writeIndexIfPresent(casesIndex, 'cases', deps.caseIds, 'cases-index.yaml');
  await writeIndexIfPresent(contextsIndex, 'contexts', deps.contextKeys, 'contexts-index.yaml');
  await writeIndexIfPresent(nodesIndex, 'nodes', deps.nodeIds, 'nodes-index.yaml');

  // Summary
  console.log('✅ Export complete');
  console.log(`- Source repo: ${sourceRoot}`);
  console.log(`- Graphs: ${graphRels.join(', ')}`);
  console.log(`- Output: ${outRoot}`);
  console.log(
    `- Copied: ${copiedCounts.parameters} parameters, ${copiedCounts.events} events, ${copiedCounts.cases} cases, ${copiedCounts.contexts} contexts, ${copiedCounts.nodes} nodes`
  );
  if (missing.length > 0) {
    console.log('');
    console.log('⚠️ Missing referenced files (not copied):');
    for (const m of missing) {
      console.log(`- ${m.kind}: ${m.id} (expected ${m.expected})`);
    }
    process.exitCode = 2;
  }

  if (args.initGit) {
    try {
      execFileSync('git', ['init'], { cwd: outRoot, stdio: 'inherit' });
      execFileSync('git', ['add', '-A'], { cwd: outRoot, stdio: 'inherit' });

      if (args.commit) {
        const msg = (args.commitMessage || 'Initial import').trim() || 'Initial import';
        execFileSync('git', ['commit', '-m', msg], { cwd: outRoot, stdio: 'inherit' });
      } else {
        console.log('- Git: initialised and staged (no commit; pass --commit to create one)');
      }
    } catch (e) {
      console.log('- Git: init requested but failed (is git installed? is user.name/user.email set?)');
      process.exitCode = process.exitCode || 2;
    }
  }
}

export { collectGraphDependencies, extractContextKeysFromDSL };

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((e) => {
    console.error('❌ export-graph-bundle failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}


