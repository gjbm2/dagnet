/**
 * useCommitHandler
 *
 * Centralized hook for commit operations with remote-ahead detection
 * and commit-time hash guard.
 * Use this hook in any component that needs to commit files.
 *
 * This is the SINGLE place where commit UI logic lives.
 */

import { useCallback, useState } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useDialog } from '../contexts/DialogContext';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { operationRegistryService } from '../services/operationRegistryService';
import type { HashGuardResult, HashChangeItem } from '../services/commitHashGuardService';

/** State for the hash mapping modal, managed by this hook. */
export interface HashGuardModalState {
  isOpen: boolean;
  result: HashGuardResult | null;
  resolve: ((items: HashChangeItem[]) => void) | null;
}

export function useCommitHandler() {
  const { state: navState } = useNavigatorContext();
  const { showTripleChoice } = useDialog();

  // State for hash guard modal — exposed so AppShell can render the modal
  const [hashGuardState, setHashGuardState] = useState<HashGuardModalState>({
    isOpen: false, result: null, resolve: null,
  });

  const handleHashGuard = useCallback(async (result: HashGuardResult): Promise<HashChangeItem[]> => {
    return new Promise<HashChangeItem[]>((resolve) => {
      setHashGuardState({ isOpen: true, result, resolve });
    });
  }, []);

  const handleHashGuardConfirm = useCallback((items: HashChangeItem[]) => {
    hashGuardState.resolve?.(items);
    setHashGuardState({ isOpen: false, result: null, resolve: null });
  }, [hashGuardState.resolve]);

  const handleHashGuardCancel = useCallback(() => {
    hashGuardState.resolve?.([]);
    setHashGuardState({ isOpen: false, result: null, resolve: null });
  }, [hashGuardState.resolve]);

  const handleCommitFiles = useCallback(async (
    files: any[],
    message: string,
    branch: string,
    onProgress?: (completed: number, total: number, phase: 'uploading' | 'finalising') => void,
    repository?: string  // Optional - defaults to navState.selectedRepo
  ) => {
    const repo = repository || navState.selectedRepo;

    const handlePull = async () => {
      const opId = `pre-commit-pull:${Date.now()}`;
      operationRegistryService.register({ id: opId, kind: 'git-pull', label: 'Pulling latest changes…', status: 'running' });
      try {
        await repositoryOperationsService.pullLatest(repo, branch);
        operationRegistryService.setLabel(opId, 'Pull complete — please commit again');
        operationRegistryService.complete(opId, 'complete');
      } catch (error) {
        operationRegistryService.complete(opId, 'error', `Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    };

    await repositoryOperationsService.commitFiles(
      files, message, branch, repo,
      showTripleChoice, handlePull, onProgress,
      handleHashGuard,
    );
  }, [navState.selectedRepo, showTripleChoice, handleHashGuard]);

  return {
    handleCommitFiles,
    hashGuardState,
    handleHashGuardConfirm,
    handleHashGuardCancel,
  };
}

