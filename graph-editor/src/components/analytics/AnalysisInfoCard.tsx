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
  diagnostics: 'Diagnostics',
};

// Tabs where per-scenario columns make sense (values actually differ by scenario).
// Other tabs show a single value column even in multi-scenario mode.
const SCENARIO_AWARE_TABS = new Set(['overview', 'structure']);

export function AnalysisInfoCard({ result, fontSize, defaultTab, onFileLink, tabExtra }: AnalysisInfoCardProps) {
  const sizeZoom = fontSizeZoom(fontSize);
  const data = result.data || [];

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

  if (data.length === 0) {
    return <div className="info-card-empty">No data</div>;
  }

  if (!hasTabs) {
    // No tabs — render flat as before
    const sections = buildSections(data, scenarioIds, scenarioMeta, result.dimension_values);
    return (
      <div className="info-card" style={sizeZoom !== 1 ? { zoom: sizeZoom } as any : undefined}>
        <InfoTable sections={sections} scenarioIds={scenarioIds} scenarioMeta={scenarioMeta} onFileLink={onFileLink} />
      </div>
    );
  }

  // Tabbed layout
  const tabs: TabDefinition[] = tabIds.map(id => ({
    id,
    label: TAB_LABELS[id] || id,
  }));

  // Build sections per tab — only pass scenario info to scenario-aware tabs
  const sectionsByTab = useMemo(() => {
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
  }, [data, tabIds, scenarioIds, scenarioMeta]);

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
        {extra}
      </>
    );
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
