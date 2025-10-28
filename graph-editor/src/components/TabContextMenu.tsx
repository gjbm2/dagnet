import React, { useMemo, useState } from 'react';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { NewFileModal } from './NewFileModal';
import { ObjectType } from '../types';

interface TabContextMenuProps {
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
  onRequestCommit: (preselectedFiles: string[]) => void;
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
    items.push({
      label: 'Duplicate...',
      onClick: () => {
        setIsDuplicateModalOpen(true);
      },
      keepMenuOpen: true
    });
    
    // Git operations
    items.push({ label: '', onClick: () => {}, divider: true });
    items.push({
      label: 'Commit This File...',
      onClick: () => {
        onRequestCommit([tab.fileId]);
      }
    });
    items.push({
      label: 'Commit All Changes...',
      onClick: () => {
        onRequestCommit([]);
      }
    });
    items.push({
      label: 'View History',
      onClick: () => {
        // TODO: Open history view for this file
        console.log('View history for:', tab.fileId);
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
    
    // Info
    items.push({
      label: 'Copy File ID',
      onClick: () => navigator.clipboard.writeText(tab.fileId)
    });
    
    return items;
  }, [tab, tabId, tabs, operations]);
  
  const handleDuplicate = async (name: string, type: ObjectType) => {
    if (!tab) return;
    
    // Get current file data
    const currentFile = fileRegistry.getFile(tab.fileId);
    if (!currentFile) {
      throw new Error('File not found');
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
      { repository: 'local', path: `${type}s/${name}`, branch: currentFile.source.branch },
      duplicatedData
    );
    
    // Add to navigator as local/uncommitted item
    const item = {
      id: name,
      type: type,
      name: name,
      path: `${type}s/${name}.${type === 'graph' ? 'json' : 'yaml'}`,
      description: currentFile.data.description || '',
      isLocal: true
    };
    
    navOps.addLocalItem(item);
    
    // Open the duplicated file in a new tab
    await operations.openTab(item, 'interactive');
    
    // Close the duplicate modal
    setIsDuplicateModalOpen(false);
    
    // Close the context menu
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
    </>
  );
}
