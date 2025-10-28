import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { db } from '../../db/appDatabase';
import { encodeStateToUrl } from '../../lib/shareUrl';

/**
 * File Menu
 * 
 * Operations:
 * - New (graph, parameter, context, case)
 * - Open (opens navigator)
 * - Import from File
 * - Save
 * - Save All
 * - Revert
 * - Export (Download, Share URL)
 * - Close Tab
 * - Settings
 */
export function FileMenu() {
  const { activeTabId, tabs, operations } = useTabContext();
  const { operations: navOps } = useNavigatorContext();

  const activeTab = tabs.find(t => t.id === activeTabId);
  const hasDirtyTabs = operations.getDirtyTabs().length > 0;
  const isGraphTab = activeTab?.fileId.startsWith('graph-');
  
  // Get isDirty state for active tab
  const activeFile = activeTab ? fileRegistry.getFile(activeTab.fileId) : null;
  const isDirty = activeFile?.isDirty ?? false;

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

  const handleImportFromFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.yaml,.yml';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsText(file);
        });
        const data = JSON.parse(text); // TODO: Support YAML parsing

        // Determine file type
        const fileType = data.nodes ? 'graph' : 'parameter'; // Simplified detection
        
        // Create a new tab with the imported data
        const item = {
          id: `imported-${Date.now()}`,
          name: file.name.replace(/\.(json|yaml|yml)$/, ''),
          type: fileType as any,
          path: '',
          size: file.size,
          lastModified: new Date().toISOString()
        };

        await operations.openTab(item, 'interactive');
      } catch (error) {
        console.error('Failed to import file:', error);
        alert('Failed to import file: ' + error);
      }
    };
    input.click();
  };

  const handleDownloadFile = async () => {
    if (!activeTab?.fileId) return;

    try {
      const data = await fileRegistry.getFile(activeTab.fileId);
      if (!data) {
        alert('No data to download');
        return;
      }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${activeTab.fileId}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (error) {
      console.error('Failed to download file:', error);
      alert('Failed to download file: ' + error);
    }
  };

  const handleShareURL = async () => {
    if (!activeTab?.fileId || !isGraphTab) return;

    try {
      const data = await fileRegistry.getFile(activeTab.fileId);
      if (!data) {
        alert('No data to share');
        return;
      }

      const url = encodeStateToUrl(data);
      await navigator.clipboard.writeText(url);
      alert('Shareable URL copied to clipboard!');
    } catch (error) {
      console.error('Failed to create shareable URL:', error);
      alert('Failed to create shareable URL: ' + error);
    }
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

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleImportFromFile}
          >
            Import from File...
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
            disabled={!activeTab || !isDirty}
          >
            Revert
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Sub>
            <Menubar.SubTrigger className="menubar-item" disabled={!activeTab}>
              Export
              <div className="menubar-right-slot">›</div>
            </Menubar.SubTrigger>
            <Menubar.Portal>
              <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={handleDownloadFile}
                  disabled={!activeTab}
                >
                  Download as File...
                </Menubar.Item>
                <Menubar.Item 
                  className="menubar-item" 
                  onSelect={handleShareURL}
                  disabled={!isGraphTab}
                >
                  Copy Shareable URL
                </Menubar.Item>
              </Menubar.SubContent>
            </Menubar.Portal>
          </Menubar.Sub>

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

