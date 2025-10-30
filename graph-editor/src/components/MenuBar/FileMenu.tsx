import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useDialog } from '../../contexts/DialogContext';
import { db } from '../../db/appDatabase';
import { encodeStateToUrl } from '../../lib/shareUrl';
import { CommitModal } from '../CommitModal';
import { NewFileModal } from '../NewFileModal';
import { gitService } from '../../services/gitService';
import { ObjectType } from '../../types';
import { fileOperationsService } from '../../services/fileOperationsService';

/**
 * File Menu
 * 
 * Operations:
 * - New (graph, parameter, context, case)
 * - Open (opens navigator)
 * - Import from File
 * - Revert
 * - Export (Download, Share URL)
 * - Close Tab
 * - Settings
 */
export function FileMenu() {
  const { activeTabId, tabs, operations } = useTabContext();
  const { operations: navOps, state: navState } = useNavigatorContext();
  const { showConfirm } = useDialog();

  const activeTab = tabs.find(t => t.id === activeTabId);
  const isGraphTab = activeTab?.fileId.startsWith('graph-');
  
  // Get isDirty state for active tab
  const activeFile = activeTab ? fileRegistry.getFile(activeTab.fileId) : null;
  const isDirty = activeFile?.isDirty ?? false;

  // Commit modal state
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const [commitModalPreselectedFiles, setCommitModalPreselectedFiles] = useState<string[]>([]);
  
  // New file modal state
  const [isNewFileModalOpen, setIsNewFileModalOpen] = useState(false);
  const [newFileType, setNewFileType] = useState<ObjectType | undefined>(undefined);
  
  // Track dirty tabs - update when tabs or files change
  const [hasDirtyTabs, setHasDirtyTabs] = useState(false);
  
  // Listen for file dirty state changes
  React.useEffect(() => {
    const updateDirtyState = () => {
      setHasDirtyTabs(operations.getDirtyTabs().length > 0);
    };
    
    // Update immediately
    updateDirtyState();
    
    // Listen for dirty state changes
    const handleDirtyChange = () => {
      updateDirtyState();
    };
    
    window.addEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
    return () => window.removeEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
  }, [tabs, operations]);

  const handleNew = (type: ObjectType) => {
    setNewFileType(type);
    setIsNewFileModalOpen(true);
  };
  
  const handleCreateFile = async (name: string, type: ObjectType) => {
    // Use centralized file operations service
    const metadata = type === 'graph' ? {
      policies: {
        default_outcome: 'abandon',
        overflow_policy: 'error',
        free_edge_policy: 'complement'
      },
      version: '1.0.0',
      author: 'Graph Editor'
    } : {};
    
    await fileOperationsService.createFile(name, type, {
      openInTab: true,
      viewMode: 'interactive',
      metadata
    });
  };

  const handleOpen = () => {
    navOps.toggleNavigator();
  };

  const handleDiscardChanges = async () => {
    if (!activeTab) return;
    await fileOperationsService.revertFile(activeTab.fileId);
  };


  const handleCommitChanges = () => {
    // Open commit modal for dirty files
    setCommitModalPreselectedFiles([]); // Empty means select all dirty files
    setIsCommitModalOpen(true);
  };

  const handleCommitAllChanges = () => {
    // Open commit modal with all dirty files
    setCommitModalPreselectedFiles([]); // Empty means select all dirty files
    setIsCommitModalOpen(true);
  };

  const handlePullLatest = async () => {
    try {
      const result = await gitService.pullLatest();
      if (result.success) {
        console.log('Pull successful:', result.message);
        // TODO: Refresh navigator content - for now just log success
      } else {
        alert(`Pull failed: ${result.error}`);
      }
    } catch (error) {
      alert(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleViewHistory = () => {
    // TODO: Open history view for current file
    console.log('View history');
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
      const selectedRepo = navState.selectedRepo;
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

  const handleCredentials = async () => {
    // Open existing credentials file
    const credentialsItem = {
      id: 'credentials',
      type: 'credentials' as const,
      name: 'Credentials',
      path: 'credentials.yaml'
    };
    
    await operations.openTab(credentialsItem, 'interactive');
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
      const file = await fileRegistry.getFile(activeTab.fileId);
      if (!file || !file.data) {
        alert('No data to share');
        return;
      }

      // Encode only the graph data (not the FileState wrapper)
      const url = encodeStateToUrl(file.data);
      await navigator.clipboard.writeText(url);
      alert('Shareable URL copied to clipboard!');
    } catch (error) {
      console.error('Failed to create shareable URL:', error);
      alert('Failed to create shareable URL: ' + error);
    }
  };

  const handleClearData = async () => {
    const confirmed = await showConfirm({
      title: 'Clear Application Data',
      message: 
        'Clear ALL application data?\n\n' +
        'This will:\n' +
        '• Close all tabs\n' +
        '• Clear all cached files\n' +
        '• Reset layout\n' +
        '• Keep settings intact\n\n' +
        'This action cannot be undone!',
      confirmLabel: 'Clear Data',
      cancelLabel: 'Cancel',
      confirmVariant: 'danger'
    });
    
    if (!confirmed) return;

    try {
      console.log('Clearing all application data (keeping settings)...');
      
      // Clear all data except settings
      await db.clearAll();
      
      console.log('All application data cleared (settings preserved)');
      
      // Reload the page to reset everything
      window.location.reload();
    } catch (error) {
      console.error('Failed to clear data:', error);
      await showConfirm({
        title: 'Error',
        message: `Failed to clear data: ${error}`,
        confirmLabel: 'OK',
        cancelLabel: '',
        confirmVariant: 'primary'
      });
    }
  };

  const handleClearAllData = async () => {
    const confirmed = await showConfirm({
      title: 'Clear ALL Data and Settings',
      message: 
        'Clear ALL application data and settings?\n\n' +
        'This will:\n' +
        '• Close all tabs\n' +
        '• Clear all cached files\n' +
        '• Reset layout and settings\n' +
        '• Clear all user preferences\n' +
        '• Remove all credentials\n\n' +
        'This action cannot be undone!',
      confirmLabel: 'Clear Everything',
      cancelLabel: 'Cancel',
      confirmVariant: 'danger'
    });
    
    if (!confirmed) return;

    try {
      console.log('Clearing all application data and settings...');
      
      // Clear all data including settings and credentials
      await db.clearAllIncludingSettings();
      
      // Set a flag to prevent re-initialization
      sessionStorage.setItem('dagnet_cleared_all', 'true');
      
      console.log('All application data and settings cleared');
      
      // Reload the page to reset everything
      window.location.reload();
    } catch (error) {
      console.error('Failed to clear data:', error);
      await showConfirm({
        title: 'Error',
        message: `Failed to clear data: ${error}`,
        confirmLabel: 'OK',
        cancelLabel: '',
        confirmVariant: 'primary'
      });
    }
  };

  return (
    <>
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
              onSelect={handleDiscardChanges}
              disabled={!activeTab || !isDirty}
            >
              Discard Changes
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={async () => {
                if (activeTab) {
                  await fileOperationsService.deleteFile(activeTab.fileId);
                }
              }}
              disabled={!activeTab}
            >
              Delete
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

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
              disabled={!hasDirtyTabs}
            >
              Commit Changes...
              <div className="menubar-right-slot">⌘K</div>
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleCommitAllChanges}
              disabled={!hasDirtyTabs}
            >
              Commit All Changes...
              <div className="menubar-right-slot">⌘⇧K</div>
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleViewHistory}
              disabled={!activeTab}
            >
              View History
              <div className="menubar-right-slot">⌘H</div>
            </Menubar.Item>

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
              onSelect={handleCredentials}
            >
              Credentials...
              <div className="menubar-right-slot">⌘,</div>
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleClearData}
            >
              Clear Data...
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleClearAllData}
            >
              Clear Data and Settings...
            </Menubar.Item>
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>

      {/* Commit Modal */}
      <CommitModal
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
        onCommit={handleCommitFiles}
        preselectedFiles={commitModalPreselectedFiles}
      />
      
      {/* New File Modal */}
      <NewFileModal
        isOpen={isNewFileModalOpen}
        onClose={() => setIsNewFileModalOpen(false)}
        onCreate={handleCreateFile}
        fileType={newFileType}
      />
    </>
  );
}

