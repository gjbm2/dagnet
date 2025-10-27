import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';

/**
 * Edit Menu
 * 
 * Context-sensitive operations based on active editor
 * - Undo/Redo
 * - Cut/Copy/Paste
 * - Find/Replace (for raw views)
 */
export function EditMenu() {
  const { activeTabId, tabs } = useTabContext();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isRawView = activeTab?.viewMode === 'raw-json' || activeTab?.viewMode === 'raw-yaml';

  const handleUndo = () => {
    // TODO: Implement undo
    console.log('Undo');
  };

  const handleRedo = () => {
    // TODO: Implement redo
    console.log('Redo');
  };

  const handleCut = () => {
    document.execCommand('cut');
  };

  const handleCopy = () => {
    document.execCommand('copy');
  };

  const handlePaste = () => {
    document.execCommand('paste');
  };

  const handleFind = () => {
    // TODO: Implement find
    console.log('Find');
  };

  const handleReplace = () => {
    // TODO: Implement replace
    console.log('Replace');
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">Edit</Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleUndo}
            disabled={!activeTab}
          >
            Undo
            <div className="menubar-right-slot">⌘Z</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleRedo}
            disabled={!activeTab}
          >
            Redo
            <div className="menubar-right-slot">⌘⇧Z</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCut}
            disabled={!activeTab}
          >
            Cut
            <div className="menubar-right-slot">⌘X</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCopy}
            disabled={!activeTab}
          >
            Copy
            <div className="menubar-right-slot">⌘C</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handlePaste}
            disabled={!activeTab}
          >
            Paste
            <div className="menubar-right-slot">⌘V</div>
          </Menubar.Item>

          {isRawView && (
            <>
              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleFind}
              >
                Find
                <div className="menubar-right-slot">⌘F</div>
              </Menubar.Item>

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleReplace}
              >
                Replace
                <div className="menubar-right-slot">⌘⌥F</div>
              </Menubar.Item>
            </>
          )}
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

