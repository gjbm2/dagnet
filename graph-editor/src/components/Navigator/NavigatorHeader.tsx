import React, { useState } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import { gitService } from '../../services/gitService';
import { CommitModal } from '../CommitModal';

/**
 * Navigator Header
 * 
 * Appears inline with tab bar when navigator is open
 * Contains:
 * - Search input
 * - Pull button
 * - Commit button (when files are dirty)
 * - Branch dropdown
 * - Pin button
 * - Close button
 */
export function NavigatorHeader() {
  const { state, operations } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  const dirtyTabs = tabOps.getDirtyTabs();
  const hasDirtyFiles = dirtyTabs.length > 0;

  const handlePull = async () => {
    setIsPulling(true);
    setPullError(null);
    
    try {
      const result = await gitService.pullLatest(state.selectedBranch || 'main');
      if (result.success) {
        console.log('Pull successful:', result.message);
        // TODO: Refresh navigator content
        operations.refreshItems();
      } else {
        setPullError(result.error || 'Failed to pull latest changes');
      }
    } catch (error) {
      setPullError(error instanceof Error ? error.message : 'Failed to pull latest changes');
    } finally {
      setIsPulling(false);
    }
  };

  const handleCommit = () => {
    setIsCommitModalOpen(true);
  };

  const handleCommitFiles = async (files: any[], message: string, branch: string) => {
    try {
      // Load credentials to get repo info
      const { credentialsManager } = await import('../../lib/credentials');
      const credentialsResult = await credentialsManager.loadCredentials();
      
      if (!credentialsResult.success || !credentialsResult.credentials) {
        throw new Error('No credentials available. Please configure credentials first.');
      }

      // Get credentials for selected repo
      const selectedRepo = state.selectedRepo;
      const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === selectedRepo);
      
      if (!gitCreds) {
        throw new Error(`No credentials found for repository ${selectedRepo}`);
      }

      // Set credentials on gitService with selected repo as default
      const credentialsWithRepo = {
        ...credentialsResult.credentials,
        defaultGitRepo: selectedRepo
      };
      gitService.setCredentials(credentialsWithRepo);

      // Prepare files with proper paths including basePath
      const filesToCommit = files.map(file => {
        const basePath = gitCreds.basePath || '';
        const fullPath = basePath ? `${basePath}/${file.path}` : file.path;
        return {
          path: fullPath,
          content: file.content,
          sha: file.sha
        };
      });

      const result = await gitService.commitAndPushFiles(filesToCommit, message, branch);
      if (result.success) {
        console.log('Commit successful:', result.message);
        // Mark files as saved
        for (const file of files) {
          const fileId = file.fileId;
          await fileRegistry.markSaved(fileId);
        }
        // TODO: Refresh navigator - for now just log success
      } else {
        throw new Error(result.error || 'Failed to commit files');
      }
    } catch (error) {
      throw error; // Re-throw to be handled by CommitModal
    }
  };

  return (
    <>
      <div className="navigator-header">
        <div className="navigator-search">
          <input
            type="text"
            placeholder="🔍 Search..."
            value={state.searchQuery}
            onChange={(e) => operations.setSearchQuery(e.target.value)}
            className="navigator-search-input"
          />
        </div>

        <div className="navigator-controls">
          {/* Pull button - always visible */}
          <button
            className="navigator-control-btn"
            onClick={handlePull}
            disabled={isPulling}
            title="Pull Latest Changes"
          >
            {isPulling ? '⏳' : '⬇️'}
          </button>

          {/* Commit button - only when files are dirty */}
          {hasDirtyFiles && (
            <button
              className="navigator-control-btn"
              onClick={handleCommit}
              title={`Commit ${dirtyTabs.length} file${dirtyTabs.length === 1 ? '' : 's'}`}
            >
              💾
            </button>
          )}

          {/* Branch dropdown - TODO: implement in Phase 1b */}
          <div className="navigator-branch">
            <span style={{ fontSize: '12px', color: '#666' }}>
              {state.selectedBranch || 'main'}
            </span>
          </div>

          <button
            className={`navigator-control-btn ${state.isPinned ? 'active' : ''}`}
            onClick={operations.togglePin}
            title={state.isPinned ? 'Unpin Navigator' : 'Pin Navigator'}
          >
            📌
          </button>

          <button
            className="navigator-control-btn"
            onClick={operations.toggleNavigator}
            title="Close Navigator"
          >
            ×
          </button>
        </div>
      </div>

      {/* Pull error message */}
      {pullError && (
        <div style={{
          padding: '8px 12px',
          backgroundColor: '#fee',
          border: '1px solid #fcc',
          color: '#c33',
          fontSize: '12px',
          margin: '4px 0'
        }}>
          Pull failed: {pullError}
          <button
            onClick={() => setPullError(null)}
            style={{
              float: 'right',
              background: 'none',
              border: 'none',
              color: '#c33',
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Commit Modal */}
      <CommitModal
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
        onCommit={handleCommitFiles}
      />
    </>
  );
}

