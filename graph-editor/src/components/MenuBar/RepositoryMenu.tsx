import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useDialog } from '../../contexts/DialogContext';
import { SwitchRepositoryModal } from '../modals/SwitchRepositoryModal';
import { SwitchBranchModal } from '../modals/SwitchBranchModal';
import { MergeConflictModal, ConflictFile } from '../modals/MergeConflictModal';
import { CommitModal } from '../CommitModal';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import { workspaceService } from '../../services/workspaceService';
import type { MergeConflict } from '../../services/workspaceService';
import { gitService } from '../../services/gitService';
import { credentialsManager } from '../../lib/credentials';
import { db } from '../../db/appDatabase';
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
  
  const [isSwitchRepoModalOpen, setIsSwitchRepoModalOpen] = useState(false);
  const [isSwitchBranchModalOpen, setIsSwitchBranchModalOpen] = useState(false);
  const [isMergeConflictModalOpen, setIsMergeConflictModalOpen] = useState(false);
  const [mergeConflicts, setMergeConflicts] = useState<ConflictFile[]>([]);
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);

  const dirtyTabs = operations.getDirtyTabs();
  const [dirtyFiles, setDirtyFiles] = React.useState<any[]>([]);
  const hasDirtyFiles = dirtyFiles.length > 0;
  const hasActiveTab = !!activeTabId;
  
  // Load dirty files from IndexedDB (not just FileRegistry)
  React.useEffect(() => {
    const loadDirtyFiles = async () => {
      const files = await db.getDirtyFiles();
      setDirtyFiles(files);
    };
    loadDirtyFiles();
    
    const handleDirtyChange = () => loadDirtyFiles();
    window.addEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
    return () => window.removeEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
  }, []);

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

  const handlePullLatest = async () => {
    try {
      const toastId = toast.loading('Pulling latest changes...');
      const result = await repositoryOperationsService.pullLatest(state.selectedRepo, state.selectedBranch);
      toast.dismiss(toastId);
      
      if (result.conflicts && result.conflicts.length > 0) {
        // Show conflict resolution modal
        setMergeConflicts(result.conflicts);
        setIsMergeConflictModalOpen(true);
        toast.error(`Pull completed with ${result.conflicts.length} conflict(s)`, { duration: 5000 });
      } else {
        toast.success('Successfully pulled latest changes');
      }
    } catch (error) {
      console.error('Failed to pull latest:', error);
      toast.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleResolveConflicts = async (resolutions: Map<string, 'local' | 'remote' | 'manual'>) => {
    const { conflictResolutionService } = await import('../../services/conflictResolutionService');
    
    // Convert ConflictFile[] to MergeConflict[]
    const mergeConflictsConverted: MergeConflict[] = mergeConflicts.map(cf => ({
      fileId: cf.fileId,
      fileName: cf.fileName,
      path: cf.path,
      type: cf.type as ObjectType,
      localContent: cf.localContent,
      remoteContent: cf.remoteContent,
      baseContent: cf.baseContent,
      mergedContent: cf.mergedContent,
      hasConflicts: cf.hasConflicts
    }));
    
    const resolvedCount = await conflictResolutionService.applyResolutions(mergeConflictsConverted, resolutions);
    
    // Refresh navigator to show updated state
    await navOps.refreshItems();
    
    if (resolvedCount > 0) {
      toast.success(`Resolved ${resolvedCount} conflict${resolvedCount !== 1 ? 's' : ''}`);
    }
  };

  const handleCommitChanges = async () => {
    try {
      // Check if remote is ahead before committing
      const credsResult = await credentialsManager.loadCredentials();
      
      if (credsResult.success && credsResult.credentials) {
        const gitCreds = credsResult.credentials.git.find(cred => cred.name === state.selectedRepo);
        
        if (gitCreds) {
          const toastId = toast.loading('Checking remote status...');
          const remoteStatus = await workspaceService.checkRemoteAhead(
            state.selectedRepo,
            state.selectedBranch,
            gitCreds
          );
          toast.dismiss(toastId);
          
          if (remoteStatus.isAhead) {
            const confirmed = await showConfirm({
              title: 'Remote Has Changes',
              message: 
                `The remote repository has changes you don't have:\n\n` +
                `• ${remoteStatus.filesChanged} file(s) changed\n` +
                `• ${remoteStatus.filesAdded} file(s) added\n` +
                `• ${remoteStatus.filesDeleted} file(s) deleted\n\n` +
                `It's recommended to pull first to avoid conflicts.\n\n` +
                `Commit anyway?`,
              confirmLabel: 'Commit Anyway',
              cancelLabel: 'Pull First',
              confirmVariant: 'danger'
            });
            
            if (!confirmed) return;
          }
        }
      }
      
      // Open commit modal
      setIsCommitModalOpen(true);
    } catch (error) {
      console.error('Failed to check remote status:', error);
      toast.error(`Failed to check remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleCommitFiles = async (files: any[], message: string, branch: string) => {
    try {
      const credsResult = await credentialsManager.loadCredentials();
      
      if (!credsResult.success || !credsResult.credentials) {
        throw new Error('No credentials available. Please configure credentials first.');
      }

      const gitCreds = credsResult.credentials.git.find(cred => cred.name === state.selectedRepo);
      
      if (!gitCreds) {
        throw new Error(`No credentials found for repository ${state.selectedRepo}`);
      }

      // Set credentials on gitService
      const credentialsWithRepo = {
        ...credsResult.credentials,
        defaultGitRepo: state.selectedRepo
      };
      gitService.setCredentials(credentialsWithRepo);

      // Prepare files with proper paths
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
        // Mark files as saved
        for (const file of files) {
          await fileRegistry.markSaved(file.fileId);
        }
        toast.success(`Committed ${files.length} file(s)`);
      } else {
        throw new Error(result.error || 'Failed to commit files');
      }
    } catch (error) {
      throw error; // Re-throw to be handled by CommitModal
    }
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
        <Menubar.Trigger className="menubar-trigger">
          Repository
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

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleForceClone}
            >
              Force Full Reload
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handlePullLatest}
            >
              Pull Latest
              <div className="menubar-right-slot">⌘P</div>
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleCommitChanges}
              disabled={!hasDirtyFiles}
            >
              Commit Changes...
              {hasDirtyFiles && <div className="menubar-right-slot">{dirtyFiles.length}</div>}
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
      <MergeConflictModal
        isOpen={isMergeConflictModalOpen}
        onClose={() => setIsMergeConflictModalOpen(false)}
        conflicts={mergeConflicts}
        onResolve={handleResolveConflicts}
      />
      <CommitModal
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
        onCommit={handleCommitFiles}
        preselectedFiles={[]}
      />
    </>
  );
}
