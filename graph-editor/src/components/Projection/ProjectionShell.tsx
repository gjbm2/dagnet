/**
 * ProjectionShell
 *
 * Standalone view for in-flight conversion projection.
 * Lets the user pick a graph + edge, then charts observed vs. model-expected k/day
 * plus a forward projection tail from currently in-flight cohorts.
 */

import React, { useMemo, useState } from 'react';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useProjectionMode } from '../../contexts/ProjectionModeContext';
import { DailyProjectionChart } from '../charts/DailyProjectionChart';
import { projectDailyConversions } from '../../services/projectionService';
import {
  computeEdgeLatencyStats,
  type CohortData,
} from '../../services/statisticalEnhancementService';
import { parseUKDate, formatDateUK } from '../../lib/dateFormat';
import { DEFAULT_T95_DAYS, RECENCY_HALF_LIFE_DAYS } from '../../constants/latency';
import type { ConversionGraph, GraphEdge } from '../../types';
import type { ParameterValue } from '../../types/parameterData';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EdgeOption {
  edgeUuid: string;
  label: string;
  paramId: string;
}

interface GraphOption {
  fileId: string;
  title: string;
  edges: EdgeOption[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(startStr: string, endStr: string): number {
  const start = parseUKDate(startStr);
  const end = parseUKDate(endStr);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** Pick the cohort-mode ParameterValue with the most entries (highest n). */
function bestCohortValue(values: ParameterValue[]): ParameterValue | undefined {
  const cohort = values.filter(
    v => v.sliceDSL?.includes('cohort(') || v.cohort_from != null
  );
  if (cohort.length === 0) return undefined;
  return cohort.reduce((best, v) => ((v.n ?? 0) > (best.n ?? 0) ? v : best));
}

/** Build CohortData array from a ParameterValue's daily arrays. */
function buildCohortData(pv: ParameterValue): CohortData[] {
  const dates = pv.dates ?? [];
  const nDaily = pv.n_daily ?? [];
  const kDaily = pv.k_daily ?? [];
  const medianLag = pv.median_lag_days ?? [];
  const meanLag = pv.mean_lag_days ?? [];
  const today = formatDateUK(new Date());

  return dates.map((date, i) => {
    const age = Math.max(0, daysBetween(date, today));
    return {
      date,
      n: nDaily[i] ?? 0,
      k: kDaily[i] ?? 0,
      age,
      median_lag_days: medianLag[i],
      mean_lag_days: meanLag[i],
    };
  });
}

// ─── Hook: derive graph options from open tabs ────────────────────────────────

function useGraphOptions(): GraphOption[] {
  const { tabs } = useTabContext();

  return useMemo(() => {
    const opts: GraphOption[] = [];
    for (const tab of tabs) {
      if (!tab.fileId.startsWith('graph-')) continue;
      const file = fileRegistry.getFile(tab.fileId);
      if (!file?.data) continue;
      const graph = file.data as ConversionGraph;
      if (!graph.edges || !graph.nodes) continue;

      // Build uuid → label map from nodes
      const nodeLabel = new Map<string, string>();
      for (const node of graph.nodes) {
        nodeLabel.set(node.uuid, node.label || node.id || node.uuid);
      }

      const edges: EdgeOption[] = [];
      for (const edge of graph.edges) {
        const paramId = (edge as GraphEdge).p?.id;
        if (!paramId) continue;
        const fromLabel = nodeLabel.get(edge.from) ?? edge.from;
        const toLabel = nodeLabel.get(edge.to) ?? edge.to;
        edges.push({
          edgeUuid: edge.uuid,
          label: `${fromLabel} → ${toLabel}`,
          paramId,
        });
      }

      if (edges.length > 0) {
        opts.push({ fileId: tab.fileId, title: tab.title, edges });
      }
    }
    return opts;
  }, [tabs]);
}

// ─── Main Shell ───────────────────────────────────────────────────────────────

export function ProjectionShell(): JSX.Element {
  const { theme: currentTheme } = useTheme();
  const { toggleProjectionMode } = useProjectionMode();
  const dark = currentTheme === 'dark';

  const bg = dark ? '#111827' : '#f9fafb';
  const cardBg = dark ? '#1f2937' : '#ffffff';
  const textColour = dark ? '#f3f4f6' : '#111827';
  const mutedColour = dark ? '#9ca3af' : '#6b7280';
  const borderColour = dark ? '#374151' : '#e5e7eb';
  const selectBg = dark ? '#374151' : '#ffffff';

  const graphOptions = useGraphOptions();

  const [selectedGraphFileId, setSelectedGraphFileId] = useState<string>(() =>
    graphOptions[0]?.fileId ?? ''
  );
  const [selectedEdgeUuid, setSelectedEdgeUuid] = useState<string>('');

  // Sync graph selection if options change and current is no longer valid
  const effectiveGraphFileId =
    graphOptions.some(g => g.fileId === selectedGraphFileId)
      ? selectedGraphFileId
      : (graphOptions[0]?.fileId ?? '');

  const selectedGraph = graphOptions.find(g => g.fileId === effectiveGraphFileId);
  const edgeOptions = selectedGraph?.edges ?? [];

  const effectiveEdgeUuid =
    edgeOptions.some(e => e.edgeUuid === selectedEdgeUuid)
      ? selectedEdgeUuid
      : (edgeOptions[0]?.edgeUuid ?? '');

  const selectedEdge = edgeOptions.find(e => e.edgeUuid === effectiveEdgeUuid);

  // ── Compute projection ─────────────────────────────────────────────────────

  const projection = useMemo(() => {
    if (!selectedEdge) return null;

    const paramFile = fileRegistry.getFile(`parameter-${selectedEdge.paramId}`);
    if (!paramFile?.data) return null;

    const values: ParameterValue[] = paramFile.data.values ?? [];
    const pv = bestCohortValue(values);
    if (!pv || !pv.dates?.length || !pv.n_daily?.length) return null;

    const latency = pv.latency ?? {};
    const aggregateMedianLag = latency.median_lag_days;
    const aggregateMeanLag = latency.mean_lag_days;
    const onsetDeltaDays = latency.onset_delta_days ?? 0;
    const edgeT95 = latency.t95;

    // Need median lag to fit a distribution
    if (!aggregateMedianLag) return null;

    const cohorts = buildCohortData(pv);
    if (cohorts.every(c => c.n === 0)) return null;

    let stats;
    try {
      stats = computeEdgeLatencyStats(
        cohorts,
        aggregateMedianLag,
        aggregateMeanLag,
        DEFAULT_T95_DAYS,
        0,
        undefined,
        undefined,
        edgeT95,
        RECENCY_HALF_LIFE_DAYS,
        onsetDeltaDays,
        undefined,
        false // window() mode: no anchor-age adjustment
      );
    } catch {
      return null;
    }

    if (!stats.forecast_available || !Number.isFinite(stats.p_infinity)) return null;

    const points = projectDailyConversions({
      nDaily: pv.n_daily,
      kDaily: pv.k_daily,
      dates: pv.dates,
      pInfinity: stats.p_infinity,
      mu: stats.fit.mu,
      sigma: stats.fit.sigma,
      onsetDeltaDays,
      horizonDays: 60,
    });

    return { points, pInfinity: stats.p_infinity, t95: stats.t95 };
  }, [selectedEdge]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const selectStyle: React.CSSProperties = {
    background: selectBg,
    color: textColour,
    border: `1px solid ${borderColour}`,
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    outline: 'none',
    minWidth: 200,
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: bg,
        color: textColour,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          borderBottom: `1px solid ${borderColour}`,
          background: cardBg,
        }}
      >
        <div>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Conversion Projection</span>
          <span style={{ color: mutedColour, fontSize: 12, marginLeft: 10 }}>
            Expected daily conversions from in-flight cohorts
          </span>
        </div>
        <button
          onClick={() => toggleProjectionMode({ updateUrl: true })}
          style={{
            background: 'none',
            border: `1px solid ${borderColour}`,
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            color: mutedColour,
            cursor: 'pointer',
          }}
        >
          ✕ Close
        </button>
      </div>

      {/* Controls */}
      <div
        style={{
          padding: '16px 24px',
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          flexWrap: 'wrap',
          borderBottom: `1px solid ${borderColour}`,
          background: cardBg,
        }}
      >
        {graphOptions.length === 0 ? (
          <span style={{ color: mutedColour, fontSize: 13 }}>
            No graphs with parameter-linked edges are open. Open a graph in the editor first.
          </span>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, color: mutedColour }}>Graph</label>
              <select
                style={selectStyle}
                value={effectiveGraphFileId}
                onChange={e => {
                  setSelectedGraphFileId(e.target.value);
                  setSelectedEdgeUuid('');
                }}
              >
                {graphOptions.map(g => (
                  <option key={g.fileId} value={g.fileId}>
                    {g.title}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, color: mutedColour }}>Edge</label>
              <select
                style={{ ...selectStyle, minWidth: 300 }}
                value={effectiveEdgeUuid}
                onChange={e => setSelectedEdgeUuid(e.target.value)}
              >
                {edgeOptions.map(e => (
                  <option key={e.edgeUuid} value={e.edgeUuid}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {/* Chart area */}
      <div style={{ padding: '24px' }}>
        {!selectedEdge ? (
          <EmptyState dark={dark} mutedColour={mutedColour} message="Select an edge to see its projection." />
        ) : !projection ? (
          <EmptyState
            dark={dark}
            mutedColour={mutedColour}
            message="No cohort-mode data with a fitted lag distribution is available for this edge. Ensure the edge has been fetched in cohort mode and has enough converters for a lag fit."
          />
        ) : (
          <div
            style={{
              background: cardBg,
              border: `1px solid ${borderColour}`,
              borderRadius: 8,
              padding: '20px 24px',
            }}
          >
            <DailyProjectionChart
              points={projection.points}
              edgeLabel={selectedEdge.label}
              pInfinity={projection.pInfinity}
              t95={projection.t95}
              height={420}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  dark,
  mutedColour,
  message,
}: {
  dark: boolean;
  mutedColour: string;
  message: string;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '48px 24px',
        textAlign: 'center',
        color: mutedColour,
        fontSize: 13,
        border: `1px dashed ${dark ? '#374151' : '#d1d5db'}`,
        borderRadius: 8,
      }}
    >
      {message}
    </div>
  );
}
