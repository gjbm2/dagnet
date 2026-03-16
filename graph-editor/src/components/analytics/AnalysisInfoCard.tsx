/**
 * AnalysisInfoCard — custom renderer for node_info / edge_info analysis results.
 *
 * Renders structured sections with key-value pairs using a single HTML <table>
 * so columns align across all sections. Supports multi-scenario columns with
 * per-scenario colouring. Identical cross-scenario values collapse to a single cell.
 */

import React, { useMemo } from 'react';
import type { AnalysisResult } from '../../lib/graphComputeClient';
import { fontSizeZoom } from '../../lib/analysisDisplaySettingsRegistry';
import '../../styles/analysis-info-card.css';

interface AnalysisInfoCardProps {
  result: AnalysisResult;
  /** Font size: numeric px, or legacy preset 'S'/'M'/'L'/'XL'. */
  fontSize?: number | string;
}

interface RowData {
  property: string;
  /** Single value (no scenarios or all scenarios identical) */
  value?: string;
  /** Per-scenario values: { scenarioId → value } */
  scenarioValues?: Record<string, string>;
  detail?: string;
}

interface SectionData {
  title: string;
  rows: RowData[];
}

export function AnalysisInfoCard({ result, fontSize }: AnalysisInfoCardProps) {
  const sizeZoom = fontSizeZoom(fontSize);
  const { sections, scenarioIds, scenarioMeta } = useMemo(() => {
    const data = result.data || [];
    if (data.length === 0) return { sections: [], scenarioIds: [], scenarioMeta: {} };

    // Detect scenarios: rows with scenario_id field
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

    // Group rows by section
    const sectionMap = new Map<string, SectionData>();

    if (hasScenarios && scIds.length > 1) {
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
        });
      }
    }

    return {
      sections: Array.from(sectionMap.values()),
      scenarioIds: scIds,
      scenarioMeta: scMeta,
    };
  }, [result]);

  if (sections.length === 0) {
    return <div className="info-card-empty">No data</div>;
  }

  const hasMultiScenario = scenarioIds.length > 1;
  // Total columns: property + N scenario cols (or property + 1 value col)
  const colCount = hasMultiScenario ? 1 + scenarioIds.length : 2;

  return (
    <div className="info-card" style={sizeZoom !== 1 ? { zoom: sizeZoom } as any : undefined}>
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

        {/* Scenario column headers */}
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
              {/* Section header */}
              <tr className="info-card-section-row">
                <td colSpan={colCount} className="info-card-section-title">
                  {section.title}
                </td>
              </tr>

              {/* Data rows */}
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
                      >
                        {row.value}
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
    </div>
  );
}
