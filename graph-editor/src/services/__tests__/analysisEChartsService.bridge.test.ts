import { describe, it, expect } from 'vitest';

import { buildBridgeEChartsOption } from '../analysisEChartsService';
import type { AnalysisResult } from '../../lib/graphComputeClient';

describe('analysisEChartsService (bridge)', () => {
  it('builds a waterfall option from bridge_view-like result', () => {
    const result: AnalysisResult = {
      analysis_type: 'bridge_view',
      analysis_name: 'Bridge View',
      analysis_description: 'Decompose reach delta',
      semantics: {
        dimensions: [{ id: 'bridge_step', name: 'Step', type: 'stage', role: 'primary' }],
        metrics: [
          { id: 'total', name: 'Reach', type: 'probability', format: 'percent', role: 'secondary' },
          { id: 'delta', name: 'Change', type: 'delta', format: 'percent', role: 'primary' },
        ],
        chart: { recommended: 'bridge' },
      },
      dimension_values: {
        bridge_step: {
          start: { name: 'Start (A)', order: 0 },
          x: { name: 'X', order: 1 },
          other: { name: 'Other', order: 2 },
          end: { name: 'End (B)', order: 3 },
        },
      },
      data: [
        { bridge_step: 'start', kind: 'start', total: 0.2, delta: null },
        { bridge_step: 'x', kind: 'step', total: null, delta: 0.1 },
        { bridge_step: 'other', kind: 'other', total: null, delta: 0.05 },
        { bridge_step: 'end', kind: 'end', total: 0.35, delta: null },
      ],
    };

    const option = buildBridgeEChartsOption(result, { ui: { showToolbox: false } });
    expect(option).toBeTruthy();
    expect(option.series).toHaveLength(4);
    expect(option.xAxis.data).toEqual(['Start (A)', 'X', 'Other', 'End (B)']);
    // Totals series should include start/end values
    const totals = option.series[3].data;
    expect(totals[0].value).toBe(0.2);
    expect(totals[3].value).toBe(0.35);
  });
});


