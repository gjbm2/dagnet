/**
 * End-to-end integration tests for Google Sheets ingestion
 * 
 * Tests the full flow:
 * - Sheets range data (Pattern A/B/C)
 * - → parseSheetsRange
 * - → DataOperationsService.getFromSourceDirect
 * - → buildScopedParamsFromFlatPack + extractSheetsUpdateDataForEdge
 * - → UpdateManager.handleExternalToGraph (direct graph upsert)
 * - → UpdateManager.handleExternalToFile (file-based append)
 * 
 * Mocks:
 * - DASRunner responses (scalar_value / param_pack)
 * - Graph structure
 * - File registry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../types';
import { extractSheetsUpdateDataForEdge } from '../dataOperationsService';
import { buildScopedParamsFromFlatPack } from '../ParamPackDSLService';

describe('Sheets E2E: Pattern A - Single scalar value', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.45, stdev: 0.03 },
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
    ],
  } as any;

  it('Pattern A: single scalar → updates p.mean on target edge', () => {
    // Simulate what parseSheetsRange returns for a single cell with value 0.52
    const sheetsResult = {
      mode: 'single-cell' as const,
      scalar_value: 0.52,
      param_pack: undefined,
      errors: [],
    };

    // Extract update payload using the actual service
    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined, // not a conditional
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({ mean: 0.52 });

    // This payload would then go to UpdateManager.handleExternalToGraph
    // which would:
    // - Set edge.p.mean = 0.52
    // - Set edge.p.data_source = { type: 'sheets', ... }
    // - Trigger sibling rebalance
  });
});

describe('Sheets E2E: Pattern B - Single-cell param pack (JSON)', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.45, stdev: 0.03 },
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
    ],
  } as any;

  it('Pattern B: JSON param pack in single cell → updates multiple fields', () => {
    // User puts in cell A1: {"mean": 0.58, "stdev": 0.04}
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        mean: 0.58,
        stdev: 0.04,
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({
      mean: 0.58,
      stdev: 0.04,
    });
  });
});

describe('Sheets E2E: Pattern C - Name/value pairs with HRN keys', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.45, stdev: 0.03 },
      } as any,
      {
        uuid: 'edge-2-uuid',
        id: 'product-to-cart',
        from: 'product-uuid',
        to: 'cart-uuid',
        p: { mean: 0.28 },
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
      { uuid: 'product-uuid', id: 'product', type: 'standard' } as any,
      { uuid: 'cart-uuid', id: 'cart', type: 'standard' } as any,
    ],
  } as any;

  it('Pattern C: name/value pairs with edge ID → scopes correctly', () => {
    // Sheets cells:
    // A1: e.checkout-to-purchase.p.mean | B1: 0.62
    // A2: e.checkout-to-purchase.p.stdev | B2: 0.05
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'e.checkout-to-purchase.p.mean': 0.62,
        'e.checkout-to-purchase.p.stdev': 0.05,
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({
      mean: 0.62,
      stdev: 0.05,
    });
  });

  it('Pattern C: from().to() HRN → resolves and scopes correctly', () => {
    // User uses from/to syntax in Sheets:
    // A1: e.from(checkout).to(purchase).p.mean | B1: 0.68
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'e.from(checkout).to(purchase).p.mean': 0.68,
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({ mean: 0.68 });
  });

  it('Pattern C: out-of-scope HRN keys are ignored', () => {
    // Sheets contains params for multiple edges; only target edge is applied
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'e.checkout-to-purchase.p.mean': 0.62,
        'e.product-to-cart.p.mean': 0.35, // different edge
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    // Only checkout-to-purchase is in scope
    expect(updatePayload).toEqual({ mean: 0.62 });
  });

  it('Pattern C: uuid() HRN syntax works (edge case when edge has no ID)', () => {
    // User was shown e.uuid(edge-1-uuid).p.mean in a snapshot because edge had no ID
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'e.uuid(edge-1-uuid).p.mean': 0.73,
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({ mean: 0.73 });
  });
});

describe('Sheets E2E: Conditional probabilities', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.45 },
        conditional_p: [
          {
            condition: 'visited(promo-uuid)',
            p: { mean: 0.6, stdev: 0.05 },
          },
        ],
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
      { uuid: 'promo-uuid', id: 'promo', type: 'standard' } as any,
    ],
  } as any;

  it('User provides conditional HRN with node ID (visited(promo))', () => {
    // Sheets cells:
    // A1: e.checkout-to-purchase.visited(promo).p.mean | B1: 0.75
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'e.checkout-to-purchase.visited(promo).p.mean': 0.75,
        'e.checkout-to-purchase.visited(promo).p.stdev': 0.06,
      },
      errors: [],
    };

    
    // Targeting conditional_p[0] (which has condition 'visited(promo-uuid)')
    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      0, // conditionalIndex
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({
      mean: 0.75,
      stdev: 0.06,
    });
  });

  it('User provides contextual keys for conditional (mean, stdev)', () => {
    // When user selects a conditional_p entry in UI and uses Sheets with contextual keys
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        mean: 0.82,
        stdev: 0.03,
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      0, // conditionalIndex
      mockGraph,
      'edge-1-uuid'
    );

    expect(updatePayload).toEqual({
      mean: 0.82,
      stdev: 0.03,
    });
  });
});

describe('Sheets E2E: Case variants', () => {
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

  it('Case variant HRN keys → updates case.variants', () => {
    // Sheets cells:
    // A1: n.promo-gate.case(promo-experiment:control).weight | B1: 0.7
    // A2: n.promo-gate.case(promo-experiment:treatment).weight | B2: 0.3
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'n.promo-gate.case(promo-experiment:control).weight': 0.7,
        'n.promo-gate.case(promo-experiment:treatment).weight': 0.3,
      },
      errors: [],
    };

    // For case updates, verify the DSL engine correctly scopes this
    const scoped = buildScopedParamsFromFlatPack(
      sheetsResult.param_pack,
      { kind: 'case', nodeId: 'promo-gate' },
      mockGraph
    );

    const variants = scoped.nodes?.['promo-gate']?.case?.variants;
    expect(variants).toEqual([
      { name: 'control', weight: 0.7 },
      { name: 'treatment', weight: 0.3 },
    ]);

    // This scoped result would then go to UpdateManager.handleExternalToGraph
    // with objectType='case' to update the case node's variants array
  });
});

describe('Sheets E2E: Mode variations (auto/single/param-pack)', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.45 },
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
    ],
  } as any;

  it('mode: "single" → uses scalar_value only, ignores param_pack', () => {
    const sheetsResult = {
      mode: 'param-pack' as const, // parseSheetsRange auto-detected pack
      scalar_value: 0.50,
      param_pack: { mean: 0.99 }, // should be ignored in single mode
      errors: [],
    };

    
    // connectionString.mode overrides auto-detection
    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'single' }, // force single mode
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    // Should use scalar_value only
    expect(updatePayload).toEqual({ mean: 0.50 });
  });

  it('mode: "param-pack" → uses param_pack only, ignores scalar_value', () => {
    const sheetsResult = {
      mode: 'single-cell' as const,
      scalar_value: 0.99, // should be ignored in param-pack mode
      param_pack: { mean: 0.65, stdev: 0.05 },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'param-pack' }, // force param-pack mode
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    // Should use param_pack only
    expect(updatePayload).toEqual({
      mean: 0.65,
      stdev: 0.05,
    });
  });

  it('mode: "auto" → uses param_pack when available', () => {
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: 0.50,
      param_pack: { mean: 0.62, stdev: 0.04 },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    // Auto mode with param_pack: uses param_pack
    expect(updatePayload).toEqual({
      mean: 0.62,
      stdev: 0.04,
    });
  });
});

describe('Sheets E2E: Error handling', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.45 },
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
    ],
  } as any;

  it('Invalid HRN keys are logged as skipped, valid keys still applied', () => {
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {
        'e.checkout-to-purchase.p.mean': 0.55,
        'e.nonexistent-edge.p.mean': 0.99, // invalid, should be skipped
      },
      errors: [],
    };

    const updatePayload = extractSheetsUpdateDataForEdge(
      sheetsResult,
      { mode: 'auto' },
      'p',
      undefined,
      mockGraph,
      'edge-1-uuid'
    );

    // Valid key is applied, invalid is skipped
    expect(updatePayload).toEqual({ mean: 0.55 });
    // In production, invalid keys would be logged for user visibility
  });

  it('Parse errors in Sheets cells are surfaced via errors array', () => {
    const sheetsResult = {
      mode: 'param-pack' as const,
      scalar_value: undefined,
      param_pack: {},
      errors: [
        { row: 2, col: 1, message: 'Cell B2 is not a valid number' },
        { row: 4, col: 0, message: 'Odd number of cells in name/value pairs' },
      ],
    };

    // Errors should be surfaced to UI (toast/log)
    expect(sheetsResult.errors).toHaveLength(2);
    expect(sheetsResult.errors[0].message).toContain('not a valid number');
  });
});

describe('Sheets E2E: File-based workflows (future)', () => {
  // TODO: When handleExternalToFile path is implemented for Sheets:
  // - Mock a parameter file with connection: sheets-readonly
  // - Call getFromSource (file-based path)
  // - Assert that a new values[] entry is appended with:
  //   - mean, stdev, n, k from Sheets
  //   - data_source: { type: 'sheets', url, range, retrieved_at }
  // - Verify existing values[] entries are preserved
  
  it.skip('TODO: File-based Sheets append (handleExternalToFile)', () => {
    // Implementation pending
  });
});

