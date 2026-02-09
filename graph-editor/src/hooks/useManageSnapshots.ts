/**
 * useManageSnapshots Hook
 *
 * Opens the Snapshot Manager tab pre-selected to a given parameter or graph.
 * Used by NavigatorItemContextMenu, TabContextMenu, and snapshot submenus.
 */

import { useCallback } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { signatureLinksTabService } from '../services/signatureLinksTabService';

interface UseManageSnapshotsResult {
  /** Whether the Snapshot Manager can be opened for this file */
  canManage: boolean;
  /** Open the Snapshot Manager, pre-selecting the relevant param/graph */
  openSnapshotManager: () => void;
}

/**
 * Hook to open the Snapshot Manager for a parameter or graph.
 *
 * - For parameters: opens with that param pre-selected.
 * - For graphs: opens with that graph pre-selected (no param).
 *
 * @param fileId - File ID (e.g. 'parameter-my-param', 'graph-my-graph')
 * @param fileType - 'parameter' | 'graph' (or undefined)
 */
export function useManageSnapshots(
  fileId: string | undefined,
  fileType: string | undefined,
): UseManageSnapshotsResult {
  const { state: navState } = useNavigatorContext();

  const canManage = fileType === 'parameter' || fileType === 'graph';

  const openSnapshotManager = useCallback(() => {
    if (!fileId || !canManage) return;

    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';

    // Strip the type prefix to get the bare ID (e.g. 'parameter-foo' -> 'foo')
    const bareId = fileId.replace(/^(parameter|graph)-/, '');

    if (fileType === 'parameter') {
      void signatureLinksTabService.openSignatureLinksTab({
        graphId: '',
        graphName: '',
        paramId: bareId,
        dbParamId: `${repo}-${branch}-${bareId}`,
        paramSlot: 'p',
      });
    } else if (fileType === 'graph') {
      void signatureLinksTabService.openSignatureLinksTab({
        graphId: bareId,
        graphName: bareId,
        paramId: '',
        dbParamId: '',
        paramSlot: 'p',
      });
    }
  }, [fileId, fileType, canManage, navState.selectedRepo, navState.selectedBranch]);

  return { canManage, openSnapshotManager };
}
