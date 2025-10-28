import React, { useMemo } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { RepositoryItem } from '../types';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

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
  
  // Check if this item has any open tabs
  const fileId = `${item.type}-${item.id}`;
  const openTabs = tabs.filter(t => t.fileId === fileId);
  
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
    
    // Git actions (TODO: implement)
    items.push({
      label: 'Commit...',
      onClick: () => console.log('Commit', item.name),
      disabled: true
    });
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Danger actions
    items.push({
      label: 'Delete from Repository...',
      onClick: () => console.log('Delete', item.name),
      disabled: true
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

  return <ContextMenu x={x} y={y} items={menuItems} onClose={onClose} />;
}

