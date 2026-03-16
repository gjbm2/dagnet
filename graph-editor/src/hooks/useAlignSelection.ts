import { useCallback, useEffect, useMemo } from 'react';
import { Node } from 'reactflow';
import {
  computeAlignment,
  computeDistribution,
  computeEqualSize,
  toNodeRect,
  AlignCommand,
  DistributeCommand,
  EqualSizeCommand,
  PositionUpdate,
  SizeUpdate,
} from '../services/alignmentService';

const DEFAULT_NODE_WIDTH = 110;
const DEFAULT_NODE_HEIGHT = 110;
const CONTAIN_TOLERANCE = 10;

/**
 * Hook providing alignment, distribution, and equal-size commands for selected canvas objects.
 *
 * Access points:
 *   - Elements menu dispatches `dagnet:align` / `dagnet:distribute` / `dagnet:equalSize` events
 *   - Canvas context menu calls the returned handlers directly
 *
 * All geometry lives in alignmentService — this hook is pure wiring.
 *
 * Graph store write-back:
 *   ReactFlow state is NOT the source of truth for canvas object positions/sizes —
 *   the graph store is. The graph→ReactFlow sync will overwrite any ReactFlow-only
 *   changes on the next cycle. So every operation here must:
 *     1. Update ReactFlow nodes (immediate visual feedback)
 *     2. Update the graph store (persistence)
 *     3. Save undo history
 *
 * Container cascading:
 *   When a container moves, all nodes spatially inside it must move by the same delta.
 *   This mirrors the container group-drag behaviour in GraphCanvas.
 */
export function useAlignSelection(
  nodes: Node[],
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>,
  graphRef: React.MutableRefObject<any>,
  setGraphDirect: (graph: any) => void,
  saveHistoryState: (label: string) => void,
) {
  const selectedNodes = useMemo(
    () => nodes.filter(n => n.selected),
    [nodes],
  );

  const canAlign = selectedNodes.length >= 2;
  const canDistribute = selectedNodes.length >= 3;

  /**
   * For each container in `updates`, find all nodes spatially inside it and
   * add cascaded position updates (same delta) for them. Skips nodes that
   * already have an explicit update (i.e. they were part of the selection).
   */
  const cascadeContainerMoves = useCallback(
    (updates: PositionUpdate[]): PositionUpdate[] => {
      const updateIds = new Set(updates.map(u => u.id));
      const containerUpdates = updates.filter(u => u.id.startsWith('container-'));
      if (containerUpdates.length === 0) return updates;

      const cascaded: PositionUpdate[] = [...updates];

      for (const cu of containerUpdates) {
        // Find the current container node to get its pre-move position and size
        const containerNode = nodes.find(n => n.id === cu.id);
        if (!containerNode) continue;

        const oldX = containerNode.position?.x ?? 0;
        const oldY = containerNode.position?.y ?? 0;
        const dx = cu.position.x - oldX;
        const dy = cu.position.y - oldY;
        if (dx === 0 && dy === 0) continue;

        const rect = toNodeRect(containerNode, 400, 300);

        // Find all nodes inside this container (using pre-move bounds)
        for (const n of nodes) {
          if (n.id === cu.id || updateIds.has(n.id)) continue;
          const nr = toNodeRect(n, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
          const inside =
            nr.x >= (rect.x - CONTAIN_TOLERANCE) &&
            nr.y >= (rect.y - CONTAIN_TOLERANCE) &&
            (nr.x + nr.width) <= (rect.x + rect.width + CONTAIN_TOLERANCE) &&
            (nr.y + nr.height) <= (rect.y + rect.height + CONTAIN_TOLERANCE);

          if (inside) {
            cascaded.push({ id: n.id, position: { x: nr.x + dx, y: nr.y + dy } });
            updateIds.add(n.id); // prevent double-cascading from nested containers
          }
        }
      }

      return cascaded;
    },
    [nodes],
  );

  /**
   * Apply position updates to the graph store.
   * Handles all node types: conversion nodes (layout.x/y), postits, containers, analyses (x/y).
   */
  const applyPositionUpdatesToGraph = useCallback(
    (updates: PositionUpdate[]) => {
      const current = graphRef.current;
      if (!current) return;
      const nextGraph = structuredClone(current);
      const posMap = new Map(updates.map(u => [u.id, u.position]));

      // Conversion nodes — position lives in layout.x/y, keyed by uuid or id
      if (nextGraph.nodes) {
        for (const gNode of nextGraph.nodes) {
          const pos = posMap.get(gNode.uuid) || posMap.get(gNode.id);
          if (pos) {
            if (!gNode.layout) gNode.layout = {};
            gNode.layout.x = pos.x;
            gNode.layout.y = pos.y;
          }
        }
      }

      // Post-its — prefixed with "postit-" in ReactFlow
      if (nextGraph.postits) {
        for (const p of nextGraph.postits) {
          const pos = posMap.get(`postit-${p.id}`);
          if (pos) { p.x = pos.x; p.y = pos.y; }
        }
      }

      // Containers — prefixed with "container-" in ReactFlow
      if (nextGraph.containers) {
        for (const c of nextGraph.containers) {
          const pos = posMap.get(`container-${c.id}`);
          if (pos) { c.x = pos.x; c.y = pos.y; }
        }
      }

      // Canvas analyses — prefixed with "analysis-" in ReactFlow
      if (nextGraph.canvasAnalyses) {
        for (const a of nextGraph.canvasAnalyses) {
          const pos = posMap.get(`analysis-${a.id}`);
          if (pos) { a.x = pos.x; a.y = pos.y; }
        }
      }

      if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
      setGraphDirect(nextGraph);
      graphRef.current = nextGraph;
    },
    [graphRef, setGraphDirect],
  );

  /**
   * Apply size updates to the graph store.
   * Only canvas objects (postits, containers, analyses) have resizable dimensions.
   */
  const applySizeUpdatesToGraph = useCallback(
    (updates: SizeUpdate[]) => {
      const current = graphRef.current;
      if (!current) return;
      const nextGraph = structuredClone(current);
      const sizeMap = new Map(updates.map(u => [u.id, u.size]));

      if (nextGraph.postits) {
        for (const p of nextGraph.postits) {
          const sz = sizeMap.get(`postit-${p.id}`);
          if (sz) { p.width = sz.width; p.height = sz.height; }
        }
      }

      if (nextGraph.containers) {
        for (const c of nextGraph.containers) {
          const sz = sizeMap.get(`container-${c.id}`);
          if (sz) { c.width = sz.width; c.height = sz.height; }
        }
      }

      if (nextGraph.canvasAnalyses) {
        for (const a of nextGraph.canvasAnalyses) {
          const sz = sizeMap.get(`analysis-${a.id}`);
          if (sz) { a.width = sz.width; a.height = sz.height; }
        }
      }

      if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
      setGraphDirect(nextGraph);
      graphRef.current = nextGraph;
    },
    [graphRef, setGraphDirect],
  );

  const align = useCallback(
    (command: AlignCommand) => {
      const selected = nodes.filter(n => n.selected);
      if (selected.length < 2) return;

      const rects = selected.map(n => toNodeRect(n));
      const updates = computeAlignment(rects, command);
      if (updates.length === 0) return;

      // Cascade: move contained nodes along with any moved containers
      const allUpdates = cascadeContainerMoves(updates);

      // 1. Update ReactFlow (immediate visual)
      const updateMap = new Map(allUpdates.map(u => [u.id, u.position]));
      setNodes(nds =>
        nds.map(n => {
          const pos = updateMap.get(n.id);
          return pos ? { ...n, position: pos } : n;
        }),
      );

      // 2. Update graph store (persistence)
      applyPositionUpdatesToGraph(allUpdates);
      saveHistoryState('Align selection');
    },
    [nodes, setNodes, cascadeContainerMoves, applyPositionUpdatesToGraph, saveHistoryState],
  );

  const distribute = useCallback(
    (command: DistributeCommand) => {
      const selected = nodes.filter(n => n.selected);
      if (selected.length < 3) return;

      const rects = selected.map(n => toNodeRect(n));
      const updates = computeDistribution(rects, command);
      if (updates.length === 0) return;

      const allUpdates = cascadeContainerMoves(updates);

      const updateMap = new Map(allUpdates.map(u => [u.id, u.position]));
      setNodes(nds =>
        nds.map(n => {
          const pos = updateMap.get(n.id);
          return pos ? { ...n, position: pos } : n;
        }),
      );

      applyPositionUpdatesToGraph(allUpdates);
      saveHistoryState('Distribute selection');
    },
    [nodes, setNodes, cascadeContainerMoves, applyPositionUpdatesToGraph, saveHistoryState],
  );

  const equalSize = useCallback(
    (command: EqualSizeCommand) => {
      const selected = nodes.filter(n => n.selected);
      if (selected.length < 2) return;

      const rects = selected.map(n => toNodeRect(n));
      const updates = computeEqualSize(rects, command);
      if (updates.length === 0) return;

      // 1. Update ReactFlow (immediate visual)
      const updateMap = new Map(updates.map(u => [u.id, u.size]));
      setNodes(nds =>
        nds.map(n => {
          const sz = updateMap.get(n.id);
          return sz
            ? { ...n, style: { ...n.style, width: sz.width, height: sz.height } }
            : n;
        }),
      );

      // 2. Update graph store (persistence)
      applySizeUpdatesToGraph(updates);
      saveHistoryState('Equal size selection');
    },
    [nodes, setNodes, applySizeUpdatesToGraph, saveHistoryState],
  );

  // Listen for events from the Elements menu
  useEffect(() => {
    const handleAlign = (e: CustomEvent<{ command: AlignCommand }>) => {
      align(e.detail.command);
    };
    const handleDistribute = (e: CustomEvent<{ command: DistributeCommand }>) => {
      distribute(e.detail.command);
    };
    const handleEqualSize = (e: CustomEvent<{ command: EqualSizeCommand }>) => {
      equalSize(e.detail.command);
    };

    window.addEventListener('dagnet:align' as any, handleAlign);
    window.addEventListener('dagnet:distribute' as any, handleDistribute);
    window.addEventListener('dagnet:equalSize' as any, handleEqualSize);
    return () => {
      window.removeEventListener('dagnet:align' as any, handleAlign);
      window.removeEventListener('dagnet:distribute' as any, handleDistribute);
      window.removeEventListener('dagnet:equalSize' as any, handleEqualSize);
    };
  }, [align, distribute, equalSize]);

  return { align, distribute, equalSize, canAlign, canDistribute, selectedCount: selectedNodes.length };
}
