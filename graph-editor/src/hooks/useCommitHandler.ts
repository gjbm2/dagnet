/**
 * useCommitHandler
 * 
 * Centralized hook for commit operations with remote-ahead detection.
 * Use this hook in any component that needs to commit files.
 * 
 * This is the SINGLE place where commit UI logic lives.
 */

import { useCallback } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useDialog } from '../contexts/DialogContext';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { operationRegistryService } from '../services/operationRegistryService';

export function useCommitHandler() {
  const { state: navState } = useNavigatorContext();
  const { showTripleChoice } = useDialog();

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
      showTripleChoice, handlePull, onProgress
    );
  }, [navState.selectedRepo, showTripleChoice]);

  return { handleCommitFiles };
}

