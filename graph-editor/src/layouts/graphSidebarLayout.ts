import { LayoutData } from 'rc-dock';

/**
 * Full layout for graph editor including canvas and sidebar panels
 * 
 * Structure: 
 * - Main area (left, flex): Canvas panel
 * - Sidebar (right, 300px): What-If/Properties/Tools tabs
 * 
 * This layout spans the entire graph editor, allowing floatbox to move freely
 */
export function getGraphEditorLayout(): LayoutData {
  return {
    dockbox: {
      mode: 'horizontal',
      children: [
        // Main canvas area (left, takes most space)
        {
          id: 'graph-canvas-panel',
          size: 1000, // Flex weight (will take remaining space)
          tabs: [
            {
              id: 'canvas-tab',
              title: '', // No title - we don't want tab bar for canvas
              content: null as any, // Will be replaced with GraphCanvas
              cached: true,
              closable: false,
              group: 'graph-canvas'
            }
          ]
        },
        // Sidebar panels (right, constrained width)
        {
          id: 'graph-sidebar-panel',
          size: 300,
          minWidth: 250,  // Won't shrink below 250px
          maxWidth: 500,  // Won't grow above 500px
          tabs: [
            {
              id: 'what-if-tab',
              title: '🎭 What-If',
              content: null as any, // Will be replaced with WhatIfPanel
              cached: true,
              closable: true,  // Always closable - CSS will hide button when docked
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: '📝 Props',
              content: null as any, // Will be replaced with PropertiesPanel
              cached: true,
              closable: true,
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: '🛠️ Tools',
              content: null as any, // Will be replaced with ToolsPanel
              cached: true,
              closable: true,
              group: 'graph-panels'
            }
          ]
        }
      ]
    },
    floatbox: {
      mode: 'float',
      children: []
    }
  };
}

/**
 * Minimized layout - canvas + hidden sidebar (size: 0)
 */
export function getGraphEditorLayoutMinimized(): LayoutData {
  return {
    dockbox: {
      mode: 'horizontal',
      children: [
        {
          id: 'graph-canvas-panel',
          size: 1000,
          tabs: [
            {
              id: 'canvas-tab',
              title: '',
              content: null as any,
              cached: true,
              closable: false,
              group: 'graph-canvas'
            }
          ]
        },
        // Sidebar panel with size: 0 (hidden but present)
        {
          id: 'graph-sidebar-panel',
          size: 0,
          maxWidth: 500,  // Same constraint as maximized
          tabs: [
            {
              id: 'what-if-tab',
              title: '🎭 What-If',
              content: null as any,
              cached: true,
              closable: true,  // Always closable - CSS will hide button when docked
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: '📝 Props',
              content: null as any,
              cached: true,
              closable: true,
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: '🛠️ Tools',
              content: null as any,
              cached: true,
              closable: true,
              group: 'graph-panels'
            }
          ]
        }
      ]
    },
    floatbox: {
      mode: 'float',
      children: []
    }
  };
}

/**
 * Map panel names to tab IDs
 */
export const PANEL_TO_TAB_ID = {
  'what-if': 'what-if-tab',
  'properties': 'properties-tab',
  'tools': 'tools-tab'
} as const;

/**
 * Map tab IDs to panel names
 */
export const TAB_ID_TO_PANEL = {
  'what-if-tab': 'what-if',
  'properties-tab': 'properties',
  'tools-tab': 'tools'
} as const;

