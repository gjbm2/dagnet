import { LayoutData } from 'rc-dock';

/**
 * Default layout for graph editor sidebar panels
 * 
 * Structure: Vertical tabs (What-If, Properties, Tools)
 * Displayed when sidebar is in 'maximized' mode
 */
export function getGraphSidebarLayout(): LayoutData {
  return {
    dockbox: {
      mode: 'vertical',
      children: [
        {
          id: 'graph-sidebar-panel',
          size: 300, // Width when maximized
          tabs: [
            {
              id: 'what-if-tab',
              title: '🎭 What-If',
              content: null as any, // Will be replaced with WhatIfPanel
              cached: true,
              closable: false,
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: '📝 Properties',
              content: null as any, // Will be replaced with PropertiesPanel
              cached: true,
              closable: false,
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: '🛠️ Tools',
              content: null as any, // Will be replaced with ToolsPanel
              cached: true,
              closable: false,
              group: 'graph-panels'
            }
          ],
          panelLock: {
            panelStyle: 'graph-sidebar'
          }
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

