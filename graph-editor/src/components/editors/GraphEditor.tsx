import React, { useState, useEffect } from 'react';
import { EditorProps, GraphData } from '../../types';
import { useFileState, useTabContext } from '../../contexts/TabContext';
import { GraphStoreProvider, useGraphStore } from '../../contexts/GraphStoreContext';
import GraphCanvas from '../GraphCanvas';
import PropertiesPanel from '../PropertiesPanel';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import WhatIfAnalysisHeader from '../WhatIfAnalysisHeader';
import JsonSection from '../JsonSection';
import JsonSectionHeader from '../JsonSectionHeader';
import CollapsibleSection from '../CollapsibleSection';

/**
 * Graph Editor Inner Component
 * Assumes it's wrapped in GraphStoreProvider
 */
function GraphEditorInner({ fileId, tabId, readonly = false }: EditorProps<GraphData> & { tabId?: string }) {
  const { data, isDirty, updateData } = useFileState<GraphData>(fileId);
  const { tabs, activeTabId, operations: tabOps } = useTabContext();
  
  // Use the specific tabId passed from AppShell
  // This ensures multiple tabs of the same file have independent state
  const myTab = tabs.find(t => t.id === tabId);
  const tabState = myTab?.editorState || {};
  
  // Tab-specific state (persisted per tab, not per file!)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(tabState.selectedNodeId ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(tabState.selectedEdgeId ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(tabState.sidebarOpen ?? true);
  const [whatIfOpen, setWhatIfOpen] = useState(tabState.whatIfOpen ?? false);
  const [propertiesOpen, setPropertiesOpen] = useState(tabState.propertiesOpen ?? true);
  const [jsonOpen, setJsonOpen] = useState(tabState.jsonOpen ?? false);
  const [useUniformScaling, setUseUniformScaling] = useState(tabState.useUniformScaling ?? false);
  const [massGenerosity, setMassGenerosity] = useState(tabState.massGenerosity ?? 0.5);
  const [autoReroute, setAutoReroute] = useState(tabState.autoReroute ?? true);
  
  // Refs for GraphCanvas exposed functions
  const addNodeRef = React.useRef<(() => void) | null>(null);
  const deleteSelectedRef = React.useRef<(() => void) | null>(null);
  const autoLayoutRef = React.useRef<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>(null);
  const forceRerouteRef = React.useRef<(() => void) | null>(null);
  
  const store = useGraphStore();
  const { setGraph, graph, undo, redo, canUndo, canRedo, saveHistoryState, resetHistory } = store;

  console.log('GraphEditor render:', { 
    fileId, 
    hasData: !!data, 
    hasNodes: !!data?.nodes,
    nodeCount: data?.nodes?.length,
    isDirty,
    graphInStore: !!graph,
    graphNodeCount: graph?.nodes?.length
  });

  // Bidirectional sync with loop prevention
  const syncingRef = React.useRef(false);
  const initialHistorySavedRef = React.useRef(false);
  
  // Track data object reference to detect changes
  const prevDataRef = React.useRef(data);
  
  // Sync file data TO graph store when file changes (from JSON editor, etc.)
  useEffect(() => {
    console.log(`GraphEditor[${fileId}]: useEffect([data]) triggered`, {
      hasData: !!data,
      hasNodes: !!data?.nodes,
      nodeCount: data?.nodes?.length,
      dataRefChanged: prevDataRef.current !== data,
      syncingRef: syncingRef.current
    });
    
    prevDataRef.current = data;
    
    if (!data || !data.nodes) {
      console.log(`GraphEditor[${fileId}]: No data or nodes, skipping file→store sync`);
      return;
    }
    
    if (syncingRef.current) {
      console.log(`GraphEditor[${fileId}]: syncingRef is true, skipping to prevent loop`);
      return;
    }
    
    syncingRef.current = true;
    console.log(`GraphEditor[${fileId}]: ✅ Syncing file → store, nodeCount:`, data.nodes.length);
    setGraph(data);
    
    // Save to history
    if (!initialHistorySavedRef.current) {
      // First load - save initial state
      setTimeout(() => {
        console.log(`GraphEditor[${fileId}]: Saving initial state to history`);
        saveHistoryState();
        initialHistorySavedRef.current = true;
      }, 150);
    } else {
      // External changes after initial load (revert, JSON editor) - save to history
      setTimeout(() => {
        console.log(`GraphEditor[${fileId}]: Saving external change to history`);
        saveHistoryState();
      }, 150);
    }
    
    setTimeout(() => { 
      syncingRef.current = false;
      console.log(`GraphEditor[${fileId}]: file→store sync complete, syncingRef reset`);
    }, 100);
  }, [data, setGraph, saveHistoryState, fileId]);

  // Sync graph store changes BACK to file (from interactive edits)
  useEffect(() => {
    if (!graph || !graph.nodes) {
      console.log('GraphEditor: Store→file sync skipped (no graph or nodes)');
      return;
    }
    
    if (syncingRef.current) {
      console.log('GraphEditor: Store→file sync skipped (syncingRef is true)');
      return;
    }
    
    const graphStr = JSON.stringify(graph);
    const dataStr = data ? JSON.stringify(data) : '';
    
    if (graphStr !== dataStr) {
      syncingRef.current = true;
      console.log('GraphEditor: Syncing store → file, nodeCount:', graph.nodes.length);
      updateData(graph);
      setTimeout(() => { 
        syncingRef.current = false;
        console.log('GraphEditor: syncingRef reset');
      }, 100);
    } else {
      console.log('GraphEditor: Store→file sync skipped (data matches)');
    }
  }, [graph, data, updateData]);

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if this graph editor is the active tab
      // and user isn't typing in an input field or Monaco editor
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor')) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      // Undo: Cmd/Ctrl+Z
      if (modifier && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndo) {
          console.log('GraphEditor: Undo triggered, canUndo:', canUndo, 'historyIndex:', store.getState().historyIndex);
          // Reset sync flag before undo so the store→file sync can happen
          syncingRef.current = false;
          undo();
          // Force a full redraw to ensure edge handles are updated
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('dagnet:forceRedraw'));
          }, 10);
        }
      }

      // Redo: Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y
      if ((modifier && e.shiftKey && e.key === 'z') || (modifier && e.key === 'y')) {
        e.preventDefault();
        if (canRedo) {
          console.log('GraphEditor: Redo triggered, canRedo:', canRedo, 'historyIndex:', store.getState().historyIndex);
          // Reset sync flag before redo so the store→file sync can happen
          syncingRef.current = false;
          redo();
          // Force a full redraw to ensure edge handles are updated
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('dagnet:forceRedraw'));
          }, 10);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, canUndo, canRedo, store]);

  // Listen for menu bar commands
  useEffect(() => {
    // Broadcast current state to menu bar
    const broadcastState = () => {
      window.dispatchEvent(new CustomEvent('dagnet:graphStateUpdate', { 
        detail: { useUniformScaling, massGenerosity, autoReroute }
      }));
    };
    broadcastState();

    // Listen for menu commands
    const handleSetUniformScaling = (e: CustomEvent) => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      const newValue = e.detail.value;
      setUseUniformScaling(newValue);
      if (tabId) {
        tabOps.updateTabState(tabId, { useUniformScaling: newValue });
      }
    };

    const handleSetMassGenerosity = (e: CustomEvent) => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      const newValue = e.detail.value;
      setMassGenerosity(newValue);
      if (tabId) {
        tabOps.updateTabState(tabId, { massGenerosity: newValue });
      }
    };

    const handleSetAutoReroute = (e: CustomEvent) => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      const newValue = e.detail.value;
      setAutoReroute(newValue);
      if (tabId) {
        tabOps.updateTabState(tabId, { autoReroute: newValue });
      }
    };

    const handleAddNode = () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (addNodeRef.current) {
        addNodeRef.current();
      }
    };

    const handleDeleteSelected = () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (deleteSelectedRef.current) {
        deleteSelectedRef.current();
      }
    };

    const handleForceReroute = () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (forceRerouteRef.current) {
        forceRerouteRef.current();
      }
    };

    const handleAutoLayout = (e: CustomEvent) => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (autoLayoutRef.current && e.detail.direction) {
        autoLayoutRef.current(e.detail.direction);
      }
    };

    window.addEventListener('dagnet:setUniformScaling' as any, handleSetUniformScaling);
    window.addEventListener('dagnet:setMassGenerosity' as any, handleSetMassGenerosity);
    window.addEventListener('dagnet:setAutoReroute' as any, handleSetAutoReroute);
    window.addEventListener('dagnet:addNode' as any, handleAddNode);
    window.addEventListener('dagnet:deleteSelected' as any, handleDeleteSelected);
    window.addEventListener('dagnet:forceReroute' as any, handleForceReroute);
    window.addEventListener('dagnet:autoLayout' as any, handleAutoLayout);

    return () => {
      window.removeEventListener('dagnet:setUniformScaling' as any, handleSetUniformScaling);
      window.removeEventListener('dagnet:setMassGenerosity' as any, handleSetMassGenerosity);
      window.removeEventListener('dagnet:setAutoReroute' as any, handleSetAutoReroute);
      window.removeEventListener('dagnet:addNode' as any, handleAddNode);
      window.removeEventListener('dagnet:deleteSelected' as any, handleDeleteSelected);
      window.removeEventListener('dagnet:forceReroute' as any, handleForceReroute);
      window.removeEventListener('dagnet:autoLayout' as any, handleAutoLayout);
    };
  }, [useUniformScaling, massGenerosity, autoReroute, tabId, activeTabId]);

  if (!data) {
    console.log('GraphEditor: No data yet, showing loading...');
    return (
      <div className="editor-loading" style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        height: '100%',
        fontSize: '14px',
        color: '#666'
      }}>
        Loading graph... (fileId: {fileId})
      </div>
    );
  }

  if (!data.nodes) {
    return (
      <div className="editor-error" style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        height: '100%',
        fontSize: '14px',
        color: '#d32f2f'
      }}>
        Error: Invalid graph data
      </div>
    );
  }

  console.log('GraphEditor: About to render GraphCanvas with', data.nodes?.length, 'nodes');
  console.log('GraphEditor: Rendering with props:', {
    sidebarOpen,
    selectedNodeId,
    selectedEdgeId
  });

  return (
    <div style={{ 
      display: 'grid', 
      gridTemplateColumns: sidebarOpen ? '1fr 350px' : '1fr', 
      height: '100%',
      transition: 'grid-template-columns 0.3s ease-in-out',
      overflow: 'hidden',
      background: '#f0f0f0' // Debug: add background to see if container renders
    }}>
      {/* Main Graph Canvas */}
      <div style={{ 
        position: 'relative',
        height: '100%',
        overflow: 'hidden',
        background: '#e0e0e0' // Debug: add background to see canvas container
      }}>
        <GraphCanvas
          onSelectedNodeChange={setSelectedNodeId}
          onSelectedEdgeChange={setSelectedEdgeId}
          useUniformScaling={useUniformScaling}
          massGenerosity={massGenerosity}
          autoReroute={autoReroute}
          onAddNodeRef={addNodeRef}
          onDeleteSelectedRef={deleteSelectedRef}
          onAutoLayoutRef={autoLayoutRef}
          onForceRerouteRef={forceRerouteRef}
          whatIfAnalysis={myTab?.editorState?.whatIfAnalysis}
          caseOverrides={myTab?.editorState?.caseOverrides}
          conditionalOverrides={myTab?.editorState?.conditionalOverrides}
        />
      </div>

      {/* Right Sidebar */}
      {sidebarOpen && (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          height: '100%',
          background: '#fff',
          borderLeft: '1px solid #e9ecef',
          position: 'relative',
          overflow: 'hidden'
        }}>
          {/* Hide sidebar button */}
          <button
            onClick={() => setSidebarOpen(false)}
            style={{
              position: 'absolute',
              left: '-12px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 1000,
              width: '24px',
              height: '24px',
              background: '#fff',
              border: '1px solid #e9ecef',
              borderRadius: '50%',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#666',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            }}
            title="Hide Sidebar (Ctrl/Cmd + B)"
          >
            ◀
          </button>

          <div style={{ 
            flex: 1, 
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column'
          }}>
            {/* What-If Analysis */}
            <CollapsibleSection 
              title={<WhatIfAnalysisHeader />} 
              isOpen={whatIfOpen}
              onToggle={() => setWhatIfOpen(!whatIfOpen)}
            >
              <div style={{ padding: '16px' }}>
                <WhatIfAnalysisControl tabId={tabId} />
              </div>
            </CollapsibleSection>

            {/* Properties Panel */}
            <CollapsibleSection 
              title={
                selectedNodeId 
                  ? (() => {
                      const selectedNodes = graph?.nodes?.filter((n: any) => n.selected) || [];
                      return selectedNodes.length > 1 
                        ? `${selectedNodes.length} nodes selected`
                        : 'Node Properties';
                    })()
                  : selectedEdgeId 
                    ? 'Edge Properties'
                    : 'Graph Properties'
              } 
              isOpen={propertiesOpen}
              onToggle={() => setPropertiesOpen(!propertiesOpen)}
            >
              <PropertiesPanel 
                selectedNodeId={selectedNodeId} 
                onSelectedNodeChange={setSelectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onSelectedEdgeChange={setSelectedEdgeId}
              />
            </CollapsibleSection>

            {/* JSON Section */}
            <CollapsibleSection 
              title={<JsonSectionHeader />} 
              isOpen={jsonOpen}
              onToggle={() => setJsonOpen(!jsonOpen)}
            >
              <JsonSection />
            </CollapsibleSection>
          </div>
        </div>
      )}

      {/* Show sidebar button (when hidden) */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          style={{
            position: 'absolute',
            right: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 1000,
            width: '24px',
            height: '24px',
            background: '#fff',
            border: '1px solid #e9ecef',
            borderRadius: '50%',
            cursor: 'pointer',
            fontSize: '12px',
            color: '#666',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          }}
          title="Show Sidebar (Ctrl/Cmd + B)"
        >
          ▶
        </button>
      )}
    </div>
  );
}

/**
 * Graph Editor
 * Wraps GraphEditorInner with isolated store provider
 */
export function GraphEditor(props: EditorProps<GraphData> & { tabId?: string }) {
  return (
    <GraphStoreProvider fileId={props.fileId}>
      <GraphEditorInner {...props} />
    </GraphStoreProvider>
  );
}
