import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useDialog } from '../../contexts/DialogContext';
import { db } from '../../db/appDatabase';
import { encodeStateToUrl } from '../../lib/shareUrl';
import { CommitModal } from '../CommitModal';
import { NewFileModal } from '../NewFileModal';
import { MergeConflictModal, ConflictFile } from '../modals/MergeConflictModal';
import { gitService } from '../../services/gitService';
import { gitConfig } from '../../config/gitConfig';
import { ObjectType } from '../../types';
import { fileOperationsService } from '../../services/fileOperationsService';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import { workspaceService } from '../../services/workspaceService';
import { IndexRebuildService } from '../../services/indexRebuildService';
import toast from 'react-hot-toast';

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
 * - Rebuild Indexes
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
  
  // Merge conflict modal state
  const [isMergeConflictModalOpen, setIsMergeConflictModalOpen] = useState(false);
  const [mergeConflicts, setMergeConflicts] = useState<ConflictFile[]>([]);
  
  // Track dirty files - update when tabs or files change
  // NOTE: Use content-based detection for reliable cross-session dirty tracking
  const [hasDirtyFiles, setHasDirtyFiles] = useState(false);
  const [hasCurrentFileDirty, setHasCurrentFileDirty] = useState(false);
  
  // Listen for file dirty state changes
  React.useEffect(() => {
    const updateDirtyState = async () => {
      // Use content-based detection for reliable dirty file tracking
      // This compares actual data to originalData, works across page refreshes
      const committableFiles = await repositoryOperationsService.getCommittableFiles(
        navState.selectedRepo,
        navState.selectedBranch
      );
      setHasDirtyFiles(committableFiles.length > 0);
      
      // Check if current file is committable (centralized logic)
      if (activeTab) {
        setHasCurrentFileDirty(fileRegistry.isFileCommittableById(activeTab.fileId));
      } else {
        setHasCurrentFileDirty(false);
      }
    };
    
    // Update immediately
    updateDirtyState();
    
    // Listen for dirty state changes
    const handleDirtyChange = () => {
      updateDirtyState();
    };
    
    window.addEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
    return () => window.removeEventListener('dagnet:fileDirtyChanged', handleDirtyChange);
  }, [tabs, operations, activeTab, navState.selectedRepo, navState.selectedBranch]);

  const handleNew = (type: ObjectType) => {
    setNewFileType(type);
    setIsNewFileModalOpen(true);
  };
  
  const handleCreateFile = async (name: string, type: ObjectType, extraMetadata?: any) => {
    // Use centralized file operations service
    let metadata = type === 'graph' ? {
      policies: {
        default_outcome: 'abandon',
        overflow_policy: 'error',
        free_edge_policy: 'complement'
      },
      version: '1.0.0',
      author: 'Graph Editor'
    } : {};
    
    // Merge in any extra metadata (e.g., parameterType from registry)
    if (extraMetadata) {
      metadata = { ...metadata, ...extraMetadata };
    }
    
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


  const handleCommitChanges = async () => {
    // Commit ONLY the current active file
    if (!activeTab) return;
    
    // Use centralized logic to check if file is committable
    if (!fileRegistry.isFileCommittableById(activeTab.fileId)) return;
    
    try {
      // Check remote status (centralized in service)
      const shouldProceed = await repositoryOperationsService.checkRemoteBeforeCommit(
        navState.selectedRepo,
        navState.selectedBranch,
        showConfirm,
        toast.loading,
        toast.dismiss
      );
      
      if (!shouldProceed) return;
      
      // Open commit modal with ONLY current file pre-selected
      setCommitModalPreselectedFiles([activeTab.fileId]);
      setIsCommitModalOpen(true);
    } catch (error) {
      console.error('Failed to check remote status:', error);
      toast.error(`Failed to check remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleCommitAllChanges = async () => {
    // Commit ALL dirty files
    try {
      // Check remote status (centralized in service)
      const shouldProceed = await repositoryOperationsService.checkRemoteBeforeCommit(
        navState.selectedRepo,
        navState.selectedBranch,
        showConfirm,
        toast.loading,
        toast.dismiss
      );
      
      if (!shouldProceed) return;
      
      // Open commit modal for ALL dirty files
      setCommitModalPreselectedFiles([]); // Empty means select all dirty files
      setIsCommitModalOpen(true);
    } catch (error) {
      console.error('Failed to check remote status:', error);
      toast.error(`Failed to check remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handlePullLatest = async () => {
    try {
      const selectedRepo = navState.selectedRepo;
      const selectedBranch = navState.selectedBranch || gitConfig.branch;
      
      if (!selectedRepo) {
        throw new Error('No repository selected. Please select a repository in the navigator.');
      }

      // Show loading toast
      const toastId = toast.loading('Pulling latest changes...');

      // Use repositoryOperationsService which does incremental pull with merge
      const result = await repositoryOperationsService.pullLatest(selectedRepo, selectedBranch);

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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Pull failed:', errorMessage);
      toast.error(`Pull failed: ${errorMessage}`);
    }
  };

  const handleResolveConflicts = async (resolutions: Map<string, 'local' | 'remote' | 'manual'>) => {
    const { conflictResolutionService } = await import('../../services/conflictResolutionService');
    
    const resolvedCount = await conflictResolutionService.applyResolutions(mergeConflicts as any, resolutions);
    
    // Refresh navigator to show updated state
    await navOps.refreshItems();
    
    if (resolvedCount > 0) {
      toast.success(`Resolved ${resolvedCount} conflict${resolvedCount !== 1 ? 's' : ''}`);
    }
  };

  const handleViewHistory = () => {
    // TODO: Open history view for current file
    console.log('View history');
  };

  const handleCommitFiles = async (files: any[], message: string, branch: string) => {
    try {
      await repositoryOperationsService.commitFiles(files, message, branch, navState.selectedRepo, showConfirm);
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

  const handleConnections = async () => {
    // Open connections configuration file
    const connectionsItem = {
      id: 'connections',
      type: 'connections' as const,
      name: 'Connections',
      path: 'connections/connections.yaml'
    };
    
    await operations.openTab(connectionsItem, 'interactive');
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
        '• Delete workspace (will re-clone from repository on reload)\n' +
        '• Reset layout\n' +
        '• Reset connections to defaults\n' +
        '• Keep settings and credentials intact\n\n' +
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
        '• Reset connections to defaults\n' +
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

  const handleRebuildIndexes = async () => {
    const confirmed = await showConfirm({
      title: 'Rebuild All Indexes',
      message: 
        'Rebuild all registry indexes?\n\n' +
        'This will:\n' +
        '• Scan all files in IndexedDB\n' +
        '• Ensure each file has a corresponding index entry\n' +
        '• Add missing entries to index files\n' +
        '• Generate a detailed log report\n\n' +
        'Index files will be marked as dirty and need to be committed.',
      confirmLabel: 'Rebuild Indexes',
      cancelLabel: 'Cancel',
      confirmVariant: 'primary'
    });
    
    if (!confirmed) return;

    try {
      console.log('Rebuilding all indexes...');
      
      const toastId = toast.loading('Rebuilding indexes...');
      
      const result = await IndexRebuildService.rebuildAllIndexes(operations, true);
      
      toast.dismiss(toastId);
      
      if (result.success) {
        const added = result.results.filter(r => r.action === 'added').length;
        const updated = result.results.filter(r => r.action === 'updated').length;
        const errors = result.results.filter(r => r.action === 'error').length;
        
        const parts: string[] = [];
        if (added > 0) parts.push(`${added} added`);
        if (updated > 0) parts.push(`${updated} updated`);
        if (errors > 0) parts.push(`${errors} failed`);
        
        const message = parts.length > 0 
          ? `Index rebuild complete: ${parts.join(', ')}`
          : 'All indexes up to date';
        
        toast.success(message, { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to rebuild indexes:', error);
      toast.error('Failed to rebuild indexes: ' + (error instanceof Error ? error.message : 'Unknown error'));
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
              disabled={!hasCurrentFileDirty}
            >
              Commit Changes...
              <div className="menubar-right-slot">⌘K</div>
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleCommitAllChanges}
              disabled={!hasDirtyFiles}
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
              onSelect={handleRebuildIndexes}
            >
              Rebuild Indexes...
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

      {/* Merge Conflict Modal */}
      <MergeConflictModal
        isOpen={isMergeConflictModalOpen}
        onClose={() => setIsMergeConflictModalOpen(false)}
        conflicts={mergeConflicts}
        onResolve={handleResolveConflicts}
      />
    </>
  );
}

