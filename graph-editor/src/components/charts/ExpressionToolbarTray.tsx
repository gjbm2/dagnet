/**
 * ExpressionToolbarTray — shared floating toolbar tray for ALL canvas analysis view types.
 *
 * Provides (all optional — callers pass what they need):
 *  - Analysis type palette
 *  - View mode switcher (chart / cards / table pills)
 *  - Kind picker (chart kind / card kind)
 *  - Display settings from the registry
 *  - Connector overlay toggle + colour
 *  - Scenario mode/layer controls
 *  - Actions (refresh, open as tab, download CSV, debug dump, delete)
 *
 * Used by:
 *  - CanvasAnalysisNode: cards view, expression view, and chart view (via AnalysisChartContainer)
 *  - AnalyticsPanel: sidebar chart display
 */

import React, { useRef, useState } from 'react';
import { BarChart3, LayoutGrid, Table2, Download, Trash2, ExternalLink, ClipboardCopy, MoreHorizontal, Settings, ChevronDown, Crosshair, Layers, Plus, RefreshCcw, Code } from 'lucide-react';
import type { ViewMode } from '../../types/chartRecipe';
import { getAvailableExpressions } from '../../types/chartRecipe';
import { getDisplaySettingsForSurface } from '../../lib/analysisDisplaySettingsRegistry';
import { getKindsForView, getAvailableViewTypes } from '../panels/analysisTypes';
import { ANALYSIS_TYPES, getAnalysisTypeMeta } from '../panels/analysisTypes';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import type { AnalysisResult, AvailableAnalysis } from '../../lib/graphComputeClient';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import { ScenarioLayerList } from '../panels/ScenarioLayerList';
import { ModeTrack } from '../ModeTrack';
import { OVERLAY_PRESET_COLOURS } from '../ColourSelector';
import { renderTraySettings } from './settingPillRenderer';
import { CfpPopover } from './CfpPopover';
import { QueryExpressionEditor } from '../QueryExpressionEditor';

const VIEW_MODE_META: Record<ViewMode, { icon: React.ComponentType<{ size?: number | string }>; label: string }> = {
  chart: { icon: BarChart3, label: 'Chart' },
  cards: { icon: LayoutGrid, label: 'Cards' },
  table: { icon: Table2, label: 'Table' },
};

export interface ExpressionToolbarTrayProps {
  viewMode: ViewMode;
  result: AnalysisResult | null;
  display?: Record<string, unknown>;
  onViewModeChange?: (mode: ViewMode) => void;
  onDisplayChange?: (keyOrBatch: string | Record<string, any>, value?: any) => void;
  onOpenAsTab?: () => void;
  onDumpDebug?: () => void;
  onDelete?: () => void;
  /** Analysis type palette */
  analysisTypeId?: string;
  availableAnalyses?: AvailableAnalysis[];
  onAnalysisTypeChange?: (typeId: string) => void;
  /** Kind picker */
  kind?: string;
  onKindChange?: (kind: string | undefined) => void;
  /** Override kind options (e.g. from result semantics for chart view). If not set, uses registry. */
  availableKinds?: { id: string; name: string }[];
  /** Connector overlay */
  overlayActive?: boolean;
  overlayColour?: string;
  onOverlayToggle?: (active: boolean) => void;
  onOverlayColourChange?: (colour: string | null) => void;
  /** Scenario mode + layer controls */
  analysisMode?: string;
  onModeCycle?: () => void;
  scenarioLayerItems?: ScenarioLayerItem[];
  onScenarioToggleVisibility?: (id: string) => void;
  onScenarioCycleMode?: (id: string) => void;
  onScenarioColourChange?: (id: string, colour: string) => void;
  onScenarioReorder?: (fromIndex: number, toIndex: number) => void;
  onScenarioDelete?: (id: string) => void;
  onScenarioEdit?: (id: string) => void;
  onAddScenario?: () => void;
  getScenarioEditTooltip?: (id: string) => string;
  getScenarioSwatchOverlayStyle?: (id: string) => React.CSSProperties | null;
  /** Refresh */
  analysisId?: string;
  /** Wide mode (inline pills) vs narrow (popovers) */
  wideToolbar?: boolean;
  /** Subject selector (e.g. daily_conversions with multiple subject_ids) */
  subjectIds?: string[];
  effectiveSubjectId?: string;
  subjectMeta?: Record<string, { name?: string }>;
  onSubjectChange?: (subjectId: string) => void;
  /** DSL editor */
  queryDsl?: string;
  onDslChange?: (dsl: string) => void;
  graph?: any;
}

export const ExpressionToolbarTray = React.memo(function ExpressionToolbarTray({
  viewMode,
  result,
  display,
  onViewModeChange,
  onDisplayChange,
  onOpenAsTab,
  onDumpDebug,
  onDelete,
  analysisTypeId,
  availableAnalyses,
  onAnalysisTypeChange,
  kind,
  onKindChange,
  availableKinds,
  overlayActive,
  overlayColour,
  onOverlayToggle,
  onOverlayColourChange,
  analysisMode,
  onModeCycle,
  scenarioLayerItems,
  onScenarioToggleVisibility,
  onScenarioCycleMode,
  onScenarioColourChange,
  onScenarioReorder,
  onScenarioDelete,
  onScenarioEdit,
  onAddScenario,
  getScenarioEditTooltip,
  getScenarioSwatchOverlayStyle,
  analysisId,
  wideToolbar = false,
  subjectIds,
  effectiveSubjectId,
  subjectMeta,
  onSubjectChange,
  queryDsl,
  onDslChange,
  graph,
}: ExpressionToolbarTrayProps) {
  // View types: prefer registry declaration, fall back to result-driven detection
  const registryViews = getAvailableViewTypes(analysisTypeId);
  const available = registryViews || getAvailableExpressions(result);
  const settings = getDisplaySettingsForSurface(kind, viewMode, 'inline', 'canvas');
  const overlayColourInputRef = useRef<HTMLInputElement>(null);
  const [showAllTypes, setShowAllTypes] = useState(false);

  // Kind options: override from caller (e.g. result semantics) or registry
  const kindOptions = availableKinds || (analysisTypeId ? getKindsForView(analysisTypeId, viewMode) : []);

  const showAnalysisType = !!analysisTypeId && !!onAnalysisTypeChange && (availableAnalyses?.length ?? 0) > 0;

  let needsSep = false;
  const sep = () => { if (needsSep) { needsSep = false; return <span className="cfp-sep" />; } return null; };
  const mark = () => { needsSep = true; };

  return (
    <>
      {/* 1. DSL (data subject — the primary thing) */}
      {queryDsl != null && (() => { mark(); return (
        <CfpPopover
          icon={<Code size={13} />}
          title="Query DSL"
          sticky
          popoverClassName="cfp-popover--dsl"
        >
          {graph && onDslChange ? (
            <QueryExpressionEditor
              value={queryDsl}
              onChange={() => {}}
              onBlur={onDslChange}
              graph={graph}
              height="120px"
              placeholder="from(node).to(node)"
            />
          ) : (
            <pre className="cfp-dsl-preview">{queryDsl}</pre>
          )}
        </CfpPopover>
      ); })()}

      {/* 2. Scenario mode + layers */}
      {(onModeCycle || (scenarioLayerItems && scenarioLayerItems.length > 0)) && (() => { const s = sep(); mark(); return (
        <>{s}
          <span className="cfp-pill-group">
            <span className="cfp-group-label">{onModeCycle ? 'Mode' : 'Scenarios'}</span>
            <CfpPopover
              icon={<><Layers size={13} /><ChevronDown size={9} /></>}
              title="Scenarios"
              trigger={onModeCycle
                ? <ModeTrack mode={(analysisMode || 'live') as any} onClick={onModeCycle} />
                : undefined}
            >
              <div className="cfp-scenario-popover">
                {scenarioLayerItems && scenarioLayerItems.length > 0 && (
                  <ScenarioLayerList
                    items={scenarioLayerItems}
                    containerClassName="cfp-scenario-popover__list"
                    onToggleVisibility={onScenarioToggleVisibility}
                    onCycleMode={onScenarioCycleMode}
                    onColourChange={onScenarioColourChange}
                    onReorder={onScenarioReorder}
                    onDelete={onScenarioDelete}
                    onEdit={onScenarioEdit}
                    getEditTooltip={getScenarioEditTooltip}
                    getSwatchOverlayStyle={getScenarioSwatchOverlayStyle}
                  />
                )}
                {onAddScenario && (
                  <button type="button" className="cfp-scenario-popover__add-btn" onClick={onAddScenario} title="Add a blank scenario">
                    <Plus size={12} /> Add scenario
                  </button>
                )}
              </div>
            </CfpPopover>
          </span>
        </>
      ); })()}

      {/* 3. Analysis type palette */}
      {showAnalysisType && (() => {
        const s = sep(); mark();
        const activeMeta = getAnalysisTypeMeta(analysisTypeId!);
        const ActiveIcon = activeMeta?.icon;
        return (
          <>{s}
            <CfpPopover
              icon={<>{ActiveIcon && <ActiveIcon size={13} />}<ChevronDown size={9} /></>}
              label={activeMeta?.name}
              title="Analysis type"
            >
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 4px 4px' }}>
                <button
                  type="button"
                  className="cfp-show-all-toggle"
                  onClick={() => setShowAllTypes(prev => !prev)}
                  style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--text-muted, #9ca3af)', padding: '2px 4px' }}
                >
                  {showAllTypes ? 'Available only' : 'Show all'}
                </button>
              </div>
              <div className="cfp-type-palette">
                {(() => {
                  const availableIds = new Set((availableAnalyses || []).map(a => a.id));
                  const types = showAllTypes
                    ? ANALYSIS_TYPES.filter(tm => !tm.internal).map(tm => ({ id: tm.id, meta: tm, available: availableIds.has(tm.id) }))
                    : (availableAnalyses || []).map(a => ({ id: a.id, meta: getAnalysisTypeMeta(a.id), available: true }));
                  return types.map(({ id, meta, available }) => {
                    const Icon = meta?.icon;
                    const active = id === analysisTypeId;
                    return (
                      <button key={id} type="button"
                        className={`cfp-type-palette-item${active ? ' active' : ''}${!available ? ' unavailable' : ''}`}
                        onClick={() => onAnalysisTypeChange!(id)}
                        title={meta?.shortDescription || meta?.name || id}
                      >
                        {Icon && <Icon size={22} />}
                        <span className="cfp-type-palette-label">{meta?.name || id}</span>
                      </button>
                    );
                  });
                })()}
              </div>
            </CfpPopover>
          </>
        );
      })()}

      {/* 4. View mode switcher */}
      {onViewModeChange && available.length > 1 && (() => { const s = sep(); mark(); return (
        <>{s}
          <span className="cfp-pill-group" title="View">
            <span className="cfp-group-label">View</span>
            {available.map(mode => {
              const meta = VIEW_MODE_META[mode];
              const Icon = meta.icon;
              return (
                <button key={mode} type="button"
                  className={`cfp-pill${mode === viewMode ? ' active' : ''}`}
                  onClick={() => onViewModeChange(mode)}
                  title={meta.label}
                >
                  <Icon size={13} />
                </button>
              );
            })}
          </span>
        </>
      ); })()}

      {/* 5. Kind picker */}
      {kindOptions.length > 1 && onKindChange && (() => { const s = sep(); mark(); return (
        <>{s}
          {wideToolbar ? (
            <span className="cfp-pill-group" title="Kind">
              <span className="cfp-group-label">{viewMode === 'chart' ? 'Chart' : 'Card'}</span>
              {kindOptions.map(k => (
                <button key={k.id} type="button"
                  className={`cfp-pill${k.id === kind ? ' active' : ''}`}
                  onClick={() => onKindChange(k.id)}
                  title={k.name}
                >
                  {k.name}
                </button>
              ))}
            </span>
          ) : (
            <CfpPopover
              icon={<><BarChart3 size={13} /><ChevronDown size={9} /></>}
              label={kindOptions.find(k => k.id === kind)?.name || kind || 'Kind'}
              title="Kind"
            >
              {kindOptions.map(k => (
                <button key={k.id} type="button"
                  className={`cfp-menu-item${k.id === kind ? ' active' : ''}`}
                  onClick={() => onKindChange(k.id)}
                >
                  {k.name}
                </button>
              ))}
            </CfpPopover>
          )}
        </>
      ); })()}

      {/* 6. Subject selector */}
      {subjectIds && subjectIds.length > 1 && onSubjectChange && (() => { const s = sep(); mark(); return (
        <>{s}
          <select
            value={effectiveSubjectId || ''}
            onChange={(e) => onSubjectChange(e.target.value)}
            className="cfp-select"
            aria-label="Subject"
          >
            {subjectIds.map(sid => (
              <option key={sid} value={sid}>{subjectMeta?.[sid]?.name || sid}</option>
            ))}
          </select>
        </>
      ); })()}

      {/* 7. Display settings */}
      {settings.length > 0 && onDisplayChange && (() => { const s = sep(); mark(); return (
        <>{s}
          {wideToolbar
            ? renderTraySettings(settings, display, onDisplayChange)
            : (
              <CfpPopover icon={<MoreHorizontal size={13} />} title="Display">
                {renderTraySettings(settings, display, onDisplayChange)}
              </CfpPopover>
            )
          }
        </>
      ); })()}

      {/* 8. Connector overlay */}
      {onOverlayToggle && (() => { const s = sep(); mark(); return (
        <>{s}
          <span className="cfp-pill-group">
            <button type="button"
              className={`cfp-pill${overlayActive ? ' active' : ''}`}
              style={overlayColour ? { color: overlayColour } : undefined}
              title="Toggle overlay connectors"
              onClick={() => onOverlayToggle(!overlayActive)}
            >
              <Crosshair size={13} />
            </button>
            {onOverlayColourChange && (
              <CfpPopover
                icon={<span className="cfp-menu-swatch" style={{ background: overlayColour || '#3b82f6' }} />}
                title="Overlay colour"
              >
                {OVERLAY_PRESET_COLOURS.map(p => (
                  <button key={p.value} type="button"
                    className={`cfp-menu-item${overlayColour === p.value ? ' active' : ''}`}
                    onClick={() => onOverlayColourChange(p.value)}
                  >
                    <span className="cfp-menu-swatch" style={{ background: p.value }} />
                    {p.name}
                  </button>
                ))}
                <button type="button"
                  className={`cfp-menu-item${overlayColour && !OVERLAY_PRESET_COLOURS.some(p => p.value === overlayColour) ? ' active' : ''}`}
                  onClick={() => overlayColourInputRef.current?.click()}
                >
                  <span className="cfp-menu-swatch" style={{ background: overlayColour || '#888', border: '1px dashed #9CA3AF' }} />
                  Custom...
                </button>
                <input ref={overlayColourInputRef} type="color"
                  value={overlayColour || '#3b82f6'}
                  onChange={(e) => onOverlayColourChange(e.target.value)}
                  style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                />
              </CfpPopover>
            )}
          </span>
        </>
      ); })()}

      {/* --- Actions (more...) --- */}
      <CfpPopover
        icon={<Settings size={13} />}
        title="More actions"
      >
        {analysisId && (
          <button type="button" className="cfp-menu-item"
            onClick={() => window.dispatchEvent(new CustomEvent('dagnet:canvasAnalysisRefresh', { detail: { analysisId } }))}
          >
            <RefreshCcw size={12} /> Refresh
          </button>
        )}
        {onOpenAsTab && (
          <button type="button" className="cfp-menu-item" onClick={onOpenAsTab}>
            <ExternalLink size={12} /> Open as Tab
          </button>
        )}
        {result && (
          <button type="button" className="cfp-menu-item"
            onClick={() => { const { filename, csv } = analysisResultToCsv(result); downloadTextFile({ content: csv, filename, mimeType: 'text/csv' }); }}
          >
            <Download size={12} /> Download CSV
          </button>
        )}
        {onDumpDebug && (
          <button type="button" className="cfp-menu-item" onClick={onDumpDebug}>
            <ClipboardCopy size={12} /> Dump Debug JSON
          </button>
        )}
        {onDelete && (
          <button type="button" className="cfp-menu-item cfp-menu-item--danger" onClick={onDelete}>
            <Trash2 size={12} /> Delete
          </button>
        )}
      </CfpPopover>
    </>
  );
});
