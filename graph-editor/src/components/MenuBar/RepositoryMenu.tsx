import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { SwitchRepositoryModal } from '../modals/SwitchRepositoryModal';
import { SwitchBranchModal } from '../modals/SwitchBranchModal';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';

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
  
  const [isSwitchRepoModalOpen, setIsSwitchRepoModalOpen] = useState(false);
  const [isSwitchBranchModalOpen, setIsSwitchBranchModalOpen] = useState(false);

  const dirtyTabs = operations.getDirtyTabs();
  const hasDirtyTabs = dirtyTabs.length > 0;
  const hasActiveTab = !!activeTabId;

  const handleSwitchRepository = () => {
    setIsSwitchRepoModalOpen(true);
  };

  const handleSwitchBranch = () => {
    setIsSwitchBranchModalOpen(true);
  };

  const handleForceClone = async () => {
    if (!confirm(`Force Full Reload: Delete local workspace and re-clone ${state.selectedRepo}/${state.selectedBranch} from Git?\n\nThis will discard any uncommitted changes.`)) {
      return;
    }
    try {
      await navOps.forceFullReload();
      console.log(`✅ Force reload complete`);
      alert('Workspace reloaded successfully!');
    } catch (error) {
      console.error('Failed to force reload:', error);
      alert('Failed to reload workspace: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handlePullLatest = async () => {
    try {
      await repositoryOperationsService.pullLatest(state.selectedRepo, state.selectedBranch);
      console.log(`✅ Pull complete`);
    } catch (error) {
      console.error('Failed to pull latest:', error);
    }
  };

  const handlePushChanges = async () => {
    try {
      const message = prompt('Commit message:') || 'Update files';
      const count = await repositoryOperationsService.pushChanges(
        state.selectedRepo,
        state.selectedBranch,
        message
      );
      console.log(`✅ Pushed ${count} files`);
    } catch (error) {
      console.error('Failed to push changes:', error);
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
              onSelect={handlePushChanges}
              disabled={!hasDirtyTabs}
            >
              Push Changes
              {hasDirtyTabs && <div className="menubar-right-slot">{dirtyTabs.length}</div>}
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
              disabled={!hasDirtyTabs}
            >
              Show Dirty Files
              {hasDirtyTabs && <div className="menubar-right-slot">{dirtyTabs.length}</div>}
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleDiscardLocalChanges}
              disabled={!hasDirtyTabs}
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
    </>
  );
}
