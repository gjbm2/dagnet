import React, { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react';
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
import { WhatIfProvider, useWhatIfContext } from '../../contexts/WhatIfContext';

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
  // Local What-If state for immediate UI response (persisted to tab state asynchronously)
  const [whatIfLocal, setWhatIfLocal] = useState({
    whatIfAnalysis: tabState.whatIfAnalysis,
    caseOverrides: tabState.caseOverrides as Record<string, string> | undefined,
    conditionalOverrides: tabState.conditionalOverrides as Record<string, Set<string>> | undefined,
  });

  // Keep local What-If state in sync if tab editorState changes externally (avoid loops)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#1: Sync What-If state from tab`);
    setWhatIfLocal(prev => {
      const same = prev.whatIfAnalysis === tabState.whatIfAnalysis &&
        JSON.stringify(prev.caseOverrides || {}) === JSON.stringify((tabState.caseOverrides as any) || {}) &&
        JSON.stringify(Object.fromEntries(Object.entries((tabState.conditionalOverrides as any) || {}).map(([k, v]) => [k, Array.from(v as Set<string>)]))) ===
        JSON.stringify(Object.fromEntries(Object.entries((prev.conditionalOverrides || {})).map(([k, v]) => [k, Array.from(v as Set<string>)])));
      if (same) {
        console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#1: No change, skipping`);
        return prev;
      }
      console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#1: Updating What-If local state`);
      return {
        whatIfAnalysis: tabState.whatIfAnalysis,
        caseOverrides: tabState.caseOverrides as any,
        conditionalOverrides: tabState.conditionalOverrides as any,
      };
    });
  }, [tabState.whatIfAnalysis, tabState.caseOverrides, tabState.conditionalOverrides]);

  // Debounced persist helper (disabled for What-If; ephemeral per design)
  const PERSIST_WHATIF = false;
  const persistTimerRef = useRef<number | null>(null);
  const schedulePersist = useCallback((next: typeof whatIfLocal) => {
    if (!PERSIST_WHATIF) return; // Disable persistence to avoid app-wide rerenders
    if (!tabId) return;
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      // Convert Sets in conditionalOverrides to Arrays
      const serialized: any = {
        whatIfAnalysis: next.whatIfAnalysis ?? null,
        caseOverrides: next.caseOverrides || {},
        conditionalOverrides: next.conditionalOverrides || {},
      };
      tabOps.updateTabState(tabId, serialized);
      persistTimerRef.current = null;
    }, 0);
  }, [tabId, tabOps]);

  
  // NEW: Sidebar state management (Phase 1)
  const { state: sidebarState, operations: sidebarOps } = useSidebarState(tabId);
  const [hoveredPanel, setHoveredPanel] = useState<'what-if' | 'properties' | 'tools' | null>(null);
  const hoverLeaveTimerRef = useRef<number | null>(null);
  const [isHoverLocked, setIsHoverLocked] = useState(false);
  const suspendLayoutUntilRef = useRef<number>(0);
  // const [usePlainWhatIfOverlay, setUsePlainWhatIfOverlay] = useState(false);
  
  // Tab-specific state (persisted per tab, not per file!)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(tabState.selectedNodeId ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(tabState.selectedEdgeId ?? null);
  
  // OLD sidebar state - will be deprecated after Phase 2
  const [whatIfOpen, setWhatIfOpen] = useState(tabState.whatIfOpen ?? false);
  const [propertiesOpen, setPropertiesOpen] = useState(tabState.propertiesOpen ?? true);
  
  const [useUniformScaling, setUseUniformScaling] = useState(tabState.useUniformScaling ?? false);
  const [massGenerosity, setMassGenerosity] = useState(tabState.massGenerosity ?? 0.5);
  const [autoReroute, setAutoReroute] = useState(tabState.autoReroute ?? true);
  
  // Refs for GraphCanvas exposed functions (must be declared before component creation)
  const addNodeRef = React.useRef<(() => void) | null>(null);
  const deleteSelectedRef = React.useRef<(() => void) | null>(null);
  const autoLayoutRef = React.useRef<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>(null);
  const forceRerouteRef = React.useRef<(() => void) | null>(null);
  const hideUnselectedRef = React.useRef<(() => void) | null>(null);
  
  // NEW: rc-dock layout for entire graph editor (Phase 2)
  const dockRef = useRef<DockLayout>(null);
  const containerRef = useRef<HTMLDivElement>(null); // Ref to THIS tab's container
  const [dockLayout, setDockLayout] = useState<LayoutData | null>(null);
  const sidebarResizeObserverRef = useRef<ResizeObserver | null>(null);
  const containerResizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastSidebarWidthRef = useRef<number>(-1);
  const sidebarWidthRafRef = useRef<number | null>(null);
  
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
    console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover called: panel=${panel}, mode=${sidebarState.mode}, isHoverLocked=${isHoverLocked}`);
    if (sidebarState.mode !== 'minimized') {
      console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover blocked: not minimized`);
      return;
    }
    if (isHoverLocked) {
      console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover blocked: hover locked`);
      return;
    }
    if (panel) {
      // Cancel pending close and show immediately
      if (hoverLeaveTimerRef.current) {
        console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover: Canceling pending close timer`);
        window.clearTimeout(hoverLeaveTimerRef.current);
        hoverLeaveTimerRef.current = null;
      }
      console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover: Setting hoveredPanel to ${panel}`);
      setHoveredPanel(panel);
    } else {
      // Schedule close, can be cancelled by preview mouse enter
      if (hoverLeaveTimerRef.current) {
        window.clearTimeout(hoverLeaveTimerRef.current);
      }
      console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover: Scheduling close in 180ms`);
      hoverLeaveTimerRef.current = window.setTimeout(() => {
        if (!isHoverLocked) {
          console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover: Timer fired, clearing hoveredPanel`);
          setHoveredPanel(null);
        } else {
          console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover: Timer fired but hover locked, not clearing`);
        }
        hoverLeaveTimerRef.current = null;
      }, 180);
    }
  }, [sidebarState.mode, isHoverLocked]);
  
  // Clear hover preview when sidebar maximizes
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#2: Clear hover on maximize (mode=${sidebarState.mode})`);
    if (sidebarState.mode === 'maximized') {
      setHoveredPanel(null);
      if (hoverLeaveTimerRef.current) {
        window.clearTimeout(hoverLeaveTimerRef.current);
        hoverLeaveTimerRef.current = null;
      }
    }
  }, [sidebarState.mode]);

  // Listen for temporary layout suspension requests (to avoid flicker during interactions)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#3: Setup dagnet:suspendLayout listener`);
    const handler = (e: any) => {
      console.log(`[${new Date().toISOString()}] [GraphEditor] EVENT: dagnet:suspendLayout received`, e?.detail);
      const ms = e?.detail?.ms ?? 600;
      suspendLayoutUntilRef.current = Date.now() + ms;
      // Lock hover during suspension, but automatically unlock after suspension ends
      setIsHoverLocked(true);
      setTimeout(() => {
        console.log(`[${new Date().toISOString()}] [GraphEditor] Suspension period ended, unlocking hover`);
        setIsHoverLocked(false);
      }, ms);
    };
    window.addEventListener('dagnet:suspendLayout' as any, handler);
    return () => window.removeEventListener('dagnet:suspendLayout' as any, handler);
  }, []);
  // Listen for explicit request to open a sidebar panel (pin open, no hover)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#4: Setup dagnet:openSidebarPanel listener`);
    const handler = (e: any) => {
      console.log(`[${new Date().toISOString()}] [GraphEditor] EVENT: dagnet:openSidebarPanel received`, e?.detail);
      const panel = e?.detail?.panel as ('what-if' | 'properties' | 'tools') | undefined;
      setHoveredPanel(null);
      sidebarOps.maximize(panel || 'what-if');
    };
    window.addEventListener('dagnet:openSidebarPanel' as any, handler);
    return () => window.removeEventListener('dagnet:openSidebarPanel' as any, handler);
  }, [sidebarOps]);
  
  // Removed: usePlainWhatIf overlay handler (hover preview deprecated)
  
  // DIAGNOSTIC: Log close button DOM structure for issue #5
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#5: DIAGNOSTIC close button check (mode=${sidebarState.mode})`);
    if (sidebarState.mode === 'maximized' && containerRef.current) {
      setTimeout(() => {
        console.log(`[GraphEditor ${fileId}] DIAGNOSTIC: Checking close button structure`);
        
        // Find ALL close buttons in this container
        const allCloseButtons = containerRef.current!.querySelectorAll('.dock-tab-close-btn');
        console.log(`[GraphEditor ${fileId}] Found ${allCloseButtons.length} total close buttons in container`);
        
        allCloseButtons.forEach((btn, idx) => {
          const tab = btn.closest('.dock-tab');
          const panel = btn.closest('.dock-panel');
          const isInSidebar = panel?.getAttribute('data-panel-id') === 'graph-sidebar-panel';
          
          console.log(`[GraphEditor ${fileId}] Close button ${idx}:`, {
            element: btn,
            parentTab: tab,
            parentPanel: panel,
            panelId: panel?.getAttribute('data-panel-id'),
            panelDataset: (panel as HTMLElement)?.dataset,
            tabNodeKey: (tab as HTMLElement)?.getAttribute('data-node-key'),
            isInSidebar,
            isVisible: btn.checkVisibility?.() ?? 'unknown',
            computedDisplay: window.getComputedStyle(btn as Element).display,
            computedVisibility: window.getComputedStyle(btn as Element).visibility
          });
        });
        
        // Also check what panels exist
        const panels = containerRef.current!.querySelectorAll('.dock-panel');
        console.log(`[GraphEditor ${fileId}] Found ${panels.length} panels:`, 
          Array.from(panels).map(p => ({
            id: p.getAttribute('data-panel-id'),
            dataset: (p as HTMLElement).dataset
          }))
        );
      }, 200);
    }
  }, [sidebarState.mode, dockLayout, fileId]);
  
  // Detect resize start/end to hide minimize button during resize
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#6: Setup resize detection listeners`);
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('dock-splitter')) {
        console.log(`[${new Date().toISOString()}] [GraphEditor] Resize started - hiding minimize button`);
        sidebarOps.setIsResizing(true);
      }
    };
    
    const handleMouseUp = () => {
      if (sidebarState.isResizing) {
        console.log(`[${new Date().toISOString()}] [GraphEditor] Resize ended - showing minimize button`);
        sidebarOps.setIsResizing(false);
      }
    };
    
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [sidebarState.isResizing, sidebarOps]);
  
  // Container resize observer - maintains sidebar absolute pixel width when container resizes
  const lastContainerWidthRef = useRef<number>(0);
  const isAdjustingLayoutRef = useRef<boolean>(false);
  // containerResizeObserverRef already declared at top of component
  
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#6b: Setup container ResizeObserver (mode=${sidebarState.mode})`);
    
    // Cleanup existing observer
    if (containerResizeObserverRef.current) {
      containerResizeObserverRef.current.disconnect();
      containerResizeObserverRef.current = null;
    }
    
    if (sidebarState.mode === 'maximized' && containerRef.current) {
      const container = containerRef.current;
      
      // Capture initial container width
      const initialWidth = Math.round(container.getBoundingClientRect().width);
      lastContainerWidthRef.current = initialWidth;
      console.log(`[${new Date().toISOString()}] [GraphEditor] Container observer: Initial container width = ${initialWidth}px`);
      
      // Observe the container - when it resizes, recalculate layout to maintain sidebar width
      containerResizeObserverRef.current = new ResizeObserver((entries) => {
        // Skip if we're already adjusting to prevent circular loop
        if (isAdjustingLayoutRef.current) {
          return;
        }
        
        const newContainerWidth = Math.round(container.getBoundingClientRect().width);
        
        // Only react to significant changes (> 10px) to avoid noise
        const widthDelta = Math.abs(newContainerWidth - lastContainerWidthRef.current);
        if (widthDelta < 10) {
          return;
        }
        
        console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 Container resized: ${lastContainerWidthRef.current}px → ${newContainerWidth}px`);
        
        // Get the stored sidebar width (the width we want to maintain)
        const targetSidebarWidth = sidebarState.sidebarWidth || 300;
        
        // Back-calculate flex weights to maintain the TARGET width in the new container
        const canvasFlexWeight = newContainerWidth - targetSidebarWidth;
        const sidebarFlexWeight = targetSidebarWidth;
        
        console.log(`[${new Date().toISOString()}] [GraphEditor] Adjusting flex to maintain ${targetSidebarWidth}px: canvas=${canvasFlexWeight}, sidebar=${sidebarFlexWeight}`);
        
        if (dockRef.current && canvasFlexWeight > 0 && sidebarFlexWeight > 0) {
          // Set flag BEFORE any changes
          isAdjustingLayoutRef.current = true;
          
          // Update layout with new flex weights
          const currentLayout = dockRef.current.getLayout();
          if (currentLayout?.dockbox?.children) {
            const mainBox = currentLayout.dockbox.children.find((child: any) => child.mode === 'horizontal');
            if (mainBox && mainBox.children && mainBox.children.length >= 2) {
              mainBox.children[0].size = canvasFlexWeight;
              mainBox.children[1].size = sidebarFlexWeight;
              dockRef.current.loadLayout(currentLayout);
            }
          }
          
          // Update last container width AFTER successful layout update
          lastContainerWidthRef.current = newContainerWidth;
          
          // Reset flag after delay (long enough for sidebar observer to skip)
          setTimeout(() => {
            isAdjustingLayoutRef.current = false;
          }, 200);
        }
      });
      
      containerResizeObserverRef.current.observe(container);
      console.log(`[${new Date().toISOString()}] [GraphEditor] Container ResizeObserver attached`);
    }
    
    return () => {
      if (containerResizeObserverRef.current) {
        containerResizeObserverRef.current.disconnect();
        containerResizeObserverRef.current = null;
      }
    };
  }, [sidebarState.mode, fileId]); // Removed sidebarOps to prevent loop
  
  // Setup ResizeObserver to track sidebar width in real-time during drag
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#7: Setup ResizeObserver (mode=${sidebarState.mode})`);
    
    // Cleanup existing observer
    if (sidebarResizeObserverRef.current) {
      sidebarResizeObserverRef.current.disconnect();
      sidebarResizeObserverRef.current = null;
    }
    
    if (sidebarState.mode === 'maximized') {
      // Wait for DOM to be ready
      setTimeout(() => {
        // CRITICAL: Query within THIS tab's container, not the entire document
        if (!containerRef.current) {
          console.error('[GraphEditor] ResizeObserver: containerRef not available');
          return;
        }
        
        // Find the OFFICIAL sidebar panel - must be the second child of the main horizontal box
        // and must contain all three sidebar tabs (what-if, properties, tools)
        let sidebarPanelElement: HTMLElement | null = null;
        
        // Find the main dockbox's horizontal container
        const mainHbox = containerRef.current.querySelector('.dock-box.dock-hbox');
        if (mainHbox) {
          // The sidebar should be the second panel child in this hbox
          const panels = mainHbox.querySelectorAll(':scope > .dock-panel');
          if (panels.length >= 2) {
            const potentialSidebar = panels[1] as HTMLElement;
            
            // Verify it has all three sidebar tabs
            const hasWhatIf = potentialSidebar.querySelector('[data-node-key="what-if-tab"]');
            const hasProps = potentialSidebar.querySelector('[data-node-key="properties-tab"]');
            const hasTools = potentialSidebar.querySelector('[data-node-key="tools-tab"]');
            
            if (hasWhatIf || hasProps || hasTools) {
              sidebarPanelElement = potentialSidebar;
              console.log(`[GraphEditor ${fileId}] Found official sidebar panel (second child of hbox)`);
            }
          }
        }
        
        if (sidebarPanelElement) {
          // Set initial width immediately
          const rect = sidebarPanelElement.getBoundingClientRect();
          const width = Math.round(rect.width);
          console.log(`[GraphEditor ${fileId}] ResizeObserver: Initial sidebar width:`, width);
          lastSidebarWidthRef.current = width;
          sidebarOps.setSidebarWidth(width);
          
          // Create ResizeObserver to track width changes in real-time
          sidebarResizeObserverRef.current = new ResizeObserver(() => {
            const t0 = performance.now();
            console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver callback fired (t0=${t0.toFixed(2)}ms)`);
            // Skip if we're in the middle of a layout adjustment to prevent circular loop
            if (isAdjustingLayoutRef.current) {
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] ResizeObserver: Skipping (layout adjustment in progress)`);
              return;
            }
            
            const newRect = sidebarPanelElement.getBoundingClientRect();
            const t1 = performance.now();
            const newWidth = Math.round(newRect.width);
            console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver: getBoundingClientRect took ${(t1-t0).toFixed(2)}ms, newWidth=${newWidth}, last=${lastSidebarWidthRef.current}`);
            if (newWidth === lastSidebarWidthRef.current) {
              console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver: Width unchanged, skipping RAF`);
              return;
            }
            lastSidebarWidthRef.current = newWidth;
            if (sidebarWidthRafRef.current) {
              console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver: Canceling previous RAF`);
              cancelAnimationFrame(sidebarWidthRafRef.current);
            }
            sidebarWidthRafRef.current = requestAnimationFrame(() => {
              const t2 = performance.now();
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] 🔍 ResizeObserver: RAF executing (scheduled ${(t2-t0).toFixed(2)}ms ago) - setting sidebar width to ${newWidth}`);
              sidebarOps.setSidebarWidth(newWidth);
              sidebarWidthRafRef.current = null;
              const t3 = performance.now();
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] 🔍 ResizeObserver: RAF completed in ${(t3-t2).toFixed(2)}ms`);
            });
          });
          
          sidebarResizeObserverRef.current.observe(sidebarPanelElement);
        } else {
          console.error(`[GraphEditor ${fileId}] ResizeObserver: Could not find sidebar panel in this container`);
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
  }, [sidebarState.mode, dockLayout, sidebarOps, fileId]);
  
  // DIAGNOSTIC: Log What-If state changes
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#8: What-If state diagnostic`, {
      whatIfAnalysis: myTab?.editorState?.whatIfAnalysis,
      caseOverrides: myTab?.editorState?.caseOverrides,
      conditionalOverrides: myTab?.editorState?.conditionalOverrides
    });
  }, [myTab?.editorState?.whatIfAnalysis, myTab?.editorState?.caseOverrides, myTab?.editorState?.conditionalOverrides, fileId]);
  
  // Canvas component - NOT memoized so it updates when What-If state changes
  const CanvasHost: React.FC = () => {
    const whatIf = useWhatIfContext();
    return (
      <GraphCanvas
        tabId={tabId}
        activeTabId={activeTabId}
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
        whatIfAnalysis={whatIf?.whatIfAnalysis}
        caseOverrides={whatIf?.caseOverrides}
        conditionalOverrides={whatIf?.conditionalOverrides}
      />
    );
  };
  const canvasComponent = (<CanvasHost />);
  
  const whatIfComponent = useMemo(() => <WhatIfPanel tabId={tabId} />, [tabId]);
  
  const propertiesComponent = useMemo(() => <PropertiesPanelWrapper tabId={tabId} />, [tabId]);
  
  const toolsComponent = useMemo(() => (
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
  ), [massGenerosity, useUniformScaling]);
  
  // Helper function to create layout structure (uses stable components)
  const createLayoutStructure = useCallback((mode: 'minimized' | 'maximized') => {
    const layout = mode === 'maximized' 
      ? getGraphEditorLayout() 
      : getGraphEditorLayoutMinimized();
    
    // Back-calculate flex weights based on desired pixel widths
    if (containerRef.current && mode === 'maximized') {
      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const desiredSidebarWidth = sidebarState.sidebarWidth ?? 300;
      
      // Calculate flex weights to achieve absolute pixel widths
      const canvasWidth = containerWidth - desiredSidebarWidth;
      
      console.log(`[GraphEditor ${fileId}] Back-calculating flex weights:`, {
        containerWidth,
        desiredSidebarWidth,
        canvasWidth,
        canvasWeight: canvasWidth,
        sidebarWeight: desiredSidebarWidth
      });
      
      // Apply calculated weights
      if (layout.dockbox.children?.[0]) {
        layout.dockbox.children[0].size = canvasWidth;
      }
      if (layout.dockbox.children?.[1]) {
        layout.dockbox.children[1].size = desiredSidebarWidth;
      }
    }
    
    // Inject stable canvas component
    if (layout.dockbox.children?.[0] && 'tabs' in layout.dockbox.children[0]) {
      const canvasPanel = layout.dockbox.children[0];
      const canvasTab = canvasPanel.tabs.find(t => t.id === 'canvas-tab');
      if (canvasTab) {
        canvasTab.content = canvasComponent;
      }
    }
    
    // Inject stable sidebar panel components (ALWAYS - even in minimized mode, panels exist with size:0)
    if (layout.dockbox.children?.[1] && 'tabs' in layout.dockbox.children[1]) {
      const sidebarPanel = layout.dockbox.children[1];
      sidebarPanel.tabs.forEach(tab => {
        if (tab.id === 'what-if-tab') {
          tab.content = whatIfComponent;
        } else if (tab.id === 'properties-tab') {
          tab.content = propertiesComponent;
        } else if (tab.id === 'tools-tab') {
          tab.content = toolsComponent;
        }
      });
      
      // Set active tab based on sidebar state
      sidebarPanel.activeId = PANEL_TO_TAB_ID[sidebarState.activePanel];
    }
    
    return layout;
  }, [sidebarState.activePanel, sidebarState.sidebarWidth, fileId, canvasComponent, whatIfComponent, propertiesComponent, toolsComponent]);
  
  // Watch What-If state: no layout reloads needed; CanvasHost reads from context
  // (left intentionally empty to avoid expensive rc-dock loadLayout calls)
  
  // Initialize dock layout (only on mount)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#9: Initialize dock layout check (dockLayout=${!!dockLayout})`);
    // Only initialize if we don't have a layout yet
    if (dockLayout) return;
    
    const layout = createLayoutStructure(sidebarState.mode);
    setDockLayout(layout);
    
    // Capture actual rendered sidebar width after layout is created
    if (sidebarState.mode === 'maximized') {
      setTimeout(() => {
        if (containerRef.current) {
          const sidebarEl = containerRef.current.querySelector('[data-panel-id="graph-sidebar-panel"], [data-node-key="what-if-tab"], [data-node-key="properties-tab"]')?.closest('.dock-panel') as HTMLElement;
          if (sidebarEl) {
            const actualWidth = sidebarEl.getBoundingClientRect().width;
            console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Initializing with actual rendered sidebar width:`, actualWidth);
            sidebarOps.setSidebarWidth(actualWidth);
          }
        }
      }, 150);
    }
  }, [dockLayout, sidebarState.mode, createLayoutStructure, fileId, sidebarOps]);
  
  // Track previous mode to detect changes
  const prevModeRef = useRef<'minimized' | 'maximized'>(sidebarState.mode);
  
  
  // Update layout when mode changes
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#10: Mode change check (mode=${sidebarState.mode}, suspended=${Date.now() < suspendLayoutUntilRef.current})`);
    if (Date.now() < suspendLayoutUntilRef.current) return;
    if (!dockRef.current) return;
    
    // Only update if mode actually changed
    if (prevModeRef.current === sidebarState.mode) return;
    
    console.log(`[${new Date().toISOString()}] [GraphEditor] Sidebar mode changed:`, prevModeRef.current, '->', sidebarState.mode);
    prevModeRef.current = sidebarState.mode;
    
    // Update sidebar width immediately based on mode
    if (sidebarState.mode === 'maximized') {
      sidebarOps.setSidebarWidth(300);
    } else {
      sidebarOps.setSidebarWidth(0);
    }
    
    // Create layout structure with stable component instances
    const layout = createLayoutStructure(sidebarState.mode);
    
    // Preserve floating tabs and re-inject stable components
    const currentLayout = dockRef.current.getLayout();
    if (currentLayout?.floatbox && currentLayout.floatbox.children && currentLayout.floatbox.children.length > 0) {
      console.log('[GraphEditor] Preserving floating tabs and re-injecting components');
      
      // Re-inject stable components into all floating tabs (directly modify, don't clone)
      const reinjectComponents = (node: any) => {
        if (node.tabs) {
          node.tabs.forEach((tab: any) => {
            // Re-inject stable component references
            if (tab.id === 'what-if-tab') {
              tab.content = whatIfComponent;
            } else if (tab.id === 'properties-tab') {
              tab.content = propertiesComponent;
            } else if (tab.id === 'tools-tab') {
              tab.content = toolsComponent;
            }
          });
        }
        if (node.children) {
          node.children.forEach(reinjectComponents);
        }
      };
      
      // Directly modify the existing floatbox (no cloning needed)
      currentLayout.floatbox.children?.forEach(reinjectComponents);
      layout.floatbox = currentLayout.floatbox as any;
    }
    
    // Apply directly via loadLayout WITHOUT remounting
    console.log('[GraphEditor] Applying layout via loadLayout (no remount)');
    dockRef.current.loadLayout(layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarState.mode]);
  
  // Update rc-dock active tab when activePanel changes (while maximized)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#11: Active panel change check (activePanel=${sidebarState.activePanel}, suspended=${Date.now() < suspendLayoutUntilRef.current})`);
    if (Date.now() < suspendLayoutUntilRef.current) return;
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
          console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#11: Loading layout for active panel change`);
          dock.loadLayout(layout);
        }
      }
    }
  }, [sidebarState.activePanel, sidebarState.mode, dockLayout]);
  
  const store = useGraphStore();
  const { setGraph, graph, undo, redo, canUndo, canRedo, saveHistoryState, resetHistory } = store;

  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] GraphEditor render:`, { 
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
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#12: Sync file→store triggered`);
    if (Date.now() < suspendLayoutUntilRef.current) {
      console.log(`[${new Date().toISOString()}] GraphEditor[${fileId}]: file→store sync skipped (suspended)`);
      return;
    }
    console.log(`[${new Date().toISOString()}] GraphEditor[${fileId}]: useEffect([data]) triggered`, {
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
    console.log(`[${new Date().toISOString()}] [GraphEditor] File→Store: SYNCING (nodes: ${data.nodes.length})`);
    setGraph(data);
    
    // Save to history
    if (!initialHistorySavedRef.current) {
      // First load - save initial state
      setTimeout(() => {
        console.log(`[${new Date().toISOString()}] [GraphEditor] Saving initial state to history`);
        saveHistoryState();
        initialHistorySavedRef.current = true;
      }, 150);
    } else {
      // External changes after initial load (revert, JSON editor) - save to history
      setTimeout(() => {
        console.log(`[${new Date().toISOString()}] [GraphEditor] Saving external change to history`);
        saveHistoryState();
      }, 150);
    }
    
    setTimeout(() => { 
      syncingRef.current = false;
      console.log(`[${new Date().toISOString()}] [GraphEditor] File→Store: Sync complete, flag reset`);
    }, 100);
  }, [data, setGraph, saveHistoryState, fileId]);

  // Sync graph store changes BACK to file (from interactive edits)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#13: Sync store→file triggered`);
    if (Date.now() < suspendLayoutUntilRef.current) {
      console.log(`[${new Date().toISOString()}] GraphEditor: Store→file sync skipped (suspended)`);
      return;
    }
    if (!graph || !graph.nodes) {
      console.log(`[${new Date().toISOString()}] GraphEditor: Store→file sync skipped (no graph or nodes)`);
      return;
    }
    
    if (syncingRef.current) {
      console.log(`[${new Date().toISOString()}] GraphEditor: Store→file sync skipped (syncingRef is true)`);
      return;
    }
    
    const graphStr = JSON.stringify(graph);
    const dataStr = data ? JSON.stringify(data) : '';
    
    if (graphStr !== dataStr) {
      syncingRef.current = true;
      console.log(`[${new Date().toISOString()}] [GraphEditor] Store→File: SYNCING (nodes: ${graph.nodes.length})`);
      updateData(graph);
      setTimeout(() => { 
        syncingRef.current = false;
        console.log(`[${new Date().toISOString()}] [GraphEditor] Store→File: Sync complete, flag reset`);
      }, 100);
    } else {
      console.log(`[${new Date().toISOString()}] [GraphEditor] Store→File: Skipped (data matches)`);
    }
  }, [graph, data, updateData]);

  // Keyboard shortcuts for undo/redo - ONLY when this tab is active
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#14: Setup keyboard shortcuts`);
    const handleKeyDown = (e: KeyboardEvent) => {
      // CRITICAL: Only process if THIS tab is the active tab
      if (activeTabId !== tabId) {
        return; // Not our tab, ignore all keyboard events
      }
      console.log(`[${new Date().toISOString()}] [GraphEditor] Keyboard event:`, { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
      
      // Only handle if user isn't typing in an input field or Monaco editor
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
          console.log(`GraphEditor[${fileId}]: Undo triggered (active tab)`, canUndo, 'historyIndex:', store.getState().historyIndex);
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
          console.log(`GraphEditor[${fileId}]: Redo triggered (active tab)`, canRedo, 'historyIndex:', store.getState().historyIndex);
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
  }, [undo, redo, canUndo, canRedo, store, activeTabId, tabId, fileId]);

  // Listen for reset sidebar command from context menu
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#15: Setup reset sidebar listener`);
    const handleResetSidebar = (e: CustomEvent) => {
      console.log(`[${new Date().toISOString()}] [GraphEditor] EVENT: dagnet:resetSidebar received`, e.detail);
      if (e.detail?.tabId === tabId) {
        console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Resetting sidebar to default`);
        sidebarOps.resetToDefault();
        
        // Force reload layout to default structure
        setTimeout(() => {
          if (dockRef.current) {
            const layout = createLayoutStructure('minimized');
            dockRef.current.loadLayout(layout);
          }
        }, 0);
      }
    };
    
    window.addEventListener('dagnet:resetSidebar' as any, handleResetSidebar);
    return () => window.removeEventListener('dagnet:resetSidebar' as any, handleResetSidebar);
  }, [tabId, fileId, sidebarOps, createLayoutStructure]);

  // Listen for menu bar commands
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#16: Setup menu bar listeners`);
    // Broadcast current state to menu bar
    const broadcastState = () => {
      window.dispatchEvent(new CustomEvent('dagnet:graphStateUpdate', { 
        detail: { useUniformScaling, massGenerosity, autoReroute }
      }));
    };
    broadcastState();

    // Listen for menu commands
    const handleSetUniformScaling = (e: CustomEvent) => {
      console.log(`[${new Date().toISOString()}] [GraphEditor] EVENT: dagnet:setUniformScaling received`, e.detail);
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

  console.log(`[${ts()}] GraphEditor: About to render GraphCanvas with ${data.nodes?.length} nodes`);
  console.log(`[${ts()}] GraphEditor: Rendering with state:`, {
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

  const SUPPRESS_LAYOUT_HANDLERS = false; // Re-enabled: needed for restore-closed-tabs logic
  return (
    <SelectionContext.Provider value={selectionContextValue}>
      <WhatIfProvider value={{
        whatIfAnalysis: whatIfLocal.whatIfAnalysis,
        caseOverrides: whatIfLocal.caseOverrides,
        conditionalOverrides: whatIfLocal.conditionalOverrides,
        setWhatIfAnalysis: (analysis) => {
          const next = { ...whatIfLocal, whatIfAnalysis: analysis };
          setWhatIfLocal(next);
          schedulePersist(next);
        },
        setCaseOverride: (nodeId, variantName) => {
          const nextOverrides = { ...(whatIfLocal.caseOverrides || {}) } as Record<string, string>;
          if (variantName === null) delete nextOverrides[nodeId]; else nextOverrides[nodeId] = variantName;
          const next = { ...whatIfLocal, caseOverrides: nextOverrides };
          setWhatIfLocal(next);
          schedulePersist(next);
        },
        setConditionalOverride: (edgeId, value) => {
          const nextCond = { ...(whatIfLocal.conditionalOverrides || {}) } as Record<string, Set<string>>;
          if (value === null) delete nextCond[edgeId]; else nextCond[edgeId] = value;
          const next = { ...whatIfLocal, conditionalOverrides: nextCond };
          setWhatIfLocal(next);
          schedulePersist(next);
        },
        clearAllOverrides: () => {
          const next = { whatIfAnalysis: null, caseOverrides: {}, conditionalOverrides: {} as any };
          setWhatIfLocal(next);
          schedulePersist(next as any);
        }
      }}>
      <div 
        ref={containerRef}
        style={{ 
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
              console.log(`[${new Date().toISOString()}] [GraphEditor] onLayoutChange FIRED`);
              if (SUPPRESS_LAYOUT_HANDLERS) {
                console.log(`[${new Date().toISOString()}] [GraphEditor] onLayoutChange SUPPRESSED`);
                return;
              }
              if (Date.now() < suspendLayoutUntilRef.current) {
                console.log(`[${new Date().toISOString()}] [GraphEditor] onLayoutChange SUSPENDED`);
                return;
              }
              // Track which panels are floating
              const floatingTabIds = newLayout.floatbox?.children?.map((box: any) => {
                return box.tabs?.map((tab: any) => tab.id) || [];
              }).flat() || [];
              
              console.log(`[${new Date().toISOString()}] [GraphEditor] Layout changed. Floating tabs:`, floatingTabIds);
              
              // DIAGNOSTIC: Check floating panel structure
              if (floatingTabIds.length > 0 && containerRef.current) {
                setTimeout(() => {
                  // Try multiple selectors to find floating panels
                  const floatingByClass = containerRef.current!.querySelectorAll('.dock-float');
                  const floatingByBox = containerRef.current!.querySelectorAll('.dock-box[data-float="true"]');
                  const allFloatBoxes = document.querySelectorAll('.dock-float, [data-float="true"]');
                  
                  console.log(`[GraphEditor ${fileId}] Floating panel search:`, {
                    byDockFloat: floatingByClass.length,
                    byDataFloat: floatingByBox.length,
                    globalFloat: allFloatBoxes.length
                  });
                  
                  // Check ALL close buttons to see which ones are in floating context
                  const allCloseBtns = containerRef.current!.querySelectorAll('.dock-tab-close-btn');
                  allCloseBtns.forEach((btn, idx) => {
                    const panel = btn.closest('.dock-panel');
                    const box = btn.closest('.dock-box');
                    console.log(`[GraphEditor ${fileId}] Close button ${idx}:`, {
                      btn,
                      panelClasses: (panel as HTMLElement)?.className,
                      boxClasses: (box as HTMLElement)?.className,
                      isFloat: box?.classList.contains('dock-float'),
                      computedDisplay: window.getComputedStyle(btn as Element).display
                    });
                  });
                }, 100);
              }
              
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
              
              console.log('[GraphEditor] All visible tabs:', Array.from(allTabIds));
              
              // If sidebar tabs are closed (not just floating), restore them to dock
              const expectedSidebarTabs = ['what-if-tab', 'properties-tab', 'tools-tab'];
              const missingSidebarTabs = expectedSidebarTabs.filter(id => !allTabIds.has(id));
              
              if (missingSidebarTabs.length > 0) {
                console.log('[GraphEditor] Sidebar tabs missing (closed):', missingSidebarTabs);
                
                // If in maximized mode, restore missing tabs to sidebar dock using stable components
                if (sidebarState.mode === 'maximized' && dockRef.current) {
                  console.log('[GraphEditor] Restoring closed tabs to sidebar dock with stable components');
                  
                  setTimeout(() => {
                    if (dockRef.current) {
                      // Use createLayoutStructure helper to get layout with stable components
                      const layout = createLayoutStructure('maximized');
                      
                      // Preserve any remaining floating tabs (non-sidebar tabs)
                      if (newLayout.floatbox && newLayout.floatbox.children && newLayout.floatbox.children.length > 0) {
                        // Only preserve floating tabs that aren't sidebar tabs
                        const nonSidebarFloating = newLayout.floatbox.children.filter((box: any) => {
                          const tabIds = box.tabs?.map((t: any) => t.id) || [];
                          return !tabIds.some((id: string) => expectedSidebarTabs.includes(id));
                        });
                        
                        if (nonSidebarFloating.length > 0) {
                          layout.floatbox = { ...newLayout.floatbox, children: nonSidebarFloating } as any;
                        }
                      }
                      
                      console.log('[GraphEditor] Loading layout with restored tabs');
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
        
        {/* Toggle Button - visible in both minimized and maximized states */}
        <button
          onClick={() => {
            if (sidebarState.mode === 'minimized') {
              sidebarOps.maximize();
            } else {
              sidebarOps.minimize();
            }
          }}
          className={`graph-minimize-button${sidebarState.isResizing ? ' resizing' : ''}`}
          style={{
            position: 'absolute',
            right: sidebarState.mode === 'maximized' 
              ? `${sidebarState.sidebarWidth ?? 300}px` 
              : '48px', // When minimized, position at icon bar
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 100, // Same z-index as sidebar panels
          }}
          title={sidebarState.mode === 'minimized' ? 'Show Sidebar (Ctrl/Cmd + B)' : 'Hide Sidebar (Ctrl/Cmd + B)'}
        >
          {sidebarState.mode === 'minimized' ? '◀' : '▶'}
        </button>

        {/* Hover Preview Panel - shows when hovering over minimized icons */}
        {sidebarState.mode === 'minimized' && hoveredPanel && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: '48px', // Position to the left of the icon bar
              bottom: 0,
              width: '350px',
              zIndex: 99, // Below icon bar (100) but above canvas
              pointerEvents: 'auto'
            }}
            onMouseEnter={() => {
              console.log(`[${new Date().toISOString()}] [GraphEditor] Hover panel wrapper onMouseEnter - panel=${hoveredPanel}`);
              setHoveredPanel(hoveredPanel); // Keep it open
            }}
            onMouseLeave={() => {
              console.log(`[${new Date().toISOString()}] [GraphEditor] Hover panel wrapper onMouseLeave - clearing if not locked`);
              if (!isHoverLocked) {
                setHoveredPanel(null);
              }
            }}
          >
            <SidebarHoverPreview
              panel={hoveredPanel}
              tabId={tabId}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectedNodeChange={handleNodeSelection}
              onSelectedEdgeChange={handleEdgeSelection}
            />
          </div>
        )}
    </div>
      </WhatIfProvider>
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
