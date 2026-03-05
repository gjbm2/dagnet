import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { SyncIndexModal } from '../modals/SyncIndexModal';

/**
 * Elements Menu
 * 
 * Graph-specific element operations:
 * - Add Node / Add Post-It / Add Container
 * - Delete Selected
 * - Sync Index from Graph
 * 
 * Only visible when a graph tab in interactive mode is active
 */
export function ElementsMenu() {
  const { activeTabId, tabs } = useTabContext();
  const { items } = useNavigatorContext();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isGraphTab = activeTab?.fileId.startsWith('graph-') && activeTab?.viewMode === 'interactive';
  
  const [isSyncIndexModalOpen, setIsSyncIndexModalOpen] = useState(false);

  if (!isGraphTab) {
    return null;
  }

  const handleAddNode = () => {
    window.dispatchEvent(new CustomEvent('dagnet:addNode'));
  };

  const handleAddPostit = () => {
    window.dispatchEvent(new CustomEvent('dagnet:addPostit'));
  };

  const handleAddContainer = () => {
    window.dispatchEvent(new CustomEvent('dagnet:addContainer'));
  };

  const handleDeleteSelected = () => {
    window.dispatchEvent(new CustomEvent('dagnet:deleteSelected'));
  };

  const handleSyncIndex = () => {
    setIsSyncIndexModalOpen(true);
  };

  const graphFiles = items
    .filter(item => item.type === 'graph')
    .map(item => ({ id: item.id, name: item.name }));

  return (
    <>
      <Menubar.Menu>
        <Menubar.Trigger className="menubar-trigger">Elements</Menubar.Trigger>
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
              onSelect={handleAddPostit}
            >
              Add Post-It
            </Menubar.Item>

            <Menubar.Item 
              className="menubar-item" 
              onSelect={handleAddContainer}
            >
              Add Container
            </Menubar.Item>

            <Menubar.Separator className="menubar-separator" />

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

      <SyncIndexModal
        isOpen={isSyncIndexModalOpen}
        onClose={() => setIsSyncIndexModalOpen(false)}
        graphFiles={graphFiles}
      />
    </>
  );
}
