/**
 * ScenarioLegend
 * 
 * Floating legend showing all scenarios with visibility toggles and delete buttons.
 * Positioned below the window panel on the graph canvas.
 * 
 * Now rendered INSIDE the canvas panel content, so it naturally uses the canvas width
 * without needing complex JavaScript width calculations.
 */

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { Scenario } from '../types/scenarios';
import { Eye, EyeOff, Images, Image, Square, X, Plus, Minimize2, Maximize2, Check, Trash2, LayoutTemplate, LockKeyhole, LockOpen, Layers as LayersIcon, LayoutPanelLeft, Monitor, type LucideIcon } from 'lucide-react';
import type { ScenarioVisibilityMode, ViewOverlayMode, CanvasView } from '../types';
import toast from 'react-hot-toast';
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
}: ScenarioLegendProps) {
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  
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
      {/* Order chips from bottom of stack (left) to top of stack (right) */}
      {/* Bottom: Original -> User Scenarios (reverse order) -> Current (top) */}
      
      {/* 1. Base - bottom of stack, leftmost */}
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
        .map(scenario => {
        const isVisible = visibleScenarioIds.includes(scenario.id);
        const colour = getScenarioColour(scenario.id, isVisible);
        
        return (
          <div
            key={scenario.id}
            className={`scenario-legend-chip ${!isVisible ? 'invisible' : ''} ${deletingIds.includes(scenario.id) ? 'deleting' : ''}`}
            style={{
              ...getChipStyle(scenario.id, colour),
              opacity: isVisible ? 1 : 0.3
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Focus scenarios panel (same pattern as properties panel)
              window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
            }}
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
      
      {/* Active view mode pills — shown for each active mode */}
      {viewModes.filter(m => m.isActive()).map(mode => {
        const ModeIcon = mode.icon;
        const hasSubmenu = mode.activeSubmenu && mode.activeSubmenu.length > 0;
        return (
        <div key={mode.id} className={`scenario-legend-new-wrapper${hasSubmenu ? '' : ' scenario-legend-no-submenu'}`}>
          <div className="scenario-legend-chip scenario-legend-mode-pill">
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
                  style={{ transitionDelay: `${(i + 1) * 0.03 + 0.03}s` }}
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

      {/* Active canvas view pill — inline-editable name + dismiss */}
      {activeCanvasViewId && (() => {
        const activeView = canvasViews.find(v => v.id === activeCanvasViewId);
        if (!activeView) return null;
        return (
          <CanvasViewPill
            key={activeView.id}
            view={activeView}
            allViews={canvasViews}
            cycleMs={dashboardCycleMs}
            onDeactivate={() => window.dispatchEvent(new Event('dagnet:deactivateCanvasView'))}
            onRename={(name) => window.dispatchEvent(new CustomEvent('dagnet:renameCanvasView', { detail: { viewId: activeView.id, name } }))}
          />
        );
      })()}

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
              const delay = () => `${(idx++) * 0.03 + 0.03}s`;
              return (
                <>
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

                  <CanvasViewSubmenuItems views={canvasViews} activeViewId={activeCanvasViewId} startIndex={idx} onIndex={() => idx++} />
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
function CanvasViewPill({ view, allViews, cycleMs, onDeactivate, onRename }: {
  view: CanvasView;
  allViews: CanvasView[];
  cycleMs?: number | null;
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
      <div className="scenario-legend-chip scenario-legend-mode-pill scenario-legend-canvas-view-pill" style={{ position: 'relative', overflow: 'hidden' }}>
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

/** Shared canvas view items for hover submenus (used in both main dropdown and pill dropdown). */
function CanvasViewSubmenuItems({ views, activeViewId, startIndex = 0, onIndex }: {
  views: CanvasView[];
  activeViewId?: string | null;
  startIndex?: number;
  onIndex?: () => void;
}) {
  let idx = startIndex;
  const delay = () => {
    const d = `${(idx++) * 0.03 + 0.03}s`;
    onIndex?.();
    return d;
  };

  return (
    <>
      <div className="scenario-legend-submenu-divider" style={{ transitionDelay: delay() }} />

      {views.map(view => (
        <div
          key={view.id}
          className={`scenario-legend-view-pill scenario-legend-canvas-view-item ${view.id === activeViewId ? 'active' : ''}`}
          style={{ transitionDelay: delay() }}
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
      ))}

      <button
        className="scenario-legend-view-pill scenario-legend-canvas-view-item"
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
        className="scenario-legend-view-pill scenario-legend-canvas-view-item"
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
        className="scenario-legend-view-pill scenario-legend-canvas-view-item"
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

