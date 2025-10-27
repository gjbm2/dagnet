import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';

/**
 * Git Menu
 * 
 * Git operations:
 * - Commit (single file)
 * - Commit All (multi-file)
 * - Pull
 * - Push
 * - Branch operations
 * - View history
 */
export function GitMenu() {
  const { operations, activeTabId } = useTabContext();
  const { state } = useNavigatorContext();
  
  const dirtyTabs = operations.getDirtyTabs();
  const hasDirtyTabs = dirtyTabs.length > 0;
  const hasActiveTab = !!activeTabId;

  const handleCommit = () => {
    // TODO: Open commit dialog for single file
    console.log('Commit current file');
  };

  const handleCommitAll = () => {
    // TODO: Open commit dialog with all dirty files
    console.log('Commit all dirty files:', dirtyTabs);
  };

  const handlePull = () => {
    // TODO: Pull from remote
    console.log('Pull from', state.selectedBranch);
  };

  const handlePush = () => {
    // TODO: Push to remote
    console.log('Push to', state.selectedBranch);
  };

  const handleNewBranch = () => {
    // TODO: Create new branch dialog
    console.log('Create new branch');
  };

  const handleSwitchBranch = () => {
    // TODO: Switch branch dialog
    console.log('Switch branch');
  };

  const handleMergeBranch = () => {
    // TODO: Merge branch dialog
    console.log('Merge branch');
  };

  const handleViewHistory = () => {
    // TODO: Open history view
    console.log('View git history');
  };

  const handleViewDiff = () => {
    // TODO: Show diff for current file
    console.log('View diff');
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">Git</Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCommit}
            disabled={!hasActiveTab}
          >
            Commit
            <div className="menubar-right-slot">⌘K</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCommitAll}
            disabled={!hasDirtyTabs}
          >
            Commit All...
            <div className="menubar-right-slot">⌘⇧K</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handlePull}
          >
            Pull
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handlePush}
          >
            Push
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Sub>
            <Menubar.SubTrigger className="menubar-item">
              Branch
              <div className="menubar-right-slot">›</div>
            </Menubar.SubTrigger>
            <Menubar.Portal>
              <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={handleNewBranch}
                >
                  New Branch...
                </Menubar.Item>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={handleSwitchBranch}
                >
                  Switch Branch...
                </Menubar.Item>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={handleMergeBranch}
                >
                  Merge Branch...
                </Menubar.Item>
              </Menubar.SubContent>
            </Menubar.Portal>
          </Menubar.Sub>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleViewHistory}
          >
            View History
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleViewDiff}
            disabled={!hasActiveTab}
          >
            View Diff
            <div className="menubar-right-slot">⌘D</div>
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

