/**
 * useDeleteSnapshots Hook
 * 
 * Centralized hook for snapshot deletion operations.
 * Handles batch inventory queries and deletion with confirmation.
 * 
 * Used by EdgeContextMenu, NodeContextMenu, NavigatorItemContextMenu, DataMenu.
 * 
 * ALL logic lives here - UI components only call the hook and render results.
 */

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useDialog } from '../contexts/DialogContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { getBatchInventory, deleteSnapshots as deleteSnapshotsApi } from '../services/snapshotWriteService';
import { sessionLogService } from '../services/sessionLogService';
import { invalidateInventoryCache } from './useEdgeSnapshotInventory';

export interface UseDeleteSnapshotsResult {
  /** Snapshot counts keyed by objectId */
  snapshotCounts: Record<string, number>;
  /** Whether currently loading */
  isLoading: boolean;
  /** Delete snapshots for an objectId (shows confirm dialog) */
  deleteSnapshots: (objectId: string) => Promise<boolean>;
  /** Refresh all counts */
  refreshCounts: () => Promise<void>;
}

/**
 * Build workspace-prefixed param_id for database operations.
 */
function buildDbParamId(objectId: string, repo: string, branch: string): string {
  return `${repo}-${branch}-${objectId}`;
}

/**
 * Hook to manage snapshot deletion for multiple parameters.
 * 
 * @param objectIds - Array of object IDs to track (e.g., parameter IDs)
 * @returns Object with snapshotCounts, isLoading, deleteSnapshots, refreshCounts
 */
export function useDeleteSnapshots(objectIds: string[]): UseDeleteSnapshotsResult {
  const [snapshotCounts, setSnapshotCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const { showConfirm } = useDialog();
  const { state: navState } = useNavigatorContext();
  
  const repo = navState.selectedRepo;
  const branch = navState.selectedBranch || 'main';
  
  // Batch query snapshot counts
  const refreshCounts = useCallback(async () => {
    if (!repo || objectIds.length === 0) {
      setSnapshotCounts({});
      return;
    }
    
    const paramIds = objectIds.map(id => buildDbParamId(id, repo, branch));
    
    try {
      const inventory = await getBatchInventory(paramIds);
      const counts: Record<string, number> = {};
      for (const objectId of objectIds) {
        const dbParamId = buildDbParamId(objectId, repo, branch);
        counts[objectId] = inventory[dbParamId]?.row_count ?? 0;
      }
      setSnapshotCounts(counts);
    } catch (error) {
      console.error('[useDeleteSnapshots] Failed to fetch inventory:', error);
    }
  }, [repo, branch, objectIds.join(',')]);
  
  // Fetch counts on mount and when dependencies change
  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);
  
  // Delete function with confirmation
  const deleteSnapshots = useCallback(async (objectId: string): Promise<boolean> => {
    if (!repo) return false;
    
    const count = snapshotCounts[objectId];
    if (!count || count === 0) return false;
    
    const dbParamId = buildDbParamId(objectId, repo, branch);
    
    const confirmed = await showConfirm({
      title: 'Delete Snapshots',
      message: `Delete ${count} snapshot row${count !== 1 ? 's' : ''} for "${objectId}"?\n\n` +
        `This removes historical time-series data and cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      confirmVariant: 'danger',
    });
    
    if (!confirmed) return false;
    
    setIsLoading(true);
    
    try {
      sessionLogService.info('data-update', 'SNAPSHOT_DELETE_START',
        `Deleting snapshots for ${objectId}`,
        undefined,
        { dbParamId, expectedCount: count }
      );
      
      const result = await deleteSnapshotsApi(dbParamId);
      
      if (result.success) {
        toast.success(`Deleted ${result.deleted} snapshot row${result.deleted !== 1 ? 's' : ''}`);
        setSnapshotCounts(prev => ({ ...prev, [objectId]: 0 }));
        
        // Invalidate edge tooltip cache so it shows fresh data
        invalidateInventoryCache(dbParamId);
        
        sessionLogService.success('data-update', 'SNAPSHOT_DELETE_SUCCESS',
          `Deleted ${result.deleted} snapshot rows for ${objectId}`,
          undefined,
          { dbParamId, deleted: result.deleted }
        );
        
        return true;
      } else {
        toast.error(`Failed to delete: ${result.error}`);
        
        sessionLogService.error('data-update', 'SNAPSHOT_DELETE_FAILED',
          `Failed to delete snapshots for ${objectId}`,
          result.error,
          { dbParamId }
        );
        
        return false;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete snapshots: ${errorMessage}`);
      
      sessionLogService.error('data-update', 'SNAPSHOT_DELETE_ERROR',
        `Error deleting snapshots for ${objectId}`,
        errorMessage,
        { dbParamId }
      );
      
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [repo, branch, snapshotCounts, showConfirm]);
  
  return {
    snapshotCounts,
    isLoading,
    deleteSnapshots,
    refreshCounts,
  };
}
