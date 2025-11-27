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
import toast from 'react-hot-toast';

export function useCommitHandler() {
  const { state: navState } = useNavigatorContext();
  const { showTripleChoice } = useDialog();

  const handleCommitFiles = useCallback(async (
    files: any[], 
    message: string, 
    branch: string,
    repository?: string  // Optional - defaults to navState.selectedRepo
  ) => {
    const repo = repository || navState.selectedRepo;
    
    const handlePull = async () => {
      const toastId = toast.loading('Pulling latest changes...');
      try {
        await repositoryOperationsService.pullLatest(repo, branch);
        toast.dismiss(toastId);
        toast.success('Pull complete! Please commit again.');
      } catch (error) {
        toast.dismiss(toastId);
        toast.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    };

    await repositoryOperationsService.commitFiles(
      files, message, branch, repo,
      showTripleChoice, handlePull
    );
  }, [navState.selectedRepo, showTripleChoice]);

  return { handleCommitFiles };
}

