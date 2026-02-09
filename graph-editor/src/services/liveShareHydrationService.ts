import type { Graph } from '../types';
import { db } from '../db/appDatabase';
import { fileRegistry } from '../contexts/TabContext';
import { getItemsForFromFileLoad } from './fetchDataService';
import { collectGraphDependencies } from '../lib/dependencyClosure';

type Identity = { repo: string; branch: string };

function fileIdForFetchItem(item: { type: string; objectId: string }): string | null {
  if (!item?.objectId) return null;
  if (item.type === 'parameter') return `parameter-${item.objectId}`;
  if (item.type === 'case') return `case-${item.objectId}`;
  if (item.type === 'node') return `node-${item.objectId}`;
  return null;
}

async function idbHasEitherFileId(fileId: string, identity: Identity): Promise<boolean> {
  const a = await db.files.get(fileId);
  if (a) return true;
  const prefixed = `${identity.repo}-${identity.branch}-${fileId}`;
  const b = await db.files.get(prefixed);
  return Boolean(b);
}

/**
 * Live share boot can race: the graph file may be available before all dependent files
 * (parameters/cases/nodes) are fully seeded into the share-scoped IndexedDB.
 *
 * This helper provides a deterministic barrier: it waits until the required files exist
 * in IndexedDB, then restores them into FileRegistry so subsequent from-file loads are stable.
 */
export async function waitForLiveShareGraphDeps(args: {
  graph: Graph;
  identity: Identity;
  timeoutMs?: number;
}): Promise<{ success: boolean; missing: string[] }> {
  const { graph, identity, timeoutMs = 12_000 } = args;

  const items = getItemsForFromFileLoad(graph as any);
  const deps = collectGraphDependencies(graph as any);
  const eventFileIds = Array.from(deps.eventIds).map((id) => `event-${id}`);

  const fileIds = Array.from(
    new Set(
      [
        ...items
          .map(i => fileIdForFetchItem(i as any))
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0),
        ...eventFileIds,
        // Provider resolution depends on connections.yaml when present (best-effort barrier).
        'connections-connections',
      ].filter(Boolean)
    )
  );

  const start = Date.now();
  let missing: string[] = [];

  while (Date.now() - start < timeoutMs) {
    const checks = await Promise.all(fileIds.map(f => idbHasEitherFileId(f, identity)));
    missing = fileIds.filter((_f, idx) => !checks[idx]);
    if (missing.length === 0) break;
    await new Promise(resolve => setTimeout(resolve, 75));
  }

  if (missing.length > 0) {
    return { success: false, missing };
  }

  // Hydrate into FileRegistry (unprefixed ids are the runtime convention).
  for (const fileId of fileIds) {
    try {
      await fileRegistry.restoreFile(fileId);
    } catch {
      // best-effort: the IDB presence check above should make this extremely rare
    }
  }

  return { success: true, missing: [] };
}


