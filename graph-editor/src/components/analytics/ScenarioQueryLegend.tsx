import React, { useMemo } from 'react';
import type { AnalysisResult } from '../../lib/graphComputeClient';

export function ScenarioQueryLegend(props: {
  result: AnalysisResult;
  scenarioDslSubtitleById?: Record<string, string>;
}): JSX.Element | null {
  const { result, scenarioDslSubtitleById } = props;

  const entries = useMemo(() => {
    const m = scenarioDslSubtitleById || {};
    const scenarioMeta = result.dimension_values?.scenario_id || {};
    const items: Array<{ id: string; name: string; colour?: string; dsl: string }> = [];
    for (const [id, dsl] of Object.entries(m)) {
      if (typeof dsl !== 'string' || !dsl.trim()) continue;
      const meta: any = (scenarioMeta as any)[id] || {};
      items.push({
        id,
        name: meta?.name || id,
        colour: meta?.colour,
        dsl,
      });
    }
    return items;
  }, [scenarioDslSubtitleById, result.dimension_values]);

  if (entries.length === 0) return null;

  return (
    <div style={{ padding: '8px 8px 0 8px' }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Scenario queries</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map(e => (
          <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            {e.colour ? <span style={{ width: 10, height: 10, borderRadius: 999, background: e.colour, flexShrink: 0, marginTop: 4 }} /> : null}
            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', flexShrink: 0 }}>{e.name}</span>
            <span
              style={{
                fontSize: 11,
                fontFamily: "'SF Mono', Monaco, 'Cascadia Code', monospace",
                color: '#6b7280',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
              title={e.dsl}
            >
              {e.dsl}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


