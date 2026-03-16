/**
 * useSnapToGuides — React hook wiring snap-to-guide line behaviour.
 *
 * Adapted from the xyflow Pro helper-lines example (perpetual licence).
 * Uses fully imperative canvas drawing — no React state changes during drag,
 * so no re-renders of the parent component tree.
 *
 * Handles both drag snapping and resize snapping.
 */

import { useCallback, useRef } from 'react';
import {
  Node,
  NodeChange,
  NodePositionChange,
  useReactFlow,
  useStore,
} from 'reactflow';
import { shallow } from 'zustand/shallow';
import HelperLinesRenderer from '../components/HelperLinesRenderer';
import type { HelperLinesHandle } from '../components/HelperLinesRenderer';
import {
  ALL_ANCHORS,
  Box,
  buildHelperLines,
  clearLastSnappedResize,
  getHelperLines,
  getSourceAnchorsForNode,
  setLastSnappedResize,
  snapPositionToHelperLines,
  snapResizeToHelperLines,
  SpatialIndex,
} from '../services/snapService';

export function useSnapToGuides() {
  const { width, height } = useStore(
    (state) => ({ width: state.width, height: state.height }),
    shallow,
  );

  const { screenToFlowPosition } = useReactFlow();

  const spatialIndexRef = useRef<SpatialIndex>(new SpatialIndex());
  const indexBuiltRef = useRef(false);
  const dragDiagFiredRef = useRef(false);
  const dragEventCountRef = useRef(0);
  const helperLinesRef = useRef<HelperLinesHandle>(null);

  // Stable refs for values needed in callbacks without causing re-creation
  const widthRef = useRef(width);
  const heightRef = useRef(height);
  widthRef.current = width;
  heightRef.current = height;
  const screenToFlowRef = useRef(screenToFlowPosition);
  screenToFlowRef.current = screenToFlowPosition;

  /** Compute the viewport box in flow coordinates. */
  const getViewportBox = (): Box => {
    const stfp = screenToFlowRef.current;
    const topLeft = stfp({ x: 0, y: 0 });
    const bottomRight = stfp({ x: widthRef.current, y: heightRef.current });
    return { x: topLeft.x, y: topLeft.y, x2: bottomRight.x, y2: bottomRight.y };
  };

  const rebuildIndex = useCallback((nodes: Node[]) => {
    helperLinesRef.current?.clear();
    const helperLines = buildHelperLines(nodes, ALL_ANCHORS);
    spatialIndexRef.current.initialize(helperLines);
    indexBuiltRef.current = true;
  }, []);

  const resetHelperLines = useCallback(() => {
    helperLinesRef.current?.clear();
    indexBuiltRef.current = false; // Force rebuild on next drag
    dragDiagFiredRef.current = false;
  }, []);

  /**
   * Intercept node changes to apply snap-to-guide behaviour for both
   * drag and resize operations.
   *
   * PERFORMANCE: This runs on EVERY onNodesChange call (including select,
   * etc.). The fast path must be as cheap as possible — no allocations,
   * no logging, no .map().
   */
  const applySnapToChanges = useCallback(
    (
      changes: NodeChange[],
      nodes: Node[],
      enabled: boolean,
      altKeyPressed: boolean,
      sankeyMode?: boolean,
    ): NodeChange[] => {
      if (!enabled || altKeyPressed) {
        helperLinesRef.current?.clear();
        return changes;
      }

      // ── Scan changes in one pass ──
      // Look for: drag position changes (dragging === true),
      // resize dimension changes (resizing === true), and resize end.
      let dragChange: NodePositionChange | undefined;
      let dragCount = 0;
      let hasDragging = false;
      let resizeDimChange: any | undefined;  // NodeDimensionChange
      let resizePosChange: NodePositionChange | undefined;
      let resizeEnded = false;

      for (let i = 0; i < changes.length; i++) {
        const c = changes[i] as any;
        if (c.type === 'position') {
          if (c.dragging) hasDragging = true;
          if (c.dragging === true) {
            dragCount++;
            if (dragCount === 1) dragChange = c;
            if (dragCount > 1) break;
          } else if (resizeDimChange && c.id === resizeDimChange.id) {
            // Position change accompanying a resize (left/top edge resize)
            resizePosChange = c;
          }
        } else if (c.type === 'dimensions') {
          if (c.resizing === true && c.dimensions) {
            resizeDimChange = c;
          } else if (c.resizing === false) {
            resizeEnded = true;
          }
        }
      }

      // If we found a resize dim change but haven't found the position change yet
      // (it might appear before the dim change), do a second pass
      if (resizeDimChange && !resizePosChange) {
        for (let i = 0; i < changes.length; i++) {
          const c = changes[i] as any;
          if (c.type === 'position' && c.id === resizeDimChange.id && c.dragging !== true) {
            resizePosChange = c;
            break;
          }
        }
      }

      // Dev: log when we see position changes but no dragging flag
      if (import.meta.env.DEV && !dragChange && !resizeDimChange && !resizeEnded) {
        const posChanges = changes.filter((c: any) => c.type === 'position');
        if (posChanges.length > 0) {
          console.log('[snap] POSITION changes without dragging=true', {
            count: posChanges.length,
            hasDragging,
            sample: (posChanges[0] as any),
            changeTypes: changes.map((c: any) => `${c.type}${c.dragging !== undefined ? ':drag=' + c.dragging : ''}`),
          });
        }
      }

      // ── Handle drag snapping ──
      if (dragCount === 1 && dragChange?.position) {
        if (!indexBuiltRef.current) {
          rebuildIndex(nodes);
          dragDiagFiredRef.current = false;
          dragEventCountRef.current = 0;
        }

        dragEventCountRef.current++;

        const node = nodes.find(n => n.id === dragChange!.id);
        if (!node) {
          helperLinesRef.current?.clear();
          return changes;
        }

        const w = (node.style as any)?.width ?? node.width ?? 110;
        const h = (node.style as any)?.height ?? node.height ?? 110;
        const nodeBox: Box = {
          x: dragChange.position.x,
          y: dragChange.position.y,
          x2: dragChange.position.x + w,
          y2: dragChange.position.y + h,
        };

        const sourceAnchors = getSourceAnchorsForNode(node.id, sankeyMode);
        const viewportBox = getViewportBox();

        const { horizontal: hMatch, vertical: vMatch } = getHelperLines(
          spatialIndexRef.current,
          viewportBox,
          node,
          nodeBox,
          sourceAnchors,
        );

        const { snappedX, snappedY } = snapPositionToHelperLines(
          node,
          dragChange,
          hMatch,
          vMatch,
        );

        // Dev-only: log first event per drag + every 10th event
        if (import.meta.env.DEV) {
          const evtN = dragEventCountRef.current;
          if (!dragDiagFiredRef.current || evtN % 10 === 0) {
            dragDiagFiredRef.current = true;
            const si = spatialIndexRef.current;
            console.log(`[snap] DRAG evt#${evtN}`, {
              nodeId: node.id,
              nodeBox,
              viewportBox,
              xLines: (si as any).xLines?.length ?? -1,
              yLines: (si as any).yLines?.length ?? -1,
              nodesInIndex: nodes.length,
              hMatch: hMatch ? { anchor: hMatch.anchorName, src: hMatch.sourcePosition, target: hMatch.line.position, targetNode: hMatch.line.node.id } : null,
              vMatch: vMatch ? { anchor: vMatch.anchorName, src: vMatch.sourcePosition, target: vMatch.line.position, targetNode: vMatch.line.node.id } : null,
              snappedX,
              snappedY,
              hasCanvasRef: !!helperLinesRef.current,
            });
          }
        }

        // Dev-only diagnostic for E2E tests
        if (import.meta.env.DEV && (window as any).__snapDiag) {
          (window as any).__snapDiag.lastDrag = {
            nodeId: node.id,
            sourceAnchors,
            hMatch: hMatch ? { anchor: hMatch.anchorName, pos: hMatch.sourcePosition, linePos: hMatch.line.position } : null,
            vMatch: vMatch ? { anchor: vMatch.anchorName, pos: vMatch.sourcePosition, linePos: vMatch.line.position } : null,
            snappedX,
            snappedY,
            nodeBox,
            viewportBox,
            xLinesCount: spatialIndexRef.current['xLines']?.length ?? -1,
            yLinesCount: spatialIndexRef.current['yLines']?.length ?? -1,
          };
        }

        if (snappedX || snappedY) {
          helperLinesRef.current?.draw(
            snappedY ? hMatch?.line : undefined,
            snappedX ? vMatch?.line : undefined,
          );
        } else {
          helperLinesRef.current?.clear();
        }

        return changes;
      }

      // ── Handle resize snapping ──
      if (resizeDimChange) {
        if (!indexBuiltRef.current) rebuildIndex(nodes);

        const node = nodes.find(n => n.id === resizeDimChange.id);
        if (!node) {
          helperLinesRef.current?.clear();
          return changes;
        }

        const viewportBox = getViewportBox();
        const { snappedX, snappedY, hLine, vLine } = snapResizeToHelperLines(
          node,
          resizeDimChange,
          resizePosChange,
          spatialIndexRef.current,
          viewportBox,
        );

        // Remember snapped dimensions so resize-end callbacks can use them
        // instead of d3-drag's unsnapped params.
        if (snappedX || snappedY) {
          const pos = resizePosChange?.position ?? node.position;
          setLastSnappedResize({
            nodeId: node.id,
            x: pos.x,
            y: pos.y,
            width: resizeDimChange.dimensions.width,
            height: resizeDimChange.dimensions.height,
          });
          helperLinesRef.current?.draw(
            snappedY ? hLine : undefined,
            snappedX ? vLine : undefined,
          );
        } else {
          clearLastSnappedResize();
          helperLinesRef.current?.clear();
        }

        return changes;
      }

      // Resize ended — clear guide lines, rebuild index
      if (resizeEnded) {
        helperLinesRef.current?.clear();
        indexBuiltRef.current = false; // Force rebuild on next interaction
        return changes;
      }

      // Multi-select drag — skip snapping
      if (dragCount > 1) {
        helperLinesRef.current?.clear();
      }

      return changes;
    },
    [rebuildIndex],
  );

  // Stable component — never changes identity, no props, no re-renders of parent
  const HelperLines = useCallback(() => {
    return <HelperLinesRenderer ref={helperLinesRef} />;
  }, []);

  return {
    rebuildIndex,
    applySnapToChanges,
    resetHelperLines,
    HelperLines,
  };
}
