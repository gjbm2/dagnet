/**
 * Integration tests for Sheets data ingestion flows via DataOperationsService
 * 
 * NOTE: These are skeleton tests showing the intended behavior.
 * Full mocking of DASRunner, fileRegistry, and UpdateManager is complex
 * and requires careful setup. For now, these tests document the expected
 * contract between Sheets ingestion and the canonical DSL engine.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScopedParamsFromFlatPack,
  unflattenParams,
  applyScopeToParams,
} from '../ParamPackDSLService';
import type { Graph } from '../../types';

describe('Sheets edge parameter ingestion: canonical DSL engine usage', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout',
        to: 'purchase',
        p: { mean: 0.45, stdev: 0.03 },
      } as any,
      {
        uuid: 'edge-2-uuid',
        id: 'product-to-cart',
        from: 'product',
        to: 'cart',
        p: { mean: 0.3 },
      } as any,
    ],
    nodes: [
      { uuid: 'node-1', id: 'checkout', type: 'standard' } as any,
      { uuid: 'node-2', id: 'purchase', type: 'standard' } as any,
    ],
  } as any;

  it('Sheets scalar -> contextual mean via buildScopedParamsFromFlatPack', () => {
    const flatPack = { mean: 0.55 };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeId: 'checkout-to-purchase', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.55);
  });

  it('Sheets param_pack with HRN keys scoped correctly', () => {
    const flatPack = {
      'e.checkout-to-purchase.p.mean': 0.52,
      'e.product-to-cart.p.mean': 0.35, // out of scope
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeId: 'checkout-to-purchase', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.52);
    expect(scoped.edges?.['product-to-cart']).toBeUndefined();
  });

  it('Sheets param_pack with contextual keys (mean, p.stdev)', () => {
    const flatPack = {
      mean: 0.58,
      'p.stdev': 0.04,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-param', edgeUuid: 'edge-1-uuid', slot: 'p' },
      mockGraph
    );

    expect(scoped.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.58);
    expect(scoped.edges?.['checkout-to-purchase']?.p?.stdev).toBe(0.04);
  });
});

describe('Sheets conditional_p ingestion: canonical DSL engine usage', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout',
        to: 'purchase',
        p: { mean: 0.45 },
        conditional_p: [
          {
            condition: 'visited(promo)',
            p: { mean: 0.6, stdev: 0.05 },
          },
          {
            condition: 'visited(blog)',
            p: { mean: 0.4 },
          },
        ],
      } as any,
    ],
    nodes: [
      { uuid: 'node-1', id: 'checkout', type: 'standard' } as any,
      { uuid: 'node-2', id: 'purchase', type: 'standard' } as any,
      { uuid: 'node-promo', id: 'promo', type: 'standard' } as any,
    ],
  } as any;

  it('Sheets conditional_p param_pack scoped to edge-conditional', () => {
    const flatPack = {
      'e.checkout-to-purchase.visited(promo).p.mean': 0.68,
      'e.checkout-to-purchase.visited(promo).p.stdev': 0.04,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-conditional', edgeId: 'checkout-to-purchase', condition: 'visited(promo)' },
      mockGraph
    );

    const edgeConds = scoped.edges?.['checkout-to-purchase']?.conditional_p || {};
    const keys = Object.keys(edgeConds);
    expect(keys).toHaveLength(1);
    const key = keys[0];
    // Internal key may be normalized (e.g. visited(promo-uuid)), so just ensure it's the promo condition
    expect(key).toContain('visited');
    expect(key).toContain('promo');
    expect(edgeConds[key].mean).toBe(0.68);
    expect(edgeConds[key].stdev).toBe(0.04);
  });

  it('Sheets conditional_p with contextual keys scoped to edge-conditional', () => {
    const flatPack = {
      mean: 0.72,
      stdev: 0.06,
    };

    const scoped = buildScopedParamsFromFlatPack(
      flatPack,
      { kind: 'edge-conditional', edgeUuid: 'edge-1-uuid', condition: 'visited(promo)' },
      mockGraph
    );

    const edgeConds = scoped.edges?.['checkout-to-purchase']?.conditional_p || {};
    const keys = Object.keys(edgeConds);
    expect(keys).toHaveLength(1);
    const key = keys[0];
    expect(key).toContain('visited');
    expect(key).toContain('promo');
    expect(edgeConds[key].mean).toBe(0.72);
    expect(edgeConds[key].stdev).toBe(0.06);
  });
});

describe('Sheets case variant ingestion: canonical DSL engine usage', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [],
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

  it('Sheets param_pack with case HRN keys scoped to case', () => {
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
});
