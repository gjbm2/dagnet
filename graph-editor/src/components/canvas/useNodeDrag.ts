/**
 * useNodeDrag — custom hook for node drag start/move/stop handlers
 * and container group-drag logic.
 *
 * Owns: hasNodeMovedRef, containerDragContainedRef, containerDragLastPosRef,
 *       dragTimeoutRef, onNodeDragStart, onNodeDrag, onNodeDragStop.
 *
 * Extracted from GraphCanvas Phase B4c (structural refactor, no behavioural change).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Node, Edge } from 'reactflow';
import { fromFlow } from '@/lib/transform';
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from '@/lib/nodeEdgeConstants';
import { canvasAnalysisResultCache } from '@/hooks/useCanvasAnalysisCompute';
import type { SyncGuards } from './syncGuards';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseNodeDragParams {
  graph: any;
  nodes: Node[];
  edges: Edge[];
  setGraph: (graph: any, oldGraph?: any, source?: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  saveHistoryState: (action: string, nodeId?: string, edgeId?: string) => void;
  resetHelperLines: () => void;
  rebuildSnapIndex: (nodes: Node[]) => void;
  guards: SyncGuards;
  setIsDraggingNode: (dragging: boolean) => void;
  setDraggedAnalysisId: (id: string | null) => void;
  lastSyncedReactFlowRef: React.MutableRefObject<string | null>;
}

export interface UseNodeDragReturn {
  onNodeDragStart: (event: any, node: any) => void;
  onNodeDrag: (event: any, node: any) => void;
  onNodeDragStop: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNodeDrag({
  graph,
  nodes,
  edges,
  setGraph,
  setNodes,
  saveHistoryState,
  resetHelperLines,
  rebuildSnapIndex,
  guards,
  setIsDraggingNode,
  setDraggedAnalysisId,
  lastSyncedReactFlowRef,
}: UseNodeDragParams): UseNodeDragReturn {

  // -------------------------------------------------------------------------
  // Internal refs
  // -------------------------------------------------------------------------
  const hasNodeMovedRef = useRef(false);
  const containerDragContainedRef = useRef<Set<string> | null>(null);
  const containerDragLastPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragTimeoutRef = useRef<number | null>(null);
  // Analysis merge-on-drop: tracks the target analysis node during drag
  const mergeTargetRef = useRef<string | null>(null);
  const draggedAnalysisIdRef = useRef<string | null>(null);

  // -------------------------------------------------------------------------
  // onNodeDragStart
  // -------------------------------------------------------------------------
  const onNodeDragStart = useCallback((_event: any, _node: any) => {
    hasNodeMovedRef.current = false;
    resetHelperLines();

    // Block Graph→ReactFlow sync during drag to prevent interruption
    guards.beginInteraction('drag');
    setIsDraggingNode(true);

    // Track the specific analysis being dragged so SelectionConnectors
    // can show connectors/shapes/halos for it (same codepath as selection).
    // Only single-tab containers participate in merge-on-drop — multi-tab
    // containers are established objects that should just move.
    if (_node.id?.startsWith('analysis-')) {
      const aid = _node.id.replace('analysis-', '');
      const analysis = graph?.canvasAnalyses?.find((a: any) => a.id === aid);
      const tabCount = analysis?.content_items?.length ?? 1;
      setDraggedAnalysisId(aid);
      draggedAnalysisIdRef.current = tabCount <= 1 ? aid : null;
      // Highlight available dropzones for single-tab container drag
      if (draggedAnalysisIdRef.current) {
        document.querySelectorAll<HTMLElement>('[data-dropzone^="analysis-"]').forEach(el => {
          if (el.getAttribute('data-dropzone') !== `analysis-${aid}`) {
            el.classList.add('dropzone-highlight');
          }
        });
      }
    } else {
      setDraggedAnalysisId(null);
      draggedAnalysisIdRef.current = null;
    }
    mergeTargetRef.current = null;

    // Container group drag: snapshot contained objects
    if (_node.id?.startsWith('container-')) {
      const containerPos = _node.position || { x: 0, y: 0 };
      const containerW = (_node as any).measured?.width ?? _node.width ?? (typeof _node.style?.width === 'number' ? _node.style.width : 400);
      const containerH = (_node as any).measured?.height ?? _node.height ?? (typeof _node.style?.height === 'number' ? _node.style.height : 300);

      console.log(`[GroupDrag] Container ${_node.id}: pos=(${containerPos.x},${containerPos.y}) size=(${containerW}x${containerH}) measured=${JSON.stringify((_node as any).measured)} style.w=${_node.style?.width} style.h=${_node.style?.height} width=${_node.width} height=${_node.height}`);

      const CONTAIN_TOLERANCE = 10;
      const isFullyInside = (n: any, px: number, py: number, pw: number, ph: number) => {
        const nw = (n as any).measured?.width ?? n.width ?? (typeof n.style?.width === 'number' ? n.style.width : (n.id?.startsWith('container-') ? 400 : n.id?.startsWith('postit-') ? 200 : DEFAULT_NODE_WIDTH));
        const nh = (n as any).measured?.height ?? n.height ?? (typeof n.style?.height === 'number' ? n.style.height : (n.id?.startsWith('container-') ? 300 : n.id?.startsWith('postit-') ? 150 : DEFAULT_NODE_HEIGHT));
        const nx = n.position?.x ?? 0;
        const ny = n.position?.y ?? 0;
        const inside = nx >= (px - CONTAIN_TOLERANCE) && ny >= (py - CONTAIN_TOLERANCE) &&
               (nx + nw) <= (px + pw + CONTAIN_TOLERANCE) && (ny + nh) <= (py + ph + CONTAIN_TOLERANCE);
        if (!n.id?.startsWith('container-') && !n.id?.startsWith('postit-') && !n.id?.startsWith('analysis-')) {
          console.log(`[GroupDrag]   Node ${n.id}: pos=(${nx},${ny}) size=(${nw}x${nh}) endAt=(${nx+nw},${ny+nh}) inside=${inside} measured=${JSON.stringify((n as any).measured)} width=${n.width}`);
        }
        return inside;
      };

      // Recursively collect all contained objects (nodes, postits, nested containers)
      const contained = new Set<string>();
      const selectedIds = new Set(nodes.filter(n => n.selected).map(n => n.id));

      const collectContained = (parentId: string, px: number, py: number, pw: number, ph: number) => {
        for (const n of nodes) {
          if (n.id === parentId || contained.has(n.id) || selectedIds.has(n.id)) continue;
          if (isFullyInside(n, px, py, pw, ph)) {
            contained.add(n.id);
            // Recurse into nested containers
            if (n.id?.startsWith('container-')) {
              const nw = (n as any).measured?.width ?? n.style?.width ?? 400;
              const nh = (n as any).measured?.height ?? n.style?.height ?? 300;
              collectContained(n.id, n.position?.x ?? 0, n.position?.y ?? 0, nw, nh);
            }
          }
        }
      };

      collectContained(_node.id, containerPos.x, containerPos.y, containerW, containerH);
      containerDragContainedRef.current = contained.size > 0 ? contained : null;
      containerDragLastPosRef.current = { x: containerPos.x, y: containerPos.y };
    } else {
      containerDragContainedRef.current = null;
      containerDragLastPosRef.current = null;
    }

    // Failsafe: clear drag flag if it somehow gets stuck
    if (dragTimeoutRef.current) {
      clearTimeout(dragTimeoutRef.current);
    }
    dragTimeoutRef.current = window.setTimeout(() => {
      if (guards.isDragging()) {
        console.log('[GraphCanvas] Drag timeout elapsed, clearing drag flag (failsafe)');
        guards.endInteraction('drag');
        setIsDraggingNode(false);
        setDraggedAnalysisId(null);
      }
      dragTimeoutRef.current = null;
    }, 30000);
  }, [graph, nodes, resetHelperLines, guards, setIsDraggingNode, setDraggedAnalysisId]);

  // -------------------------------------------------------------------------
  // onNodeDrag
  // -------------------------------------------------------------------------
  const onNodeDrag = useCallback((_event: any, draggedNode: any) => {
    if (!hasNodeMovedRef.current) {
      hasNodeMovedRef.current = true;
    }

    // Analysis merge detection: use pointer position to find target dropzone
    // (title bar / tab bar only — not the whole container)
    if (draggedAnalysisIdRef.current && draggedNode.id?.startsWith('analysis-')) {
      const elements = document.elementsFromPoint(_event.clientX, _event.clientY);
      let bestTarget: string | null = null;
      for (const el of elements) {
        const dz = (el as HTMLElement).closest?.('[data-dropzone^="analysis-"]');
        if (dz) {
          const aid = (dz.getAttribute('data-dropzone') || '').replace('analysis-', '');
          if (aid !== draggedAnalysisIdRef.current) { bestTarget = aid; break; }
        }
      }

      if (bestTarget !== mergeTargetRef.current) {
        // Clear old snap-in preview
        if (mergeTargetRef.current) {
          window.dispatchEvent(new CustomEvent('dagnet:clearContentItemPreview', {
            detail: { targetAnalysisId: mergeTargetRef.current },
          }));
        }
        mergeTargetRef.current = bestTarget;
        // Show snap-in preview tab on new target + hide the dragged node
        // (it visually "snaps in" — one visual representation, not two)
        if (bestTarget) {
          const sourceAnalysis = graph?.canvasAnalyses?.find((a: any) => a.id === draggedAnalysisIdRef.current);
          let previewItem = sourceAnalysis?.content_items?.[0];
          // Ensure preview item carries DSL (backfill from container if legacy)
          if (previewItem && !previewItem.analytics_dsl && sourceAnalysis?.content_items?.[0]?.analytics_dsl) {
            previewItem = { ...previewItem, analytics_dsl: sourceAnalysis.content_items[0].analytics_dsl };
          }
          if (previewItem) {
            // Pass cached result so the target can render real chart content
            const cachedResult = canvasAnalysisResultCache.get(draggedAnalysisIdRef.current!);
            window.dispatchEvent(new CustomEvent('dagnet:previewContentItem', {
              detail: {
                targetAnalysisId: bestTarget,
                contentItem: previewItem,
                analysisResult: cachedResult ?? null,
              },
            }));
          }
        }
        // Hide/show dragged node via direct DOM (avoids React re-render cascade).
        // Use visibility (not opacity) because .selected has opacity: 1 !important.
        const nodeEl = document.querySelector(`[data-id="${draggedNode.id}"]`) as HTMLElement | null;
        if (nodeEl) nodeEl.style.visibility = bestTarget ? 'hidden' : '';
      }
    }

    // Container group drag: move contained objects by delta
    if (containerDragContainedRef.current && containerDragLastPosRef.current) {
      const dx = (draggedNode.position?.x ?? 0) - containerDragLastPosRef.current.x;
      const dy = (draggedNode.position?.y ?? 0) - containerDragLastPosRef.current.y;
      containerDragLastPosRef.current = { x: draggedNode.position?.x ?? 0, y: draggedNode.position?.y ?? 0 };

      if (dx !== 0 || dy !== 0) {
        const containedIds = containerDragContainedRef.current;
        setNodes(nds => nds.map(n => {
          if (containedIds.has(n.id)) {
            return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
          }
          return n;
        }));
      }
    }
  }, [graph, setNodes]);

  // -------------------------------------------------------------------------
  // onNodeDragStop
  // -------------------------------------------------------------------------
  const onNodeDragStop = useCallback(() => {
    // Clear snap-to-guide state and rebuild index with final positions
    resetHelperLines();
    rebuildSnapIndex(nodes);

    // Clear container group drag state
    containerDragContainedRef.current = null;
    containerDragLastPosRef.current = null;

    // Clear dropzone highlights
    document.querySelectorAll('.dropzone-highlight').forEach(el => el.classList.remove('dropzone-highlight'));

    // Analysis merge: if dropped on another analysis node, dispatch merge event
    // When merging, skip the normal position sync — the source node is being deleted.
    const didMerge = !!(mergeTargetRef.current && draggedAnalysisIdRef.current);
    const draggedNodeId = draggedAnalysisIdRef.current
      ? `analysis-${draggedAnalysisIdRef.current}` : null;
    if (didMerge) {
      const sourceId = draggedAnalysisIdRef.current!;
      const targetId = mergeTargetRef.current!;
      // Clear snap-in preview
      window.dispatchEvent(new CustomEvent('dagnet:clearContentItemPreview', {
        detail: { targetAnalysisId: targetId },
      }));
      // Dispatch merge (source node will be deleted — no need to restore opacity)
      window.dispatchEvent(new CustomEvent('dagnet:mergeContainers', {
        detail: { sourceAnalysisId: sourceId, targetAnalysisId: targetId },
      }));
    } else if (draggedNodeId) {
      // No merge — restore visibility on the dragged node in case it was hidden
      const nodeEl = document.querySelector(`[data-id="${draggedNodeId}"]`) as HTMLElement | null;
      if (nodeEl) nodeEl.style.visibility = '';
    }
    mergeTargetRef.current = null;
    draggedAnalysisIdRef.current = null;

    if (didMerge) {
      // Merge handler already updated the graph — just clear drag state
      guards.endInteraction('drag');
      setIsDraggingNode(false);
      setDraggedAnalysisId(null);
      return;
    }

    // Keep drag flag set - it will be cleared by the sync effect when it takes the fast path
    // Use double requestAnimationFrame to ensure ReactFlow has finished updating node positions
    // and React has re-rendered before we sync to graph store and trigger edge recalculation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setDraggedAnalysisId(null);

        // Only sync positions & save history if the node actually moved.
        if (hasNodeMovedRef.current && graph && nodes.length > 0) {
          const updatedGraph = fromFlow(nodes, edges, graph);
          if (updatedGraph) {
            const updatedJson = JSON.stringify(updatedGraph);
            // Only update if positions actually changed
            if (updatedJson !== lastSyncedReactFlowRef.current) {
              console.log(`🎯 Syncing node positions to graph store after drag`);
              guards.beginConnectionSync();
              lastSyncedReactFlowRef.current = updatedJson;
              // Keep drag guard active - sync effect will clear it after taking fast path
              setGraph(updatedGraph);
              // Clear syncing flag and drag state AFTER the sync render settles,
              // so edge components still see isDraggingNode=true and suppress hover previews
              setTimeout(() => {
                guards.endInteraction('drag');
                setIsDraggingNode(false);
              }, 0);
              guards.endConnectionSync(0);
            } else {
              // No position change, clear flags immediately
              guards.endInteraction('drag');
              setIsDraggingNode(false);
            }
          } else {
            // No graph update, clear flags immediately
            guards.endInteraction('drag');
            setIsDraggingNode(false);
          }

          // Save the FINAL position to history after the ReactFlow→Store sync completes
          // Use setTimeout to ensure sync completes first
          setTimeout(() => {
            saveHistoryState('Move node');
          }, 0);
        } else {
          // Click-only (no movement) - just clear drag flag, no graph update or history entry
          guards.endInteraction('drag');
          setIsDraggingNode(false);
        }
      });
    });
  }, [saveHistoryState, graph, nodes, edges, setGraph, resetHelperLines, rebuildSnapIndex, guards, setIsDraggingNode, setDraggedAnalysisId, lastSyncedReactFlowRef]);

  // -------------------------------------------------------------------------
  // Cleanup drag timeout on unmount
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = null;
      }
    };
  }, []);

  return {
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
  };
}
