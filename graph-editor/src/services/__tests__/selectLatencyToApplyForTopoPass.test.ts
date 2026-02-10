import { describe, it, expect } from 'vitest';

import { selectLatencyToApplyForTopoPass } from '../fetchDataService';
import { UpdateManager } from '../UpdateManager';

describe('selectLatencyToApplyForTopoPass', () => {
  it('preserves existing median/mean lag but always takes computed completeness in from-file mode', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
      onset_delta_days: 3,
    };

    const existing = {
      median_lag_days: 6.4,
      mean_lag_days: 6.8,
      t95: 13.12,
      completeness: 0.6032414791916322,
      onset_delta_days: 9,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, existing, true);

    expect(selected.median_lag_days).toBe(existing.median_lag_days);
    expect(selected.mean_lag_days).toBe(existing.mean_lag_days);
    expect(selected.t95).toBe(computed.t95);
    expect(selected.path_t95).toBe(computed.path_t95);
    expect(selected.completeness).toBe(computed.completeness);
    expect(selected.onset_delta_days).toBe(computed.onset_delta_days);
  });

  it('returns computed latency unchanged when not preserving from-file summary', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
      onset_delta_days: 0,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, { completeness: 0.1 }, false);
    expect(selected).toEqual(computed);
  });

  it('returns computed latency when there is no existing median/mean summary', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
      onset_delta_days: 2,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, { completeness: 0.2 }, true);
    expect(selected).toEqual(computed);
  });

  it('preserves computed mu/sigma in from-file mode (not stripped by type narrowing)', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
      onset_delta_days: 3,
      mu: 1.609,
      sigma: 0.8,
    };

    const existing = {
      median_lag_days: 6.4,
      mean_lag_days: 6.8,
      t95: 13.12,
      completeness: 0.6032414791916322,
      onset_delta_days: 9,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, existing, true);

    // mu/sigma must always come from the topo pass (fitted model params).
    // This test catches the bug where type narrowing in from-file mode stripped them.
    expect(selected.mu).toBe(1.609);
    expect(selected.sigma).toBe(0.8);
  });

  it('mu/sigma survive the full from-file pipeline: select → applyBatchLAGValues → graph edge', () => {
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: {
            mean: 0.5,
            latency: {
              latency_parameter: true,
              onset_delta_days_overridden: false,
            },
          },
        },
      ],
    };

    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
      onset_delta_days: 3,
      mu: 1.609,
      sigma: 0.8,
    };

    const existing = {
      median_lag_days: 6.4,
      mean_lag_days: 6.8,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, existing, true);

    const um = new UpdateManager();
    const next = um.applyBatchLAGValues(
      graph,
      [{ edgeId: 'e1', latency: selected }],
      { writeHorizonsToGraph: false },
    );

    const e1 = next.edges.find((e: any) => e.uuid === 'e1' || e.id === 'e1');
    expect(e1?.p?.latency?.mu).toBe(1.609);
    expect(e1?.p?.latency?.sigma).toBe(0.8);
  });

  it('from-file topo pass: selected onset persists onto graph via UpdateManager', () => {
    // This reproduces the exact app flow:
    // - Stage‑2 (from-file) chooses which latency fields to apply
    // - UpdateManager.applyBatchLAGValues writes onto edge.p.latency (respecting overrides)
    const graph: any = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: {
            mean: 0.5,
            latency: {
              latency_parameter: true,
              // Crucially, onset is not already on the graph.
              onset_delta_days_overridden: false,
            },
          },
        },
      ],
    };

    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
      onset_delta_days: 3,
    };

    // Existing (file-derived) latency summary that we preserve in from-file mode.
    const existing = {
      median_lag_days: 6.4,
      mean_lag_days: 6.8,
      t95: 13.12,
      completeness: 0.6032414791916322,
      // Existing onset should NOT be preserved; topo pass computed onset must apply.
      onset_delta_days: 9,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, existing, true);

    const um = new UpdateManager();
    const next = um.applyBatchLAGValues(
      graph,
      [
        {
          edgeId: 'e1',
          latency: selected,
        },
      ],
      // from-file pipeline typically does not write horizons unless explicitly requested
      { writeHorizonsToGraph: false }
    );

    const e1 = next.edges.find((e: any) => e.uuid === 'e1' || e.id === 'e1');
    expect(e1?.p?.latency?.onset_delta_days).toBe(3);
  });
});




