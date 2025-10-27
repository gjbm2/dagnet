import { LayoutData } from 'rc-dock';

/**
 * Default rc-dock layout configuration
 * 
 * Structure:
 * - Menu Bar (locked, 40px)
 * - Navigator Header + Tab Bar (44px)
 * - Navigator Panel (240px, collapsible) | Main Content (flex)
 * - Float boxes (dragged-out tabs)
 * 
 * Note: Content placeholders will be replaced with actual components
 * when the layout is instantiated in the React app
 */
export function getDefaultLayout(): LayoutData {
  return {
    dockbox: {
      mode: 'vertical',
      children: [
        // Menu Bar (top, locked, 40px height)
        {
          mode: 'horizontal',
          size: 40,
          children: [
            {
              id: 'menu-panel',
              tabs: [
                {
                  id: 'menu',
                  title: '',
                  content: null as any, // Will be replaced with MenuBar component
                  cached: true,
                  closable: false
                }
              ],
              panelLock: {
                panelStyle: 'menu-bar',
                minSize: 40,
                maxSize: 40
              }
            }
          ]
        },
        
        // Main workspace (navigator + tabs)
        {
          mode: 'horizontal',
          children: [
            // Navigator panel (left, 240px, collapsible)
            {
              id: 'navigator-panel',
              size: 0, // Start collapsed
              minWidth: 180,
              minHeight: 200,
              tabs: [
                {
                  id: 'navigator',
                  title: '🔍 Navigator',
                  content: null as any, // Will be replaced with Navigator component
                  cached: true,
                  closable: false
                }
              ],
              panelLock: {
                panelStyle: 'navigator',
                minSize: 0, // Can collapse to 0
                maxSize: 400
              }
            },
            
            // Main tabs area (right, flex)
            {
              id: 'main-tabs',
              tabs: [], // User's tabs go here
              panelLock: {
                panelStyle: 'main-tabs'
              }
            }
          ]
        }
      ]
    },
    
    // Floating windows
    floatbox: {
      mode: 'float',
      children: []
    }
  };
}

/**
 * Groups configuration for rc-dock
 * Defines behavior for different types of tabs
 */
export const dockGroups = {
  // Main content tabs (graphs, parameters, etc.)
  'main-content': {
    floatable: true,
    maximizable: true,
    tabLocked: false,
    animated: true,
    newWindow: false,
    // Inject Navigator button into tab bar
    panelExtra: (panelData: any) => {
      // This will be replaced with actual component in AppShell
      return null;
    }
  },
  
  // Special tabs (settings, about, etc.)
  'special': {
    floatable: true,
    maximizable: false,
    tabLocked: false,
    animated: true,
    newWindow: false
  },
  
  // System panels (menu, navigator) - completely locked
  'menu-bar': {
    floatable: false,
    maximizable: false,
    tabLocked: true,
    animated: false,
    newWindow: false,
    panelLock: true
  },
  
  'navigator': {
    floatable: false,
    maximizable: false,
    tabLocked: true,
    animated: false,
    newWindow: false
  },
  
  // Graph-specific panels (for nested rc-dock in graph editor)
  'graph-panels': {
    floatable: true,
    maximizable: true,
    tabLocked: true,
    animated: true,
    newWindow: false
  }
};

/**
 * Panel lock styles for different panel types
 */
export const panelLockStyles = {
  'menu-bar': {
    panelStyle: 'menu-bar'
  },
  'navigator': {
    panelStyle: 'navigator'
  },
  'main-tabs': {
    panelStyle: 'main-tabs'
  }
};

