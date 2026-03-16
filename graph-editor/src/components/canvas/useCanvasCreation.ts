/**
 * useCanvasCreation — custom hook encapsulating element creation, paste, drop,
 * and draw-to-place logic.
 *
 * Owns: addNode/Postit/Container/Analysis creation callbacks, paste/drop
 * handlers, draw-to-place state + pointer handlers, ref exports to parent.
 *
 * Extracted from GraphCanvas Phase B4a (structural refactor, no behavioural change).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, Edge } from 'reactflow';
import toast from 'react-hot-toast';
import {
  createNodeInGraph,
  createNodeFromFileInGraph,
  createPostitInGraph,
  createContainerInGraph,
  createCanvasAnalysisInGraph,
  buildAddChartPayload,
} from './creationTools';
import { canvasAnalysisTransientCache } from '../../hooks/useCanvasAnalysisCompute';
import { fileRegistry } from '../../contexts/TabContext';
import { dataOperationsService } from '../../services/dataOperationsService';

// Module-level mutable for pending analysis payload (shared with draw-to-place).
// Mirrors the module-level variable that was in GraphCanvas.
let pendingAnalysisPayload: any = null;
export function setPendingAnalysisPayload(payload: any) { pendingAnalysisPayload = payload; }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCanvasCreationParams {
  graph: any;
  nodes: Node[];
  edges: Edge[];
  setGraph: (graph: any, oldGraph?: any, source?: string) => void;
  setGraphDirect: (graph: any) => void;
  saveHistoryState: (action: string, nodeId?: string, edgeId?: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  onSelectedAnnotationChange?: (id: string | null, type: 'postit' | 'container' | 'canvasAnalysis' | null) => void;
  setContextMenu: (menu: any) => void;
  activeElementTool: string | null | undefined;
  setActiveElementTool: (tool: any) => void;
  onClearElementTool?: () => void;
  copiedNode: any;
  copiedSubgraph: any;
  isCanvasObjectNode: (id: string) => boolean;
  getContainedConversionNodeIds: (container: { x: number; y: number; width: number; height: number }, rfNodes: any[], tolerance?: number) => string[];
  autoEditPostitIdRef: React.MutableRefObject<string | null>;
  autoSelectAnalysisIdRef: React.MutableRefObject<string | null>;
  tabId?: string;
  effectiveActiveTabId: string | null | undefined;
  onAddNodeRef?: React.MutableRefObject<(() => void) | null>;
  onAddPostitRef?: React.MutableRefObject<(() => void) | null>;
  onAddContainerRef?: React.MutableRefObject<(() => void) | null>;
}

export interface UseCanvasCreationReturn {
  addNodeAtPosition: (x: number, y: number) => void;
  addPostitAtPosition: (x: number, y: number, w?: number, h?: number) => void;
  addContainerAtPosition: (x: number, y: number, w?: number, h?: number) => void;
  addChartAtPosition: (x: number, y: number, w?: number, h?: number) => void;
  pasteNodeAtPosition: (x: number, y: number) => Promise<void>;
  pasteSubgraphAtPosition: (x: number, y: number) => Promise<void>;
  startAddChart: (detail?: { contextNodeIds?: string[]; contextEdgeIds?: string[] }) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  onPaneMouseDown: (event: React.PointerEvent) => void;
  onPaneMouseMove: (event: React.PointerEvent) => void;
  onPaneMouseUp: (event: React.PointerEvent) => void;
  onPaneClick: (event: React.MouseEvent) => void;
  drawRect: { x: number; y: number; w: number; h: number } | null;
  drawStartRef: React.MutableRefObject<{ screenX: number; screenY: number; flowX: number; flowY: number; tool: string } | null>;
  /** Visual rect for right-drag lasso (flow-space coords), for rendering */
  rightDragRect: { x: number; y: number; w: number; h: number } | null;
  /** Consume the right-drag rect (returns value and clears state). Used by onPaneContextMenu. */
  consumeRightDragRect: () => { x: number; y: number; w: number; h: number } | null;
  /** Clear right-drag state without consuming. Used by closeAllContextMenus. */
  clearRightDrag: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCanvasCreation({
  graph,
  nodes,
  edges,
  setGraph,
  setGraphDirect,
  saveHistoryState,
  setNodes,
  screenToFlowPosition,
  onSelectedNodeChange,
  onSelectedEdgeChange,
  onSelectedAnnotationChange,
  setContextMenu,
  activeElementTool,
  setActiveElementTool,
  onClearElementTool,
  copiedNode,
  copiedSubgraph,
  isCanvasObjectNode,
  getContainedConversionNodeIds,
  autoEditPostitIdRef,
  autoSelectAnalysisIdRef,
  tabId,
  effectiveActiveTabId,
  onAddNodeRef,
  onAddPostitRef,
  onAddContainerRef,
}: UseCanvasCreationParams): UseCanvasCreationReturn {

  // -------------------------------------------------------------------------
  // Draw-to-place state
  // -------------------------------------------------------------------------
  const drawStartRef = useRef<{ screenX: number; screenY: number; flowX: number; flowY: number; tool: string } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const DRAW_TOOLS = new Set(['new-postit', 'new-container', 'new-analysis']);

  // -------------------------------------------------------------------------
  // Right-drag lasso state (button 2 drag → context menu with drawn rect)
  // -------------------------------------------------------------------------
  const rightDragStartRef = useRef<{ screenX: number; screenY: number; flowX: number; flowY: number } | null>(null);
  const rightDragRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [rightDragRect, setRightDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const consumeRightDragRect = useCallback(() => {
    const rect = rightDragRectRef.current;
    rightDragRectRef.current = null;
    // Don't clear visual state here — rect stays visible while context menu is open.
    // clearRightDrag() handles full cleanup when the menu dismisses.
    console.log('[DIAG] consumeRightDragRect:', rect);
    return rect;
  }, []);

  const clearRightDrag = useCallback(() => {
    console.trace('[DIAG] clearRightDrag called');
    rightDragStartRef.current = null;
    rightDragRectRef.current = null;
    setRightDragRect(null);
  }, []);

  // -------------------------------------------------------------------------
  // Core creation callbacks
  // -------------------------------------------------------------------------

  const addNode = useCallback(() => {
    if (!graph) return;
    const viewportCenter = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const { graph: nextGraph, newUuid } = createNodeInGraph(graph, viewportCenter);
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newUuid);
    }
    setTimeout(() => {
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 50);
  }, [graph, setGraph, onSelectedNodeChange, screenToFlowPosition, saveHistoryState, setNodes]);

  const addNodeAtPosition = useCallback((x: number, y: number) => {
    if (!graph) return;
    const { graph: nextGraph, newUuid } = createNodeInGraph(graph, { x, y });
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newUuid);
    }
    setContextMenu(null);
    setTimeout(() => {
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 50);
  }, [graph, setGraph, saveHistoryState, setNodes, onSelectedNodeChange, setContextMenu]);

  const addPostitAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    if (!graph) return;
    const { graph: nextGraph, newId } = createPostitInGraph(graph, { x, y }, { width: w, height: h });
    setGraphDirect(nextGraph);
    saveHistoryState('Add post-it');
    setContextMenu(null);
    autoEditPostitIdRef.current = newId;
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'postit');
  }, [graph, setGraphDirect, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, setContextMenu, autoEditPostitIdRef]);

  const addPostit = useCallback(() => {
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addPostitAtPosition(centre.x, centre.y);
  }, [screenToFlowPosition, addPostitAtPosition]);

  const addContainerAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    if (!graph) return;
    const { graph: nextGraph, newId } = createContainerInGraph(graph, { x, y }, { width: w, height: h });
    setGraphDirect(nextGraph);
    saveHistoryState('Add container');
    setContextMenu(null);
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'container');
  }, [graph, setGraphDirect, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, setContextMenu]);

  const addContainer = useCallback(() => {
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addContainerAtPosition(centre.x, centre.y);
  }, [screenToFlowPosition, addContainerAtPosition]);

  const addCanvasAnalysisAtPosition = useCallback((x: number, y: number, dragData: any) => {
    if (!graph) return;
    const { graph: nextGraph, analysisId, analysis } = createCanvasAnalysisInGraph(graph, { x, y }, dragData);
    if (dragData.analysisResult) {
      canvasAnalysisTransientCache.set(analysisId, dragData.analysisResult);
    }
    autoSelectAnalysisIdRef.current = analysisId;
    setGraphDirect(nextGraph as any);
    saveHistoryState('Pin analysis to canvas');
    setContextMenu(null);
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(analysisId, 'canvasAnalysis');
  }, [graph, setGraphDirect, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, setContextMenu, autoSelectAnalysisIdRef]);

  const startPinnedCanvasAnalysis = useCallback((payload?: any) => {
    pendingAnalysisPayload = payload || {};
    setActiveElementTool('new-analysis');
  }, [setActiveElementTool]);

  const startAddChart = useCallback((detail?: { contextNodeIds?: string[]; contextEdgeIds?: string[] }) => {
    const ctxNodeIds: string[] = detail?.contextNodeIds || [];
    const ctxEdgeIds: string[] = detail?.contextEdgeIds || [];
    pendingAnalysisPayload = buildAddChartPayload(
      graph, nodes, edges, ctxNodeIds, ctxEdgeIds, isCanvasObjectNode, getContainedConversionNodeIds,
    );
    setActiveElementTool('new-analysis');
  }, [nodes, edges, isCanvasObjectNode, graph, setActiveElementTool, getContainedConversionNodeIds]);

  /** Create a chart immediately at position + optional size (used by right-drag lasso). */
  const addChartAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    const payload = buildAddChartPayload(
      graph, nodes, edges, [], [], isCanvasObjectNode, getContainedConversionNodeIds,
    );
    addCanvasAnalysisAtPosition(x, y, { ...(payload || {}), drawWidth: w, drawHeight: h });
  }, [graph, nodes, edges, isCanvasObjectNode, getContainedConversionNodeIds, addCanvasAnalysisAtPosition]);

  // -------------------------------------------------------------------------
  // Ref exports to parent
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (onAddNodeRef) {
      onAddNodeRef.current = addNode;
    }
  }, [addNode, onAddNodeRef]);

  useEffect(() => {
    if (onAddPostitRef) {
      onAddPostitRef.current = addPostit;
    }
  }, [addPostit, onAddPostitRef]);

  useEffect(() => {
    if (onAddContainerRef) {
      onAddContainerRef.current = addContainer;
    }
  }, [addContainer, onAddContainerRef]);

  // -------------------------------------------------------------------------
  // Event listeners for analysis pinning
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (tabId !== effectiveActiveTabId) return;
      startPinnedCanvasAnalysis(e.detail);
    };
    window.addEventListener('dagnet:pinAnalysisToCanvas', handler as any);
    return () => window.removeEventListener('dagnet:pinAnalysisToCanvas', handler as any);
  }, [startPinnedCanvasAnalysis, tabId, effectiveActiveTabId]);

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (tabId !== effectiveActiveTabId) return;
      const { screenX, screenY, dragData } = e.detail;
      const flowPos = screenToFlowPosition({ x: screenX, y: screenY });
      addCanvasAnalysisAtPosition(flowPos.x, flowPos.y, dragData);
    };
    window.addEventListener('dagnet:pinAnalysisAtScreenPosition', handler as any);
    return () => window.removeEventListener('dagnet:pinAnalysisAtScreenPosition', handler as any);
  }, [addCanvasAnalysisAtPosition, screenToFlowPosition, tabId, effectiveActiveTabId]);

  useEffect(() => {
    const handler = (e: Event) => {
      if (tabId !== effectiveActiveTabId) return;
      startAddChart((e as CustomEvent).detail || {});
    };
    window.addEventListener('dagnet:addAnalysis', handler as any);
    return () => window.removeEventListener('dagnet:addAnalysis', handler as any);
  }, [startAddChart, tabId, effectiveActiveTabId]);

  // -------------------------------------------------------------------------
  // Paste callbacks
  // -------------------------------------------------------------------------

  const pasteNodeAtPosition = useCallback(async (x: number, y: number) => {
    if (!graph) return;
    if (!copiedNode) { toast.error('No node copied'); return; }
    const nodeId = copiedNode.objectId;
    const file = fileRegistry.getFile(`node-${nodeId}`);
    if (!file) { toast.error(`Node file not found: ${nodeId}`); return; }
    const { graph: nextGraph, newUuid } = createNodeFromFileInGraph(graph, nodeId, file.data?.label || nodeId, { x, y });
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') { saveHistoryState('Paste node', newUuid); }
    setContextMenu(null);
    setTimeout(async () => {
      try {
        await dataOperationsService.getNodeFromFile({ nodeId, graph: nextGraph, setGraph: setGraph as any, targetNodeUuid: newUuid });
        toast.success(`Pasted node: ${nodeId}`);
      } catch (error) {
        console.error('[GraphCanvas] Failed to get node from file:', error);
        toast.error('Failed to load node data from file');
      }
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 100);
  }, [graph, setGraph, copiedNode, saveHistoryState, setNodes, onSelectedNodeChange, setContextMenu]);

  const pasteSubgraphAtPosition = useCallback(async (x: number, y: number) => {
    if (!graph) return;

    if (!copiedSubgraph) {
      toast.error('No subgraph copied');
      return;
    }

    // Calculate offset from first item's position to target position
    const firstNode = copiedSubgraph.nodes[0];
    const firstPostit = copiedSubgraph.postits?.[0];
    const firstContainer = copiedSubgraph.containers?.[0];
    const refX = firstNode?.layout?.x ?? firstPostit?.x ?? firstContainer?.x ?? 0;
    const refY = firstNode?.layout?.y ?? firstPostit?.y ?? firstContainer?.y ?? 0;
    const offsetX = x - refX;
    const offsetY = y - refY;

    // Import updateManager dynamically to avoid circular dependencies
    const { updateManager } = await import('../../services/UpdateManager');

    const result = updateManager.pasteSubgraph(
      graph,
      copiedSubgraph.nodes,
      copiedSubgraph.edges,
      { x: offsetX, y: offsetY },
      copiedSubgraph.postits,
      { containers: copiedSubgraph.containers, canvasAnalyses: copiedSubgraph.canvasAnalyses }
    );

    setGraph(result.graph);

    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Paste subgraph');
    }
    setContextMenu(null);

    const parts: string[] = [];
    if (result.pastedNodeUuids.length > 0) {
      parts.push(`${result.pastedNodeUuids.length} node${result.pastedNodeUuids.length !== 1 ? 's' : ''}`);
    }
    if (result.pastedEdgeUuids.length > 0) {
      parts.push(`${result.pastedEdgeUuids.length} edge${result.pastedEdgeUuids.length !== 1 ? 's' : ''}`);
    }
    const totalCanvasObjects = Object.values(result.pastedCanvasObjectIds).reduce((s: number, a: any) => s + a.length, 0);
    if (totalCanvasObjects > 0) {
      parts.push(`${totalCanvasObjects} canvas object${totalCanvasObjects !== 1 ? 's' : ''}`);
    }
    toast.success(`Pasted ${parts.join(' and ')}`);

    // Select the pasted items (nodes, postits, containers)
    setTimeout(() => {
      const pastedUuidSet = new Set(result.pastedNodeUuids);
      const pastedCanvasRfIds = new Set([
        ...result.pastedPostitIds.map((id: string) => `postit-${id}`),
        ...(result.pastedCanvasObjectIds['containers'] || []).map((id: string) => `container-${id}`),
      ]);
      setNodes((nodes) =>
        nodes.map((node) => ({
          ...node,
          selected: pastedUuidSet.has(node.id) || pastedCanvasRfIds.has(node.id)
        }))
      );
      if (result.pastedNodeUuids.length > 0) {
        onSelectedNodeChange(result.pastedNodeUuids[0]);
      } else if (result.pastedPostitIds.length > 0) {
        onSelectedAnnotationChange?.(result.pastedPostitIds[0], 'postit');
      }
    }, 100);
  }, [graph, setGraph, copiedSubgraph, saveHistoryState, setNodes, onSelectedNodeChange, onSelectedAnnotationChange, setContextMenu]);

  // -------------------------------------------------------------------------
  // Drop from Navigator
  // -------------------------------------------------------------------------

  const dropNodeAtPosition = useCallback(async (nodeId: string, x: number, y: number) => {
    if (!graph) return;
    const file = fileRegistry.getFile(`node-${nodeId}`);
    if (!file) { toast.error(`Node file not found: ${nodeId}`); return; }
    const { graph: nextGraph, newUuid } = createNodeFromFileInGraph(graph, nodeId, file.data?.label || nodeId, { x, y });
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') { saveHistoryState('Drop node', newUuid); }
    setTimeout(async () => {
      try {
        await dataOperationsService.getNodeFromFile({ nodeId, graph: nextGraph, setGraph: setGraph as any, targetNodeUuid: newUuid });
        toast.success(`Added node: ${nodeId}`);
      } catch (error) {
        console.error('[GraphCanvas] Failed to get node from file:', error);
        toast.error('Failed to load node data from file');
      }
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 100);
  }, [graph, setGraph, saveHistoryState, setNodes, onSelectedNodeChange]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();

    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (!jsonData) return;

      const dragData = JSON.parse(jsonData);
      if (dragData.type !== 'dagnet-drag') return;

      // Get drop position in flow coordinates
      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      if (dragData.objectType === 'node') {
        dropNodeAtPosition(dragData.objectId, position.x, position.y);
      } else if (dragData.objectType === 'new-node') {
        addNodeAtPosition(position.x, position.y);
      } else if (dragData.objectType === 'new-postit') {
        addPostitAtPosition(position.x, position.y);
      } else if (dragData.objectType === 'new-container') {
        addContainerAtPosition(position.x, position.y);
      } else if (dragData.objectType === 'canvas-analysis') {
        addCanvasAnalysisAtPosition(position.x, position.y, dragData);
      } else if (dragData.objectType === 'new-analysis') {
        addCanvasAnalysisAtPosition(position.x, position.y, {});
      } else if (dragData.objectType === 'parameter') {
        toast('Drop parameters onto an edge to attach them');
      }
    } catch (error) {
      console.error('[GraphCanvas] Drop error:', error);
    }
  }, [screenToFlowPosition, dropNodeAtPosition, addNodeAtPosition, addPostitAtPosition, addContainerAtPosition, addCanvasAnalysisAtPosition]);

  // -------------------------------------------------------------------------
  // Draw-to-place pointer handlers
  // -------------------------------------------------------------------------

  const onPaneMouseDown = useCallback((event: React.PointerEvent) => {
    // Right-drag for lasso creation (button 2)
    if (event.button === 2) {
      const target = event.target as HTMLElement;
      if (target.closest('.react-flow__node') || target.closest('.react-flow__edge')) return;
      const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      rightDragStartRef.current = { screenX: event.clientX, screenY: event.clientY, flowX: flowPos.x, flowY: flowPos.y };
      rightDragRectRef.current = null;
      setRightDragRect(null);
      return;
    }
    // Left-click draw-to-place (existing)
    if (!activeElementTool || !DRAW_TOOLS.has(activeElementTool)) return;
    const target = event.target as HTMLElement;
    if (target.closest('.react-flow__node') || target.closest('.react-flow__edge')) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    drawStartRef.current = { screenX: event.clientX, screenY: event.clientY, flowX: flowPos.x, flowY: flowPos.y, tool: activeElementTool };
    setDrawRect(null);
  }, [activeElementTool, screenToFlowPosition]);

  const onPaneMouseMove = useCallback((event: React.PointerEvent) => {
    // Right-drag rect tracking
    if (rightDragStartRef.current) {
      const sdx = event.clientX - rightDragStartRef.current.screenX;
      const sdy = event.clientY - rightDragStartRef.current.screenY;
      // Only show rect after 10px screen-space movement (avoid accidental micro-drags)
      if (sdx * sdx + sdy * sdy < 100) return;
      const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const sx = rightDragStartRef.current.flowX;
      const sy = rightDragStartRef.current.flowY;
      const rect = {
        x: Math.min(sx, flowPos.x),
        y: Math.min(sy, flowPos.y),
        w: Math.abs(flowPos.x - sx),
        h: Math.abs(flowPos.y - sy),
      };
      rightDragRectRef.current = rect;
      setRightDragRect(rect);
      return;
    }
    // Left-click draw (existing)
    if (!drawStartRef.current) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const sx = drawStartRef.current.flowX;
    const sy = drawStartRef.current.flowY;
    setDrawRect({
      x: Math.min(sx, flowPos.x),
      y: Math.min(sy, flowPos.y),
      w: Math.abs(flowPos.x - sx),
      h: Math.abs(flowPos.y - sy),
    });
  }, [screenToFlowPosition]);

  const onPaneMouseUp = useCallback((event: React.PointerEvent) => {
    // Right-drag: clear start ref, leave rect for contextmenu handler
    if (rightDragStartRef.current && event.button === 2) {
      rightDragStartRef.current = null;
      return;
    }
    // Left-click draw-to-place (existing)
    if (!drawStartRef.current) return;
    const tool = drawStartRef.current.tool;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const sx = drawStartRef.current.flowX;
    const sy = drawStartRef.current.flowY;
    const w = Math.abs(flowPos.x - sx);
    const h = Math.abs(flowPos.y - sy);
    const x = Math.min(sx, flowPos.x);
    const y = Math.min(sy, flowPos.y);
    drawStartRef.current = null;
    setDrawRect(null);
    if (tool === 'new-postit') {
      addPostitAtPosition(x, y, w, h);
    } else if (tool === 'new-container') {
      addContainerAtPosition(x, y, w, h);
    } else if (tool === 'new-analysis') {
      const payload = pendingAnalysisPayload;
      pendingAnalysisPayload = null;
      addCanvasAnalysisAtPosition(x, y, { ...(payload || {}), drawWidth: w, drawHeight: h });
    }
    onClearElementTool?.();
  }, [screenToFlowPosition, addPostitAtPosition, addContainerAtPosition, addCanvasAnalysisAtPosition, onClearElementTool]);

  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (activeElementTool === 'new-node') {
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNodeAtPosition(flowPosition.x, flowPosition.y);
      onClearElementTool?.();
    } else if (activeElementTool === 'new-container') {
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addContainerAtPosition(flowPosition.x, flowPosition.y);
      onClearElementTool?.();
    }
  }, [activeElementTool, screenToFlowPosition, addNodeAtPosition, addContainerAtPosition, onClearElementTool]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  return {
    addNodeAtPosition,
    addPostitAtPosition,
    addContainerAtPosition,
    addChartAtPosition,
    pasteNodeAtPosition,
    pasteSubgraphAtPosition,
    startAddChart,
    handleDragOver,
    handleDrop,
    onPaneMouseDown,
    onPaneMouseMove,
    onPaneMouseUp,
    onPaneClick,
    drawRect,
    drawStartRef,
    rightDragRect,
    consumeRightDragRect,
    clearRightDrag,
  };
}
