import React, { useState, useEffect, useRef } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';
import { getGraphStore } from '../../contexts/GraphStoreContext';
import { useValidationMode } from '../../contexts/ValidationContext';
import { copyVarsToClipboard } from '../../services/copyVarsService';
import toast from 'react-hot-toast';

/**
 * Edit Menu
 * 
 * Context-sensitive operations based on active editor
 * - Undo/Redo
 * - Cut/Copy/Paste
 * - Copy Vars (for graph editor with selection)
 * - Find/Replace (for raw views)
 */
export function EditMenu() {
  const { activeTabId, tabs } = useTabContext();
  const { mode: validationMode, setMode: setValidationMode } = useValidationMode();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isRawView = activeTab?.viewMode === 'raw-json' || activeTab?.viewMode === 'raw-yaml';
  const isGraphEditor = activeTab?.fileId.startsWith('graph-') && activeTab?.viewMode === 'interactive';
  const isFormEditor = (activeTab?.fileId.startsWith('parameter-') || 
                        activeTab?.fileId.startsWith('context-') || 
                        activeTab?.fileId.startsWith('case-')) && 
                       activeTab?.viewMode === 'interactive';

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

  const handleCopyVars = async () => {
    if (!isGraphEditor || !activeTab?.fileId) {
      toast.error('Copy Vars is only available in graph editor');
      return;
    }

    try {
      // Get the graph store to access current state
      const store = getGraphStore(activeTab.fileId);
      if (!store) {
        toast.error('Graph not loaded');
        return;
      }

      const state = store.getState();
      const graph = state.graph;
      
      // Query for selected nodes and edges using existing mechanism
      const detail = {
        selectedNodeUuids: [] as string[],
        selectedEdgeUuids: [] as string[]
      };
      
      // Dispatch synchronous event - GraphCanvas listener will populate detail
      window.dispatchEvent(new CustomEvent('dagnet:querySelection', { detail }));
      
      // Use the copyVarsService
      const result = await copyVarsToClipboard(
        graph,
        detail.selectedNodeUuids,
        detail.selectedEdgeUuids
      );
      
      if (result.success) {
        const parts: string[] = [];
        if (result.nodeCount > 0) {
          parts.push(`${result.nodeCount} node${result.nodeCount !== 1 ? 's' : ''}`);
        }
        if (result.edgeCount > 0) {
          parts.push(`${result.edgeCount} edge${result.edgeCount !== 1 ? 's' : ''}`);
        }
        
        toast.success(
          `Copied ${result.count} variable${result.count !== 1 ? 's' : ''} ` +
          `from ${parts.join(' and ')} to clipboard`
        );
      } else {
        toast.error(result.error || 'Failed to copy variables');
      }
    } catch (error) {
      console.error('Failed to copy vars:', error);
      toast.error('Failed to copy variables');
    }
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
            disabled={true}
          >
            Cut (coming soon)
            <div className="menubar-right-slot">⌘X</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            disabled={true}
          >
            Copy (coming soon)
            <div className="menubar-right-slot">⌘C</div>
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            disabled={true}
          >
            Paste (coming soon)
            <div className="menubar-right-slot">⌘V</div>
          </Menubar.Item>

          {isGraphEditor && (
            <>
              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                onSelect={handleCopyVars}
              >
                Copy Vars
                <div className="menubar-right-slot">⌘⇧C</div>
              </Menubar.Item>
            </>
          )}

          {isRawView && (
            <>
              <Menubar.Separator className="menubar-separator" />

              <Menubar.Item 
                className="menubar-item" 
                disabled={true}
              >
                Find (coming soon)
                <div className="menubar-right-slot">⌘F</div>
              </Menubar.Item>

              <Menubar.Item 
                className="menubar-item" 
                disabled={true}
              >
                Replace (coming soon)
                <div className="menubar-right-slot">⌘⌥F</div>
              </Menubar.Item>
            </>
          )}

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Sub>
            <Menubar.SubTrigger className="menubar-item">
              Validation Mode
              <div className="menubar-right-slot">▶</div>
            </Menubar.SubTrigger>
            <Menubar.Portal>
              <Menubar.SubContent className="menubar-content" alignOffset={-5}>
                <Menubar.RadioGroup value={validationMode} onValueChange={(value) => setValidationMode(value as any)}>
                  <Menubar.RadioItem className="menubar-item" value="warning">
                    <Menubar.ItemIndicator className="menubar-item-indicator">
                      ●
                    </Menubar.ItemIndicator>
                    Warning (Default)
                    <div className="menubar-hint" style={{ fontSize: '11px', color: '#666', marginLeft: '8px' }}>
                      Suggest registry, allow custom
                    </div>
                  </Menubar.RadioItem>
                  
                  <Menubar.RadioItem className="menubar-item" value="strict">
                    <Menubar.ItemIndicator className="menubar-item-indicator">
                      ●
                    </Menubar.ItemIndicator>
                    Strict
                    <div className="menubar-hint" style={{ fontSize: '11px', color: '#666', marginLeft: '8px' }}>
                      Require registry IDs
                    </div>
                  </Menubar.RadioItem>
                  
                  <Menubar.RadioItem className="menubar-item" value="none">
                    <Menubar.ItemIndicator className="menubar-item-indicator">
                      ●
                    </Menubar.ItemIndicator>
                    None
                    <div className="menubar-hint" style={{ fontSize: '11px', color: '#666', marginLeft: '8px' }}>
                      Free-form, no suggestions
                    </div>
                  </Menubar.RadioItem>
                </Menubar.RadioGroup>
              </Menubar.SubContent>
            </Menubar.Portal>
          </Menubar.Sub>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

