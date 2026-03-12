/**
 * HoverAnalysisPreview
 *
 * Portal-rendered analysis preview card that appears on node/edge hover.
 * Shows instant FE-computed analysis result (node_info / edge_info).
 * Draggable to canvas to persist as a standard analysis object.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { GripVertical } from 'lucide-react';
import { AnalysisInfoCard } from './analytics/AnalysisInfoCard';
import { computeLocalResult, computeLocalResultMultiScenario, type LocalScenario } from '../services/localAnalysisComputeService';
import { buildGraphForAnalysisLayer } from '../services/CompositionService';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import type { ConversionGraph, Graph } from '../types';
import type { AnalysisResult } from '../lib/graphComputeClient';

interface HoverAnalysisPreviewProps {
  /** The current graph (for FE compute) */
  graph: ConversionGraph;
  /** For node_info: the node ID */
  nodeId?: string;
  /** For edge_info: source node ref */
  edgeSource?: string;
  /** For edge_info: target node ref */
  edgeTarget?: string;
  /** Anchor point: top-centre of the trigger element (screen coords) */
  position: { x: number; y: number };
  /** Bottom edge of trigger element — for fallback positioning below */
  triggerBottom?: number;
  /** Scenario graphs — when provided, result includes per-scenario data */
  scenarios?: LocalScenario[];
  /** Current canvas zoom (for sizing the pinned object correctly) */
  canvasZoom?: number;
  /** Signal that mouse entered the card (cancels hook dismiss timer) */
  onCardEnter: () => void;
  /** Signal that mouse left the card (starts hook dismiss timer) */
  onCardLeave: () => void;
  /** Force dismiss (e.g. after drag) */
  onDismiss: () => void;
}

export function HoverAnalysisPreview({
  graph,
  nodeId,
  edgeSource,
  edgeTarget,
  position,
  triggerBottom,
  scenarios,
  canvasZoom,
  onCardEnter,
  onCardLeave,
  onDismiss,
}: HoverAnalysisPreviewProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);

  // Determine analysis type and DSL
  const { analysisType, dsl } = useMemo(() => {
    if (nodeId) {
      return { analysisType: 'node_info', dsl: `from(${nodeId})` };
    }
    if (edgeSource && edgeTarget) {
      return { analysisType: 'edge_info', dsl: `from(${edgeSource}).to(${edgeTarget})` };
    }
    return { analysisType: '', dsl: '' };
  }, [nodeId, edgeSource, edgeTarget]);

  // Compute result instantly from FE graph data — with scenario support
  const result: AnalysisResult | null = useMemo(() => {
    if (!analysisType || !dsl) return null;
    const response = scenarios && scenarios.length > 0
      ? computeLocalResultMultiScenario(scenarios, analysisType, dsl)
      : computeLocalResult(graph, analysisType, dsl);
    return response.success ? response.result ?? null : null;
  }, [graph, analysisType, dsl, scenarios]);

  // Self-correct position to stay within viewport
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = position;

    // Position above the trigger element by default (position.y = element top)
    y = y - rect.height - 8;

    // If above viewport, show below the trigger element instead
    if (y < 8) {
      y = (triggerBottom ?? position.y) + 8;
    }

    // Centre horizontally on the trigger element
    x = x - rect.width / 2;

    // Clamp to viewport
    if (x + rect.width > vw - 20) x = vw - rect.width - 20;
    if (x < 20) x = 20;
    if (y + rect.height > vh - 20) y = vh - rect.height - 20;
    if (y < 20) y = 20;

    setAdjustedPos({ x, y });
  }, [position.x, position.y, result]);

  // Custom pointer drag — the card itself follows the mouse, then pins on release
  const dragState = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleGripPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = cardRef.current;
    if (!el) return;
    // Offset: where in the card the user grabbed
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - adjustedPos.x,
      offsetY: e.clientY - adjustedPos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, [adjustedPos]);

  const handleGripPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    setAdjustedPos({
      x: e.clientX - dragState.current.offsetX,
      y: e.clientY - dragState.current.offsetY,
    });
  }, []);

  const handleGripPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const ds = dragState.current;
    dragState.current = null;
    setDragging(false);

    // Check if this was actually a drag (moved more than 3px)
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    const wasDrag = (dx * dx + dy * dy) > 9;
    if (!wasDrag) return; // Just a click on the grip — ignore

    // Measure card size and convert to canvas coordinates
    const el = cardRef.current;
    const z = canvasZoom || 1;
    const drawWidth = el ? el.offsetWidth / z : undefined;
    const drawHeight = el ? el.offsetHeight / z : undefined;

    // Pin at the card's top-left corner (not the mouse position)
    // adjustedPos is the card's current top-left in screen coordinates;
    // screenToFlowPosition in GraphCanvas will convert to flow/canvas coordinates.
    const cardLeft = e.clientX - ds.offsetX;
    const cardTop = e.clientY - ds.offsetY;

    // Capture the effective font size from the rendered card so the
    // persisted canvas node looks identical to the tooltip.
    const computedFontSize = el ? parseFloat(getComputedStyle(el).fontSize) || 10 : 10;

    const dragData = {
      type: 'dagnet-drag',
      objectType: 'canvas-analysis',
      recipe: {
        analysis: {
          analysis_type: analysisType,
          analytics_dsl: dsl,
        },
      },
      viewMode: 'chart',
      chartKind: 'info',
      analysisTypeOverridden: true,
      analysisResult: result,
      drawWidth,
      drawHeight,
      display: {
        font_size: computedFontSize,
        scale_with_canvas: false,
      },
    };
    window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisAtScreenPosition', {
      detail: { screenX: cardLeft, screenY: cardTop, dragData },
    }));

    onDismiss();
  }, [analysisType, dsl, result, onDismiss, canvasZoom]);

  if (!result) return null;

  return ReactDOM.createPortal(
    <div
      ref={cardRef}
      className={'hover-analysis-preview' + (dragging ? ' hover-analysis-preview--dragging' : '')}
      onMouseEnter={dragging ? undefined : onCardEnter}
      onMouseLeave={dragging ? undefined : onCardLeave}
      onPointerDown={handleGripPointerDown}
      onPointerMove={handleGripPointerMove}
      onPointerUp={handleGripPointerUp}
      style={{
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
        zIndex: 9999,
        pointerEvents: 'auto',
        cursor: dragging ? 'grabbing' : 'grab',
      }}
    >
      <div className="hover-analysis-preview-header">
        <GripVertical size={12} className="hover-analysis-preview-grip" />
        <span className="hover-analysis-preview-title">{result.analysis_name}</span>
        <span className="hover-analysis-preview-hint">drag to pin</span>
      </div>
      <div className="hover-analysis-preview-body">
        <AnalysisInfoCard result={result} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * Hook that manages the hover lifecycle for showing HoverAnalysisPreview.
 *
 * All timer management is centralized here. The preview card signals
 * hover state back to the hook via onCardEnter/onCardLeave, which the
 * hook uses to cancel/start dismiss timers.
 */
export function useHoverPreview(delay = 500, gracePeriod = 300) {
  const [previewState, setPreviewState] = useState<{
    position: { x: number; y: number };
    /** Bottom edge of trigger element — used for fallback positioning below */
    triggerBottom?: number;
  } | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveringTriggerRef = useRef(false);
  const isHoveringCardRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
  }, []);

  const startGraceTimer = useCallback(() => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = setTimeout(() => {
      // Only dismiss if neither trigger nor card is hovered
      if (!isHoveringTriggerRef.current && !isHoveringCardRef.current) {
        setPreviewState(null);
      }
    }, gracePeriod);
  }, [gracePeriod]);

  const handleTriggerEnter = useCallback((e: { currentTarget?: Element | null; clientX: number; clientY: number }) => {
    isHoveringTriggerRef.current = true;
    // Cancel any pending dismiss
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    // If preview is already showing, keep it
    if (previewState) return;
    // Start delay to show
    if (showTimerRef.current) clearTimeout(showTimerRef.current);

    // Position based on the graph object's bounding rect, not the cursor.
    // This ensures the preview never appears under the pointer.
    const el = e.currentTarget;
    const rect = el?.getBoundingClientRect?.();
    const pos = rect
      ? { x: rect.left + rect.width / 2, y: rect.top }   // top-centre of element
      : { x: e.clientX, y: e.clientY };                    // fallback to cursor
    const triggerBottom = rect ? rect.bottom : undefined;

    showTimerRef.current = setTimeout(() => {
      if (isHoveringTriggerRef.current) {
        setPreviewState({ position: pos, triggerBottom });
      }
    }, delay);
  }, [delay, previewState]);

  const handleTriggerLeave = useCallback(() => {
    isHoveringTriggerRef.current = false;
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    // Start grace timer — card's onCardEnter will cancel if mouse moves to card
    startGraceTimer();
  }, [startGraceTimer]);

  /** Card signals mouse entered it */
  const handleCardEnter = useCallback(() => {
    isHoveringCardRef.current = true;
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
  }, []);

  /** Card signals mouse left it */
  const handleCardLeave = useCallback(() => {
    isHoveringCardRef.current = false;
    startGraceTimer();
  }, [startGraceTimer]);

  /** Force dismiss (e.g. after drag) */
  const handleDismiss = useCallback(() => {
    clearAllTimers();
    isHoveringTriggerRef.current = false;
    isHoveringCardRef.current = false;
    setPreviewState(null);
  }, [clearAllTimers]);

  // Dismiss instantly on any mousedown outside the preview card.
  // When the user clicks to select a node/edge, the preview should get out of the way.
  const cardActiveRef = useRef(false);
  useEffect(() => {
    cardActiveRef.current = !!previewState;
  }, [previewState]);

  useEffect(() => {
    const onMouseDown = () => {
      // If preview is showing and mouse is not on the card, dismiss instantly
      if (cardActiveRef.current && !isHoveringCardRef.current) {
        clearAllTimers();
        isHoveringTriggerRef.current = false;
        isHoveringCardRef.current = false;
        setPreviewState(null);
      }
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [clearAllTimers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => clearAllTimers();
  }, [clearAllTimers]);

  return {
    previewState,
    handleTriggerEnter,
    handleTriggerLeave,
    handleCardEnter,
    handleCardLeave,
    handleDismiss,
  };
}

/**
 * Build LocalScenario[] for hover preview from the current scenario context.
 * Returns undefined when no scenarios are active (single-graph fallback).
 */
export function useHoverScenarios(graph: ConversionGraph | Graph | null): LocalScenario[] | undefined {
  const scenariosCtx = useScenariosContextOptional();
  const { tabs, activeTabId, operations: tabOps } = useTabContext();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const scenarioState = activeTab?.editorState?.scenarioState;
  const whatIfDSL = activeTab?.editorState?.whatIfDSL;

  return useMemo(() => {
    if (!graph || !scenariosCtx?.scenariosReady) return undefined;
    const visibleIds = scenarioState?.visibleScenarioIds?.length
      ? scenarioState.visibleScenarioIds
      : ['current'];
    if (visibleIds.length <= 1 && visibleIds[0] === 'current' && !whatIfDSL) return undefined;

    const result: LocalScenario[] = [];
    for (const scenarioId of visibleIds) {
      const visibilityMode = activeTabId
        ? tabOps.getScenarioVisibilityMode(activeTabId, scenarioId)
        : 'f+e';
      const scenarioGraph = buildGraphForAnalysisLayer(
        scenarioId,
        graph as Graph,
        scenariosCtx.baseParams || {},
        scenariosCtx.currentParams || {},
        scenariosCtx.scenarios || [],
        scenarioId === 'current' ? whatIfDSL : undefined,
        visibilityMode as any,
      );
      const scenario = scenariosCtx.scenarios.find(s => s.id === scenarioId);
      result.push({
        scenario_id: scenarioId,
        name: scenario?.name || (scenarioId === 'current' ? 'Current' : scenarioId),
        colour: scenario?.colour || scenariosCtx.currentColour || '#808080',
        graph: scenarioGraph as ConversionGraph,
      });
    }
    return result.length > 0 ? result : undefined;
  }, [graph, scenariosCtx, scenarioState?.visibleScenarioIds, whatIfDSL, activeTabId, tabOps]);
}
