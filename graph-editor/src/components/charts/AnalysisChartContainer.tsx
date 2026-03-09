import React, { useMemo, useState, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import { ExternalLink, Download } from 'lucide-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { getDisplaySettings, getDisplaySettingsForSurface, resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';
import type { DisplaySettingDef } from '../../lib/analysisDisplaySettingsRegistry';
import { buildChartOption } from '../../services/analysisEChartsService';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';

type ChartKind = 'funnel' | 'bridge' | 'histogram' | 'daily_conversions' | 'cohort_maturity' | 'lag_fit';

function normaliseChartKind(kind: string | undefined | null): ChartKind | null {
  if (!kind) return null;
  if (kind === 'funnel') return 'funnel';
  if (kind === 'bridge' || kind === 'bridge_horizontal') return 'bridge';
  if (kind === 'histogram' || kind === 'lag_histogram') return 'histogram';
  if (kind === 'daily_conversions') return 'daily_conversions';
  if (kind === 'cohort_maturity') return 'cohort_maturity';
  if (kind === 'lag_fit') return 'lag_fit';
  return null;
}

function labelForChartKind(kind: ChartKind): string {
  if (kind === 'funnel') return 'Funnel';
  if (kind === 'bridge') return 'Bridge';
  if (kind === 'histogram') return 'Lag Histogram';
  if (kind === 'daily_conversions') return 'Daily Conversions';
  if (kind === 'cohort_maturity') return 'Cohort Maturity';
  if (kind === 'lag_fit') return 'Lag Fit';
  return kind;
}

function extractSubjectIds(result: AnalysisResult): string[] {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  const s = new Set<string>();
  for (const r of rows) if (r?.subject_id) s.add(String(r.subject_id));
  return Array.from(s);
}

export function AnalysisChartContainer(props: {
  result: AnalysisResult;
  chartKindOverride?: string;
  visibleScenarioIds: string[];
  scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
  scenarioMetaById?: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }>;
  scenarioDslSubtitleById?: Record<string, string>;
  height?: number;
  fillHeight?: boolean;
  compactControls?: boolean;
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
}): JSX.Element | null {
  const { result, chartKindOverride, visibleScenarioIds, scenarioVisibilityModes, scenarioMetaById, scenarioDslSubtitleById, height = 420, fillHeight = false, compactControls = false, display, onDisplayChange, source, hideChrome = false } = props;
  const chartContext = props.chartContext || (compactControls ? 'canvas' : 'tab');
  const showActionChrome = chartContext === 'tab' && !hideChrome;
  const hideScenarioLegend = props.hideScenarioLegend ?? false;

  const patchedResult = useMemo(() => {
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
    const spec: any = patchedResult?.semantics?.chart;
    const rec = normaliseChartKind(spec?.recommended);
    const alts = Array.isArray(spec?.alternatives) ? spec.alternatives : [];
    const altKinds = alts.map(normaliseChartKind).filter(Boolean) as ChartKind[];
    const all = [rec, ...altKinds].filter(Boolean) as ChartKind[];
    if (all.length === 0 && inferredChartKind) return [inferredChartKind];
    return Array.from(new Set(all));
  }, [patchedResult, inferredChartKind]);

  const [selectedKind, setSelectedKind] = useState<ChartKind | null>(null);
  const normalisedOverride = normaliseChartKind(chartKindOverride);
  const kind = normalisedOverride ?? selectedKind ?? availableChartKinds[0] ?? null;

  const resolvedSettings = useMemo(() => {
    if (!kind) return {};
    const settings = getDisplaySettings(kind, 'chart');
    const resolved: Record<string, any> = {};
    for (const s of settings) {
      resolved[s.key] = resolveDisplaySetting(display, s);
    }
    return resolved;
  }, [kind, display]);

  const inlineSettings = useMemo((): DisplaySettingDef[] => {
    if (!kind || !onDisplayChange) return [];
    return getDisplaySettingsForSurface(kind, 'chart', 'inline', chartContext);
  }, [kind, chartContext, onDisplayChange]);

  // Subject selector state for daily_conversions / cohort_maturity
  const subjectIds = useMemo(() => extractSubjectIds(result), [result]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const effectiveSubjectId = (selectedSubjectId && subjectIds.includes(selectedSubjectId))
    ? selectedSubjectId
    : (subjectIds[0] || undefined);
  const showSubjectSelector = (kind === 'daily_conversions' || kind === 'cohort_maturity') && subjectIds.length > 1;

  const echartsOption = useMemo(() => {
    if (!kind) return null;
    const finalSettings = hideScenarioLegend
      ? { ...resolvedSettings, show_legend: false }
      : resolvedSettings;
    return buildChartOption(kind, patchedResult, finalSettings, {
      visibleScenarioIds,
      scenarioVisibilityModes,
      scenarioDslSubtitleById,
      subjectId: effectiveSubjectId,
    });
  }, [kind, patchedResult, resolvedSettings, hideScenarioLegend, visibleScenarioIds, scenarioVisibilityModes, scenarioDslSubtitleById, effectiveSubjectId]);

  const onEvents = useMemo(() => ({}), []);

  const handleSubjectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedSubjectId(e.target.value);
  }, []);

  if (!kind) {
    return (
      <div style={{ padding: 12, color: 'var(--text-secondary)' }}>
        No chart available for this analysis.
      </div>
    );
  }

  const showChooser = availableChartKinds.length > 1;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: fillHeight ? '100%' : undefined,
      }}
    >
      {(showChooser || showSubjectSelector) ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0, padding: '4px 4px 0' }}>
          {showChooser ? (
            <>
              {!compactControls ? <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Chart</span> : null}
              {availableChartKinds.length <= 2 ? (
                availableChartKinds.map(k => (
                  <button
                    key={k}
                    type="button"
                    className="chart-container-btn"
                    onClick={() => setSelectedKind(k)}
                    style={k === kind ? { background: 'var(--bg-tertiary)' } : undefined}
                    title={labelForChartKind(k)}
                  >
                    {labelForChartKind(k)}
                  </button>
                ))
              ) : (
                <select
                  value={kind}
                  onChange={e => setSelectedKind(e.target.value as ChartKind)}
                  className="chart-container-select"
                  aria-label="Chart type"
                >
                  {availableChartKinds.map(k => (
                    <option key={k} value={k}>
                      {labelForChartKind(k)}
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : null}

          {showSubjectSelector ? (
            <>
              {!compactControls ? <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: showChooser ? 8 : 0 }}>Subject</span> : null}
              <select
                value={effectiveSubjectId || ''}
                onChange={handleSubjectChange}
                className="chart-container-select"
                aria-label="Subject"
              >
                {subjectIds.map(sid => {
                  const meta = (result?.dimension_values as any)?.subject_id?.[sid];
                  return (
                    <option key={sid} value={sid}>
                      {meta?.name || sid}
                    </option>
                  );
                })}
              </select>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Inline settings + action chrome */}
      {echartsOption && (inlineSettings.length > 0 || showActionChrome) && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 4px 0', flexWrap: 'wrap', flexShrink: 0 }}>
          {/* Inline settings from registry */}
          {inlineSettings.map(setting => {
            const currentValue = resolveDisplaySetting(display, setting);
            if (setting.type === 'checkbox') {
              return (
                <button
                  key={setting.key}
                  type="button"
                  className={`chart-container-btn${currentValue ? ' active' : ''}`}
                  onClick={() => onDisplayChange?.(setting.key, !currentValue)}
                  title={setting.label}
                >
                  {setting.label}
                </button>
              );
            }
            if (setting.type === 'radio' && setting.options) {
              return (
                <span key={setting.key} style={{ display: 'inline-flex', gap: 1 }}>
                  {setting.options.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`chart-container-btn${currentValue === opt.value ? ' active' : ''}`}
                      onClick={() => onDisplayChange?.(setting.key, opt.value)}
                      title={`${setting.label}: ${opt.label}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </span>
              );
            }
            return null;
          })}

          {/* Spacer to push actions to the right */}
          {showActionChrome && <span style={{ flex: 1 }} />}

          {/* Action chrome (tab mode only) */}
          {showActionChrome && (
            <>
              <button
                type="button"
                onClick={() => {
                  const { filename, csv } = analysisResultToCsv(result);
                  if (csv) downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
                }}
                className="chart-container-link-btn"
                title="Download CSV"
              >
                <Download size={12} /> CSV
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!kind) return;
                  chartOperationsService.openAnalysisChartTabFromAnalysis({
                    chartKind: kind as any,
                    analysisResult: result,
                    scenarioIds: visibleScenarioIds,
                    source,
                  });
                }}
                className="chart-container-link-btn"
                title="Open as Tab"
              >
                <ExternalLink size={12} /> Open as Tab
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ flex: fillHeight ? 1 : undefined, minHeight: 0 }}>
        {echartsOption ? (
          <ReactECharts
            option={echartsOption}
            style={{ height: fillHeight ? '100%' : height, width: '100%' }}
            notMerge
            onEvents={onEvents}
          />
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
  );
}
