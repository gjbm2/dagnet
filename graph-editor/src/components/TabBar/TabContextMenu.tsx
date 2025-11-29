import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useTabContext } from '../../contexts/TabContext';
import { usePullFile } from '../../hooks/usePullFile';
import { usePullAll } from '../../hooks/usePullAll';
import { useRenameFile } from '../../hooks/useRenameFile';
import { useViewHistory } from '../../hooks/useViewHistory';
import { RenameModal } from '../RenameModal';
import { HistoryModal } from '../modals/HistoryModal';
import './TabBar.css';

/**
 * Tab Context Menu (Right-Click)
 * 
 * Options:
 * - Open in New Tab (JSON/YAML views)
 * - Save
 * - Revert
 * - Close
 * - Close Others
 * - Close to Right
 * - Close All
 * - Copy Path
 * - Reveal in Navigator
 */
interface TabContextMenuProps {
  tabId: string;
  children: React.ReactNode;
}

export function TabContextMenu({ tabId, children }: TabContextMenuProps) {
  const { tabs, operations } = useTabContext();
  const tab = tabs.find(t => t.id === tabId);
  const tabIndex = tabs.findIndex(t => t.id === tabId);
  
  // Pull hooks - all logic including conflict modal is in the hook
  const { canPull, pullFile } = usePullFile(tab?.fileId);
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
  } = useRenameFile(tab?.fileId);
  
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

  if (!tab) return <>{children}</>;

  const canOpenNewView = tab.viewMode === 'interactive';
  const hasTabsToRight = tabIndex < tabs.length - 1;
  const hasOtherTabs = tabs.length > 1;

  const handleOpenJSONView = async () => {
    await operations.openInNewView(tabId, 'raw-json');
  };

  const handleOpenYAMLView = async () => {
    await operations.openInNewView(tabId, 'raw-yaml');
  };

  const handleSave = async () => {
    await operations.saveTab(tabId);
  };

  const handleRevert = () => {
    operations.revertTab(tabId);
  };

  const handleClose = async () => {
    await operations.closeTab(tabId);
  };

  const handleCloseOthers = async () => {
    const otherTabs = tabs.filter(t => t.id !== tabId);
    await Promise.all(otherTabs.map(t => operations.closeTab(t.id)));
  };

  const handleCloseToRight = async () => {
    const tabsToRight = tabs.slice(tabIndex + 1);
    await Promise.all(tabsToRight.map(t => operations.closeTab(t.id)));
  };

  const handleCloseAll = async () => {
    await Promise.all(tabs.map(t => operations.closeTab(t.id)));
  };

  const handleCopyPath = () => {
    // TODO: Get file path from file registry
    console.log('Copy path for', tabId);
  };

  const handleRevealInNavigator = () => {
    // TODO: Open navigator and scroll to item
    console.log('Reveal in navigator', tabId);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {children}
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tab-context-menu" sideOffset={5}>
          {canOpenNewView && (
            <>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="tab-context-item">
                  Open in New Tab
                  <div className="tab-context-right-slot">›</div>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="tab-context-menu" sideOffset={2} alignOffset={-5}>
                    <DropdownMenu.Item 
                      className="tab-context-item" 
                      onSelect={handleOpenJSONView}
                    >
                      Open JSON View
                    </DropdownMenu.Item>
                    <DropdownMenu.Item 
                      className="tab-context-item" 
                      onSelect={handleOpenYAMLView}
                    >
                      Open YAML View
                    </DropdownMenu.Item>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>

              <DropdownMenu.Separator className="tab-context-separator" />
            </>
          )}

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleSave}
          >
            Save
          </DropdownMenu.Item>

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={showRenameModal}
            disabled={!canRename}
          >
            Rename...
          </DropdownMenu.Item>

          {canPull && (
            <DropdownMenu.Item 
              className="tab-context-item" 
              onSelect={pullFile}
            >
              Pull Latest
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={pullAll}
          >
            Pull All Latest
          </DropdownMenu.Item>

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleRevert}
          >
            Revert
          </DropdownMenu.Item>

          {canViewHistory && (
            <DropdownMenu.Item 
              className="tab-context-item" 
              onSelect={showHistoryModal}
            >
              View History
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Separator className="tab-context-separator" />

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleClose}
          >
            Close
          </DropdownMenu.Item>

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleCloseOthers}
            disabled={!hasOtherTabs}
          >
            Close Others
          </DropdownMenu.Item>

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleCloseToRight}
            disabled={!hasTabsToRight}
          >
            Close to Right
          </DropdownMenu.Item>

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleCloseAll}
          >
            Close All
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="tab-context-separator" />

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleCopyPath}
          >
            Copy Path
          </DropdownMenu.Item>

          <DropdownMenu.Item 
            className="tab-context-item" 
            onSelect={handleRevealInNavigator}
          >
            Reveal in Navigator
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
      
      {/* Rename Modal */}
      <RenameModal
        isOpen={isRenameModalOpen}
        onClose={hideRenameModal}
        onRename={renameFile}
        currentName={renameCurrentName}
        fileType={renameFileType}
        isRenaming={isRenaming}
      />
      
      {/* History Modal */}
      <HistoryModal
        isOpen={isHistoryModalOpen}
        onClose={hideHistoryModal}
        fileName={historyFileName}
        filePath={historyFilePath}
        isLoading={isHistoryLoading}
        history={history}
        currentContent={currentContent}
        onLoadHistory={loadHistory}
        onGetContentAtCommit={getContentAtCommit}
        onRollback={rollbackToCommit}
      />
      
      {/* Pull all conflict modal - managed by usePullAll hook */}
      {pullAllConflictModal}
    </DropdownMenu.Root>
  );
}

