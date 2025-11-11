import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react';
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
import { ViewPreferencesProvider } from '../../contexts/ViewPreferencesContext';
import { Sparkles, FileText, Wrench } from 'lucide-react';
import { SelectorModal } from '../SelectorModal';
import { ItemBase } from '../../hooks/useItemFiltering';
import { WindowSelector } from '../WindowSelector';

// Context to share selection state with sidebar panels
interface SelectionContextType {
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  openSelectorModal: (config: SelectorModalConfig) => void;
}

interface SelectorModalConfig {
  type: 'parameter' | 'context' | 'case' | 'node' | 'event';
  items: ItemBase[];
  currentValue: string;
  onSelect: (value: string) => void;
  onOpenItem?: (itemId: string) => void;
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
  
  // DEBUG: Log when tabState changes
  console.log(`[GraphEditor ${fileId}] tabState:`, tabState);
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
  const isResizingRef = useRef<boolean>(false);
  // const [usePlainWhatIfOverlay, setUsePlainWhatIfOverlay] = useState(false);
  
  // Tab-specific state (persisted per tab, not per file!)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(tabState.selectedNodeId ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(tabState.selectedEdgeId ?? null);
  
  // Selector modal state (scoped to graph editor window)
  const [selectorModalConfig, setSelectorModalConfig] = useState<SelectorModalConfig | null>(null);
  
  // OLD sidebar state - will be deprecated after Phase 2
  const [whatIfOpen, setWhatIfOpen] = useState(tabState.whatIfOpen ?? false);
  const [propertiesOpen, setPropertiesOpen] = useState(tabState.propertiesOpen ?? true);
  
  // Removed local view prefs state; handled by ViewPreferencesProvider

  // Sync local state with tab state when tab state changes (e.g., from menu actions or tab switches)
  // Only update if different to avoid infinite loops
  // View preferences sync is handled in ViewPreferencesProvider

  // When edge scaling state changes, we don't reload layout (would cause loop)
  // Instead, toolsComponent is not memoized and will have fresh props on next render
  // The layout structure includes toolsComponent in its dependencies, so it will update
  
  // Refs for GraphCanvas exposed functions (must be declared before component creation)
  const addNodeRef = React.useRef<(() => void) | null>(null);
  const deleteSelectedRef = React.useRef<(() => void) | null>(null);
  const autoLayoutRef = React.useRef<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>(null);
  const sankeyLayoutRef = React.useRef<(() => void) | null>(null);
  const forceRerouteRef = React.useRef<(() => void) | null>(null);
  const hideUnselectedRef = React.useRef<(() => void) | null>(null);
  
  // NEW: rc-dock layout for entire graph editor (Phase 2)
  const dockRef = useRef<DockLayout>(null);
  const containerRef = useRef<HTMLDivElement>(null); // Ref to THIS tab's container
  const [dockLayout, setDockLayout] = useState<LayoutData | null>(null);
  const sidebarResizeObserverRef = useRef<ResizeObserver | null>(null);
  const containerResizeObserverRef = useRef<ResizeObserver | null>(null);
  const hboxResizeObserverRef = useRef<ResizeObserver | null>(null);
  const [splitterCenterY, setSplitterCenterY] = useState<number>(0); // Vertical center of splitter in pixels from top
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
    // Dispatch event for DataMenu
    window.dispatchEvent(new CustomEvent('dagnet:nodeSelected', { detail: { nodeId } }));
    if (!nodeId) {
      window.dispatchEvent(new CustomEvent('dagnet:selectionCleared'));
    }
    // Persist to tab state
    if (tabId) {
      tabOps.updateTabState(tabId, { selectedNodeId: nodeId });
    }
    prevSelectedNodeRef.current = nodeId;
  }, [sidebarOps, tabId, tabOps]);
  
  const handleEdgeSelection = React.useCallback((edgeId: string | null) => {
    const changed = prevSelectedEdgeRef.current !== edgeId;
    setSelectedEdgeId(edgeId);
    if (edgeId && changed) {
      // Smart auto-open: opens Properties on first selection (only when selection changes)
      sidebarOps.handleSelection();
    }
    // Dispatch event for DataMenu
    window.dispatchEvent(new CustomEvent('dagnet:edgeSelected', { detail: { edgeId } }));
    if (!edgeId) {
      window.dispatchEvent(new CustomEvent('dagnet:selectionCleared'));
    }
    // Persist to tab state
    if (tabId) {
      tabOps.updateTabState(tabId, { selectedEdgeId: edgeId });
    }
    prevSelectedEdgeRef.current = edgeId;
  }, [sidebarOps, tabId, tabOps]);
  
  // Icon bar handlers
  const handleIconClick = React.useCallback((panel: 'what-if' | 'properties' | 'tools') => {
    // Click on icon - just update state, let the effect handle the layout
    sidebarOps.maximize(panel);
  }, [sidebarOps]);
  
  const handleIconHover = React.useCallback((panel: 'what-if' | 'properties' | 'tools' | null) => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover called: panel=${panel}, mode=${sidebarState.mode}, isHoverLocked=${isHoverLocked}`);
    if (sidebarState.mode !== 'minimized') return;
    if (isHoverLocked) return;
    
    // Only set panel on hover (icon enter), ignore null (icon leave)
    if (panel) {
      console.log(`[${new Date().toISOString()}] [GraphEditor] handleIconHover: Setting hoveredPanel to ${panel}`);
      setHoveredPanel(panel);
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
  
  // Listen for request to open Properties panel (from context menu or double-click)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#4b: Setup dagnet:openPropertiesPanel listener`);
    const handler = () => {
      console.log(`[${new Date().toISOString()}] [GraphEditor] EVENT: dagnet:openPropertiesPanel received`);
      // Maximize sidebar to Properties panel
      sidebarOps.maximize('properties');
    };
    window.addEventListener('dagnet:openPropertiesPanel' as any, handler);
    return () => window.removeEventListener('dagnet:openPropertiesPanel' as any, handler);
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
    console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] useEffect#6: Setup resize detection listeners`);
    
    if (!containerRef.current) return;
    
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Debug logging
      const hasContainer = !!containerRef.current;
      const isInContainer = containerRef.current?.contains(target);
      const isDockDiv = target.classList.contains('dock-divider');
      const isDockSplit = target.classList.contains('dock-splitter');
      
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] mousedown debug:`, {
        hasContainer,
        isInContainer,
        isDockDiv,
        isDockSplit,
        className: target.className,
        tagName: target.tagName
      });
      
      // Only respond if the splitter is within THIS container
      if (!containerRef.current?.contains(target)) {
        console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] mousedown IGNORED (not in container)`);
        return;
      }
      
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] mousedown on:`, target.className, target.tagName);
      if (target.classList.contains('dock-divider') || target.classList.contains('dock-splitter')) {
        console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] ✅ Splitter clicked! Setting isResizing=true`);
        isResizingRef.current = true;
        sidebarOps.setIsResizing(true);
      }
    };
    
    const handleMouseUp = () => {
      if (sidebarState.isResizing) {
        console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Resize ended - capturing final width`);
        
        // CRITICAL: Capture the final width BEFORE clearing isResizing
        // Find sidebar using its stable ID (works regardless of position)
        const sidebarPanel = containerRef.current?.querySelector('[data-dockid="graph-sidebar-panel"]') as HTMLElement;
        if (sidebarPanel) {
          const finalWidth = Math.round(sidebarPanel.getBoundingClientRect().width);
          console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Final width after resize: ${finalWidth}px (integer)`);
          sidebarOps.setSidebarWidth(finalWidth);
        } else {
          console.warn(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Could not find sidebar panel to capture final width`);
        }
        
        // Now clear the resizing flag
        isResizingRef.current = false;
        sidebarOps.setIsResizing(false);
      }
    };
    
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [sidebarState.isResizing, sidebarOps, fileId]);
  
  // Global click handler for close buttons on sidebar panels (floating or docked elsewhere)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Check if click is on a close button
      if (target.classList.contains('dock-tab-close-btn')) {
        // Only handle if it's in this GraphEditor instance
        if (!containerRef.current?.contains(target)) return;
        
        // Find the tab element and get its data-node-key
        const tab = target.closest('.dock-tab') as HTMLElement;
        const tabId = tab?.getAttribute('data-node-key');
        
        console.log(`[GraphEditor ${fileId}] Close button clicked, tab element:`, tab, 'tabId:', tabId);
        
        if (tabId && dockRef.current) {
          console.log(`[GraphEditor ${fileId}] Close button clicked for tab: ${tabId}`);
          e.stopPropagation();
          e.preventDefault();
          
          // Find the tab in rc-dock and remove it (will return to home)
          const tabData = dockRef.current.find(tabId);
          console.log(`[GraphEditor ${fileId}] Found tab data:`, tabData);
          if (tabData && 'title' in tabData) {
            console.log(`[GraphEditor ${fileId}] Removing tab from layout: ${tabId}`);
            dockRef.current.dockMove(tabData, null, 'remove');
          }
        }
      }
    };
    
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [fileId]);
  
  // Apply CSS-based fixed width to sidebar panel
  // Using useLayoutEffect so it runs synchronously after DOM updates but before paint
  useLayoutEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] useEffect#6b: Apply fixed width CSS (mode=${sidebarState.mode}, width=${sidebarState.sidebarWidth}, isResizing=${sidebarState.isResizing})`);
    
    if (!containerRef.current) {
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] useEffect#6b: No containerRef`);
      return;
    }
    
    // Find sidebar using its stable ID (works regardless of position)
    const sidebarPanel = containerRef.current.querySelector('[data-dockid="graph-sidebar-panel"]') as HTMLElement;
    if (!sidebarPanel) {
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] useEffect#6b: No sidebar panel found`);
      return;
    }
    
    // If minimized, force width to 0
    if (sidebarState.mode === 'minimized') {
      sidebarPanel.style.flex = '0 0 0px';
      sidebarPanel.style.width = '0px';
      sidebarPanel.style.minWidth = '0px';
      sidebarPanel.style.maxWidth = '0px';
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Forced width to 0 (minimized)`);
      return;
    }
    
    // If maximized and user is actively resizing, allow rc-dock to resize freely
    // but DON'T lock the width - just remove the min/max constraints
    if (sidebarState.mode === 'maximized' && sidebarState.isResizing) {
      const currentWidth = sidebarPanel.getBoundingClientRect().width;
      sidebarPanel.style.flex = `0 0 ${currentWidth}px`;
      sidebarPanel.style.minWidth = '';
      sidebarPanel.style.maxWidth = '';
      sidebarPanel.style.width = `${currentWidth}px`;
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Unlocked for resizing (current width ${currentWidth}px)`);
      return;
    }
    
    // If maximized and NOT resizing, apply fixed width (but keep it resizable!)
    if (sidebarState.mode === 'maximized') {
      const targetWidth = sidebarState.sidebarWidth || 300;
      const currentWidth = sidebarPanel.getBoundingClientRect().width;
      
      // Set flex basis and width, but DON'T lock with min/max
      // This allows the width to be corrected but keeps the splitter visible
      sidebarPanel.style.flex = `0 0 ${targetWidth}px`;
      sidebarPanel.style.width = `${targetWidth}px`;
      sidebarPanel.style.minWidth = ''; // Clear any previous constraints
      sidebarPanel.style.maxWidth = ''; // Clear any previous constraints
      
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Applied fixed width ${targetWidth}px to sidebar (was ${currentWidth}px before CSS)`);
    }
  }, [sidebarState.mode, sidebarState.sidebarWidth, sidebarState.isResizing, fileId]);
  
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
        
        // Find the OFFICIAL sidebar panel using its stable ID
        // rc-dock adds the panel ID as a data attribute: data-dockid="graph-sidebar-panel"
        let sidebarPanelElement: HTMLElement | null = null;
        
        sidebarPanelElement = containerRef.current.querySelector('[data-dockid="graph-sidebar-panel"]') as HTMLElement;
        
        if (sidebarPanelElement) {
          console.log(`[GraphEditor ${fileId}] Found official sidebar panel via data-dockid`);
        }
        
        if (sidebarPanelElement) {
          // Set initial width immediately
          const rect = sidebarPanelElement.getBoundingClientRect();
          const width = Math.round(rect.width);
          const storedWidth = sidebarState.sidebarWidth;
          console.log(`[GraphEditor ${fileId}] ResizeObserver: Initial sidebar width: ${width}px (stored: ${storedWidth}px)`);
          
          // Apply CSS fixed width IMMEDIATELY if we have a stored width
          if (storedWidth && !sidebarState.isResizing) {
            sidebarPanelElement.style.flex = `0 0 ${storedWidth}px`;
            sidebarPanelElement.style.width = `${storedWidth}px`;
            sidebarPanelElement.style.minWidth = '';
            sidebarPanelElement.style.maxWidth = '';
            console.log(`[GraphEditor ${fileId}] ResizeObserver: Applied stored width ${storedWidth}px (was ${width}px)`);
            lastSidebarWidthRef.current = storedWidth;
          } else if (!storedWidth) {
            // No stored width - capture the initial rendered width
            console.log(`[GraphEditor ${fileId}] ResizeObserver: No stored width, capturing initial width ${width}px`);
            lastSidebarWidthRef.current = width;
            sidebarOps.setSidebarWidth(width);
          } else {
            // isResizing=true, don't apply CSS
            lastSidebarWidthRef.current = width;
            console.log(`[GraphEditor ${fileId}] ResizeObserver: isResizing=true, skipping CSS application`);
          }
          
          // Create ResizeObserver to track width changes in real-time
          sidebarResizeObserverRef.current = new ResizeObserver(() => {
            const t0 = performance.now();
            console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver callback fired (t0=${t0.toFixed(2)}ms)`);
            
            // CRITICAL: Skip updates while user is actively resizing
            // When isResizing=true, we remove CSS constraints and the panel may temporarily collapse
            // We only want to capture the FINAL width after user releases mouse
            if (isResizingRef.current) {
              console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver: Skipping (isResizing=true)`);
              return;
            }
            
            // CRITICAL: Never persist width when sidebar is minimized
            // The width will be 0 or 1px, which would corrupt the stored maximized width
            if (sidebarState.mode === 'minimized') {
              console.log(`[${new Date().toISOString()}] [GraphEditor] 🔍 ResizeObserver: Skipping (sidebar minimized)`);
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
              // CRITICAL: Always use integer width to prevent rounding loops
              const intWidth = Math.round(newWidth);
              
              // Don't update if it matches the stored width (CSS is correcting it)
              if (intWidth === sidebarState.sidebarWidth) {
                console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] 🔍 ResizeObserver: RAF - width ${intWidth}px matches stored, skipping update`);
                sidebarWidthRafRef.current = null;
                return;
              }
              
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] 🔍 ResizeObserver: RAF executing (scheduled ${(t2-t0).toFixed(2)}ms ago) - setting sidebar width to ${intWidth}px (integer)`);
              sidebarOps.setSidebarWidth(intWidth);
              sidebarWidthRafRef.current = null;
              const t3 = performance.now();
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] 🔍 ResizeObserver: RAF completed in ${(t3-t2).toFixed(2)}ms`);
            });
          });
          
          sidebarResizeObserverRef.current.observe(sidebarPanelElement);
        } else {
          console.error(`[GraphEditor ${fileId}] ResizeObserver: Could not find sidebar panel in this container`);
          // Retry after a longer delay - the panel might be restoring from a closed state
          setTimeout(() => {
            if (!containerRef.current) return;
            
            // Find sidebar panel using its stable ID
            const sidebar = containerRef.current.querySelector('[data-dockid="graph-sidebar-panel"]') as HTMLElement;
            
            if (sidebar && sidebarState.sidebarWidth && sidebarState.sidebarWidth > 50) {
              sidebar.style.flex = 'none';
              sidebar.style.width = `${sidebarState.sidebarWidth}px`;
              console.log(`[GraphEditor ${fileId}] ResizeObserver RETRY: Applied stored width ${sidebarState.sidebarWidth}px to restored sidebar`);
            }
          }, 200);
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
  
  // Track vertical position of the hbox (where the splitter actually is)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#7b: Setup hbox position tracker`);
    
    if (hboxResizeObserverRef.current) {
      hboxResizeObserverRef.current.disconnect();
      hboxResizeObserverRef.current = null;
    }
    
    if (!containerRef.current) return;
    
    const updateSplitterPosition = () => {
      const hbox = containerRef.current?.querySelector('.dock-box.dock-hbox') as HTMLElement;
      if (hbox) {
        const rect = hbox.getBoundingClientRect();
        const containerRect = containerRef.current!.getBoundingClientRect();
        
        // Calculate center Y relative to container
        const centerY = rect.top - containerRect.top + (rect.height / 2);
        setSplitterCenterY(centerY);
        console.log(`[${new Date().toISOString()}] [GraphEditor] Splitter center Y: ${centerY}px (hbox top=${rect.top - containerRect.top}, height=${rect.height})`);
      }
    };
    
    // Initial position
    setTimeout(() => {
      updateSplitterPosition();
      
      // Set up observer
      const hbox = containerRef.current?.querySelector('.dock-box.dock-hbox') as HTMLElement;
      if (hbox) {
        hboxResizeObserverRef.current = new ResizeObserver(() => {
          updateSplitterPosition();
        });
        hboxResizeObserverRef.current.observe(hbox);
      }
    }, 100);
    
    return () => {
      if (hboxResizeObserverRef.current) {
        hboxResizeObserverRef.current.disconnect();
        hboxResizeObserverRef.current = null;
      }
    };
  }, [dockLayout]);
  
  // DIAGNOSTIC: Log What-If state changes
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#8: What-If state diagnostic`, {
      whatIfAnalysis: myTab?.editorState?.whatIfAnalysis,
      caseOverrides: myTab?.editorState?.caseOverrides,
      conditionalOverrides: myTab?.editorState?.conditionalOverrides
    });
  }, [myTab?.editorState?.whatIfAnalysis, myTab?.editorState?.caseOverrides, myTab?.editorState?.conditionalOverrides, fileId]);
  
  // Canvas component - recreate when edge scaling props change so GraphCanvas receives updates
  const CanvasHost: React.FC = () => {
    const whatIf = useWhatIfContext();
    return (
      <GraphCanvas
        tabId={tabId}
        activeTabId={activeTabId}
        onSelectedNodeChange={handleNodeSelection}
        onSelectedEdgeChange={handleEdgeSelection}
        onAddNodeRef={addNodeRef}
        onDeleteSelectedRef={deleteSelectedRef}
        onAutoLayoutRef={autoLayoutRef}
        onSankeyLayoutRef={sankeyLayoutRef}
        onForceRerouteRef={forceRerouteRef}
        onHideUnselectedRef={hideUnselectedRef}
        whatIfAnalysis={whatIf?.whatIfAnalysis}
        caseOverrides={whatIf?.caseOverrides}
        conditionalOverrides={whatIf?.conditionalOverrides}
      />
    );
  };
  // Canvas component - no memoization, recreate every render so props are always fresh
  const canvasComponent = <CanvasHost />;
  
  const whatIfComponent = useMemo(() => <WhatIfPanel tabId={tabId} />, [tabId]);
  
  const propertiesComponent = useMemo(() => <PropertiesPanelWrapper tabId={tabId} />, [tabId]);
  
  // Tools panel - pass current state as props so it displays correctly
  // Use events for changes (same pattern as View menu)
  const toolsComponent = useMemo(() => (
    <ToolsPanel
      onAutoLayout={(dir) => autoLayoutRef.current?.(dir || 'LR')}
      onSankeyLayout={() => sankeyLayoutRef.current?.()}
      onForceReroute={() => forceRerouteRef.current?.()}
      onHideUnselected={() => hideUnselectedRef.current?.()}
      onShowAll={() => {
        window.dispatchEvent(new CustomEvent('dagnet:showAll'));
      }}
    />
  ), []);
  
  // Helper function to create layout structure (uses stable components)
  const createLayoutStructure = useCallback((
    mode: 'minimized' | 'maximized',
    sidebarTabsToInclude?: string[] // e.g. ['properties-tab'] or ['what-if-tab', 'tools-tab']
  ) => {
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
      
      // If specific tabs requested, filter to only those
      if (sidebarTabsToInclude) {
        sidebarPanel.tabs = sidebarPanel.tabs.filter((tab: any) => sidebarTabsToInclude.includes(tab.id));
        console.log(`[GraphEditor ${fileId}] Creating layout with only sidebar tabs:`, sidebarTabsToInclude);
      }
      
      sidebarPanel.tabs.forEach((tab: any) => {
        if (tab.id === 'what-if-tab') {
          tab.content = whatIfComponent;
        } else if (tab.id === 'properties-tab') {
          tab.content = propertiesComponent;
        } else if (tab.id === 'tools-tab') {
          tab.content = toolsComponent;
        }
      });
      
      // Set active tab based on sidebar state (if that tab exists in the filtered list)
      const desiredActiveId = PANEL_TO_TAB_ID[sidebarState.activePanel];
      if (sidebarPanel.tabs.some((t: any) => t.id === desiredActiveId)) {
        sidebarPanel.activeId = desiredActiveId;
      } else if (sidebarPanel.tabs.length > 0) {
        sidebarPanel.activeId = (sidebarPanel.tabs[0] as any).id;
      }
    }
    
    return layout;
  }, [sidebarState.activePanel, sidebarState.sidebarWidth, fileId, whatIfComponent, propertiesComponent, toolsComponent]);
  
  // Watch What-If state: no layout reloads needed; CanvasHost reads from context
  // (left intentionally empty to avoid expensive rc-dock loadLayout calls)
  
  // Initialize dock layout (only on mount)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#9: Initialize dock layout check (dockLayout=${!!dockLayout}, savedLayout=${!!sidebarState.savedDockLayout})`);
    // Only initialize if we don't have a layout yet
    if (dockLayout) {
      console.log(`[${new Date().toISOString()}] [GraphEditor] useEffect#9: Skipping init - dockLayout already exists`);
      return;
    }
    
    let layout;
    
    if (sidebarState.savedDockLayout) {
      // Restore saved layout structure
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Restoring saved dock layout`);
      layout = sidebarState.savedDockLayout;
      
      // Re-inject React components and titles into all tabs (recursively)
      const reinjectComponents = (node: any) => {
        if (node.tabs) {
          node.tabs.forEach((tab: any) => {
            if (tab.id === 'canvas-tab') {
              tab.content = canvasComponent;
              tab.title = '';
            } else if (tab.id === 'what-if-tab') {
              tab.content = whatIfComponent;
              tab.title = React.createElement('div', { 
                className: 'dock-tab-title', 
                style: { display: 'flex', alignItems: 'center', gap: '6px' } 
              },
                React.createElement(Sparkles, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis', 
                    whiteSpace: 'nowrap' 
                  } 
                }, 'What-If')
              );
            } else if (tab.id === 'properties-tab') {
              tab.content = propertiesComponent;
              tab.title = React.createElement('div', { 
                className: 'dock-tab-title', 
                style: { display: 'flex', alignItems: 'center', gap: '6px' } 
              },
                React.createElement(FileText, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis', 
                    whiteSpace: 'nowrap' 
                  } 
                }, 'Props')
              );
            } else if (tab.id === 'tools-tab') {
              tab.content = toolsComponent;
              tab.title = React.createElement('div', { 
                className: 'dock-tab-title', 
                style: { display: 'flex', alignItems: 'center', gap: '6px' } 
              },
                React.createElement(Wrench, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis', 
                    whiteSpace: 'nowrap' 
                  } 
                }, 'Tools')
              );
            }
          });
        }
        if (node.children) {
          node.children.forEach(reinjectComponents);
        }
      };
      
      if (layout.dockbox) reinjectComponents(layout.dockbox);
      if (layout.floatbox) {
        reinjectComponents(layout.floatbox);
        
        // Log the positions we're restoring
        layout.floatbox.children?.forEach((fp: any) => {
          const tabId = fp.tabs?.[0]?.id;
          console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Restoring position for ${tabId}: x=${fp.x}, y=${fp.y}, w=${fp.w}, h=${fp.h}`);
        });
      }
      
      // Set sidebar panel size in layout if mode is maximized
      if (sidebarState.mode === 'maximized' && sidebarState.sidebarWidth) {
        const setSidebarSize = (node: any) => {
          if (node.id === 'graph-sidebar-panel') {
            node.size = sidebarState.sidebarWidth;
            console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Set sidebar panel size to ${sidebarState.sidebarWidth}px in restored layout`);
          }
          if (node.children) {
            node.children.forEach(setSidebarSize);
          }
        };
        if (layout.dockbox) setSidebarSize(layout.dockbox);
      }
      
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Layout restored, components re-injected`);
    } else {
      // No saved layout, create default
      console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] No saved layout, creating default`);
      layout = createLayoutStructure(sidebarState.mode);
    }
    
    setDockLayout(layout);
    
    // Capture actual rendered sidebar width ONLY if no width is stored
    if (sidebarState.mode === 'maximized' && !sidebarState.sidebarWidth) {
      setTimeout(() => {
        if (containerRef.current) {
          const sidebarEl = containerRef.current.querySelector('[data-panel-id="graph-sidebar-panel"], [data-node-key="what-if-tab"], [data-node-key="properties-tab"]')?.closest('.dock-panel') as HTMLElement;
          if (sidebarEl) {
            const actualWidth = Math.round(sidebarEl.getBoundingClientRect().width);
            console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Initializing with actual rendered sidebar width: ${actualWidth}px (no stored width)`);
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
    
    // NO loadLayout() needed! The CSS effect (useLayoutEffect#6b) handles minimize/maximize
    // by setting the sidebar panel width to 0 or the stored width.
    // This preserves floating panels because we never destroy/recreate the layout.
    console.log(`[${new Date().toISOString()}] [GraphEditor] Mode change handled by CSS (no loadLayout call)`);
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

  // Listen for suppress store→file sync event (for programmatic updates from file pulls)
  useEffect(() => {
    const handler = (e: any) => {
      const duration = e?.detail?.duration ?? 200;
      console.log(`[${new Date().toISOString()}] [GraphEditor] EVENT: dagnet:suppressStoreToFileSync received, suppressing for ${duration}ms`);
      syncingRef.current = true;
      setTimeout(() => {
        syncingRef.current = false;
        console.log(`[${new Date().toISOString()}] [GraphEditor] Suppression period ended, sync re-enabled`);
      }, duration);
    };
    window.addEventListener('dagnet:suppressStoreToFileSync' as any, handler);
    return () => window.removeEventListener('dagnet:suppressStoreToFileSync' as any, handler);
  }, []);

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
      // Exception: inputs marked with data-allow-global-shortcuts="true" should pass through
      const target = e.target as HTMLElement;
      const allowGlobalShortcuts = target.getAttribute?.('data-allow-global-shortcuts') === 'true';
      if (!allowGlobalShortcuts && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor'))) {
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
    // View preferences are handled via context; no broadcast needed

    // Listen for menu commands
    // Removed view preference handlers

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

    const handleSankeyLayout = () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (sankeyLayoutRef.current) {
        sankeyLayoutRef.current();
      }
    };

    // View preference listeners removed; handled via context
    window.addEventListener('dagnet:addNode' as any, handleAddNode);
    window.addEventListener('dagnet:deleteSelected' as any, handleDeleteSelected);
    window.addEventListener('dagnet:forceReroute' as any, handleForceReroute);
    window.addEventListener('dagnet:autoLayout' as any, handleAutoLayout);
    window.addEventListener('dagnet:sankeyLayout' as any, handleSankeyLayout);

    const handleHideUnselected = () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (hideUnselectedRef.current) {
        hideUnselectedRef.current();
      }
    };

    const handleShowAll = async () => {
      // Only handle if this is the active tab's editor
      if (tabId !== activeTabId) return;
      
      if (tabId) {
        await tabOps.showAllNodes(tabId);
      }
    };

    window.addEventListener('dagnet:hideUnselected' as any, handleHideUnselected);
    window.addEventListener('dagnet:showAll' as any, handleShowAll);

    return () => {
      // View preference listeners removed
      window.removeEventListener('dagnet:addNode' as any, handleAddNode);
      window.removeEventListener('dagnet:deleteSelected' as any, handleDeleteSelected);
      window.removeEventListener('dagnet:forceReroute' as any, handleForceReroute);
      window.removeEventListener('dagnet:autoLayout' as any, handleAutoLayout);
      window.removeEventListener('dagnet:sankeyLayout' as any, handleSankeyLayout);
      window.removeEventListener('dagnet:hideUnselected' as any, handleHideUnselected);
      window.removeEventListener('dagnet:showAll' as any, handleShowAll);
    };
  }, [tabId, activeTabId, tabOps]);

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
    onSelectedEdgeChange: handleEdgeSelection,
    openSelectorModal: (config) => setSelectorModalConfig(config)
  };

  const SUPPRESS_LAYOUT_HANDLERS = false; // Re-enabled: needed for restore-closed-tabs logic
  return (
    <SelectionContext.Provider value={selectionContextValue}>
      <ViewPreferencesProvider tabId={tabId}>
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
        className="graph-editor-dock-container"
        style={{ 
        position: 'relative',
        height: '100%',
          width: '100%',
          overflow: 'hidden'
        }}>
        {/* Window Selector - floating at top center */}
        <WindowSelector />
        
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
              
              // Update sidebar state with current floating panels
              const sidebarFloatingIds = floatingTabIds.filter(id => 
                id === 'what-if-tab' || id === 'properties-tab' || id === 'tools-tab'
              );
              if (JSON.stringify(sidebarFloatingIds.sort()) !== JSON.stringify(sidebarState.floatingPanels.sort())) {
                console.log(`[${new Date().toISOString()}] [GraphEditor] Updating floatingPanels:`, sidebarFloatingIds);
                sidebarOps.updateState({ floatingPanels: sidebarFloatingIds });
              }
              
              // Dynamic closable management: tabs should be closable ONLY when NOT in their home position
              const SIDEBAR_TAB_IDS = ['what-if-tab', 'properties-tab', 'tools-tab'];
              if (dockRef.current) {
                SIDEBAR_TAB_IDS.forEach(tabId => {
                  const tabData = dockRef.current!.find(tabId);
                  // Type guard: ensure it's a TabData (has 'parent' and 'closable' properties)
                  if (tabData && 'parent' in tabData && 'closable' in tabData) {
                    // Check if tab is in its home panel
                    const isAtHome = tabData.parent?.id === 'graph-sidebar-panel';
                    // Closable ONLY when NOT at home (floating or docked elsewhere)
                    const shouldBeClosable = !isAtHome;
                    
                    // Update if changed (avoid unnecessary updates)
                    if (tabData.closable !== shouldBeClosable) {
                      console.log(`[GraphEditor] Tab ${tabId}: closable ${tabData.closable} → ${shouldBeClosable} (isAtHome: ${isAtHome})`);
                      // Update by finding and modifying the tab in the layout
                      (tabData as any).closable = shouldBeClosable;
                    }
                  }
                });
              }
              
              // Save the entire dock layout structure (strip React components and sidebar panel size)
              // This preserves all panel positions (docked AND floating)
              const layoutToSave = JSON.parse(JSON.stringify(newLayout, (key, value) => {
                // Strip out React components
                if (key === 'content') return undefined;
                return value;
              }));
              
              // Remove size from sidebar panel (we manage this separately)
              const stripSidebarSize = (node: any) => {
                if (node.id === 'graph-sidebar-panel') {
                  delete node.size;
                }
                if (node.children) {
                  node.children.forEach(stripSidebarSize);
                }
              };
              if (layoutToSave.dockbox) stripSidebarSize(layoutToSave.dockbox);
              
              // Log floating panel positions being saved
              if (layoutToSave.floatbox?.children) {
                layoutToSave.floatbox.children.forEach((fp: any) => {
                  const tabId = fp.tabs?.[0]?.id;
                  console.log(`[${new Date().toISOString()}] [GraphEditor] Saving position for ${tabId}: x=${fp.x}, y=${fp.y}, w=${fp.w}, h=${fp.h}`);
                });
              }
              
              console.log(`[${new Date().toISOString()}] [GraphEditor] Saving dock layout structure (persisting to IndexedDB)`);
              sidebarOps.updateState({ savedDockLayout: layoutToSave });
              
              // If ALL panels are floating, auto-minimize the sidebar
              if (sidebarFloatingIds.length === 3 && sidebarState.mode === 'maximized') {
                console.log(`[${new Date().toISOString()}] [GraphEditor] All panels floating - auto-minimizing sidebar`);
                sidebarOps.minimize();
              }
              
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
                console.log('[GraphEditor] Current sidebar mode:', sidebarState.mode);
                console.log('[GraphEditor] Current floating panels:', sidebarState.floatingPanels);
                
                if (dockRef.current) {
                  setTimeout(() => {
                    if (!dockRef.current) return;
                    
                    // Get current layout
                    const currentLayout = dockRef.current.getLayout();
                    
              // Find existing sidebar panel
              let sidebarPanel: any = null;
              if (currentLayout.dockbox?.children) {
                for (const child of currentLayout.dockbox.children) {
                  if (child.id === 'graph-sidebar-panel' && 'tabs' in child) {
                    sidebarPanel = child;
                    break;
                  }
                }
              }
              
              // Check if sidebar has any existing sidebar tabs (not just Canvas)
              const existingSidebarTabs = sidebarPanel?.tabs?.filter((t: any) => 
                t.id === 'what-if-tab' || t.id === 'properties-tab' || t.id === 'tools-tab'
              ) || [];
                    
                    if (existingSidebarTabs.length > 0) {
                      // Sidebar already has tabs - just add the missing ones
                      console.log('[GraphEditor] Sidebar has existing tabs, adding missing tabs to it:', missingSidebarTabs);
                      
                      missingSidebarTabs.forEach((tabId: string) => {
                        let component: React.ReactElement | null = null;
                        let title = '';
                        if (tabId === 'what-if-tab') {
                          component = whatIfComponent;
                          title = React.createElement('div', { 
                            className: 'dock-tab-title', 
                            style: { display: 'flex', alignItems: 'center', gap: '6px' } 
                          },
                            React.createElement(Sparkles, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                            React.createElement('span', { 
                              style: { 
                                flex: 1, 
                                minWidth: 0, 
                                overflow: 'hidden', 
                                textOverflow: 'ellipsis', 
                                whiteSpace: 'nowrap' 
                              } 
                            }, 'What-If')
                          ) as any;
                        } else if (tabId === 'properties-tab') {
                          component = propertiesComponent;
                          title = React.createElement('div', { 
                            className: 'dock-tab-title', 
                            style: { display: 'flex', alignItems: 'center', gap: '6px' } 
                          },
                            React.createElement(FileText, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                            React.createElement('span', { 
                              style: { 
                                flex: 1, 
                                minWidth: 0, 
                                overflow: 'hidden', 
                                textOverflow: 'ellipsis', 
                                whiteSpace: 'nowrap' 
                              } 
                            }, 'Props')
                          ) as any;
                        } else if (tabId === 'tools-tab') {
                          component = toolsComponent;
                          title = React.createElement('div', { 
                            className: 'dock-tab-title', 
                            style: { display: 'flex', alignItems: 'center', gap: '6px' } 
                          },
                            React.createElement(Wrench, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                            React.createElement('span', { 
                              style: { 
                                flex: 1, 
                                minWidth: 0, 
                                overflow: 'hidden', 
                                textOverflow: 'ellipsis', 
                                whiteSpace: 'nowrap' 
                              } 
                            }, 'Tools')
                          ) as any;
                        }
                        
                        if (component && sidebarPanel) {
                          sidebarPanel.tabs.push({
                            id: tabId,
                            title: title,
                            content: component,
                            cached: true,
                            closable: false,  // Start as false; dynamic logic will update based on position
                            group: 'graph-panels'
                          });
                        }
                      });
                      
                      // Re-inject components into floating panels
                      const reinjectFloating = (node: any) => {
                        if (node.tabs) {
                          node.tabs.forEach((tab: any) => {
                            if (tab.id === 'what-if-tab') tab.content = whatIfComponent;
                            else if (tab.id === 'properties-tab') tab.content = propertiesComponent;
                            else if (tab.id === 'tools-tab') tab.content = toolsComponent;
                          });
                        }
                        if (node.children) node.children.forEach(reinjectFloating);
                      };
                      if (currentLayout.floatbox) reinjectFloating(currentLayout.floatbox);
                      
                      console.log('[GraphEditor] Reloading layout with added tabs');
                      dockRef.current.loadLayout(currentLayout);
                      dockRef.current.forceUpdate();
                      
                      // Update dockLayout state to trigger ResizeObserver re-initialization
                      setDockLayout(currentLayout);
                      
                    } else {
                      // Sidebar is empty (only Canvas) - rebuild with missing tabs
                      console.log('[GraphEditor] Sidebar is empty, rebuilding with tabs:', missingSidebarTabs);
                      
                      const freshLayout = createLayoutStructure(sidebarState.mode, missingSidebarTabs);
                      
                      // Preserve the floatbox from current layout
                      if (currentLayout.floatbox) {
                        freshLayout.floatbox = currentLayout.floatbox;
                        
                        const reinjectFloating = (node: any) => {
                          if (node.tabs) {
                            node.tabs.forEach((tab: any) => {
                              if (tab.id === 'what-if-tab') tab.content = whatIfComponent;
                              else if (tab.id === 'properties-tab') tab.content = propertiesComponent;
                              else if (tab.id === 'tools-tab') tab.content = toolsComponent;
                            });
                          }
                          if (node.children) node.children.forEach(reinjectFloating);
                        };
                        reinjectFloating(freshLayout.floatbox);
                      }
                      
                      console.log('[GraphEditor] Loading fresh layout');
                      dockRef.current.loadLayout(freshLayout);
                      dockRef.current.forceUpdate();
                      
                      // Update dockLayout state to trigger ResizeObserver re-initialization
                      setDockLayout(freshLayout);
                    }
                  }, 0);
                }
              }
            }}
          />
        )}

        {/* Icon Bar - when minimized */}
        {sidebarState.mode === 'minimized' && (
          <div style={{ 
            position: 'absolute',
            top: 0,
            right: 0,
            height: '100%',
            width: '48px',
            background: '#F9FAFB',
            borderLeft: '1px solid #E5E7EB',
            zIndex: 100,
            pointerEvents: 'auto'
          }}>
            <SidebarIconBar
              state={sidebarState}
              onIconClick={handleIconClick}
              onIconHover={handleIconHover}
            />
          </div>
        )}
        
        {/* Hover Preview Panel - shows when hovering over icons */}
        {sidebarState.mode === 'minimized' && hoveredPanel && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: '48px',
              bottom: 0,
              width: '350px',
              zIndex: 99,
              pointerEvents: 'auto'
            }}
            onMouseLeave={() => {
              console.log(`[${new Date().toISOString()}] [GraphEditor] Hover panel onMouseLeave - clearing hover if not locked`);
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

        {/* Toggle Button - visible in both minimized and maximized states */}
        {/* Disabled if all panels are floating (sidebar is empty) */}
        {sidebarState.floatingPanels.length < 3 && (
        <button
          onClick={() => {
            console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Minimize button clicked (current mode: ${sidebarState.mode})`);
            if (sidebarState.mode === 'minimized') {
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Calling maximize()`);
              sidebarOps.maximize();
            } else {
              console.log(`[${new Date().toISOString()}] [GraphEditor ${fileId}] Calling minimize()`);
              sidebarOps.minimize();
            }
          }}
          className={`graph-minimize-button${sidebarState.isResizing ? ' resizing' : ''}`}
          style={{
            position: 'absolute',
            right: sidebarState.mode === 'maximized' 
              ? `${sidebarState.sidebarWidth ?? 300}px` 
              : '48px', // When minimized, position at icon bar
              top: splitterCenterY > 0 ? `${splitterCenterY}px` : '50%',
            transform: 'translateY(-50%)',
            zIndex: 10, // Lower than Monaco widgets but above normal content
          }}
          title={sidebarState.mode === 'minimized' ? 'Show Sidebar (Ctrl/Cmd + B)' : 'Hide Sidebar (Ctrl/Cmd + B)'}
        >
          {sidebarState.mode === 'minimized' ? '◀' : '▶'}
        </button>
      )}

        {/* Selector Modal - overlays entire graph window */}
        {selectorModalConfig && (
          <SelectorModal
            isOpen={true}
            onClose={() => setSelectorModalConfig(null)}
            type={selectorModalConfig.type}
            items={selectorModalConfig.items}
            currentValue={selectorModalConfig.currentValue}
            onSelect={(value) => {
              selectorModalConfig.onSelect(value);
              setSelectorModalConfig(null);
            }}
            onOpenItem={selectorModalConfig.onOpenItem}
          />
        )}
    </div>
      </WhatIfProvider>
      </ViewPreferencesProvider>
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

