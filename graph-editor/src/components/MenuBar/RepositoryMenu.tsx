import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';

/**
 * Repository Menu
 * 
 * Repository operations:
 * - Switch Branch
 * - Create Branch
 * - Pull Latest
 * - Repository Settings
 */
export function RepositoryMenu() {
  const { operations, activeTabId } = useTabContext();
  const { state } = useNavigatorContext();
  
  const dirtyTabs = operations.getDirtyTabs();
  const hasDirtyTabs = dirtyTabs.length > 0;
  const hasActiveTab = !!activeTabId;

  const handleSwitchBranch = () => {
    // TODO: Open branch switching dialog
    console.log('Switch branch');
  };

  const handleCreateBranch = () => {
    // TODO: Open create branch dialog
    console.log('Create new branch');
  };

  const handlePullLatest = () => {
    // TODO: Pull latest changes from remote
    console.log('Pull latest from', state.selectedBranch);
  };

  const handleRepositorySettings = () => {
    // TODO: Open repository settings
    console.log('Repository settings');
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">
        Repository
      </Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleSwitchBranch}
          >
            Switch Branch
            <div className="menubar-right-slot">⌘B</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCreateBranch}
          >
            Create Branch...
            <div className="menubar-right-slot">⌘⇧B</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handlePullLatest}
          >
            Pull Latest
            <div className="menubar-right-slot">⌘P</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleRepositorySettings}
          >
            Repository Settings...
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}
