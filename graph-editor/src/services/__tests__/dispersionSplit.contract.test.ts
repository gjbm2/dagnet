/**
 * L5 dispersion split contract — doc 73b §3.3.4 / §6.2 / §12.2 rows S5/S8/S9.
 *
 * Pins the contract that:
 *  - `p.stdev` is always epistemic; `p.stdev_pred` is always predictive
 *    (kappa-inflated) and absent when no predictive flavour exists.
 *  - CF apply mapping is `p_sd → p.stdev_pred`, `p_sd_epistemic → p.stdev`.
 *  - `applyBatchLAGValues` routes `update.stdev → p.stdev` (gated by
 *    `stdev_overridden`) and `update.stdev_pred → p.stdev_pred`
 *    (no `*_overridden` lock per row S6).
 *  - Pack roundtrip via `GraphParamExtractor` + `applyComposedParamsToGraph`
 *    preserves both fields.
 *
 * Sibling tests cover other slices of this contract:
 *  - `conditionedForecastCompleteness.test.ts` exercises the full CF apply
 *    flow against a live `applyConditionedForecastToGraph`.
 *  - `stage0ContractPinning.test.ts` pins the §3.2 promoted surface
 *    contract (separate concern from the L5 split).
 */

import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { applyComposedParamsToGraph } from '../CompositionService';

const EDGE_ID = 'edge-1';
const baseGraph = (initial: any = {}) => ({
  nodes: [{ id: 'A' }, { id: 'B' }],
  edges: [
    {
      id: EDGE_ID,
      uuid: EDGE_ID,
      from: 'A',
      to: 'B',
      p: { latency: {}, ...initial },
    },
  ],
  metadata: {},
});

describe('L5 dispersion split — UpdateManager.applyBatchLAGValues routing', () => {
  it('writes update.stdev to p.stdev (epistemic) and update.stdev_pred to p.stdev_pred', () => {
    const um = new UpdateManager();
    const next = um.applyBatchLAGValues(baseGraph(), [
      {
        edgeId: EDGE_ID,
        latency: { t95: 0, completeness: 0.8, path_t95: 0 },
        stdev: 0.04,
        stdev_pred: 0.05,
      },
    ]);
    const e = next.edges.find((x: any) => x.id === EDGE_ID);
    expect(e.p.stdev).toBeCloseTo(0.04, 5);
    expect(e.p.stdev_pred).toBeCloseTo(0.05, 5);
  });

  it('respects p.stdev_overridden lock for p.stdev (epistemic) but NOT for p.stdev_pred (row S6 — no lock)', () => {
    const um = new UpdateManager();
    const next = um.applyBatchLAGValues(
      baseGraph({ stdev: 0.99, stdev_overridden: true, stdev_pred: 0.99 }),
      [
        {
          edgeId: EDGE_ID,
          latency: { t95: 0, completeness: 0.8, path_t95: 0 },
          stdev: 0.04,
          stdev_pred: 0.05,
        },
      ],
    );
    const e = next.edges.find((x: any) => x.id === EDGE_ID);
    // Lock blocks epistemic write
    expect(e.p.stdev).toBeCloseTo(0.99, 5);
    // No lock for predictive — write goes through
    expect(e.p.stdev_pred).toBeCloseTo(0.05, 5);
  });

  it('leaves p.stdev_pred absent when update.stdev_pred is undefined (FE topo analytic blend)', () => {
    const um = new UpdateManager();
    const next = um.applyBatchLAGValues(baseGraph(), [
      {
        edgeId: EDGE_ID,
        latency: { t95: 0, completeness: 0.8, path_t95: 0 },
        stdev: 0.04,
        // stdev_pred deliberately omitted — analytic source has no kappa
      },
    ]);
    const e = next.edges.find((x: any) => x.id === EDGE_ID);
    expect(e.p.stdev).toBeCloseTo(0.04, 5);
    expect(e.p.stdev_pred).toBeUndefined();
  });

  it('mirrors the routing for conditional_p entries', () => {
    const um = new UpdateManager();
    const graph: any = baseGraph();
    graph.edges[0].conditional_p = [
      { condition: 'context(channel:paid)', p: { latency: {} } },
    ];
    const next = um.applyBatchLAGValues(graph, [
      {
        edgeId: EDGE_ID,
        conditionalIndex: 0,
        latency: { t95: 0, completeness: 0.8, path_t95: 0 },
        stdev: 0.06,
        stdev_pred: 0.08,
      },
    ]);
    const e = next.edges.find((x: any) => x.id === EDGE_ID);
    expect(e.conditional_p[0].p.stdev).toBeCloseTo(0.06, 5);
    expect(e.conditional_p[0].p.stdev_pred).toBeCloseTo(0.08, 5);
  });
});

describe('L5 dispersion split — pack roundtrip', () => {
  it('GraphParamExtractor extracts p.stdev_pred alongside p.stdev', () => {
    const graph: any = baseGraph({
      mean: 0.6,
      stdev: 0.04,
      stdev_pred: 0.05,
    });
    const params = extractParamsFromGraph(graph);
    const ep = params.edges?.[EDGE_ID];
    expect(ep?.p?.stdev).toBeCloseTo(0.04, 5);
    expect((ep?.p as any)?.stdev_pred).toBeCloseTo(0.05, 5);
  });

  it('GraphParamExtractor mirrors p.stdev_pred under conditional_p', () => {
    const graph: any = baseGraph({ mean: 0.6, stdev: 0.04 });
    graph.edges[0].conditional_p = [
      {
        condition: 'context(channel:paid)',
        p: { mean: 0.7, stdev: 0.06, stdev_pred: 0.08 },
      },
    ];
    const params = extractParamsFromGraph(graph);
    const ep = params.edges?.[EDGE_ID];
    const cond: any = ep?.conditional_p?.['context(channel:paid)'];
    expect(cond?.stdev).toBeCloseTo(0.06, 5);
    expect(cond?.stdev_pred).toBeCloseTo(0.08, 5);
  });

  it('applyComposedParamsToGraph deep-merges p.stdev_pred back onto the graph', () => {
    const graph: any = baseGraph({ mean: 0.6, stdev: 0.04 });
    const composed: any = {
      edges: { [EDGE_ID]: { p: { stdev_pred: 0.05 } } },
    };
    const next: any = applyComposedParamsToGraph(graph, composed);
    const e = next.edges.find((x: any) => x.id === EDGE_ID);
    expect(e.p.stdev).toBeCloseTo(0.04, 5); // existing preserved
    expect(e.p.stdev_pred).toBeCloseTo(0.05, 5); // pasted from pack
  });
});
