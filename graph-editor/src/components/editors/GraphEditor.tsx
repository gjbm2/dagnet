import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { EditorProps, GraphData } from '../../types';
import { useFileState, useTabContext } from '../../contexts/TabContext';
import { GraphStoreProvider, useGraphStore } from '../../contexts/GraphStoreContext';
import DockLayout, { LayoutData } from 'rc-dock';
import GraphCanvas from '../GraphCanvas';
import PropertiesPanel from '../PropertiesPanel';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import WhatIfAnalysisHeader from '../WhatIfAnalysisHeader';
import CollapsibleSection from '../CollapsibleSection';
import SidebarIconBar from '../SidebarIconBar';
import SidebarHoverPreview from '../SidebarHoverPreview';
import WhatIfPanel from '../panels/WhatIfPanel';
import PropertiesPanelWrapper from '../panels/PropertiesPanelWrapper';
import ToolsPanel from '../panels/ToolsPanel';
import { useSidebarState } from '../../hooks/useSidebarState';
import { getGraphSidebarLayout, PANEL_TO_TAB_ID } from '../../layouts/graphSidebarLayout';
import { dockGroups } from '../../layouts/defaultLayout';

// Context to share selection state with sidebar panels
interface SelectionContextType {
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
}

const SelectionContext = createContext<SelectionContextType | null>(null);

export function useSelectionContext() {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelectionContext must be used within SelectionContext.Provider');
  }
  return context;
}

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
  
  // NEW: Sidebar state management (Phase 1)
  const { state: sidebarState, operations: sidebarOps } = useSidebarState(tabId);
  const [hoveredPanel, setHoveredPanel] = useState<'what-if' | 'properties' | 'tools' | null>(null);
  
  // Tab-specific state (persisted per tab, not per file!)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(tabState.selectedNodeId ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(tabState.selectedEdgeId ?? null);
  
  // OLD sidebar state - will be deprecated after Phase 2
  // For now, sync with new sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(
    tabState.sidebarOpen ?? (sidebarState.mode === 'maximized')
  );
  const [whatIfOpen, setWhatIfOpen] = useState(tabState.whatIfOpen ?? false);
  const [propertiesOpen, setPropertiesOpen] = useState(tabState.propertiesOpen ?? true);
  
  const [useUniformScaling, setUseUniformScaling] = useState(tabState.useUniformScaling ?? false);
  const [massGenerosity, setMassGenerosity] = useState(tabState.massGenerosity ?? 0.5);
  const [autoReroute, setAutoReroute] = useState(tabState.autoReroute ?? true);
  
  // Sync old sidebar state with new sidebar mode
  useEffect(() => {
    if (sidebarState.mode === 'minimized') {
      setSidebarOpen(false);
    } else if (sidebarState.mode === 'maximized') {
      setSidebarOpen(true);
    }
  }, [sidebarState.mode]);
  
  // NEW: rc-dock layout for sidebar (Phase 2)
  const sidebarDockRef = useRef<DockLayout>(null);
  const [sidebarLayout, setSidebarLayout] = useState<LayoutData | null>(null);
  
  // Wrapped selection handlers with smart auto-open logic
  const handleNodeSelection = React.useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (nodeId) {
      // Smart auto-open: opens Properties on first selection
      sidebarOps.handleSelection();
    }
  }, [sidebarOps]);
  
  const handleEdgeSelection = React.useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    if (edgeId) {
      // Smart auto-open: opens Properties on first selection
      sidebarOps.handleSelection();
    }
  }, [sidebarOps]);
  
  // Icon bar handlers
  const handleIconClick = React.useCallback((panel: 'what-if' | 'properties' | 'tools') => {
    // Click on icon - maximize sidebar and show the panel
    sidebarOps.maximize(panel);
  }, [sidebarOps]);
  
  const handleIconHover = React.useCallback((panel: 'what-if' | 'properties' | 'tools' | null) => {
    // Hover on icon - show preview
    setHoveredPanel(panel);
  }, []);
  
  // Initialize sidebar layout (only when mode changes or layout doesn't exist)
  useEffect(() => {
    if (sidebarState.mode === 'maximized' && !sidebarLayout) {
      const layout = getGraphSidebarLayout();
      
      // Replace placeholder content with actual React components
      if (layout.dockbox.children?.[0] && 'tabs' in layout.dockbox.children[0]) {
        const panel = layout.dockbox.children[0];
        panel.tabs.forEach(tab => {
          if (tab.id === 'what-if-tab') {
            tab.content = <WhatIfPanel tabId={tabId} />;
          } else if (tab.id === 'properties-tab') {
            tab.content = (
              <PropertiesPanelWrapper tabId={tabId} />
            );
          } else if (tab.id === 'tools-tab') {
            tab.content = (
              <ToolsPanel
                onAutoLayout={(dir) => autoLayoutRef.current?.(dir || 'LR')}
                onForceReroute={() => forceRerouteRef.current?.()}
                massGenerosity={massGenerosity}
                onMassGenerosityChange={setMassGenerosity}
                useUniformScaling={useUniformScaling}
                onUniformScalingChange={setUseUniformScaling}
                onHideUnselected={() => hideUnselectedRef.current?.()}
                onShowAll={() => {/* TODO: implement showAll */}}
              />
            );
          }
        });
        
        // Set active tab based on sidebar state
        panel.activeId = PANEL_TO_TAB_ID[sidebarState.activePanel];
      }
      
      setSidebarLayout(layout);
    } else if (sidebarState.mode === 'minimized') {
      // Clear layout when minimized
      setSidebarLayout(null);
    }
  }, [sidebarState.mode, sidebarLayout, tabId, selectedNodeId, selectedEdgeId, 
      handleNodeSelection, handleEdgeSelection, massGenerosity, useUniformScaling, sidebarState.activePanel]);
  
  // Update rc-dock active tab when activePanel changes (while maximized)
  useEffect(() => {
    if (sidebarState.mode === 'maximized' && sidebarDockRef.current && sidebarLayout) {
      const targetTabId = PANEL_TO_TAB_ID[sidebarState.activePanel];
      const dockLayout = sidebarDockRef.current;
      
      // Find and activate the target tab
      if (dockLayout.getLayout) {
        const layout = dockLayout.getLayout();
        if (layout.dockbox && layout.dockbox.children) {
          layout.dockbox.children.forEach((panel: any) => {
            if (panel.tabs && panel.tabs.some((t: any) => t.id === targetTabId)) {
              panel.activeId = targetTabId;
            }
          });
          dockLayout.loadLayout(layout);
        }
      }
    }
  }, [sidebarState.activePanel, sidebarState.mode, sidebarLayout]);
  
  // Refs for GraphCanvas exposed functions
  const addNodeRef = React.useRef<(() => void) | null>(null);
  const deleteSelectedRef = React.useRef<(() => void) | null>(null);
  const autoLayoutRef = React.useRef<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>(null);
  const forceRerouteRef = React.useRef<(() => void) | null>(null);
  const hideUnselectedRef = React.useRef<(() => void) | null>(null);
  
  const store = useGraphStore();
  const { setGraph, graph, undo, redo, canUndo, canRedo, saveHistoryState, resetHistory } = store;

  console.log('GraphEditor render:', { 
    fileId, 
    hasData: !!data, 
    hasNodes: !!data?.nodes,
    nodeCount: data?.nodes?.length,
    isDirty,
    graphInStore: !!graph,
    graphNodeCount: graph?.nodes?.length,
    sidebarMode: sidebarState.mode,
    sidebarOpen,
    hoveredPanel
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

    const handleHideUnselected = () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (hideUnselectedRef.current) {
        hideUnselectedRef.current();
      }
    };

    window.addEventListener('dagnet:hideUnselected' as any, handleHideUnselected);

    return () => {
      window.removeEventListener('dagnet:setUniformScaling' as any, handleSetUniformScaling);
      window.removeEventListener('dagnet:setMassGenerosity' as any, handleSetMassGenerosity);
      window.removeEventListener('dagnet:setAutoReroute' as any, handleSetAutoReroute);
      window.removeEventListener('dagnet:addNode' as any, handleAddNode);
      window.removeEventListener('dagnet:deleteSelected' as any, handleDeleteSelected);
      window.removeEventListener('dagnet:forceReroute' as any, handleForceReroute);
      window.removeEventListener('dagnet:autoLayout' as any, handleAutoLayout);
      window.removeEventListener('dagnet:hideUnselected' as any, handleHideUnselected);
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
  console.log('GraphEditor: Rendering with state:', {
    sidebarState: sidebarState,
    sidebarOpen,
    selectedNodeId,
    selectedEdgeId,
    sidebarLayoutExists: !!sidebarLayout
  });

  const selectionContextValue: SelectionContextType = {
    selectedNodeId,
    selectedEdgeId,
    onSelectedNodeChange: handleNodeSelection,
    onSelectedEdgeChange: handleEdgeSelection
  };

  return (
    <SelectionContext.Provider value={selectionContextValue}>
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: sidebarState.mode === 'maximized' ? '1fr 300px' : sidebarState.mode === 'minimized' ? '1fr 48px' : '1fr', 
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
          onSelectedNodeChange={handleNodeSelection}
          onSelectedEdgeChange={handleEdgeSelection}
          useUniformScaling={useUniformScaling}
          massGenerosity={massGenerosity}
          autoReroute={autoReroute}
          onAddNodeRef={addNodeRef}
          onDeleteSelectedRef={deleteSelectedRef}
          onAutoLayoutRef={autoLayoutRef}
          onForceRerouteRef={forceRerouteRef}
          onHideUnselectedRef={hideUnselectedRef}
          whatIfAnalysis={myTab?.editorState?.whatIfAnalysis}
          caseOverrides={myTab?.editorState?.caseOverrides}
          conditionalOverrides={myTab?.editorState?.conditionalOverrides}
        />
      </div>

      {/* NEW: Icon Bar (Phase 1) - shown when sidebar is minimized */}
      {sidebarState.mode === 'minimized' && (
        <div style={{ 
          position: 'relative',
          height: '100%',
          width: '48px',
          background: '#F9FAFB',
          borderLeft: '1px solid #E5E7EB'
        }}>
          <SidebarIconBar
            state={sidebarState}
            onIconClick={handleIconClick}
            onIconHover={handleIconHover}
          />
          
          {/* Hover Preview - absolutely positioned to overlay canvas */}
          {hoveredPanel && (
            <div 
              style={{ position: 'absolute', top: 0, right: '48px', height: '100%', width: '300px', zIndex: 999 }}
              onMouseEnter={() => {
                console.log('[GraphEditor] Mouse entered preview');
              }}
              onMouseLeave={() => {
                console.log('[GraphEditor] Mouse left preview');
                setHoveredPanel(null);
              }}
            >
              <SidebarHoverPreview
                panel={hoveredPanel}
                tabId={tabId}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onSelectedNodeChange={handleNodeSelection}
                onSelectedEdgeChange={handleEdgeSelection}
                massGenerosity={massGenerosity}
                onMassGenerosityChange={setMassGenerosity}
                useUniformScaling={useUniformScaling}
                onUniformScalingChange={setUseUniformScaling}
                onAutoLayout={() => autoLayoutRef.current?.('LR')}
                onForceReroute={() => forceRerouteRef.current?.()}
                onHideUnselected={() => hideUnselectedRef.current?.()}
                onShowAll={() => {/* TODO: implement showAll */}}
              />
            </div>
          )}
        </div>
      )}

      {/* NEW: rc-dock Sidebar (Phase 2) - shown when maximized */}
      {sidebarState.mode === 'maximized' && sidebarLayout && (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          height: '100%',
          background: '#fff',
          borderLeft: '1px solid #e9ecef',
          position: 'relative',
          overflow: 'hidden'
        }}>
          {/* Minimize sidebar button */}
          <button
            onClick={() => sidebarOps.minimize()}
            style={{
              position: 'absolute',
              left: '-16px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 1000,
              width: '32px',
              height: '48px',
              background: '#3B82F6',
              border: '2px solid #fff',
              borderRadius: '8px 0 0 8px',
              cursor: 'pointer',
              fontSize: '16px',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.15)',
              transition: 'background-color 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#2563EB';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#3B82F6';
            }}
            title="Minimize Sidebar (Ctrl/Cmd + B)"
          >
            ◀
          </button>

          {/* rc-dock layout for sidebar panels */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <DockLayout
              ref={sidebarDockRef}
              defaultLayout={sidebarLayout}
              groups={dockGroups}
              style={{ width: '100%', height: '100%' }}
            />
          </div>
        </div>
      )}
      
      </div>
    </SelectionContext.Provider>
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
