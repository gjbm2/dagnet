/**
 * Tests for scenario creation, editing, and composition with conditional_p
 */

import { describe, it, expect } from 'vitest';
import {
  flattenParams,
  unflattenParams,
  fromYAML,
  toYAML,
  parseFlatHRNToParams,
} from '../ParamPackDSLService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import type { Graph } from '../../types';
import type { ScenarioParams } from '../../types/scenarios';

describe('Scenario snapshots with conditional_p', () => {
  const mockGraph: Graph = {
    graph_version: '1.0',
    id: 'test-graph',
    edges: [
      {
        uuid: 'edge-uuid-1',
        id: 'checkout-to-purchase',
        from: 'checkout-uuid',
        to: 'purchase-uuid',
        p: { mean: 0.5 },
        conditional_p: [
          {
            condition: 'visited(promo-uuid)',
            p: { mean: 0.8, stdev: 0.05 },
          },
          {
            condition: 'visited(blog-uuid)',
            p: { mean: 0.6 },
          },
        ],
      } as any,
    ],
    nodes: [
      { uuid: 'checkout-uuid', id: 'checkout', type: 'standard' } as any,
      { uuid: 'purchase-uuid', id: 'purchase', type: 'standard' } as any,
      { uuid: 'promo-uuid', id: 'promo', type: 'standard' } as any,
      { uuid: 'blog-uuid', id: 'blog', type: 'standard' } as any,
    ],
  } as any;

  it('extractParamsFromGraph correctly captures conditional_p', () => {
    const params = extractParamsFromGraph(mockGraph);

    expect(params.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.5);
    expect(params.edges?.['checkout-to-purchase']?.conditional_p).toBeDefined();
    
    // Note: condition keys in the extracted params use the graph's stored condition strings
    // (which already contain UUIDs since that's how they're stored in the graph)
    const condKeys = Object.keys(params.edges?.['checkout-to-purchase']?.conditional_p || {});
    expect(condKeys).toContain('visited(promo-uuid)');
    expect(condKeys).toContain('visited(blog-uuid)');
  });

  it('flattenParams produces correct DSL format for conditional_p', () => {
    const params = extractParamsFromGraph(mockGraph);
    const flat = flattenParams(params);

    expect(flat['e.checkout-to-purchase.p.mean']).toBe(0.5);
    
    // Conditional probabilities use the format: e.<edge-id>.<condition>.p.<field>
    // NO 'conditional_p' segment in the DSL
    expect(flat['e.checkout-to-purchase.visited(promo-uuid).p.mean']).toBe(0.8);
    expect(flat['e.checkout-to-purchase.visited(promo-uuid).p.stdev']).toBe(0.05);
    expect(flat['e.checkout-to-purchase.visited(blog-uuid).p.mean']).toBe(0.6);
    
    // Verify the old (wrong) format is NOT present
    expect(flat['e.checkout-to-purchase.conditional_p.visited(promo-uuid).mean']).toBeUndefined();
  });

  it('toYAML/fromYAML round-trip preserves conditional_p', () => {
    const params = extractParamsFromGraph(mockGraph);
    const yaml = toYAML(params, 'flat');

    // Verify YAML uses correct DSL format (condition between edge ID and .p.)
    expect(yaml).toContain('visited(promo-uuid).p.mean');
    expect(yaml).toContain('visited(blog-uuid).p.mean');
    
    // Verify old format is NOT present
    expect(yaml).not.toContain('.conditional_p.');

    // Round-trip
    const parsedParams = fromYAML(yaml, 'flat');

    const condKeys = Object.keys(parsedParams.edges?.['checkout-to-purchase']?.conditional_p || {});
    expect(condKeys).toContain('visited(promo-uuid)');
    expect(condKeys).toContain('visited(blog-uuid)');
  });

  it('allows editing conditional_p using from().to() HRN syntax (user-preferred)', () => {
    // User edits scenario YAML using from().to() syntax (more readable than edge IDs)
    const yamlContent = `
e.from(checkout).to(purchase).visited(promo).p.mean: 0.9
e.from(checkout).to(purchase).visited(promo).p.stdev: 0.02
`;

    // Parse with graph for HRN resolution
    const params = fromYAML(yamlContent, 'flat', mockGraph);

    // Should resolve to the edge (internally uses UUID but test should be ID-agnostic)
    const edgeKeys = Object.keys(params.edges || {});
    expect(edgeKeys).toHaveLength(1);
    const edgeKey = edgeKeys[0];

    // Condition should be normalized (promo → promo-uuid internally)
    const condKeys = Object.keys(params.edges?.[edgeKey]?.conditional_p || {});
    expect(condKeys).toHaveLength(1);
    const condKey = condKeys[0];
    
    // Verify the condition was normalized (contains promo-uuid)
    expect(condKey).toContain('promo-uuid');
    expect(condKey).toContain('visited');

    // Values should be correct
    expect(params.edges?.[edgeKey]?.conditional_p?.[condKey]?.mean).toBe(0.9);
    expect(params.edges?.[edgeKey]?.conditional_p?.[condKey]?.stdev).toBe(0.02);
  });

  it('handles mixed base and conditional probabilities', () => {
    const yamlContent = `
e.checkout-to-purchase.p.mean: 0.55
e.checkout-to-purchase.p.stdev: 0.1
e.checkout-to-purchase.visited(promo).p.mean: 0.85
e.checkout-to-purchase.visited(blog).p.mean: 0.65
`;

    // Parse with graph to normalize node references in conditions
    const params = fromYAML(yamlContent, 'flat', mockGraph);

    expect(params.edges?.['checkout-to-purchase']?.p?.mean).toBe(0.55);
    expect(params.edges?.['checkout-to-purchase']?.p?.stdev).toBe(0.1);
    
    // Conditions should be normalized internally
    const condKeys = Object.keys(params.edges?.['checkout-to-purchase']?.conditional_p || {});
    expect(condKeys).toHaveLength(2);
    
    // Check that values are present (key format is internal detail)
    const allCondValues = Object.values(params.edges?.['checkout-to-purchase']?.conditional_p || {});
    const means = allCondValues.map((v: any) => v?.mean).filter(Boolean);
    expect(means).toContain(0.85);
    expect(means).toContain(0.65);
  });

  it('handles complex condition strings with multiple clauses', () => {
    const flatPack = {
      'e.checkout-to-purchase.visited(promo).exclude(blog).p.mean': 0.75,
    };

    const params = unflattenParams(flatPack);

    const condKeys = Object.keys(params.edges?.['checkout-to-purchase']?.conditional_p || {});
    // The complex condition should be preserved as a single key
    expect(condKeys).toHaveLength(1);
    expect(condKeys[0]).toContain('visited');
    expect(condKeys[0]).toContain('exclude');
    expect(condKeys[0]).toContain('promo');
    expect(condKeys[0]).toContain('blog');
    
    const condKey = condKeys[0];
    expect(params.edges?.['checkout-to-purchase']?.conditional_p?.[condKey]?.mean).toBe(0.75);
  });
});

