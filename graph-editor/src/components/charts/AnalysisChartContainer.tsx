import React, { useMemo, useState, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import { ExternalLink, Download } from 'lucide-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { getDisplaySettings, resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';
import { buildChartOption } from '../../services/analysisEChartsService';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';

type ChartKind = 'funnel' | 'bridge' | 'bridge_horizontal' | 'histogram' | 'daily_conversions' | 'cohort_maturity';

function normaliseChartKind(kind: string | undefined | null): ChartKind | null {
  if (!kind) return null;
  if (kind === 'funnel') return 'funnel';
  if (kind === 'bridge') return 'bridge';
  if (kind === 'bridge_horizontal') return 'bridge_horizontal';
  if (kind === 'histogram' || kind === 'lag_histogram') return 'histogram';
  if (kind === 'daily_conversions') return 'daily_conversions';
  if (kind === 'cohort_maturity') return 'cohort_maturity';
  return null;
}

function labelForChartKind(kind: ChartKind): string {
  if (kind === 'funnel') return 'Funnel';
  if (kind === 'bridge') return 'Bridge';
  if (kind === 'bridge_horizontal') return 'Bridge (Horizontal)';
  if (kind === 'histogram') return 'Lag Histogram';
  if (kind === 'daily_conversions') return 'Daily Conversions';
  if (kind === 'cohort_maturity') return 'Cohort Maturity';
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
}): JSX.Element | null {
  const { result, chartKindOverride, visibleScenarioIds, scenarioVisibilityModes, scenarioMetaById, scenarioDslSubtitleById, height = 420, fillHeight = false, compactControls = false, display, onDisplayChange, source, hideChrome = false } = props;
  const showChrome = !hideChrome && !compactControls;
  const hideScenarioLegend = props.hideScenarioLegend ?? compactControls;

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
      <div style={{ padding: 12, color: '#6b7280' }}>
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
        gap: 8,
        minHeight: 0,
        height: fillHeight ? '100%' : undefined,
        position: fillHeight ? 'relative' : undefined,
      }}
    >
      {(showChooser || showSubjectSelector) ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: compactControls ? 'nowrap' : 'wrap' }}>
          {showChooser ? (
            <>
              {!compactControls ? <span style={{ fontSize: 11, color: '#6b7280' }}>Chart</span> : null}
              {availableChartKinds.length <= 2 ? (
                availableChartKinds.map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSelectedKind(k)}
                    style={{
                      border: '1px solid #e5e7eb',
                      background: k === kind ? '#f3f4f6' : '#ffffff',
                      color: '#374151',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                    title={labelForChartKind(k)}
                  >
                    {labelForChartKind(k)}
                  </button>
                ))
              ) : (
                <select
                  value={kind}
                  onChange={e => setSelectedKind(e.target.value as ChartKind)}
                  style={{
                    border: '1px solid #e5e7eb',
                    background: '#ffffff',
                    color: '#374151',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
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
              {!compactControls ? <span style={{ fontSize: 11, color: '#6b7280', marginLeft: showChooser ? 8 : 0 }}>Subject</span> : null}
              <select
                value={effectiveSubjectId || ''}
                onChange={handleSubjectChange}
                style={{
                  border: '1px solid #e5e7eb',
                  background: '#ffffff',
                  color: '#374151',
                  borderRadius: 6,
                  padding: '4px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
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

      {showChrome && echartsOption && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', padding: '0 4px' }}>
          <button
            type="button"
            onClick={() => {
              const { filename, csv } = analysisResultToCsv(result);
              if (csv) downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 2, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}
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
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 2, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}
            title="Open as Tab"
          >
            <ExternalLink size={12} /> Open as Tab
          </button>
        </div>
      )}

      <div style={{ minHeight: 0, ...(fillHeight ? { position: 'absolute' as const, inset: 0 } : {}) }}>
        {echartsOption ? (
          <ReactECharts
            option={echartsOption}
            style={{ height: fillHeight ? '100%' : height, width: '100%' }}
            notMerge
            onEvents={onEvents}
          />
        ) : (
          <div style={{ padding: '24px 16px', color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
            <p style={{ marginBottom: 8, fontWeight: 600, color: '#374151' }}>No data available</p>
            <p style={{ margin: 0 }}>
              The analysis returned no data for the current selection. Check query DSL, scenario visibility, and date range.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
