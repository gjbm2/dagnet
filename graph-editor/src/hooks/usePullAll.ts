/**
 * usePullAll Hook
 * 
 * Centralized hook for pulling all latest changes from remote.
 * Used by RepositoryMenu, FileMenu, and any context menu that needs "Pull All Latest".
 * 
 * IMPORTANT: This hook manages ALL pull-all logic including conflict resolution.
 * Menus should NOT have any logic - just call pullAll() and render {conflictModal}.
 */

import React, { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { gitConfig } from '../config/gitConfig';
import { MergeConflictModal, ConflictFile } from '../components/modals/MergeConflictModal';
import { conflictResolutionService } from '../services/conflictResolutionService';

interface UsePullAllResult {
  /** Whether a pull operation is in progress */
  isPulling: boolean;
  /** Pull all latest changes from remote */
  pullAll: () => Promise<{ success: boolean; conflicts?: ConflictFile[] }>;
  /** Render this in your component to show conflict modal when needed */
  conflictModal: React.ReactNode;
}

/**
 * Hook to pull all latest changes from remote repository
 * 
 * Usage:
 * ```tsx
 * const { pullAll, isPulling, conflictModal } = usePullAll();
 * 
 * return (
 *   <>
 *     <button onClick={pullAll} disabled={isPulling}>Pull All</button>
 *     {conflictModal}
 *   </>
 * );
 * ```
 */
export function usePullAll(): UsePullAllResult {
  const { state: navState, operations: navOps } = useNavigatorContext();
  const [isPulling, setIsPulling] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [isConflictModalOpen, setIsConflictModalOpen] = useState(false);
  
  const handleResolveConflicts = useCallback(async (resolutions: Map<string, 'local' | 'remote' | 'manual'>) => {
    const resolvedCount = await conflictResolutionService.applyResolutions(conflicts as any, resolutions);
    
    // Refresh navigator to show updated state
    await navOps.refreshItems();
    
    if (resolvedCount > 0) {
      toast.success(`Resolved ${resolvedCount} conflict${resolvedCount !== 1 ? 's' : ''}`);
    }
    
    setIsConflictModalOpen(false);
    setConflicts([]);
  }, [conflicts, navOps]);
  
  const pullAll = useCallback(async () => {
    const selectedRepo = navState.selectedRepo;
    const selectedBranch = navState.selectedBranch || gitConfig.branch;
    
    if (!selectedRepo) {
      toast.error('No repository selected. Please select a repository first.');
      return { success: false };
    }
    
    setIsPulling(true);
    const toastId = toast.loading('Pulling latest changes...');
    
    try {
      const result = await repositoryOperationsService.pullLatest(selectedRepo, selectedBranch);
      
      toast.dismiss(toastId);
      
      if (result.conflicts && result.conflicts.length > 0) {
        toast.error(`Pull completed with ${result.conflicts.length} conflict(s)`, { duration: 5000 });
        const typedConflicts = result.conflicts as ConflictFile[];
        setConflicts(typedConflicts);
        setIsConflictModalOpen(true);
        return { success: true, conflicts: typedConflicts };
      } else {
        toast.success('Successfully pulled latest changes');
        return { success: true };
      }
    } catch (error) {
      toast.dismiss(toastId);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Pull failed: ${errorMessage}`);
      return { success: false };
    } finally {
      setIsPulling(false);
    }
  }, [navState.selectedRepo, navState.selectedBranch]);
  
  // The modal component - menus just render this, no logic needed
  const conflictModal = React.createElement(MergeConflictModal, {
    isOpen: isConflictModalOpen,
    onClose: () => {
      setIsConflictModalOpen(false);
      setConflicts([]);
    },
    conflicts: conflicts,
    onResolve: handleResolveConflicts
  });
  
  return { isPulling, pullAll, conflictModal };
}
