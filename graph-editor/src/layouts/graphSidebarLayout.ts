import { LayoutData } from 'rc-dock';
import React from 'react';
import { Sparkles, FileText, Wrench } from 'lucide-react';

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
          tabs: [
            {
              id: 'what-if-tab',
              title: React.createElement('div', { className: 'dock-tab-title' },
                React.createElement(Sparkles, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { style: { flex: 1, minWidth: 0 } }, 'What-If'),
                React.createElement('div', { 
                  className: 'dock-tab-close-btn',
                  style: { flexShrink: 0 }
                }, '✕')
              ),
              content: null as any, // Will be replaced with WhatIfPanel
              cached: true,
              closable: false,  // We use custom close button in title
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: React.createElement('div', { className: 'dock-tab-title' },
                React.createElement(FileText, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { style: { flex: 1, minWidth: 0 } }, 'Props'),
                React.createElement('div', { 
                  className: 'dock-tab-close-btn',
                  style: { flexShrink: 0 }
                }, '✕')
              ),
              content: null as any, // Will be replaced with PropertiesPanel
              cached: true,
              closable: false,  // We use custom close button in title
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: React.createElement('div', { className: 'dock-tab-title' },
                React.createElement(Wrench, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { style: { flex: 1, minWidth: 0 } }, 'Tools'),
                React.createElement('div', { 
                  className: 'dock-tab-close-btn',
                  style: { flexShrink: 0 }
                }, '✕')
              ),
              content: null as any, // Will be replaced with ToolsPanel
              cached: true,
              closable: false,  // We use custom close button in title
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
          tabs: [
            {
              id: 'what-if-tab',
              title: React.createElement('div', { className: 'dock-tab-title' },
                React.createElement(Sparkles, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { style: { flex: 1, minWidth: 0 } }, 'What-If'),
                React.createElement('div', { 
                  className: 'dock-tab-close-btn',
                  style: { flexShrink: 0 }
                }, '✕')
              ),
              content: null as any,
              cached: true,
              closable: false,  // We use custom close button in title
              group: 'graph-panels'
            },
            {
              id: 'properties-tab',
              title: React.createElement('div', { className: 'dock-tab-title' },
                React.createElement(FileText, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { style: { flex: 1, minWidth: 0 } }, 'Props'),
                React.createElement('div', { 
                  className: 'dock-tab-close-btn',
                  style: { flexShrink: 0 }
                }, '✕')
              ),
              content: null as any,
              cached: true,
              closable: false,  // We use custom close button in title
              group: 'graph-panels'
            },
            {
              id: 'tools-tab',
              title: React.createElement('div', { className: 'dock-tab-title' },
                React.createElement(Wrench, { size: 14, strokeWidth: 2, style: { flexShrink: 0 } }),
                React.createElement('span', { style: { flex: 1, minWidth: 0 } }, 'Tools'),
                React.createElement('div', { 
                  className: 'dock-tab-close-btn',
                  style: { flexShrink: 0 }
                }, '✕')
              ),
              content: null as any,
              cached: true,
              closable: false,  // We use custom close button in title
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

