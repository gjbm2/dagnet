import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { SyncIndexModal } from '../modals/SyncIndexModal';
import type { AlignCommand, DistributeCommand, EqualSizeCommand } from '../../services/alignmentService';

/**
 * Elements Menu
 *
 * Graph-specific element operations:
 * - Add Node / Add Post-It / Add Container
 * - Delete Selected
 * - Align / Distribute (submenu)
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

  const handleAddAnalysis = () => {
    window.dispatchEvent(new CustomEvent('dagnet:addAnalysis'));
  };

  const handleDeleteSelected = () => {
    window.dispatchEvent(new CustomEvent('dagnet:deleteSelected'));
  };

  const handleAlign = (command: AlignCommand) => {
    window.dispatchEvent(new CustomEvent('dagnet:align', { detail: { command } }));
  };

  const handleDistribute = (command: DistributeCommand) => {
    window.dispatchEvent(new CustomEvent('dagnet:distribute', { detail: { command } }));
  };

  const handleEqualSize = (command: EqualSizeCommand) => {
    window.dispatchEvent(new CustomEvent('dagnet:equalSize', { detail: { command } }));
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

            <Menubar.Item
              className="menubar-item"
              onSelect={handleAddAnalysis}
            >
              Add Analysis
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

            <Menubar.Sub>
              <Menubar.SubTrigger className="menubar-item">
                Align
                <div className="menubar-right-slot">›</div>
              </Menubar.SubTrigger>
              <Menubar.Portal>
                <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                  <Menubar.Item className="menubar-item" onSelect={() => handleAlign('align-left')}>
                    Align Left Edges
                  </Menubar.Item>
                  <Menubar.Item className="menubar-item" onSelect={() => handleAlign('align-right')}>
                    Align Right Edges
                  </Menubar.Item>
                  <Menubar.Item className="menubar-item" onSelect={() => handleAlign('align-top')}>
                    Align Top Edges
                  </Menubar.Item>
                  <Menubar.Item className="menubar-item" onSelect={() => handleAlign('align-bottom')}>
                    Align Bottom Edges
                  </Menubar.Item>

                  <Menubar.Separator className="menubar-separator" />

                  <Menubar.Item className="menubar-item" onSelect={() => handleAlign('align-centre-horizontal')}>
                    Align Centre Horizontally
                  </Menubar.Item>
                  <Menubar.Item className="menubar-item" onSelect={() => handleAlign('align-centre-vertical')}>
                    Align Centre Vertically
                  </Menubar.Item>

                  <Menubar.Separator className="menubar-separator" />

                  <Menubar.Item className="menubar-item" onSelect={() => handleDistribute('distribute-horizontal')}>
                    Distribute Horizontally
                  </Menubar.Item>
                  <Menubar.Item className="menubar-item" onSelect={() => handleDistribute('distribute-vertical')}>
                    Distribute Vertically
                  </Menubar.Item>

                  <Menubar.Separator className="menubar-separator" />

                  <Menubar.Item className="menubar-item" onSelect={() => handleEqualSize('equal-width')}>
                    Make Equal Width
                  </Menubar.Item>
                  <Menubar.Item className="menubar-item" onSelect={() => handleEqualSize('equal-height')}>
                    Make Equal Height
                  </Menubar.Item>
                </Menubar.SubContent>
              </Menubar.Portal>
            </Menubar.Sub>

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
