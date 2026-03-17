/**
 * useGroupResize — cascades resize to all selected resizable nodes.
 *
 * Uses the same module-level singleton pattern as snapService's
 * getLastSnappedResize/setLastSnappedResize. The hook binds to
 * nodes/setNodes/update-handlers; node components call the exported
 * functions directly — no callback wiring through node data needed.
 */

import { useRef } from 'react';
import type { Node } from 'reactflow';

// ---------------------------------------------------------------------------
// Constants — minimum dimensions per node type (must match NodeResizer props)
// ---------------------------------------------------------------------------

const MIN_DIMS: Record<string, { w: number; h: number }> = {
  'postit-':    { w: 150, h: 80 },
  'container-': { w: 200, h: 120 },
  'analysis-':  { w: 300, h: 200 },
};

function getMinDims(nodeId: string): { w: number; h: number } {
  for (const prefix of Object.keys(MIN_DIMS)) {
    if (nodeId.startsWith(prefix)) return MIN_DIMS[prefix];
  }
  return { w: 50, h: 50 };
}

function isResizable(nodeId: string): boolean {
  return nodeId.startsWith('postit-') || nodeId.startsWith('container-') || nodeId.startsWith('analysis-');
}

function stripPrefix(nodeId: string): string {
  const idx = nodeId.indexOf('-');
  return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
}

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

interface Snapshot { width: number; height: number; }

let _nodesRef: { current: Node[] } | null = null;
let _setNodes: React.Dispatch<React.SetStateAction<Node[]>> | null = null;
let _handleUpdatePostit: ((id: string, u: any) => void) | null = null;
let _handleUpdateContainer: ((id: string, u: any) => void) | null = null;
let _handleUpdateAnalysis: ((id: string, u: any) => void) | null = null;

let _snapshot: Map<string, Snapshot> | null = null;
let _primarySnapshot: Snapshot | null = null;

// ---------------------------------------------------------------------------
// Exported functions — called directly by node components
// ---------------------------------------------------------------------------

export function groupResizeStart(primaryNodeId: string): void {
  if (!_nodesRef) return;
  const nodes = _nodesRef.current;

  const selected = nodes.filter(
    n => n.selected && isResizable(n.id) && n.id !== primaryNodeId,
  );
  if (import.meta.env.DEV) {
    console.log('[GroupResize] START', {
      primaryNodeId,
      selectedPeers: selected.map(n => n.id),
      allSelected: nodes.filter(n => n.selected).map(n => n.id),
    });
  }
  if (selected.length === 0) {
    _snapshot = null;
    _primarySnapshot = null;
    return;
  }

  const primaryNode = nodes.find(n => n.id === primaryNodeId);
  if (!primaryNode) { _snapshot = null; _primarySnapshot = null; return; }

  _primarySnapshot = {
    width: (primaryNode.style as any)?.width ?? primaryNode.width ?? 200,
    height: (primaryNode.style as any)?.height ?? primaryNode.height ?? 150,
  };

  const snap = new Map<string, Snapshot>();
  for (const n of selected) {
    snap.set(n.id, {
      width: (n.style as any)?.width ?? n.width ?? 200,
      height: (n.style as any)?.height ?? n.height ?? 150,
    });
  }
  _snapshot = snap;
}

export function groupResize(primaryNodeId: string, newWidth: number, newHeight: number): void {
  if (!_snapshot || !_primarySnapshot) return;

  const dw = newWidth - _primarySnapshot.width;
  const dh = newHeight - _primarySnapshot.height;

  // Direct DOM manipulation for performance — avoids calling setNodes on every
  // resize frame, which would trigger massive re-render cascades (SelectionConnectors,
  // what-if recompute, halo highlights etc.) and cause visual thrashing.
  // Final state is committed to React + graph store in groupResizeEnd.
  for (const [nodeId, peerSnap] of _snapshot) {
    const min = getMinDims(nodeId);
    const w = Math.max(min.w, Math.round(peerSnap.width + dw));
    const h = Math.max(min.h, Math.round(peerSnap.height + dh));

    const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`) as HTMLElement | null;
    if (el) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
  }
}

export function groupResizeEnd(primaryNodeId: string, finalWidth?: number, finalHeight?: number): void {
  if (!_snapshot || !_primarySnapshot || !_nodesRef) {
    _snapshot = null;
    _primarySnapshot = null;
    return;
  }

  // Use explicit final dims when provided (avoids stale React state from batched renders).
  // Fall back to reading the primary node's current RF state.
  let finalW: number;
  let finalH: number;
  if (finalWidth != null && finalHeight != null) {
    finalW = finalWidth;
    finalH = finalHeight;
  } else {
    const primaryNode = _nodesRef.current.find(n => n.id === primaryNodeId);
    finalW = primaryNode
      ? ((primaryNode.style as any)?.width ?? primaryNode.width ?? _primarySnapshot.width)
      : _primarySnapshot.width;
    finalH = primaryNode
      ? ((primaryNode.style as any)?.height ?? primaryNode.height ?? _primarySnapshot.height)
      : _primarySnapshot.height;
  }
  const dw = finalW - _primarySnapshot.width;
  const dh = finalH - _primarySnapshot.height;

  if (import.meta.env.DEV) {
    console.log('[GroupResize] END', { primaryNodeId, dw, dh, peerCount: _snapshot.size });
  }

  // Compute final dimensions for each peer
  const peerUpdates: Array<{ rfNodeId: string; objectId: string; x: number; y: number; w: number; h: number }> = [];
  for (const [rfNodeId, peerSnap] of _snapshot) {
    const node = _nodesRef.current.find(n => n.id === rfNodeId);
    const x = node?.position?.x ?? 0;
    const y = node?.position?.y ?? 0;

    const min = getMinDims(rfNodeId);
    const w = Math.max(min.w, Math.round(peerSnap.width + dw));
    const h = Math.max(min.h, Math.round(peerSnap.height + dh));

    peerUpdates.push({ rfNodeId, objectId: stripPrefix(rfNodeId), x: Math.round(x), y: Math.round(y), w, h });
  }

  // Commit final peer styles to React state (single setNodes call — syncs DOM
  // manipulation with React's virtual DOM before the resize guard clears)
  if (_setNodes && peerUpdates.length > 0) {
    const peerMap = new Map(peerUpdates.map(p => [p.rfNodeId, p]));
    _setNodes(nds => nds.map(n => {
      const pu = peerMap.get(n.id);
      if (!pu) return n;
      return {
        ...n,
        style: { ...n.style, width: pu.w, height: pu.h },
      };
    }));
  }

  // Persist final dimensions to graph store
  for (const pu of peerUpdates) {
    const updates = { x: pu.x, y: pu.y, width: pu.w, height: pu.h };
    if (pu.rfNodeId.startsWith('postit-')) {
      _handleUpdatePostit?.(pu.objectId, updates);
    } else if (pu.rfNodeId.startsWith('container-')) {
      _handleUpdateContainer?.(pu.objectId, updates);
    } else if (pu.rfNodeId.startsWith('analysis-')) {
      _handleUpdateAnalysis?.(pu.objectId, updates);
    }
  }

  _snapshot = null;
  _primarySnapshot = null;
}

// ---------------------------------------------------------------------------
// Hook — binds the singleton to the current component's state/handlers
// ---------------------------------------------------------------------------

export interface UseGroupResizeParams {
  nodes: Node[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  handleUpdatePostit: (id: string, updates: any) => void;
  handleUpdateContainer: (id: string, updates: any) => void;
  handleUpdateAnalysis: (id: string, updates: any) => void;
}

export function useGroupResize({
  nodes,
  setNodes,
  handleUpdatePostit,
  handleUpdateContainer,
  handleUpdateAnalysis,
}: UseGroupResizeParams): void {
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Bind module-level state to current React state
  _nodesRef = nodesRef;
  _setNodes = setNodes;
  _handleUpdatePostit = handleUpdatePostit;
  _handleUpdateContainer = handleUpdateContainer;
  _handleUpdateAnalysis = handleUpdateAnalysis;
}
