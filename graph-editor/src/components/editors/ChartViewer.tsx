import React, { useState, useCallback, useMemo } from 'react';

import type { EditorProps } from '../../types';
import type { ViewMode } from '../../types/chartRecipe';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import { useFileState } from '../../contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { AnalysisInfoCard } from '../analytics/AnalysisInfoCard';
import { AnalysisResultTable } from '../analytics/AnalysisResultTable';
import { ChartSettingsSection } from '../panels/ChartSettingsSection';
import CollapsibleSection from '../CollapsibleSection';
import { ScenarioLayerList } from '../panels/ScenarioLayerList';
import { AnalysisTypeSection } from '../panels/AnalysisTypeSection';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { useElementSize } from '../../hooks/useElementSize';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Link2, Pin, Settings, FileText, BarChart3, LayoutGrid, Table2, Download, RefreshCw } from 'lucide-react';
import { getAvailableExpressions } from '../../types/chartRecipe';
import { resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';
import { filterResultForScenarios } from '../../lib/analysisResultUtils';
import { refreshChartByFileId } from '../../services/chartRefreshService';
import { chartOperationsService } from '../../services/chartOperationsService';
import { useAutoUpdateCharts } from '../../hooks/useAutoUpdateCharts';
import { chartDepsSignatureV1 } from '../../lib/chartDeps';
import { dslDependsOnReferenceDay } from '../../lib/dslDynamics';
import { ukReferenceDayService } from '../../services/ukReferenceDayService';
import { getScenarioVisibilityOverlayStyle } from '../../lib/scenarioVisibilityModeStyles';
import { SCENARIO_PALETTE } from '../../contexts/scenarioPalette';
import { ScenarioQueryEditModal } from '../modals/ScenarioQueryEditModal';
import { resolveAnalysisType } from '../../services/analysisTypeResolutionService';
import { augmentChartKindOptionsForAnalysisType } from '../../services/chartDisplayPlanningService';
import { getDisplaySettingsForSurface } from '../../lib/analysisDisplaySettingsRegistry';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import type { AvailableAnalysis } from '../../lib/graphComputeClient';
import '../modals/Modal.css';

type ChartFileDataV1 = {
  version: '1.0.0';
  /** Inferred chart kind (funnel, bridge, etc.) — used for deps/recompute */
  chart_kind: string;
  created_at_uk: string;
  created_at_ms: number;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  /**
   * The chart definition — the ONE schema shared with CanvasAnalysis.
   * Contains: title, view_mode, chart_kind (user override), display, recipe.
   * When absent (legacy files), fields are read from top-level/recipe.
   */
  definition?: {
    title?: string;
    view_mode?: ViewMode;
    chart_kind?: string;
    display?: Record<string, unknown>;
    recipe?: {
      analysis?: { analysis_type?: string | null; query_dsl?: string | null; analytics_dsl?: string | null; what_if_dsl?: string | null };
      scenarios?: Array<{ scenario_id: string; effective_dsl?: string; name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e'; is_live?: boolean }>;
    };
  };
  /** @deprecated Legacy: use definition.title */
  title?: string;
  /** Legacy recipe (kept for backward compat + recompute service) */
  recipe?: {
    parent?: { parent_file_id?: string; parent_tab_id?: string };
    analysis?: { analysis_type?: string | null; query_dsl?: string | null; analytics_dsl?: string | null; what_if_dsl?: string | null };
    scenarios?: Array<{ scenario_id: string; effective_dsl?: string; name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e'; is_live?: boolean }>;
    display?: Record<string, unknown>;
    pinned_recompute_eligible?: boolean;
  };
  /** Legacy render block (v2 transition) */
  render?: { chart_kind?: string; view_mode?: string; display?: Record<string, unknown> };
  payload: {
    analysis_result: any;
    scenario_ids: string[];
  };
};

export function ChartViewer({ fileId }: EditorProps): JSX.Element {
  const { data } = useFileState(fileId);
  const { policy: autoUpdatePolicy } = useAutoUpdateCharts();
  const [showSettings, setShowSettings] = useState(false);

  const chart = data as ChartFileDataV1 | undefined;
  const analysisResult = chart?.payload?.analysis_result;
  const errorMessage = (chart as any)?.payload?.error_message as string | undefined;

  // Canonical chart definition. If absent (legacy file), construct from top-level fields.
  const def: any = (chart as any)?.definition || (chart ? {
    title: chart.title,
    view_mode: 'chart',
    chart_kind: chart.chart_kind,
    display: chart.recipe?.display || {},
    recipe: chart.recipe ? { analysis: chart.recipe.analysis, scenarios: chart.recipe.scenarios } : { analysis: {} },
  } : undefined);

  const chartDef = {
    title: def?.title || '',
    view_mode: (def?.view_mode || 'chart') as ViewMode,
    chart_kind: def?.chart_kind,
    display: (def?.display || {}) as Record<string, unknown>,
  };
  const defRecipe = def?.recipe;

  const allScenarioIds = (defRecipe?.scenarios || []).map((s: any) => s.scenario_id).filter(Boolean);
  const hiddenSet = useMemo(
    () => new Set<string>((chartDef.display?.hidden_scenarios || []) as string[]),
    [chartDef.display]
  );
  const scenarioIds = useMemo(
    () => allScenarioIds.filter(id => !hiddenSet.has(id)),
    [allScenarioIds, hiddenSet]
  );
  const scenarios: any[] = defRecipe?.scenarios || [];
  const scenarioDslSubtitleById = (() => {
    const m: Record<string, string> = {};
    for (const s of scenarios) {
      const dsl = typeof s?.effective_dsl === 'string' ? s.effective_dsl.trim() : '';
      if (dsl) m[s.scenario_id] = dsl;
    }
    return Object.keys(m).length ? m : undefined;
  })();

  const scenarioVisibilityModes = (() => {
    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
    for (const s of scenarios) {
      const id = String(s?.scenario_id || '');
      if (!id) continue;
      const vm = s?.visibility_mode;
      if (vm === 'f' || vm === 'e' || vm === 'f+e') m[id] = vm;
    }
    return Object.keys(m).length ? m : undefined;
  })();
  const scenarioMetaById = (() => {
    const m: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }> = {};
    for (const s of scenarios) {
      const id = String(s?.scenario_id || '');
      if (!id) continue;
      m[id] = {
        name: s?.name || id,
        colour: s?.colour,
        visibility_mode: (s?.visibility_mode as any) || 'f+e',
      };
    }
    return Object.keys(m).length ? m : undefined;
  })();

  const isLinked = Boolean(chart?.recipe?.parent?.parent_tab_id ?? chart?.source?.parent_tab_id);
  const isStale = (() => {
    if (!chart) return false;
    const stored = (chart as any)?.deps_signature as string | undefined;
    const deps = (chart as any)?.deps as any;
    if (!deps || typeof stored !== 'string' || !stored.trim()) return false;
    const recipeScenarios: any[] = Array.isArray(scenarios) ? scenarios : [];
    const hasDynamic = recipeScenarios.some(s => dslDependsOnReferenceDay(s?.effective_dsl));
    const currentStamp = { ...deps, reference_day_uk: hasDynamic ? ukReferenceDayService.getReferenceDayUK() : undefined };
    const currentSig = chartDepsSignatureV1(currentStamp);
    return currentSig !== stored;
  })();

  const effectiveChartKind = chartDef.chart_kind || analysisResult?.semantics?.chart?.recommended || undefined;
  const chartKindOptions: string[] = (() => {
    const spec: any = analysisResult?.semantics?.chart;
    const rec = spec?.recommended;
    const alts = Array.isArray(spec?.alternatives) ? spec.alternatives : [];
    return augmentChartKindOptionsForAnalysisType(
      analysisResult?.analysis_type,
      [rec, ...alts].filter(Boolean) as string[],
    );
  })();

  const updateChartFile = useCallback(async (
    mutator: (d: any) => void,
    opts?: { recompute?: boolean },
  ) => {
    // Always read the LATEST data from FileRegistry, not stale closure `data`
    const current = fileRegistry.getFile(fileId)?.data || data;
    if (!current) return;
    const next = structuredClone(current) as any;
    mutator(next);
    await fileRegistry.updateFile(fileId, next);
    if (opts?.recompute) {
      void refreshChartByFileId({ chartFileId: fileId });
    }
  }, [data, fileId]);

  // Primary expression — driven by definition.view_mode, falls back to 'chart'.
  const [viewMode, setViewMode] = useState<ViewMode>(chartDef.view_mode);
  // Sync when chartDef.view_mode changes externally (e.g. settings modal).
  React.useEffect(() => { setViewMode(chartDef.view_mode); }, [chartDef.view_mode]);
  const availableExpressions = useMemo(() => getAvailableExpressions(analysisResult), [analysisResult]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    void updateChartFile((d) => {
      if (!d.definition) d.definition = {};
      d.definition.view_mode = mode;
    });
  }, [updateChartFile]);

  // Filtered result for cards/table: only visible scenarios, patched metadata
  const expressionResult = useMemo(
    () => filterResultForScenarios(analysisResult, scenarioIds, scenarioMetaById),
    [analysisResult, scenarioIds, scenarioMetaById],
  );

  const handleDisplayChange = useCallback((keyOrBatch: string | Record<string, any>, value?: any) => {
    void updateChartFile((d) => {
      if (!d.definition) d.definition = {};
      if (!d.definition.display) d.definition.display = {};
      if (typeof keyOrBatch === 'object') {
        Object.assign(d.definition.display, keyOrBatch);
      } else {
        d.definition.display[keyOrBatch] = value;
      }
    });
  }, [updateChartFile]);

  const handleClearAllDisplayOverrides = useCallback(() => {
    void updateChartFile((d) => {
      const disp = d.definition?.display;
      if (!disp) return;
      const settingsList = getDisplaySettingsForSurface(effectiveChartKind, chartDef.view_mode, 'propsPanel');
      for (const s of settingsList) {
        if ((s as any).overridable && s.key in disp) delete disp[s.key];
      }
    });
  }, [updateChartFile, effectiveChartKind, chartDef.view_mode]);

  const handleChartKindChange = useCallback((kind: string | undefined) => {
    void updateChartFile((d) => {
      if (!d.definition) d.definition = {};
      d.definition.chart_kind = kind;
    });
  }, [updateChartFile]);

  const handleAnalysisTypeChange = useCallback((typeId: string) => {
    void updateChartFile((d) => {
      const recipe = d.definition?.recipe || d.recipe;
      if (recipe?.analysis) recipe.analysis.analysis_type = typeId;
    }, { recompute: true });
  }, [updateChartFile]);

  const analyticsDsl = defRecipe?.analysis?.analytics_dsl || defRecipe?.analysis?.query_dsl || '';
  const analysisType = defRecipe?.analysis?.analysis_type || '';

  const scenarioLayerItems = useMemo((): ScenarioLayerItem[] => {
    return scenarios.map((s: any) => ({
      id: s.scenario_id,
      name: s.name || s.scenario_id,
      colour: s.colour || '#808080',
      visible: !hiddenSet.has(s.scenario_id),
      visibilityMode: (s.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
      kind: 'user' as const,
      tooltip: s.effective_dsl,
    }));
  }, [scenarios, hiddenSet]);

  const getSwatchOverlayStyle = useCallback((id: string) => {
    const item = scenarioLayerItems.find((entry) => entry.id === id);
    return getScenarioVisibilityOverlayStyle(item?.visibilityMode);
  }, [scenarioLayerItems]);

  const handleAddScenario = useCallback(() => {
    void updateChartFile((d) => {
      const recipe = d.definition?.recipe || d.recipe;
      if (!recipe) return;
      if (!recipe.scenarios) recipe.scenarios = [];
      const usedColours = new Set(recipe.scenarios.map((s: any) => s.colour));
      const colour = SCENARIO_PALETTE.find(c => !usedColours.has(c)) || SCENARIO_PALETTE[recipe.scenarios.length % SCENARIO_PALETTE.length];
      const id = `scenario_${Date.now()}`;
      const name = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      recipe.scenarios.push({ scenario_id: id, name, colour, effective_dsl: '', visibility_mode: 'f+e' });
    }, { recompute: true });
  }, [updateChartFile]);

  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);

  const scenarioCallbacks = useMemo(() => {
    const getRecipeScenarios = (d: any): any[] => (d.definition?.recipe || d.recipe)?.scenarios || [];
    const getDisplay = (d: any): any => {
      if (!d.definition) d.definition = {};
      if (!d.definition.display) d.definition.display = {};
      return d.definition.display;
    };
    return {
      onRename: (id: string, name: string) => updateChartFile((d) => {
        const s = getRecipeScenarios(d).find((s: any) => s.scenario_id === id);
        if (s) s.name = name;
      }),
      onColourChange: (id: string, colour: string) => updateChartFile((d) => {
        const s = getRecipeScenarios(d).find((s: any) => s.scenario_id === id);
        if (s) s.colour = colour;
      }),
      onDelete: (id: string) => void updateChartFile((d) => {
        const recipe = d.definition?.recipe || d.recipe;
        if (recipe?.scenarios) recipe.scenarios = recipe.scenarios.filter((s: any) => s.scenario_id !== id);
        const disp = getDisplay(d);
        if (Array.isArray(disp.hidden_scenarios)) {
          disp.hidden_scenarios = disp.hidden_scenarios.filter((h: string) => h !== id);
        }
      }, { recompute: true }),
      onToggleVisibility: (id: string) => void updateChartFile((d) => {
        const disp = getDisplay(d);
        const hidden: string[] = Array.isArray(disp.hidden_scenarios) ? [...disp.hidden_scenarios] : [];
        if (hidden.includes(id)) {
          disp.hidden_scenarios = hidden.filter((h: string) => h !== id);
        } else {
          disp.hidden_scenarios = [...hidden, id];
        }
      }),
      onCycleMode: (id: string) => void updateChartFile((d) => {
        const s = getRecipeScenarios(d).find((s: any) => s.scenario_id === id);
        if (s) s.visibility_mode = s.visibility_mode === 'f+e' ? 'f' : s.visibility_mode === 'f' ? 'e' : 'f+e';
      }, { recompute: true }),
      onReorder: (fromIndex: number, toIndex: number) => void updateChartFile((d) => {
        const recipe = d.definition?.recipe || d.recipe;
        if (!recipe?.scenarios) return;
        const arr = [...recipe.scenarios];
        const [moved] = arr.splice(fromIndex, 1);
        arr.splice(toIndex, 0, moved);
        recipe.scenarios = arr;
      }, { recompute: true }),
      onEdit: (id: string) => setEditingScenarioId(id),
      getEditTooltip: () => 'Edit scenario DSL',
    };
  }, [updateChartFile]);

  const editingScenario = editingScenarioId
    ? scenarios.find((s: any) => s.scenario_id === editingScenarioId)
    : null;

  const [availableAnalyses, setAvailableAnalyses] = useState<AvailableAnalysis[]>([]);

  // Load parent graph for analysis type resolution and QueryExpressionEditor autocomplete
  const [parentGraph, setParentGraph] = useState<any>(null);
  const parentFileId = chart?.recipe?.parent?.parent_file_id || chart?.source?.parent_file_id;
  React.useEffect(() => {
    if (!parentFileId) return;
    const file = fileRegistry.getFile(parentFileId);
    if (file?.data) { setParentGraph(file.data); return; }
    db.files.get(parentFileId).then((f: any) => { if (f?.data) setParentGraph(f.data); });
  }, [parentFileId]);

  // Resolve available analyses from parent graph (eagerly, for toolbar dropdown)
  const visibleScenarioCount = scenarioLayerItems.filter(i => i.visible).length || 1;
  React.useEffect(() => {
    if (!parentGraph) return;
    resolveAnalysisType(parentGraph, analyticsDsl || undefined, visibleScenarioCount)
      .then(({ availableAnalyses: resolved }) => setAvailableAnalyses(resolved));
  }, [parentGraph, analyticsDsl, visibleScenarioCount]);

  // Auto-switch analysis type when the current one becomes unavailable
  // (e.g. bridge requires 2 visible scenarios — hiding one invalidates it).
  // Tracks what we switched away from so we can restore when it becomes valid again.
  const autoSwitchRef = React.useRef<{ from: string; to: string } | null>(null);
  React.useEffect(() => {
    if (!availableAnalyses.length || !analysisType) return;

    // If user manually changed the type after an auto-switch, clear the restore state
    if (autoSwitchRef.current && analysisType !== autoSwitchRef.current.to) {
      autoSwitchRef.current = null;
    }

    const stillValid = availableAnalyses.some(a => a.id === analysisType);

    if (stillValid) {
      // Restore the original type if it's available again (e.g. re-showing a hidden scenario)
      if (autoSwitchRef.current) {
        const canRestore = availableAnalyses.some(a => a.id === autoSwitchRef.current!.from);
        if (canRestore) {
          const restoreId = autoSwitchRef.current.from;
          autoSwitchRef.current = null;
          handleAnalysisTypeChange(restoreId);
        }
      }
      return;
    }

    // Current type no longer valid — auto-switch to primary
    const primary = availableAnalyses.find(a => a.is_primary) || availableAnalyses[0];
    if (primary) {
      autoSwitchRef.current = { from: analysisType, to: primary.id };
      handleAnalysisTypeChange(primary.id);
    }
  }, [availableAnalyses, analysisType, handleAnalysisTypeChange]);

  // IMPORTANT: measure a container whose height is driven by the tab viewport (fixed),
  // not by the content we render inside it. Measuring a content-sized element can create
  // a ResizeObserver feedback loop (infinite growth / rerender).
  const { ref: viewportRef } = useElementSize<HTMLDivElement>();

  if (!chart || !analysisResult) {
    return (
      <div style={{ padding: 12, color: 'var(--text-secondary)' }}>
        {typeof errorMessage === 'string' && errorMessage.trim() ? (
          <>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Chart failed to load</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{errorMessage}</div>
          </>
        ) : (
          'No chart data.'
        )}
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className="chart-viewer"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-secondary)',
      }}
    >
      {/* Minimal header: title, metadata badges, view toggles, settings */}
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{chartDef.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{chart.created_at_uk}</div>
        <div style={{ fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border-primary)', background: 'var(--bg-primary)', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {isLinked ? <><Link2 size={11} /> Linked</> : <><Pin size={11} /> Pinned</>}
        </div>
        {analyticsDsl && (
          <div style={{ fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border-primary)', background: 'var(--bg-primary)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }} title={analyticsDsl}>
            {analyticsDsl}
          </div>
        )}
        {!autoUpdatePolicy.enabled && isStale ? (
          <div style={{ fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--color-warning)', background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>
            Stale
          </div>
        ) : null}
        {/* Refresh: manual recompute for pinned charts */}
        <button
          type="button"
          className="chart-viewer-btn"
          onClick={() => refreshChartByFileId({ chartFileId: fileId })}
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
        <span style={{ flex: 1 }} />
        {/* View mode switcher */}
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {availableExpressions.map(mode => {
            const Icon = mode === 'chart' ? BarChart3 : mode === 'cards' ? LayoutGrid : Table2;
            const label = mode === 'chart' ? 'Chart' : mode === 'cards' ? 'Cards' : 'Table';
            return (
              <button
                key={mode}
                type="button"
                className={`chart-viewer-btn${mode === viewMode ? ' active' : ''}`}
                onClick={() => handleViewModeChange(mode)}
                title={label}
              >
                <Icon size={13} />
              </button>
            );
          })}
        </span>
        {/* Download CSV */}
        <button
          type="button"
          className="chart-viewer-btn"
          onClick={() => {
            const { filename, csv } = analysisResultToCsv(analysisResult);
            downloadTextFile({ content: csv, filename, mimeType: 'text/csv' });
          }}
          title="Download CSV"
        >
          <Download size={13} />
        </button>
        <button
          type="button"
          className="chart-viewer-btn"
          onClick={() => setShowSettings(true)}
          title="Advanced settings"
        >
          <Settings size={13} />
        </button>
      </div>

      {/* Advanced settings modal (DSL editing, scenario management, analysis type) */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-container" style={{ maxWidth: 520, maxHeight: '85vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Chart Properties</h3>
              <button className="modal-close" onClick={() => setShowSettings(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              {/* Parent graph link */}
              {parentFileId && (
                <div style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--border-primary)',
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, color: 'var(--text-secondary)',
                }}>
                  <FileText size={14} style={{ flexShrink: 0 }} />
                  <span>Graph:</span>
                  {chart?.recipe?.parent?.parent_tab_id ? (
                    <button
                      type="button"
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', {
                          detail: { tabId: chart.recipe?.parent?.parent_tab_id },
                        }));
                        setShowSettings(false);
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                        color: 'var(--accent-primary, #3b82f6)', textDecoration: 'underline',
                        fontSize: 12, fontWeight: 500,
                      }}
                    >
                      {parentGraph?.metadata?.name || parentFileId}
                    </button>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {parentGraph?.metadata?.name || parentFileId}
                    </span>
                  )}
                </div>
              )}

              {/* Section 1: Selection & Query */}
              <CollapsibleSection
                title={analyticsDsl
                  ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Selection & Query <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{analyticsDsl}</span></span>
                  : "Selection & Query"}
                defaultOpen={!analyticsDsl}
              >
                <div className="property-group" style={{ padding: '4px 12px 8px' }}>
                  <QueryExpressionEditor
                    value={analyticsDsl}
                    onChange={(newValue) => {
                      void updateChartFile((d) => {
                        const recipe = d.definition?.recipe || d.recipe;
                        if (recipe?.analysis) recipe.analysis.analytics_dsl = newValue || undefined;
                      }, { recompute: true });
                    }}
                    graph={parentGraph}
                    placeholder="from(node).to(node)"
                    height="40px"
                  />
                </div>
              </CollapsibleSection>

              {/* Section 2: Scenarios */}
              <CollapsibleSection title="Scenarios" defaultOpen={scenarioLayerItems.length > 0}>
                <div className="property-group" style={{ padding: '4px 12px 8px' }}>
                  {scenarioLayerItems.length > 0 ? (
                    <ScenarioLayerList
                      items={scenarioLayerItems}
                      containerClassName=""
                      allowRenameAll={true}
                      getSwatchOverlayStyle={getSwatchOverlayStyle}
                      {...scenarioCallbacks}
                    />
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>No scenarios captured</div>
                  )}
                </div>
              </CollapsibleSection>

              {/* Section 3: Analysis Type */}
              <AnalysisTypeSection
                availableAnalyses={availableAnalyses}
                selectedAnalysisId={analysisType || null}
                onSelect={handleAnalysisTypeChange}
                defaultOpen={false}
              />

              {/* Section 4: Chart Settings */}
              <ChartSettingsSection
                title={chartDef.title}
                onTitleChange={(title) => {
                  void updateChartFile((d) => {
                    if (d.definition) d.definition.title = title;
                    else d.title = title;
                  });
                }}
                viewMode={chartDef.view_mode}
                onViewModeChange={(mode) => {
                  void updateChartFile((d) => {
                    if (!d.definition) d.definition = {};
                    d.definition.view_mode = mode;
                  });
                }}
                chartKind={chartDef.chart_kind}
                effectiveChartKind={effectiveChartKind}
                onChartKindChange={(kind) => {
                  void updateChartFile((d) => {
                    if (!d.definition) d.definition = {};
                    d.definition.chart_kind = kind;
                  });
                }}
                chartKindOptions={chartKindOptions}
                display={chartDef.display}
                onDisplayChange={handleDisplayChange}
                onClearAllOverrides={handleClearAllDisplayOverrides}
              />
            </div>
          </div>
        </div>
      )}

      {/* Scenario DSL edit modal (top-level so it works from both toolbar popover and settings modal) */}
      {editingScenarioId && editingScenario && (
        <ScenarioQueryEditModal
          isOpen={true}
          scenarioName={editingScenario.name || editingScenarioId}
          currentDSL={editingScenario.effective_dsl || ''}
          inheritedDSL={analyticsDsl}
          onSave={(newDSL) => {
            void updateChartFile((d) => {
              const recipe = d.definition?.recipe || d.recipe;
              const s = recipe?.scenarios?.find((s: any) => s.scenario_id === editingScenarioId);
              if (s) s.effective_dsl = newDSL;
            }, { recompute: true });
            setEditingScenarioId(null);
          }}
          onClose={() => setEditingScenarioId(null)}
        />
      )}

      {/* Chart + results area */}
      <div style={{ flex: 1, minHeight: 0, padding: '0 12px 12px 12px', position: 'relative' }}>
        <div
          className="chart-viewer-content"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 10,
            position: 'absolute',
            inset: '0 12px 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* All view modes go through AnalysisChartContainer — ONE CODEPATH for toolbar */}
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <AnalysisChartContainer
                result={analysisResult}
                chartKindOverride={chartDef.chart_kind}
                visibleScenarioIds={scenarioIds}
                scenarioVisibilityModes={scenarioVisibilityModes}
                scenarioMetaById={scenarioMetaById}
                scenarioDslSubtitleById={scenarioDslSubtitleById}
                fillHeight
                chartContext="tab"
                source={chart.source}
                display={chartDef.display}
                onDisplayChange={handleDisplayChange}
                onChartKindChange={handleChartKindChange}
                analysisTypeId={analysisType || undefined}
                availableAnalyses={availableAnalyses}
                onAnalysisTypeChange={handleAnalysisTypeChange}
                scenarioLayerItems={scenarioLayerItems}
                onScenarioToggleVisibility={scenarioCallbacks.onToggleVisibility}
                onScenarioCycleMode={scenarioCallbacks.onCycleMode}
                onScenarioColourChange={scenarioCallbacks.onColourChange}
                onScenarioReorder={scenarioCallbacks.onReorder}
                onScenarioDelete={scenarioCallbacks.onDelete}
                onScenarioEdit={scenarioCallbacks.onEdit}
                getScenarioEditTooltip={scenarioCallbacks.getEditTooltip}
                getScenarioSwatchOverlayStyle={getSwatchOverlayStyle}
                onAddScenario={handleAddScenario}
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
              >
                {viewMode === 'cards' ? (
                  <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
                    {chartDef.chart_kind && analysisResult ? (
                      <AnalysisInfoCard
                        result={analysisResult}
                        kind={chartDef.chart_kind}
                        fontSize={resolveDisplaySetting(chartDef.display, { key: 'font_size', defaultValue: undefined } as any)}
                      />
                    ) : (
                      <AnalysisResultCards
                        result={expressionResult!}
                        scenarioDslSubtitleById={scenarioDslSubtitleById}
                        collapsedCards={resolveDisplaySetting(chartDef.display, { key: 'cards_collapsed', defaultValue: [] } as any)}
                        onCollapsedCardsChange={(collapsed) => handleDisplayChange('cards_collapsed', collapsed)}
                      />
                    )}
                  </div>
                ) : viewMode === 'table' ? (
                  <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
                    <AnalysisResultTable
                      result={expressionResult!}
                      fontSize={resolveDisplaySetting(chartDef.display, { key: 'font_size', defaultValue: 'M' } as any)}
                      striped={resolveDisplaySetting(chartDef.display, { key: 'table_striped', defaultValue: true } as any)}
                      sortColumn={resolveDisplaySetting(chartDef.display, { key: 'table_sort_column', defaultValue: undefined } as any)}
                      sortDirection={resolveDisplaySetting(chartDef.display, { key: 'table_sort_direction', defaultValue: 'asc' } as any)}
                      onSortChange={(col, dir) => {
                        handleDisplayChange('table_sort_column', col);
                        handleDisplayChange('table_sort_direction', dir);
                      }}
                      hiddenColumns={resolveDisplaySetting(chartDef.display, { key: 'table_hidden_columns', defaultValue: [] } as any)}
                      onHiddenColumnsChange={(hidden) => handleDisplayChange('table_hidden_columns', hidden)}
                      columnOrder={resolveDisplaySetting(chartDef.display, { key: 'table_column_order', defaultValue: [] } as any)}
                      onColumnOrderChange={(order) => handleDisplayChange('table_column_order', order)}
                      columnWidths={resolveDisplaySetting(chartDef.display, { key: 'table_column_widths', defaultValue: '' } as any)}
                      onColumnWidthsChange={(widths) => handleDisplayChange('table_column_widths', widths)}
                    />
                  </div>
                ) : undefined}
              </AnalysisChartContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
