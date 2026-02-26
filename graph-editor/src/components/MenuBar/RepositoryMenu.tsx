import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext, useIsReadOnly } from '../../contexts/NavigatorContext';
import { useDialog } from '../../contexts/DialogContext';
import { useCommitHandler } from '../../hooks/useCommitHandler';
import { usePullAll } from '../../hooks/usePullAll';
import { useRollbackRepository } from '../../hooks/useRollbackRepository';
import { SwitchRepositoryModal } from '../modals/SwitchRepositoryModal';
import { SwitchBranchModal } from '../modals/SwitchBranchModal';
import { NewBranchModal } from '../modals/NewBranchModal';
import { MergeBranchModal } from '../modals/MergeBranchModal';
import { RepositoryHistoryModal } from '../modals/RepositoryHistoryModal';
// MergeConflictModal is handled by usePullAll hook
import { CommitModal } from '../CommitModal';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import { workspaceService } from '../../services/workspaceService';
import type { MergeConflict } from '../../services/workspaceService';
import { gitService } from '../../services/gitService';
import { credentialsManager } from '../../lib/credentials';
import { startOAuthFlow, isOAuthEnabled } from '../../services/githubOAuthService';
import toast from 'react-hot-toast';
import YAML from 'yaml';
import type { ObjectType } from '../../types';

/**
 * Repository Menu
 * 
 * Repository operations:
 * - Switch Repository (guarded)
 * - Switch Branch (guarded)
 * - Pull Latest
 * - Push Changes
 * - Refresh Status
 * - Show Dirty Files
 * - Discard Local Changes
 */
export function RepositoryMenu() {
  const { operations, activeTabId } = useTabContext();
  const { state, operations: navOps } = useNavigatorContext();
  const { showConfirm } = useDialog();
  const { handleCommitFiles: commitFiles } = useCommitHandler();
  const isReadOnly = useIsReadOnly();
  const oauthEnabled = isOAuthEnabled();

  const [connectedUser, setConnectedUser] = useState<string | null>(null);
  React.useEffect(() => {
    const check = async () => {
      if (!state.selectedRepo) { setConnectedUser(null); return; }
      const result = await credentialsManager.loadCredentials();
      const gitCreds = result.credentials?.git?.find((c: any) => c.name === state.selectedRepo);
      const token = gitCreds?.token || '';
      // A token starting with "ghu_" is a GitHub App user token (from our OAuth flow)
      setConnectedUser(token.startsWith('ghu_') ? (gitCreds?.userName || null) : null);
    };
    check();
  }, [state.selectedRepo, isReadOnly]);

  const [isSwitchRepoModalOpen, setIsSwitchRepoModalOpen] = useState(false);
  const [isSwitchBranchModalOpen, setIsSwitchBranchModalOpen] = useState(false);
  const [isNewBranchModalOpen, setIsNewBranchModalOpen] = useState(false);
  const [isMergeBranchModalOpen, setIsMergeBranchModalOpen] = useState(false);
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  
  // Pull all hook - manages everything including conflict modal
  const { isPulling, pullAll, conflictModal: pullAllConflictModal } = usePullAll();
  
  // Repository history/rollback hook
  const {
    showModal: showRepoHistoryModal,
    hideModal: hideRepoHistoryModal,
    isModalOpen: isRepoHistoryModalOpen,
    loadHistory: loadRepoHistory,
    rollbackToCommit,
    isLoading: isRepoHistoryLoading,
    history: repoHistory,
    repoName,
    branch: repoBranch
  } = useRollbackRepository();

  const dirtyTabs = operations.getDirtyTabs();
  const [dirtyFiles, setDirtyFiles] = React.useState<any[]>([]);
  const hasDirtyFiles = dirtyFiles.length > 0;
  const hasActiveTab = !!activeTabId;
  
  // Load dirty files using content-based detection (more reliable than isDirty flag)
  React.useEffect(() => {
    const loadDirtyFiles = async () => {
      // Use content-based detection which compares data to originalData
      // This works reliably across page refreshes
      const files = await repositoryOperationsService.getCommittableFiles(
        state.selectedRepo,
        state.selectedBranch
      );
      setDirtyFiles(files);
    };
    loadDirtyFiles();
    
    const handleDirtyChange = () => loadDirtyFiles();
    window.addEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
    return () => window.removeEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
  }, [state.selectedRepo, state.selectedBranch]);

  const handleSwitchRepository = () => {
    setIsSwitchRepoModalOpen(true);
  };

  const handleSwitchBranch = () => {
    setIsSwitchBranchModalOpen(true);
  };

  const handleForceClone = async () => {
    // Warn if there are dirty files
    if (hasDirtyFiles) {
      const confirmed = await showConfirm({
        title: 'Force Full Reload',
        message: 
          `You have ${dirtyFiles.length} uncommitted file(s).\n\n` +
          'Force Full Reload will:\n' +
          '• Delete your local workspace\n' +
          '• Re-clone from remote repository\n' +
          '• DISCARD ALL LOCAL CHANGES\n\n' +
          'This cannot be undone. Continue?',
        confirmLabel: 'Force Reload',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger'
      });
      
      if (!confirmed) return;
    }
    
    try {
      const toastId = toast.loading('Force reloading workspace...');
      await repositoryOperationsService.forceFullReload(state.selectedRepo, state.selectedBranch, true);
      toast.dismiss(toastId);
      toast.success('Workspace reloaded');
    } catch (error) {
      console.error('Failed to force reload:', error);
      toast.error(`Force reload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };


  const handleCommitChanges = () => {
    // Open commit modal - remote-ahead check happens inside commitFiles
    setIsCommitModalOpen(true);
  };

  const handleCommitFiles = async (files: any[], message: string, branch: string) => {
    await commitFiles(files, message, branch);
    toast.success(`Committed ${files.length} file(s)`);
  };

  const handleRefreshStatus = async () => {
    try {
      const status = await repositoryOperationsService.getStatus(state.selectedRepo, state.selectedBranch);
      console.log('Repository status:', status);
      alert(`Repository: ${status.repository}/${status.branch}\nDirty files: ${status.dirtyFiles}\nLocal only: ${status.localOnlyFiles}`);
    } catch (error) {
      console.error('Failed to get status:', error);
    }
  };

  const handleShowDirtyFiles = () => {
    const dirtyFiles = repositoryOperationsService.getDirtyFiles();
    console.log('Dirty files:', dirtyFiles);
    alert(`Dirty files:\n${dirtyFiles.map(f => f.fileId).join('\n')}`);
  };

  const handleDiscardLocalChanges = async () => {
    if (!confirm('Discard all local changes? This cannot be undone.')) return;
    
    try {
      const count = await repositoryOperationsService.discardLocalChanges(
        state.selectedRepo,
        state.selectedBranch
      );
      console.log(`✅ Discarded ${count} changes`);
    } catch (error) {
      console.error('Failed to discard changes:', error);
    }
  };

  return (
    <>
      <Menubar.Menu>
        <Menubar.Trigger className="menubar-trigger" title={isReadOnly ? 'Read-only mode (no GitHub token)' : undefined}>
          Repository
          {oauthEnabled && connectedUser && (
            <span style={{
              marginLeft: '4px',
              fontSize: '9px',
              padding: '1px 4px',
              borderRadius: '3px',
              background: '#d1fae5',
              color: '#065f46',
              fontWeight: 500
            }}>
              @{connectedUser}
            </span>
          )}
          {oauthEnabled && !connectedUser && isReadOnly && (
            <span
              style={{
                marginLeft: '4px',
                fontSize: '9px',
                padding: '1px 4px',
                borderRadius: '3px',
                background: '#fef3c7',
                color: '#92400e',
                fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Click to connect your GitHub account for write access"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (state.selectedRepo) {
                  startOAuthFlow(state.selectedRepo);
                }
              }}
            >
              read-only 🔗
            </span>
          )}
          {!oauthEnabled && isReadOnly && (
            <span style={{ 
              marginLeft: '4px', 
              fontSize: '9px', 
              padding: '1px 4px', 
              borderRadius: '3px',
              background: '#fef3c7',
              color: '#92400e',
              fontWeight: 500
            }}>
              read-only
            </span>
          )}
        </Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className="menubar-content" align="start">
            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleSwitchRepository}
            >
              Switch Repository...
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleSwitchBranch}
            >
              Switch Branch...
              <div className="menubar-right-slot">⌘B</div>
            </Menubar.Item>

            <Menubar.Item
              className="menubar-item"
              onSelect={() => setIsNewBranchModalOpen(true)}
              disabled={isReadOnly === true}
            >
              New Branch...
              {isReadOnly && <div className="menubar-right-slot" style={{ fontSize: '10px', opacity: 0.7 }}>read-only</div>}
            </Menubar.Item>

            <Menubar.Item
              className="menubar-item"
              onSelect={() => setIsMergeBranchModalOpen(true)}
              disabled={isReadOnly === true}
            >
              Merge Branch...
              {isReadOnly && <div className="menubar-right-slot" style={{ fontSize: '10px', opacity: 0.7 }}>read-only</div>}
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleForceClone}
            >
              Force Full Reload
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={pullAll}
              disabled={isPulling}
            >
              Pull All Latest
              <div className="menubar-right-slot">⌘P</div>
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleCommitChanges}
              disabled={!hasDirtyFiles || isReadOnly === true}
              title={isReadOnly ? 'Read-only mode (no GitHub token configured)' : undefined}
            >
              Commit All Changes...
              {isReadOnly && <div className="menubar-right-slot" style={{ fontSize: '10px', opacity: 0.7 }}>read-only</div>}
              {!isReadOnly && hasDirtyFiles && <div className="menubar-right-slot">{dirtyFiles.length}</div>}
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={showRepoHistoryModal}
            >
              View Repository History...
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleRefreshStatus}
            >
              Refresh Status
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleShowDirtyFiles}
              disabled={!hasDirtyFiles}
            >
              Show Dirty Files
              {hasDirtyFiles && <div className="menubar-right-slot">{dirtyFiles.length}</div>}
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleDiscardLocalChanges}
              disabled={!hasDirtyFiles}
            >
              Discard Local Changes...
            </Menubar.Item>
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>

      {/* Modals */}
      <SwitchRepositoryModal
        isOpen={isSwitchRepoModalOpen}
        onClose={() => setIsSwitchRepoModalOpen(false)}
      />
      <SwitchBranchModal
        isOpen={isSwitchBranchModalOpen}
        onClose={() => setIsSwitchBranchModalOpen(false)}
      />
      <NewBranchModal
        isOpen={isNewBranchModalOpen}
        onClose={() => setIsNewBranchModalOpen(false)}
      />
      <MergeBranchModal
        isOpen={isMergeBranchModalOpen}
        onClose={() => setIsMergeBranchModalOpen(false)}
      />
      {/* Pull all conflict modal - managed by usePullAll hook */}
      {pullAllConflictModal}
      <CommitModal
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
        onCommit={handleCommitFiles}
        preselectedFiles={[]}
      />
      <RepositoryHistoryModal
        isOpen={isRepoHistoryModalOpen}
        onClose={hideRepoHistoryModal}
        repoName={repoName}
        branch={repoBranch}
        isLoading={isRepoHistoryLoading}
        history={repoHistory}
        onLoadHistory={loadRepoHistory}
        onRollback={rollbackToCommit}
      />
    </>
  );
}
