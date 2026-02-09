import type { Graph } from '../types';
import { buildItemKey } from './fetchPlanTypes';
import { computePlannerQuerySignaturesForGraph } from './plannerQuerySignatureService';
import { computeShortCoreHash } from './coreHashService';

export type SnapshotQueryMode = 'window' | 'cohort' | 'unknown';

export function detectSnapshotQueryModeFromDsl(dsl: string | undefined | null): SnapshotQueryMode {
  const s = (dsl || '').toString();
  if (s.includes('cohort(')) return 'cohort';
  if (s.includes('window(')) return 'window';
  return 'unknown';
}

export async function computeCurrentCoreHashForEdge(args: {
  graph: Graph;
  /** Graph-level DSL (authoritative), e.g. "cohort(-30d:).context(...)" */
  dsl: string;
  edgeId: string;
  paramId: string;
  slot: 'p' | 'cost_gbp' | 'labour_cost';
}): Promise<{ coreHash: string; canonicalSignature: string; itemKey: string } | null> {
  const { graph, dsl, edgeId, paramId, slot } = args;

  const itemKey = buildItemKey({
    type: 'parameter',
    objectId: paramId,
    targetId: edgeId,
    slot,
  });

  // Compute execution-grade canonical signatures for this graph+DSL.
  // This mirrors the snapshot_subjects flow used by share-live and is sensitive to mode (window vs cohort).
  const sigs = await computePlannerQuerySignaturesForGraph({ graph, dsl, forceCompute: true });
  const canonicalSignature = sigs[itemKey];
  if (!canonicalSignature) return null;

  // The DB "core_hash" is a short hash of the canonical signature (hash-fixes.md).
  const coreHash = await computeShortCoreHash(canonicalSignature);
  return { coreHash, canonicalSignature, itemKey };
}

