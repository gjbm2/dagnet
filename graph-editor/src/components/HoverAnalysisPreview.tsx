/**
 * HoverAnalysisPreview
 *
 * Portal-rendered analysis preview card that appears on node/edge hover.
 * Uses the same compute pipeline as canvas analyses (runPreparedAnalysis):
 *   - FE-computable types (node_info, edge_info): instant result
 *   - Other types: backend call, with FE-first progressive augmentation
 *
 * Renders via AnalysisChartContainer — the same component canvas analyses use.
 * Draggable to canvas to persist as a standard analysis object.
 *
 * Satellite row: when the user hovers over the preview card, a row of
 * additional cards spans the full viewport width above it, each with a
 * random analysis type + chart kind. All cards use the same compute and
 * rendering pipeline.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { GripVertical } from 'lucide-react';
import { AnalysisChartContainer } from './charts/AnalysisChartContainer';
import { AnalysisInfoCard } from './analytics/AnalysisInfoCard';
import { ANALYSIS_TYPES, getAnalysisTypeMeta } from './panels/analysisTypes';
import { useCanvasAnalysisCompute } from '../hooks/useCanvasAnalysisCompute';
import { buildGraphForAnalysisLayer } from '../services/CompositionService';
import { resolveAnalysisType } from '../services/analysisTypeResolutionService';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { useViewOverlayMode } from '../hooks/useViewOverlayMode';
import type { ConversionGraph, Graph, CanvasAnalysis, ContentItem } from '../types';
import { CanvasAnalysisCard } from './CanvasAnalysisCard';
import type { TabDragOutcome } from './CanvasAnalysisCard';
import type { LocalScenario } from '../services/localAnalysisComputeService';
import type { EdgeSnapshotRetrievalsData } from '../hooks/useEdgeSnapshotRetrievals';
import { CalendarGrid } from './CalendarGrid';
import { TAB_LABELS, extractTabIds, buildPinDragData } from '../utils/canvasAnalysisAccessors';

// -------------------------------------------------------------------
// Satellite helpers
// -------------------------------------------------------------------

/** Fixed UI scale for satellite cards. Charts are always rendered at this
 *  fraction of their natural size, regardless of canvas zoom, so they stay
 *  legible at any zoom level. chartHeight is inflated by 1/this value to
 *  compensate for the CSS zoom shrink. */
const SATELLITE_CONTENT_SCALE = 0.5;

interface SatelliteRecipe {
  analysisType: string;
  chartKind?: string;
}

/** Fisher-Yates shuffle (in-place). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Generate center-out reveal order: start at the middle index, then
 *  alternate left/right. Returns an array of position indices. */
export function centerOutOrder(count: number): number[] {
  if (count <= 0) return [];
  const center = Math.floor(count / 2);
  const order: number[] = [center];
  for (let d = 1; order.length < count; d++) {
    if (center - d >= 0) order.push(center - d);
    if (center + d < count) order.push(center + d);
  }
  return order;
}

// -------------------------------------------------------------------
// Drag data builder — extracted for testability
// -------------------------------------------------------------------


// -------------------------------------------------------------------
// DraggableAnalysisCard — self-contained: compute + render + drag
// -------------------------------------------------------------------

/**
 * A single analysis card that:
 *   1. Computes via useCanvasAnalysisCompute (same hook as CanvasAnalysisNode)
 *   2. Renders via AnalysisChartContainer (same component as canvas analyses)
 *   3. Can be dragged to pin on canvas (same event as canvas analysis creation)
 *
 * Zero bespoke compute logic — the standard hook handles workspace, snapshots,
 * scenarios, graph-from-store, and progressive augmentation.
 */
function DraggableAnalysisCard({
  analysisType,
  dsl,
  chartKind,
  tabId,
  canvasZoom,
  onDismiss,
  onCardEnter,
  onCardLeave,
  style,
  className,
  scaleContent,
  hideHeader,
  chartHeight,
  onSettled,
  deferred,
  infoDefaultTab,
  snapshotRetrievals,
  onFileLink,
  onClickPin,
}: {
  analysisType: string;
  dsl: string;
  /** When omitted, uses the result's recommended chart kind */
  chartKind?: string;
  /** Tab ID for scenario/workspace context — from activeTabId */
  tabId?: string;
  canvasZoom?: number;
  onDismiss: () => void;
  onCardEnter: () => void;
  onCardLeave: () => void;
  style?: React.CSSProperties;
  className?: string;
  /** When true, apply SATELLITE_CONTENT_SCALE zoom to chart body (satellites only) */
  scaleContent?: boolean;
  /** Hide the header title bar (satellites show tooltip instead) */
  hideHeader?: boolean;
  /** Explicit chart height in px — avoids fillHeight flex-chain race conditions */
  chartHeight?: number;
  /** Called when this card reaches a terminal state. 'rendered' = chart painted with data; 'failed' = error/blocked/empty. */
  onSettled?: (outcome: 'rendered' | 'failed') => void;
  /** When true, render placeholder shell without starting compute (progressive reveal) */
  deferred?: boolean;
  /** Default tab for info cards (driven by view overlay mode) */
  infoDefaultTab?: string;
  /** Snapshot retrieval data for edge_info Evidence tab (async — arrives when ready) */
  snapshotRetrievals?: EdgeSnapshotRetrievalsData;
  /** Callback when a file link is clicked */
  onFileLink?: (fileId: string, type: string) => void;
  /** Called on click (no drag) — satellites use this to pin at main card position */
  onClickPin?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { operations } = useTabContext();
  const scenariosCtx = useScenariosContextOptional();

  // Stable unique ID per component instance (for compute caching)
  const stableId = useRef(`hover-${Math.random().toString(36).slice(2, 8)}`).current;

  // Synthetic CanvasAnalysis — drives the standard useCanvasAnalysisCompute hook.
  // When deferred, analysis_type is empty → hook returns blocked (no compute fires).
  // When commissioned, analysis_type populates → hook triggers compute automatically.
  const syntheticAnalysis = useMemo((): CanvasAnalysis => ({
    id: stableId,
    recipe: {
      analysis: {
        analysis_type: deferred ? '' : analysisType,
        analytics_dsl: dsl,
      },
    },
    view_mode: 'chart',
    chart_kind: chartKind,
    mode: 'live' as const,
    x: 0, y: 0, width: 300, height: 200,
    content_items: [{
      id: `${stableId}-content-0`,
      analysis_type: deferred ? '' : analysisType,
      view_type: 'chart' as const,
      kind: chartKind,
      analytics_dsl: dsl,
    }],
  }), [stableId, analysisType, dsl, chartKind, deferred]);

  // Standard compute — same hook as CanvasAnalysisNode. Handles workspace,
  // snapshot subjects, scenarios, graph-from-store, progressive augmentation.
  const { result, loading, waitingForDeps, error, backendUnavailable } = useCanvasAnalysisCompute({
    analysis: syntheticAnalysis,
    tabId,
  });

  // --- Satellite diagnostic logging ---
  const isSatellite = !!scaleContent;
  const prevStateRef = useRef<string>('');
  const computeState = error ? 'error' : backendUnavailable ? 'backend-unavailable'
    : loading ? (result ? 'loading-with-result' : 'loading')
    : result ? 'result' : waitingForDeps ? 'waiting-for-deps' : 'idle';
  useEffect(() => {
    if (!isSatellite) return;
    const isEmpty = result && (result.metadata as any)?.empty === true;
    const stateKey = `${computeState}|empty=${isEmpty}|type=${analysisType}|chart=${chartKind}`;
    if (stateKey === prevStateRef.current) return;
    prevStateRef.current = stateKey;
    console.log(`[Satellite:${stableId}] ${analysisType}×${chartKind} → ${computeState}`, {
      deferred,
      isEmpty,
      error: error || undefined,
      resultType: result?.analysis_type,
      resultSource: (result?.metadata as any)?.source,
      resultDescription: result?.analysis_description?.substring(0, 80),
      dataLength: Array.isArray(result?.data) ? result.data.length : undefined,
    });
  });
  // Log final state at unmount so we can see why satellites didn't render
  useEffect(() => {
    if (!isSatellite) return;
    return () => {
      console.log(`[Satellite:${stableId}] UNMOUNT ${analysisType}×${chartKind} (was: ${prevStateRef.current.split('|')[0]})`);
    };
  }, [isSatellite, stableId, analysisType, chartKind]);

  // Signal settlement to parent — 'rendered' when ECharts finishes painting
  // real data; 'failed' for error/blocked/empty chart.
  const settledRef = useRef(false);
  const fireSettled = useCallback((outcome: 'rendered' | 'failed') => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettled?.(outcome);
  }, [onSettled]);

  // Terminal non-render states: settle as failed.
  // error/backendUnavailable are immediate failures.
  // waitingForDeps may resolve, but give up after 5s to avoid blocking the queue.
  useEffect(() => {
    if (settledRef.current || deferred) return;
    if (error || backendUnavailable) fireSettled('failed');
  }, [deferred, error, backendUnavailable, fireSettled]);

  useEffect(() => {
    if (settledRef.current || deferred || !waitingForDeps) return;
    const timer = setTimeout(() => fireSettled('failed'), 5000);
    return () => clearTimeout(timer);
  }, [deferred, waitingForDeps, fireSettled]);

  // Overall trial timeout: if the card hasn't settled within 10s of mount,
  // fail it so the queue isn't blocked by slow backend responses.
  useEffect(() => {
    if (settledRef.current || deferred) return;
    const timer = setTimeout(() => {
      if (import.meta.env.DEV && !settledRef.current) {
        console.log(`[Satellite:${stableId}] TIMEOUT 10s — failing ${analysisType}×${chartKind}`);
      }
      fireSettled('failed');
    }, 10000);
    return () => clearTimeout(timer);
  }, [deferred, fireSettled, stableId, analysisType, chartKind]);

  // Effective chart kind: explicit prop → result's recommended → undefined (let chart decide)
  const effectiveChartKind = chartKind || (result as any)?.semantics?.chart?.recommended;

  // --- Drag-to-pin (same event as canvas analysis creation) ---
  // Uses transform: translate(dx, dy) for drag movement — immune to containing
  // block issues (parent transforms, fixed positioning inside transforms).
  //
  // Drag sources: header (main card) or whole card (satellites with hideHeader).
  // During drag, hit-tests for existing containers — shows snap-in preview tab,
  // and drops into the container on release (instead of pinning to canvas).
  const dragState = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  // Tab drag active — suppresses hover dismissal while a tab is being dragged
  const [tabDragging, setTabDragging] = useState(false);
  const anyDragging = dragging || tabDragging;
  // Drop-target tracking during card drag (snap-in preview on containers)
  const dragDropTargetRef = useRef<string | null>(null);

  const handleCardPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const handleCardPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    setDragDelta({
      dx: e.clientX - dragState.current.startX,
      dy: e.clientY - dragState.current.startY,
    });

    // Hit-test for container drop targets (title bar / tab bar only)
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    let targetId: string | null = null;
    for (const el of elements) {
      const dz = (el as HTMLElement).closest?.('[data-dropzone^="analysis-"]');
      if (dz) {
        targetId = (dz.getAttribute('data-dropzone') || '').replace('analysis-', '') || null;
        break;
      }
    }
    if (targetId !== dragDropTargetRef.current) {
      if (dragDropTargetRef.current) {
        window.dispatchEvent(new CustomEvent('dagnet:clearContentItemPreview', {
          detail: { targetAnalysisId: dragDropTargetRef.current },
        }));
      }
      dragDropTargetRef.current = targetId;
      if (targetId) {
        const meta = ANALYSIS_TYPES.find((t) => t.id === analysisType);
        window.dispatchEvent(new CustomEvent('dagnet:previewContentItem', {
          detail: {
            targetAnalysisId: targetId,
            contentItem: {
              analysis_type: analysisType,
              view_type: 'chart',
              kind: effectiveChartKind,
              title: meta?.name || analysisType,
              analytics_dsl: dsl,
            },
            analysisResult: result,
          },
        }));
      }
    }
  }, [analysisType, dsl, effectiveChartKind, result]);

  const handleCardPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const ds = dragState.current;
    dragState.current = null;
    setDragging(false);
    setDragDelta(null);

    const dropTarget = dragDropTargetRef.current;
    // Clear any snap-in preview
    if (dropTarget) {
      window.dispatchEvent(new CustomEvent('dagnet:clearContentItemPreview', {
        detail: { targetAnalysisId: dropTarget },
      }));
    }
    dragDropTargetRef.current = null;

    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (dx * dx + dy * dy <= 9) {
      // Click (no drag) — satellites use onClickPin to pin at main card position
      if (onClickPin) onClickPin();
      return;
    }

    // Drop into existing container — snap content item
    if (dropTarget) {
      const meta = ANALYSIS_TYPES.find((t) => t.id === analysisType);
      console.log('[HoverPreview] SNAP dispatch', {
        dropTarget: dropTarget?.slice(0, 12),
        analysisType,
        effectiveChartKind,
        title: meta?.name || analysisType,
        dsl: dsl?.slice(0, 40),
        hasResult: !!result,
      });
      window.dispatchEvent(new CustomEvent('dagnet:snapContentItemToContainer', {
        detail: {
          targetAnalysisId: dropTarget,
          contentItem: {
            analysis_type: analysisType,
            view_type: 'chart',
            kind: effectiveChartKind,
            title: meta?.name || analysisType,
            analytics_dsl: dsl,
          },
          analysisResult: result,
          sourceTabId: tabId,
        },
      }));
      onDismiss();
      return;
    }

    // Drop onto empty canvas — pin as new analysis
    const el = cardRef.current;
    const cardLeft = e.clientX - ds.ox;
    const cardTop = e.clientY - ds.oy;
    const pinMeta = ANALYSIS_TYPES.find((t) => t.id === analysisType);
    // Satellites are thumbnails — use a standard size for the pinned analysis, not the tile size.
    const pinWidth = scaleContent ? 400 : (el ? el.offsetWidth : 400);
    const pinHeight = scaleContent ? 300 : (el ? el.offsetHeight : 300);
    const dragData = buildPinDragData({
      analysisType,
      dsl,
      chartKind: effectiveChartKind,
      result,
      screenWidth: pinWidth,
      screenHeight: pinHeight,
      canvasZoom: canvasZoom || 1,
      baseFontSize: el ? parseFloat(getComputedStyle(el).fontSize) || 10 : 10,
      scaleContent: false, // Pinned analyses don't scale content — they're standard-sized
      title: pinMeta?.name || analysisType,
    });
    window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisAtScreenPosition', {
      detail: { screenX: cardLeft, screenY: cardTop, dragData, sourceTabId: tabId },
    }));
    onDismiss();
  }, [analysisType, dsl, effectiveChartKind, result, canvasZoom, scaleContent, onDismiss, onClickPin, tabId]);

  // --- Render ---
  const meta = ANALYSIS_TYPES.find((t) => t.id === analysisType);
  const label = meta?.name || analysisType;
  // Visible scenario IDs — same source as CanvasAnalysisNode (live mode).
  // Uses the tab's scenario state, not bespoke extraction from result data.
  const visibleScenarioIds = useMemo(() => {
    if (tabId) {
      const state = operations.getScenarioState(tabId);
      return state?.visibleScenarioIds || ['current'];
    }
    return ['current'];
  }, [tabId, operations]);

  // Scenario visibility modes — same as CanvasAnalysisNode (live mode)
  const scenarioVisibilityModes = useMemo(() => {
    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
    for (const id of visibleScenarioIds) {
      m[id] = tabId ? operations.getScenarioVisibilityMode(tabId, id) : 'f+e';
    }
    return m;
  }, [visibleScenarioIds, tabId, operations]);

  // Scenario meta — same as CanvasAnalysisNode (live mode)
  const scenarioMetaById = useMemo(() => {
    const m: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }> = {};
    for (const id of visibleScenarioIds) {
      if (id === 'current') {
        m[id] = {
          name: 'Current',
          colour: (scenariosCtx as any)?.currentColour || '#3b82f6',
          visibility_mode: scenarioVisibilityModes[id] || 'f+e',
        };
      } else if (id === 'base') {
        m[id] = {
          name: 'Base',
          colour: (scenariosCtx as any)?.baseColour || '#6b7280',
          visibility_mode: scenarioVisibilityModes[id] || 'f+e',
        };
      } else {
        const s = (scenariosCtx as any)?.scenarios?.find((x: any) => x.id === id);
        m[id] = {
          name: s?.name || id,
          colour: s?.colour || '#808080',
          visibility_mode: scenarioVisibilityModes[id] || 'f+e',
        };
      }
    }
    return m;
  }, [visibleScenarioIds, scenariosCtx, scenarioVisibilityModes]);

  // --- Synthesise content items from result facets for CanvasAnalysisCard ---
  const tabIds = useMemo(() => extractTabIds(result), [result]);
  const hasMultipleTabs = tabIds.length > 1;
  const [activeTabIdx, setActiveTabIdx] = useState(0);

  // Honour infoDefaultTab (driven by view overlay mode) when tabs first appear
  useEffect(() => {
    if (!infoDefaultTab || tabIds.length === 0) return;
    const idx = tabIds.indexOf(infoDefaultTab);
    if (idx >= 0) setActiveTabIdx(idx);
  }, [infoDefaultTab, tabIds]);

  const hoverContentItems = useMemo((): ContentItem[] => {
    if (tabIds.length <= 1) {
      return [{
        id: `${stableId}-main`,
        analysis_type: analysisType,
        view_type: 'chart',
        kind: chartKind,
      }];
    }
    return tabIds.map(tid => ({
      id: `${stableId}-${tid}`,
      analysis_type: analysisType,
      view_type: 'cards' as const,
      kind: tid,
      title: TAB_LABELS[tid] || tid,
      analysis_type_overridden: true,
    }));
  }, [stableId, tabIds, analysisType, chartKind]);

  // Tab drag complete → pin as new analysis or snap into existing container
  const handleTabDragComplete = useCallback((outcome: TabDragOutcome) => {
    const itemKind = outcome.contentItem.kind;
    if (outcome.targetAnalysisId) {
      window.dispatchEvent(new CustomEvent('dagnet:snapContentItemToContainer', {
        detail: {
          targetAnalysisId: outcome.targetAnalysisId,
          contentItem: {
            analysis_type: analysisType,
            view_type: 'cards' as const,
            kind: itemKind,
            title: TAB_LABELS[itemKind || ''] || itemKind || outcome.label,
            analysis_type_overridden: true,
          },
          analysisResult: result,
          sourceTabId: tabId,
        },
      }));
      onDismiss();
    } else {
      const el = cardRef.current;
      const tabPinMeta = ANALYSIS_TYPES.find((t) => t.id === analysisType);
      const dragData = buildPinDragData({
        analysisType,
        dsl,
        chartKind: effectiveChartKind,
        result,
        screenWidth: el ? el.offsetWidth : 400,
        screenHeight: el ? el.offsetHeight : 300,
        canvasZoom: canvasZoom || 1,
        baseFontSize: el ? parseFloat(getComputedStyle(el).fontSize) || 10 : 10,
        scaleContent: !!scaleContent,
        singleFacet: itemKind,
        title: tabPinMeta?.name || analysisType,
      });
      window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisAtScreenPosition', {
        detail: { screenX: outcome.screenX, screenY: outcome.screenY, dragData, sourceTabId: tabId },
      }));
      onDismiss();
    }
  }, [analysisType, effectiveChartKind, result, dsl, canvasZoom, scaleContent, onDismiss]);

  return (
    <div
      ref={cardRef}
      className={
        'hover-analysis-preview' +
        (dragging ? ' hover-analysis-preview--dragging' : '') +
        (className ? ` ${className}` : '')
      }
      onMouseEnter={anyDragging ? undefined : onCardEnter}
      onMouseLeave={anyDragging ? undefined : onCardLeave}
      onPointerDown={hideHeader ? handleCardPointerDown : undefined}
      onPointerMove={handleCardPointerMove}
      onPointerUp={handleCardPointerUp}
      style={{
        position: 'relative' as const,
        cursor: anyDragging ? 'grabbing' : undefined,
        transition: anyDragging ? undefined : 'opacity 0.25s ease-in-out',
        display: 'flex',
        flexDirection: 'column',
        ...style,
        ...(hasMultipleTabs && !hideHeader ? { width: 420 } : {}),
        ...(loading && !result && !error && !backendUnavailable && !waitingForDeps ? { opacity: 0 } : {}),
        ...(dragDelta ? { transform: `translate(${dragDelta.dx}px, ${dragDelta.dy}px)`, zIndex: 10001 } : {}),
      }}
    >
      {!hideHeader && (
        <div className="hover-analysis-preview-header" onPointerDown={handleCardPointerDown}>
          <GripVertical size={9} className="hover-analysis-preview-grip" />
          <span className="hover-analysis-preview-title">
            {label}{effectiveChartKind && effectiveChartKind !== 'info' ? ` · ${effectiveChartKind.replace(/_/g, ' ')}` : ''}
          </span>
          <span className="hover-analysis-preview-hint">drag to pin</span>
        </div>
      )}
      <CanvasAnalysisCard
        analysisId={stableId}
        contentItems={hoverContentItems}
        activeContentIndex={activeTabIdx}
        onActiveContentIndexChange={setActiveTabIdx}
        result={result}
        loading={loading}
        error={error ?? undefined}
        backendUnavailable={backendUnavailable}
        waitingForDeps={waitingForDeps}
        hasAnalysisType={!deferred && !!analysisType}
        interactive
        onTabDragComplete={handleTabDragComplete}
        onTabDragActiveChange={setTabDragging}
        contentZoomStyle={scaleContent ? { zoom: SATELLITE_CONTENT_SCALE } as React.CSSProperties : undefined}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column' as const,
          overflow: 'hidden',
          minHeight: 0,
        }}
        renderContent={(ci, previewOverlay) => (
          <div
            className="hover-analysis-preview-body"
            style={{
              ...(hasMultipleTabs ? { height: 320, flex: 'none', overflow: 'auto' } : {}),
            }}
          >
            {result && ci.view_type === 'cards' ? (
              <AnalysisInfoCard
                result={result}
                kind={ci.kind}
                fontSize={ci.display?.font_size as number | undefined}
                onFileLink={onFileLink}
                tabExtra={snapshotRetrievals ? { evidence: <SnapshotCalendarSection data={snapshotRetrievals} /> } : undefined}
              />
            ) : result ? (
              <AnalysisChartContainer
                result={result}
                chartKindOverride={effectiveChartKind}
                visibleScenarioIds={visibleScenarioIds}
                scenarioVisibilityModes={scenarioVisibilityModes}
                scenarioMetaById={scenarioMetaById}
                height={chartHeight ?? (effectiveChartKind === 'info' ? undefined : 140)}
                hideChrome
                suppressAnimation={!!scaleContent}
                onRendered={fireSettled}
                onFileLink={onFileLink}
                source={{ query_dsl: dsl }}
                infoCardKind={ci.kind}
                infoDefaultTab={hasMultipleTabs ? undefined : infoDefaultTab}
                infoTabExtra={snapshotRetrievals ? {
                  evidence: <SnapshotCalendarSection data={snapshotRetrievals} />,
                } : undefined}
              />
            ) : null}
            {previewOverlay}
          </div>
        )}
      />
      {/* Tooltip — shows analysis type & chart kind on hover (satellites only) */}
      {hideHeader && (
        <div className="hover-analysis-preview-tooltip">
          {label}{effectiveChartKind && effectiveChartKind !== 'info' ? ` · ${effectiveChartKind.replace(/_/g, ' ')}` : ''}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// SnapshotCalendarSection — compact calendar for Evidence tab
// -------------------------------------------------------------------

function SnapshotCalendarSection({ data }: { data: EdgeSnapshotRetrievalsData }) {
  // Right month = the latest retrieval month (or current month)
  const [rightMonth, setRightMonth] = useState(() => {
    if (data.latestRetrievedAt) {
      const d = new Date(data.latestRetrievedAt);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    }
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  // Left month = one month before right
  const leftMonth = useMemo(() => {
    const d = new Date(rightMonth.getTime());
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d;
  }, [rightMonth]);

  const highlightedDates = useMemo(
    () => new Set(data.retrievedDays),
    [data.retrievedDays],
  );

  // Shared nav moves the pair
  const setLeftMonth = useCallback((d: Date) => {
    const next = new Date(d.getTime());
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(1);
    setRightMonth(next);
  }, []);

  const noop = useCallback(() => {}, []);

  return (
    <div className="info-card-snapshot-calendar info-card-snapshot-calendar--dual">
      <div className="info-card-section-title" style={{ padding: '3px 4px 1px' }}>
        Snapshots
      </div>
      <div className="info-card-snapshot-calendar-pair">
        <div className="info-card-snapshot-calendar-month">
          <CalendarGrid
            monthCursor={leftMonth}
            setMonthCursor={setLeftMonth}
            highlightedDates={highlightedDates}
            selectedDate={null}
            onDateClick={noop}
            getDayTitle={(iso, highlighted) =>
              highlighted ? 'Snapshot available' : ''
            }
          />
        </div>
        <div className="info-card-snapshot-calendar-month">
          <CalendarGrid
            monthCursor={rightMonth}
            setMonthCursor={setRightMonth}
            highlightedDates={highlightedDates}
            selectedDate={null}
            onDateClick={noop}
            getDayTitle={(iso, highlighted) =>
              highlighted ? 'Snapshot available' : ''
            }
          />
        </div>
      </div>
      <div className="calendar-grid-footer">
        {data.count} row{data.count !== 1 ? 's' : ''} across {data.retrievedDays.length} day{data.retrievedDays.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Main component
// -------------------------------------------------------------------

interface HoverAnalysisPreviewProps {
  graph: ConversionGraph;
  nodeId?: string;
  edgeSource?: string;
  edgeTarget?: string;
  position: { x: number; y: number };
  triggerBottom?: number;
  scenarios?: LocalScenario[];
  canvasZoom?: number;
  onCardEnter: () => void;
  onCardLeave: () => void;
  onDismiss: () => void;
  /** Snapshot retrieval data for edge_info Evidence tab (async — arrives when ready) */
  snapshotRetrievals?: EdgeSnapshotRetrievalsData;
  /** Callback when a file link is clicked in an info card */
  onFileLink?: (fileId: string, type: string) => void;
}

export function HoverAnalysisPreview({
  graph,
  nodeId,
  edgeSource,
  edgeTarget,
  position,
  triggerBottom,
  scenarios: _scenarios,
  canvasZoom,
  onCardEnter,
  onCardLeave,
  onDismiss,
  snapshotRetrievals,
  onFileLink,
}: HoverAnalysisPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeTabId } = useTabContext();
  const { viewOverlayMode } = useViewOverlayMode();

  // Derive default info tab from view overlay mode
  const infoDefaultTab = viewOverlayMode === 'forecast-quality'
    ? 'forecast'
    : viewOverlayMode === 'data-depth'
      ? 'depth'
      : undefined;


  // --- Satellite row ---
  // Satellites are commissioned progressively (center-out) to avoid hammering
  // the server. Each card starts deferred (no compute), then gets commissioned
  // by a timer that reveals from the center outward.
  //
  // Available analysis types are resolved dynamically via resolveAnalysisType —
  // the same codepath used by the analytics panel palette. This ensures
  // satellites show exactly the types valid for the current hover context.
  const [satelliteRecipes, setSatelliteRecipes] = useState<SatelliteRecipe[]>([]);
  const [hoveringPreview, setHoveringPreview] = useState(false);

  // Commission model: trial cards are rendered in the DOM (hidden) so hooks fire
  // and compute runs. Once ECharts paints real data ('rendered'), the card becomes
  // visible in the row at its centre-out position. Failed trials are silently
  // removed and the next recipe is tried. NO empty boxes — a satellite only
  // appears once it has actual chart content.
  interface CardEntry {
    id: string;
    recipe: SatelliteRecipe;
    status: 'trial' | 'rendered';
    slotPosition?: number; // visual position in the row (0..maxSlots-1), assigned on success
  }
  const [cards, setCards] = useState<CardEntry[]>([]);
  const renderedCountRef = useRef(0);
  const recipeQueueRef = useRef<SatelliteRecipe[]>([]);
  const activeTrialCountRef = useRef(0);

  // Delay satellite rendering by 500ms to avoid positional flicker —
  // satellites need a frame to measure the main card's bounding rect.
  const [satelliteDelayElapsed, setSatelliteDelayElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSatelliteDelayElapsed(true), 200);
    return () => clearTimeout(timer);
  }, []);

  const handleCardEnterWithSatellites = useCallback(() => {
    onCardEnter();
    setHoveringPreview(true);
  }, [onCardEnter]);

  const handleCardLeaveWithSatellites = useCallback(() => {
    onCardLeave();
    setHoveringPreview(false);
  }, [onCardLeave]);

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

  // Resolve available analysis types for this DSL (same as analytics palette)
  // Build cartesian product of analysis type × chart kinds for satellites.
  useEffect(() => {
    if (!graph || !dsl || !analysisType) return;
    let cancelled = false;
    resolveAnalysisType(graph, dsl).then(({ availableAnalyses }) => {
      if (cancelled) return;
      // Build cartesian product, excluding non-chart kinds (table, info)
      // — satellites are visual chart previews only.
      const NON_CHART_KINDS = new Set(['table', 'info']);
      const hasToPart = dsl.includes('.to(');
      const recipes: SatelliteRecipe[] = [];
      const skippedTypes: string[] = [];
      for (const a of availableAnalyses) {
        // Snapshot types with funnel_path scope need from(a).to(b) in the DSL.
        // When hovering a node (DSL = from(nodeId)), these types cannot resolve
        // snapshot subjects and would always fail — skip them.
        if (!hasToPart) {
          const meta = getAnalysisTypeMeta(a.id);
          if (meta?.snapshotContract?.scopeRule === 'funnel_path') {
            skippedTypes.push(a.id);
            continue;
          }
        }
        const kinds = (a.chart_kinds || []).filter(k => !NON_CHART_KINDS.has(k));
        for (const kind of kinds) {
          recipes.push({ analysisType: a.id, chartKind: kind });
        }
      }
      // Exclude the main card's exact combo
      const filtered = recipes.filter(
        (r) => !(r.analysisType === analysisType && !r.chartKind),
      );
      console.log('[SatelliteRecipes] Built', filtered.length, 'recipes from', availableAnalyses.length, 'available types.', {
        dsl,
        hasToPart,
        skippedFunnelPath: skippedTypes,
        recipes: filtered.map(r => `${r.analysisType}×${r.chartKind}`),
      });
      setSatelliteRecipes(shuffle(filtered));
    });
    return () => { cancelled = true; };
  }, [graph, dsl, analysisType]);

  // --- CSS-anchored positioning (no DOM measurement needed for initial frame) ---
  // position.y = top of the trigger element.
  // Anchor the container's BOTTOM edge 8px above trigger top via CSS `bottom`.
  // Horizontal centering via transform: translateX(-50%) — no width measurement.
  // This eliminates the visible "render then jump" bug entirely: the card is
  // placed correctly from the very first paint frame.
  const bottomAnchor = window.innerHeight - position.y + 8;

  // Viewport edge clamping — runs ONCE after mount to adjust for edges.
  // No ResizeObserver: satellite appearance must NOT trigger re-clamping.
  const [clampedLeft, setClampedLeft] = useState<number | null>(null);
  const [flippedBelow, setFlippedBelow] = useState(false);
  const clampedRef = useRef(false);

  useEffect(() => {
    if (clampedRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    clampedRef.current = true;
    if (rect.left < 20) {
      setClampedLeft(20);
    } else if (rect.right > vw - 20) {
      setClampedLeft(vw - rect.width - 20);
    }
    if (rect.top < 8) {
      setFlippedBelow(true);
    }
  });

  if (!analysisType || !dsl) return null;

  // Main card: bottom-anchored (normal) or top-anchored (flipped below trigger)
  const mainLeft = clampedLeft ?? position.x;
  const mainTransform = clampedLeft != null ? undefined : 'translateX(-50%)';
  const containerStyle: React.CSSProperties = flippedBelow
    ? {
        position: 'fixed',
        left: mainLeft,
        top: (triggerBottom ?? position.y) + 8,
        transform: mainTransform,
        zIndex: 9999,
        pointerEvents: 'auto' as const,
      }
    : {
        position: 'fixed',
        left: mainLeft,
        bottom: bottomAnchor,
        transform: mainTransform,
        zIndex: 9999,
        pointerEvents: 'auto' as const,
      };

  // Satellite positioning — measured from the main card's bounding rect.
  // ResizeObserver fires when the main card changes size (e.g. "Computing..."
  // → full chart result), so satellites get correct position and tile size
  // even though the size change is a child state update invisible to us.
  //
  // The satellite row is capped to MAX_SATELLITE_ROW_TILES tiles, centred on
  // the main card. This prevents the row from spanning the entire viewport
  // (which looked visually disconnected from the hover card).
  const GAP = 6;
  const MAX_SATELLITE_ROW_TILES = 8;
  const [satelliteLayout, setSatelliteLayout] = useState<{
    tileSize: number;
    bottom: number;
    count: number;
    rowLeft: number;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const tileSize = Math.floor((rect.width - 12) / 3);
      const bottom = window.innerHeight - rect.top + 6;
      // Fit tiles within viewport, capped at MAX_SATELLITE_ROW_TILES
      const availableWidth = window.innerWidth - 24; // 12px margin each side
      const fitCount = Math.max(1, Math.floor((availableWidth + GAP) / (tileSize + GAP)));
      const count = Math.min(fitCount, MAX_SATELLITE_ROW_TILES);
      const totalRowWidth = count * tileSize + (count - 1) * GAP;
      // Centre the satellite row on the main card, clamped to viewport edges.
      // This keeps satellites visually aligned with the hover card instead of
      // always viewport-centred (which looks misaligned for nodes near edges).
      const cardCenterX = rect.left + rect.width / 2;
      const idealLeft = Math.round(cardCenterX - totalRowWidth / 2);
      const rowLeft = Math.max(12, Math.min(idealLeft, window.innerWidth - totalRowWidth - 12));
      const next = { tileSize, bottom, count, rowLeft };
      setSatelliteLayout((prev) => {
        if (prev && prev.tileSize === tileSize && prev.bottom === bottom && prev.count === count && prev.rowLeft === rowLeft) return prev;
        console.log('[SatelliteLayout] measure', {
          mainCard: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
          cardCenterX: Math.round(cardCenterX),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          tileSize, count, totalRowWidth, idealLeft, rowLeft, bottom,
        });
        return next;
      });
    };
    measure(); // initial measurement
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Centre-out reveal positions — cards fill from the middle outward.
  const maxSlots = satelliteLayout?.count ?? 0;
  const revealOrder = useMemo(() => centerOutOrder(maxSlots), [maxSlots]);

  // Start a new trial from the recipe queue (renders hidden, hooks fire compute)
  const startNextTrial = useCallback(() => {
    if (recipeQueueRef.current.length === 0 || renderedCountRef.current >= maxSlots) return;
    const recipe = recipeQueueRef.current.shift()!;
    const id = `sat-${Math.random().toString(36).slice(2, 8)}`;
    activeTrialCountRef.current++;
    setCards(prev => [...prev, { id, recipe, status: 'trial' }]);
  }, [maxSlots]);

  // Settlement: rendered → make visible at next centre-out slot; failed → discard.
  // After settlement, commission the next trial if none are active.
  const handleTrialSettled = useCallback((cardId: string, recipe: SatelliteRecipe, outcome: 'rendered' | 'failed') => {
    activeTrialCountRef.current--;
    if (outcome === 'rendered') {
      const pos = renderedCountRef.current;
      if (pos < revealOrder.length) {
        const slotIdx = revealOrder[pos];
        renderedCountRef.current = pos + 1;
        setCards(prev => prev.map(c =>
          c.id === cardId ? { ...c, status: 'rendered' as const, slotPosition: slotIdx } : c
        ));
        if (import.meta.env.DEV) {
          console.log(`[Satellite] RENDERED ${recipe.analysisType}×${recipe.chartKind} → slot ${slotIdx} (${pos + 1}/${maxSlots})`);
        }
      }
    } else {
      setCards(prev => prev.filter(c => c.id !== cardId));
      if (import.meta.env.DEV) {
        console.log(`[Satellite] FAILED ${recipe.analysisType}×${recipe.chartKind} — discarded`);
      }
    }
    // Commission next trial if none active
    if (activeTrialCountRef.current <= 0) {
      setTimeout(() => startNextTrial(), 0);
    }
  }, [revealOrder, maxSlots, startNextTrial]);

  // Initialise: fill queue and start first 2 trials
  const initialisedRef = useRef(false);
  useEffect(() => {
    if (!satelliteLayout || satelliteRecipes.length === 0 || initialisedRef.current) return;
    initialisedRef.current = true;
    recipeQueueRef.current = [...satelliteRecipes];
    renderedCountRef.current = 0;
    activeTrialCountRef.current = 0;
    const initial: CardEntry[] = [];
    const startCount = Math.min(2, satelliteRecipes.length);
    for (let i = 0; i < startCount; i++) {
      const recipe = recipeQueueRef.current.shift()!;
      initial.push({ id: `sat-${Math.random().toString(36).slice(2, 8)}`, recipe, status: 'trial' });
      activeTrialCountRef.current++;
    }
    setCards(initial);
  }, [satelliteLayout, satelliteRecipes]);

  // Satellite click-to-pin: clicking (not dragging) a satellite pins that
  // chart type at the main hover preview card's screen position.
  const makeSatelliteClickPin = useCallback((recipe: SatelliteRecipe) => {
    return () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const satMeta = ANALYSIS_TYPES.find((t) => t.id === recipe.analysisType);
      const dragData = buildPinDragData({
        analysisType: recipe.analysisType,
        dsl,
        chartKind: recipe.chartKind,
        result: null, // no cached result for the satellite's type at main card position
        screenWidth: rect.width,
        screenHeight: rect.height,
        canvasZoom: canvasZoom || 1,
        baseFontSize: 10,
        scaleContent: false,
        title: satMeta?.name || recipe.analysisType,
      });
      window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisAtScreenPosition', {
        detail: { screenX: rect.left, screenY: rect.top, dragData },
      }));
      onDismiss();
    };
  }, [dsl, canvasZoom, onDismiss]);

  return ReactDOM.createPortal(
    <>
      {/* Main preview card — rendered first so containerRef is populated
          for the layout effect that measures satellite positioning. */}
      <div ref={containerRef} style={containerStyle}>
        <DraggableAnalysisCard
          analysisType={analysisType}
          dsl={dsl}
          chartKind="info"
          tabId={activeTabId ?? undefined}
          canvasZoom={canvasZoom}
          onDismiss={onDismiss}
          onCardEnter={handleCardEnterWithSatellites}
          onCardLeave={handleCardLeaveWithSatellites}
          infoDefaultTab={infoDefaultTab}
          snapshotRetrievals={snapshotRetrievals}
          onFileLink={onFileLink}
        />
      </div>

      {/* Satellite row — delayed 500ms after mount to avoid positional flicker,
          then gated on satelliteLayout measurement.
          Spans the full viewport width, centered. */}
      {satelliteDelayElapsed && satelliteLayout && cards.length > 0 && (
        <div
          className="satellite-row"
          style={{
            position: 'fixed',
            left: satelliteLayout.rowLeft,
            bottom: satelliteLayout.bottom,
            width: maxSlots * satelliteLayout.tileSize + Math.max(0, maxSlots - 1) * GAP,
            height: satelliteLayout.tileSize,
            zIndex: 10000,
            pointerEvents: 'auto',
          }}
          onMouseEnter={handleCardEnterWithSatellites}
          onMouseLeave={handleCardLeaveWithSatellites}
        >
          {cards.map((card) => {
            const isTrial = card.status === 'trial';
            return (
              <DraggableAnalysisCard
                key={card.id}
                analysisType={card.recipe.analysisType}
                chartKind={card.recipe.chartKind}
                dsl={dsl}
                tabId={activeTabId ?? undefined}
                canvasZoom={canvasZoom}
                onDismiss={onDismiss}
                onCardEnter={handleCardEnterWithSatellites}
                onCardLeave={handleCardLeaveWithSatellites}
                className="satellite-card"
                scaleContent
                hideHeader
                onClickPin={makeSatelliteClickPin(card.recipe)}
                onSettled={(outcome) => handleTrialSettled(card.id, card.recipe, outcome)}
                chartHeight={Math.round((satelliteLayout.tileSize - 4) / SATELLITE_CONTENT_SCALE)}
                style={{
                  position: 'absolute' as const,
                  left: isTrial ? 0 : (card.slotPosition! * (satelliteLayout.tileSize + GAP)),
                  top: 0,
                  width: satelliteLayout.tileSize,
                  height: satelliteLayout.tileSize,
                  visibility: isTrial ? 'hidden' as const : 'visible' as const,
                  opacity: isTrial ? 0 : (hoveringPreview ? 0.45 : 0.08),
                  transition: isTrial ? undefined : 'opacity 0.4s ease-in-out',
                  pointerEvents: isTrial ? 'none' as const : 'auto' as const,
                }}
              />
            );
          })}
        </div>
      )}
    </>,
    document.body,
  );
}

/**
 * Hook that manages the hover lifecycle for showing HoverAnalysisPreview.
 */
export function useHoverPreview(delay = 500, gracePeriod = 300) {
  const [previewState, setPreviewState] = useState<{
    position: { x: number; y: number };
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
      if (!isHoveringTriggerRef.current && !isHoveringCardRef.current) {
        setPreviewState(null);
      }
    }, gracePeriod);
  }, [gracePeriod]);

  const handleTriggerEnter = useCallback((e: { currentTarget?: Element | null; clientX: number; clientY: number; buttons?: number }) => {
    // Suppress hover preview during drag (any mouse button held)
    if ((e as any).buttons > 0) return;
    isHoveringTriggerRef.current = true;
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    if (previewState) return;
    if (showTimerRef.current) clearTimeout(showTimerRef.current);

    const el = e.currentTarget;
    const rect = el?.getBoundingClientRect?.();
    const pos = rect
      ? { x: rect.left + rect.width / 2, y: rect.top }
      : { x: e.clientX, y: e.clientY - 40 };
    const triggerBottom = rect ? rect.bottom : (e.clientY + 40);

    showTimerRef.current = setTimeout(() => {
      if (isHoveringTriggerRef.current) {
        setPreviewState({ position: pos, triggerBottom });
      }
    }, delay);
  }, [delay, previewState]);

  const handleTriggerLeave = useCallback(() => {
    isHoveringTriggerRef.current = false;
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    startGraceTimer();
  }, [startGraceTimer]);

  const handleCardEnter = useCallback(() => {
    isHoveringCardRef.current = true;
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
  }, []);

  const handleCardLeave = useCallback(() => {
    isHoveringCardRef.current = false;
    startGraceTimer();
  }, [startGraceTimer]);

  const handleDismiss = useCallback(() => {
    clearAllTimers();
    isHoveringTriggerRef.current = false;
    isHoveringCardRef.current = false;
    setPreviewState(null);
  }, [clearAllTimers]);

  const cardActiveRef = useRef(false);
  useEffect(() => {
    cardActiveRef.current = !!previewState;
  }, [previewState]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      // Always cancel pending timers on mousedown (prevents hover preview
      // from appearing during drag — the show timer may have been set just
      // before the user clicked to start dragging)
      clearAllTimers();
      isHoveringTriggerRef.current = false;

      // If the click target is inside the hover preview card or satellite row,
      // treat it as an in-card interaction (tab clicks, scroll, etc.) and do
      // NOT dismiss.  mouseenter may not have fired if the card appeared under
      // the cursor, so isHoveringCardRef can be stale — the DOM check is
      // authoritative.
      const target = e.target as HTMLElement | null;
      if (target?.closest('.hover-analysis-preview, .satellite-row')) {
        isHoveringCardRef.current = true;
        return;
      }

      if (cardActiveRef.current && !isHoveringCardRef.current) {
        isHoveringCardRef.current = false;
        setPreviewState(null);
      }
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [clearAllTimers]);

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
