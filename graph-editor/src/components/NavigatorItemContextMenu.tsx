import React, { useMemo, useState } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { RepositoryItem, ObjectType } from '../types';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { CommitModal } from './CommitModal';
import { DeleteModal } from './DeleteModal';
import { NewFileModal } from './NewFileModal';
import { gitService } from '../services/gitService';
import { fileRegistry } from '../contexts/TabContext';

interface NavigatorItemContextMenuProps {
  item: RepositoryItem;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Context menu for Navigator item right-click
 */
export function NavigatorItemContextMenu({ item, x, y, onClose }: NavigatorItemContextMenuProps) {
  const { tabs, operations } = useTabContext();
  const { state: navState, operations: navOps } = useNavigatorContext();
  
  // Check if this item has any open tabs
  const fileId = `${item.type}-${item.id}`;
  const openTabs = tabs.filter(t => t.fileId === fileId);

  // Commit modal state
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const [commitModalPreselectedFiles, setCommitModalPreselectedFiles] = useState<string[]>([]);
  
  // Delete modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  
  // New file modal state
  const [isNewFileModalOpen, setIsNewFileModalOpen] = useState(false);
  const [newFileType, setNewFileType] = useState<ObjectType | undefined>(undefined);
  
  // Duplicate modal state
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);

  const handleCommitFiles = async (files: any[], message: string, branch: string) => {
    try {
      // Load credentials to get repo info
      const { credentialsManager } = await import('../lib/credentials');
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
  
  const handleDeleteFile = async (message: string) => {
    try {
      // Load credentials
      const { credentialsManager } = await import('../lib/credentials');
      const credentialsResult = await credentialsManager.loadCredentials();
      
      if (!credentialsResult.success || !credentialsResult.credentials) {
        throw new Error('No credentials available. Please configure credentials first.');
      }

      // Get credentials for selected repo
      const selectedRepo = navState.selectedRepo;
      const selectedBranch = navState.selectedBranch || 'main';
      const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === selectedRepo);
      
      if (!gitCreds) {
        throw new Error(`No credentials found for repository ${selectedRepo}`);
      }

      // Set credentials on gitService
      const credentialsWithRepo = {
        ...credentialsResult.credentials,
        defaultGitRepo: selectedRepo
      };
      gitService.setCredentials(credentialsWithRepo);

      // Use item.path directly - it already includes the full path from repo root
      console.log(`Deleting file from repository: ${item.path}`);
      const result = await gitService.deleteFile(item.path, message, selectedBranch);
      
      if (result.success) {
        console.log('Delete successful:', result.message);
        
        // Close any open tabs for this file
        for (const tab of openTabs) {
          await operations.closeTab(tab.id, true); // Force close
        }
        
        // Refresh navigator to remove deleted item
        await navOps.refreshItems();
      } else {
        throw new Error(result.error || 'Failed to delete file');
      }
    } catch (error) {
      throw error; // Re-throw to be handled by DeleteModal
    }
  };
  
  const menuItems: ContextMenuItem[] = useMemo(() => {
    const items: ContextMenuItem[] = [];
    
    // Open actions - ALWAYS open new tabs (force=true)
    items.push({
      label: 'Open in Editor',
      onClick: () => {
        operations.openTab(item, 'interactive', true);
      }
    });
    items.push({
      label: 'Open as JSON',
      onClick: () => {
        operations.openTab(item, 'raw-json', true);
      }
    });
    items.push({
      label: 'Open as YAML',
      onClick: () => {
        operations.openTab(item, 'raw-yaml', true);
      }
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Close actions (only if there are open tabs)
    if (openTabs.length > 0) {
      items.push({
        label: `Close All Views (${openTabs.length})`,
        onClick: async () => {
          console.log('Close All Views: Closing', openTabs.length, 'tabs for', fileId);
          // Close each tab with force=false to allow dirty checks
          for (const tab of openTabs) {
            console.log('Closing tab:', tab.id);
            await operations.closeTab(tab.id, false);
          }
        }
      });
      items.push({ label: '', onClick: () => {}, divider: true });
    }
    
    // File operations
    items.push({
      label: 'Duplicate...',
      onClick: () => {
        setIsDuplicateModalOpen(true);
      },
      keepMenuOpen: true
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Git actions
    items.push({
      label: 'Commit This File...',
      onClick: () => {
        // Open commit modal for this specific file
        setCommitModalPreselectedFiles([fileId]);
        setIsCommitModalOpen(true);
      },
      keepMenuOpen: true // Keep menu open so modal can render
    });
    items.push({
      label: 'Commit All Changes...',
      onClick: () => {
        // Open commit modal for all dirty files
        setCommitModalPreselectedFiles([]);
        setIsCommitModalOpen(true);
      },
      keepMenuOpen: true // Keep menu open so modal can render
    });
    items.push({
      label: 'View History',
      onClick: () => {
        // TODO: Open history view for this file
        console.log('View history for:', item.name);
      }
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Danger actions
    items.push({
      label: 'Delete from Repository...',
      onClick: () => {
        setIsDeleteModalOpen(true);
      },
      keepMenuOpen: true
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Info
    items.push({
      label: 'Copy Name',
      onClick: () => navigator.clipboard.writeText(item.name)
    });
    items.push({
      label: 'Copy Path',
      onClick: () => navigator.clipboard.writeText(item.path)
    });
    
    return items;
  }, [item, openTabs, operations]);

  const handleCreateFile = async (name: string, type: ObjectType) => {
    // Create a new file with default content based on type
    const newFileId = `${type}-${name}`;
    
    let defaultData: any;
    if (type === 'graph') {
      defaultData = {
        nodes: [],
        edges: [],
        policies: {
          default_outcome: 'abandon',
          overflow_policy: 'error',
          free_edge_policy: 'complement'
        },
        metadata: {
          version: '1.0.0',
          created_at: new Date().toISOString(),
          author: 'Graph Editor',
          description: '',
          name: `${name}.json`
        }
      };
    } else {
      // YAML files (parameter, context, case)
      defaultData = {
        id: name,
        name: name,
        description: '',
        created_at: new Date().toISOString()
      };
    }
    
    // Create file in registry
    await fileRegistry.getOrCreateFile(
      newFileId,
      type,
      { repository: 'local', path: `${type}s/${name}`, branch: navState.selectedBranch || 'main' },
      defaultData
    );
    
    // Add to navigator as local/uncommitted item
    const newItem = {
      id: name,
      type: type,
      name: name,
      path: `${type}s/${name}.${type === 'graph' ? 'json' : 'yaml'}`,
      description: '',
      isLocal: true
    };
    
    navOps.addLocalItem(newItem);
    
    // Open the new file in a tab
    await operations.openTab(newItem, 'interactive');
    
    // Close modals
    setIsNewFileModalOpen(false);
    onClose();
  };
  
  const handleDuplicate = async (name: string, type: ObjectType) => {
    // First, ensure the file is loaded by opening it (which loads it into fileRegistry)
    // This is necessary because the file may not be in the registry yet
    let currentFile = fileRegistry.getFile(fileId);
    
    if (!currentFile) {
      // File not loaded yet - open it first to load it into the registry
      console.log(`NavigatorItemContextMenu: File ${fileId} not in registry, opening to load it first`);
      await operations.openTab(item, 'interactive');
      
      // Now try to get it again
      currentFile = fileRegistry.getFile(fileId);
      if (!currentFile) {
        throw new Error('Failed to load file for duplication');
      }
    }
    
    // Clone the data and update the id/name to the new value
    const duplicatedData = { ...currentFile.data };
    
    // Update ID and name fields with the new name
    if (type === 'graph') {
      // For graphs, update metadata name
      if (duplicatedData.metadata) {
        duplicatedData.metadata.name = `${name}.json`;
      }
    } else {
      // For YAML files (parameter, context, case), update id and name
      duplicatedData.id = name;
      duplicatedData.name = name;
    }
    
    // Create new file with duplicated data (will be marked dirty on save)
    const newFileId = `${type}-${name}`;
    await fileRegistry.getOrCreateFile(
      newFileId,
      type,
      { repository: 'local', path: `${type}s/${name}`, branch: currentFile.source?.branch || 'main' },
      duplicatedData
    );
    
    // Add to navigator as local/uncommitted item
    const newItem = {
      id: name,
      type: type,
      name: name,
      path: `${type}s/${name}.${type === 'graph' ? 'json' : 'yaml'}`,
      description: currentFile.data.description || '',
      isLocal: true
    };
    
    navOps.addLocalItem(newItem);
    
    // Open the duplicated file in a new tab
    await operations.openTab(newItem, 'interactive');
    
    // Close modals
    setIsDuplicateModalOpen(false);
    onClose();
  };

  const originalName = item.id.replace(/\.(json|yaml)$/, '');

  return (
    <>
      <ContextMenu x={x} y={y} items={menuItems} onClose={onClose} />
      
      {/* Commit Modal */}
      <CommitModal
        isOpen={isCommitModalOpen}
        onClose={() => {
          setIsCommitModalOpen(false);
          onClose(); // Close context menu when modal closes
        }}
        onCommit={handleCommitFiles}
        preselectedFiles={commitModalPreselectedFiles}
      />
      
      {/* Delete Modal */}
      <DeleteModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          onClose(); // Close context menu when modal closes
        }}
        onDelete={handleDeleteFile}
        fileName={item.name}
        fileType={item.type}
      />
      
      {/* New File Modal */}
      <NewFileModal
        isOpen={isNewFileModalOpen}
        onClose={() => {
          setIsNewFileModalOpen(false);
          onClose();
        }}
        onCreate={handleCreateFile}
        fileType={newFileType}
      />
      
      {/* Duplicate Modal */}
      <NewFileModal
        isOpen={isDuplicateModalOpen}
        onClose={() => {
          setIsDuplicateModalOpen(false);
          onClose();
        }}
        onCreate={handleDuplicate}
        fileType={item.type as ObjectType}
        defaultName={`${originalName}-copy`}
      />
    </>
  );
}

