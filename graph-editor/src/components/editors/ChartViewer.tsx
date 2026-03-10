import React, { useState, useCallback, useMemo } from 'react';

import type { EditorProps } from '../../types';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import { useFileState } from '../../contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { ChartSettingsSection } from '../panels/ChartSettingsSection';
import CollapsibleSection from '../CollapsibleSection';
import { ScenarioLayerList } from '../panels/ScenarioLayerList';
import { AnalysisTypeSection } from '../panels/AnalysisTypeSection';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { useElementSize } from '../../hooks/useElementSize';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Download, Eye, EyeOff, Table, RefreshCw, Link2, Pin, Unlink2, Settings, FileText } from 'lucide-react';
import { refreshChartByFileId } from '../../services/chartRefreshService';
import { chartOperationsService } from '../../services/chartOperationsService';
import { useAutoUpdateCharts } from '../../hooks/useAutoUpdateCharts';
import { chartDepsSignatureV1 } from '../../lib/chartDeps';
import { dslDependsOnReferenceDay } from '../../lib/dslDynamics';
import { ukReferenceDayService } from '../../services/ukReferenceDayService';
import { getScenarioVisibilityOverlayStyle } from '../../lib/scenarioVisibilityModeStyles';
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
    view_mode?: 'chart' | 'cards';
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
    view_mode: (def?.view_mode || 'chart') as 'chart' | 'cards',
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

  const [showChart, setShowChart] = useState(true);
  const [showResults, setShowResults] = useState(false);
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

  const handleDisplayChange = useCallback((key: string, value: any) => {
    void updateChartFile((d) => {
      if (!d.definition) d.definition = {};
      if (!d.definition.display) d.definition.display = {};
      d.definition.display[key] = value;
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
      }, { recompute: true }),
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

  // Resolve available analyses from parent graph
  const visibleScenarioCount = scenarioLayerItems.filter(i => i.visible).length || 1;
  React.useEffect(() => {
    if (!parentGraph || !showSettings) return;
    resolveAnalysisType(parentGraph, analyticsDsl || undefined, visibleScenarioCount)
      .then(({ availableAnalyses: resolved }) => setAvailableAnalyses(resolved));
  }, [parentGraph, analyticsDsl, visibleScenarioCount, showSettings]);

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
      <div style={{ padding: 12, paddingBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{chartDef.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{chart.created_at_uk}</div>
          <div style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, border: '1px solid var(--border-primary)', background: 'var(--bg-primary)', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {isLinked ? <><Link2 size={12} /> Linked</> : <><Pin size={12} /> Pinned</>}
          </div>
          {!autoUpdatePolicy.enabled && isStale ? (
            <div style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, border: '1px solid var(--color-warning)', background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>
              Stale
            </div>
          ) : null}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {chart.source?.query_dsl ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 120, flex: '1 1 320px' }} title={chart.source.query_dsl}>
                {chart.source.query_dsl}
              </div>
            ) : null}
            <button
              type="button"
              className="chart-viewer-btn"
              onClick={() => {
                void refreshChartByFileId({ chartFileId: fileId });
              }}
              title="Refresh chart"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} />
                Refresh
              </span>
            </button>
            <button
              type="button"
              className="chart-viewer-btn"
              onClick={() => {
                void chartOperationsService.disconnectChart({ chartFileId: fileId });
              }}
              disabled={!isLinked}
              style={!isLinked ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              title={isLinked ? 'Disconnect (pin) this chart' : 'Already pinned'}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Unlink2 size={14} />
                Disconnect
              </span>
            </button>
            <button
              type="button"
              className={`chart-viewer-btn${showChart ? ' active' : ''}`}
              onClick={() => setShowChart(v => !v)}
              title={showChart ? 'Hide chart' : 'Show chart'}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {showChart ? <EyeOff size={14} /> : <Eye size={14} />}
                {showChart ? 'Hide chart' : 'Show chart'}
              </span>
            </button>
            <button
              type="button"
              className={`chart-viewer-btn${showResults ? ' active' : ''}`}
              onClick={() => setShowResults(v => !v)}
              title={showResults ? 'Hide results' : 'Show results'}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Table size={14} />
                {showResults ? 'Hide results' : 'Show results'}
              </span>
            </button>
            <button
              type="button"
              className="chart-viewer-btn"
              onClick={() => {
                const { filename, csv } = analysisResultToCsv(analysisResult);
                downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
              }}
              title="Download CSV"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Download size={14} />
                Download CSV
              </span>
            </button>
            <button
              type="button"
              className="chart-viewer-btn"
              onClick={() => setShowSettings(true)}
              title="Chart settings"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Settings size={14} />
                Settings
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Chart properties modal -- mirrors canvas analysis properties panel (Custom mode) */}
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

              {/* Section 2: Scenarios (Custom mode -- chart tab always owns its scenarios) */}
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

              {/* Scenario DSL edit modal */}
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

              {/* Section 3: Analysis Type */}
              <AnalysisTypeSection
                availableAnalyses={availableAnalyses}
                selectedAnalysisId={analysisType || null}
                onSelect={(typeId) => {
                  void updateChartFile((d) => {
                    const recipe = d.definition?.recipe || d.recipe;
                    if (recipe?.analysis) recipe.analysis.analysis_type = typeId;
                  }, { recompute: true });
                }}
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

              {/* Section 5: Actions */}
              <CollapsibleSection title="Actions" defaultOpen={true}>
                <div className="property-group" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 12px 8px' }}>
                  <button
                    className="property-action-button"
                    style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', border: '1px solid var(--border-primary)', borderRadius: 4, background: 'transparent' }}
                    onClick={() => { void refreshChartByFileId({ chartFileId: fileId }); setShowSettings(false); }}
                  >
                    Refresh
                  </button>
                  <button
                    className="property-action-button"
                    style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', border: '1px solid var(--border-primary)', borderRadius: 4, background: 'transparent' }}
                    onClick={() => {
                      const { filename, csv } = analysisResultToCsv(analysisResult);
                      if (csv) downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
                    }}
                  >
                    Download CSV
                  </button>
                  <button
                    className="property-action-button"
                    style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', border: '1px solid var(--border-primary)', borderRadius: 4, background: 'transparent' }}
                    disabled={!isLinked}
                    onClick={() => { void chartOperationsService.disconnectChart({ chartFileId: fileId }); }}
                  >
                    Disconnect
                  </button>
                </div>
              </CollapsibleSection>
            </div>
          </div>
        </div>
      )}

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
          {showChart && (
            <div style={{ flex: showResults ? 3 : 1, minHeight: 0, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, padding: 10 }}>
                <AnalysisChartContainer
                  result={analysisResult}
                  chartKindOverride={chartDef.chart_kind}
                  visibleScenarioIds={scenarioIds}
                  scenarioVisibilityModes={scenarioVisibilityModes}
                  scenarioMetaById={scenarioMetaById}
                  height={420}
                  fillHeight={true}
                  chartContext="tab"
                  source={chart.source}
                  scenarioDslSubtitleById={scenarioDslSubtitleById}
                  display={chartDef.display}
                  onDisplayChange={handleDisplayChange}
                />
              </div>
            </div>
          )}

          {showResults && (
            <div style={{ flex: 2, minHeight: 0, overflow: 'auto', padding: 10, borderTop: '1px solid var(--border-primary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Results</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>({analysisResult.analysis_name || 'Analysis'})</div>
              </div>
              <AnalysisResultCards result={analysisResult} scenarioDslSubtitleById={scenarioDslSubtitleById} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


