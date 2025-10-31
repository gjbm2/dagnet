import React, { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { EditorProps, GraphData } from '../../types';
import { useFileState, useTabContext } from '../../contexts/TabContext';
import { GraphStoreProvider, useGraphStore } from '../../contexts/GraphStoreContext';
import DockLayout, { LayoutData } from 'rc-dock';
import './GraphEditor.css';
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
import { getGraphEditorLayout, getGraphEditorLayoutMinimized, PANEL_TO_TAB_ID } from '../../layouts/graphSidebarLayout';
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
  const [whatIfOpen, setWhatIfOpen] = useState(tabState.whatIfOpen ?? false);
  const [propertiesOpen, setPropertiesOpen] = useState(tabState.propertiesOpen ?? true);
  
  const [useUniformScaling, setUseUniformScaling] = useState(tabState.useUniformScaling ?? false);
  const [massGenerosity, setMassGenerosity] = useState(tabState.massGenerosity ?? 0.5);
  const [autoReroute, setAutoReroute] = useState(tabState.autoReroute ?? true);
  
  // NEW: rc-dock layout for entire graph editor (Phase 2)
  const dockRef = useRef<DockLayout>(null);
  const [dockLayout, setDockLayout] = useState<LayoutData | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(300); // Track sidebar width for minimize button positioning
  const sidebarResizeObserverRef = useRef<ResizeObserver | null>(null);
  
  // Wrapped selection handlers with smart auto-open logic
  const prevSelectedNodeRef = useRef<string | null>(null);
  const prevSelectedEdgeRef = useRef<string | null>(null);
  
  const handleNodeSelection = React.useCallback((nodeId: string | null) => {
    const changed = prevSelectedNodeRef.current !== nodeId;
    setSelectedNodeId(nodeId);
    if (nodeId && changed) {
      // Smart auto-open: opens Properties on first selection (only when selection changes)
      sidebarOps.handleSelection();
    }
    prevSelectedNodeRef.current = nodeId;
  }, [sidebarOps]);
  
  const handleEdgeSelection = React.useCallback((edgeId: string | null) => {
    const changed = prevSelectedEdgeRef.current !== edgeId;
    setSelectedEdgeId(edgeId);
    if (edgeId && changed) {
      // Smart auto-open: opens Properties on first selection (only when selection changes)
      sidebarOps.handleSelection();
    }
    prevSelectedEdgeRef.current = edgeId;
  }, [sidebarOps]);
  
  // Icon bar handlers
  const handleIconClick = React.useCallback((panel: 'what-if' | 'properties' | 'tools') => {
    // Click on icon - just update state, let the effect handle the layout
    sidebarOps.maximize(panel);
  }, [sidebarOps]);
  
  const handleIconHover = React.useCallback((panel: 'what-if' | 'properties' | 'tools' | null) => {
    // Hover on icon - show preview (only when minimized)
    if (sidebarState.mode === 'minimized') {
      setHoveredPanel(panel);
    }
  }, [sidebarState.mode]);
  
  // Clear hover preview when sidebar maximizes
  useEffect(() => {
    if (sidebarState.mode === 'maximized') {
      setHoveredPanel(null);
    }
  }, [sidebarState.mode]);
  
  // Setup ResizeObserver to track sidebar width in real-time during drag
  useEffect(() => {
    // Cleanup existing observer
    if (sidebarResizeObserverRef.current) {
      sidebarResizeObserverRef.current.disconnect();
      sidebarResizeObserverRef.current = null;
    }
    
    if (sidebarState.mode === 'maximized') {
      // Wait for DOM to be ready
      setTimeout(() => {
        const sidebarPanelElement = document.querySelector('[data-dockid="graph-sidebar-panel"]');
        if (sidebarPanelElement) {
          // Create ResizeObserver to track width changes in real-time
          sidebarResizeObserverRef.current = new ResizeObserver((entries) => {
            for (const entry of entries) {
              const width = entry.contentRect.width;
              setSidebarWidth(width);
            }
          });
          
          sidebarResizeObserverRef.current.observe(sidebarPanelElement);
        }
      }, 100); // Small delay to ensure DOM is ready
    }
    
    // Cleanup on unmount or mode change
    return () => {
      if (sidebarResizeObserverRef.current) {
        sidebarResizeObserverRef.current.disconnect();
        sidebarResizeObserverRef.current = null;
      }
    };
  }, [sidebarState.mode, dockLayout]);
  
  // Helper function to create layout with proper content injection
  const createLayoutWithContent = useCallback((mode: 'minimized' | 'maximized') => {
    const layout = mode === 'maximized' 
      ? getGraphEditorLayout() 
      : getGraphEditorLayoutMinimized();
    
    // Inject GraphCanvas into canvas tab
    if (layout.dockbox.children?.[0] && 'tabs' in layout.dockbox.children[0]) {
      const canvasPanel = layout.dockbox.children[0];
      const canvasTab = canvasPanel.tabs.find(t => t.id === 'canvas-tab');
      if (canvasTab) {
        canvasTab.content = (
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
        );
      }
    }
    
    // Inject sidebar panels if maximized
    if (mode === 'maximized' && layout.dockbox.children?.[1] && 'tabs' in layout.dockbox.children[1]) {
      const sidebarPanel = layout.dockbox.children[1];
      sidebarPanel.tabs.forEach(tab => {
        if (tab.id === 'what-if-tab') {
          tab.content = <WhatIfPanel tabId={tabId} />;
        } else if (tab.id === 'properties-tab') {
          tab.content = <PropertiesPanelWrapper tabId={tabId} />;
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
      sidebarPanel.activeId = PANEL_TO_TAB_ID[sidebarState.activePanel];
    }
    
    return layout;
  }, [tabId, massGenerosity, useUniformScaling, autoReroute, 
      sidebarState.activePanel, myTab?.editorState, handleNodeSelection, handleEdgeSelection]);
  
  // Initialize dock layout (only on mount)
  useEffect(() => {
    // Only initialize if we don't have a layout yet
    if (dockLayout) return;
    
    const layout = createLayoutWithContent(sidebarState.mode);
    setDockLayout(layout);
  }, [dockLayout, sidebarState.mode, createLayoutWithContent]);
  
  // Track previous mode to detect changes
  const prevModeRef = useRef<'minimized' | 'maximized'>(sidebarState.mode);
  const pendingLayoutRef = useRef<LayoutData | null>(null);
  
  // Update layout state when mode changes (triggers re-render with new defaultLayout)
  useEffect(() => {
    if (!dockLayout) {
      // Initialize prevModeRef when layout is first created
      if (prevModeRef.current !== sidebarState.mode) {
        prevModeRef.current = sidebarState.mode;
      }
      return;
    }
    
    // Only update if mode actually changed
    if (prevModeRef.current === sidebarState.mode) return;
    
    console.log('[GraphEditor] Sidebar mode changed:', prevModeRef.current, '->', sidebarState.mode);
    
    // Update prevModeRef FIRST to prevent re-running when state updates
    prevModeRef.current = sidebarState.mode;
    
    // Create new layout
    const layout = createLayoutWithContent(sidebarState.mode);
    
    // If dockRef exists, preserve floating tabs
    if (dockRef.current) {
      const currentLayout = dockRef.current.getLayout();
      if (currentLayout?.floatbox && currentLayout.floatbox.children && currentLayout.floatbox.children.length > 0) {
        layout.floatbox = currentLayout.floatbox as any;
      }
    }
    
    // Store pending layout and update state (this triggers re-render)
    pendingLayoutRef.current = layout;
    setDockLayout(layout);
    
    // Apply layout to rc-dock after state update completes
    requestAnimationFrame(() => {
      if (pendingLayoutRef.current && dockRef.current) {
        console.log('[GraphEditor] Applying layout update to rc-dock');
        dockRef.current.loadLayout(pendingLayoutRef.current);
        pendingLayoutRef.current = null;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarState.mode, dockLayout]);
  
  // Update rc-dock active tab when activePanel changes (while maximized)
  useEffect(() => {
    if (sidebarState.mode === 'maximized' && dockRef.current && dockLayout) {
      const targetTabId = PANEL_TO_TAB_ID[sidebarState.activePanel];
      const dock = dockRef.current;
      
      // Find and activate the target tab in sidebar panel
      if (dock.getLayout) {
        const layout = dock.getLayout();
        if (layout.dockbox && layout.dockbox.children) {
          // Find sidebar panel (second child) and set active tab
          layout.dockbox.children.forEach((panel: any) => {
            if (panel.tabs && panel.tabs.some((t: any) => t.id === targetTabId)) {
              panel.activeId = targetTabId;
            }
          });
          dock.loadLayout(layout);
        }
      }
    }
  }, [sidebarState.activePanel, sidebarState.mode, dockLayout]);
  
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
    selectedNodeId,
    selectedEdgeId,
    dockLayoutExists: !!dockLayout
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
        position: 'relative',
        height: '100%',
        width: '100%',
        overflow: 'hidden'
      }}>
        {/* Main DockLayout - spans entire graph editor */}
        {dockLayout && (
          <DockLayout
            ref={dockRef}
            defaultLayout={dockLayout}
            groups={dockGroups as any}
            style={{ width: '100%', height: '100%' }}
            onLayoutChange={(newLayout) => {
              // Track which panels are floating
              const floatingTabIds = newLayout.floatbox?.children?.map((box: any) => {
                return box.tabs?.map((tab: any) => tab.id) || [];
              }).flat() || [];
              
              console.log('Layout changed. Floating tabs:', floatingTabIds);
              
              // Check if sidebar tabs were closed
              const allTabIds = new Set<string>();
              const collectTabs = (node: any) => {
                if (node.tabs) {
                  node.tabs.forEach((tab: any) => allTabIds.add(tab.id));
                }
                if (node.children) {
                  node.children.forEach(collectTabs);
                }
              };
              
              if (newLayout.dockbox) collectTabs(newLayout.dockbox);
              if (newLayout.floatbox) collectTabs(newLayout.floatbox);
              
              console.log('All visible tabs:', Array.from(allTabIds));
              
              // If sidebar tabs are closed (not just floating), restore them to dock
              const expectedSidebarTabs = ['what-if-tab', 'properties-tab', 'tools-tab'];
              const missingSidebarTabs = expectedSidebarTabs.filter(id => !allTabIds.has(id));
              
              if (missingSidebarTabs.length > 0) {
                console.log('Sidebar tabs missing (closed):', missingSidebarTabs);
                
                // If in maximized mode, restore missing tabs to sidebar dock
                if (sidebarState.mode === 'maximized' && dockRef.current) {
                  console.log('Restoring closed tabs to sidebar dock');
                  
                  // For each missing tab, restore it by reloading with full layout
                  setTimeout(() => {
                    if (dockRef.current) {
                      const layout = getGraphEditorLayout();
                      
                      // Inject canvas
                      if (layout.dockbox.children?.[0] && 'tabs' in layout.dockbox.children[0]) {
                        const canvasPanel = layout.dockbox.children[0];
                        const canvasTab = canvasPanel.tabs.find(t => t.id === 'canvas-tab');
                        if (canvasTab) {
                          canvasTab.content = (
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
                          );
                        }
                      }
                      
                      // Inject sidebar panels
                      if (layout.dockbox.children?.[1] && 'tabs' in layout.dockbox.children[1]) {
                        const sidebarPanel = layout.dockbox.children[1];
                        sidebarPanel.tabs.forEach(tab => {
                          if (tab.id === 'what-if-tab') {
                            tab.content = <WhatIfPanel tabId={tabId} />;
                          } else if (tab.id === 'properties-tab') {
                            tab.content = <PropertiesPanelWrapper tabId={tabId} />;
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
                        
                        // Keep active tab
                        sidebarPanel.activeId = PANEL_TO_TAB_ID[sidebarState.activePanel];
                      }
                      
                      // Preserve any remaining floating tabs (cast to avoid type errors)
                      if (newLayout.floatbox && newLayout.floatbox.children && newLayout.floatbox.children.length > 0) {
                        layout.floatbox = newLayout.floatbox as any;
                      }
                      
                      dockRef.current.loadLayout(layout);
                    }
                  }, 0);
                }
              }
            }}
          />
        )}

        {/* Icon Bar - absolutely positioned on right edge when minimized */}
        {sidebarState.mode === 'minimized' && (
          <div style={{ 
            position: 'absolute',
            top: 0,
            right: 0,
            height: '100%',
            width: '48px',
            background: '#F9FAFB',
            borderLeft: '1px solid #E5E7EB',
            zIndex: 100
          }}>
            <SidebarIconBar
              state={sidebarState}
              onIconClick={handleIconClick}
              onIconHover={handleIconHover}
            />
          </div>
        )}
        
        {/* Hover Preview - absolutely positioned adjacent to icon bar */}
        {sidebarState.mode === 'minimized' && hoveredPanel && (
          <div 
            style={{ 
              position: 'absolute', 
              top: 0, 
              right: '48px', // Immediately adjacent to icon bar (no gap)
              height: '100%', 
              width: '300px', 
              zIndex: 150 
            }}
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

        {/* Minimize Button - absolutely positioned when sidebar is maximized */}
        {sidebarState.mode === 'maximized' && (
          <button
            onClick={() => sidebarOps.minimize()}
            className="graph-minimize-button"
            style={{
              position: 'absolute',
              right: `${sidebarWidth - 6}px`, // Sidebar width minus button overlap
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 200,
              width: '20px',
              height: '60px',
              border: '1px solid #dee2e6',
              borderRight: 'none',
              borderRadius: '4px 0 0 4px',
              cursor: 'pointer',
              fontSize: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s ease',
              padding: 0,
            }}
            title="Minimize Sidebar (Ctrl/Cmd + B)"
        >
          ▶
        </button>
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
