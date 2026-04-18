import type { AnalysisResult } from '../lib/graphComputeClient';

export type ChartXAxisMode = 'time' | 'scenario' | 'category' | 'stage';
export type ChartScenarioSelectionMode = 'all_visible' | 'current_only' | 'explicit_single';
export type ChartMetricBasis = 'blended_probability' | 'forecast_probability' | 'evidence_probability' | 'absolute_k';
export type ChartFERenderingMode = 'none' | 'blended_single_series' | 'split_fe_stack';

export interface ChartDisplayPlan {
  requestedChartKind?: string;
  effectiveChartKind?: string;
  xAxisMode: ChartXAxisMode;
  scenarioIdsToRender: string[];
  scenarioSelectionMode: ChartScenarioSelectionMode;
  metricBasis: ChartMetricBasis;
  feRenderingMode: ChartFERenderingMode;
  fallbackReasons: string[];
}

export interface PlanChartDisplayArgs {
  result: AnalysisResult | null | undefined;
  requestedChartKind?: string;
  visibleScenarioIds: string[];
  scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
  display?: Record<string, unknown>;
}

export function augmentChartKindOptionsForAnalysisType(
  analysisType: string | null | undefined,
  options: string[],
): string[] {
  const out = [...options];
  if ((analysisType === 'branch_comparison' || analysisType === 'outcome_comparison') && !out.includes('time_series')) {
    out.push('time_series');
  }
  return out;
}

const TIME_SERIES_KINDS = new Set(['daily_conversions', 'conversion_rate', 'cohort_maturity', 'lag_fit', 'time_series']);
const PIE_KINDS = new Set(['pie']);

function metricIds(result: AnalysisResult | null | undefined): Set<string> {
  return new Set((result?.semantics?.metrics || []).map(m => m.id));
}

function inferMetricBasis(args: PlanChartDisplayArgs, scenarioIdsToRender: string[]): ChartMetricBasis {
  const mode = typeof args.display?.metric_mode === 'string' ? String(args.display.metric_mode) : null;
  if (mode === 'absolute') return 'absolute_k';

  const firstScenarioId = scenarioIdsToRender[0];
  const visibilityMode = firstScenarioId ? (args.scenarioVisibilityModes?.[firstScenarioId] || 'f+e') : 'f+e';
  if (visibilityMode === 'f') return 'forecast_probability';
  if (visibilityMode === 'e') return 'evidence_probability';
  return 'blended_probability';
}

export function planChartDisplay(args: PlanChartDisplayArgs): ChartDisplayPlan {
  const fallbackReasons: string[] = [];
  const requestedChartKind = args.requestedChartKind || args.result?.semantics?.chart?.recommended;
  let effectiveChartKind = requestedChartKind;

  let xAxisMode: ChartXAxisMode = 'category';
  if (requestedChartKind === 'bridge') xAxisMode = 'stage';
  else if (TIME_SERIES_KINDS.has(requestedChartKind || '')) xAxisMode = 'time';
  else if (PIE_KINDS.has(requestedChartKind || '')) xAxisMode = 'category';
  else if ((args.visibleScenarioIds?.length || 0) > 1) xAxisMode = 'scenario';

  let scenarioIdsToRender = [...(args.visibleScenarioIds || [])];
  let scenarioSelectionMode: ChartScenarioSelectionMode = 'all_visible';

  // Cohort maturity supports multi-scenario overlay natively (per-scenario series
  // with distinct colours). Other time-series charts (daily_conversions, lag_fit)
  // only render one scenario at a time.
  const multiScenarioTimeSeriesKinds = new Set(['cohort_maturity', 'daily_conversions', 'conversion_rate']);
  if (xAxisMode === 'time' && scenarioIdsToRender.length > 1
      && !multiScenarioTimeSeriesKinds.has(requestedChartKind || '')) {
    const lastScenarioId = scenarioIdsToRender[scenarioIdsToRender.length - 1];
    scenarioIdsToRender = lastScenarioId ? [lastScenarioId] : scenarioIdsToRender.slice(0, 1);
    scenarioSelectionMode = 'current_only';
    fallbackReasons.push('Time-series charts default to the last visible scenario when multiple scenarios are visible.');
  } else if (scenarioIdsToRender.length === 1) {
    scenarioSelectionMode = 'explicit_single';
  }

  if (PIE_KINDS.has(requestedChartKind || '') && scenarioIdsToRender.length > 1) {
    effectiveChartKind = 'bar_grouped';
    xAxisMode = 'scenario';
    fallbackReasons.push('Pie charts are restricted to a single scenario; falling back to scenario comparison.');
  }

  const mids = metricIds(args.result);
  const hasEvidence = mids.has('evidence_mean') || mids.has('evidence_k');
  const hasForecast = mids.has('forecast_mean') || mids.has('forecast_k');
  const allFERendered = scenarioIdsToRender.length > 0
    && scenarioIdsToRender.every(sid => (args.scenarioVisibilityModes?.[sid] || 'f+e') === 'f+e');
  const metricBasis = inferMetricBasis(args, scenarioIdsToRender);
  const feRenderingMode: ChartFERenderingMode = allFERendered && hasEvidence && hasForecast
    ? 'split_fe_stack'
    : (scenarioIdsToRender.some(sid => (args.scenarioVisibilityModes?.[sid] || 'f+e') === 'f+e') ? 'blended_single_series' : 'none');

  return {
    requestedChartKind,
    effectiveChartKind,
    xAxisMode,
    scenarioIdsToRender,
    scenarioSelectionMode,
    metricBasis,
    feRenderingMode,
    fallbackReasons,
  };
}
