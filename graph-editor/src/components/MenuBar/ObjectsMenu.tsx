import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { SyncIndexModal } from '../modals/SyncIndexModal';

/**
 * Objects Menu
 * 
 * Graph-specific object operations:
 * - Add Node
 * - Delete Selected
 * - Sync Index from Graph
 * 
 * Only visible when a graph tab in interactive mode is active
 */
export function ObjectsMenu() {
  const { activeTabId, tabs } = useTabContext();
  const { items } = useNavigatorContext();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isGraphTab = activeTab?.fileId.startsWith('graph-') && activeTab?.viewMode === 'interactive';
  
  const [isSyncIndexModalOpen, setIsSyncIndexModalOpen] = useState(false);

  // Don't render if not a graph tab
  if (!isGraphTab) {
    return null;
  }

  const handleAddNode = () => {
    // Trigger custom event that GraphEditor will listen to
    window.dispatchEvent(new CustomEvent('dagnet:addNode'));
  };

  const handleDeleteSelected = () => {
    // Trigger custom event that GraphEditor will listen to
    window.dispatchEvent(new CustomEvent('dagnet:deleteSelected'));
  };

  const handleSyncIndex = () => {
    setIsSyncIndexModalOpen(true);
  };

  // Get all graph files for the modal
  const graphFiles = items
    .filter(item => item.type === 'graph')
    .map(item => ({ id: item.id, name: item.name }));

  return (
    <>
      <Menubar.Menu>
        <Menubar.Trigger className="menubar-trigger">Objects</Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className="menubar-content" align="start">
            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleAddNode}
            >
              Add Node
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleDeleteSelected}
            >
              Delete Selected
              <div className="menubar-right-slot">⌫</div>
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleSyncIndex}
            >
              Sync Index from Graph...
            </Menubar.Item>
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>

      {/* Modals */}
      <SyncIndexModal
        isOpen={isSyncIndexModalOpen}
        onClose={() => setIsSyncIndexModalOpen(false)}
        graphFiles={graphFiles}
      />
    </>
  );
}

