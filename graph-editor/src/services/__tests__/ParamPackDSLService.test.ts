/**
 * Unit tests for ParamPackDSLService: canonical DSL/param-pack engine
 */

import { describe, it, expect } from 'vitest';
import {
  flattenParams,
  unflattenParams,
  applyScopeToParams,
  buildScopedParamsFromFlatPack,
  parseFlatHRNToParams,
} from '../ParamPackDSLService';
import type { ScenarioParams } from '../../types/scenarios';
import type { Graph } from '../../types';

describe('ParamPackDSLService: unflattenParams / flattenParams round-trips', () => {
  it('round-trips edge p params', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': {
          p: { mean: 0.5, stdev: 0.1 },
        },
      },
    };

    const flat = flattenParams(params);
    expect(flat).toEqual({
      'e.edge-1.p.mean': 0.5,
      'e.edge-1.p.stdev': 0.1,
    });

    const unflat = unflattenParams(flat);
    expect(unflat.edges).toEqual(params.edges);
  });

  it('round-trips edge cost params', () => {
    const params: ScenarioParams = {
      edges: {
        'checkout-to-purchase': {
          cost_gbp: { mean: 12.5 },
          cost_time: { mean: 300 },
        },
      },
    };

    const flat = flattenParams(params);
    expect(flat).toEqual({
      'e.checkout-to-purchase.cost_gbp.mean': 12.5,
      'e.checkout-to-purchase.cost_time.mean': 300,
    });

    const unflat = unflattenParams(flat);
    expect(unflat.edges).toEqual(params.edges);
  });

  it('round-trips node case variants', () => {
    const params: ScenarioParams = {
      nodes: {
        'case-node-1': {
          case: {
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 },
            ],
          },
        },
      },
    };

    const flat = flattenParams(params);
    expect(flat).toEqual({
      'n.case-node-1.case(case-node-1:control).weight': 0.5,
      'n.case-node-1.case(case-node-1:treatment).weight': 0.5,
    });

    const unflat = unflattenParams(flat);
    expect(unflat.nodes).toEqual(params.nodes);
  });

  it('round-trips conditional_p params (edge-conditional)', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': {
          conditional_p: {
            'visited(promo)': { mean: 0.6, stdev: 0.05 },
            'visited(blog)': { mean: 0.4 },
          },
        },
      },
    };

    const flat = flattenParams(params);
    expect(flat).toMatchObject({
      'e.edge-1.visited(promo).p.mean': 0.6,
      'e.edge-1.visited(promo).p.stdev': 0.05,
      'e.edge-1.visited(blog).p.mean': 0.4,
    });

    const unflat = unflattenParams(flat);
    expect(unflat.edges).toEqual(params.edges);
  });

  it('round-trips mixed edges and nodes', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.7 } },
        'edge-2': { cost_gbp: { mean: 5.0 } },
      },
      nodes: {
        'node-1': { entry: { entry_weight: 100 } },
        'case-node': {
          case: {
            variants: [{ name: 'variant-a', weight: 1.0 }],
          },
        },
      },
    };

    const flat = flattenParams(params);
    const unflat = unflattenParams(flat);
    expect(unflat).toEqual(params);
  });
});

describe('ParamPackDSLService: applyScopeToParams', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-uuid-1',
        id: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        p: { mean: 0.5 },
        conditional_p: [
          { condition: 'visited(promo)', p: { mean: 0.6 } },
          { condition: 'visited(blog)', p: { mean: 0.4 } },
        ],
      } as any,
      {
        uuid: 'edge-uuid-2',
        id: 'edge-2',
        from: 'node-b',
        to: 'node-c',
        p: { mean: 0.3 },
      } as any,
    ],
    nodes: [
      {
        uuid: 'node-uuid-1',
        id: 'node-1',
        type: 'standard',
      } as any,
      {
        uuid: 'case-node-uuid',
        id: 'case-node',
        type: 'case',
        case: {
          id: 'exp-1',
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment', weight: 0.5 },
          ],
        },
      } as any,
    ],
  } as any;

  it('graph scope: returns full params unchanged', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.7 } },
        'edge-2': { p: { mean: 0.3 } },
      },
      nodes: {
        'node-1': { entry: { entry_weight: 100 } },
      },
    };

    const scoped = applyScopeToParams(params, { kind: 'graph' }, mockGraph);
    expect(scoped).toEqual(params);
  });

  it('edge-param scope: narrows to single edge + slot (p)', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.7, stdev: 0.1 }, cost_gbp: { mean: 10 } },
        'edge-2': { p: { mean: 0.3 } },
      },
      nodes: {
        'node-1': { entry: { entry_weight: 100 } },
      },
    };

    const scoped = applyScopeToParams(
      params,
      { kind: 'edge-param', edgeUuid: 'edge-uuid-1', slot: 'p' },
      mockGraph
    );

    expect(scoped).toEqual({
      edges: {
        'edge-1': {
          p: { mean: 0.7, stdev: 0.1 },
        },
      },
    });
  });

  it('edge-param scope: narrows to cost_gbp', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.7 }, cost_gbp: { mean: 10, stdev: 2 } },
      },
    };

    const scoped = applyScopeToParams(
      params,
      { kind: 'edge-param', edgeId: 'edge-1', slot: 'cost_gbp' },
      mockGraph
    );

    expect(scoped).toEqual({
      edges: {
        'edge-1': {
          cost_gbp: { mean: 10, stdev: 2 },
        },
      },
    });
  });

  it('edge-conditional scope: narrows to single conditional_p entry', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': {
          p: { mean: 0.5 },
          conditional_p: {
            'visited(promo)': { mean: 0.6, stdev: 0.05 },
            'visited(blog)': { mean: 0.4 },
          },
        },
      },
    };

    const scoped = applyScopeToParams(
      params,
      { kind: 'edge-conditional', edgeId: 'edge-1', condition: 'visited(promo)' },
      mockGraph
    );

    expect(scoped).toEqual({
      edges: {
        'edge-1': {
          conditional_p: {
            'visited(promo)': { mean: 0.6, stdev: 0.05 },
          },
        },
      },
    });
  });

  it('node scope: narrows to single node', () => {
    const params: ScenarioParams = {
      edges: {
        'edge-1': { p: { mean: 0.5 } },
      },
      nodes: {
        'node-1': { entry: { entry_weight: 100 } },
        'case-node': {
          case: {
            variants: [{ name: 'control', weight: 1.0 }],
          },
        },
      },
    };

    const scoped = applyScopeToParams(
      params,
      { kind: 'node', nodeId: 'node-1' },
      mockGraph
    );

    expect(scoped).toEqual({
      nodes: {
        'node-1': { entry: { entry_weight: 100 } },
      },
    });
  });

  it('case scope: narrows to case variants on a single node', () => {
    const params: ScenarioParams = {
      nodes: {
        'node-1': { entry: { entry_weight: 100 } },
        'case-node': {
          case: {
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 },
            ],
          },
        },
      },
    };

    const scoped = applyScopeToParams(
      params,
      { kind: 'case', nodeId: 'case-node' },
      mockGraph
    );

    expect(scoped).toEqual({
      nodes: {
        'case-node': {
          case: {
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 },
            ],
          },
        },
      },
    });
  });

  it('case scope with variantName: narrows to single variant', () => {
    const params: ScenarioParams = {
      nodes: {
        'case-node': {
          case: {
            variants: [
              { name: 'control', weight: 0.5 },
              { name: 'treatment', weight: 0.5 },
            ],
          },
        },
      },
    };

    const scoped = applyScopeToParams(
      params,
      { kind: 'case', nodeId: 'case-node', variantName: 'control' },
      mockGraph
    );

    expect(scoped).toEqual({
      nodes: {
        'case-node': {
          case: {
            variants: [{ name: 'control', weight: 0.5 }],
          },
        },
      },
    });
  });
});

describe('ParamPackDSLService: buildScopedParamsFromFlatPack (Sheets ingestion scenarios)', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-uuid-1',
        id: 'checkout-to-purchase',
        from: 'checkout',
        to: 'purchase',
        p: { mean: 0.45 },
        conditional_p: [
          { condition: 'visited(promo)', p: { mean: 0.6 } },
        ],
      } as any,
    ],
    nodes: [
      {
        uuid: 'case-node-uuid',
        id: 'promo-gate',
        type: 'case',
        case: {
          id: 'promo-experiment',
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment', weight: 0.5 },
          ],
        },
      } as any,
    ],
  } as any;

  it('Sheets edge param: contextual keys (mean, p.mean) scoped to edge-param', () => {
    const flatPack = {
      'mean': 0.55,
      'p.stdev': 0.02,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeId: 'checkout-to-purchase', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p).toEqual({
      mean: 0.55,
      stdev: 0.02,
    });
    expect(Object.keys(scoped.edges || {})).toHaveLength(1);
  });

  it('Sheets edge param: HRN keys (e.edge-id.p.mean) scoped to edge-param', () => {
    const flatPack = {
      'e.checkout-to-purchase.p.mean': 0.55,
      'e.checkout-to-purchase.p.stdev': 0.02,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeUuid: 'edge-uuid-1', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p).toEqual({
      mean: 0.55,
      stdev: 0.02,
    });
  });

  it('Sheets conditional p: HRN keys scoped to edge-conditional', () => {
    const flatPack = {
      'e.checkout-to-purchase.visited(promo).p.mean': 0.65,
      'e.checkout-to-purchase.visited(promo).p.stdev': 0.03,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-conditional', edgeId: 'checkout-to-purchase', condition: 'visited(promo)' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.conditional_p?.['visited(promo)']).toEqual({
      mean: 0.65,
      stdev: 0.03,
    });
    expect(Object.keys(scoped.edges?.['checkout-to-purchase']?.conditional_p || {})).toHaveLength(1);
  });

  it('Sheets case variants: HRN keys scoped to case', () => {
    const flatPack = {
      'n.promo-gate.case(promo-experiment:control).weight': 0.7,
      'n.promo-gate.case(promo-experiment:treatment).weight': 0.3,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'case', nodeId: 'promo-gate' },
      mockGraph
    );

    expect(scoped.nodes?.['promo-gate']?.case?.variants).toEqual([
      { name: 'control', weight: 0.7 },
      { name: 'treatment', weight: 0.3 },
    ]);
  });

  it('Sheets edge param: out-of-scope HRNs are dropped', () => {
    const flatPack = {
      'e.checkout-to-purchase.p.mean': 0.55,
      'e.other-edge.p.mean': 0.99, // out of scope
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeId: 'checkout-to-purchase', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.55);
    expect(scoped.edges?.['other-edge']).toBeUndefined();
  });

  it('Sheets edge param: wrong slot keys are dropped', () => {
    const flatPack = {
      'mean': 0.55,
      'cost_gbp.mean': 10.0, // out of scope for slot=p
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeId: 'checkout-to-purchase', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.55);
    expect(scoped.edges?.['checkout-to-purchase']?.cost_gbp).toBeUndefined();
  });
});

describe('ParamPackDSLService: HRN equivalence (e.edge-id vs e.from(a).to(b))', () => {
  it('accepts e.uuid(<uuid>) HRN for edges', () => {
    const mockGraph: Graph = {
      graph_version: '1.0',
      id: 'test-graph',
      edges: [
        {
          uuid: 'edge-uuid-1',
          id: 'checkout-to-purchase',
          from: 'checkout-uuid',
          to: 'purchase-uuid',
        } as any,
      ],
      nodes: [
        { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
        { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
      ],
    } as any;

    const flatPackUuid = { 'e.uuid(edge-uuid-1).p.mean': 0.6 };
    const flatPackId = { 'e.checkout-to-purchase.p.mean': 0.6 };

    const { params: paramsFromUuid } = parseFlatHRNToParams(flatPackUuid, mockGraph);
    const { params: paramsFromId } = parseFlatHRNToParams(flatPackId, mockGraph);

    const edgeKeyFromUuid = Object.keys(paramsFromUuid.edges || {})[0];
    const edgeKeyFromId = Object.keys(paramsFromId.edges || {})[0];
    expect(edgeKeyFromUuid).toBe(edgeKeyFromId);
    expect(paramsFromUuid).toEqual(paramsFromId);
  });
  it('resolves e.from(checkout).to(purchase) to the same edge as e.checkout-to-purchase', () => {
    const mockGraph: Graph = {
      graph_version: '1.0',
      id: 'test-graph',
      edges: [
        {
          uuid: 'edge-uuid-1',
          id: 'checkout-to-purchase',
          from: 'checkout-uuid',
          to: 'purchase-uuid',
        } as any,
      ],
      nodes: [
        { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
        { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
      ],
    } as any;

    const flatPackHRN = { 'e.from(checkout).to(purchase).p.mean': 0.6 };
    const flatPackId = { 'e.checkout-to-purchase.p.mean': 0.6 };

    const { params: paramsFromHRN } = parseFlatHRNToParams(flatPackHRN, mockGraph);
    const { params: paramsFromId } = parseFlatHRNToParams(flatPackId, mockGraph);

    // After resolution, both should resolve to the same edge
    // The implementation uses UUIDs internally, but we verify both resolve identically
    const edgeKeyFromHRN = Object.keys(paramsFromHRN.edges || {})[0];
    const edgeKeyFromId = Object.keys(paramsFromId.edges || {})[0];
    
    expect(edgeKeyFromHRN).toBe(edgeKeyFromId);
    expect(paramsFromHRN).toEqual(paramsFromId);
  });

  it('normalizes conditional_p condition strings (visited(promo) → visited(promo-uuid))', () => {
    const mockGraph: Graph = {
      graph_version: '1.0',
      id: 'test-graph',
      edges: [
        {
          uuid: 'edge-uuid-1',
          id: 'checkout-to-purchase',
          from: 'checkout-uuid',
          to: 'purchase-uuid',
        } as any,
      ],
      nodes: [
        { uuid: 'promo-uuid', id: 'promo', type: 'standard' } as any,
      ],
    } as any;

    const flatPack = {
      'e.checkout-to-purchase.visited(promo).p.mean': 0.7,
      'e.checkout-to-purchase.visited(promo).p.stdev': 0.05,
    };

    const { params } = parseFlatHRNToParams(flatPack, mockGraph);

    const edgeKey = Object.keys(params.edges || {})[0];
    
    // Condition keys should be normalized (promo → promo-uuid)
    const condKeys = Object.keys(params.edges?.[edgeKey]?.conditional_p || {});
    expect(condKeys).toEqual(['visited(promo-uuid)']);
    expect(
      params.edges?.[edgeKey]?.conditional_p?.['visited(promo-uuid)']?.mean
    ).toBe(0.7);
    expect(
      params.edges?.[edgeKey]?.conditional_p?.['visited(promo-uuid)']?.stdev
    ).toBe(0.05);
  });

  it('handles direct edge ID vs from().to() HRN equivalently with conditional_p', () => {
    const mockGraph: Graph = {
      graph_version: '1.0',
      id: 'test-graph',
      edges: [
        {
          uuid: 'edge-uuid-1',
          id: 'checkout-to-purchase',
          from: 'checkout-uuid',
          to: 'purchase-uuid',
        } as any,
      ],
      nodes: [
        { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
        { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
        { uuid: 'promo-uuid', id: 'promo', type: 'standard' } as any,
      ],
    } as any;

    // Test 1: Direct edge ID with conditional
    const flatPackDirect = {
      'e.checkout-to-purchase.visited(promo).p.mean': 0.75,
    };

    // Test 2: from().to() HRN with conditional (user-preferred format)
    const flatPackHRN = {
      'e.from(checkout).to(purchase).visited(promo).p.mean': 0.75,
    };

    const { params: paramsFromDirect } = parseFlatHRNToParams(flatPackDirect, mockGraph);
    const { params: paramsFromHRN } = parseFlatHRNToParams(flatPackHRN, mockGraph);

    // Both should resolve to the same edge (key may be ID or UUID, but must match)
    const edgeKeyFromDirect = Object.keys(paramsFromDirect.edges || {})[0];
    const edgeKeyFromHRN = Object.keys(paramsFromHRN.edges || {})[0];
    expect(edgeKeyFromDirect).toBe(edgeKeyFromHRN);

    // Both should have exactly one conditional entry for promo
    const condMapDirect = paramsFromDirect.edges?.[edgeKeyFromDirect]?.conditional_p || {};
    const condMapHRN = paramsFromHRN.edges?.[edgeKeyFromHRN]?.conditional_p || {};
    const condKeysDirect = Object.keys(condMapDirect);
    const condKeysHRN = Object.keys(condMapHRN);
    expect(condKeysDirect).toHaveLength(1);
    expect(condKeysHRN).toHaveLength(1);

    const condKeyDirect = condKeysDirect[0];
    const condKeyHRN = condKeysHRN[0];
    // Internal condition keys may include UUIDs; just assert they both refer to promo
    expect(condKeyDirect).toContain('visited');
    expect(condKeyDirect).toContain('promo');
    expect(condKeyHRN).toContain('visited');
    expect(condKeyHRN).toContain('promo');

    expect(condMapDirect[condKeyDirect]).not.toBeNull();
    expect(condMapHRN[condKeyHRN]).not.toBeNull();
    expect(condMapDirect[condKeyDirect]!.mean).toBe(0.75);
    expect(condMapHRN[condKeyHRN]!.mean).toBe(0.75);
  });
});

