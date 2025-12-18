import React, { useMemo, useCallback } from 'react';
import type { AnalysisResult } from '../../lib/graphComputeClient';

export function AnalysisResultCards(props: {
  result: AnalysisResult;
  /**
   * Optional: per-scenario DSL subtitles to display under scenario titles.
   * This is a plain object so it can be persisted in chart files.
   */
  scenarioDslSubtitleById?: Record<string, string>;
}): JSX.Element | null {
  const { result, scenarioDslSubtitleById } = props;

  const scenarioDslMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(scenarioDslSubtitleById || {})) {
      if (typeof v === 'string' && v.trim()) m.set(k, v);
    }
    return m;
  }, [scenarioDslSubtitleById]);

  const renderDslSubtitle = useCallback((dsl: string) => {
    // Prefer line wrapping at clause separators ('.') so long DSLs break sensibly.
    // Also avoid ugly wrapping inside UK-style dates (e.g. 17-Nov-25) by using non-breaking hyphens.
    const normalised = dsl.replace(
      /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/g,
      (_m, d, mon, y) => `${d}\u2011${mon}\u2011${y}` // U+2011 = non-breaking hyphen
    );

    const parts = normalised.split('.');
    if (parts.length <= 1) return dsl;
    return parts.map((part, i) => (
      <React.Fragment key={`${i}-${part}`}>
        {part}
        {i < parts.length - 1 ? (
          <>
            .<wbr />
          </>
        ) : null}
      </React.Fragment>
    ));
  }, []);

  const renderedCards = useMemo(() => {
    if (!result?.semantics?.dimensions || !result?.data) return null;

    const { dimensions, metrics } = result.semantics;
    const primaryDim = dimensions.find((d: any) => d.role === 'primary');
    const secondaryDim = dimensions.find((d: any) => d.role === 'secondary');
    if (!primaryDim) return null;

    const primaryValues = [...new Set(result.data.map((row: any) => row[primaryDim.id]))];

    const formatValue = (value: number | null | undefined, format?: string): string => {
      if (value === null || value === undefined) return '—';
      switch (format) {
        case 'percent': return `${(value * 100).toFixed(1)}%`;
        case 'currency_gbp': return `£${value.toFixed(2)}`;
        default: return value.toLocaleString();
      }
    };

    const getLabel = (dimId: string, valueId: string | number): string => {
      const meta = result.dimension_values?.[dimId]?.[String(valueId)];
      return (meta as any)?.name ?? String(valueId);
    };

    const getColour = (dimId: string, valueId: string | number): string | undefined => {
      return (result.dimension_values?.[dimId]?.[String(valueId)] as any)?.colour;
    };

    const getScenarioProbabilityLabel = (scenarioId: string | number, row?: any): string | undefined => {
      const rowLabel = row?.probability_label;
      if (typeof rowLabel === 'string' && rowLabel.trim()) return rowLabel;
      const meta: any = result.dimension_values?.scenario_id?.[String(scenarioId)];
      const metaLabel = meta?.probability_label;
      if (typeof metaLabel === 'string' && metaLabel.trim()) return metaLabel;
      return undefined;
    };

    const formatScenarioTitleWithBasis = (scenarioId: string | number): string => {
      const title = getLabel('scenario_id', scenarioId);
      const basis = getScenarioProbabilityLabel(scenarioId);
      if (!basis || basis === 'Probability') return title;
      return `${title} (${basis})`;
    };

    // Scenario-first cards
    if (primaryDim.type === 'scenario') {
      return primaryValues.map(pv => {
        const rows = result.data.filter((row: any) => row[primaryDim.id] === pv);
        const colour = getColour(primaryDim.id, pv);
        const subtitle = scenarioDslMap.get(String(pv));
        return {
          id: String(pv),
          title: formatScenarioTitleWithBasis(pv),
          subtitle,
          colour,
          metrics: (metrics || []).map((m: any) => ({
            id: m.id,
            label: m.id === 'probability'
              ? (getScenarioProbabilityLabel(pv, rows[0]) || m.name)
              : m.name,
            value: formatValue(rows[0]?.[m.id], m.format),
            role: m.role || 'secondary'
          }))
        };
      });
    }

    // Stage-first cards (funnel)
    if (primaryDim.type === 'stage' && secondaryDim?.type === 'scenario') {
      const scenarioValues = [...new Set(result.data.map((row: any) => row[secondaryDim.id]))];
      const sortedStages = primaryValues.sort((a, b) => {
        const orderA = (result.dimension_values?.stage?.[String(a)] as any)?.order ?? 0;
        const orderB = (result.dimension_values?.stage?.[String(b)] as any)?.order ?? 0;
        return orderA - orderB;
      });

      return sortedStages.map((stageId, index) => {
        const stageLabel = getLabel(primaryDim.id, stageId);
        const scenarioItems = scenarioValues.map(sv => {
          const row = result.data.find((r: any) => r[primaryDim.id] === stageId && r[secondaryDim.id] === sv);

          const funnelMetricPriority = [
            'probability',
            'step_probability',
            'dropoff',
            'n',
            'evidence_mean',
            'forecast_mean',
            'p_mean',
            'completeness',
            'median_lag_days',
            'mean_lag_days',
          ];

          const metricsById = new Map((metrics || []).map((m: any) => [m.id, m]));
          const funnelMetrics = funnelMetricPriority
            .map(id => metricsById.get(id))
            .filter(Boolean) as any[];

          const metricsToRender = funnelMetrics.length > 0 ? funnelMetrics : (metrics || []);

          const itemMetrics = metricsToRender
            .map((m: any) => ({
              id: m.id,
              label: m.id === 'probability'
                ? (() => {
                    const basis = getScenarioProbabilityLabel(sv, row);
                    if (!basis || basis === 'Probability') return m.name;
                    return `${m.name} (${basis})`;
                  })()
                : m.name,
              value: formatValue(row?.[m.id], m.format),
              rawValue: row?.[m.id],
              role: m.role || 'secondary',
            }))
            .filter(m => m.rawValue !== null && m.rawValue !== undefined);

          return {
            label: formatScenarioTitleWithBasis(sv),
            colour: getColour(secondaryDim.id, sv),
            metrics: itemMetrics,
          };
        });

        return {
          id: String(stageId),
          title: stageLabel,
          stageNumber: index + 1,
          items: scenarioItems,
          isStageCard: true,
        };
      });
    }

    // Generic fallback: if secondary is scenario, render one card per scenario
    // This handles node-first, outcome-first, branch-first layouts.
    if (secondaryDim?.type === 'scenario') {
      const scenarioValues = [...new Set(result.data.map((row: any) => row[secondaryDim.id]))];
      const sortHint = (result.semantics as any)?.chart?.hints?.sort;
      const primaryMetric = (metrics as any[]).find(m => m.role === 'primary') || (metrics as any[])[0];

      return scenarioValues.map(sv => {
        const colour = getColour(secondaryDim.id, sv);
        const rows = result.data.filter((r: any) => r[secondaryDim.id] === sv);

        const sortedValues = [...primaryValues].sort((a, b) => {
          if (sortHint?.by) {
            const rowA = rows.find((r: any) => r[primaryDim.id] === a);
            const rowB = rows.find((r: any) => r[primaryDim.id] === b);
            const valA = rowA?.[sortHint.by] ?? 0;
            const valB = rowB?.[sortHint.by] ?? 0;
            return sortHint.order === 'desc' ? valB - valA : valA - valB;
          }
          const orderA = (result.dimension_values?.[primaryDim.id]?.[String(a)] as any)?.order ?? 0;
          const orderB = (result.dimension_values?.[primaryDim.id]?.[String(b)] as any)?.order ?? 0;
          return orderA - orderB;
        });

        const itemData = sortedValues.map(pv => {
          const row = rows.find((r: any) => r[primaryDim.id] === pv);
          return {
            label: getLabel(primaryDim.id, pv),
            value: formatValue(row?.[primaryMetric?.id], primaryMetric?.format),
            rawValue: row?.[primaryMetric?.id],
          };
        });

        return {
          id: String(sv),
          title: formatScenarioTitleWithBasis(sv),
          subtitle: scenarioDslMap.get(String(sv)),
          colour,
          items: itemData,
          primaryDimName: primaryDim.name,
        };
      });
    }

    // No secondary dimension - single view with all data
    return primaryValues.map(pv => {
      const rows = result.data.filter((row: any) => row[primaryDim.id] === pv);
      return {
        id: String(pv),
        title: getLabel(primaryDim.id, pv),
        metrics: (metrics || []).map((m: any) => ({
          id: m.id,
          label: m.name,
          value: formatValue(rows[0]?.[m.id], m.format),
          role: m.role || 'secondary',
        })),
      };
    });
  }, [result, scenarioDslMap]);

  if (!renderedCards || renderedCards.length === 0) return null;

  return (
    <div className={`analytics-cards-container ${renderedCards.length === 1 ? 'single-card' : ''}`}>
      {renderedCards.map((card: any) => (
        <div
          key={card.id}
          className={`analytics-card ${renderedCards.length === 1 ? 'full-width' : ''}`}
          style={card.colour ? { borderLeftColor: card.colour } : undefined}
        >
          <div
            className="analytics-card-header"
            style={card.colour ? { borderLeftColor: card.colour } : undefined}
          >
            {card.colour && (
              <span
                className="analytics-card-dot"
                style={{ backgroundColor: card.colour }}
              />
            )}
            {card.stageNumber && (
              <span className="analytics-card-stage-number">{card.stageNumber}</span>
            )}
            <span className="analytics-card-title-block">
              <span className="analytics-card-title">{card.title}</span>
              {card.subtitle && (
                <span className="analytics-card-subtitle">{renderDslSubtitle(card.subtitle)}</span>
              )}
            </span>
          </div>

          <div className="analytics-card-content">
            {/* Metric rows */}
            {card.metrics && card.metrics.map((m: any) => (
              <div
                key={m.id}
                className={`analytics-metric ${m.role === 'primary' ? 'analytics-metric-primary' : ''}`}
              >
                <span className="analytics-metric-label">{m.label}</span>
                <span className="analytics-metric-value">{m.value}</span>
              </div>
            ))}

            {card.items && (
              <>
                {card.items.map((item: any, idx: number) => (
                  <div key={`${card.id}-${item.label}-${idx}`} className="analytics-item">
                    {item.colour && (
                      <span className="analytics-item-dot" style={{ backgroundColor: item.colour }} />
                    )}
                    <span className="analytics-item-label" title={item.label}>{item.label}</span>
                    {item.value ? <span className="analytics-item-value">{item.value}</span> : null}
                    {item.metrics && (
                      <div className="analytics-item-metrics">
                        {item.metrics.map((m: any) => (
                          <div
                            key={m.id}
                            className={`analytics-metric analytics-item-metric ${m.role === 'primary' ? 'analytics-metric-primary' : ''}`}
                          >
                            <span className="analytics-metric-label">{m.label}</span>
                            <span className="analytics-metric-value">{m.value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}


