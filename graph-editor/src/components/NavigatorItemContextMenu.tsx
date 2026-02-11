import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import YAML from 'yaml';
import { useTabContext } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useDialog } from '../contexts/DialogContext';
import { useCommitHandler } from '../hooks/useCommitHandler';
import { RepositoryItem, ObjectType } from '../types';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { CommitModal } from './CommitModal';
import { DeleteModal } from './DeleteModal';
import { NewFileModal } from './NewFileModal';
import { RenameModal } from './RenameModal';
import { gitService } from '../services/gitService';
import { fileRegistry } from '../contexts/TabContext';
import { fileOperationsService } from '../services/fileOperationsService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { useShareLink } from '../hooks/useShareLink';
import { usePullFile } from '../hooks/usePullFile';
import { usePullAll } from '../hooks/usePullAll';
import { useRenameFile } from '../hooks/useRenameFile';
import { useViewHistory } from '../hooks/useViewHistory';
import { useOpenHistorical } from '../hooks/useOpenHistorical';
import { useClearDataFile } from '../hooks/useClearDataFile';
import { useSnapshotsMenu } from '../hooks/useSnapshotsMenu';
import { useManageSnapshots } from '../hooks/useManageSnapshots';
import { useWhereUsed } from '../hooks/useWhereUsed';
import { useCopyPaste } from '../hooks/useCopyPaste';
import { HistoryModal } from './modals/HistoryModal';
import { TagEditorPopover } from './TagEditorPopover';

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
  // CRITICAL DEBUG: Log what item this context menu received
  console.log('🟢 [NavigatorItemContextMenu] MOUNTED with item:', {
    type: item.type,
    id: item.id,
    name: item.name,
    path: item.path,
    fullItem: item,
  });
  
  const { tabs, operations } = useTabContext();
  const { state: navState, operations: navOps } = useNavigatorContext();
  const { showConfirm } = useDialog();
  const { handleCommitFiles } = useCommitHandler();
  
  // Check if this item has any open tabs
  const fileId = `${item.type}-${item.id}`;
  const openTabs = tabs.filter(t => t.fileId === fileId);
  
  // Pull hooks - all logic including conflict modal is in the hook
  const { canPull, pullFile } = usePullFile(fileId);
  const { pullAll, conflictModal: pullAllConflictModal } = usePullAll();
  
  // Rename hook
  const { 
    canRename, 
    showRenameModal, 
    hideRenameModal, 
    isRenameModalOpen, 
    renameFile, 
    currentName: renameCurrentName,
    fileType: renameFileType,
    isRenaming 
  } = useRenameFile(fileId);
  
  // History hook
  const {
    canViewHistory,
    showHistoryModal,
    hideHistoryModal,
    isHistoryModalOpen,
    loadHistory,
    getContentAtCommit,
    rollbackToCommit,
    viewAtCommit,
    fileName: historyFileName,
    filePath: historyFilePath,
    isLoading: isHistoryLoading,
    history,
    currentContent
  } = useViewHistory(fileId);

  // Historical version hook
  const {
    canOpenHistorical,
    isLoading: isHistoricalLoading,
    dateItems: historicalDateItems,
    loadDates: loadHistoricalDates,
    selectCommit: selectHistoricalCommit,
  } = useOpenHistorical(fileId);

  // Pre-load historical dates when the context menu mounts so they're ready when the
  // user hovers "Open Historical Version".  The onHover callback on the menu item acts
  // as a fallback trigger.
  useEffect(() => {
    if (canOpenHistorical) {
      loadHistoricalDates();
    }
  }, [canOpenHistorical, loadHistoricalDates]);

  // Clear data file hook
  const { clearDataFile, canClearData } = useClearDataFile();
  const hasDataToClear = fileId ? canClearData(fileId) : false;
  const isDataFile = item.type === 'parameter' || item.type === 'case';
  
  // Snapshot deletion hook (only for parameters)
  const paramIds = item.type === 'parameter' && item.id ? [item.id] : [];
  const { inventories, snapshotCounts, deleteSnapshots, downloadSnapshotData } = useSnapshotsMenu(paramIds);
  const snapshotCount = item.type === 'parameter' ? snapshotCounts[item.id] : undefined;
  const snapshotRowCount = item.type === 'parameter' ? inventories[item.id]?.row_count : undefined;
  const hasSnapshots = (snapshotRowCount ?? 0) > 0;

  // Snapshot Manager hook (parameters and graphs)
  const { canManage: canManageSnapshots, openSnapshotManager } = useManageSnapshots(fileId, item.type);

  // Where used hook
  const { findWhereUsed, isSearching: isSearchingWhereUsed, canSearch: canSearchWhereUsed } = useWhereUsed(fileId);

  // Copy-paste hook
  const { copyToClipboard } = useCopyPaste();
  
  // Share link hook
  const {
    canShare,
    canShareStatic,
    canShareLive,
    canCopyWorkingLink,
    copyStaticShareLink,
    copyLiveShareLink,
    copyWorkingLink,
    liveShareUnavailableReason,
  } = useShareLink(fileId);
  
  // Check if this item type can be copied (nodes, parameters, cases)
  const canCopy = item.type === 'node' || item.type === 'parameter' || item.type === 'case';

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

  // Tag editor popover state
  const [tagEditorPos, setTagEditorPos] = useState<{ x: number; y: number } | null>(null);

  const handleDeleteFile = async (message: string) => {
    try {
      // Check if this is a node file (has special image GC logic)
      const isNodeFile = item.type === 'node';
      
      if (isNodeFile) {
        // Use deleteOperationsService for smart image GC
        const { deleteOperationsService } = await import('../services/deleteOperationsService');
        const nodeId = item.id.replace(/^node-/, '');
        await deleteOperationsService.deleteNodeFile(nodeId);
        
        // Close any open tabs for this file
        for (const tab of openTabs) {
          await operations.closeTab(tab.id, true); // Force close
        }
        
        // Refresh navigator to remove deleted item
        await navOps.refreshItems();
      } else {
        // For non-node files, use standard file deletion (but still staged, not immediate Git)
        // Close any open tabs for this file
        for (const tab of openTabs) {
          await operations.closeTab(tab.id, true); // Force close
        }
        
        // Stage file deletion (don't delete from Git immediately)
        fileRegistry.registerFileDeletion(item.id, item.path, item.type);
        
        // Remove from local FileRegistry
        await fileRegistry.deleteFile(item.id);
        
        // Refresh navigator
        await navOps.refreshItems();
        
        toast.success(`File deletion staged: ${item.id} (commit to sync to Git)`);
      }
    } catch (error) {
      throw error; // Re-throw to be handled by DeleteModal
    }
  };
  
  // Build menu items fresh on each render to avoid stale closures on `item`
  const menuItems: ContextMenuItem[] = [];

  // Open actions - ALWAYS open new tabs (force=true)
  menuItems.push({
    label: 'Open in Editor',
    onClick: () => {
      operations.openTab(item, 'interactive', true);
    }
  });
  menuItems.push({
    label: 'Open as JSON',
    onClick: () => {
      operations.openTab(item, 'raw-json', true);
    }
  });
  menuItems.push({
    label: 'Open as YAML',
    onClick: () => {
      operations.openTab(item, 'raw-yaml', true);
    }
  });

  // Copy action (for nodes, parameters, cases - can be pasted onto graph elements)
  if (canCopy) {
    menuItems.push({
      label: 'Copy',
      onClick: async () => {
        console.log('[NavigatorItemContextMenu] Copy clicked for', {
          type: item.type,
          id: item.id,
          fileId,
        });
        await copyToClipboard(item.type as 'node' | 'parameter' | 'case', item.id);
        onClose();
      }
    });
  }

  menuItems.push({ label: '', onClick: () => {}, divider: true });

  // Close actions (only if there are open tabs)
  if (openTabs.length > 0) {
    menuItems.push({
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
    menuItems.push({ label: '', onClick: () => {}, divider: true });
  }

  // File operations
  menuItems.push({
    label: 'Rename...',
    onClick: () => {
      showRenameModal();
    },
    keepMenuOpen: true,
    disabled: !canRename
  });
  menuItems.push({
    label: 'Duplicate...',
    onClick: () => {
      setIsDuplicateModalOpen(true);
    },
    keepMenuOpen: true
  });
  menuItems.push({
    label: 'Edit Tags…',
    onClick: () => {
      setTagEditorPos({ x: x + 160, y });
    },
    keepMenuOpen: true
  });
  menuItems.push({ label: '', onClick: () => {}, divider: true });

  // Git actions - only show if file is committable
  if (fileRegistry.isFileCommittableById(fileId)) {
    menuItems.push({
      label: 'Commit This File...',
      onClick: () => {
        // Open commit modal - remote-ahead check happens inside commitFiles
        setCommitModalPreselectedFiles([fileId]);
        setIsCommitModalOpen(true);
      },
      keepMenuOpen: true // Keep menu open so modal can render
    });
  }
  menuItems.push({
    label: 'Commit All Changes...',
    onClick: () => {
      // Open commit modal - remote-ahead check happens inside commitFiles
      setCommitModalPreselectedFiles([]);
      setIsCommitModalOpen(true);
    },
    keepMenuOpen: true // Keep menu open so modal can render
  });
  if (canViewHistory) {
    menuItems.push({
      label: 'View History',
      onClick: () => {
        showHistoryModal();
      },
      keepMenuOpen: true
    });
  }
  console.log(`[NavigatorItemContextMenu] canOpenHistorical=${canOpenHistorical}, isHistoricalLoading=${isHistoricalLoading}, historicalDateItems=${historicalDateItems === null ? 'null' : `array(${historicalDateItems?.length})`}`);
  if (canOpenHistorical) {
    // Build submenu items from loaded date items
    const historicalSubmenu: ContextMenuItem[] = [];
    if (isHistoricalLoading || !historicalDateItems) {
      historicalSubmenu.push({ label: 'Loading…', onClick: () => {}, disabled: true });
    } else if (historicalDateItems.length === 0) {
      historicalSubmenu.push({ label: 'No historical versions', onClick: () => {}, disabled: true });
    } else {
      for (const dateItem of historicalDateItems) {
        if (dateItem.commits.length === 1) {
          const commit = dateItem.commits[0];
          historicalSubmenu.push({
            label: `${dateItem.dateUK}  ${commit.shortSha}`,
            onClick: () => { selectHistoricalCommit(commit); },
          });
        } else {
          historicalSubmenu.push({
            label: `${dateItem.dateUK} (${dateItem.commits.length})`,
            onClick: () => {},
            submenu: dateItem.commits.map((commit) => ({
              label: `${commit.shortSha}  ${commit.message}`,
              onClick: () => { selectHistoricalCommit(commit); },
            })),
          });
        }
      }
    }
    menuItems.push({
      label: 'Open Historical Version',
      onClick: () => {},
      onHover: () => loadHistoricalDates(),
      submenu: historicalSubmenu,
    });
  }

  // Where Used - find all references to this file
  if (canSearchWhereUsed) {
    menuItems.push({
      label: isSearchingWhereUsed ? 'Searching...' : 'Where Used...',
      onClick: async () => {
        await findWhereUsed();
        onClose();
      },
      disabled: isSearchingWhereUsed
    });
  }

  // Share links (for graphs and charts)
  if (canShare) {
    if (canCopyWorkingLink) {
      menuItems.push({
        label: 'Copy Working Link',
        onClick: async () => {
          await copyWorkingLink();
          onClose();
        }
      });
    }
    if (canShareStatic) {
      menuItems.push({
        label: 'Copy Static Share Link',
        onClick: async () => {
          await copyStaticShareLink();
          onClose();
        }
      });
    }
    
    menuItems.push({
      label: canShareLive ? 'Copy Live Share Link' : `Copy Live Share Link (${liveShareUnavailableReason || 'unavailable'})`,
      onClick: async () => {
        await copyLiveShareLink();
        onClose();
      },
      disabled: !canShareLive
    });
  }

  // Clear data file (only for parameter/case files with data)
  if (isDataFile) {
    menuItems.push({
      label: 'Clear data file',
      onClick: async () => {
        if (fileId) {
          await clearDataFile(fileId);
        }
        onClose();
      },
      disabled: !hasDataToClear
    });
  }
  
  // Snapshots submenu (for parameters)
  if (item.type === 'parameter') {
    menuItems.push({
      label: 'Snapshots',
      onClick: () => {},
      submenu: [
        {
          label: 'Download snapshot data',
          disabled: !hasSnapshots,
          onClick: async () => {
            await downloadSnapshotData(item.id);
            onClose();
          },
        },
        {
          label: `Delete ${snapshotCount ?? 0} snapshot${(snapshotCount ?? 0) !== 1 ? 's' : ''}`,
          disabled: (snapshotCount ?? 0) === 0,
          onClick: async () => {
            await deleteSnapshots(item.id);
            onClose();
          },
        },
        { label: '', onClick: () => {}, divider: true },
        {
          label: 'Manage...',
          onClick: () => {
            openSnapshotManager();
            onClose();
          },
        },
      ],
    });
  }

  // Snapshot Manager (for graphs)
  if (item.type === 'graph' && canManageSnapshots) {
    menuItems.push({
      label: 'Snapshot Manager...',
      onClick: () => {
        openSnapshotManager();
        onClose();
      },
    });
  }

  menuItems.push({ label: '', onClick: () => {}, divider: true });

  // Pull Latest - fetch latest version from remote (uses usePullFile hook)
  if (canPull) {
    menuItems.push({
      label: 'Pull Latest',
      onClick: async () => {
        await pullFile();
        onClose();
      }
    });
  }

  // Pull All Latest - fetch all latest from remote
  menuItems.push({
    label: 'Pull All Latest',
    onClick: async () => {
      await pullAll();
      onClose();
    }
  });

  // Revert - always show (same as tab context menu "Revert")
  menuItems.push({
    label: 'Revert',
    onClick: async () => {
      await fileOperationsService.revertFile(fileId);
      onClose();
    }
  });

  // Discard Changes (if dirty) - same as Revert but more explicit label
  const currentFile = fileRegistry.getFile(fileId);
  if (currentFile?.isDirty) {
    menuItems.push({
      label: 'Discard Changes',
      onClick: async () => {
        await fileOperationsService.revertFile(fileId);
        onClose();
      }
    });
  }
  menuItems.push({ label: '', onClick: () => {}, divider: true });

  // Danger actions
  menuItems.push({
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
  menuItems.push({ label: '', onClick: () => {}, divider: true });

  // Info
  menuItems.push({
    label: 'Copy Name',
    onClick: () => navigator.clipboard.writeText(item.name)
  });
  menuItems.push({
    label: 'Copy Path',
    onClick: () => navigator.clipboard.writeText(item.path)
  });

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
      {!tagEditorPos && <ContextMenu x={x} y={y} items={menuItems} onClose={onClose} />}
      
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
      
      {/* Rename Modal */}
      <RenameModal
        isOpen={isRenameModalOpen}
        onClose={() => {
          hideRenameModal();
          onClose();
        }}
        onRename={renameFile}
        currentName={renameCurrentName}
        fileType={renameFileType}
        isRenaming={isRenaming}
      />
      
      {/* History Modal */}
      <HistoryModal
        isOpen={isHistoryModalOpen}
        onClose={() => {
          hideHistoryModal();
          onClose();
        }}
        fileName={historyFileName}
        filePath={historyFilePath}
        isLoading={isHistoryLoading}
        history={history}
        currentContent={currentContent}
        onLoadHistory={loadHistory}
        onGetContentAtCommit={getContentAtCommit}
        onRollback={rollbackToCommit}
        onView={viewAtCommit}
      />

      {/* Tag Editor Popover */}
      {tagEditorPos && (
        <TagEditorPopover
          fileId={fileId}
          x={tagEditorPos.x}
          y={tagEditorPos.y}
          onClose={() => {
            setTagEditorPos(null);
            onClose();
          }}
        />
      )}

      {/* Pull all conflict modal - managed by usePullAll hook */}
      {pullAllConflictModal}
    </>
  );
}

