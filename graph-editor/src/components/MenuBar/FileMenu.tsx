import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { db } from '../../db/appDatabase';

/**
 * File Menu
 * 
 * Operations:
 * - New (graph, parameter, context, case)
 * - Open (opens navigator)
 * - Save
 * - Save All
 * - Revert
 * - Close Tab
 * - Settings
 */
export function FileMenu() {
  const { activeTabId, tabs, operations } = useTabContext();
  const { operations: navOps } = useNavigatorContext();

  const activeTab = tabs.find(t => t.id === activeTabId);
  const hasDirtyTabs = operations.getDirtyTabs().length > 0;

  const handleNew = (type: string) => {
    // TODO: Implement new file creation
    console.log('New', type);
  };

  const handleOpen = () => {
    navOps.toggleNavigator();
  };

  const handleSave = async () => {
    if (activeTabId) {
      await operations.saveTab(activeTabId);
    }
  };

  const handleSaveAll = async () => {
    await operations.saveAll();
  };

  const handleRevert = () => {
    if (activeTabId) {
      operations.revertTab(activeTabId);
    }
  };

  const handleCloseTab = async () => {
    if (activeTabId) {
      await operations.closeTab(activeTabId);
    }
  };

  const handleSettings = () => {
    // TODO: Open settings tab
    console.log('Settings');
  };

  const handleClearAllData = async () => {
    const confirmed = window.confirm(
      'Clear ALL application data?\n\n' +
      'This will:\n' +
      '- Close all tabs\n' +
      '- Clear all cached files\n' +
      '- Reset layout and settings\n\n' +
      'This action cannot be undone!'
    );
    
    if (!confirmed) return;

    try {
      console.log('Clearing all application data...');
      
      // Use the built-in clearAll method
      await db.clearAll();
      
      console.log('All application data cleared');
      
      // Reload the page to reset everything
      window.location.reload();
    } catch (error) {
      console.error('Failed to clear data:', error);
      alert('Failed to clear data: ' + error);
    }
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">File</Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          <Menubar.Sub>
            <Menubar.SubTrigger className="menubar-item">
              New
              <div className="menubar-right-slot">›</div>
            </Menubar.SubTrigger>
            <Menubar.Portal>
              <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={() => handleNew('graph')}
                >
                  Graph
                </Menubar.Item>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={() => handleNew('parameter')}
                >
                  Parameter
                </Menubar.Item>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={() => handleNew('context')}
                >
                  Context
                </Menubar.Item>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={() => handleNew('case')}
                >
                  Case
                </Menubar.Item>
              </Menubar.SubContent>
            </Menubar.Portal>
          </Menubar.Sub>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleOpen}
          >
            Open...
            <div className="menubar-right-slot">⌘O</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleSave}
            disabled={!activeTab}
          >
            Save
            <div className="menubar-right-slot">⌘S</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleSaveAll}
            disabled={!hasDirtyTabs}
          >
            Save All
            <div className="menubar-right-slot">⌘⇧S</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleRevert}
            disabled={!activeTab}
          >
            Revert
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCloseTab}
            disabled={!activeTab}
          >
            Close Tab
            <div className="menubar-right-slot">⌘W</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleSettings}
          >
            Settings...
            <div className="menubar-right-slot">⌘,</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleClearAllData}
          >
            Clear All Data...
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

