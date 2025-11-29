/**
 * useViewHistory Hook
 * 
 * Centralized hook for viewing file history (commits).
 * Used by FileMenu, NavigatorItemContextMenu, and TabContextMenu.
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { gitService } from '../services/gitService';
import { credentialsManager } from '../lib/credentials';
import { sessionLogService } from '../services/sessionLogService';

export interface HistoryCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  shortSha: string;
}

interface UseViewHistoryResult {
  /** Whether the file can show history (has remote path) */
  canViewHistory: boolean;
  /** Show the history modal */
  showHistoryModal: () => void;
  /** Hide the history modal */
  hideHistoryModal: () => void;
  /** Whether the history modal is visible */
  isHistoryModalOpen: boolean;
  /** Load history for the file */
  loadHistory: () => Promise<HistoryCommit[]>;
  /** Get file content at a specific commit */
  getContentAtCommit: (commitSha: string) => Promise<string | null>;
  /** Rollback file to a specific commit */
  rollbackToCommit: (commitSha: string) => Promise<boolean>;
  /** Current file's path */
  filePath: string | null;
  /** Current file's name */
  fileName: string | null;
  /** Whether history is loading */
  isLoading: boolean;
  /** History commits (loaded after loadHistory) */
  history: HistoryCommit[];
  /** Current file content */
  currentContent: string | null;
}

/**
 * Hook to view file history and optionally rollback to a previous version
 * 
 * @param fileId - The file ID to view history for
 * @returns Object with history viewing and rollback capabilities
 */
export function useViewHistory(fileId: string | undefined): UseViewHistoryResult {
  const { state: navState } = useNavigatorContext();
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<HistoryCommit[]>([]);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  
  const file = fileId ? fileRegistry.getFile(fileId) : null;
  const canViewHistory = !!(file?.source?.path && !file?.isLocal && file?.sha);
  const filePath = file?.source?.path || null;
  const fileName = file?.name || fileId?.split('-').slice(1).join('-') || null;
  
  // Helper to set up git credentials - matches repositoryOperationsService pattern
  const setupGitCredentials = useCallback(async (): Promise<boolean> => {
    const credsResult = await credentialsManager.loadCredentials();
    if (!credsResult.success || !credsResult.credentials) {
      console.error('useViewHistory: No credentials available');
      toast.error('No credentials available');
      return false;
    }
    
    const gitCreds = credsResult.credentials.git?.find(
      (g: any) => g.name === navState.selectedRepo
    );
    
    if (!gitCreds) {
      console.error(`useViewHistory: Repository "${navState.selectedRepo}" not found in credentials`);
      toast.error('No Git credentials found for this repository');
      return false;
    }
    
    // Configure gitService with credentials - use same pattern as repositoryOperationsService
    const fullCredentials = {
      git: [gitCreds],
      defaultGitRepo: navState.selectedRepo
    };
    console.log('useViewHistory: Setting credentials for', `${gitCreds.owner}/${gitCreds.name}`);
    gitService.setCredentials(fullCredentials);
    
    return true;
  }, [navState.selectedRepo]);
  
  const showHistoryModal = useCallback(() => {
    setIsHistoryModalOpen(true);
  }, []);
  
  const hideHistoryModal = useCallback(() => {
    setIsHistoryModalOpen(false);
    setHistory([]);
    setCurrentContent(null);
  }, []);
  
  const loadHistory = useCallback(async (): Promise<HistoryCommit[]> => {
    if (!filePath) {
      toast.error('Cannot load history: file has no remote path');
      return [];
    }
    
    setIsLoading(true);
    
    try {
      // Set up credentials first
      const credsOk = await setupGitCredentials();
      if (!credsOk) {
        setIsLoading(false);
        return [];
      }
      
      const result = await gitService.getFileHistory(filePath, navState.selectedBranch);
      
      if (!result.success || !result.data) {
        toast.error(result.error || 'Failed to load history');
        return [];
      }
      
      // GitHub API returns nested structure: commit.commit.message, commit.commit.author, etc.
      const commits: any[] = result.data;
      const historyCommits: HistoryCommit[] = commits.map(commit => {
        // Handle both nested (from API) and flat (from interface) structures
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
      
      setHistory(historyCommits);
      
      // Also load current content for comparison
      if (file?.data) {
        let content: string;
        if (file.type === 'graph') {
          content = JSON.stringify(file.data, null, 2);
        } else {
          const yaml = await import('yaml');
          content = yaml.stringify(file.data);
        }
        setCurrentContent(content);
      }
      
      return historyCommits;
    } catch (error) {
      toast.error(`Failed to load history: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [filePath, file, setupGitCredentials, navState.selectedBranch]);
  
  const getContentAtCommit = useCallback(async (commitSha: string): Promise<string | null> => {
    if (!filePath) return null;
    
    try {
      // Ensure credentials are set (may have been set by loadHistory, but just in case)
      await setupGitCredentials();
      
      const result = await gitService.getFile(filePath, commitSha);
      
      if (!result.success || !result.data) {
        toast.error(result.error || 'Failed to load file at commit');
        return null;
      }
      
      // Decode base64 content
      const gitFile = result.data;
      if (gitFile.content && gitFile.encoding === 'base64') {
        return atob(gitFile.content);
      }
      
      return gitFile.content || null;
    } catch (error) {
      toast.error(`Failed to load file at commit: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }, [filePath, setupGitCredentials]);
  
  const rollbackToCommit = useCallback(async (commitSha: string): Promise<boolean> => {
    if (!fileId || !filePath) return false;
    
    sessionLogService.info('git', 'FILE_ROLLBACK', `Rolling back ${fileId} to ${commitSha.substring(0, 7)}`, undefined,
      { fileId, filePath, commitSha });
    
    const toastId = toast.loading('Loading version...');
    
    try {
      // Get content at the target commit
      const content = await getContentAtCommit(commitSha);
      if (!content) {
        sessionLogService.error('git', 'FILE_ROLLBACK_ERROR', `Failed to load content at commit ${commitSha.substring(0, 7)}`);
        toast.error('Failed to load version content', { id: toastId });
        return false;
      }
      
      // Parse content
      let data: any;
      if (file?.type === 'graph') {
        data = JSON.parse(content);
      } else {
        const yaml = await import('yaml');
        data = yaml.parse(content);
      }
      
      // Update file in registry (this marks it dirty)
      await fileRegistry.updateFile(fileId, data);
      
      sessionLogService.success('git', 'FILE_ROLLBACK_SUCCESS', `Rolled back ${fileId} to ${commitSha.substring(0, 7)}`,
        'File marked dirty - commit to persist',
        { fileId, filePath, commitSha });
      
      toast.success('Rolled back to selected version (commit to save)', { id: toastId });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      sessionLogService.error('git', 'FILE_ROLLBACK_ERROR', `Rollback failed for ${fileId}: ${errorMessage}`);
      toast.error(`Rollback failed: ${errorMessage}`, { id: toastId });
      return false;
    }
  }, [fileId, filePath, file?.type, getContentAtCommit]);
  
  return {
    canViewHistory,
    showHistoryModal,
    hideHistoryModal,
    isHistoryModalOpen,
    loadHistory,
    getContentAtCommit,
    rollbackToCommit,
    filePath,
    fileName,
    isLoading,
    history,
    currentContent
  };
}

