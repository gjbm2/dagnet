import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { SwitchRepositoryModal } from '../modals/SwitchRepositoryModal';
import { SwitchBranchModal } from '../modals/SwitchBranchModal';

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
    if (!confirm(`Force re-clone ${state.selectedRepo}/${state.selectedBranch}? This will discard any local changes.`)) {
      return;
    }
    console.log('Force cloning repository...');
    const { workspaceService } = await import('../../services/workspaceService');
    await workspaceService.deleteWorkspace(state.selectedRepo, state.selectedBranch);
    await navOps.refreshItems(); // This will trigger loadItems which will re-clone
  };

  const handlePullLatest = async () => {
    console.log('Pulling latest from', state.selectedBranch);
    const { workspaceService } = await import('../../services/workspaceService');
    await workspaceService.deleteWorkspace(state.selectedRepo, state.selectedBranch);
    await navOps.refreshItems(); // This will trigger loadItems which will re-clone
  };

  const handlePushChanges = () => {
    // TODO: Implement push all dirty files
    console.log('Push changes to', state.selectedBranch);
  };

  const handleRefreshStatus = async () => {
    console.log('Refreshing repository status');
    await navOps.refreshItems();
  };

  const handleShowDirtyFiles = () => {
    // TODO: Open modal showing all dirty files
    console.log('Show dirty files:', dirtyTabs);
  };

  const handleDiscardLocalChanges = () => {
    // TODO: Open confirmation modal to discard all local changes
    console.log('Discard local changes');
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
              Force Clone Repository
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
