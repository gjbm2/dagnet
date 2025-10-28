import React, { useMemo } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

interface TabContextMenuProps {
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Context menu for tab right-click
 * Context-sensitive: shows view mode options based on current view
 */
export function TabContextMenu({ tabId, x, y, onClose }: TabContextMenuProps) {
  const { tabs, operations } = useTabContext();
  const tab = tabs.find(t => t.id === tabId);

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

  if (!tab) return null;

  return <ContextMenu x={x} y={y} items={menuItems} onClose={onClose} />;
}
