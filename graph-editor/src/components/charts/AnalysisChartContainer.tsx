import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { Download, Sliders, ExternalLink, ClipboardCopy } from 'lucide-react';

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
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import { ChartFloatingIcon } from './ChartInlineSettingsFloating';
import { logChartReadinessTrace } from '../../lib/snapshotBootTrace';
import type { ViewMode } from '../../types/chartRecipe';
import { getAvailableExpressions } from '../../types/chartRecipe';
import { LayoutGrid, Table2 } from 'lucide-react';
import { AnalysisInfoCard } from '../analytics/AnalysisInfoCard';
import { ExpressionToolbarTray } from './ExpressionToolbarTray';
import { CfpPopover } from './CfpPopover';

type ChartKind = 'funnel' | 'bridge' | 'histogram' | 'daily_conversions' | 'cohort_maturity' | 'lag_fit' | 'bar_grouped' | 'pie' | 'time_series' | 'info' | 'surprise_gauge';

/** Stable ref so ReactECharts doesn't dispose/reinit on every render. */
const ECHARTS_OPTS = { renderer: 'svg' as const };


export function normaliseChartKind(kind: string | undefined | null): ChartKind | null {
  if (!kind) return null;
  if (kind === 'funnel') return 'funnel';
  if (kind === 'bridge' || kind === 'bridge_horizontal') return 'bridge';
  if (kind === 'histogram' || kind === 'lag_histogram') return 'histogram';
  if (kind === 'daily_conversions') return 'daily_conversions';
  if (kind === 'cohort_maturity') return 'cohort_maturity';
  if (kind === 'lag_fit') return 'lag_fit';
  if (kind === 'surprise_gauge') return 'surprise_gauge';
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
  if (kind === 'surprise_gauge') return 'Expectation Gauge';
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
  /** When set, filter AnalysisInfoCard to this card kind (no internal tab bar). */
  infoCardKind?: string;
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

  // Data Depth enrichment now lives in AnalysisInfoCard (works in both
  // chart-container and direct card-view paths).
  const finalResult = patchedResult;

  const inferredChartKind = useMemo((): ChartKind | null => {
    if (!finalResult) return null;
    const t = (finalResult as any)?.analysis_type;
    if (t === 'conversion_funnel') return 'funnel';
    if (t === 'lag_histogram') return 'histogram';
    if (t === 'daily_conversions') return 'daily_conversions';
    if (t === 'cohort_maturity') return 'cohort_maturity';
    if (t === 'lag_fit') return 'lag_fit';
    if (t === 'surprise_gauge') return 'surprise_gauge';
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
  // Explicit override (from content item kind) is authoritative — the planner
  // may only adjust scenarios, not override the kind itself.
  const effectiveKind = normalisedOverride || normaliseChartKind(displayPlan.effectiveChartKind || kind);

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

  // Layout ref — read at useMemo computation time but NOT a dependency.
  // Dimension changes are handled by instance.resize() below, not by
  // rebuilding the option (which caused the double-draw regression).
  const layoutRef = useRef({ w: 0, h: 0 });
  layoutRef.current = { w: chartWidthPx, h: chartHeightPx };

  const echartsOption = useMemo(() => {
    if (!finalResult) return null;
    if (!effectiveKind) return null;
    const finalSettings = hideScenarioLegend
      ? { ...resolvedSettings, show_legend: false }
      : resolvedSettings;
    const w = layoutRef.current.w;
    const h = layoutRef.current.h;
    const opt = buildChartOption(effectiveKind, finalResult, finalSettings, {
      visibleScenarioIds: displayPlan.scenarioIdsToRender,
      scenarioVisibilityModes,
      scenarioDslSubtitleById,
      subjectId: effectiveSubjectId,
      layout: {
        widthPx: w > 0 ? w : undefined,
        heightPx: h > 0 ? h : (fillHeight ? undefined : height),
      },
    });
    if (props.suppressAnimation && opt) opt.animation = false;
    return opt;
  }, [effectiveKind, finalResult, resolvedSettings, hideScenarioLegend, displayPlan.scenarioIdsToRender, scenarioVisibilityModes, scenarioDslSubtitleById, effectiveSubjectId, fillHeight, height, props.suppressAnimation]);


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
  // Guard with ref to fire at most once per mount — prevents infinite loop when
  // viewMode prop reads from ci.view_type (content item) but onViewModeChange
  // updates analysis.view_mode (container), so the prop never changes.
  const chartCanRender = (effectiveKind === 'info' && !!finalResult) || !!echartsOption;
  const autoFallbackFiredRef = useRef(false);
  // Reset fallback guard when chart becomes renderable again (e.g. new result arrives)
  if (chartCanRender) autoFallbackFiredRef.current = false;
  useEffect(() => {
    if (chartCanRender) return;            // chart renders fine
    if (autoFallbackFiredRef.current) return; // already fired — prevent loop
    if (props.children) return;            // parent supplies content (cards/table)
    if (!finalResult) return;            // no result yet — still loading
    if (!props.onViewModeChange) return;   // can't switch view mode
    if (props.viewMode && props.viewMode !== 'chart') return; // already not chart

    const available = getAvailableExpressions(finalResult);
    const fallback = available.find(m => m !== 'chart');
    if (fallback) {
      autoFallbackFiredRef.current = true;
      props.onViewModeChange(fallback);
    }
  }, [chartCanRender, finalResult, props.children, props.onViewModeChange, props.viewMode]);

  const onEvents = useMemo(() => ({}), []);
  const echartsRef = useRef<any>(null);

  // DEV: patch echarts-for-react's internal updateEChartsOption to trace every setOption
  // TODO: echarts-for-react's async initEchartsInstance causes a double-animation
  // (componentDidUpdate fires setOption on the temp instance before renderNewEcharts
  // resolves and creates the real one). Needs a fix that doesn't break initial rendering.

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

  // Context menu items for non-canvas right-click
  // (must be before early returns to satisfy React hooks ordering)
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

  const wideToolbar = chartWidthPx > 480;

  const toolbarTray = (
    <ExpressionToolbarTray
      viewMode={props.viewMode || 'chart'}
      result={result}
      display={effectiveDisplay}
      onViewModeChange={props.onViewModeChange}
      onDisplayChange={handleDisplayChange}
      onOpenAsTab={props.onOpenAsTab}
      onDumpDebug={props.onDumpDebug}
      onDelete={props.onDelete}
      analysisTypeId={props.analysisTypeId}
      availableAnalyses={props.availableAnalyses}
      onAnalysisTypeChange={props.onAnalysisTypeChange}
      kind={kind ?? undefined}
      onKindChange={props.onChartKindChange ? (k) => handleChartKindChange(k as any) : undefined}
      availableKinds={availableChartKinds.length > 1 ? availableChartKinds.map(k => ({ id: k, name: labelForChartKind(k) })) : undefined}
      overlayActive={props.overlayActive}
      overlayColour={props.overlayColour}
      onOverlayToggle={props.onOverlayToggle}
      onOverlayColourChange={props.onOverlayColourChange}
      analysisMode={props.analysisMode}
      onModeCycle={props.onModeCycle}
      scenarioLayerItems={props.scenarioLayerItems}
      onScenarioToggleVisibility={props.onScenarioToggleVisibility}
      onScenarioCycleMode={props.onScenarioCycleMode}
      onScenarioColourChange={props.onScenarioColourChange}
      onScenarioReorder={props.onScenarioReorder}
      onScenarioDelete={props.onScenarioDelete}
      onScenarioEdit={props.onScenarioEdit}
      onAddScenario={props.onAddScenario}
      getScenarioEditTooltip={props.getScenarioEditTooltip}
      getScenarioSwatchOverlayStyle={props.getScenarioSwatchOverlayStyle}
      analysisId={props.analysisId}
      wideToolbar={wideToolbar}
      subjectIds={showSubjectSelector ? subjectIds : undefined}
      effectiveSubjectId={effectiveSubjectId}
      subjectMeta={(result?.dimension_values as any)?.subject_id}
      onSubjectChange={showSubjectSelector ? (sid) => setSelectedSubjectId(sid) : undefined}
      queryDsl={source?.query_dsl}
      onDslChange={props.onDslChange}
      graph={props.graph}
    />
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
            <AnalysisInfoCard result={finalResult} fontSize={resolvedSettings.font_size} defaultTab={props.infoDefaultTab} onFileLink={props.onFileLink} tabExtra={props.infoTabExtra} kind={props.infoCardKind} />
          </div>
        ) : echartsOption ? (
          <div style={{ flex: fillHeight ? 1 : undefined, minHeight: 0, position: 'relative' }}>
            <ReactECharts
              ref={echartsRef}
              option={echartsOption}
              opts={ECHARTS_OPTS}
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
