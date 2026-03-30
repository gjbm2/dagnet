/**
 * CanvasAnalysisCard — the ONE shared renderer for canvas analysis objects.
 *
 * Used by both CanvasAnalysisNode (pinned mode) and HoverAnalysisPreview
 * (hover mode). Owns:
 *   - Tab bar (when multiple content items)
 *   - Tab switching (hover-to-switch)
 *   - Tab drag-out gesture (mousedown/mousemove/mouseup)
 *   - Tab drag ghost (portalled to document.body)
 *   - Snap-in preview (event listener + preview overlay)
 *   - Tab context menu
 *   - Content area shell (loading/error states)
 *
 * See: docs/current/project-canvas/7-container-content-split.md
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContentItem } from '../types';
import type { AnalysisResult } from '../lib/graphComputeClient';
import { AnalysisChartContainer } from './charts/AnalysisChartContainer';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';
import { TAB_LABELS } from '../utils/canvasAnalysisAccessors';
import { Loader2, AlertCircle, ServerOff } from 'lucide-react';

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface TabDragOutcome {
  /** The content item (or synthetic item) being dragged. */
  contentItem: ContentItem;
  /** Label shown in the ghost. */
  label: string;
  /** Screen position where the drop happened. */
  screenX: number;
  screenY: number;
  /** If dropped onto another container, its analysis ID. */
  targetAnalysisId: string | null;
  /** Whether ctrl/meta was held (= duplicate). */
  duplicate: boolean;
}

export interface CanvasAnalysisCardProps {
  /** The analysis ID — used for preview event filtering and drag identity. */
  analysisId: string;

  /** Content items to render in the tab bar. */
  contentItems: ContentItem[];

  /** Active content item index. */
  activeContentIndex: number;
  onActiveContentIndexChange: (idx: number) => void;

  /** The computed analysis result. */
  result: AnalysisResult | null;

  /** Loading / error states. */
  loading?: boolean;
  error?: string | null;
  backendUnavailable?: boolean;
  waitingForDeps?: boolean;
  hasAnalysisType?: boolean;

  /**
   * Render the main content for the active content item.
   * The card handles loading/error/empty states; this renders when
   * there IS a result (or no analysis type, for placeholder cards).
   */
  renderContent: (contentItem: ContentItem, previewOverlay: React.ReactNode | null) => React.ReactNode;

  /** Optional extra content after the main content (expression views in pinned mode). */
  renderExtra?: () => React.ReactNode;

  /** Header content — rendered above the tab bar. */
  renderHeader?: () => React.ReactNode;

  /** Called when a tab is dragged out of the tab bar and dropped. */
  onTabDragComplete?: (outcome: TabDragOutcome) => void;

  /** Called when a tab's close button is clicked. */
  onRemoveContentItem?: (contentItemId: string) => void;

  /** Called when the + button is clicked. */
  onAddContentItem?: () => void;

  /** Called when a tab is right-clicked → Open as Tab. */
  onOpenContentItemAsTab?: (ci: ContentItem) => void;

  /** Per-tab connector overlay toggle/colour. */
  onTabOverlayToggle?: (ci: ContentItem, active: boolean) => void;
  onTabOverlayColourChange?: (ci: ContentItem, colour: string | null) => void;

  /** Build full context menu items for a tab — delegates to parent for shared codepath with node context menu. */
  buildTabContextMenuItems?: (ci: ContentItem, closeMenu: () => void) => import('./ContextMenu').ContextMenuItem[];

  /** Content area zoom style (for inverse-zoom in pinned mode). */
  contentZoomStyle?: React.CSSProperties;
  /** Chrome (tab bar) zoom style — inverse zoom so always readable. */
  chromeZoomStyle?: React.CSSProperties;

  /** Connector overlay colour — used to tint tab accents when subject overlay is active. */
  connectorColour?: string;

  /** When false, an overlay blocks interaction (pinned mode: not selected). */
  interactive?: boolean;

  /** Whether scenarios are still hydrating (gates chart rendering). */
  awaitingScenariosHydration?: boolean;

  /** Called when tab drag starts/ends — consumers can suppress dismissal during drag. */
  onTabDragActiveChange?: (active: boolean) => void;

  /** CSS class for the outer container. */
  className?: string;

  /** Inline styles for the outer container. */
  style?: React.CSSProperties;
}

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

const EXTRACT_THRESHOLD = 20; // px distance to trigger tab extraction

// -------------------------------------------------------------------
// Component
// -------------------------------------------------------------------

export function CanvasAnalysisCard({
  analysisId,
  contentItems,
  activeContentIndex,
  onActiveContentIndexChange,
  result,
  loading,
  error,
  backendUnavailable,
  waitingForDeps,
  hasAnalysisType,
  renderContent,
  renderExtra,
  renderHeader,
  onTabDragComplete,
  onRemoveContentItem,
  onAddContentItem,
  onOpenContentItemAsTab,
  onTabOverlayToggle,
  onTabOverlayColourChange,
  buildTabContextMenuItems,
  contentZoomStyle,
  chromeZoomStyle,
  connectorColour,
  interactive = true,
  awaitingScenariosHydration,
  onTabDragActiveChange,
  className,
  style,
}: CanvasAnalysisCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const onTabDragActiveChangeRef = useRef(onTabDragActiveChange);
  onTabDragActiveChangeRef.current = onTabDragActiveChange;

  // Auto-select newly added tab when a SINGLE item is added (snap-in).
  // Don't auto-select when bulk-populating tabs (e.g. result arrives with 5 facets).
  const prevItemCountRef = useRef(contentItems.length);
  useEffect(() => {
    if (contentItems.length === prevItemCountRef.current + 1) {
      onActiveContentIndexChange(contentItems.length - 1);
    }
    prevItemCountRef.current = contentItems.length;
  }, [contentItems.length, onActiveContentIndexChange]);

  // --- Snap-in preview state (batched to avoid multi-render flicker) ---
  const [previewState, setPreviewState] = useState<{
    item: ContentItem | null;
    result: AnalysisResult | null;
    active: boolean;
  }>({ item: null, result: null, active: false });
  const previewItem = previewState.item;
  const previewResult = previewState.result;
  const previewActive = previewState.active;

  useEffect(() => {
    const handlePreview = (e: CustomEvent) => {
      if (e.detail?.targetAnalysisId !== analysisId) return;
      setPreviewState({
        item: e.detail.contentItem as ContentItem,
        result: e.detail.analysisResult ?? null,
        active: true,
      });
    };
    const handleClear = (e: CustomEvent) => {
      if (e.detail?.targetAnalysisId !== analysisId) return;
      setPreviewState({ item: null, result: null, active: false });
    };
    window.addEventListener('dagnet:previewContentItem', handlePreview as any);
    window.addEventListener('dagnet:clearContentItemPreview', handleClear as any);
    return () => {
      window.removeEventListener('dagnet:previewContentItem', handlePreview as any);
      window.removeEventListener('dagnet:clearContentItemPreview', handleClear as any);
    };
  }, [analysisId]);

  // --- Tab drag-out gesture ---
  const tabDragRef = useRef<{
    contentItem: ContentItem;
    label: string;
    startX: number;
    startY: number;
    extracted: boolean;
    width: number;
    height: number;
  } | null>(null);
  const [tabDragGhost, setTabDragGhost] = useState<{ x: number; y: number; label: string; contentItem: ContentItem; width: number; height: number } | null>(null);
  const [tabDragOverTarget, setTabDragOverTarget] = useState<string | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  // During tab drag, filter out the dragged tab so it visually disappears from the source
  const visibleItems = draggedTabId ? contentItems.filter(item => item.id !== draggedTabId) : contentItems;
  const clampedIndex = Math.min(activeContentIndex, visibleItems.length - 1);
  const contentItem = visibleItems[clampedIndex] || visibleItems[0];
  const showContentTabs = visibleItems.length > 1 || !!previewItem;

  // Auto-scroll tab bar to the end when preview appears or tabs grow
  useEffect(() => {
    if (showContentTabs && tabBarRef.current) {
      requestAnimationFrame(() => {
        if (tabBarRef.current) {
          tabBarRef.current.scrollLeft = tabBarRef.current.scrollWidth;
        }
      });
    }
  }, [showContentTabs, visibleItems.length, !!previewItem]);

  const prevDragOverTargetRef = useRef<string | null>(null);
  const onTabDragCompleteRef = useRef(onTabDragComplete);
  onTabDragCompleteRef.current = onTabDragComplete;

  const handleTabMouseDown = useCallback((e: React.MouseEvent, item: ContentItem, idx: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    tabDragRef.current = {
      contentItem: item,
      label: item.title || item.analysis_type || TAB_LABELS[item.kind || ''] || `Tab ${idx + 1}`,
      startX: e.clientX,
      startY: e.clientY,
      extracted: false,
      width: 0,
      height: 0,
    };
    onActiveContentIndexChange(idx);
  }, [onActiveContentIndexChange]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = tabDragRef.current;
      if (!drag) return;
      const dist = Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY);
      if (!drag.extracted && dist > EXTRACT_THRESHOLD) {
        drag.extracted = true;
        drag.width = cardRef.current?.offsetWidth || 400;
        drag.height = cardRef.current?.offsetHeight || 300;
        setDraggedTabId(drag.contentItem.id);
        onTabDragActiveChangeRef.current?.(true);
        // Show connectors for the source analysis during tab drag
        window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId } }));
        // Highlight available dropzones (ALL containers including source — drop back to cancel)
        document.querySelectorAll<HTMLElement>('[data-dropzone^="analysis-"]').forEach(el => {
          el.classList.add('dropzone-highlight');
        });
      }
      if (!drag.extracted) return;

      setTabDragGhost({ x: e.clientX, y: e.clientY, label: drag.label, contentItem: drag.contentItem, width: drag.width, height: drag.height });

      // Hit-test for drop targets (title bar / tab bar only)
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      let targetId: string | null = null;
      for (const el of elements) {
        const dz = (el as HTMLElement).closest?.('[data-dropzone^="analysis-"]');
        if (dz) {
          const aid = (dz.getAttribute('data-dropzone') || '').replace('analysis-', '');
          targetId = aid; break;
        }
      }
      setTabDragOverTarget(targetId);

      // Dispatch preview events on target change
      if (targetId !== prevDragOverTargetRef.current) {
        if (prevDragOverTargetRef.current) {
          window.dispatchEvent(new CustomEvent('dagnet:clearContentItemPreview', {
            detail: { targetAnalysisId: prevDragOverTargetRef.current },
          }));
        }
        prevDragOverTargetRef.current = targetId;
        if (targetId) {
          window.dispatchEvent(new CustomEvent('dagnet:previewContentItem', {
            detail: {
              targetAnalysisId: targetId,
              contentItem: drag.contentItem,
              analysisResult: result,
            },
          }));
        }
      }
    };

    const onUp = (e: MouseEvent) => {
      const drag = tabDragRef.current;
      if (!drag) return;
      tabDragRef.current = null;

      // Clear any preview
      if (prevDragOverTargetRef.current) {
        window.dispatchEvent(new CustomEvent('dagnet:clearContentItemPreview', {
          detail: { targetAnalysisId: prevDragOverTargetRef.current },
        }));
      }
      const targetId = prevDragOverTargetRef.current;
      prevDragOverTargetRef.current = null;

      setTabDragGhost(null);
      setTabDragOverTarget(null);
      setDraggedTabId(null);
      // Clear hover connectors from tab drag
      window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: null } }));
      // Clear dropzone highlights
      document.querySelectorAll('.dropzone-highlight').forEach(el => el.classList.remove('dropzone-highlight'));

      if (drag.extracted) {
        onTabDragActiveChangeRef.current?.(false);
      }
      // Drop back on source = cancel (tab reappears via draggedTabId clearing above)
      const isCancel = targetId === analysisId;
      if (drag.extracted && onTabDragCompleteRef.current && !isCancel) {
        onTabDragCompleteRef.current({
          contentItem: drag.contentItem,
          label: drag.label,
          screenX: e.clientX,
          screenY: e.clientY,
          targetAnalysisId: targetId,
          duplicate: e.ctrlKey || e.metaKey,
        });
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [analysisId, result]);

  // --- Tab context menu ---
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; item: ContentItem } | null>(null);

  const tabContextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!tabContextMenu) return [];
    const ci = tabContextMenu.item;
    const closeMenu = () => setTabContextMenu(null);
    // Use parent-provided full menu builder when available (shared codepath with node context menu)
    if (buildTabContextMenuItems) {
      return buildTabContextMenuItems(ci, closeMenu);
    }
    // Fallback: simple menu for contexts without the full builder (e.g. hover preview)
    const hasOverlay = !!(ci.display as any)?.show_subject_overlay;
    return [
      ...(onTabOverlayToggle ? [{
        label: hasOverlay ? 'Hide Connectors' : 'Show Connectors',
        onClick: () => { onTabOverlayToggle(ci, !hasOverlay); closeMenu(); },
      }] : []),
      ...(onOpenContentItemAsTab ? [{ label: 'Open as Tab', onClick: () => { onOpenContentItemAsTab(ci); closeMenu(); }, disabled: !result }] : []),
      ...(onRemoveContentItem ? [{ label: 'Close', onClick: () => { onRemoveContentItem(ci.id); closeMenu(); }, divider: true as const }] : []),
    ];
  }, [tabContextMenu, result, onOpenContentItemAsTab, onRemoveContentItem, onTabOverlayToggle, buildTabContextMenuItems]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, item: ContentItem) => {
    e.preventDefault();
    e.stopPropagation();
    setTabContextMenu({ x: e.clientX, y: e.clientY, item });
  }, []);

  // --- Preview overlay for snap-in ---
  // Shows real chart content when result is available; loading spinner otherwise.
  // Memoize scenario IDs to avoid new array reference on every render (prevents infinite loop).
  const previewScenarioIds = useMemo(() => {
    if (!previewResult) return ['current'];
    const ids = (previewResult as any).scenarios?.map((s: any) => s.scenario_id);
    return ids?.length ? ids : ['current'];
  }, [previewResult]);

  const previewOverlay = previewActive && previewItem ? (
    <div style={{
      position: 'absolute', inset: 0,
      zIndex: 5,
      background: 'var(--bg-primary, #1a1a2e)',
      borderRadius: 'inherit',
      overflow: 'hidden',
    }}>
      {previewResult ? (
        <AnalysisChartContainer
          result={previewResult}
          chartKindOverride={previewItem.kind}
          visibleScenarioIds={previewScenarioIds}
          display={previewItem.display}
          fillHeight
          chartContext="canvas"
          hideScenarioLegend
          analysisTypeId={previewItem.analysis_type}
          infoCardKind={previewItem.kind}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
          <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      )}
    </div>
  ) : null;

  // --- Render ---
  return (
    <>
      <div
        ref={cardRef}
        className={className}
        style={{ display: 'flex', flexDirection: 'column', ...style }}
      >
        {renderHeader?.()}

        {/* Tab bar — always in DOM to avoid mount/unmount layout flicker */}
        <div
          ref={tabBarRef}
          className="nodrag canvas-analysis-tab-bar"
          data-dropzone={`analysis-${analysisId}`}
          style={{
            display: showContentTabs ? 'flex' : 'none',
            gap: 0,
            borderBottom: '1px solid var(--canvas-analysis-border, #e5e7eb)',
            flexShrink: 0,
            background: 'var(--canvas-analysis-title-bg, #f9fafb)',
            fontSize: 9,
            overflowX: 'auto',
            overflowY: 'hidden',
            alignItems: 'stretch',
            ...chromeZoomStyle,
          }}
          >
            {visibleItems.map((item, idx) => (
              <div
                key={item.id}
                className="canvas-analysis-content-tab"
                onContextMenu={(e) => handleTabContextMenu(e, item)}
                style={(() => {
                  const tabOverlayColour = (item.display as any)?.subject_overlay_colour;
                  const isActive = idx === clampedIndex;
                  const hasOverlay = (item.display as any)?.show_subject_overlay && tabOverlayColour;
                  return {
                    display: 'flex',
                    alignItems: 'center',
                    borderBottom: isActive
                      ? `2px solid ${tabOverlayColour || connectorColour || 'var(--accent-primary, #3b82f6)'}`
                      : hasOverlay
                        ? `2px solid ${tabOverlayColour}80` // 50% opacity via hex alpha
                        : '2px solid transparent',
                    background: isActive ? 'var(--bg-primary, #fff)' : 'transparent',
                  };
                })()}
              >
                <button
                  type="button"
                  onMouseEnter={() => onActiveContentIndexChange(idx)}
                  onMouseDown={(e) => handleTabMouseDown(e, item, idx)}
                  style={{
                    all: 'unset',
                    padding: '3px 4px 3px 8px',
                    color: idx === clampedIndex ? 'var(--text-primary, #111)' : 'var(--text-muted, #6b7280)',
                    fontWeight: idx === clampedIndex ? 600 : 400,
                    cursor: 'grab',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 100,
                    fontSize: 'inherit',
                    userSelect: 'none',
                  }}
                  title={item.title || item.analysis_type || `Tab ${idx + 1}`}
                >
                  {item.title || item.analysis_type || `Tab ${idx + 1}`}
                </button>
                {onRemoveContentItem && (
                  <button
                    type="button"
                    className="canvas-analysis-tab-close"
                    onClick={(e) => { e.stopPropagation(); onRemoveContentItem(item.id); }}
                    title="Close tab"
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      padding: '2px 4px',
                      fontSize: 8,
                      lineHeight: 1,
                      color: 'var(--text-muted, #999)',
                      opacity: 0,
                      transition: 'opacity 0.1s',
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {/* Snap-in preview tab */}
            {previewItem && (
              <div
                key="__preview__"
                className={`canvas-analysis-content-tab canvas-analysis-content-tab--preview${previewActive ? ' canvas-analysis-content-tab--active' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  borderBottom: previewActive
                    ? '2px solid var(--accent-primary, #3b82f6)'
                    : '2px dashed var(--accent-primary, #3b82f6)',
                  background: previewActive
                    ? 'var(--accent-primary-15, rgba(59, 130, 246, 0.12))'
                    : 'var(--accent-primary-10, rgba(59, 130, 246, 0.06))',
                  opacity: previewActive ? 1 : 0.7,
                }}
              >
                <span style={{
                  padding: '3px 8px',
                  color: 'var(--accent-primary, #3b82f6)',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  fontSize: 'inherit',
                  userSelect: 'none',
                }}>
                  {previewItem.title || previewItem.kind || 'New tab'}
                </span>
              </div>
            )}
            {/* + button */}
            {onAddContentItem && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onAddContentItem(); }}
                title="Add tab"
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  padding: '3px 8px',
                  color: 'var(--text-muted, #6b7280)',
                  fontSize: 9,
                  fontWeight: 400,
                  flexShrink: 0,
                }}
              >
                +
              </button>
            )}
          </div>

        {/* Content area */}
        <div ref={contentAreaRef} style={{ flex: 1, overflow: 'auto', position: 'relative', minHeight: 0, ...contentZoomStyle }}>
          {/* Interaction overlay when not selected (pinned mode) */}
          {!interactive && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 10, cursor: 'grab' }} />
          )}
          {/* Recomputing overlay */}
          {result && loading && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 5,
              background: 'var(--canvas-analysis-recompute-overlay, rgba(255,255,255,0.55))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted, #6b7280)' }} />
            </div>
          )}
          {hasAnalysisType && backendUnavailable && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)', padding: 16 }}>
              <ServerOff size={28} />
              <span style={{ fontSize: 12, textAlign: 'center' }}>Analysis backend unavailable</span>
            </div>
          )}
          {hasAnalysisType && !backendUnavailable && error && !result && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--color-danger)', padding: 16 }}>
              <AlertCircle size={24} />
              <span style={{ fontSize: 11, textAlign: 'center', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', WebkitLineClamp: 3, display: '-webkit-box', WebkitBoxOrient: 'vertical' }}>{error}</span>
            </div>
          )}
          {hasAnalysisType && !backendUnavailable && !result && !error && (loading || waitingForDeps) && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)' }}>
              <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12 }}>{waitingForDeps ? 'Loading chart dependencies...' : 'Computing...'}</span>
            </div>
          )}
          {awaitingScenariosHydration && result && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)' }}>
              <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12 }}>Loading scenarios...</span>
            </div>
          )}

          {/* Main content — rendered by consumer */}
          {renderContent(contentItem, previewOverlay)}

          {/* Extra content (expression views in pinned mode) */}
          {renderExtra?.()}
        </div>
      </div>

      {/* Tab context menu — portalled to body to escape ReactFlow transform context */}
      {tabContextMenu && createPortal(
        <ContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          items={tabContextMenuItems}
          onClose={() => setTabContextMenu(null)}
        />,
        document.body,
      )}

      {/* Ghost during tab drag-out — full-content preview matching the card dimensions */}
      {tabDragGhost && createPortal(
        <div
          style={{
            position: 'fixed',
            left: tabDragGhost.x + 12,
            top: tabDragGhost.y - 16,
            pointerEvents: 'none',
            zIndex: 10000,
            width: tabDragGhost.width,
            height: tabDragGhost.height,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-primary, #fff)',
            border: '1px solid var(--accent-primary, #3b82f6)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            opacity: 0.85,
            overflow: 'hidden',
          }}
        >
          {/* Tab label header */}
          <div style={{
            padding: '3px 8px',
            fontSize: 9,
            fontWeight: 600,
            color: 'var(--text-primary, #374151)',
            borderBottom: '1px solid var(--canvas-analysis-border, #e5e7eb)',
            background: 'var(--canvas-analysis-title-bg, #f9fafb)',
          }}>
            {tabDragGhost.label}
            {tabDragOverTarget && (
              <span style={{ fontSize: 7, marginLeft: 4, color: 'var(--accent-primary, #3b82f6)' }}> → merge</span>
            )}
          </div>
          {/* Full chart content */}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            {renderContent(tabDragGhost.contentItem, null)}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
