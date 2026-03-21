/**
 * AnalysisInfoCard — custom renderer for node_info / edge_info analysis results.
 *
 * Renders structured sections with key-value pairs using a single HTML <table>
 * so columns align across all sections. Supports multi-scenario columns with
 * per-scenario colouring. Identical cross-scenario values collapse to a single cell.
 *
 * When data rows include a `tab` field, renders a tabbed layout using TabbedContainer.
 * Each tab shows its own sections/rows. The defaultTab prop (driven by view overlay mode)
 * controls which tab is visible initially.
 */

import React, { useMemo, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import type { AnalysisResult } from '../../lib/graphComputeClient';
import { fontSizeZoom } from '../../lib/analysisDisplaySettingsRegistry';
import { TabbedContainer, type TabDefinition } from '../shared/TabbedContainer';
import { freshnessColour, type FreshnessLevel } from '../../utils/freshnessDisplay';
import { objectTypeTheme, type ObjectType } from '../../theme/objectTypeTheme';
import '../../styles/analysis-info-card.css';

interface AnalysisInfoCardProps {
  result: AnalysisResult;
  /** Font size: numeric px, or legacy preset 'S'/'M'/'L'/'XL'. */
  fontSize?: number | string;
  /** Default tab to show (driven by view overlay mode). */
  defaultTab?: string;
  /** Callback when a file link is clicked (fileId, objectType). */
  onFileLink?: (fileId: string, type: string) => void;
  /** Extra React content to append after a specific tab's table. Keyed by tab ID. */
  tabExtra?: Record<string, React.ReactNode>;
  /**
   * When set, filter data rows to only those matching this tab/facet ID.
   * Renders flat (no tab bar) — the tab bar lives at the container level.
   * Used by multi-content-item containers where each content item shows one facet.
   */
  facet?: string;
}

interface RowData {
  property: string;
  /** Single value (no scenarios or all scenarios identical) */
  value?: string;
  /** Per-scenario values: { scenarioId → value } */
  scenarioValues?: Record<string, string>;
  detail?: string;
  /** Freshness level for colour-coding the value */
  freshness?: string;
  /** File link — when present, value renders as icon + clickable text */
  link?: { type: string; fileId: string };
}

interface SectionData {
  title: string;
  rows: RowData[];
}

// Tab display names
const TAB_LABELS: Record<string, string> = {
  overview: 'Overview',
  structure: 'Structure',
  evidence: 'Evidence',
  forecast: 'Forecast',
  depth: 'Data Depth',
  diagnostics: 'Diagnostics',
};

// Tabs where per-scenario columns make sense (values actually differ by scenario).
// Other tabs show a single value column even in multi-scenario mode.
const SCENARIO_AWARE_TABS = new Set(['overview', 'structure']);

export function AnalysisInfoCard({ result, fontSize, defaultTab, onFileLink, tabExtra, facet }: AnalysisInfoCardProps) {
  const sizeZoom = fontSizeZoom(fontSize);
  const allData = result.data || [];
  // When facet is set, filter to only rows matching that tab — renders flat (no tab bar).
  const data = facet ? allData.filter((row: any) => row.tab === facet) : allData;

  // Detect tabs: rows with a `tab` field
  const tabIds = useMemo(() => {
    const seen: string[] = [];
    for (const row of data) {
      if (row.tab && !seen.includes(row.tab)) {
        seen.push(row.tab);
      }
    }
    return seen;
  }, [data]);

  const hasTabs = tabIds.length > 1;

  // Detect scenarios (same as before)
  const { scenarioIds, scenarioMeta } = useMemo(() => {
    const hasScenarios = data.some(row => row.scenario_id !== undefined);
    const scIds: string[] = [];
    const scMeta: Record<string, { name: string; colour?: string }> = {};
    if (hasScenarios) {
      for (const row of data) {
        if (row.scenario_id && !scIds.includes(row.scenario_id)) {
          scIds.push(row.scenario_id);
          const dimVal = result.dimension_values?.scenario_id?.[row.scenario_id];
          scMeta[row.scenario_id] = {
            name: dimVal?.name || row.scenario_id,
            colour: dimVal?.colour,
          };
        }
      }
    }
    return { scenarioIds: scIds, scenarioMeta: scMeta };
  }, [data, result.dimension_values]);

  // Build sections per tab — MUST be unconditional (before early returns) to
  // keep hook count stable. Skips work when hasTabs is false.
  const sectionsByTab = useMemo(() => {
    if (!hasTabs) return {};
    const result_: Record<string, SectionData[]> = {};
    for (const tabId of tabIds) {
      const tabRows = data.filter(row => row.tab === tabId);
      const isScenarioAware = SCENARIO_AWARE_TABS.has(tabId);
      result_[tabId] = buildSections(
        tabRows,
        isScenarioAware ? scenarioIds : [],
        isScenarioAware ? scenarioMeta : {},
      );
    }
    return result_;
  }, [hasTabs, data, tabIds, scenarioIds, scenarioMeta]);

  if (data.length === 0) {
    return <div className="info-card-empty">No data</div>;
  }

  if (!hasTabs) {
    // No tabs — render flat (single tab, faceted view, or no tab field at all)
    const sections = buildSections(data, scenarioIds, scenarioMeta, result.dimension_values);
    const extra = facet ? tabExtra?.[facet] : undefined;
    return (
      <div className="info-card" style={sizeZoom !== 1 ? { zoom: sizeZoom } as any : undefined}>
        <InfoTable sections={sections} scenarioIds={scenarioIds} scenarioMeta={scenarioMeta} onFileLink={onFileLink} />
        {extra}
      </div>
    );
  }

  // Tabbed layout
  const tabs: TabDefinition[] = tabIds.map(id => ({
    id,
    label: TAB_LABELS[id] || id,
  }));

  const latencyCdfMeta = (result as any).metadata?.latency_cdf;

  const panels: Record<string, React.ReactNode> = {};
  for (const tabId of tabIds) {
    const isScenarioAware = SCENARIO_AWARE_TABS.has(tabId);
    const extra = tabExtra?.[tabId];
    panels[tabId] = (
      <>
        <InfoTable
          sections={sectionsByTab[tabId] || []}
          scenarioIds={isScenarioAware ? scenarioIds : []}
          scenarioMeta={isScenarioAware ? scenarioMeta : {}}
          onFileLink={onFileLink}
        />
        {tabId === 'latency' && latencyCdfMeta && (
          <LatencyCdfTab edge={latencyCdfMeta.edge} path={latencyCdfMeta.path} />
        )}
        {extra}
      </>
    );
  }

  // If no latency data rows but we have CDF metadata, add the tab
  if (latencyCdfMeta && !tabIds.includes('latency')) {
    const diagIdx = tabs.findIndex(t => t.id === 'diagnostics');
    const latencyTab = { id: 'latency', label: 'Latency' };
    if (diagIdx >= 0) {
      tabs.splice(diagIdx, 0, latencyTab);
    } else {
      tabs.push(latencyTab);
    }
    panels['latency'] = <LatencyCdfTab edge={latencyCdfMeta.edge} path={latencyCdfMeta.path} />;
  }

  return (
    <div className="info-card" style={sizeZoom !== 1 ? { zoom: sizeZoom } as any : undefined}>
      <TabbedContainer tabs={tabs} defaultTab={defaultTab} panels={panels} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Section builder (extracted from original useMemo)
// ────────────────────────────────────────────────────────────

function buildSections(
  data: Record<string, any>[],
  scenarioIds: string[],
  scenarioMeta: Record<string, { name: string; colour?: string }>,
  _dimensionValues?: Record<string, any>,
): SectionData[] {
  const sectionMap = new Map<string, SectionData>();
  const hasScenarios = scenarioIds.length > 1;

  if (hasScenarios) {
    const rowKey = (row: any) => `${row.section}||${row.property}`;
    const seen = new Map<string, { section: string; property: string; scenarioValues: Record<string, string>; detail?: string }>();

    for (const row of data) {
      const key = rowKey(row);
      if (!seen.has(key)) {
        seen.set(key, {
          section: row.section || '',
          property: row.property || '',
          scenarioValues: {},
          detail: row.detail,
        });
      }
      const entry = seen.get(key)!;
      if (row.scenario_id) {
        entry.scenarioValues[row.scenario_id] = row.value ?? '';
      }
    }

    for (const entry of seen.values()) {
      const sectionTitle = entry.section || 'General';
      if (!sectionMap.has(sectionTitle)) {
        sectionMap.set(sectionTitle, { title: sectionTitle, rows: [] });
      }
      const vals = Object.values(entry.scenarioValues);
      const allSame = vals.length > 0 && vals.every(v => v === vals[0]);
      if (allSame) {
        sectionMap.get(sectionTitle)!.rows.push({
          property: entry.property,
          value: vals[0],
          detail: entry.detail,
        });
      } else {
        sectionMap.get(sectionTitle)!.rows.push({
          property: entry.property,
          scenarioValues: entry.scenarioValues,
          detail: entry.detail,
        });
      }
    }
  } else {
    for (const row of data) {
      const sectionTitle = row.section || 'General';
      if (!sectionMap.has(sectionTitle)) {
        sectionMap.set(sectionTitle, { title: sectionTitle, rows: [] });
      }
      sectionMap.get(sectionTitle)!.rows.push({
        property: row.property || '',
        value: row.value ?? '',
        detail: row.detail,
        freshness: row.freshness,
        link: row.link,
      });
    }
  }

  return Array.from(sectionMap.values());
}

// ────────────────────────────────────────────────────────────
// InfoTable — renders sections as a table (extracted for reuse in tabs)
// ────────────────────────────────────────────────────────────

function InfoTable({
  sections,
  scenarioIds,
  scenarioMeta,
  onFileLink,
}: {
  sections: SectionData[];
  scenarioIds: string[];
  scenarioMeta: Record<string, { name: string; colour?: string }>;
  onFileLink?: (fileId: string, type: string) => void;
}) {
  if (sections.length === 0) {
    return <div className="info-card-empty">No data</div>;
  }

  const hasMultiScenario = scenarioIds.length > 1;
  const colCount = hasMultiScenario ? 1 + scenarioIds.length : 2;

  return (
    <table className="info-card-table">
      {hasMultiScenario && (
        <colgroup>
          <col className="info-card-col-prop" />
          {scenarioIds.map(sid => (
            <col key={sid} className="info-card-col-scenario" />
          ))}
        </colgroup>
      )}
      {!hasMultiScenario && (
        <colgroup>
          <col className="info-card-col-prop" />
          <col className="info-card-col-val" />
        </colgroup>
      )}

      {hasMultiScenario && (
        <thead>
          <tr className="info-card-scenario-header-row">
            <th />
            {scenarioIds.map(sid => (
              <th
                key={sid}
                className="info-card-scenario-th"
                style={scenarioMeta[sid]?.colour ? { borderBottomColor: scenarioMeta[sid].colour } : undefined}
              >
                {scenarioMeta[sid]?.name || sid}
              </th>
            ))}
          </tr>
        </thead>
      )}

      <tbody>
        {sections.map((section, si) => (
          <React.Fragment key={si}>
            <tr className="info-card-section-row">
              <td colSpan={colCount} className="info-card-section-title">
                {section.title}
              </td>
            </tr>
            {section.rows.map((row, ri) => (
              <React.Fragment key={ri}>
                <tr className="info-card-data-row">
                  <td className="info-card-prop">{row.property}</td>
                  {row.scenarioValues ? (
                    scenarioIds.map(sid => (
                      <td
                        key={sid}
                        className="info-card-scenario-val"
                        style={scenarioMeta[sid]?.colour ? { color: scenarioMeta[sid].colour } : undefined}
                      >
                        {row.scenarioValues![sid] ?? '\u2014'}
                      </td>
                    ))
                  ) : (
                    <td
                      className="info-card-val"
                      colSpan={hasMultiScenario ? scenarioIds.length : 1}
                      style={row.freshness ? { color: freshnessColour(row.freshness as FreshnessLevel) } : undefined}
                    >
                      {row.link ? (
                        <FileLinkValue link={row.link} value={row.value} onFileLink={onFileLink} />
                      ) : row.value}
                    </td>
                  )}
                </tr>
                {row.detail && (
                  <tr className="info-card-detail-row">
                    <td colSpan={colCount} className="info-card-detail">
                      {row.detail}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

// ────────────────────────────────────────────────────────────
// FileLinkValue — renders an icon + clickable value for file references
// ────────────────────────────────────────────────────────────

function FileLinkValue({
  link,
  value,
  onFileLink,
}: {
  link: { type: string; fileId: string };
  value?: string;
  onFileLink?: (fileId: string, type: string) => void;
}) {
  const theme = objectTypeTheme[link.type as ObjectType];
  const Icon = theme?.icon;
  const accentColour = theme?.accentColour;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onFileLink?.(link.fileId, link.type);
  }, [onFileLink, link.fileId, link.type]);

  return (
    <span
      className={`info-card-file-link${onFileLink ? ' info-card-file-link--clickable' : ''}`}
      style={accentColour ? { color: accentColour } : undefined}
      onClick={onFileLink ? handleClick : undefined}
      title={`Open ${link.fileId}`}
    >
      {Icon && <Icon size={12} style={{ marginRight: 3, verticalAlign: -1 }} />}
      {value}
    </span>
  );
}

// ────────────────────────────────────────────────────────────
// Latency CDF sparkline — lightweight inline chart
// ────────────────────────────────────────────────────────────

function shiftedLognormalCdf(age: number, onset: number, mu: number, sigma: number): number {
  const t = age - onset;
  if (t <= 0 || sigma <= 0) return 0;
  const z = (Math.log(t) - mu) / (sigma * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

interface CdfParams { mu: number; sigma: number; onset: number }

function buildCombinedCdfOption(edge?: CdfParams, path?: CdfParams) {
  const edgeT95 = edge ? Math.exp(edge.mu + 1.645 * edge.sigma) + edge.onset : 0;
  const pathT95 = path ? Math.exp(path.mu + 1.645 * path.sigma) + path.onset : 0;
  const maxDays = Math.ceil(Math.max(edgeT95, pathT95, 5) * 1.3);
  const steps = Math.min(maxDays, 80);

  const edgeData: [number, number][] = [];
  const pathData: [number, number][] = [];
  for (let d = 0; d <= steps; d++) {
    const tau = (d / steps) * maxDays;
    if (edge) edgeData.push([tau, shiftedLognormalCdf(tau, edge.onset, edge.mu, edge.sigma)]);
    if (path) pathData.push([tau, shiftedLognormalCdf(tau, path.onset, path.mu, path.sigma)]);
  }

  // Onset markers
  const markLines: any[] = [];
  if (edge && edge.onset > 0) {
    markLines.push({ xAxis: edge.onset, label: { formatter: `onset ${edge.onset.toFixed(0)}d`, fontSize: 8, position: 'insideStartTop' }, lineStyle: { color: '#60a5fa', type: 'dotted', width: 1 } });
  }
  if (path && path.onset > 0 && (!edge || Math.abs(path.onset - edge.onset) > 0.5)) {
    markLines.push({ xAxis: path.onset, label: { formatter: `onset ${path.onset.toFixed(0)}d`, fontSize: 8, position: 'insideStartTop' }, lineStyle: { color: '#f59e0b', type: 'dotted', width: 1 } });
  }

  const series: any[] = [];

  if (edge) {
    series.push({
      name: `Edge: μ=${edge.mu.toFixed(2)} σ=${edge.sigma.toFixed(2)}`,
      type: 'line', showSymbol: false, smooth: true,
      lineStyle: { width: 1.5, color: '#60a5fa' },
      areaStyle: { color: '#60a5fa', opacity: 0.06 },
      data: edgeData,
      ...(markLines.length > 0 ? { markLine: { silent: true, symbol: 'none', data: markLines } } : {}),
    });
  }

  if (path) {
    series.push({
      name: `Path: μ=${path.mu.toFixed(2)} σ=${path.sigma.toFixed(2)}`,
      type: 'line', showSymbol: false, smooth: true,
      lineStyle: { width: 1.5, color: '#f59e0b', type: 'dashed' },
      areaStyle: { color: '#f59e0b', opacity: 0.06 },
      data: pathData,
      // Put mark lines on path series if no edge series
      ...(!edge && markLines.length > 0 ? { markLine: { silent: true, symbol: 'none', data: markLines } } : {}),
    });
  }

  return {
    animation: false,
    grid: { left: 30, right: 8, top: 28, bottom: 20 },
    legend: {
      show: true, top: 0, left: 0, itemWidth: 14, itemHeight: 8, itemGap: 12,
      textStyle: { fontSize: 8, color: '#aaa' },
    },
    xAxis: {
      type: 'value' as const, min: 0, max: maxDays,
      name: 'days', nameLocation: 'end' as const,
      nameTextStyle: { fontSize: 8, color: '#666', padding: [0, 0, 0, -20] },
      axisLabel: { fontSize: 8, color: '#888', formatter: '{value}' },
      axisLine: { lineStyle: { color: '#444' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const, min: 0, max: 1,
      name: 'completeness',
      nameTextStyle: { fontSize: 8, color: '#666' },
      axisLabel: { fontSize: 8, color: '#888', formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      axisLine: { lineStyle: { color: '#444' } },
      splitLine: { show: false },
    },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: 'rgba(30,30,30,0.9)',
      borderColor: '#444',
      textStyle: { fontSize: 9, color: '#ddd' },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const tau = params[0].value[0].toFixed(1);
        const lines = params.map((p: any) =>
          `<span style="color:${p.color}">●</span> ${p.seriesName}: ${(p.value[1] * 100).toFixed(1)}%`
        );
        return `${tau}d<br/>${lines.join('<br/>')}`;
      },
    },
    series,
  };
}

const LatencyCdfTab = React.memo(function LatencyCdfTab({ edge, path }: { edge?: CdfParams; path?: CdfParams }) {
  if (!edge && !path) return null;
  const option = useMemo(() => buildCombinedCdfOption(edge, path), [edge, path]);
  return <ReactECharts option={option} style={{ height: 140 }} notMerge lazyUpdate />;
});
