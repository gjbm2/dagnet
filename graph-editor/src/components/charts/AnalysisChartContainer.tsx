import React, { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import ReactECharts from 'echarts-for-react';
import {
  ExternalLink, Download, RefreshCcw, Trash2, MoreHorizontal, Sliders,
  BarChart3, LineChart, TrendingUp, Percent, Hash,
  List, ArrowUpDown, ArrowLeftRight, Sigma,
  Zap, Lock, Crosshair, Settings2, ChevronDown, Plus,
} from 'lucide-react';

import type { AnalysisResult, AvailableAnalysis } from '../../lib/graphComputeClient';
import { getDisplaySettings, getDisplaySettingsForSurface, resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';
import type { DisplaySettingDef } from '../../lib/analysisDisplaySettingsRegistry';
import { buildChartOption } from '../../services/analysisEChartsService';
import { augmentChartKindOptionsForAnalysisType, planChartDisplay } from '../../services/chartDisplayPlanningService';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { useElementSize } from '../../hooks/useElementSize';
import { getAnalysisTypeMeta } from '../panels/analysisTypes';
import { AnalysisTypeCardList } from '../panels/AnalysisTypeCardList';
import { ScenarioLayerList } from '../panels/ScenarioLayerList';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import { ChartFloatingIcon } from './ChartInlineSettingsFloating';
import { logChartReadinessTrace } from '../../lib/snapshotBootTrace';

const CHECKBOX_ICONS: Record<string, React.ComponentType<{ size?: number | string }>> = {
  show_legend: List,
  show_trend_line: TrendingUp,
  cumulative: Sigma,
};

const OPTION_ICONS: Record<string, Record<string, React.ComponentType<{ size?: number | string }>>> = {
  series_type: { bar: BarChart3, line: LineChart },
  metric_mode: { proportional: Percent, absolute: Hash },
  orientation: { vertical: ArrowUpDown, horizontal: ArrowLeftRight },
};

const OPTION_SHORT_LABELS: Record<string, Record<string, string>> = {
  time_grouping: { day: 'D', week: 'W', month: 'M' },
  stack_mode: { grouped: 'Grp', stacked: 'Stk', stacked_100: '100%' },
  funnel_metric: { cumulative_probability: 'Cum', step_probability: 'Step' },
  metric: { cumulative_probability: 'Cum', step_probability: 'Step' },
};

function renderTrayCheckbox(
  setting: DisplaySettingDef,
  value: any,
  onChange: (key: string, val: any) => void,
) {
  const Icon = CHECKBOX_ICONS[setting.key];
  return (
    <button
      key={setting.key}
      type="button"
      className={`cfp-pill${value ? ' active' : ''}`}
      onClick={() => onChange(setting.key, !value)}
      title={setting.label}
    >
      {Icon ? <Icon size={13} /> : setting.label}
    </button>
  );
}

function renderTrayRadio(
  setting: DisplaySettingDef,
  value: any,
  onChange: (key: string, val: any) => void,
) {
  if (!setting.options) return null;
  const icons = OPTION_ICONS[setting.key];
  const shorts = OPTION_SHORT_LABELS[setting.key];

  if (setting.options.length > 3 && !icons && !shorts) {
    return (
      <select
        key={setting.key}
        value={value ?? ''}
        onChange={e => onChange(setting.key, e.target.value)}
        className="cfp-select"
        title={setting.label}
      >
        {setting.options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }

  const groupLabel = setting.shortLabel || setting.label;
  return (
    <span key={setting.key} className="cfp-pill-group" title={setting.label}>
      <span className="cfp-group-label">{groupLabel}</span>
      {setting.options.map(opt => {
        const Icon = icons?.[opt.value];
        const short = shorts?.[opt.value];
        return (
          <button
            key={opt.value}
            type="button"
            className={`cfp-pill${value === opt.value ? ' active' : ''}`}
            onClick={() => onChange(setting.key, opt.value)}
            title={`${setting.label}: ${opt.label}`}
          >
            {Icon ? <Icon size={13} /> : (short || opt.label)}
          </button>
        );
      })}
    </span>
  );
}

function renderTraySetting(
  setting: DisplaySettingDef,
  display: Record<string, unknown> | undefined,
  onChange: (key: string, val: any) => void,
) {
  const value = resolveDisplaySetting(display, setting);
  if (setting.type === 'checkbox') return renderTrayCheckbox(setting, value, onChange);
  if (setting.type === 'radio') return renderTrayRadio(setting, value, onChange);
  return null;
}

function CfpPopover({ icon, title, label, children, active, activeColour, onClick }: {
  icon: React.ReactNode;
  title: string;
  label?: string;
  children: React.ReactNode;
  active?: boolean;
  activeColour?: string;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setOpen(true);
  }, []);

  const scheduleHide = useCallback(() => {
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const anchor = wrapRef.current.getBoundingClientRect();
    const GAP = 4;
    const popH = popRef.current?.offsetHeight ?? 180;
    const popW = popRef.current?.offsetWidth ?? 180;
    const flipY = anchor.bottom + GAP + popH > window.innerHeight && anchor.top - GAP - popH > 0;
    const top = flipY ? anchor.top - GAP - popH : anchor.bottom + GAP;
    let left = anchor.right - popW;
    if (left < 4) left = 4;
    if (left + popW > window.innerWidth - 4) left = window.innerWidth - 4 - popW;
    setPos({ position: 'fixed', top, left, right: undefined, bottom: undefined });
  }, [open]);

  const isActive = active || open;

  return (
    <span
      ref={wrapRef}
      className="cfp-popover-anchor"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <button
        type="button"
        className={`cfp-pill${isActive ? ' active' : ''}`}
        style={activeColour ? { color: activeColour } : undefined}
        title={title}
        onClick={onClick}
      >
        {icon}
        {label && <span className="cfp-group-label" style={{ padding: '0 0 0 2px' }}>{label}</span>}
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="cfp-popover"
          style={pos}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}

type ChartKind = 'funnel' | 'bridge' | 'histogram' | 'daily_conversions' | 'cohort_maturity' | 'lag_fit' | 'bar_grouped' | 'pie' | 'time_series';

function normaliseChartKind(kind: string | undefined | null): ChartKind | null {
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
  compactControls?: boolean;
  onChartKindChange?: (chartKind: string | undefined) => void;
  display?: Record<string, unknown>;
  onDisplayChange?: (key: string, value: any) => void;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  hideChrome?: boolean;
  hideScenarioLegend?: boolean;
  /** Controls which inline settings and actions are shown. 'tab' shows full inline settings + action chrome; 'canvas' shows brief inline settings only. */
  chartContext?: 'canvas' | 'tab';
  /** Current analysis type ID (for canvas header dropdown) */
  analysisTypeId?: string;
  /** Available analyses for the dropdown */
  availableAnalyses?: AvailableAnalysis[];
  /** Callback when user changes analysis type via the header dropdown */
  onAnalysisTypeChange?: (analysisTypeId: string) => void;
  /** Whether the analysis is in live mode (vs custom/frozen) */
  analysisLive?: boolean;
  /** Toggle live/custom mode */
  onLiveToggle?: (live: boolean) => void;
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
}): JSX.Element | null {
  const { result, chartKindOverride, visibleScenarioIds, scenarioVisibilityModes, scenarioMetaById, scenarioDslSubtitleById, height = 420, fillHeight = false, compactControls = false, display, onDisplayChange, source, hideChrome = false } = props;
  const chartContext = props.chartContext || (compactControls ? 'canvas' : 'tab');
  const showActionChrome = chartContext === 'tab' && !hideChrome;
  const hideScenarioLegend = props.hideScenarioLegend ?? false;
  const showInlineAnalysisTypePicker = chartContext === 'canvas' && !props.analysisTypeId && !!props.onAnalysisTypeChange;
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

  const inferredChartKind = useMemo((): ChartKind | null => {
    if (!patchedResult) return null;
    const t = (patchedResult as any)?.analysis_type;
    if (t === 'conversion_funnel') return 'funnel';
    if (t === 'lag_histogram') return 'histogram';
    if (t === 'daily_conversions') return 'daily_conversions';
    if (t === 'cohort_maturity') return 'cohort_maturity';
    if (t === 'lag_fit') return 'lag_fit';
    if (typeof t === 'string' && t.includes('bridge')) return 'bridge';
    return 'bridge';
  }, [patchedResult]);

  const availableChartKinds = useMemo((): ChartKind[] => {
    if (!patchedResult) return [];
    const spec: any = patchedResult?.semantics?.chart;
    const rec = normaliseChartKind(spec?.recommended);
    const alts = Array.isArray(spec?.alternatives) ? spec.alternatives : [];
    const augmented = augmentChartKindOptionsForAnalysisType(patchedResult?.analysis_type, [spec?.recommended, ...alts].filter(Boolean) as string[]);
    const altKinds = augmented.slice(1).map(normaliseChartKind).filter(Boolean) as ChartKind[];
    const augmentedRec = normaliseChartKind(augmented[0] || spec?.recommended);
    const all = [augmentedRec || rec, ...altKinds].filter(Boolean) as ChartKind[];
    if (all.length === 0 && inferredChartKind) return [inferredChartKind];
    return Array.from(new Set(all));
  }, [patchedResult, inferredChartKind]);

  const [selectedKind, setSelectedKind] = useState<ChartKind | null>(null);
  const normalisedOverride = normaliseChartKind(chartKindOverride);
  const kind = normalisedOverride ?? selectedKind ?? availableChartKinds[0] ?? null;
  const displayPlan = useMemo(() => planChartDisplay({
    result: patchedResult,
    requestedChartKind: kind || chartKindOverride || patchedResult?.semantics?.chart?.recommended,
    visibleScenarioIds,
    scenarioVisibilityModes,
    display,
  }), [patchedResult, kind, chartKindOverride, visibleScenarioIds, scenarioVisibilityModes, display]);
  const effectiveKind = normaliseChartKind(displayPlan.effectiveChartKind || kind);

  const resolvedSettings = useMemo(() => {
    if (!effectiveKind) return {};
    const settings = getDisplaySettings(effectiveKind, 'chart');
    const resolved: Record<string, any> = {};
    for (const s of settings) {
      resolved[s.key] = resolveDisplaySetting(display, s);
    }
    return resolved;
  }, [effectiveKind, display]);

  // Single list of display settings for the unified toolbar.
  // Always fetch the 'tab' surface set — it's the full set.
  // When wide, these render inline as pills; when narrow, they collapse into a popover.
  const toolbarSettings = useMemo((): DisplaySettingDef[] => {
    if (!effectiveKind || !onDisplayChange) return [];
    return getDisplaySettingsForSurface(effectiveKind, 'chart', 'inline', 'tab');
  }, [effectiveKind, onDisplayChange]);

  // Subject selector state for daily_conversions / cohort_maturity
  const subjectIds = useMemo(() => extractSubjectIds(result), [result]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const effectiveSubjectId = (selectedSubjectId && subjectIds.includes(selectedSubjectId))
    ? selectedSubjectId
    : (subjectIds[0] || undefined);
  const showSubjectSelector = (effectiveKind === 'daily_conversions' || effectiveKind === 'cohort_maturity') && subjectIds.length > 1;
  const { ref: chartViewportRef, width: chartWidthPx, height: chartHeightPx } = useElementSize<HTMLDivElement>();

  const echartsOption = useMemo(() => {
    if (!patchedResult) return null;
    if (!effectiveKind) return null;
    const finalSettings = hideScenarioLegend
      ? { ...resolvedSettings, show_legend: false }
      : resolvedSettings;
    return buildChartOption(effectiveKind, patchedResult, finalSettings, {
      visibleScenarioIds: displayPlan.scenarioIdsToRender,
      scenarioVisibilityModes,
      scenarioDslSubtitleById,
      subjectId: effectiveSubjectId,
      layout: {
        widthPx: chartWidthPx > 0 ? chartWidthPx : undefined,
        heightPx: chartHeightPx > 0 ? chartHeightPx : (fillHeight ? undefined : height),
      },
    });
  }, [effectiveKind, patchedResult, resolvedSettings, hideScenarioLegend, displayPlan.scenarioIdsToRender, scenarioVisibilityModes, scenarioDslSubtitleById, effectiveSubjectId, chartWidthPx, chartHeightPx, fillHeight, height]);

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

  const dailyChartStateKey = useMemo(() => {
    if (!isDebugDailyConversions) return null;
    return JSON.stringify({
      analysisId: props.analysisId || null,
      chartContext,
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
    chartContext,
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

  const handleChartReady = useCallback((instance: any) => {
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
  }, [isDebugDailyConversions, props.analysisId]);

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

  // Whether chart is wide enough to auto-expand popovers into inline pills.
  const wideToolbar = chartWidthPx > 480;

  const toolbarTray = (
    <>
      {/* --- Analysis type: popover palette --- */}
      {showAnalysisTypeDropdown && (() => {
        const activeMeta = getAnalysisTypeMeta(props.analysisTypeId!);
        const ActiveIcon = activeMeta?.icon;
        return (
          <CfpPopover
            icon={<>{ActiveIcon && <ActiveIcon size={13} />}<ChevronDown size={9} /></>}
            label={activeMeta?.name}
            title="Analysis type"
          >
            <div className="cfp-type-palette">
              {(props.availableAnalyses || []).map(a => {
                const meta = getAnalysisTypeMeta(a.id);
                const Icon = meta?.icon;
                const active = a.id === props.analysisTypeId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`cfp-type-palette-item${active ? ' active' : ''}`}
                    onClick={() => props.onAnalysisTypeChange?.(a.id)}
                    title={meta?.shortDescription || meta?.name || a.id}
                  >
                    {Icon && <Icon size={22} />}
                    <span className="cfp-type-palette-label">{meta?.name || a.name || a.id}</span>
                  </button>
                );
              })}
            </div>
          </CfpPopover>
        );
      })()}

      {/* --- Separator --- */}
      {showAnalysisTypeDropdown && (showChooser || showSubjectSelector) && <span className="cfp-sep" />}

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
      {onDisplayChange && toolbarSettings.length > 0 && (
        wideToolbar
          ? toolbarSettings.map(s => renderTraySetting(s, display, onDisplayChange))
          : (
            <CfpPopover
              icon={<Sliders size={13} />}
              title="Display"
              label="Display"
            >
              {toolbarSettings.map(s => renderTraySetting(s, display, onDisplayChange))}
            </CfpPopover>
          )
      )}

      {/* --- Overlay toggle with colour picker (canvas only, guarded by prop) --- */}
      {props.onOverlayToggle && (
        <CfpPopover
          icon={<Crosshair size={13} />}
          title="Overlay connectors"
          active={!!props.overlayActive}
          activeColour={props.overlayActive ? props.overlayColour : undefined}
          onClick={() => props.onOverlayToggle!(!props.overlayActive)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0' }}>
            <span className="cfp-group-label">Overlay</span>
            {['#f59e0b', '#3b82f6', '#22c55e', '#ef4444', '#8b5cf6', '#ec4899'].map(c => (
              <button
                key={c}
                type="button"
                className="cfp-colour-swatch"
                style={{
                  background: c,
                  outline: props.overlayActive && props.overlayColour === c ? '2px solid var(--text-primary)' : undefined,
                  outlineOffset: 1,
                }}
                onClick={() => props.onOverlayColourChange?.(c)}
                title={`Overlay: ${c}`}
              />
            ))}
            <button
              type="button"
              className="cfp-colour-swatch cfp-colour-swatch--none"
              style={{
                outline: !props.overlayActive ? '2px solid var(--text-primary)' : undefined,
                outlineOffset: 1,
              }}
              onClick={() => props.onOverlayColourChange?.(null)}
              title="No overlay"
            >
              ✕
            </button>
          </div>
        </CfpPopover>
      )}

      {/* --- Scenarios popover (canvas only, guarded by prop) --- */}
      {props.onLiveToggle && (
        <CfpPopover
          icon={<>{props.analysisLive ? <Zap size={13} /> : <Lock size={13} />}<ChevronDown size={9} /></>}
          label={props.analysisLive ? 'Live' : 'Custom'}
          title={props.analysisLive ? 'Live — tracking tab scenarios' : 'Custom — frozen scenarios'}
        >
          <div className="cfp-scenario-popover">
            {/* Live/Custom toggle row — ON = Custom, matching PropertiesPanel convention */}
            <div className="cfp-scenario-popover__toggle-row">
              <div
                className="cfp-lc-toggle"
                onClick={() => props.onLiveToggle!(!props.analysisLive)}
                title={props.analysisLive ? 'Live — click for Custom' : 'Custom — click for Live'}
              >
                <span className={`cfp-lc-toggle__label${props.analysisLive ? ' active' : ''}`}>Live</span>
                <span className={`cfp-lc-toggle__track${!props.analysisLive ? ' on' : ''}`}>
                  <span className="cfp-lc-toggle__thumb" />
                </span>
                <span className={`cfp-lc-toggle__label${!props.analysisLive ? ' active' : ''}`}>Custom</span>
              </div>
            </div>
            {/* Scenario layers */}
            {props.scenarioLayerItems && props.scenarioLayerItems.length > 0 && (
              <ScenarioLayerList
                items={props.scenarioLayerItems}
                containerClassName="cfp-scenario-popover__list"
                onToggleVisibility={props.onScenarioToggleVisibility}
                onCycleMode={props.onScenarioCycleMode}
                onColourChange={props.onScenarioColourChange}
                getSwatchOverlayStyle={props.getScenarioSwatchOverlayStyle}
              />
            )}
            {/* Add scenario button */}
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
      )}

      {/* --- Open Properties (canvas only, guarded by prop) --- */}
      {chartContext === 'canvas' && (
        <button
          type="button"
          className="cfp-pill"
          onClick={() => {
            if (props.analysisId) {
              window.dispatchEvent(new CustomEvent('dagnet:openAnalysisProperties', { detail: { analysisId: props.analysisId } }));
            } else {
              window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
            }
          }}
          title="Open Properties"
        >
          <Settings2 size={13} />
        </button>
      )}

      {/* --- Inline action chrome (wide only) --- */}
      {showActionChrome && wideToolbar && (
        <>
          <span className="cfp-sep" />
          <button
            type="button"
            className="cfp-pill"
            onClick={() => {
              if (!result) return;
              const { filename, csv } = analysisResultToCsv(result);
              if (csv) downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
            }}
            title="Download CSV"
          >
            <Download size={12} />
          </button>
          <button
            type="button"
            className="cfp-pill"
            onClick={() => {
              if (!kind || !result) return;
              chartOperationsService.openAnalysisChartTabFromAnalysis({
                chartKind: kind as any,
                analysisResult: result,
                scenarioIds: visibleScenarioIds,
                source,
              });
            }}
            title="Open as Tab"
          >
            <ExternalLink size={12} />
          </button>
        </>
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
        {kind && result && (
          <button
            type="button"
            className="cfp-menu-item"
            onClick={() => {
              chartOperationsService.openAnalysisChartTabFromAnalysis({
                chartKind: kind as any,
                analysisResult: result,
                scenarioIds: visibleScenarioIds,
                source,
              });
            }}
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
      {/* Tab toolbar — static bar using the unified tray content */}
      {chartContext !== 'canvas' && !hideChrome && (
        <div className="cfp-tab-toolbar">
          {toolbarTray}
        </div>
      )}

      <div style={{ flex: fillHeight ? 1 : undefined, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {chartContext === 'canvas' && (
          <ChartFloatingIcon
            containerRef={chartViewportRef}
            tray={toolbarTray}
            canvasZoom={props.canvasZoom}
          />
        )}
        <div
          ref={chartViewportRef}
          data-chart-viewport
          style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
        {echartsOption ? (
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
        ) : (
          <div style={{ padding: '24px 16px', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center' }}>
            <p style={{ marginBottom: 8, fontWeight: 600, color: 'var(--text-primary)' }}>No data available</p>
            <p style={{ margin: 0 }}>
              {(result as any)?.metadata?.empty_reason
                || 'The analysis returned no data for the current selection. Check query DSL, scenario visibility, and date range.'}
            </p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
