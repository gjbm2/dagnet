import React, { useState, useEffect, useMemo } from 'react';
import DockLayout, { LayoutData } from 'rc-dock';
import { TabProvider, useTabContext } from './contexts/TabContext';
import { NavigatorProvider, useNavigatorContext } from './contexts/NavigatorContext';
import { DialogProvider } from './contexts/DialogContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MenuBar } from './components/MenuBar';
import { NavigatorContent } from './components/Navigator';
import { getEditorComponent } from './components/editors';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { layoutService } from './services/layoutService';
import { dockGroups } from './layouts/defaultLayout';
import { db } from './db/appDatabase';
import 'rc-dock/dist/rc-dock.css'; // Import rc-dock base styles
import './styles/dock-theme.css'; // Safe customizations

/**
 * App Shell Content
 * 
 * Main application shell with rc-dock layout
 * Integrates all components: Menu, Navigator, Tabs, Editors
 */
function AppShellContent() {
  const { tabs, activeTabId, operations: tabOperations } = useTabContext();
  const { state: navState, operations: navOperations } = useNavigatorContext();
  const [dockLayoutRef, setDockLayoutRef] = useState<DockLayout | null>(null);

  console.log('AppShell render - navState:', navState);
  
  // Track hover state for unpinned navigator
  const [isHovering, setIsHovering] = useState(false);
  const navButtonRef = React.useRef<HTMLDivElement>(null);

  // Custom groups - NO panelExtra, we'll position Navigator separately
  const customGroups = useMemo(() => ({
    ...dockGroups
  }), []);

  // Enable keyboard shortcuts
  useKeyboardShortcuts();

  // Track which tabs we've already added to rc-dock
  const [addedTabs, setAddedTabs] = React.useState<Set<string>>(new Set());

  // Sync tabs to rc-dock when they change
  useEffect(() => {
    if (!dockLayoutRef) return;

    // Only add NEW tabs that haven't been added yet
    tabs.forEach(tab => {
      if (!addedTabs.has(tab.id)) {
        const EditorComponent = getEditorComponent(tab.fileId.split('-')[0] as any, tab.viewMode);
        
        const dockTab = {
          id: tab.id,
          title: tab.title,
          content: <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} />,
          closable: true,
          cached: true,
          group: 'main-content' // Assign to main-content group
        };

        // Add tab to main-tabs panel
        dockLayoutRef.dockMove(dockTab, 'main-tabs', 'middle');
        
        // Mark as added
        setAddedTabs(prev => new Set([...prev, tab.id]));
      }
    });

    // Remove tabs that are no longer in the tabs array
    addedTabs.forEach(tabId => {
      if (!tabs.find(t => t.id === tabId)) {
        setAddedTabs(prev => {
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      }
    });
  }, [tabs, dockLayoutRef, addedTabs]);

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

  // Always use default layout (empty tabs)
  // Tabs will be added programmatically when TabContext loads them
  const [layoutLoaded, setLayoutLoaded] = React.useState(false);
  
  React.useEffect(() => {
    // Just use default layout - don't try to restore tab IDs
    // because tabs load asynchronously and rc-dock will crash if loadTab returns null
    console.log('Using default layout (tabs will be added programmatically)');
    setLayoutLoaded(true);
  }, []);

  // Helper to extract all tab IDs from a layout
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

  // Sync tabs from TabContext to rc-dock
  React.useEffect(() => {
    if (!dockLayoutRef) return;

    console.log('AppShell: Syncing tabs to rc-dock:', tabs.map(t => t.id));

    // Get current layout
    const currentLayout = dockLayoutRef.getLayout();
    const currentTabIds = extractTabIds(currentLayout);

    // Find tabs that need to be added
    const tabsToAdd = tabs.filter(tab => !currentTabIds.includes(tab.id));

    // Add each new tab to the main panel
    for (const tab of tabsToAdd) {
      console.log(`AppShell: Adding tab ${tab.id} to rc-dock`);
      dockLayoutRef.dockMove(tab, 'main-tabs', 'middle');
    }
  }, [tabs, dockLayoutRef, extractTabIds]);

  // Track previous layout to detect tab closes
  const prevLayoutRef = React.useRef<LayoutData | null>(null);

  // Load tab callback - rc-dock uses this to hydrate tab IDs with actual tab data
  const loadTab = React.useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.warn(`loadTab: Tab ${tabId} not found in TabContext`);
      return null;
    }
    return tab;
  }, [tabs]);

  // Save layout to IndexedDB when it changes
  const handleLayoutChange = React.useCallback(async (newLayout: LayoutData) => {
    console.log('AppShell: handleLayoutChange called');
    console.log('AppShell: New layout structure:', JSON.stringify(newLayout, null, 2));
    
    if (!dockLayoutRef) {
      console.log('AppShell: No dockLayoutRef, returning');
      return;
    }

    // Detect closed tabs by comparing with previous layout
    if (prevLayoutRef.current) {
      const prevTabIds = extractTabIds(prevLayoutRef.current);
      const newTabIds = extractTabIds(newLayout);
      console.log('AppShell: Previous tab IDs:', prevTabIds);
      console.log('AppShell: New tab IDs:', newTabIds);
      
      const closedTabIds = prevTabIds.filter(id => !newTabIds.includes(id));
      
      if (closedTabIds.length > 0) {
        console.log('AppShell: Detected closed tabs:', closedTabIds);
        // Call closeTab for each closed tab (without force, so dirty check happens)
        for (const tabId of closedTabIds) {
          const closed = await tabOperations.closeTab(tabId, false); // force=false to allow confirmation
          
          // If user cancelled (dirty file), restore the previous layout
          if (!closed && dockLayoutRef) {
            console.log(`AppShell: User cancelled close for ${tabId}, restoring previous layout`);
            // Restore the entire previous layout to bring the tab back
            dockLayoutRef.loadLayout(prevLayoutRef.current);
            // Don't update prevLayoutRef or save to DB
            return;
          }
        }
      } else {
        console.log('AppShell: No tabs closed');
      }
    } else {
      console.log('AppShell: First layout change, setting prevLayoutRef');
    }

    prevLayoutRef.current = newLayout;

    // Debounce save to IndexedDB
    setTimeout(() => {
      layoutService.saveLayout(newLayout);
    }, 1000);
  }, [dockLayoutRef, tabOperations, extractTabIds, tabs]);

  return (
    <div className={`app-shell ${navState.isPinned ? 'nav-pinned' : 'nav-unpinned'}`} style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Menu bar */}
      <div style={{ height: '40px', borderBottom: '1px solid #e0e0e0', flexShrink: 0 }}>
        <MenuBar />
      </div>
      
      {/* Content area - grid layout */}
      <div style={{ 
        flex: 1, 
        display: 'grid',
        gridTemplateColumns: navState.isPinned ? '240px 1fr' : '1fr',
        position: 'relative', 
        overflow: 'hidden',
        transition: 'grid-template-columns 0.2s ease'
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
              zIndex: 1001,
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
            borderRight: '1px solid #e0e0e0',
            background: '#f8f9fa',
            overflow: 'hidden',
            position: 'relative'
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
              boxSizing: 'border-box'
            }}
            onClick={() => navOperations.togglePin()}
            >
              <span style={{ fontSize: '12px', lineHeight: 1 }}>▼</span>
              <span style={{ fontSize: '13px', fontWeight: 500, lineHeight: 1 }}>Navigator</span>
            </div>
            
            {/* Navigator content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <NavigatorContent />
            </div>
            
            {/* Resize handle */}
            <div 
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                bottom: 0,
                width: '4px',
                cursor: 'col-resize',
                background: 'transparent'
              }}
              onMouseDown={(e) => {
                // TODO: Implement resize logic
                console.log('Resize handle clicked');
              }}
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
              zIndex: 1000,
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
        
        {/* rc-dock - only render after layout is loaded */}
        {layoutLoaded && (
          <DockLayout
            ref={setDockLayoutRef}
            defaultLayout={defaultLayout}
            loadTab={loadTab}
            onLayoutChange={handleLayoutChange}
            groups={customGroups}
            style={{ 
              width: '100%',
              height: '100%',
              paddingLeft: navState.isPinned ? '0' : '0' // rc-dock starts at 0, button overlays it
            }}
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
  return (
    <ErrorBoundary>
      <DialogProvider>
        <TabProvider>
          <NavigatorProvider>
            <AppShellContent />
          </NavigatorProvider>
        </TabProvider>
      </DialogProvider>
    </ErrorBoundary>
  );
}

