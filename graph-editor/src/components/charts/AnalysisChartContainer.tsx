import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import {
  Download, RefreshCcw, Trash2, MoreHorizontal, Sliders,
  BarChart3, Code, ExternalLink, ClipboardCopy,
  Layers, Crosshair, ChevronDown, Plus, Eye, EyeOff,
} from 'lucide-react';
import { ModeTrack } from '../ModeTrack';
import { QueryExpressionEditor } from '../QueryExpressionEditor';

import type { AnalysisResult, AvailableAnalysis } from '../../lib/graphComputeClient';
import { getDisplaySettings, getDisplaySettingsForSurface, resolveDisplaySetting, buildContextMenuSettingItems } from '../../lib/analysisDisplaySettingsRegistry';
import type { DisplaySettingDef } from '../../lib/analysisDisplaySettingsRegistry';
import { ContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import { buildChartOption } from '../../services/analysisEChartsService';
import { augmentChartKindOptionsForAnalysisType, planChartDisplay } from '../../services/chartDisplayPlanningService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { useElementSize } from '../../hooks/useElementSize';
import { getAnalysisTypeMeta, ANALYSIS_TYPES } from '../panels/analysisTypes';
import { AnalysisTypeCardList } from '../panels/AnalysisTypeCardList';
import { ScenarioLayerList } from '../panels/ScenarioLayerList';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import { ChartFloatingIcon } from './ChartInlineSettingsFloating';
import { logChartReadinessTrace } from '../../lib/snapshotBootTrace';
import type { ViewMode } from '../../types/chartRecipe';
import { getAvailableExpressions } from '../../types/chartRecipe';
import { LayoutGrid, Table2 } from 'lucide-react';
import { AnalysisInfoCard } from '../analytics/AnalysisInfoCard';
import { renderTraySettings } from './settingPillRenderer';
import { CfpPopover } from './CfpPopover';
import { OVERLAY_PRESET_COLOURS } from '../ColourSelector';
import { useDataDepthContext } from '../../contexts/DataDepthContext';
import { buildDataDepthInfoRows } from '../../services/dataDepthService';
import { useGraphStoreOptional } from '../../contexts/GraphStoreContext';

type ChartKind = 'funnel' | 'bridge' | 'histogram' | 'daily_conversions' | 'cohort_maturity' | 'lag_fit' | 'bar_grouped' | 'pie' | 'time_series' | 'info';

export function normaliseChartKind(kind: string | undefined | null): ChartKind | null {
  if (!kind) return null;
  if (kind === 'funnel') return 'funnel';
  if (kind === 'bridge' || kind === 'bridge_horizontal') return 'bridge';
  if (kind === 'histogram' || kind === 'lag_histogram') return 'histogram';
  if (kind === 'daily_conversions') return 'daily_conversions';
  if (kind === 'cohort_maturity') return 'cohort_maturity';
  if (kind === 'lag_fit') return 'lag_fit';
  if (kind === 'bar_grouped') return 'bar_grouped';
  if (kind === 'pie') return 'pie';
  if (kind === 'time_series') return 'time_series';
  if (kind === 'info') return 'info';
  return null;
}

function labelForChartKind(kind: ChartKind): string {
  if (kind === 'funnel') return 'Funnel';
  if (kind === 'bridge') return 'Bridge';
  if (kind === 'histogram') return 'Lag Histogram';
  if (kind === 'daily_conversions') return 'Daily Conversions';
  if (kind === 'cohort_maturity') return 'Cohort Maturity';
  if (kind === 'lag_fit') return 'Lag Fit';
  if (kind === 'bar_grouped') return 'Comparison';
  if (kind === 'pie') return 'Pie';
  if (kind === 'time_series') return 'Time Series';
  return kind;
}

function extractSubjectIds(result: AnalysisResult | null): string[] {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  const s = new Set<string>();
  for (const r of rows) if (r?.subject_id) s.add(String(r.subject_id));
  return Array.from(s);
}

function summariseDailyConversionsOption(option: any): Record<string, unknown> {
  const series = Array.isArray(option?.series) ? option.series : [];
  return {
    seriesCount: series.length,
    seriesNames: series.map((s: any) => s?.name || null),
    seriesTypes: series.map((s: any) => s?.type || null),
    pointCounts: series.map((s: any) => Array.isArray(s?.data) ? s.data.length : 0),
    firstPoints: series.map((s: any) => Array.isArray(s?.data) && s.data.length > 0 ? s.data[0] : null),
    lastPoints: series.map((s: any) => Array.isArray(s?.data) && s.data.length > 0 ? s.data[s.data.length - 1] : null),
    legendShown: option?.legend?.show !== false,
    xAxisType: option?.xAxis?.type || null,
    xAxisName: option?.xAxis?.name || null,
  };
}

export function AnalysisChartContainer(props: {
  result: AnalysisResult | null;
  chartKindOverride?: string;
  visibleScenarioIds: string[];
  scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
  scenarioMetaById?: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }>;
  scenarioDslSubtitleById?: Record<string, string>;
  height?: number;
  fillHeight?: boolean;
  onChartKindChange?: (chartKind: string | undefined) => void;
  display?: Record<string, unknown>;
  onDisplayChange?: (keyOrBatch: string | Record<string, any>, value?: any) => void;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  hideChrome?: boolean;
  hideScenarioLegend?: boolean;
  /** Rendering mode: 'canvas' = floating palette over chart; 'tab' = static toolbar bar. */
  chartContext?: 'canvas' | 'tab';
  /** Current analysis type ID (for toolbar dropdown) */
  analysisTypeId?: string;
  /** Available analyses for the dropdown */
  availableAnalyses?: AvailableAnalysis[];
  /** Callback when user changes analysis type via the header dropdown */
  onAnalysisTypeChange?: (analysisTypeId: string) => void;
  /** Current analysis mode (live/custom/fixed) */
  analysisMode?: 'live' | 'custom' | 'fixed';
  /** Cycle to the next mode: Live → Custom → Fixed → Live */
  onModeCycle?: () => void;
  /** Scenario layer items for the toolbar scenarios popover */
  scenarioLayerItems?: ScenarioLayerItem[];
  /** Toggle scenario visibility in the toolbar popover */
  onScenarioToggleVisibility?: (id: string) => void;
  /** Cycle scenario visibility mode (f+e → f → e) */
  onScenarioCycleMode?: (id: string) => void;
  /** Change scenario colour */
  onScenarioColourChange?: (id: string, colour: string) => void;
  /** Swatch overlay style for visibility mode indicators */
  getScenarioSwatchOverlayStyle?: (id: string) => React.CSSProperties | null;
  /** Delete a scenario */
  onScenarioDelete?: (id: string) => void;
  /** Edit a scenario (open DSL editor) */
  onScenarioEdit?: (id: string) => void;
  /** Tooltip for the edit button */
  getScenarioEditTooltip?: () => string;
  /** Reorder scenarios */
  onScenarioReorder?: (fromIndex: number, toIndex: number) => void;
  /** Add a new blank scenario (auto-promotes to custom if live) */
  onAddScenario?: () => void;
  /** Whether the subject overlay connectors are active */
  overlayActive?: boolean;
  /** Current overlay colour */
  overlayColour?: string;
  /** Toggle overlay connectors on/off */
  onOverlayToggle?: (active: boolean) => void;
  /** Change overlay colour (also enables overlay) */
  onOverlayColourChange?: (colour: string | null) => void;
  /** Analysis ID (for refresh event dispatch) */
  analysisId?: string;
  /** Delete the canvas analysis */
  onDelete?: () => void;
  /** Current canvas zoom level (for inverse-scaling UI chrome) */
  canvasZoom?: number;
  /** Current view mode — enables view mode switcher in the toolbar */
  viewMode?: ViewMode;
  /** Callback to switch view mode (chart → cards → table) */
  onViewModeChange?: (mode: ViewMode) => void;
  /** Open the current result in a dedicated tab */
  onOpenAsTab?: () => void;
  /** Dump debug JSON to clipboard */
  onDumpDebug?: () => void;
  /** Graph object for the QueryExpressionEditor in the DSL badge popover */
  graph?: any;
  /** Callback when the user edits the DSL in the toolbar badge popover */
  onDslChange?: (dsl: string) => void;
  /** When provided, replaces the default chart/info content area (used for cards/table views). */
  children?: React.ReactNode;
  /** Force-disable ECharts load animations (e.g. hover preview satellites). */
  suppressAnimation?: boolean;
  /** Default tab for info cards (driven by view overlay mode). */
  infoDefaultTab?: string;
  /** Callback when a file link is clicked in an info card. */
  onFileLink?: (fileId: string, type: string) => void;
  /** Extra React content to append after a specific tab's table in info cards. */
  infoTabExtra?: Record<string, React.ReactNode>;
  /** Called once the chart reaches a terminal visual state.
   *  'rendered' = ECharts painted real data; 'failed' = null option / info / no chart. */
  onRendered?: (outcome: 'rendered' | 'failed') => void;
}): JSX.Element | null {
  const { result, chartKindOverride, visibleScenarioIds, scenarioVisibilityModes, scenarioMetaById, scenarioDslSubtitleById, height = 420, fillHeight = false, display, onDisplayChange, source, hideChrome = false } = props;
  const defaultContext = props.chartContext || 'tab';
  const hideScenarioLegend = props.hideScenarioLegend ?? false;

  // Local display state fallback: when the parent doesn't provide onDisplayChange
  // (e.g. analytics panel tab), display settings still work via local state.
  const [localDisplay, setLocalDisplay] = useState<Record<string, unknown>>({});
  const effectiveDisplay = display ?? localDisplay;
  const handleDisplayChange = useCallback((keyOrBatch: string | Record<string, any>, value?: any) => {
    if (onDisplayChange) {
      onDisplayChange(keyOrBatch, value);
    } else if (typeof keyOrBatch === 'object') {
      setLocalDisplay(prev => ({ ...prev, ...keyOrBatch }));
    } else {
      setLocalDisplay(prev => ({ ...prev, [keyOrBatch]: value }));
    }
  }, [onDisplayChange]);
  const showInlineAnalysisTypePicker = defaultContext === 'canvas' && !props.analysisTypeId && !!props.onAnalysisTypeChange;
  const isDebugDailyConversions = import.meta.env.DEV && result?.analysis_type === 'daily_conversions';

  const patchedResult = useMemo(() => {
    if (!result) return null;
    if (!scenarioMetaById || Object.keys(scenarioMetaById).length === 0) return result;
    const clone: any = structuredClone(result);
    clone.dimension_values = clone.dimension_values || {};
    clone.dimension_values.scenario_id = clone.dimension_values.scenario_id || {};

    for (const [sid, meta] of Object.entries(scenarioMetaById)) {
      const existing = clone.dimension_values.scenario_id[sid] || {};
      clone.dimension_values.scenario_id[sid] = {
        ...existing,
        ...(meta.name ? { name: meta.name } : null),
        ...(meta.colour ? { colour: meta.colour } : null),
        ...(meta.visibility_mode ? { visibility_mode: meta.visibility_mode } : null),
      };
    }

    // Bridge results embed scenario names in metadata and step labels.
    const metaA = clone.metadata?.scenario_a;
    const metaB = clone.metadata?.scenario_b;
    const oldA = metaA?.name;
    const oldB = metaB?.name;
    if (metaA?.scenario_id && scenarioMetaById[metaA.scenario_id]) {
      Object.assign(metaA, scenarioMetaById[metaA.scenario_id]);
    }
    if (metaB?.scenario_id && scenarioMetaById[metaB.scenario_id]) {
      Object.assign(metaB, scenarioMetaById[metaB.scenario_id]);
    }
    if (clone.dimension_values?.bridge_step) {
      for (const step of Object.values(clone.dimension_values.bridge_step) as any[]) {
        if (typeof step?.name === 'string') {
          let n = step.name;
          if (oldA && metaA?.name) n = n.replaceAll(oldA, metaA.name);
          if (oldB && metaB?.name) n = n.replaceAll(oldB, metaB.name);
          step.name = n;
        }
      }
    }
    return clone as AnalysisResult;
  }, [result, scenarioMetaById]);

  // ── Data Depth score enrichment (appends coverage scores when available) ──
  // The depth tab always exists from buildEdgeInfoResult (basic n/k rows).
  // This memo appends f₁/f₂/f₃/composite rows once async scores arrive.
  const { scores: _ddScores } = useDataDepthContext();
  const _ddGraph: any = useGraphStoreOptional((s: any) => s?.graph);
  const finalResult = useMemo(() => {
    if (!patchedResult || patchedResult.analysis_type !== 'edge_info' || !_ddScores || !_ddGraph?.edges) {
      return patchedResult;
    }
    const rows = patchedResult.data as any[] | undefined;
    const edgeIdRow = rows?.find((r: any) => r.tab === 'overview' && r.property === 'Edge ID');
    if (!edgeIdRow?.value) return patchedResult;

    const edgeObj = _ddGraph.edges.find((e: any) => e.id === edgeIdRow.value || e.uuid === edgeIdRow.value);
    const scoreKey = edgeObj ? (edgeObj.uuid ?? edgeObj.id) : edgeIdRow.value;
    const score = _ddScores.get(scoreKey);
    if (!score) return patchedResult;

    const n = edgeObj?.p?.evidence?.n ?? 0;
    const k = edgeObj?.p?.evidence?.k;
    return {
      ...patchedResult,
      data: [...(rows ?? []), ...buildDataDepthInfoRows(score, n, k)],
    };
  }, [patchedResult, _ddScores, _ddGraph]);

  const inferredChartKind = useMemo((): ChartKind | null => {
    if (!finalResult) return null;
    const t = (finalResult as any)?.analysis_type;
    if (t === 'conversion_funnel') return 'funnel';
    if (t === 'lag_histogram') return 'histogram';
    if (t === 'daily_conversions') return 'daily_conversions';
    if (t === 'cohort_maturity') return 'cohort_maturity';
    if (t === 'lag_fit') return 'lag_fit';
    if (typeof t === 'string' && t.includes('bridge')) return 'bridge';
    return 'bridge';
  }, [finalResult]);

  const availableChartKinds = useMemo((): ChartKind[] => {
    if (!finalResult) return [];
    const spec: any = finalResult?.semantics?.chart;
    const rec = normaliseChartKind(spec?.recommended);
    const alts = Array.isArray(spec?.alternatives) ? spec.alternatives : [];
    const augmented = augmentChartKindOptionsForAnalysisType(finalResult?.analysis_type, [spec?.recommended, ...alts].filter(Boolean) as string[]);
    const altKinds = augmented.slice(1).map(normaliseChartKind).filter(Boolean) as ChartKind[];
    const augmentedRec = normaliseChartKind(augmented[0] || spec?.recommended);
    const all = [augmentedRec || rec, ...altKinds].filter(Boolean) as ChartKind[];
    if (all.length === 0 && inferredChartKind) return [inferredChartKind];
    return Array.from(new Set(all));
  }, [finalResult, inferredChartKind]);

  const [selectedKind, setSelectedKind] = useState<ChartKind | null>(null);
  const normalisedOverride = normaliseChartKind(chartKindOverride);
  const kind = normalisedOverride ?? selectedKind ?? availableChartKinds[0] ?? null;
  const displayPlan = useMemo(() => planChartDisplay({
    result: finalResult,
    requestedChartKind: kind || chartKindOverride || finalResult?.semantics?.chart?.recommended,
    visibleScenarioIds,
    scenarioVisibilityModes,
    display: effectiveDisplay,
  }), [finalResult, kind, chartKindOverride, visibleScenarioIds, scenarioVisibilityModes, effectiveDisplay]);
  const effectiveKind = normaliseChartKind(displayPlan.effectiveChartKind || kind);

  const resolvedSettings = useMemo(() => {
    if (!effectiveKind) return {};
    const settings = getDisplaySettings(effectiveKind, 'chart');
    const resolved: Record<string, any> = {};
    for (const s of settings) {
      resolved[s.key] = resolveDisplaySetting(effectiveDisplay, s);
    }
    return resolved;
  }, [effectiveKind, effectiveDisplay]);

  // Single list of display settings for the unified toolbar.
  // Always fetch the 'tab' surface set — it's the full set.
  // When wide, these render inline as pills; when narrow, they collapse into a popover.
  const toolbarSettings = useMemo((): DisplaySettingDef[] => {
    if (!effectiveKind) return [];
    return getDisplaySettingsForSurface(effectiveKind, 'chart', 'inline', 'tab');
  }, [effectiveKind]);

  // Subject selector state for daily_conversions / cohort_maturity
  const subjectIds = useMemo(() => extractSubjectIds(result), [result]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const effectiveSubjectId = (selectedSubjectId && subjectIds.includes(selectedSubjectId))
    ? selectedSubjectId
    : (subjectIds[0] || undefined);
  const showSubjectSelector = (effectiveKind === 'daily_conversions' || effectiveKind === 'cohort_maturity') && subjectIds.length > 1;
  const { ref: chartViewportRef, width: chartWidthPx, height: chartHeightPx } = useElementSize<HTMLDivElement>();

  const echartsOption = useMemo(() => {
    if (!finalResult) return null;
    if (!effectiveKind) return null;
    const finalSettings = hideScenarioLegend
      ? { ...resolvedSettings, show_legend: false }
      : resolvedSettings;
    const opt = buildChartOption(effectiveKind, finalResult, finalSettings, {
      visibleScenarioIds: displayPlan.scenarioIdsToRender,
      scenarioVisibilityModes,
      scenarioDslSubtitleById,
      subjectId: effectiveSubjectId,
      layout: {
        widthPx: chartWidthPx > 0 ? chartWidthPx : undefined,
        heightPx: chartHeightPx > 0 ? chartHeightPx : (fillHeight ? undefined : height),
      },
    });
    if (props.suppressAnimation && opt) opt.animation = false;
    return opt;
  }, [effectiveKind, finalResult, resolvedSettings, hideScenarioLegend, displayPlan.scenarioIdsToRender, scenarioVisibilityModes, scenarioDslSubtitleById, effectiveSubjectId, chartWidthPx, chartHeightPx, fillHeight, height, props.suppressAnimation]);

  // Diagnostic: log when we have a result but no chart option
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!finalResult) return; // still loading — nothing to log
    if (effectiveKind === 'info') return; // info cards don't need echarts
    if (echartsOption) {
      console.log(`[ChartRender] OK ${finalResult.analysis_type}×${effectiveKind}`, {
        analysisId: props.analysisId,
        dataRows: finalResult.data?.length,
        seriesCount: echartsOption?.series?.length,
        source: finalResult.metadata?.source,
      });
      return;
    }
    console.warn(`[ChartRender] NULL echartsOption — chart will be invisible`, {
      analysisId: props.analysisId,
      analysisType: finalResult.analysis_type,
      effectiveKind,
      hasResult: true,
      dataRows: finalResult.data?.length,
      dimensions: finalResult.semantics?.dimensions?.map((d: any) => d?.id),
      metrics: finalResult.semantics?.metrics?.map((m: any) => m?.id),
      source: finalResult.metadata?.source,
      empty: finalResult.metadata?.empty,
      hasOnViewModeChange: !!props.onViewModeChange,
    });
  }, [finalResult, effectiveKind, echartsOption]);

  // Fire onRendered for non-ECharts paths (info card, null option) — these are
  // already at their final visual state, no ECharts 'finished' event will come.
  useEffect(() => {
    if (renderedCallbackFiredRef.current) return;
    if (!finalResult) return; // still loading
    if (echartsOption) return;  // ECharts path — handled by handleChartReady
    renderedCallbackFiredRef.current = true;
    props.onRendered?.('failed');
  }, [finalResult, echartsOption, props.onRendered]);

  // Auto-fallback: when chart view can't render (no echarts option and not info),
  // switch to the next available view mode instead of showing "No data available".
  const chartCanRender = (effectiveKind === 'info' && !!finalResult) || !!echartsOption;
  useEffect(() => {
    if (chartCanRender) return;            // chart renders fine
    if (props.children) return;            // parent supplies content (cards/table)
    if (!finalResult) return;            // no result yet — still loading
    if (!props.onViewModeChange) return;   // can't switch view mode
    if (props.viewMode && props.viewMode !== 'chart') return; // already not chart

    const available = getAvailableExpressions(finalResult);
    const fallback = available.find(m => m !== 'chart');
    if (fallback) {
      props.onViewModeChange(fallback);
    }
  }, [chartCanRender, finalResult, props.children, props.onViewModeChange, props.viewMode]);

  const onEvents = useMemo(() => ({}), []);
  const echartsRef = useRef<any>(null);
  const dailyRenderCommitRef = useRef(0);
  const dailyOptionVersionRef = useRef(0);
  const dailyEchartsReadyCountRef = useRef(0);

  const handleSubjectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedSubjectId(e.target.value);
  }, []);

  const handleChartKindChange = useCallback((nextKind: ChartKind) => {
    setSelectedKind(nextKind);
    props.onChartKindChange?.(nextKind);
  }, [props]);

  // Right-click context menu (non-canvas contexts only — canvas has its own node-level menu)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showAllAnalysisTypes, setShowAllAnalysisTypes] = useState(false);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (defaultContext === 'canvas') return; // canvas uses CanvasAnalysisContextMenu
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [defaultContext]);

  const dailyChartStateKey = useMemo(() => {
    if (!isDebugDailyConversions) return null;
    return JSON.stringify({
      analysisId: props.analysisId || null,
      chartContext: defaultContext,
      effectiveKind,
      visibleScenarioIds,
      subjectIds,
      selectedSubjectId,
      effectiveSubjectId: effectiveSubjectId || null,
      chartWidthPx,
      chartHeightPx,
      rowCount: Array.isArray(result?.data) ? result.data.length : 0,
      scenarioIds: Array.from(new Set((Array.isArray(result?.data) ? result.data : []).map((r: any) => String(r?.scenario_id)).filter(Boolean))).sort(),
      option: echartsOption ? summariseDailyConversionsOption(echartsOption) : null,
    });
  }, [
    isDebugDailyConversions,
    props.analysisId,
    defaultContext,
    effectiveKind,
    visibleScenarioIds,
    subjectIds,
    selectedSubjectId,
    effectiveSubjectId,
    chartWidthPx,
    chartHeightPx,
    result,
    echartsOption,
  ]);

  useEffect(() => {
    if (!isDebugDailyConversions || !dailyChartStateKey) return;
    dailyRenderCommitRef.current += 1;
    logChartReadinessTrace('DailyConversionsChart:commit', {
      commit: dailyRenderCommitRef.current,
      analysisId: props.analysisId,
      state: JSON.parse(dailyChartStateKey),
    });
  }, [isDebugDailyConversions, dailyChartStateKey, props.analysisId]);

  useEffect(() => {
    if (!isDebugDailyConversions || !echartsOption) return;
    dailyOptionVersionRef.current += 1;
    logChartReadinessTrace('DailyConversionsChart:option-updated', {
      analysisId: props.analysisId,
      optionVersion: dailyOptionVersionRef.current,
      summary: summariseDailyConversionsOption(echartsOption),
    });
  }, [isDebugDailyConversions, echartsOption, props.analysisId]);

  const renderedCallbackFiredRef = useRef(false);
  const overlayColourInputRef = useRef<HTMLInputElement>(null);
  const handleChartReady = useCallback((instance: any) => {
    // Fire onRendered once the ECharts instance has finished its first paint.
    // With suppressAnimation, 'finished' fires synchronously during setOption —
    // BEFORE onChartReady is called — so attaching the listener here is too late.
    // Fallback: schedule on the next animation frame (chart is already painted).
    if (!renderedCallbackFiredRef.current && props.onRendered) {
      const fireOnce = () => {
        if (renderedCallbackFiredRef.current) return;
        renderedCallbackFiredRef.current = true;
        props.onRendered!('rendered');
      };
      instance?.on?.('finished', fireOnce);
      // Fallback for suppressed animation or already-fired finished event
      requestAnimationFrame(() => fireOnce());
    }

    if (!isDebugDailyConversions) return;
    dailyEchartsReadyCountRef.current += 1;
    logChartReadinessTrace('DailyConversionsChart:echarts-ready', {
      analysisId: props.analysisId,
      readyCount: dailyEchartsReadyCountRef.current,
      width: typeof instance?.getWidth === 'function' ? instance.getWidth() : null,
      height: typeof instance?.getHeight === 'function' ? instance.getHeight() : null,
    });

    const onRendered = () => {
      logChartReadinessTrace('DailyConversionsChart:echarts-rendered', {
        analysisId: props.analysisId,
        readyCount: dailyEchartsReadyCountRef.current,
        width: typeof instance?.getWidth === 'function' ? instance.getWidth() : null,
        height: typeof instance?.getHeight === 'function' ? instance.getHeight() : null,
      });
    };
    const onFinished = () => {
      logChartReadinessTrace('DailyConversionsChart:echarts-finished', {
        analysisId: props.analysisId,
        readyCount: dailyEchartsReadyCountRef.current,
        width: typeof instance?.getWidth === 'function' ? instance.getWidth() : null,
        height: typeof instance?.getHeight === 'function' ? instance.getHeight() : null,
      });
    };

    instance?.off?.('rendered');
    instance?.off?.('finished');
    instance?.on?.('rendered', onRendered);
    instance?.on?.('finished', onFinished);
  }, [isDebugDailyConversions, props.analysisId, props.onRendered]);

  if (showInlineAnalysisTypePicker) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: fillHeight ? '100%' : undefined,
        }}
      >
        <div ref={chartViewportRef} style={{ flex: fillHeight ? 1 : undefined, minHeight: 0, overflow: 'auto', padding: '8px 10px' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, textAlign: 'center' }}>
            Choose an analysis type
          </div>
          <AnalysisTypeCardList
            availableAnalyses={props.availableAnalyses || []}
            selectedAnalysisId={props.analysisTypeId}
            onSelect={(id) => props.onAnalysisTypeChange?.(id)}
            viewMode="icons"
            showAll={false}
          />
        </div>
      </div>
    );
  }

  if (!effectiveKind) {
    return (
      <div style={{ padding: 12, color: 'var(--text-secondary)' }}>
        No chart available for this analysis.
      </div>
    );
  }

  const showChooser = availableChartKinds.length > 1;
  const showAnalysisTypeDropdown = !!props.analysisTypeId && !!props.onAnalysisTypeChange && (props.availableAnalyses?.length ?? 0) > 0;

  // Context menu items for non-canvas right-click
  const ctxMenuItems = useMemo((): ContextMenuItem[] => {
    if (defaultContext === 'canvas') return [];
    const items: ContextMenuItem[] = [];

    // Analysis type submenu
    if (props.analysisTypeId && props.onAnalysisTypeChange && props.availableAnalyses && props.availableAnalyses.length > 0) {
      items.push({
        label: 'Analysis Type',
        onClick: () => {},
        submenu: props.availableAnalyses.map(a => {
          const meta = getAnalysisTypeMeta(a.id);
          const Icon = meta?.icon;
          return {
            label: meta?.name || a.name || a.id,
            icon: Icon ? <Icon size={14} /> : undefined,
            checked: a.id === props.analysisTypeId,
            onClick: () => props.onAnalysisTypeChange!(a.id),
          };
        }),
      });
    }

    // Chart kind submenu
    if (availableChartKinds.length > 1) {
      items.push({
        label: 'Chart Type',
        onClick: () => {},
        submenu: availableChartKinds.map(k => ({
          label: labelForChartKind(k),
          checked: k === kind,
          onClick: () => handleChartKindChange(k),
        })),
      });
    }

    // Display settings submenu
    if (effectiveKind && handleDisplayChange) {
      const displayItems = buildContextMenuSettingItems(
        effectiveKind,
        'chart',
        effectiveDisplay,
        handleDisplayChange,
      );
      if (displayItems.length > 0) {
        items.push(
          { label: '', onClick: () => {}, divider: true },
          { label: 'Display', icon: <Sliders size={14} />, onClick: () => {}, submenu: displayItems as ContextMenuItem[] },
        );
      }
    }

    // Scenario visibility submenu
    if (props.scenarioLayerItems && props.scenarioLayerItems.length > 1 && props.onScenarioToggleVisibility) {
      const scenarioItems: ContextMenuItem[] = props.scenarioLayerItems.map(s => ({
        label: s.name,
        checked: s.visible,
        onClick: () => props.onScenarioToggleVisibility!(s.id),
        keepMenuOpen: true,
      }));
      items.push(
        { label: '', onClick: () => {}, divider: true },
        { label: 'Scenarios', onClick: () => {}, submenu: scenarioItems },
      );
    }

    // Actions
    const hasActions = result || props.onOpenAsTab || props.onDumpDebug;
    if (hasActions) {
      items.push({ label: '', onClick: () => {}, divider: true });
    }
    if (props.onOpenAsTab) {
      items.push({
        label: 'Open as Tab',
        icon: <ExternalLink size={14} />,
        onClick: props.onOpenAsTab,
      });
    }
    if (result) {
      items.push({
        label: 'Download CSV',
        icon: <Download size={14} />,
        onClick: () => {
          const { filename, csv } = analysisResultToCsv(result);
          if (csv) downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
        },
      });
    }
    if (props.onDumpDebug) {
      items.push({
        label: 'Dump Debug JSON',
        icon: <ClipboardCopy size={14} />,
        onClick: props.onDumpDebug,
      });
    }

    return items;
  }, [defaultContext, props.analysisTypeId, props.onAnalysisTypeChange, props.availableAnalyses, availableChartKinds, kind, handleChartKindChange, effectiveKind, effectiveDisplay, handleDisplayChange, props.scenarioLayerItems, props.onScenarioToggleVisibility, result, props.onOpenAsTab, props.onDumpDebug]);

  // Whether chart is wide enough to auto-expand popovers into inline pills.
  const wideToolbar = chartWidthPx > 480;

  const VIEW_MODE_ICONS: Record<ViewMode, React.ComponentType<{ size?: number | string }>> = {
    chart: BarChart3,
    cards: LayoutGrid,
    table: Table2,
  };
  const VIEW_MODE_LABELS: Record<ViewMode, string> = { chart: 'Chart', cards: 'Cards', table: 'Table' };

  const toolbarTray = (
    <>
      {/* --- Analysis type: popover palette (most fundamental choice) --- */}
      {showAnalysisTypeDropdown && (() => {
        const activeMeta = getAnalysisTypeMeta(props.analysisTypeId!);
        const ActiveIcon = activeMeta?.icon;
        return (
          <CfpPopover
            icon={<>{ActiveIcon && <ActiveIcon size={13} />}<ChevronDown size={9} /></>}
            label={activeMeta?.name}
            title="Analysis type"
          >
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 4px 4px' }}>
              <button
                type="button"
                className="cfp-show-all-toggle"
                onClick={() => setShowAllAnalysisTypes(prev => !prev)}
                title={showAllAnalysisTypes ? 'Available only' : 'Show all'}
                style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--text-muted, #9ca3af)', padding: '2px 4px' }}
              >
                {showAllAnalysisTypes ? <EyeOff size={11} /> : <Eye size={11} />}
                {showAllAnalysisTypes ? 'Available only' : 'Show all'}
              </button>
            </div>
            <div className="cfp-type-palette">
              {(() => {
                const availableIds = new Set((props.availableAnalyses || []).map(a => a.id));
                const types = showAllAnalysisTypes
                  ? ANALYSIS_TYPES.filter(tm => !tm.internal).map(tm => ({ id: tm.id, meta: tm, available: availableIds.has(tm.id) }))
                  : (props.availableAnalyses || []).map(a => ({ id: a.id, meta: getAnalysisTypeMeta(a.id), available: true }));
                return types.map(({ id, meta, available }) => {
                  const Icon = meta?.icon;
                  const active = id === props.analysisTypeId;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`cfp-type-palette-item${active ? ' active' : ''}${!available ? ' unavailable' : ''}`}
                      onClick={() => props.onAnalysisTypeChange?.(id)}
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
        );
      })()}

      {/* --- View mode switcher --- */}
      {props.onViewModeChange && (() => {
        const available = getAvailableExpressions(result);
        if (available.length <= 1) return null;
        const current = props.viewMode || 'chart';
        return (
          <>
            {showAnalysisTypeDropdown && <span className="cfp-sep" />}
            <span className="cfp-pill-group" title="View">
              <span className="cfp-group-label">View</span>
              {available.map(mode => {
                const Icon = VIEW_MODE_ICONS[mode];
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`cfp-pill${mode === current ? ' active' : ''}`}
                    onClick={() => props.onViewModeChange!(mode)}
                    title={VIEW_MODE_LABELS[mode]}
                  >
                    <Icon size={13} />
                  </button>
                );
              })}
            </span>
          </>
        );
      })()}

      {/* --- Separator --- */}
      {(showChooser || showSubjectSelector) && <span className="cfp-sep" />}

      {/* --- Chart kind: inline pills (wide) or popover (narrow) --- */}
      {showChooser && (
        wideToolbar ? (
          <span className="cfp-pill-group" title="Chart type">
            <span className="cfp-group-label">Chart</span>
            {availableChartKinds.map(k => (
              <button
                key={k}
                type="button"
                className={`cfp-pill${k === kind ? ' active' : ''}`}
                onClick={() => handleChartKindChange(k)}
                title={labelForChartKind(k)}
              >
                {labelForChartKind(k)}
              </button>
            ))}
          </span>
        ) : (
          <CfpPopover
            icon={<><BarChart3 size={13} /><ChevronDown size={9} /></>}
            label={kind ? labelForChartKind(kind) : 'Chart'}
            title="Chart type"
          >
            {availableChartKinds.map(k => (
              <button
                key={k}
                type="button"
                className={`cfp-menu-item${k === kind ? ' active' : ''}`}
                onClick={() => handleChartKindChange(k)}
              >
                {labelForChartKind(k)}
              </button>
            ))}
          </CfpPopover>
        )
      )}

      {/* --- Subject selector --- */}
      {showSubjectSelector && (
        <select
          value={effectiveSubjectId || ''}
          onChange={handleSubjectChange}
          className="cfp-select"
          aria-label="Subject"
        >
          {subjectIds.map(sid => {
            const meta = (result?.dimension_values as any)?.subject_id?.[sid];
            return <option key={sid} value={sid}>{meta?.name || sid}</option>;
          })}
        </select>
      )}

      {/* --- Separator --- */}
      <span className="cfp-sep" />

      {/* --- Display settings: inline (wide) or popover (narrow) --- */}
      {toolbarSettings.length > 0 && (
        wideToolbar
          ? renderTraySettings(toolbarSettings, effectiveDisplay, handleDisplayChange)
          : (
            <CfpPopover
              icon={<Sliders size={13} />}
              title="Display"
              label="Display"
            >
              {renderTraySettings(toolbarSettings, effectiveDisplay, handleDisplayChange)}
            </CfpPopover>
          )
      )}

      {/* --- Overlay group --- */}
      {props.onOverlayToggle && (
        <span className="cfp-pill-group">
          <span className="cfp-group-label">Overlay</span>
          <button
            type="button"
            className={`cfp-pill${props.overlayActive ? ' active' : ''}`}
            style={props.overlayColour ? { color: props.overlayColour } : undefined}
            title="Toggle overlay connectors"
            onClick={() => props.onOverlayToggle!(!props.overlayActive)}
          >
            <Crosshair size={13} />
          </button>
          <CfpPopover
            icon={<span className="cfp-menu-swatch" style={{ background: props.overlayColour || '#3b82f6' }} />}
            title="Overlay colour"
          >
            {OVERLAY_PRESET_COLOURS.map(p => (
              <button
                key={p.value}
                type="button"
                className={`cfp-menu-item${props.overlayColour === p.value ? ' active' : ''}`}
                onClick={() => props.onOverlayColourChange?.(p.value)}
              >
                <span className="cfp-menu-swatch" style={{ background: p.value }} />
                {p.name}
              </button>
            ))}
            <button
              type="button"
              className={`cfp-menu-item${props.overlayColour && !OVERLAY_PRESET_COLOURS.some(p => p.value === props.overlayColour) ? ' active' : ''}`}
              onClick={() => overlayColourInputRef.current?.click()}
            >
              <span className="cfp-menu-swatch" style={{ background: props.overlayColour || '#888', border: '1px dashed #9CA3AF' }} />
              Custom...
            </button>
            <input
              ref={overlayColourInputRef}
              type="color"
              value={props.overlayColour || '#3b82f6'}
              onChange={(e) => props.onOverlayColourChange?.(e.target.value)}
              style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            />
          </CfpPopover>
        </span>
      )}

      {/* --- Mode / Scenarios group --- */}
      {(props.onModeCycle || (props.scenarioLayerItems && props.scenarioLayerItems.length > 0)) && (
        <span className="cfp-pill-group">
          <span className="cfp-group-label">{props.onModeCycle ? 'Mode' : 'Scenarios'}</span>
          <CfpPopover
            icon={<><Layers size={13} /><ChevronDown size={9} /></>}
            title="Scenarios"
            trigger={props.onModeCycle
              ? <ModeTrack mode={props.analysisMode || 'live'} onClick={props.onModeCycle} />
              : undefined}
          >
            <div className="cfp-scenario-popover">
              {props.scenarioLayerItems && props.scenarioLayerItems.length > 0 && (
                <ScenarioLayerList
                  items={props.scenarioLayerItems}
                  containerClassName="cfp-scenario-popover__list"
                  onToggleVisibility={props.onScenarioToggleVisibility}
                  onCycleMode={props.onScenarioCycleMode}
                  onColourChange={props.onScenarioColourChange}
                  onReorder={props.onScenarioReorder}
                  onDelete={props.onScenarioDelete}
                  onEdit={props.onScenarioEdit}
                  getEditTooltip={props.getScenarioEditTooltip}
                  getSwatchOverlayStyle={props.getScenarioSwatchOverlayStyle}
                />
              )}
              {props.onAddScenario && (
                <button
                  type="button"
                  className="cfp-scenario-popover__add-btn"
                  onClick={props.onAddScenario}
                  title="Add a blank scenario"
                >
                  <Plus size={12} /> Add scenario
                </button>
              )}
            </div>
          </CfpPopover>
        </span>
      )}

      {/* --- DSL badge (canvas only — tab shows DSL in panel above) --- */}
      {defaultContext === 'canvas' && source?.query_dsl && (
        <CfpPopover
          icon={<Code size={13} />}
          title="Query DSL"
          sticky
          popoverClassName="cfp-popover--dsl"
        >
          {props.graph && props.onDslChange ? (
            <QueryExpressionEditor
              value={source.query_dsl}
              onChange={() => {}}
              onBlur={props.onDslChange}
              graph={props.graph}
              height="120px"
              placeholder="from(node).to(node)"
            />
          ) : (
            <pre className="cfp-dsl-preview">{source.query_dsl}</pre>
          )}
        </CfpPopover>
      )}

      {/* --- More actions dropdown --- */}
      <CfpPopover
        icon={<MoreHorizontal size={13} />}
        title="More actions"
      >
        {props.analysisId && (
          <button
            type="button"
            className="cfp-menu-item"
            onClick={() => window.dispatchEvent(new CustomEvent('dagnet:canvasAnalysisRefresh', { detail: { analysisId: props.analysisId } }))}
          >
            <RefreshCcw size={12} /> Refresh
          </button>
        )}
        {props.onOpenAsTab && (
          <button
            type="button"
            className="cfp-menu-item"
            onClick={props.onOpenAsTab}
          >
            <ExternalLink size={12} /> Open as Tab
          </button>
        )}
        {result && (
          <button
            type="button"
            className="cfp-menu-item"
            onClick={() => {
              const { filename, csv } = analysisResultToCsv(result);
              if (csv) downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
            }}
          >
            <Download size={12} /> Download CSV
          </button>
        )}
        {props.onDumpDebug && (
          <button
            type="button"
            className="cfp-menu-item"
            onClick={props.onDumpDebug}
          >
            <ClipboardCopy size={12} /> Dump Debug JSON
          </button>
        )}
        {props.onDelete && (
          <button
            type="button"
            className="cfp-menu-item cfp-menu-item--danger"
            onClick={props.onDelete}
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
      </CfpPopover>
    </>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: fillHeight ? '100%' : undefined,
      }}
    >
      <div style={{ flex: fillHeight ? 1 : undefined, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {!hideChrome && (
          <ChartFloatingIcon
            containerRef={chartViewportRef}
            tray={toolbarTray}
            canvasZoom={props.canvasZoom}
            defaultAnchor={defaultContext === 'tab' ? 'top' : 'top-right'}
          />
        )}
        <div
          ref={chartViewportRef}
          data-chart-viewport
          onContextMenu={handleContextMenu}
          style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
        {props.children ? (
          props.children
        ) : effectiveKind === 'info' && finalResult ? (
          <div style={{ flex: fillHeight ? 1 : undefined, minHeight: 0, overflow: 'auto' }}>
            <AnalysisInfoCard result={finalResult} fontSize={resolvedSettings.font_size} defaultTab={props.infoDefaultTab} onFileLink={props.onFileLink} tabExtra={props.infoTabExtra} />
          </div>
        ) : echartsOption ? (
          <div style={{ flex: fillHeight ? 1 : undefined, minHeight: 0, position: 'relative' }}>
            <ReactECharts
              ref={echartsRef}
              option={echartsOption}
              style={{ height: fillHeight ? '100%' : height, width: '100%' }}
              notMerge
              onEvents={onEvents}
              onChartReady={handleChartReady}
            />
          </div>
        ) : null}
        </div>
      </div>
      {ctxMenu && ctxMenuItems.length > 0 && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenuItems} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  );
}
