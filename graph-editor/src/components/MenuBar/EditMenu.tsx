import React, { useState, useEffect, useRef } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { getGraphStore } from '../../contexts/GraphStoreContext';

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
  const isGraphEditor = activeTab?.fileId.startsWith('graph-') && activeTab?.viewMode === 'interactive';
  const isFormEditor = (activeTab?.fileId.startsWith('parameter-') || 
                        activeTab?.fileId.startsWith('context-') || 
                        activeTab?.fileId.startsWith('case-')) && 
                       activeTab?.viewMode === 'interactive';

  console.log('EditMenu render:', { 
    activeTabId, 
    fileId: activeTab?.fileId, 
    viewMode: activeTab?.viewMode,
    isGraphEditor,
    isFormEditor,
    isRawView
  });

  // Track undo/redo state for the active editor
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoFnRef = useRef<(() => void) | null>(null);
  const redoFnRef = useRef<(() => void) | null>(null);

  // Subscribe to the active tab's graph store OR form editor for undo/redo state
  useEffect(() => {
    console.log('EditMenu: useEffect triggered', { 
      isGraphEditor, 
      isFormEditor,
      fileId: activeTab?.fileId 
    });
    
    // Handle form editor undo/redo
    if (isFormEditor && activeTab?.fileId) {
      console.log('EditMenu: Querying form editor undo/redo state');
      
      const queryFormEditor = () => {
        const detail = { 
          fileId: activeTab.fileId,
          canUndo: false,
          canRedo: false,
          undo: null as any,
          redo: null as any
        };
        
        window.dispatchEvent(new CustomEvent('dagnet:queryUndoRedo', { detail }));
        
        if (detail.undo && detail.redo) {
          setCanUndo(detail.canUndo);
          setCanRedo(detail.canRedo);
          undoFnRef.current = detail.undo;
          redoFnRef.current = detail.redo;
        }
      };
      
      queryFormEditor();
      
      // Poll for state changes (form editor updates its state)
      const interval = setInterval(queryFormEditor, 500);
      return () => clearInterval(interval);
    }
    
    if (!isGraphEditor || !activeTab?.fileId) {
      console.log('EditMenu: Not a graph/form editor, disabling undo/redo');
      setCanUndo(false);
      setCanRedo(false);
      undoFnRef.current = null;
      redoFnRef.current = null;
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let retryCount = 0;
    const maxRetries = 10;
    
    const trySubscribe = () => {
      const store = getGraphStore(activeTab.fileId);
      console.log(`EditMenu: Attempt ${retryCount + 1} - Got store for ${activeTab.fileId}:`, store ? 'EXISTS' : 'NULL');
      
      if (!store) {
        if (retryCount < maxRetries) {
          retryCount++;
          // Store not ready yet, retry after a delay
          setTimeout(trySubscribe, 100);
        } else {
          console.warn('EditMenu: Store not found after', maxRetries, 'retries, disabling undo/redo');
          setCanUndo(false);
          setCanRedo(false);
        }
        return;
      }

      // Store found - subscribe
      const updateState = () => {
        const state = store.getState();
        console.log(`EditMenu: Updating undo/redo state for ${activeTab.fileId}:`, {
          canUndo: state.canUndo,
          canRedo: state.canRedo,
          historyIndex: state.historyIndex,
          historyLength: state.history.length
        });
        setCanUndo(state.canUndo);
        setCanRedo(state.canRedo);
      };
      
      console.log('EditMenu: Setting up subscription');
      updateState();
      unsubscribe = store.subscribe(updateState);
      console.log('EditMenu: Subscription active');
    };
    
    trySubscribe();

    return () => {
      if (unsubscribe) {
        console.log('EditMenu: Unsubscribing from', activeTab.fileId);
        unsubscribe();
      }
    };
  }, [isGraphEditor, isFormEditor, activeTab?.fileId]);

  const handleUndo = () => {
    if (isGraphEditor && activeTab?.fileId) {
      // Graph editor - use graph store undo
      const store = getGraphStore(activeTab.fileId);
      if (store && store.getState().canUndo) {
        store.getState().undo();
      }
    } else if (isFormEditor && undoFnRef.current) {
      // Form editor - use form undo
      console.log('EditMenu: Triggering form editor undo');
      undoFnRef.current();
    } else if (isRawView) {
      // Raw view - trigger Monaco editor's undo
      console.log('EditMenu: Triggering Monaco undo via execCommand');
      document.execCommand('undo');
    }
  };

  const handleRedo = () => {
    if (isGraphEditor && activeTab?.fileId) {
      // Graph editor - use graph store redo
      const store = getGraphStore(activeTab.fileId);
      if (store && store.getState().canRedo) {
        store.getState().redo();
      }
    } else if (isFormEditor && redoFnRef.current) {
      // Form editor - use form redo
      console.log('EditMenu: Triggering form editor redo');
      redoFnRef.current();
    } else if (isRawView) {
      // Raw view - trigger Monaco editor's redo
      console.log('EditMenu: Triggering Monaco redo via execCommand');
      document.execCommand('redo');
    }
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
            disabled={(isGraphEditor || isFormEditor) ? !canUndo : !isRawView}
          >
            Undo
            <div className="menubar-right-slot">⌘Z</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleRedo}
            disabled={(isGraphEditor || isFormEditor) ? !canRedo : !isRawView}
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

