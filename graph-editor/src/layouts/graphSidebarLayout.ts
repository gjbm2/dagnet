import { LayoutData } from 'rc-dock';
import React from 'react';
import { Layers, FileText, Wrench, BarChart3 } from 'lucide-react';
import { DEFAULT_SIDEBAR_WIDTH } from '../lib/uiConstants';

/**
 * Full layout for graph editor including canvas and sidebar panels
 * 
 * Structure: 
 * - Main area (left, flex): Canvas panel
 * - Sidebar (right): Scenarios/Properties/Tools tabs
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
        // Sidebar vbox (right) — palette strip + tabbed panel
        {
          id: 'graph-sidebar-vbox',
          mode: 'vertical' as any,
          size: DEFAULT_SIDEBAR_WIDTH,
          children: [
            // Element palette (fixed height, non-interactive chrome)
            {
              id: 'element-palette-panel',
              size: 40,
              panelLock: { widthFlex: 0, heightFlex: 0 },
              tabs: [
                {
                  id: 'element-palette-tab',
                  title: '',
                  content: null as any,
                  cached: true,
                  closable: false,
                  group: 'graph-canvas'
                }
              ]
            },
            // Sidebar tabbed panel
            {
              id: 'graph-sidebar-panel',
              size: 1000,
              tabs: [
            {
              id: 'what-if-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(Layers, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Scenarios')
              ),
              content: null as any, // Will be replaced with WhatIfPanel
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(FileText, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Props')
              ),
              content: null as any, // Will be replaced with PropertiesPanel
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(Wrench, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Tools')
              ),
              content: null as any, // Will be replaced with ToolsPanel
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            },
            {
              id: 'analytics-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(BarChart3, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Analytics')
              ),
              content: null as any, // Will be replaced with AnalyticsPanel
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            }
          ]
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
        // Sidebar vbox with size: 0 (hidden but present)
        {
          id: 'graph-sidebar-vbox',
          mode: 'vertical' as any,
          size: 0,
          children: [
            {
              id: 'element-palette-panel',
              size: 0,
              panelLock: { widthFlex: 0, heightFlex: 0 },
              tabs: [
                {
                  id: 'element-palette-tab',
                  title: '',
                  content: null as any,
                  cached: true,
                  closable: false,
                  group: 'graph-canvas'
                }
              ]
            },
            {
              id: 'graph-sidebar-panel',
              size: 1000,
              tabs: [
            {
              id: 'what-if-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(Layers, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Scenarios')
              ),
              content: null as any,
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(FileText, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Props')
              ),
              content: null as any,
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(Wrench, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Tools')
              ),
              content: null as any,
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            },
            {
              id: 'analytics-tab',
              title: React.createElement('div', { 
                className: 'dock-tab-title',
                style: { display: 'flex', alignItems: 'center', gap: '4px' }
              },
                React.createElement(BarChart3, { size: 12, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { 
                  style: { 
                    flex: 1, 
                    minWidth: 0, 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  } 
                }, 'Analytics')
              ),
              content: null as any,
              cached: true,
              closable: false,  // Dynamic: false at home, true when floating/docked elsewhere
              group: 'graph-panels'
            }
          ]
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
  'tools': 'tools-tab',
  'analytics': 'analytics-tab'
} as const;

/**
 * Map tab IDs to panel names
 */
export const TAB_ID_TO_PANEL = {
  'what-if-tab': 'what-if',
  'properties-tab': 'properties',
  'tools-tab': 'tools',
  'analytics-tab': 'analytics'
} as const;
