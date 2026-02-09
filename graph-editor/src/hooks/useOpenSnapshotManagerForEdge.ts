import { useCallback } from 'react';
import type { Graph } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { signatureLinksTabService } from '../services/signatureLinksTabService';
import {
  computeCurrentCoreHashForEdge,
  detectSnapshotQueryModeFromDsl,
} from '../services/snapshotManagerContextService';

export function useOpenSnapshotManagerForEdge(args: {
  graph: Graph;
  graphFileId?: string | null;
  currentDsl: string;
}) {
  const { state: navState } = useNavigatorContext();

  return useCallback(async (input: {
    edgeId: string;
    paramId: string;
    slot: 'p' | 'cost_gbp' | 'labour_cost';
  }) => {
    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';

    if (!repo) return;
    if (!input.paramId) return;

    const bareGraphId = args.graphFileId ? args.graphFileId.replace(/^graph-/, '') : '';
    const desiredQueryMode = detectSnapshotQueryModeFromDsl(args.currentDsl);

    const computed = await computeCurrentCoreHashForEdge({
      graph: args.graph,
      dsl: args.currentDsl,
      edgeId: input.edgeId,
      paramId: input.paramId,
      slot: input.slot,
    });

    await signatureLinksTabService.openSignatureLinksTab({
      graphId: bareGraphId,
      graphName: bareGraphId,
      paramId: input.paramId,
      dbParamId: `${repo}-${branch}-${input.paramId}`,
      paramSlot: input.slot,
      currentCoreHash: computed?.coreHash,
      desiredQueryMode: desiredQueryMode === 'unknown' ? undefined : desiredQueryMode,
    });
  }, [
    args.graph,
    args.graphFileId,
    args.currentDsl,
    navState.selectedRepo,
    navState.selectedBranch,
  ]);
}

