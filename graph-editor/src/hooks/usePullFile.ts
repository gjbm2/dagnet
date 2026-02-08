/**
 * usePullFile Hook
 * 
 * Centralized hook for pulling latest version of a single file from remote.
 * Used by NavigatorItemContextMenu, TabContextMenu, and FileMenu.
 */

import { useCallback } from 'react';
import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { repositoryOperationsService } from '../services/repositoryOperationsService';

interface UsePullFileResult {
  /** Whether the file can be pulled (has remote path and is not local-only) */
  canPull: boolean;
  /** Pull the file from remote */
  pullFile: () => Promise<void>;
}

/**
 * Hook to pull latest version of a file from remote
 * 
 * @param fileId - The file ID to pull (e.g., 'parameter-my-param', 'graph-my-graph')
 * @returns Object with canPull flag and pullFile function
 */
export function usePullFile(fileId: string | undefined): UsePullFileResult {
  const { state: navState } = useNavigatorContext();
  
  const file = fileId ? fileRegistry.getFile(fileId) : null;
  // Temporary/historical files cannot be pulled from remote
  const canPull = !!(file?.source?.path && !file?.isLocal && file?.source?.repository !== 'temporary');
  
  const pullFile = useCallback(async () => {
    if (!fileId || !canPull) return;
    
    try {
      const result = await repositoryOperationsService.pullFile(
        fileId,
        navState.selectedRepo,
        navState.selectedBranch
      );
      toast.success(result.message || 'File updated from remote');
    } catch (error) {
      toast.error(`Failed to pull: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [fileId, canPull, navState.selectedRepo, navState.selectedBranch]);
  
  return { canPull, pullFile };
}

