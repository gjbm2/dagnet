/**
 * RemoveOverridesMenuItem Component
 * 
 * Menu item wrapper - NO LOGIC HERE, all logic in useRemoveOverrides hook.
 * Used by EdgeContextMenu, NodeContextMenu, and DataMenu.
 */

import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { RotateCcw } from 'lucide-react';
import { useRemoveOverrides } from '../hooks/useRemoveOverrides';
import type { GraphData } from '../types';

interface RemoveOverridesMenuItemProps {
  graph: GraphData | null | undefined;
  onUpdateGraph: (graph: GraphData, historyLabel: string, objectId?: string) => void;
  nodeId?: string | null;
  edgeId?: string | null;
  onClose: () => void;
}

/**
 * Menu item for context menus (EdgeContextMenu, NodeContextMenu).
 * NO LOGIC - just calls the hook.
 * Renders nothing if there are no overrides.
 */
export function RemoveOverridesMenuItem({
  graph,
  onUpdateGraph,
  nodeId,
  edgeId,
  onClose
}: RemoveOverridesMenuItemProps) {
  // Hook handles ALL logic - counting and removing
  const { overrideCount, hasOverrides, removeOverrides } = useRemoveOverrides(
    graph,
    onUpdateGraph,
    nodeId,
    edgeId
  );

  if (!hasOverrides) return null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        removeOverrides();
        onClose();
      }}
      style={{
        padding: '8px 12px',
        cursor: 'pointer',
        fontSize: '13px',
        borderRadius: '2px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
    >
      <RotateCcw size={14} />
      <span>Remove overrides ({overrideCount})</span>
    </div>
  );
}

interface RemoveOverridesMenubarItemProps {
  graph: GraphData | null | undefined;
  onUpdateGraph: (graph: GraphData, historyLabel: string, objectId?: string) => void;
  nodeId?: string | null;
  edgeId?: string | null;
}

/**
 * Menu item for Radix Menubar (DataMenu).
 * NO LOGIC - just calls the hook.
 * Renders nothing if there are no overrides.
 */
export function RemoveOverridesMenubarItem({
  graph,
  onUpdateGraph,
  nodeId,
  edgeId
}: RemoveOverridesMenubarItemProps) {
  // Hook handles ALL logic - counting and removing
  const { overrideCount, hasOverrides, removeOverrides } = useRemoveOverrides(
    graph,
    onUpdateGraph,
    nodeId,
    edgeId
  );

  if (!hasOverrides) return null;

  return (
    <Menubar.Item className="menubar-item" onSelect={removeOverrides}>
      Remove overrides ({overrideCount})
    </Menubar.Item>
  );
}

