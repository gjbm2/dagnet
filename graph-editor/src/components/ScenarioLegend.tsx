/**
 * ScenarioLegend
 * 
 * Floating legend showing all scenarios with visibility toggles and delete buttons.
 * Positioned below the window panel on the graph canvas.
 * 
 * Now rendered INSIDE the canvas panel content, so it naturally uses the canvas width
 * without needing complex JavaScript width calculations.
 */

import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { Scenario } from '../types/scenarios';
import { Eye, EyeOff, Images, Image, Square, X, Plus, Minimize2, Maximize2, Check, Trash2, LayoutTemplate, LockKeyhole, LockOpen, Layers as LayersIcon, LayoutPanelLeft, Monitor, type LucideIcon } from 'lucide-react';
import type { ScenarioVisibilityMode, ViewOverlayMode, CanvasView } from '../types';
import { useScenarioHighlight } from '../contexts/ScenarioHighlightContext';
import toast from 'react-hot-toast';
import { createPortal } from 'react-dom';
import './ScenarioLegend.css';

/** View mode items for the hover submenu. */
interface ViewModeItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  isActive: () => boolean;
  toggle: () => void;
  /** Optional sub-options shown on hover when this mode's pill is active. */
  activeSubmenu?: { label: string; checked?: boolean; onClick: () => void }[];
}

interface ScenarioLegendProps {
  scenarios: Scenario[];
  scenarioOrder: string[];
  visibleScenarioIds: string[];
  currentColour: string;
  baseColour: string;
  showCurrent: boolean;
  showBase: boolean;
  isDashboardMode?: boolean;
  activeDsl?: string | null;
  baseDsl?: string | null;
  onToggleVisibility: (scenarioId: string) => void;
  onCycleVisibilityMode?: (scenarioId: string) => void;
  getVisibilityMode?: (scenarioId: string) => ScenarioVisibilityMode;
  onDelete: (scenarioId: string) => void;
  onNewScenario?: () => void;
  /** View mode items for the hover submenu. */
  viewModes?: ViewModeItem[];
  /** When true, scenario chips are hidden (replaced by the active mode pill). */
  hideScenarioChips?: boolean;
  /** Canvas view groups. */
  canvasViews?: CanvasView[];
  activeCanvasViewId?: string | null;
  onRenameScenario?: (scenarioId: string, newName: string) => void;
  /** Colour the next created scenario will get. */
  nextScenarioColour?: string;
  /** Dashboard auto-cycle interval in ms (null = off). Drives drain animation on view pill. */
  dashboardCycleMs?: number | null;
  /** Reorder user scenarios by index within the user-scenario-only list. */
  onReorderScenario?: (fromIndex: number, toIndex: number) => void;
}

export function ScenarioLegend({
  scenarios,
  scenarioOrder,
  visibleScenarioIds,
  currentColour,
  baseColour,
  showCurrent,
  showBase,
  isDashboardMode,
  activeDsl,
  baseDsl,
  onToggleVisibility,
  onCycleVisibilityMode,
  getVisibilityMode,
  onDelete,
  onNewScenario,
  viewModes = [],
  hideScenarioChips = false,
  canvasViews = [],
  activeCanvasViewId,
  onRenameScenario,
  nextScenarioColour,
  dashboardCycleMs,
  onReorderScenario,
}: ScenarioLegendProps) {
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const { highlightedScenarioId, setHighlightedScenarioId } = useScenarioHighlight();

  // Clear peek if the highlighted scenario becomes hidden
  useEffect(() => {
    if (highlightedScenarioId && !visibleScenarioIds.includes(highlightedScenarioId)) {
      setHighlightedScenarioId(null);
    }
  }, [highlightedScenarioId, visibleScenarioIds, setHighlightedScenarioId]);

  // Track which chips have had their enter animation — remove the class after it plays
  // so React DOM reordering can never replay it.
  // Entrance animation — detected synchronously during render (not in useEffect)
  // so the chip-enter class is present on the FIRST paint, not one frame late.
  const knownChipIdsRef = useRef<Set<string>>(new Set());
  const knownPillIdsRef = useRef<Set<string>>(new Set());
  const [, forceAnimUpdate] = useState(0);

  // Scenario chips — detect fresh IDs during render
  const currentScenarioIds = scenarios.map(s => s.id);
  const freshScenarioIds = currentScenarioIds.filter(id => !knownChipIdsRef.current.has(id));
  const enterAnimatingIds = useRef(new Set<string>()).current;
  if (freshScenarioIds.length > 0) {
    freshScenarioIds.forEach(id => enterAnimatingIds.add(id));
    knownChipIdsRef.current = new Set(currentScenarioIds);
  } else if (currentScenarioIds.length !== knownChipIdsRef.current.size) {
    knownChipIdsRef.current = new Set(currentScenarioIds);
  }

  // View pill + mode pills — detect fresh IDs during render
  const activeModeIds = viewModes.filter(m => m.isActive()).map(m => `mode-${m.id}`);
  const viewPillId = activeCanvasViewId ? [`view-${activeCanvasViewId}`] : [];
  const currentPillIds = [...viewPillId, ...activeModeIds];
  const freshPillIds = currentPillIds.filter(id => !knownPillIdsRef.current.has(id));
  const enterAnimatingPills = useRef(new Set<string>()).current;
  if (freshPillIds.length > 0) {
    freshPillIds.forEach(id => enterAnimatingPills.add(id));
    knownPillIdsRef.current = new Set(currentPillIds);
  } else if (currentPillIds.length !== knownPillIdsRef.current.size) {
    knownPillIdsRef.current = new Set(currentPillIds);
  }

  // Clean up animation classes after they complete (350ms)
  useEffect(() => {
    if (freshScenarioIds.length === 0 && freshPillIds.length === 0) return;
    const t = setTimeout(() => {
      freshScenarioIds.forEach(id => enterAnimatingIds.delete(id));
      freshPillIds.forEach(id => enterAnimatingPills.delete(id));
      forceAnimUpdate(n => n + 1);
    }, 350);
    return () => clearTimeout(t);
  }); // intentionally no deps — runs after every render that had fresh IDs

  // ── Horizontal drag-reorder for user scenario chips ──
  const CHIP_DRAG_THRESHOLD = 5;
  const chipPendingRef = useRef<{ idx: number; startX: number; startY: number; pointerId: number } | null>(null);
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [chipDrag, setChipDrag] = useState<{
    fromIdx: number; overIdx: number;
    x: number; y: number; ox: number; oy: number;
    rect: { width: number; height: number };
    slotMids: number[]; // X midpoints
  } | null>(null);
  const [chipSuppressTransitions, setChipSuppressTransitions] = useState(false);
  // Frozen drag state kept after drop so shuffle transforms persist until reorder renders
  const [frozenDrag, setFrozenDrag] = useState<{ fromIdx: number; overIdx: number; rect: { width: number } } | null>(null);
  // Clear frozen state when scenarioOrder changes (= reorder has rendered)
  const prevScenarioOrderRef = useRef(scenarioOrder);
  useEffect(() => {
    if (prevScenarioOrderRef.current !== scenarioOrder && frozenDrag) {
      setFrozenDrag(null);
      // Small delay so React has painted the new order before we re-enable transitions
      requestAnimationFrame(() => setChipSuppressTransitions(false));
    }
    prevScenarioOrderRef.current = scenarioOrder;
  }, [scenarioOrder, frozenDrag]);

  const onChipPointerDown = useCallback((e: React.PointerEvent, chipIndex: number) => {
    if (!onReorderScenario) return;
    if ((e.target as HTMLElement).closest('button')) return;
    chipPendingRef.current = { idx: chipIndex, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId };
  }, [onReorderScenario]);

  const startChipDrag = useCallback((chipIndex: number, clientX: number, clientY: number, pointerId: number) => {
    const el = chipRefs.current[chipIndex];
    if (!el) return;
    el.setPointerCapture(pointerId);
    const slotMids = chipRefs.current.map(ref => {
      if (!ref) return 0;
      const r = ref.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const rect = el.getBoundingClientRect();
    setChipDrag({
      fromIdx: chipIndex, overIdx: chipIndex,
      x: clientX, y: clientY,
      ox: clientX - rect.left, oy: clientY - rect.top,
      rect: { width: rect.width, height: rect.height },
      slotMids,
    });
  }, []);

  const onChipPointerMove = useCallback((e: React.PointerEvent) => {
    const p = chipPendingRef.current;
    if (p && !chipDrag) {
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (dx * dx + dy * dy > CHIP_DRAG_THRESHOLD * CHIP_DRAG_THRESHOLD) {
        chipPendingRef.current = null;
        startChipDrag(p.idx, e.clientX, e.clientY, p.pointerId);
      }
      return;
    }
    if (!chipDrag) return;
    const x = e.clientX;
    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < chipDrag.slotMids.length; i++) {
      const d = Math.abs(x - chipDrag.slotMids[i]);
      if (d < minDist) { minDist = d; closest = i; }
    }
    setChipDrag(prev => prev ? { ...prev, x: e.clientX, y: e.clientY, overIdx: closest } : null);
  }, [chipDrag, startChipDrag]);

  const onChipPointerUp = useCallback(() => {
    chipPendingRef.current = null;
    if (chipDrag && chipDrag.fromIdx !== chipDrag.overIdx && onReorderScenario) {
      const { fromIdx, overIdx } = chipDrag;
      // Freeze the shuffle transforms so they persist until the reorder renders
      setFrozenDrag({ fromIdx, overIdx, rect: { width: chipDrag.rect.width } });
      setChipSuppressTransitions(true);
      setChipDrag(null); // removes ghost, but frozenDrag keeps transforms
      onReorderScenario(fromIdx, overIdx);
    } else {
      setChipDrag(null);
    }
  }, [chipDrag, onReorderScenario]);

  /**
   * Get simple visibility (eye) icon for a scenario (bool)
   */
  const getVisibilityIcon = useCallback((scenarioId: string) => {
    const isVisible = visibleScenarioIds.includes(scenarioId);
    return isVisible ? <Eye size={14} /> : <EyeOff size={14} />;
  }, [visibleScenarioIds]);
  
  /**
   * Get visibility tooltip for a scenario
   */
  const getVisibilityTooltip = useCallback((scenarioId: string, name: string): string => {
    const isVisible = visibleScenarioIds.includes(scenarioId);
    return isVisible ? `Hide ${name}` : `Show ${name}`;
  }, [visibleScenarioIds]);
  
  /**
   * Get tri-state mode icon (F+E / F / E)
   */
  const getModeIcon = useCallback((scenarioId: string) => {
    if (!getVisibilityMode) return <Images size={14} />;
    const mode = getVisibilityMode(scenarioId);
    switch (mode) {
      case 'f+e': return <Images size={14} />;
      case 'f': return <Image size={14} />;
      case 'e': return <Square size={14} />;
      default: return <Images size={14} />;
    }
  }, [getVisibilityMode]);
  
  /**
   * Get tri-state mode tooltip for a scenario
   */
  const getModeTooltip = useCallback((scenarioId: string, name: string): string => {
    if (!getVisibilityMode) return `${name}: Cycle forecast/evidence display`;
    const mode = getVisibilityMode(scenarioId);
    switch (mode) {
      case 'f+e': return `${name}: Forecast + Evidence (click to cycle)`;
      case 'f': return `${name}: Forecast only (click to cycle)`;
      case 'e': return `${name}: Evidence only (click to cycle)`;
      default: return `${name}: Cycle forecast/evidence display`;
    }
  }, [getVisibilityMode]);
  
  /**
   * Handle visibility toggle (eye icon)
   */
  const handleVisibilityClick = useCallback((scenarioId: string) => {
    onToggleVisibility(scenarioId);
  }, [onToggleVisibility]);
  
  /**
   * Handle tri-state mode cycle (F+E/F/E)
   */
  const handleModeClick = useCallback((scenarioId: string) => {
    if (!onCycleVisibilityMode || !getVisibilityMode) return;
    
    const currentMode = getVisibilityMode(scenarioId);
    const modeOrder: ScenarioVisibilityMode[] = ['f+e', 'f', 'e'];
    const currentIndex = modeOrder.indexOf(currentMode);
    const nextMode = modeOrder[(currentIndex + 1) % modeOrder.length];
    
    onCycleVisibilityMode(scenarioId);
    
    const modeLabels: Record<ScenarioVisibilityMode, string> = {
      'f+e': 'Forecast + Evidence',
      'f': 'Forecast only',
      'e': 'Evidence only',
    };
    toast.success(`${modeLabels[nextMode]}`, { duration: 1500 });
  }, [onCycleVisibilityMode, getVisibilityMode]);
  
  /**
   * Get chip background style based on visibility mode
   * - F+E: Gradient solid→striped L→R
   * - F only: Striped background
   * - E only: Solid background (default)
   * - Hidden: Semi-transparent (handled via opacity)
   */
  const getChipStyle = useCallback((scenarioId: string, baseColour: string): React.CSSProperties => {
    if (!getVisibilityMode) {
      return { backgroundColor: baseColour };
    }
    
    const mode = getVisibilityMode(scenarioId);
    
    switch (mode) {
      case 'f+e':
        // Smooth gradient: solid left → striped right (evidence → forecast)
        // Uses CSS mask to smoothly blend solid colour into stripes
        return {
          background: `
            linear-gradient(90deg, ${baseColour} 0%, ${baseColour} 30%, transparent 70%, transparent 100%),
            repeating-linear-gradient(45deg, ${baseColour} 0px, ${baseColour} 2px, ${baseColour}66 2px, ${baseColour}66 4px)
          `,
          backgroundColor: `${baseColour}44`,
        };
      case 'f':
        // Striped background (forecast only)
        return {
          background: `repeating-linear-gradient(45deg, ${baseColour} 0px, ${baseColour} 2px, ${baseColour}66 2px, ${baseColour}66 4px)`,
          backgroundColor: `${baseColour}44`,
        };
      case 'e':
        // Solid background (evidence only)
        return { backgroundColor: baseColour };
      default:
        return { backgroundColor: baseColour };
    }
  }, [getVisibilityMode]);
  
  // Count visible scenarios (user scenarios + current/base if visible)
  const visibleCount = visibleScenarioIds.length;
  // Show chips if there are any scenarios (visible or not) or if current/base are shown
  const shouldShowChips = !hideScenarioChips && (scenarios.length > 0 || visibleCount > 0);
  
  /**
   * Get effective colour for a scenario (with single-layer grey override)
   * Only the sole VISIBLE layer is shown in grey; hidden layers retain their assigned colour.
   */
  const getScenarioColour = useCallback((scenarioId: string, isVisible: boolean = true): string => {
    // Single-layer grey override: ONLY apply to the visible layer when exactly 1 layer is visible
    if (isVisible && visibleScenarioIds.length === 1) {
      return '#808080';
    }
    
    // Get stored colour (for both visible and hidden layers)
    if (scenarioId === 'current') {
      return currentColour;
    } else if (scenarioId === 'base') {
      return baseColour;
    } else {
      const scenario = scenarios.find(s => s.id === scenarioId);
      return scenario?.colour || '#808080';
  }
  }, [visibleScenarioIds.length, currentColour, baseColour, scenarios]);
  
  // Derive tab-specific order for user scenarios (excluding base/current)
  const orderedUserScenarios: Scenario[] = (scenarioOrder.length > 0
    ? scenarioOrder
        .filter(id => id !== 'current' && id !== 'base')
        .map(id => scenarios.find(s => s.id === id))
        .filter((s): s is Scenario => s !== undefined)
    : scenarios
  );


  // Width is now handled by CSS - legend is inside canvas panel so it uses parent width naturally
  /**
   * Dashboard-only labelling: in dashboard mode we replace "Current/Base" with DSL strings for clarity.
   * Tooltip/title behaviour: for callers that omit `isDashboardMode` (e.g. unit tests), we still allow DSL titles.
   *
   * GraphEditor always passes `isDashboardMode` explicitly, so normal-mode behaviour is unaffected.
   */
  const useDslLabels = isDashboardMode === true;
  const useDslTitles = isDashboardMode !== false; // true when omitted OR dashboard mode

  const currentLabel = useDslLabels && activeDsl ? activeDsl : 'Current';
  const baseLabel = useDslLabels && baseDsl ? baseDsl : 'Base';
  const baseTitleDsl = baseDsl ?? activeDsl ?? null;
  const baseTitle = useDslTitles && baseTitleDsl ? `Base — ${baseTitleDsl}` : 'Base';
  const currentTitle = useDslTitles && activeDsl ? `Current — ${activeDsl}` : 'Current';

  return (
    <div className="scenario-legend">
      {/* Active canvas view pill — first, as it's determinative (controls scenarios + modes) */}
      {activeCanvasViewId && (() => {
        const activeView = canvasViews.find(v => v.id === activeCanvasViewId);
        if (!activeView) return null;
        return (
          <CanvasViewPill
            key={activeView.id}
            view={activeView}
            allViews={canvasViews}
            cycleMs={dashboardCycleMs}
            chipEnter={enterAnimatingPills.has(`view-${activeView.id}`)}
            onDeactivate={() => window.dispatchEvent(new Event('dagnet:deactivateCanvasView'))}
            onRename={(name) => window.dispatchEvent(new CustomEvent('dagnet:renameCanvasView', { detail: { viewId: activeView.id, name } }))}
          />
        );
      })()}

      {/* Active view mode pills — shown for each active mode */}
      {viewModes.filter(m => m.isActive()).map(mode => {
        const ModeIcon = mode.icon;
        const hasSubmenu = mode.activeSubmenu && mode.activeSubmenu.length > 0;
        return (
        <div key={mode.id} className={`scenario-legend-new-wrapper${hasSubmenu ? '' : ' scenario-legend-no-submenu'}`}>
          <div className={`scenario-legend-chip scenario-legend-mode-pill${enterAnimatingPills.has(`mode-${mode.id}`) ? ' chip-enter' : ''}`}>
            <span className="scenario-legend-name">{ModeIcon && <ModeIcon size={16} />}{mode.label}</span>
            <button
              className="scenario-legend-delete"
              onClick={(e) => {
                e.stopPropagation();
                mode.toggle();
              }}
              title={`Exit ${mode.label}`}
            >
              <X size={14} />
            </button>
          </div>
          {hasSubmenu && (
            <div className="scenario-legend-hover-submenu">
              {mode.activeSubmenu!.map((item, i) => (
                <button
                  key={item.label}
                  className={`scenario-legend-view-pill${item.checked ? ' active' : ''}`}
                  style={{ transitionDelay: `${(i + 1) * 0.015 + 0.015}s` }}
                  onClick={(e) => { e.stopPropagation(); item.onClick(); }}
                >
                  {item.checked && <Check size={14} />}
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        );
      })}

      {/* Scenario chips: Base -> User Scenarios -> Current */}

      {/* 1. Base - bottom of stack */}
      {shouldShowChips && showBase && (
        <div
          key="base"
          className={`scenario-legend-chip ${!visibleScenarioIds.includes('base') ? 'invisible' : ''}`}
          title={baseTitle}
          style={{
            ...getChipStyle('base', getScenarioColour('base', visibleScenarioIds.includes('base'))),
            opacity: visibleScenarioIds.includes('base') ? 1 : 0.3
          }}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
          }}
          onMouseEnter={() => visibleScenarioIds.includes('base') && setHighlightedScenarioId('base')}
          onMouseLeave={() => visibleScenarioIds.includes('base') && setHighlightedScenarioId(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
              detail: { x: e.clientX, y: e.clientY, scenarioId: 'base' }
            }));
          }}
        >
          <button
            className="scenario-legend-toggle"
            onClick={(e) => {
              e.stopPropagation();
              handleVisibilityClick('base');
            }}
            title={getVisibilityTooltip('base', 'Base')}
          >
            {getVisibilityIcon('base')}
          </button>
          <button
            className="scenario-legend-mode-toggle"
            onClick={(e) => {
              e.stopPropagation();
              handleModeClick('base');
            }}
            title={getModeTooltip('base', 'Base')}
          >
            {getModeIcon('base')}
          </button>
          
          <span className="scenario-legend-name">{baseLabel}</span>
        </div>
      )}
      
      {/* 2. User Scenarios - show ALL scenarios in tab-specific layer order */}
      {/* Use scenarioOrder (per-tab), reversed so left = bottom of stack, right = top */}
      {shouldShowChips && [...orderedUserScenarios]
        .reverse()
        .map((scenario, chipIndex) => {
        const isVisible = visibleScenarioIds.includes(scenario.id);
        const colour = getScenarioColour(scenario.id, isVisible);
        const isChipGrabbed = chipDrag?.fromIdx === chipIndex;

        // Horizontal shuffle: shift chips left/right to open a gap.
        // Use either the active drag or the frozen post-drop drag for transforms.
        const activeDrag = chipDrag || frozenDrag;
        const isFrozenGrabbed = frozenDrag?.fromIdx === chipIndex;
        let chipTransform = '';
        if (activeDrag && !isChipGrabbed && !isFrozenGrabbed) {
          const { fromIdx, overIdx } = activeDrag;
          const shiftPx = activeDrag.rect.width + 6; // chip width + gap
          if (fromIdx < overIdx) {
            if (chipIndex > fromIdx && chipIndex <= overIdx) chipTransform = `translateX(-${shiftPx}px)`;
          } else if (fromIdx > overIdx) {
            if (chipIndex >= overIdx && chipIndex < fromIdx) chipTransform = `translateX(${shiftPx}px)`;
          }
        }

        return (
          <div
            key={scenario.id}
            ref={el => { chipRefs.current[chipIndex] = el; }}
            className={`scenario-legend-chip${enterAnimatingIds.has(scenario.id) ? ' chip-enter' : ''} ${!isVisible ? 'invisible' : ''} ${deletingIds.includes(scenario.id) ? 'deleting' : ''}${(isChipGrabbed || isFrozenGrabbed) ? ' chip-grabbed' : ''}`}
            style={{
              ...getChipStyle(scenario.id, colour),
              opacity: (isChipGrabbed || isFrozenGrabbed) ? 0 : (isVisible ? 1 : 0.3),
              transform: chipTransform || undefined,
              transition: (isChipGrabbed || isFrozenGrabbed || chipSuppressTransitions) ? 'none' : chipDrag ? 'transform 0.15s ease' : undefined,
            }}
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
            }}
            onPointerDown={(e) => onChipPointerDown(e, chipIndex)}
            onPointerMove={onChipPointerMove}
            onPointerUp={onChipPointerUp}
            onPointerCancel={onChipPointerUp}
            onMouseEnter={() => isVisible && setHighlightedScenarioId(scenario.id)}
            onMouseLeave={() => isVisible && setHighlightedScenarioId(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
                detail: { x: e.clientX, y: e.clientY, scenarioId: scenario.id }
              }));
            }}
          >
            <button
              className="scenario-legend-toggle"
              onClick={(e) => {
                e.stopPropagation();
                handleVisibilityClick(scenario.id);
              }}
              title={getVisibilityTooltip(scenario.id, scenario.name)}
            >
              {getVisibilityIcon(scenario.id)}
            </button>
            <button
              className="scenario-legend-mode-toggle"
              onClick={(e) => {
                e.stopPropagation();
                handleModeClick(scenario.id);
              }}
              title={getModeTooltip(scenario.id, scenario.name)}
            >
              {getModeIcon(scenario.id)}
            </button>
            
            <InlineEditableName
              name={scenario.name}
              onRename={onRenameScenario ? (name) => onRenameScenario(scenario.id, name) : undefined}
            />

            <button
              className="scenario-legend-delete"
              onClick={(e) => {
                e.stopPropagation();
                // Mark as deleting to trigger shrink animation, then actually delete
                setDeletingIds(prev => prev.includes(scenario.id) ? prev : [...prev, scenario.id]);
                setTimeout(() => {
                  onDelete(scenario.id);
                }, 280);
              }}
              title="Delete scenario"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      {/* Floating ghost for chip drag */}
      {chipDrag && (() => {
        const reversed = [...orderedUserScenarios].reverse();
        const s = reversed[chipDrag.fromIdx];
        if (!s) return null;
        const isVisible = visibleScenarioIds.includes(s.id);
        const colour = getScenarioColour(s.id, isVisible);
        return createPortal(
          <div
            className="scenario-legend-chip chip-ghost"
            style={{
              ...getChipStyle(s.id, colour),
              position: 'fixed',
              left: chipDrag.x - chipDrag.ox,
              top: chipDrag.y - chipDrag.oy,
              width: chipDrag.rect.width,
              height: chipDrag.rect.height,
              margin: 0,
              pointerEvents: 'none',
              zIndex: 9999,
              opacity: 0.9,
              boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
            }}
          >
            <span className="scenario-legend-toggle">{getVisibilityIcon(s.id)}</span>
            <span className="scenario-legend-mode-toggle">{getModeIcon(s.id)}</span>
            <span className="scenario-legend-name">{s.name}</span>
            <span className="scenario-legend-delete"><X size={14} /></span>
          </div>,
          document.body,
        );
      })()}

      {/* 3. Current - top of stack, rightmost (before new button) */}
      {shouldShowChips && showCurrent && (
        <div
          key="current"
          className={`scenario-legend-chip ${!visibleScenarioIds.includes('current') ? 'invisible' : ''}`}
          title={currentTitle}
          style={{
            ...getChipStyle('current', getScenarioColour('current', visibleScenarioIds.includes('current'))),
            opacity: visibleScenarioIds.includes('current') ? 1 : 0.3
          }}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
          }}
          onMouseEnter={() => visibleScenarioIds.includes('current') && setHighlightedScenarioId('current')}
          onMouseLeave={() => visibleScenarioIds.includes('current') && setHighlightedScenarioId(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
              detail: { x: e.clientX, y: e.clientY, scenarioId: 'current' }
            }));
          }}
        >
          <button
            className="scenario-legend-toggle"
            onClick={(e) => {
              e.stopPropagation();
              handleVisibilityClick('current');
            }}
            title={getVisibilityTooltip('current', 'Current')}
          >
            {getVisibilityIcon('current')}
          </button>
          <button
            className="scenario-legend-mode-toggle"
            onClick={(e) => {
              e.stopPropagation();
              handleModeClick('current');
            }}
            title={getModeTooltip('current', 'Current')}
          >
            {getModeIcon('current')}
          </button>
          
          <span className="scenario-legend-name">{currentLabel}</span>
        </div>
      )}
      

      {/* + button with hover submenu — not shown in dashboard mode */}
      {!isDashboardMode && (
        <div className="scenario-legend-new-wrapper" style={nextScenarioColour ? { '--next-scenario-colour': nextScenarioColour } as React.CSSProperties : undefined}>
          {/* Invisible spacer to reserve full expanded width */}
          <span className="scenario-legend-new-spacer" aria-hidden="true">
            <Plus size={16} />
            <span>New scenario</span>
          </span>
          {/* Actual visible button */}
          <button
            className="scenario-legend-chip scenario-legend-new"
            onClick={onNewScenario}
            title={scenarios.length >= 15 ? 'Maximum scenarios reached' : 'New scenario'}
            disabled={!onNewScenario || scenarios.length >= 15}
            style={{ opacity: (!onNewScenario || scenarios.length >= 15) ? 0.5 : 1 }}
          >
            <Plus size={16} />
            <span className="scenario-legend-new-text">New scenario</span>
          </button>
          {/* Hover submenu: view modes + canvas views + actions */}
          <div className="scenario-legend-hover-submenu">
            {(() => {
              let idx = 0;
              const delay = () => `${(idx++) * 0.015 + 0.015}s`;
              // CanvasViewSubmenuItems will consume: divider + header + N views + New view + divider + Expand + Shrink
              const viewsSlots = 1 + 1 + canvasViews.length + 1 + 1 + 1 + 1; // divider, "Views" header, views, New view, divider, Expand, Shrink
              const viewsStartIdx = idx;
              idx += viewsSlots; // skip past views section so display modes continue the cascade
              return (
                <>
                  <CanvasViewSubmenuItems views={canvasViews} activeViewId={activeCanvasViewId} startIndex={viewsStartIdx} showHeader />

                  <div className="scenario-legend-submenu-divider" style={{ transitionDelay: delay(), height: 6 }} />
                  <div className="scenario-legend-submenu-header scenario-legend-view-pill" style={{ transitionDelay: delay() }}>Display mode</div>
                  {viewModes.map(mode => {
                    const Icon = mode.icon;
                    const d = delay();
                    return (
                      <button
                        key={mode.id}
                        className={`scenario-legend-view-pill ${mode.isActive() ? 'active' : ''}`}
                        style={{ transitionDelay: d }}
                        onClick={(e) => { e.stopPropagation(); mode.toggle(); }}
                      >
                        {Icon && <Icon size={16} />}
                        {mode.label}
                      </button>
                    );
                  })}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline-editable pill for the active canvas view, with hover submenu to switch views. */
function CanvasViewPill({ view, allViews, cycleMs, chipEnter, onDeactivate, onRename }: {
  view: CanvasView;
  allViews: CanvasView[];
  cycleMs?: number | null;
  chipEnter?: boolean;
  onDeactivate: () => void;
  onRename: (name: string) => void;
}) {
  // Drain animation key — resets whenever the view changes or cycle interval changes
  const [drainKey, setDrainKey] = useState(0);
  useEffect(() => { setDrainKey(k => k + 1); }, [view.id, cycleMs]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(view.name);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, view.name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== view.name) onRename(trimmed);
    setEditing(false);
  };

  return (
    <div className="scenario-legend-new-wrapper scenario-legend-canvas-view-pill-wrapper">
      <div className={`scenario-legend-chip scenario-legend-mode-pill scenario-legend-canvas-view-pill${chipEnter ? ' chip-enter' : ''}`} style={{ position: 'relative', overflow: 'hidden' }}>
        {/* Drain progress — fills L-to-R then resets on cycle */}
        {cycleMs && cycleMs > 0 && (
          <div
            key={drainKey}
            className="scenario-legend-drain"
            style={{ animationDuration: `${cycleMs}ms` }}
          />
        )}
        {editing ? (
          <input
            ref={inputRef}
            className="scenario-legend-inline-edit"
            value={draft}
            style={{ width: `${Math.max(draft.length + 1, 4)}ch` }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="scenario-legend-name"
            onClick={() => setEditing(true)}
            title="Click to rename"
            style={{ cursor: 'text' }}
          >
            {view.locked ? <LockKeyhole size={14} /> : <LockOpen size={14} />}
            {view.name}
          </span>
        )}
        <button
          className="scenario-legend-delete"
          onClick={(e) => { e.stopPropagation(); onDeactivate(); }}
          title="Deactivate view"
        >
          <X size={14} />
        </button>
      </div>
      {/* Hover submenu — view-only items */}
      <div className="scenario-legend-hover-submenu">
        <CanvasViewSubmenuItems views={allViews} activeViewId={view.id} startIndex={0} />
      </div>
    </div>
  );
}

/** Click-to-edit name span for scenario chips and similar pills. */
function InlineEditableName({ name, onRename }: { name: string; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name && onRename) onRename(trimmed);
    setEditing(false);
  };

  if (!onRename) {
    return <span className="scenario-legend-name">{name}</span>;
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="scenario-legend-inline-edit"
        value={draft}
        style={{ width: `${Math.max(draft.length + 1, 4)}ch` }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className="scenario-legend-name"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to rename"
      style={{ cursor: 'text' }}
    >
      {name}
    </span>
  );
}

/**
 * Shared canvas view items for hover submenus (used in both main dropdown and pill dropdown).
 *
 * Drag-reorder uses pointer events. The grabbed pill is pulled out of flow
 * (position:fixed, follows cursor). Remaining pills collapse the gap and
 * shuffle with translateY to show the insertion point. On release the pill
 * snaps into its new slot.
 */
function CanvasViewSubmenuItems({ views, activeViewId, startIndex = 0, onIndex, showHeader = false }: {
  views: CanvasView[];
  activeViewId?: string | null;
  startIndex?: number;
  onIndex?: () => void;
  showHeader?: boolean;
}) {
  const ROW_H = 35; // 31px pill + 4px gap
  const DRAG_THRESHOLD = 5; // px movement before drag engages

  // Pending = pointerdown recorded but haven't moved enough to start dragging yet.
  // Drag = actively dragging.
  const pendingRef = useRef<{ idx: number; startX: number; startY: number; pointerId: number } | null>(null);
  const [suppressTransitions, setSuppressTransitions] = useState(false);

  const [drag, setDrag] = useState<{
    fromIdx: number; overIdx: number;
    x: number; y: number; ox: number; oy: number;
    rect: { width: number; height: number };
    slotTops: number[];
  } | null>(null);

  const pillRefs = useRef<(HTMLDivElement | null)[]>([]);

  const onPointerDown = useCallback((e: React.PointerEvent, viewIndex: number) => {
    // Only block drag from the action overlay buttons, not the main pill button
    if ((e.target as HTMLElement).closest('.scenario-legend-canvas-view-actions')) return;
    // Record intent — actual drag starts after movement threshold
    pendingRef.current = { idx: viewIndex, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId };
  }, []);

  const startDrag = useCallback((viewIndex: number, clientX: number, clientY: number, pointerId: number) => {
    const el = pillRefs.current[viewIndex];
    if (!el) return;
    el.setPointerCapture(pointerId);

    const slotTops = pillRefs.current.map(ref => {
      if (!ref) return 0;
      const r = ref.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const rect = el.getBoundingClientRect();

    setDrag({
      fromIdx: viewIndex,
      overIdx: viewIndex,
      x: clientX, y: clientY,
      ox: clientX - rect.left, oy: clientY - rect.top,
      rect: { width: rect.width, height: rect.height },
      slotTops,
    });
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    // Check if we should promote pending → drag
    const p = pendingRef.current;
    if (p && !drag) {
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
        pendingRef.current = null;
        startDrag(p.idx, e.clientX, e.clientY, p.pointerId);
      }
      return;
    }
    if (!drag) return;
    const y = e.clientY;
    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < drag.slotTops.length; i++) {
      const d = Math.abs(y - drag.slotTops[i]);
      if (d < minDist) { minDist = d; closest = i; }
    }
    setDrag(prev => prev ? { ...prev, x: e.clientX, y: e.clientY, overIdx: closest } : null);
  }, [drag, startDrag]);

  const onPointerUp = useCallback(() => {
    pendingRef.current = null;
    if (drag && drag.fromIdx !== drag.overIdx) {
      const { fromIdx, overIdx } = drag;
      // Kill transitions so pills snap instantly to new positions on drop
      setSuppressTransitions(true);
      setDrag(null);
      window.dispatchEvent(new CustomEvent('dagnet:reorderCanvasViews', {
        detail: { fromIndex: fromIdx, toIndex: overIdx },
      }));
      // Re-enable transitions next frame
      requestAnimationFrame(() => setSuppressTransitions(false));
    } else {
      setDrag(null);
    }
  }, [drag]);

  let idx = startIndex;
  const delay = () => {
    const d = `${(idx++) * 0.015 + 0.015}s`;
    onIndex?.();
    return d;
  };

  return (
    <>
      {!showHeader && <div className="scenario-legend-submenu-divider" style={{ transitionDelay: delay() }} />}
      {showHeader && <div className="scenario-legend-submenu-header scenario-legend-view-pill" style={{ transitionDelay: delay() }}>Views</div>}

      {views.map((view, viewIndex) => {
        const isGrabbed = drag?.fromIdx === viewIndex;

        // Non-grabbed pills: shift to fill the vacated slot and open the insertion gap
        let transform = '';
        if (drag && !isGrabbed) {
          const { fromIdx, overIdx } = drag;
          if (fromIdx < overIdx) {
            // Dragging down: items between source+1..target shift up one slot
            if (viewIndex > fromIdx && viewIndex <= overIdx) transform = `translateY(-${ROW_H}px)`;
          } else if (fromIdx > overIdx) {
            // Dragging up: items between target..source-1 shift down one slot
            if (viewIndex >= overIdx && viewIndex < fromIdx) transform = `translateY(${ROW_H}px)`;
          }
        }

        const staggerDelay = delay();
        return (
        <div
          key={view.id}
          ref={el => { pillRefs.current[viewIndex] = el; }}
          className={`scenario-legend-view-pill scenario-legend-canvas-view-item${view.id === activeViewId ? ' active' : ''}${isGrabbed ? ' view-grabbed' : ''}${suppressTransitions ? ' view-no-transition' : ''}`}
          style={{
            transition: `opacity 0.1s ease ${staggerDelay}, transform 0.15s ease ${staggerDelay}, border-color 0.15s ease ${staggerDelay}, box-shadow 0.15s ease ${staggerDelay}`,
            transform: transform || undefined,
          }}
          onPointerDown={(e) => onPointerDown(e, viewIndex)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <button
            className="scenario-legend-canvas-view-btn"
            onClick={(e) => {
              e.stopPropagation();
              console.log('[ScenarioLegend] Dispatching dagnet:applyCanvasView', view.id);
              window.dispatchEvent(new CustomEvent('dagnet:applyCanvasView', { detail: { viewId: view.id } }));
            }}
          >
            {view.locked ? <LockKeyhole size={16} /> : <LockOpen size={16} />}
            {view.name}
          </button>
          {/* Action buttons: scope toggles, gap, lock, delete */}
          <div className="scenario-legend-canvas-view-actions">
            <button
              className={`scenario-legend-canvas-view-action-btn${view.applyScenarios === false ? ' scope-off' : ''}`}
              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:toggleCanvasViewScope', { detail: { viewId: view.id, scope: 'applyScenarios' } })); }}
              title="Update scenarios"
            >
              <LayersIcon size={13} />
            </button>
            <button
              className={`scenario-legend-canvas-view-action-btn${view.applyLayout === false ? ' scope-off' : ''}`}
              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:toggleCanvasViewScope', { detail: { viewId: view.id, scope: 'applyLayout' } })); }}
              title="Update layout"
            >
              <LayoutPanelLeft size={13} />
            </button>
            <button
              className={`scenario-legend-canvas-view-action-btn${view.applyDisplayMode === false ? ' scope-off' : ''}`}
              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:toggleCanvasViewScope', { detail: { viewId: view.id, scope: 'applyDisplayMode' } })); }}
              title="Update display mode"
            >
              <Monitor size={13} />
            </button>
            <span className="scenario-legend-canvas-view-actions-gap" />
            <button
              className="scenario-legend-canvas-view-action-btn"
              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:toggleCanvasViewLocked', { detail: { viewId: view.id } })); }}
              title={view.locked ? 'Unlock view' : 'Lock view'}
            >
              {view.locked ? <LockKeyhole size={13} /> : <LockOpen size={13} />}
            </button>
            <button
              className="scenario-legend-canvas-view-action-btn delete"
              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:deleteCanvasView', { detail: { viewId: view.id } })); }}
              title="Delete view"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
        );
      })}

      {/* Floating ghost — portalled to document.body so no stacking context can clip it */}
      {drag && createPortal(
        <div
          className="scenario-legend-view-pill scenario-legend-canvas-view-item view-ghost"
          style={{
            position: 'fixed',
            left: drag.x - drag.ox,
            top: drag.y - drag.oy,
            width: drag.rect.width,
            height: drag.rect.height,
            margin: 0,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          <span className="scenario-legend-canvas-view-btn">
            {views[drag.fromIdx]?.locked ? <LockKeyhole size={16} /> : <LockOpen size={16} />}
            {views[drag.fromIdx]?.name}
          </span>
        </div>,
        document.body,
      )}

      <button
        className="scenario-legend-view-pill"
        style={{ transitionDelay: delay() }}
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('dagnet:createCanvasView', { detail: { name: `View ${views.length + 1}` } }));
        }}
      >
        <Plus size={14} />
        New view
      </button>

      <div className="scenario-legend-submenu-divider" style={{ transitionDelay: delay() }} />

      <button
        className="scenario-legend-view-pill"
        style={{ transitionDelay: delay() }}
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('dagnet:restoreAll', { detail: { clearView: true } }));
        }}
      >
        <Maximize2 size={14} />
        Expand all
      </button>
      <button
        className="scenario-legend-view-pill"
        style={{ transitionDelay: delay() }}
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('dagnet:minimiseAll', { detail: { clearView: true } }));
        }}
      >
        <Minimize2 size={14} />
        Shrink all
      </button>
    </>
  );
}

