import React, { useState, useEffect, useMemo } from 'react';
import DockLayout, { LayoutData } from 'rc-dock';
import { TabProvider, useTabContext, fileRegistry } from './contexts/TabContext';
import { NavigatorProvider, useNavigatorContext } from './contexts/NavigatorContext';
import { DialogProvider, useDialog } from './contexts/DialogContext';
import { ValidationProvider } from './contexts/ValidationContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { fileOperationsService } from './services/fileOperationsService';
import { repositoryOperationsService } from './services/repositoryOperationsService';
import { MenuBar } from './components/MenuBar';
import { NavigatorContent } from './components/Navigator';
import { TabContextMenu } from './components/TabContextMenu';
import { CommitModal } from './components/CommitModal';
import { gitService } from './services/gitService';
import { getEditorComponent } from './components/editors';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { layoutService } from './services/layoutService';
import { dockGroups } from './layouts/defaultLayout';
import { db } from './db/appDatabase';
import 'rc-dock/dist/rc-dock.css'; // Import rc-dock base styles
import './styles/dock-theme.css'; // Safe customizations
import './styles/active-tab-highlight.css'; // Active tab highlighting
import './styles/file-state-indicators.css'; // File state visual indicators

/**
 * App Shell Content
 * 
 * Main application shell with rc-dock layout
 * Integrates all components: Menu, Navigator, Tabs, Editors
 */
function AppShellContent() {
  const { tabs, activeTabId, operations: tabOperations } = useTabContext();
  const { state: navState, operations: navOperations } = useNavigatorContext();
  const dialogOps = useDialog();
  const [dockLayoutRef, setDockLayoutRef] = useState<DockLayout | null>(null);
  
  // Initialize services once
  useEffect(() => {
    fileOperationsService.initialize({
      navigatorOps: navOperations,
      tabOps: tabOperations,
      dialogOps
    });
    
    repositoryOperationsService.initialize({
      navigatorOps: navOperations
    });
    
    console.log('✅ Services initialized');
  }, [navOperations, tabOperations, dialogOps]);

  console.log('AppShell render - navState:', navState);
  
  // Track hover state for unpinned navigator
  const [isHovering, setIsHovering] = useState(false);
  const navButtonRef = React.useRef<HTMLDivElement>(null);
  
  // Navigator resizing - load from localStorage or default to 280
  const [navWidth, setNavWidth] = useState(() => {
    const saved = localStorage.getItem('navigator-width');
    return saved ? parseInt(saved, 10) : 280;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = React.useRef(0);
  const resizeStartWidth = React.useRef(0);
  
  // Handle navigator resizing with proper mouse tracking
  useEffect(() => {
    if (!isResizing) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Calculate delta from start position
      const delta = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + delta;
      
      // Apply constraints
      const MIN_WIDTH = 200;
      const MAX_WIDTH = 800;
      const constrainedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));
      
      setNavWidth(constrainedWidth);
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
      // Save to localStorage
      localStorage.setItem('navigator-width', navWidth.toString());
      // Re-enable text selection
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    
    // Disable text selection and set cursor during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, navWidth]);

  // Tab context menu state
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  
  // Commit modal state (lifted to AppShell to persist when context menu closes)
  const [commitModalState, setCommitModalState] = useState<{
    isOpen: boolean;
    preselectedFiles: string[];
  }>({ isOpen: false, preselectedFiles: [] });

  // Custom groups - NO panelExtra, we'll position Navigator separately
  const customGroups = useMemo(() => ({
    ...dockGroups
  }), []);

  // Enable keyboard shortcuts
  useKeyboardShortcuts();

  // Track which tabs we've already added to rc-dock
  const [addedTabs, setAddedTabs] = React.useState<Set<string>>(new Set());

  // Track tabs we're currently removing to prevent duplicate removal attempts
  const removingTabsRef = React.useRef<Set<string>>(new Set());

  // Helper to extract all tab IDs from a layout - MUST BE DEFINED BEFORE USE
  const extractTabIds = React.useCallback((layout: LayoutData): string[] => {
    const tabIdSet = new Set<string>();
    
    const extractFromBox = (box: any) => {
      if (!box) return;
      
      // Only process tabs if this box has them directly
      if (box.tabs && Array.isArray(box.tabs)) {
        box.tabs.forEach((tab: any) => {
          if (tab.id) tabIdSet.add(tab.id);
        });
      }
      
      // Recurse into children (panels/boxes, not tabs)
      if (box.children && Array.isArray(box.children)) {
        box.children.forEach((child: any) => {
          // Only recurse if child is a box/panel, not a tab
          if (child && typeof child === 'object' && !child.content) {
            extractFromBox(child);
          }
        });
      }
    };
    
    if (layout.dockbox) extractFromBox(layout.dockbox);
    if (layout.floatbox) extractFromBox(layout.floatbox);
    
    return Array.from(tabIdSet);
  }, []);

  // Add global context menu handler for tabs
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      console.log('=== RIGHT CLICK DEBUG ===');
      console.log('Target:', target.tagName, target.className);
      
      // rc-dock uses role="tab" for tabs
      const roleTab = target.closest('[role="tab"]');
      
      if (roleTab) {
        // Look for our custom data-tab-id attribute in the title div
        const titleDiv = roleTab.querySelector('[data-tab-id]') as HTMLElement;
        const tabId = titleDiv?.getAttribute('data-tab-id');
        
        console.log('Found tab:', {
          foundRoleTab: true,
          foundTitleDiv: !!titleDiv,
          tabId,
          existsInTabs: tabId ? !!tabs.find(t => t.id === tabId) : false
        });
        
        if (tabId && tabs.find(t => t.id === tabId)) {
          e.preventDefault();
          e.stopPropagation();
          
          console.log('✅ SHOWING CONTEXT MENU for', tabId);
          
          setContextMenu({
            tabId,
            x: e.clientX,
            y: e.clientY
          });
        } else {
          console.log('❌ No matching tab found');
        }
      } else {
        console.log('❌ No [role="tab"] found');
      }
    };

    document.addEventListener('contextmenu', handleContextMenu, true);
    return () => document.removeEventListener('contextmenu', handleContextMenu, true);
  }, [tabs]);

  // Track which panel each tab is in for smart placement
  const tabPanelMapRef = React.useRef<Map<string, string>>(new Map());

  // Sync tabs to rc-dock when they change
  useEffect(() => {
    if (!dockLayoutRef) return;

    const currentLayout = dockLayoutRef.getLayout();
    const currentTabIds = extractTabIds(currentLayout);

    // Update panel map - track which panel each tab is in
    const updatePanelMap = (box: any, panelId?: string) => {
      if (!box) return;
      if (box.tabs && Array.isArray(box.tabs)) {
        box.tabs.forEach((tab: any) => {
          if (tab.id && box.id) {
            tabPanelMapRef.current.set(tab.id, box.id);
          }
        });
      }
      if (box.children) {
        box.children.forEach((child: any) => updatePanelMap(child, child.id));
      }
    };
    if (currentLayout.dockbox) updatePanelMap(currentLayout.dockbox);

    tabs.forEach(tab => {
      const isInLayout = currentTabIds.includes(tab.id);
      const hasBeenAdded = addedTabs.has(tab.id);
      
      if (isInLayout && !hasBeenAdded) {
        // Tab exists in layout (placeholder from loadTab) - UPDATE with real content
        console.log(`AppShell: Updating placeholder tab ${tab.id} with real content`);
        const EditorComponent = getEditorComponent(tab.fileId.split('-')[0] as any, tab.viewMode);
        
        const realTab = {
          id: tab.id,
          title: (
            <div 
              style={{ display: 'flex', alignItems: 'center', width: '100%' }}
              data-tab-id={tab.id}
              data-is-focused="false"
              data-is-dirty="false"
              onClick={() => tabOperations.switchTab(tab.id)}
            >
              <span style={{ flex: 1 }}>{tab.title}</span>
              <div
                className="custom-tab-close-btn"
                onClick={async (e) => {
                  e.stopPropagation();
                  await tabOperations.closeTab(tab.id);
                }}
                style={{
                  width: '14px',
                  height: '14px',
                  marginLeft: '8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '2px',
                  fontSize: '10px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                ✕
              </div>
            </div>
          ),
          content: (
            <div 
              onClick={() => tabOperations.switchTab(tab.id)}
              style={{ width: '100%', height: '100%' }}
            >
              <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} tabId={tab.id} onChange={() => {}} />
            </div>
          ),
          closable: false,
          cached: true,
          group: 'main-content'
        };
        
        // Update the placeholder with real content
        dockLayoutRef.updateTab(tab.id, realTab, false);
        setAddedTabs(prev => new Set([...prev, tab.id]));
        
      } else if (!isInLayout && !hasBeenAdded) {
        // New tab not in layout - ADD to rc-dock
        console.log(`AppShell: Adding new tab ${tab.id} to rc-dock`);
        const EditorComponent = getEditorComponent(tab.fileId.split('-')[0] as any, tab.viewMode);
        
        const dockTab = {
          id: tab.id,
          title: (
            <div 
              style={{ display: 'flex', alignItems: 'center', width: '100%' }}
              data-tab-id={tab.id}
              data-is-focused="false"
              data-is-dirty="false"
              onClick={() => tabOperations.switchTab(tab.id)}
            >
              {tab.icon && <span style={{ marginRight: '6px', fontSize: '14px' }}>{tab.icon}</span>}
              <span style={{ flex: 1 }}>{tab.title}</span>
              <div
                className="custom-tab-close-btn"
                onClick={async (e) => {
                  e.stopPropagation();
                  await tabOperations.closeTab(tab.id);
                }}
                style={{
                  width: '14px',
                  height: '14px',
                  marginLeft: '8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '2px',
                  fontSize: '10px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                ✕
              </div>
            </div>
          ),
          content: (
            <div 
              onClick={() => tabOperations.switchTab(tab.id)}
              style={{ width: '100%', height: '100%' }}
            >
              <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} tabId={tab.id} onChange={() => {}} />
            </div>
          ),
          closable: false,
          cached: true,
          group: 'main-content'
        };

        // Determine target panel: use currently active tab's panel, or default to 'main-tabs'
        let targetPanel = 'main-tabs';
        if (activeTabId) {
          const activeTabData = dockLayoutRef.find(activeTabId);
          const activePanel = activeTabData?.parent?.id;
          if (activePanel && activePanel !== 'menu' && activePanel !== 'navigator') {
            targetPanel = activePanel;
            console.log(`AppShell: Opening new tab in focused panel: ${targetPanel}`);
          }
        }

        dockLayoutRef.dockMove(dockTab, targetPanel, 'middle');
        setAddedTabs(prev => new Set([...prev, tab.id]));
      }
    });
  }, [tabs, dockLayoutRef, addedTabs, tabOperations, extractTabIds]);

  // Listen for "open in same panel" events
  useEffect(() => {
    const handleOpenInSamePanel = (e: CustomEvent) => {
      const { newTabId, sourceTabId } = e.detail;
      
      if (!dockLayoutRef) return;
      
      console.log(`\n=== OPEN IN SAME PANEL ===`);
      console.log('Source tab:', sourceTabId);
      console.log('New tab:', newTabId);
      console.log('Panel map:', Object.fromEntries(tabPanelMapRef.current));
      
      // Find source tab in rc-dock to get its panel
      const sourceTabData = dockLayoutRef.find(sourceTabId);
      console.log('Source tab data:', sourceTabData);
      console.log('Source tab parent:', sourceTabData?.parent);
      
      const sourcePanel = sourceTabData?.parent?.id;
      console.log('Source panel ID:', sourcePanel);
      
      if (sourcePanel) {
        // Wait for the tab to be added, then move it
        setTimeout(() => {
          const tabData = dockLayoutRef.find(newTabId);
          console.log('Found new tab:', !!tabData);
          if (tabData && ('title' in tabData && 'content' in tabData)) {
            console.log(`Moving ${newTabId} to panel ${sourcePanel}`);
            dockLayoutRef.dockMove(tabData, sourcePanel, 'middle');
          }
        }, 200);
      }
    };
    
    const handleOpenInFocusedPanel = (e: CustomEvent) => {
      const { newTabFileId } = e.detail;
      
      if (!dockLayoutRef || !activeTabId) return;
      
      console.log(`\n=== OPEN IN FOCUSED PANEL ===`);
      console.log('Focused tab:', activeTabId);
      console.log('New file:', newTabFileId);
      
      // Find focused tab in rc-dock to get its panel
      const focusedTabData = dockLayoutRef.find(activeTabId);
      console.log('Focused tab data:', focusedTabData);
      console.log('Focused tab parent:', focusedTabData?.parent);
      
      const focusedPanel = focusedTabData?.parent?.id;
      console.log('Focused panel ID:', focusedPanel);
      
      if (focusedPanel) {
        // Find the new tab (it was just added)
        setTimeout(() => {
          const newTab = tabs.find(t => t.fileId === newTabFileId);
          console.log('Found new tab in tabs array:', newTab?.id);
          if (newTab) {
            const tabData = dockLayoutRef.find(newTab.id);
            console.log('Found new tab in rc-dock:', !!tabData);
            if (tabData && ('title' in tabData && 'content' in tabData)) {
              console.log(`Moving ${newTab.id} to panel ${focusedPanel}`);
              dockLayoutRef.dockMove(tabData, focusedPanel, 'middle');
            }
          }
        }, 200);
      }
    };

    window.addEventListener('dagnet:openInSamePanel' as any, handleOpenInSamePanel);
    window.addEventListener('dagnet:openInFocusedPanel' as any, handleOpenInFocusedPanel);
    return () => {
      window.removeEventListener('dagnet:openInSamePanel' as any, handleOpenInSamePanel);
      window.removeEventListener('dagnet:openInFocusedPanel' as any, handleOpenInFocusedPanel);
    };
  }, [dockLayoutRef, activeTabId, tabs]);

  // Listen for tab close events to immediately remove from rc-dock
  useEffect(() => {
    const handleTabClosed = (e: CustomEvent) => {
      const tabId = e.detail.tabId;
      
      // Prevent duplicate removal
      if (removingTabsRef.current.has(tabId)) {
        console.log(`AppShell: Tab ${tabId} already being removed, skipping`);
        return;
      }
      
      console.log(`\n=== RC-DOCK REMOVAL: ${tabId} ===`);
      removingTabsRef.current.add(tabId);
      
      if (dockLayoutRef) {
        // Find the actual tab in rc-dock's layout
        const tabData = dockLayoutRef.find(tabId);
        console.log('AppShell: Found tab in rc-dock:', !!tabData, tabData);
        
        if (tabData && ('title' in tabData && 'content' in tabData)) {
          console.log('AppShell: Calling dockMove to REMOVE tab');
          dockLayoutRef.dockMove(tabData, null, 'remove');
          console.log('AppShell: ✅ Tab removed from rc-dock');
        } else {
          console.warn('AppShell: ⚠️ Tab not found in rc-dock layout, cannot remove');
        }
        
        setAddedTabs(prev => {
          const next = new Set(prev);
          next.delete(tabId);
          console.log(`AppShell: addedTabs: ${prev.size} -> ${next.size}`);
          return next;
        });
      }
      
      // Clear from removing set
      setTimeout(() => {
        removingTabsRef.current.delete(tabId);
      }, 100);
    };

    window.addEventListener('dagnet:tabClosed' as any, handleTabClosed);
    return () => window.removeEventListener('dagnet:tabClosed' as any, handleTabClosed);
  }, [dockLayoutRef]);

  // Sync activeTabId FROM React TO rc-dock (when programmatically changed)
  useEffect(() => {
    if (!dockLayoutRef || !activeTabId) return;
    
    console.log(`AppShell: Syncing activeTabId to rc-dock: ${activeTabId}`);
    
    // Find the tab in rc-dock layout
    const tabData = dockLayoutRef.find(activeTabId);
    if (!tabData || !('title' in tabData && 'content' in tabData)) {
      console.log(`AppShell: Tab ${activeTabId} not found in rc-dock layout`);
      return;
    }
    
    // Use rc-dock's updateTab to force it to be active
    // This is the proper way to programmatically select a tab in rc-dock
    dockLayoutRef.updateTab(activeTabId, tabData, true);
    console.log(`AppShell: ✅ Selected tab ${activeTabId} in rc-dock`);
  }, [activeTabId, dockLayoutRef]);
  
  // Update data-is-focused and data-is-dirty attributes via DOM
  useEffect(() => {
    const updateTabIndicators = () => {
      document.querySelectorAll('[data-tab-id]').forEach(elem => {
        const tabId = elem.getAttribute('data-tab-id');
        if (!tabId) return;
        
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;
        
        const file = fileRegistry.getFile(tab.fileId);
        
        const isFocused = tabId === activeTabId;
        const isDirty = file?.isDirty || false;
        
        elem.setAttribute('data-is-focused', isFocused ? 'true' : 'false');
        elem.setAttribute('data-is-dirty', isDirty ? 'true' : 'false');
      });
    };
    
    updateTabIndicators();
    
    // Listen for dirty state changes
    const handleDirtyChanged = () => {
      console.log('AppShell: File dirty state changed, updating indicators');
      updateTabIndicators();
    };
    
    window.addEventListener('dagnet:fileDirtyChanged' as any, handleDirtyChanged);
    return () => window.removeEventListener('dagnet:fileDirtyChanged' as any, handleDirtyChanged);
  }, [activeTabId, tabs]);

  // Create default layout
  const defaultLayout: LayoutData = useMemo(() => ({
    dockbox: {
      mode: 'horizontal',
      children: [
        {
          id: 'main-tabs',
          group: 'main-content',
          tabs: [],
          panelLock: {}
        }
      ]
    },
    floatbox: {
      mode: 'float',
      children: []
    }
  }), []);

  // Load saved layout with graceful fallback
  const [layout, setLayout] = React.useState<LayoutData>(defaultLayout);
  const [layoutLoaded, setLayoutLoaded] = React.useState(false);
  
  React.useEffect(() => {
    const loadSavedLayout = async () => {
      try {
        const savedLayout = await layoutService.loadLayout();
        if (savedLayout && savedLayout.dockbox) {
          console.log('Loaded saved layout from IndexedDB');
          setLayout(savedLayout);
        } else {
          console.log('No saved layout, using default');
          setLayout(defaultLayout);
        }
      } catch (error) {
        console.error('Failed to load layout, using default:', error);
        setLayout(defaultLayout);
      } finally {
        setLayoutLoaded(true);
      }
    };
    
    loadSavedLayout();
  }, [defaultLayout]);

  // Track previous layout to detect tab closes
  const prevLayoutRef = React.useRef<LayoutData | null>(null);

  // Load tab callback - rc-dock uses this to hydrate saved layout tabs
  const loadTab = React.useCallback((savedTab: any) => {
    try {
      // savedTab can be either a string (tab ID) or an object with { id: ... }
      const tabId = typeof savedTab === 'string' ? savedTab : savedTab?.id;
      
      console.log('loadTab called with:', savedTab, 'extracted tabId:', tabId);
      
      if (!tabId) {
        console.warn('loadTab: No tab ID provided, returning placeholder');
        return {
          id: 'placeholder',
          title: 'Invalid Tab',
          content: <div>Invalid tab ID</div>,
          closable: false,
          cached: false
        };
      }
      
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
        console.warn(`loadTab: Tab ${tabId} not found in TabContext (have ${tabs.length} tabs), will be added later`);
        // Return minimal tab data to prevent crash
        // The actual tab will be added when TabContext loads it
        return {
          id: tabId,
          title: 'Loading...',
          content: <div>Loading tab...</div>,
          closable: false,
          cached: false
        };
      }
      
      const EditorComponent = getEditorComponent(tab.fileId.split('-')[0] as any, tab.viewMode);
      
      // Return full TabData with content
      return {
        id: tab.id,
        title: (
          <div 
            style={{ display: 'flex', alignItems: 'center', width: '100%' }}
            data-tab-id={tab.id}
            data-is-focused={tab.id === activeTabId ? 'true' : 'false'}
            onClick={() => {
              console.log('Tab title clicked (from loadTab), setting active:', tab.id);
              tabOperations.switchTab(tab.id);
            }}
          >
            <span style={{ flex: 1 }}>{tab.title}</span>
            <div
              className="custom-tab-close-btn"
              onClick={async (e) => {
                e.stopPropagation();
                console.log('Custom close button clicked for', tab.id);
                const closed = await tabOperations.closeTab(tab.id);
                if (!closed) {
                  console.log('Tab close was cancelled, keeping tab');
                }
              }}
              style={{
                width: '14px',
                height: '14px',
                marginLeft: '8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '2px',
                fontSize: '10px'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              ✕
            </div>
          </div>
        ),
        content: (
          <div 
            onClick={() => {
              console.log('Tab content clicked (from loadTab), setting active:', tab.id);
              tabOperations.switchTab(tab.id);
            }}
            style={{ width: '100%', height: '100%' }}
          >
            <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} onChange={() => {}} />
          </div>
        ),
        closable: false,
        cached: true,
        group: 'main-content'
      };
    } catch (error) {
      console.error('loadTab: Error loading tab:', error);
      // Return placeholder to prevent crash
      return {
        id: 'error-tab',
        title: 'Error',
        content: <div>Failed to load tab</div>,
        closable: true,
        cached: false
      };
    }
  }, [tabs, tabOperations]);

  // Track if we're in the middle of updating tabs to prevent loops
  const isUpdatingTabsRef = React.useRef(false);

  // Save layout to IndexedDB when it changes
  const handleLayoutChange = React.useCallback((newLayout: LayoutData, currentTabId?: string) => {
    console.log('AppShell: handleLayoutChange called, currentTabId:', currentTabId);
    
    // Update active tab when rc-dock changes active tab (when user clicks tabs)
    // BUT don't do this if we're in the middle of updating tabs (prevents infinite loop)
    if (currentTabId && currentTabId !== activeTabId && !isUpdatingTabsRef.current) {
      console.log('AppShell: rc-dock switched active tab to:', currentTabId);
      tabOperations.switchTab(currentTabId);
    } else if (isUpdatingTabsRef.current) {
      console.log('AppShell: Ignoring layout change during tab update (preventing loop)');
    }

    if (!prevLayoutRef.current) {
      console.log('AppShell: First layout change, setting prevLayoutRef');
      prevLayoutRef.current = newLayout;
      return;
    }

      const prevTabIds = extractTabIds(prevLayoutRef.current);
      const newTabIds = extractTabIds(newLayout);
    
      console.log('AppShell: Previous tab IDs:', prevTabIds);
      console.log('AppShell: New tab IDs:', newTabIds);
      
    // Find tabs that were closed (in prev but not in new)
      const closedTabIds = prevTabIds.filter(id => !newTabIds.includes(id));
      
      if (closedTabIds.length > 0) {
      console.log('AppShell: Tabs removed from rc-dock:', closedTabIds);
      // These were already removed by our custom close button
      // Just clean up tracking
      setAddedTabs(prev => {
        const next = new Set(prev);
        closedTabIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      console.log('AppShell: No tabs closed');
    }

    prevLayoutRef.current = newLayout;

    // Debounce save to IndexedDB
    setTimeout(() => {
      layoutService.saveLayout(newLayout);
    }, 1000);
  }, [extractTabIds, tabOperations, activeTabId]);

  return (
    <div className={`app-shell ${navState.isPinned ? 'nav-pinned' : 'nav-unpinned'}`} style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
      {/* Menu bar */}
      <div style={{ height: '40px', borderBottom: '1px solid #e0e0e0', flexShrink: 0, boxSizing: 'border-box' }}>
        <MenuBar />
      </div>
      
      {/* Content area - flex layout for dynamic navigator width */}
      <div style={{ 
        flex: 1, 
        display: 'flex',
        flexDirection: 'row',
        position: 'relative', 
        overflow: 'hidden',
        boxSizing: 'border-box',
        minHeight: 0
      }}>
        {/* Navigator button - ONLY when unpinned */}
        {!navState.isPinned && (
          <div 
            ref={navButtonRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              height: '36px',
              padding: '8px 16px',
              background: '#ffffff',
              border: 'none',
              borderRight: '1px solid #e0e0e0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              zIndex: 10, // Behind menu bar dropdowns
              cursor: 'pointer',
              userSelect: 'none',
              boxSizing: 'border-box',
              color: '#666'
            }}
            onClick={() => navOperations.togglePin()}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            <span style={{ fontSize: '12px', lineHeight: 1 }}>▶</span>
            <span style={{ fontSize: '13px', fontWeight: 400, lineHeight: 1 }}>Navigator</span>
          </div>
        )}
        
        {/* Navigator panel - when pinned */}
        {navState.isPinned && (
          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            borderRight: isResizing ? '2px solid #0066cc' : '1px solid #e0e0e0',
            background: '#f8f9fa',
            overflow: 'hidden',
            position: 'relative',
            boxSizing: 'border-box',
            width: `${navWidth}px`,
            minWidth: '200px',
            maxWidth: '800px',
            flexShrink: 0,
            transition: isResizing ? 'none' : 'width 0.1s ease-out'
          }}>
            {/* Navigator header - same height as tab bar */}
            <div style={{
              height: '36px',
              padding: '8px 12px',
              background: '#f8f9fa',
              borderBottom: '1px solid #e0e0e0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              userSelect: 'none',
              flexShrink: 0,
              boxSizing: 'border-box',
              overflow: 'hidden', // Prevent text overflow
              whiteSpace: 'nowrap' // Keep text on one line
            }}
            onClick={() => navOperations.togglePin()}
            >
              <span style={{ fontSize: '12px', lineHeight: 1, flexShrink: 0 }}>▼</span>
              <span style={{ 
                fontSize: '13px', 
                fontWeight: 500, 
                lineHeight: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>Navigator</span>
            </div>
            
            {/* Navigator content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <NavigatorContent />
            </div>
            
            {/* Resize handle - always visible with subtle border */}
            <div 
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Capture starting positions
                resizeStartX.current = e.clientX;
                resizeStartWidth.current = navWidth;
                setIsResizing(true);
              }}
              style={{
                position: 'absolute',
                right: '0',
                top: 0,
                bottom: 0,
                width: '3px',
                cursor: 'col-resize',
                background: isResizing ? '#0066cc' : 'transparent',
                borderLeft: isResizing ? 'none' : '1px solid #e0e0e0',
                zIndex: 1, // Low z-index so context menus appear above it
                transition: isResizing ? 'none' : 'background 0.2s, border 0.2s'
              }}
              onMouseEnter={(e) => {
                if (!isResizing) {
                  e.currentTarget.style.background = 'rgba(0, 102, 204, 0.3)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isResizing) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
              title="Drag to resize Navigator"
            />
          </div>
        )}
        
        {/* Navigator panel - overlay when unpinned + hovering */}
        {!navState.isPinned && isHovering && (
          <div 
            style={{ 
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '240px',
              borderRight: '1px solid #e0e0e0',
              background: '#f8f9fa',
              zIndex: 10, // Behind menu bar (which is z-index: 1000+)
              boxShadow: '4px 0 16px rgba(0, 0, 0, 0.2)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            {/* Header in overlay */}
            <div style={{
              height: '36px',
              padding: '8px 12px',
              background: '#f8f9fa',
              borderBottom: '1px solid #e0e0e0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              userSelect: 'none',
              flexShrink: 0,
              boxSizing: 'border-box'
            }}
            onClick={() => navOperations.togglePin()}
            >
              <span style={{ fontSize: '12px', lineHeight: 1 }}>▼</span>
              <span style={{ fontSize: '13px', fontWeight: 500, lineHeight: 1 }}>Navigator</span>
              <span 
                style={{ marginLeft: 'auto', fontSize: '12px', cursor: 'pointer', padding: '4px', lineHeight: 1 }}
                onClick={(e) => { e.stopPropagation(); navOperations.togglePin(); }}
                title="Pin"
              >
                📍
              </span>
            </div>
            
            {/* Content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <NavigatorContent />
            </div>
          </div>
        )}
        
        {/* rc-dock wrapper - takes remaining flex space */}
        {layoutLoaded && (
          <div style={{
            flex: 1,
            minWidth: 0,
            height: '100%',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <DockLayout
              ref={setDockLayoutRef}
              defaultLayout={layout}
              loadTab={loadTab}
              onLayoutChange={handleLayoutChange}
              groups={customGroups}
              style={{ 
                width: '100%',
                height: '100%'
              }}
            />
            
            {/* Welcome screen when no tabs - positioned BEHIND dock panels */}
            {tabs.length === 0 && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: '0',
                right: 0,
                bottom: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#fafafa',
                zIndex: 0, /* Behind everything */
                pointerEvents: 'auto' // Allow clicking on links
              }}>
                <h1 style={{ fontSize: '32px', marginBottom: '16px', color: '#333' }}>DagNet</h1>
                <p style={{ fontSize: '14px', marginBottom: '24px', color: '#666' }}>Conversion Graph Editor</p>
                <p style={{ fontSize: '12px', color: '#999' }}>Open a file from the Navigator to get started</p>
                <p style={{ fontSize: '11px', color: '#aaa', marginTop: '40px' }}>
                  <a href="mailto:greg@nous.co" style={{ color: '#aaa', textDecoration: 'none' }}>
                    greg@nous.co
                  </a> for support
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tab Context Menu */}
        {contextMenu && (
          <TabContextMenu
            tabId={contextMenu.tabId}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onRequestCommit={(preselectedFiles) => {
              setCommitModalState({ isOpen: true, preselectedFiles });
              setContextMenu(null); // Close context menu
            }}
          />
        )}

        {/* Commit Modal - at AppShell level so it persists when context menu closes */}
        {commitModalState.isOpen && (
          <CommitModal
            isOpen={commitModalState.isOpen}
            onClose={() => setCommitModalState({ isOpen: false, preselectedFiles: [] })}
            onCommit={async (files, message, branch) => {
              // Load credentials and commit files
              const { credentialsManager } = await import('./lib/credentials');
              const credentialsResult = await credentialsManager.loadCredentials();
              
              if (!credentialsResult.success || !credentialsResult.credentials) {
                throw new Error('No credentials available. Please configure credentials first.');
              }

              const selectedRepo = navState.selectedRepo;
              const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === selectedRepo);
              
              if (!gitCreds) {
                throw new Error(`No credentials found for repository ${selectedRepo}`);
              }

              const credentialsWithRepo = {
                ...credentialsResult.credentials,
                defaultGitRepo: selectedRepo
              };
              gitService.setCredentials(credentialsWithRepo);

              const filesToCommit = files.map(file => {
                const basePath = gitCreds.basePath || '';
                const fullPath = basePath ? `${basePath}/${file.path}` : file.path;
                return {
                  path: fullPath,
                  content: file.content,
                  sha: file.sha
                };
              });

              const result = await gitService.commitAndPushFiles(filesToCommit, message, branch);
              if (result.success) {
                console.log('Commit successful:', result.message);
                for (const file of files) {
                  await fileRegistry.markSaved(file.fileId);
                }
              } else {
                throw new Error(result.error || 'Failed to commit files');
              }
            }}
            preselectedFiles={commitModalState.preselectedFiles}
          />
        )}
      </div>
    </div>
  );
}

/**
 * App Shell with Providers
 */
export function AppShell() {
  // Check for ?clear or ?clearall parameters to force state reset
  React.useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    
    if (urlParams.has('clearall')) {
      console.warn('🗑️ CLEARING ALL DATA AND SETTINGS due to ?clearall parameter');
      db.clearAllIncludingSettings()
        .then(() => {
          console.log('✅ All data and settings cleared successfully');
          // Remove the ?clearall parameter from URL
          const newUrl = window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
          // Reload to start fresh
          window.location.reload();
        })
        .catch(error => {
          console.error('❌ Failed to clear all data and settings:', error);
        });
    } else if (urlParams.has('clear')) {
      console.warn('🗑️ CLEARING ALL LOCAL STATE due to ?clear parameter');
      db.clearAll()
        .then(() => {
          console.log('✅ Local state cleared successfully');
          // Remove the ?clear parameter from URL
          const newUrl = window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
          // Reload to start fresh
          window.location.reload();
        })
        .catch(error => {
          console.error('❌ Failed to clear local state:', error);
        });
    }
  }, []);

  return (
    <ErrorBoundary>
      <DialogProvider>
        <ValidationProvider>
          <TabProvider>
            <NavigatorProvider>
              <AppShellContent />
            </NavigatorProvider>
          </TabProvider>
        </ValidationProvider>
      </DialogProvider>
    </ErrorBoundary>
  );
}

