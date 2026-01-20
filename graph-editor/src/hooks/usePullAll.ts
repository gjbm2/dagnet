/**
 * usePullAll Hook
 * 
 * Centralized hook for pulling all latest changes from remote.
 * Used by RepositoryMenu, FileMenu, and any context menu that needs "Pull All Latest".
 * 
 * IMPORTANT: This hook manages ALL pull-all logic including conflict resolution.
 * Menus should NOT have any logic - just call pullAll() and render {conflictModal}.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { gitConfig } from '../config/gitConfig';
import { MergeConflictModal, ConflictFile } from '../components/modals/MergeConflictModal';
import { conflictResolutionService } from '../services/conflictResolutionService';
import { ForceReplaceOnPullModal, type ForceReplaceOnPullRequest } from '../components/modals/ForceReplaceOnPullModal';
import { sessionLogService } from '../services/sessionLogService';

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

  // Force-replace-on-pull confirmation (one-shot, per-file, countdown)
  const [isForceReplaceModalOpen, setIsForceReplaceModalOpen] = useState(false);
  const [forceReplaceRequests, setForceReplaceRequests] = useState<ForceReplaceOnPullRequest[]>([]);
  const [forceReplaceCountdownSeconds, setForceReplaceCountdownSeconds] = useState<number>(0);
  const forceReplaceResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const forceReplaceIntervalRef = useRef<number | null>(null);

  const closeForceReplaceModal = useCallback(() => {
    if (forceReplaceIntervalRef.current !== null) {
      window.clearInterval(forceReplaceIntervalRef.current);
      forceReplaceIntervalRef.current = null;
    }
    setIsForceReplaceModalOpen(false);
    setForceReplaceRequests([]);
    setForceReplaceCountdownSeconds(0);
  }, []);

  const resolveForceReplace = useCallback((ok: boolean) => {
    const resolve = forceReplaceResolveRef.current;
    forceReplaceResolveRef.current = null;
    closeForceReplaceModal();
    try {
      sessionLogService.info(
        'git',
        'GIT_PULL_FORCE_REPLACE_CHOICE',
        ok ? 'User accepted force replace (overwrite remote)' : 'User declined force replace (merge normally)',
        undefined,
        { accepted: ok }
      );
    } catch {
      // best-effort
    }
    resolve?.(ok);
  }, [closeForceReplaceModal]);

  const promptForceReplace = useCallback(async (requests: ForceReplaceOnPullRequest[]): Promise<boolean> => {
    // Guard: only allow one prompt at a time.
    if (forceReplaceResolveRef.current) {
      // Default to OK if we somehow re-enter (should not happen).
      return true;
    }

    setForceReplaceRequests(requests);
    setIsForceReplaceModalOpen(true);
    setForceReplaceCountdownSeconds(10);

    try {
      sessionLogService.warning(
        'git',
        'GIT_PULL_FORCE_REPLACE_PROMPT',
        `Force replace requested for ${requests.length} file(s) - awaiting user choice`,
        undefined,
        { files: requests.map(r => ({ fileId: r.fileId, path: r.path })) }
      );
    } catch {
      // best-effort
    }

    // Start countdown interval
    forceReplaceIntervalRef.current = window.setInterval(() => {
      setForceReplaceCountdownSeconds(prev => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return await new Promise<boolean>((resolve) => {
      forceReplaceResolveRef.current = resolve;
    });
  }, []);

  // Auto-confirm when countdown reaches 0
  useEffect(() => {
    if (!isForceReplaceModalOpen) return;
    if (forceReplaceCountdownSeconds !== 0) return;
    resolveForceReplace(true);
  }, [isForceReplaceModalOpen, forceReplaceCountdownSeconds, resolveForceReplace]);
  
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
    let applyToastId: string | undefined;
    
    try {
      // Step A: detect force-replace requests (may still apply non-flagged updates).
      const preflight = await repositoryOperationsService.pullLatest(selectedRepo, selectedBranch, {
        forceReplace: { mode: 'detect' },
      });

      const requested = (preflight.forceReplaceRequests || []) as any[];
      let result = preflight;

      if (requested.length > 0) {
        toast.dismiss(toastId);
        const uiRequests: ForceReplaceOnPullRequest[] = requested.map((r: any) => ({
          fileId: r.fileId,
          fileName: r.fileName,
          path: r.path,
        }));

        const ok = await promptForceReplace(uiRequests);
        const allowFileIds = ok ? uiRequests.map(r => r.fileId) : [];

        applyToastId = toast.loading('Finalising pull...');
        result = await repositoryOperationsService.pullLatest(selectedRepo, selectedBranch, {
          forceReplace: { mode: 'apply', allowFileIds },
        });
        toast.dismiss(applyToastId);
        applyToastId = undefined;
      } else {
        toast.dismiss(toastId);
      }

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
      if (applyToastId) toast.dismiss(applyToastId);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Pull failed: ${errorMessage}`);
      return { success: false };
    } finally {
      setIsPulling(false);
    }
  }, [navState.selectedRepo, navState.selectedBranch, promptForceReplace]);
  
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

  const forceReplaceModal = React.createElement(ForceReplaceOnPullModal, {
    isOpen: isForceReplaceModalOpen,
    countdownSeconds: forceReplaceCountdownSeconds,
    requests: forceReplaceRequests,
    onOk: () => resolveForceReplace(true),
    onCancel: () => resolveForceReplace(false),
  });
  
  return { isPulling, pullAll, conflictModal: React.createElement(React.Fragment, null, conflictModal as any, forceReplaceModal) };
}
