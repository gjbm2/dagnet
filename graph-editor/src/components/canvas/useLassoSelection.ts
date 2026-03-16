/**
 * useLassoSelection — custom hook for Shift+Drag lasso selection and
 * keyboard delete/escape handling.
 *
 * Owns: isLassoSelecting, lassoStart, lassoEnd, isShiftHeld state;
 *       window keydown/keyup/mouse event listeners for lasso + delete.
 *
 * Extracted from GraphCanvas Phase B4b (structural refactor, no behavioural change).
 */

import { useEffect, useRef, useState } from 'react';
import type { Node, Edge } from 'reactflow';
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from '@/lib/nodeEdgeConstants';
import { toNodeRect } from '../../services/alignmentService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseLassoSelectionParams {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  deleteSelected: () => void;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  activeElementTool: string | null | undefined;
  onClearElementTool?: () => void;
  tabId?: string;
}

export interface UseLassoSelectionReturn {
  isLassoSelecting: boolean;
  lassoStart: { x: number; y: number } | null;
  lassoEnd: { x: number; y: number } | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLassoSelection({
  nodes,
  edges,
  setNodes,
  deleteSelected,
  screenToFlowPosition,
  activeElementTool,
  onClearElementTool,
  tabId,
}: UseLassoSelectionParams): UseLassoSelectionReturn {
  const [isLassoSelecting, setIsLassoSelecting] = useState(false);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const lassoCompletedRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }

      // Escape: revert to pointer mode when a non-pointer tool is active
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor');
        if (!inInput && activeElementTool && activeElementTool !== 'select') {
          e.preventDefault();
          onClearElementTool?.();
          return;
        }
      }

      // Handle Delete key for selected elements
      if (e.key === 'Delete' || e.key === 'Backspace') {
        console.log(`[GraphCanvas ${tabId}] Delete key detected`);

        // FIRST: Check if user is typing in a form field or Monaco editor
        // (Exception: inputs with data-allow-global-shortcuts="true" should pass through for CTRL+Z/CTRL+Y only)
        const target = e.target as HTMLElement;
        const allowGlobalShortcuts = target.getAttribute?.('data-allow-global-shortcuts') === 'true';

        if (!allowGlobalShortcuts && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor'))) {
          console.log(`[GraphCanvas ${tabId}] Delete ignored - focus in input field without global shortcuts flag`);
          return; // Let the input field handle the Delete/Backspace
        }

        // SECOND: If not in an input, check for selected elements
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdges = edges.filter(e => e.selected);

        console.log(`[GraphCanvas ${tabId}] Delete key pressed, selected nodes:`, selectedNodes.length, 'selected edges:', selectedEdges.length);

        // If there are selected nodes or edges, delete them
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          console.log(`[GraphCanvas ${tabId}] Calling deleteSelected`);
          deleteSelected();
          return;
        }

        console.log(`[GraphCanvas ${tabId}] No selected elements to delete`);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isShiftHeld && e.target && (e.target as Element).closest('.react-flow')) {
        e.preventDefault();
        e.stopPropagation();

        // Store viewport coordinates (for screenToFlowPosition conversion)
        setIsLassoSelecting(true);
        setLassoStart({ x: e.clientX, y: e.clientY });
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart) {
        e.preventDefault();
        e.stopPropagation();

        // Store viewport coordinates (for screenToFlowPosition conversion)
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart && lassoEnd && !lassoCompletedRef.current) {
        lassoCompletedRef.current = true; // Prevent double execution
        e.preventDefault();
        e.stopPropagation();

        // Use ReactFlow's built-in coordinate conversion
        const flowStart = screenToFlowPosition({ x: lassoStart.x, y: lassoStart.y });
        const flowEnd = screenToFlowPosition({ x: lassoEnd.x, y: lassoEnd.y });

        const flowStartX = flowStart.x;
        const flowStartY = flowStart.y;
        const flowEndX = flowEnd.x;
        const flowEndY = flowEnd.y;

        const lassoRect = {
          left: Math.min(flowStartX, flowEndX),
          top: Math.min(flowStartY, flowEndY),
          right: Math.max(flowStartX, flowEndX),
          bottom: Math.max(flowStartY, flowEndY)
        };

        const selectedNodes = nodes.filter(node => {
          const rect = toNodeRect(node, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
          const nodeRect = {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
          };

          return !(nodeRect.right < lassoRect.left ||
                   nodeRect.left > lassoRect.right ||
                   nodeRect.bottom < lassoRect.top ||
                   nodeRect.top > lassoRect.bottom);
        });


        const selectedNodeIds = new Set(selectedNodes.map(n => n.id));
        const addToExisting = e.ctrlKey || e.metaKey;

        setNodes(prevNodes =>
          prevNodes.map(n => ({
            ...n,
            selected: selectedNodeIds.has(n.id) || (addToExisting && !!n.selected)
          }))
        );

        // Reset lasso state after a delay to allow selection to settle
        setTimeout(() => {
          setIsLassoSelecting(false);
          setLassoStart(null);
          setLassoEnd(null);
          lassoCompletedRef.current = false; // Reset for next lasso
        }, 100);
      } else {
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
        lassoCompletedRef.current = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes, edges, deleteSelected, tabId, activeElementTool, onClearElementTool, screenToFlowPosition]);

  return {
    isLassoSelecting,
    lassoStart,
    lassoEnd,
  };
}
