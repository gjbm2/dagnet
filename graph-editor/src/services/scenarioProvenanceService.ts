import type { Graph } from '../types';
import { db } from '../db/appDatabase';
import { collectGraphDependencies, extractContextKeysFromDSL } from '../lib/dependencyClosure';
import { dslDependsOnReferenceDay } from '../lib/dslDynamics';
import { ukReferenceDayService } from './ukReferenceDayService';
import { scenarioDepsSignatureV1, type ScenarioDepsStampV1, type ScenarioObservedInputV1 } from '../lib/scenarioDeps';

function fileRevisionToken(file: any): string {
  const sha = typeof file?.sha === 'string' ? file.sha.trim() : '';
  if (sha) return sha;
  const lm = file?.lastModified;
  if (typeof lm === 'number' && Number.isFinite(lm)) return String(lm);
  return 'missing';
}

async function resolveContextFileById(contextId: string): Promise<any | null> {
  // Fast path: common convention is fileId = `context-${id}`.
  try {
    const byFileId = await db.files.get(`context-${contextId}`);
    if (byFileId?.type === 'context' && (byFileId as any)?.data?.id === contextId) return byFileId;
  } catch {
    // ignore
  }

  // Fallback: scan context files for matching data.id (workspace-scoped).
  try {
    const all = await db.files.where('type').equals('context').toArray();
    const hit = all.find((f: any) => f?.data?.id === contextId) || null;
    return hit;
  } catch {
    return null;
  }
}

export async function computeScenarioDepsStampV1(args: {
  graphFileId: string;
  graph: Graph;
  baseDsl: string;
  effectiveDsl: string;
}): Promise<{ stamp: ScenarioDepsStampV1; signature: string }> {
  const deps = collectGraphDependencies(args.graph as any);

  const inputs: ScenarioObservedInputV1[] = [];

  // Graph file revision (best-effort).
  try {
    const graphFile = await db.files.get(args.graphFileId);
    inputs.push({ kind: 'graph', file_id: args.graphFileId, rev: fileRevisionToken(graphFile) });
  } catch {
    inputs.push({ kind: 'graph', file_id: args.graphFileId, rev: 'missing' });
  }

  // Index revisions (best-effort; these are often the resolution sources for parameter/context IDs).
  try {
    const pIndex = await db.files.get('parameter-index');
    if (pIndex) inputs.push({ kind: 'index', id: 'parameter-index', file_id: 'parameter-index', rev: fileRevisionToken(pIndex) });
  } catch {
    // ignore
  }
  try {
    const cIndex = await db.files.get('context-index');
    if (cIndex) inputs.push({ kind: 'index', id: 'context-index', file_id: 'context-index', rev: fileRevisionToken(cIndex) });
  } catch {
    // ignore
  }

  // Forecasting settings (repo-committed in many workspaces).
  try {
    const settings = await db.files.get('settings-settings');
    if (settings) inputs.push({ kind: 'settings', id: 'settings/settings.yaml', file_id: 'settings-settings', rev: fileRevisionToken(settings) });
  } catch {
    // ignore
  }

  // Parameter files referenced by the graph topology.
  for (const pid of Array.from(deps.parameterIds)) {
    const fileId = `parameter-${pid}`;
    try {
      const f = await db.files.get(fileId);
      inputs.push({ kind: 'parameter', id: pid, file_id: fileId, rev: fileRevisionToken(f) });
    } catch {
      inputs.push({ kind: 'parameter', id: pid, file_id: fileId, rev: 'missing' });
    }
  }

  // Context definitions referenced by the effective DSL.
  const contextKeys = Array.from(extractContextKeysFromDSL(args.effectiveDsl));
  for (const cid of contextKeys) {
    const f = await resolveContextFileById(cid);
    inputs.push({
      kind: 'context',
      id: cid,
      file_id: f?.fileId || (f ? `context-${cid}` : undefined),
      rev: fileRevisionToken(f),
    });
  }

  const reference_day_uk = dslDependsOnReferenceDay(args.effectiveDsl) ? ukReferenceDayService.getReferenceDayUK() : undefined;

  const stamp: ScenarioDepsStampV1 = {
    v: 1,
    graph_file_id: args.graphFileId,
    base_dsl: args.baseDsl,
    effective_dsl: args.effectiveDsl,
    inputs,
    reference_day_uk,
  };

  return { stamp, signature: scenarioDepsSignatureV1(stamp) };
}


