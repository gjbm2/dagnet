import React, { useMemo, useState } from 'react';
import YAML from 'yaml';
import { useTabContext } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { RepositoryItem, ObjectType } from '../types';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { CommitModal } from './CommitModal';
import { DeleteModal } from './DeleteModal';
import { NewFileModal } from './NewFileModal';
import { gitService } from '../services/gitService';
import { fileRegistry } from '../contexts/TabContext';
import { fileOperationsService } from '../services/fileOperationsService';

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

      // IMPORTANT: Update file timestamps BEFORE committing to Git
      const nowISO = new Date().toISOString();
      const filesToCommit = files.map(file => {
        // Get the file from registry to update its metadata
        const fileState = fileRegistry.getFile(file.fileId);
        let content = file.content;
        
        // Update timestamp in the file content itself (standardized metadata structure)
        if (fileState?.data) {
          // All file types now use metadata.updated_at
          if (!fileState.data.metadata) {
            fileState.data.metadata = {
              created_at: nowISO,
              version: '1.0.0'
            };
          }
          fileState.data.metadata.updated_at = nowISO;
          
          // Set author from credentials userName if available
          if (gitCreds?.userName && !fileState.data.metadata.author) {
            fileState.data.metadata.author = gitCreds.userName;
          }
          
          // Re-serialize with updated timestamp
          content = fileState.type === 'graph' 
            ? JSON.stringify(fileState.data, null, 2)
            : YAML.stringify(fileState.data);
        }
        
        const basePath = gitCreds.basePath || '';
        const fullPath = basePath ? `${basePath}/${file.path}` : file.path;
        return {
          path: fullPath,
          content,
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
    
    // Discard Changes (if dirty)
    const currentFile = fileRegistry.getFile(fileId);
    if (currentFile?.isDirty) {
      items.push({
        label: 'Discard Changes',
        onClick: async () => {
          await fileOperationsService.revertFile(fileId);
          onClose();
        }
      });
      items.push({ label: '', onClick: () => {}, divider: true });
    }
    
    // Danger actions
    items.push({
      label: 'Delete',
      onClick: async () => {
        try {
          const success = await fileOperationsService.deleteFile(fileId);
          if (success) {
            onClose();
          }
        } catch (error) {
          console.error('Failed to delete file:', error);
          alert(`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
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
    await fileOperationsService.createFile(name, type, {
      openInTab: true,
      viewMode: 'interactive'
    });
    
    setIsNewFileModalOpen(false);
    onClose();
  };
  
  const handleDuplicate = async (name: string, type: ObjectType) => {
    await fileOperationsService.duplicateFile(fileId, name, true);
    
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

