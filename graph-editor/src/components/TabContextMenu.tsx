import React, { useMemo, useState } from 'react';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { NewFileModal } from './NewFileModal';
import { HistoryModal } from './modals/HistoryModal';
import { ObjectType } from '../types';
import { fileOperationsService } from '../services/fileOperationsService';
import { useViewHistory } from '../hooks/useViewHistory';
import { useShareLink } from '../hooks/useShareLink';

interface TabContextMenuProps {
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
  onRequestCommit: (preselectedFiles: string[]) => void | Promise<void>;
}

/**
 * Context menu for tab right-click
 * Context-sensitive: shows view mode options based on current view
 */
export function TabContextMenu({ tabId, x, y, onClose, onRequestCommit }: TabContextMenuProps) {
  const { tabs, operations } = useTabContext();
  const { operations: navOps } = useNavigatorContext();
  const tab = tabs.find(t => t.id === tabId);
  
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);
  
  // History hook
  const {
    canViewHistory,
    showHistoryModal,
    hideHistoryModal,
    isHistoryModalOpen,
    loadHistory,
    getContentAtCommit,
    rollbackToCommit,
    fileName: historyFileName,
    filePath: historyFilePath,
    isLoading: isHistoryLoading,
    history,
    currentContent
  } = useViewHistory(tab?.fileId);
  
  // Share link hook
  const {
    canShare,
    canShareStatic,
    canShareLive,
    copyStaticShareLink,
    copyLiveShareLink,
    liveShareUnavailableReason,
  } = useShareLink(tab?.fileId);

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!tab) return [];
    
    const items: ContextMenuItem[] = [];
    
    // View mode switching - ALWAYS show all view options to allow multiple views of same type
    items.push({
      label: tab.viewMode === 'interactive' ? 'Open Editor View (New)' : 'Open Editor View',
      onClick: () => operations.openInNewView(tabId, 'interactive')
    });
    
    items.push({
      label: tab.viewMode === 'raw-json' ? 'Open JSON View (New)' : 'Open JSON View',
      onClick: () => operations.openInNewView(tabId, 'raw-json')
    });
    
    items.push({
      label: tab.viewMode === 'raw-yaml' ? 'Open YAML View (New)' : 'Open YAML View',
      onClick: () => operations.openInNewView(tabId, 'raw-yaml')
    });
    
    // Divider after view mode section
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // File operations
    items.push({
      label: 'Save',
      onClick: () => operations.saveTab(tabId)
    });
    items.push({
      label: 'Revert',
      onClick: () => operations.revertTab(tabId)
    });
    
    // Discard Changes (if dirty)
    const currentFile = fileRegistry.getFile(tab.fileId);
    if (currentFile?.isDirty) {
      items.push({
        label: 'Discard Changes',
        onClick: async () => {
          await fileOperationsService.revertFile(tab.fileId);
          onClose();
        }
      });
    }
    
    items.push({
      label: 'Duplicate...',
      onClick: () => {
        setIsDuplicateModalOpen(true);
      },
      keepMenuOpen: true
    });
    
    // Graph-specific operations (only for graph tabs)
    if (tab.fileId.startsWith('graph-') && tab.viewMode === 'interactive') {
      items.push({ label: '', onClick: () => {}, divider: true });
      items.push({
        label: 'Reset Sidebar',
        onClick: () => {
          // Dispatch event to reset sidebar for this specific tab
          window.dispatchEvent(new CustomEvent('dagnet:resetSidebar', { 
            detail: { tabId } 
          }));
          onClose();
        }
      });
    }
    
    // Git operations - only show if file is committable
    if (fileRegistry.isFileCommittableById(tab.fileId)) {
      items.push({ label: '', onClick: () => {}, divider: true });
      items.push({
        label: 'Commit This File...',
        onClick: () => {
          onRequestCommit([tab.fileId]);
        }
      });
    }
    items.push({
      label: 'Commit All Changes...',
      onClick: () => {
        onRequestCommit([]);
      }
    });
    if (canViewHistory) {
      items.push({
        label: 'View History',
        onClick: () => {
          showHistoryModal();
        },
        keepMenuOpen: true
      });
    }
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Danger actions
    items.push({
      label: 'Delete',
      onClick: async () => {
        const success = await fileOperationsService.deleteFile(tab.fileId);
        if (success) {
          onClose();
        }
      }
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Tab operations
    items.push({
      label: 'Close',
      onClick: () => operations.closeTab(tabId)
    });
    items.push({
      label: 'Close Others',
      onClick: async () => {
        for (const t of tabs) {
          if (t.id !== tabId) {
            await operations.closeTab(t.id);
          }
        }
      },
      disabled: tabs.length === 1
    });
    items.push({
      label: 'Close All',
      onClick: async () => {
        for (const t of tabs) {
          await operations.closeTab(t.id);
        }
      }
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Share links (for graphs and charts only)
    if (canShare) {
      if (canShareStatic) {
        items.push({
          label: 'Copy Static Share Link',
          onClick: async () => {
            await copyStaticShareLink();
            onClose();
          }
        });
      }
      
      items.push({
        label: canShareLive ? 'Copy Live Share Link' : `Copy Live Share Link (${liveShareUnavailableReason || 'unavailable'})`,
        onClick: async () => {
          await copyLiveShareLink();
          onClose();
        },
        disabled: !canShareLive
      });
      
      items.push({ label: '', onClick: () => {}, divider: true });
    }
    
    // Info
    items.push({
      label: 'Copy File ID',
      onClick: () => navigator.clipboard.writeText(tab.fileId)
    });
    
    return items;
  }, [tab, tabId, tabs, operations, canViewHistory, showHistoryModal, canShare, canShareStatic, canShareLive, copyStaticShareLink, copyLiveShareLink, liveShareUnavailableReason, onClose]);
  
  const handleDuplicate = async (name: string, type: ObjectType) => {
    if (!tab) return;
    
    await fileOperationsService.duplicateFile(tab.fileId, name, true);
    
    setIsDuplicateModalOpen(false);
    onClose();
  };

  if (!tab) return null;
  
  // Get file for duplicate modal
  const file = fileRegistry.getFile(tab.fileId);
  const fileType = file?.type as ObjectType | undefined;
  const originalName = tab.fileId.split('-').slice(1).join('-').replace(/\.(json|yaml)$/, '');

  return (
    <>
      <ContextMenu x={x} y={y} items={menuItems} onClose={onClose} />
      
      {/* Duplicate Modal */}
      {fileType && (
        <NewFileModal
          isOpen={isDuplicateModalOpen}
          onClose={() => {
            setIsDuplicateModalOpen(false);
            onClose();
          }}
          onCreate={handleDuplicate}
          fileType={fileType}
          defaultName={`${originalName}-copy`}
        />
      )}
      
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
      />
    </>
  );
}
