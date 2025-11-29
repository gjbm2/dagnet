/**
 * useRollbackRepository Hook
 * 
 * Centralized hook for viewing repository commit history and rolling back
 * the entire repo to an earlier state.
 * 
 * Used by RepoMenu.
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { gitService } from '../services/gitService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { credentialsManager } from '../lib/credentials';

export interface RepoCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  shortSha: string;
}

interface UseRollbackRepositoryResult {
  /** Show the repository history modal */
  showModal: () => void;
  /** Hide the modal */
  hideModal: () => void;
  /** Whether the modal is visible */
  isModalOpen: boolean;
  /** Load repository commit history */
  loadHistory: () => Promise<RepoCommit[]>;
  /** Rollback repository to a specific commit */
  rollbackToCommit: (commitSha: string) => Promise<boolean>;
  /** Whether history is loading */
  isLoading: boolean;
  /** Commit history */
  history: RepoCommit[];
  /** Current repository name */
  repoName: string;
  /** Current branch */
  branch: string;
}

/**
 * Hook to view repository history and rollback to an earlier commit
 * 
 * Rollback pulls ALL files from the selected commit into local/IDB,
 * marking them dirty. User must "Commit All" to persist or "Pull All" to revert.
 */
export function useRollbackRepository(): UseRollbackRepositoryResult {
  const { state: navState } = useNavigatorContext();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<RepoCommit[]>([]);
  
  const repoName = navState.selectedRepo || '';
  const branch = navState.selectedBranch || 'main';
  
  // Helper to set up git credentials
  const setupGitCredentials = useCallback(async (): Promise<boolean> => {
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success || !credsResult.credentials) {
      console.error('useRollbackRepository: No credentials available');
      toast.error('No credentials available');
      return false;
    }
    
    const gitCreds = credsResult.credentials.git?.find(
      (g: any) => g.name === navState.selectedRepo
    );
    
    if (!gitCreds) {
      console.error(`useRollbackRepository: Repository "${navState.selectedRepo}" not found in credentials`);
      toast.error('No Git credentials found for this repository');
      return false;
    }
    
    // Configure gitService with credentials
    const fullCredentials = {
      git: [gitCreds],
      defaultGitRepo: navState.selectedRepo
    };
    console.log('useRollbackRepository: Setting credentials for', `${gitCreds.owner}/${gitCreds.name}`);
    gitService.setCredentials(fullCredentials);
    
    return true;
  }, [navState.selectedRepo]);
  
  const showModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);
  
  const hideModal = useCallback(() => {
    setIsModalOpen(false);
    setHistory([]);
  }, []);
  
  const loadHistory = useCallback(async (): Promise<RepoCommit[]> => {
    setIsLoading(true);
    
    try {
      // Set up credentials first
      const credsOk = await setupGitCredentials();
      if (!credsOk) {
        setIsLoading(false);
        return [];
      }
      
      // GitHub API max is 100 per page - gets commit metadata only (no file contents)
      const result = await gitService.getRepositoryCommits(branch, 100);
      
      if (!result.success || !result.data) {
        toast.error(result.error || 'Failed to load repository history');
        return [];
      }
      
      // GitHub API returns nested structure
      const commits: any[] = result.data;
      const repoCommits: RepoCommit[] = commits.map(commit => {
        const commitData = commit.commit || commit;
        const message = commitData.message || 'No message';
        const author = commitData.author?.name || commit.author?.login || 'Unknown';
        const date = commitData.author?.date || commitData.committer?.date || '';
        
        return {
          sha: commit.sha,
          shortSha: commit.sha.substring(0, 7),
          message: message.split('\n')[0], // First line only
          author,
          date
        };
      });
      
      setHistory(repoCommits);
      return repoCommits;
    } catch (error) {
      toast.error(`Failed to load history: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [branch, setupGitCredentials]);
  
  const rollbackToCommit = useCallback(async (commitSha: string): Promise<boolean> => {
    const toastId = toast.loading('Rolling back repository...');
    
    try {
      // Use repositoryOperationsService.rollbackToCommit
      // This fetches all files from the commit and updates local/IDB
      const result = await repositoryOperationsService.rollbackToCommit(
        navState.selectedRepo,
        branch,
        commitSha
      );
      
      if (!result.success) {
        toast.error('Failed to rollback repository', { id: toastId });
        return false;
      }
      
      toast.success(`Rolled back ${result.filesChanged} files (Commit All to save, Pull All to revert)`, { id: toastId });
      return true;
    } catch (error) {
      toast.error(`Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: toastId });
      return false;
    }
  }, [navState.selectedRepo, branch]);
  
  return {
    showModal,
    hideModal,
    isModalOpen,
    loadHistory,
    rollbackToCommit,
    isLoading,
    history,
    repoName,
    branch
  };
}

