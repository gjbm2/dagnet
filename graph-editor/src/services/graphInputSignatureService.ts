import type { Graph } from '../types';
import { db } from '../db/appDatabase';
import { collectGraphDependencies, extractContextKeysFromDSL } from '../lib/dependencyClosure';
import { graphTopologySignature } from './graphTopologySignatureService';
import { fnv1a32, stableStringify } from '../lib/stableSignature';

function fileRevisionToken(file: any): string {
  const sha = typeof file?.sha === 'string' ? file.sha.trim() : '';
  if (sha) return sha;
  const lm = file?.lastModified;
  if (typeof lm === 'number' && Number.isFinite(lm)) return String(lm);
  return 'missing';
}

async function resolveContextRevision(contextId: string): Promise<{ fileId?: string; rev: string }> {
  // Fast path (convention).
  try {
    const f = await db.files.get(`context-${contextId}`);
    if (f?.type === 'context' && (f as any)?.data?.id === contextId) return { fileId: f.fileId, rev: fileRevisionToken(f) };
  } catch {
    // ignore
  }
  try {
    const all = await db.files.where('type').equals('context').toArray();
    const hit = all.find((x: any) => x?.data?.id === contextId) || null;
    return hit ? { fileId: hit.fileId, rev: fileRevisionToken(hit) } : { rev: 'missing' };
  } catch {
    return { rev: 'missing' };
  }
}

/**
 * Compute a compact signature of the authoritative repo/inputs that can affect scenario graphs and therefore charts.
 *
 * This is used for chart dependency stamps so changes in underlying parameter/context/settings files can invalidate charts
 * even when the chart recipe DSL is unchanged.
 */
export async function computeGraphInputsSignatureV1(args: {
  graphFileId: string;
  graph: Graph;
  scenarioEffectiveDsls: string[];
}): Promise<string> {
  const topo = graphTopologySignature(args.graph as any) || '';
  const deps = collectGraphDependencies(args.graph as any);

  const parts: Array<{ k: string; id?: string; fileId?: string; rev: string; extra?: string }> = [];

  // Graph file revision + topology signature (topology signature captures in-memory edits even when file revision is unchanged).
  try {
    const gFile = await db.files.get(args.graphFileId);
    parts.push({ k: 'graph', fileId: args.graphFileId, rev: fileRevisionToken(gFile), extra: topo });
  } catch {
    parts.push({ k: 'graph', fileId: args.graphFileId, rev: 'missing', extra: topo });
  }

  // Index files (resolution sources).
  try {
    const pIndex = await db.files.get('parameter-index');
    if (pIndex) parts.push({ k: 'index', id: 'parameter-index', fileId: 'parameter-index', rev: fileRevisionToken(pIndex) });
  } catch {
    // ignore
  }
  try {
    const cIndex = await db.files.get('context-index');
    if (cIndex) parts.push({ k: 'index', id: 'context-index', fileId: 'context-index', rev: fileRevisionToken(cIndex) });
  } catch {
    // ignore
  }

  // Settings.
  try {
    const settings = await db.files.get('settings-settings');
    if (settings) parts.push({ k: 'settings', id: 'settings/settings.yaml', fileId: 'settings-settings', rev: fileRevisionToken(settings) });
  } catch {
    // ignore
  }

  // Parameters referenced by the graph.
  for (const pid of Array.from(deps.parameterIds)) {
    const fileId = `parameter-${pid}`;
    try {
      const f = await db.files.get(fileId);
      parts.push({ k: 'parameter', id: pid, fileId, rev: fileRevisionToken(f) });
    } catch {
      parts.push({ k: 'parameter', id: pid, fileId, rev: 'missing' });
    }
  }

  // Context definitions referenced by any participating DSL.
  const contextKeys = new Set<string>();
  for (const dsl of args.scenarioEffectiveDsls) {
    for (const k of extractContextKeysFromDSL(dsl)) contextKeys.add(k);
  }
  for (const cid of Array.from(contextKeys)) {
    const { fileId, rev } = await resolveContextRevision(cid);
    parts.push({ k: 'context', id: cid, fileId, rev });
  }

  parts.sort((a, b) => `${a.k}:${a.id || ''}:${a.fileId || ''}`.localeCompare(`${b.k}:${b.id || ''}:${b.fileId || ''}`));

  return `v1:${fnv1a32(stableStringify(parts))}`;
}






