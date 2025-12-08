/**
 * Case Runtime Probability Tests
 * 
 * Tests for:
 * - Edge probability = edge.p.mean × variant.weight
 * - Case variant effect on path analysis
 * - What-if case overrides (case(id:variant) DSL)
 * 
 * CRITICAL GAP: These had ZERO test coverage previously.
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { computeEffectiveEdgeProbability, parseWhatIfDSL } from '../../lib/whatIf';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createGraphWithCaseNode(options: {
  caseNodeId?: string;
  caseId?: string;
  variants?: Array<{ name: string; weight: number }>;
  edges?: Array<{
    uuid: string;
    from: string;
    to: string;
    case_variant?: string;
    case_id?: string;
    p?: { mean: number };
  }>;
} = {}) {
  const caseNodeId = options.caseNodeId || 'case-node-1';
  const caseId = options.caseId || 'test-case';
  const variants = options.variants || [
    { name: 'control', weight: 0.5 },
    { name: 'treatment', weight: 0.5 }
  ];

  return {
    nodes: [
      {
        uuid: caseNodeId,
        id: caseNodeId,
        type: 'case',
        case: {
          id: caseId,
          status: 'active',
          variants
        }
      },
      { uuid: 'target-a', id: 'target-a' },
      { uuid: 'target-b', id: 'target-b' }
    ],
    edges: options.edges || [
      {
        uuid: 'edge-control',
        id: 'edge-control',
        from: caseNodeId,
        to: 'target-a',
        case_variant: 'control',
        case_id: caseId,
        p: { mean: 0.8 }
      },
      {
        uuid: 'edge-treatment',
        id: 'edge-treatment',
        from: caseNodeId,
        to: 'target-b',
        case_variant: 'treatment',
        case_id: caseId,
        p: { mean: 0.9 }
      }
    ]
  };
}

// ============================================================================
// TEST SUITE 1: Basic Case Variant Probability
// ============================================================================

describe('Case Runtime Probability', () => {
  describe('Edge probability with variant weights', () => {
    it('should multiply edge.p.mean by variant.weight', () => {
      const graph = createGraphWithCaseNode({
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ],
        edges: [
          {
            uuid: 'edge-control',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'control',
            case_id: 'test-case',
            p: { mean: 0.8 }
          }
        ]
      });

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-control',
        { whatIfDSL: null }
      );

      // 0.8 × 0.5 = 0.4
      expect(probability).toBeCloseTo(0.4, 10);
    });

    it('should handle variant weight of 1.0', () => {
      const graph = createGraphWithCaseNode({
        variants: [
          { name: 'control', weight: 1.0 },
          { name: 'treatment', weight: 0.0 }
        ],
        edges: [
          {
            uuid: 'edge-control',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'control',
            case_id: 'test-case',
            p: { mean: 0.8 }
          }
        ]
      });

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-control',
        { whatIfDSL: null }
      );

      // 0.8 × 1.0 = 0.8
      expect(probability).toBe(0.8);
    });

    it('should return 0 when variant weight is 0', () => {
      const graph = createGraphWithCaseNode({
        variants: [
          { name: 'control', weight: 1.0 },
          { name: 'treatment', weight: 0.0 }
        ],
        edges: [
          {
            uuid: 'edge-treatment',
            from: 'case-node-1',
            to: 'target-b',
            case_variant: 'treatment',
            case_id: 'test-case',
            p: { mean: 0.9 }
          }
        ]
      });

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-treatment',
        { whatIfDSL: null }
      );

      // 0.9 × 0.0 = 0
      expect(probability).toBe(0);
    });

    it('should infer case_id from source node when not set on edge', () => {
      const graph = createGraphWithCaseNode({
        caseNodeId: 'case-node-uuid',
        caseId: 'my-case',
        variants: [
          { name: 'control', weight: 0.6 },
          { name: 'treatment', weight: 0.4 }
        ],
        edges: [
          {
            uuid: 'edge-1',
            from: 'case-node-uuid',  // Match by uuid
            to: 'target-a',
            case_variant: 'control',
            // case_id intentionally NOT set - should be inferred
            p: { mean: 1.0 }
          }
        ]
      });

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-1',
        { whatIfDSL: null }
      );

      // 1.0 × 0.6 = 0.6
      expect(probability).toBeCloseTo(0.6, 10);
    });

    it('should handle edge without case_variant (not a case edge)', () => {
      const graph = {
        nodes: [
          { uuid: 'node-a', id: 'node-a' },
          { uuid: 'node-b', id: 'node-b' }
        ],
        edges: [
          {
            uuid: 'edge-1',
            from: 'node-a',
            to: 'node-b',
            p: { mean: 0.75 }
            // No case_variant - regular edge
          }
        ]
      };

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-1',
        { whatIfDSL: null }
      );

      // Just returns edge.p.mean
      expect(probability).toBe(0.75);
    });
  });

  // ============================================================================
  // TEST SUITE 2: What-If Case Overrides
  // ============================================================================

  describe('What-If case overrides', () => {
    it('should set variant to 100% when overridden', () => {
      const graph = createGraphWithCaseNode({
        caseNodeId: 'case-node-1',
        caseId: 'checkout-test',
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 }
        ],
        edges: [
          {
            uuid: 'edge-control',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'control',
            case_id: 'checkout-test',
            p: { mean: 0.8 }
          },
          {
            uuid: 'edge-treatment',
            from: 'case-node-1',
            to: 'target-b',
            case_variant: 'treatment',
            case_id: 'checkout-test',
            p: { mean: 0.9 }
          }
        ]
      });

      // What-if: force treatment to 100%
      const whatIfDSL = 'case(case-node-1:treatment)';

      // Control edge: should be 0 (forced to 0%)
      const controlProb = computeEffectiveEdgeProbability(
        graph,
        'edge-control',
        { whatIfDSL }
      );
      expect(controlProb).toBe(0);

      // Treatment edge: should be 0.9 × 1.0 = 0.9
      const treatmentProb = computeEffectiveEdgeProbability(
        graph,
        'edge-treatment',
        { whatIfDSL }
      );
      expect(treatmentProb).toBe(0.9);
    });

    it('should parse case DSL correctly', () => {
      const graph = createGraphWithCaseNode({
        caseNodeId: 'my-case-node'
      });

      const parsed = parseWhatIfDSL('case(my-case-node:treatment)', graph);

      expect(parsed.caseOverrides).toBeDefined();
      expect(parsed.caseOverrides['my-case-node']).toBe('treatment');
    });

    it('should handle multiple case overrides in DSL', () => {
      const graph = {
        nodes: [
          {
            uuid: 'case-1',
            id: 'case-1',
            type: 'case',
            case: {
              id: 'case-1',
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment', weight: 0.5 }
              ]
            }
          },
          {
            uuid: 'case-2',
            id: 'case-2',
            type: 'case',
            case: {
              id: 'case-2',
              variants: [
                { name: 'variant-a', weight: 0.33 },
                { name: 'variant-b', weight: 0.67 }
              ]
            }
          },
          { uuid: 'target', id: 'target' }
        ],
        edges: [
          {
            uuid: 'edge-1',
            from: 'case-1',
            to: 'target',
            case_variant: 'control',
            case_id: 'case-1',
            p: { mean: 1.0 }
          }
        ]
      };

      const whatIfDSL = 'case(case-1:treatment).case(case-2:variant-b)';
      const parsed = parseWhatIfDSL(whatIfDSL, graph);

      expect(parsed.caseOverrides['case-1']).toBe('treatment');
      expect(parsed.caseOverrides['case-2']).toBe('variant-b');
    });

    it('should combine case override with regular probability', () => {
      const graph = createGraphWithCaseNode({
        variants: [
          { name: 'control', weight: 0.3 },  // Will be overridden to 1.0
          { name: 'treatment', weight: 0.7 }
        ],
        edges: [
          {
            uuid: 'edge-1',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'control',
            case_id: 'test-case',
            p: { mean: 0.6 }
          }
        ]
      });

      // Without override: 0.6 × 0.3 = 0.18
      const withoutOverride = computeEffectiveEdgeProbability(
        graph,
        'edge-1',
        { whatIfDSL: null }
      );
      expect(withoutOverride).toBeCloseTo(0.18, 10);

      // With override: 0.6 × 1.0 = 0.6
      const withOverride = computeEffectiveEdgeProbability(
        graph,
        'edge-1',
        { whatIfDSL: 'case(case-node-1:control)' }
      );
      expect(withOverride).toBe(0.6);
    });
  });

  // ============================================================================
  // TEST SUITE 3: Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should return 0 for missing edge', () => {
      const graph = createGraphWithCaseNode();

      const probability = computeEffectiveEdgeProbability(
        graph,
        'nonexistent-edge',
        { whatIfDSL: null }
      );

      expect(probability).toBe(0);
    });

    it('should return 0 for empty graph', () => {
      const probability = computeEffectiveEdgeProbability(
        { nodes: [], edges: [] },
        'edge-1',
        { whatIfDSL: null }
      );

      expect(probability).toBe(0);
    });

    it('should handle variant not found in case node', () => {
      const graph = createGraphWithCaseNode({
        variants: [
          { name: 'control', weight: 1.0 }
          // 'treatment' variant is missing
        ],
        edges: [
          {
            uuid: 'edge-1',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'treatment',  // Points to missing variant
            case_id: 'test-case',
            p: { mean: 0.8 }
          }
        ]
      });

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-1',
        { whatIfDSL: null }
      );

      // Variant not found, weight = 0
      expect(probability).toBe(0);
    });

    it('should handle case node not found', () => {
      const graph = {
        nodes: [
          { uuid: 'regular-node', id: 'regular-node' },  // Not a case node
          { uuid: 'target', id: 'target' }
        ],
        edges: [
          {
            uuid: 'edge-1',
            from: 'regular-node',
            to: 'target',
            case_variant: 'treatment',  // Points to non-case node
            case_id: 'nonexistent-case',
            p: { mean: 0.8 }
          }
        ]
      };

      const probability = computeEffectiveEdgeProbability(
        graph,
        'edge-1',
        { whatIfDSL: null }
      );

      // Case node not found, just return base probability
      // (The edge has case_variant but the from node isn't a case node)
      expect(probability).toBe(0.8);
    });

    it('should handle 3-variant case (A/B/C test)', () => {
      const graph = createGraphWithCaseNode({
        variants: [
          { name: 'control', weight: 0.34 },
          { name: 'variant-a', weight: 0.33 },
          { name: 'variant-b', weight: 0.33 }
        ],
        edges: [
          {
            uuid: 'edge-control',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'control',
            case_id: 'test-case',
            p: { mean: 1.0 }
          },
          {
            uuid: 'edge-variant-a',
            from: 'case-node-1',
            to: 'target-a',
            case_variant: 'variant-a',
            case_id: 'test-case',
            p: { mean: 1.0 }
          },
          {
            uuid: 'edge-variant-b',
            from: 'case-node-1',
            to: 'target-b',
            case_variant: 'variant-b',
            case_id: 'test-case',
            p: { mean: 1.0 }
          }
        ]
      });

      // Check each variant
      expect(computeEffectiveEdgeProbability(graph, 'edge-control', { whatIfDSL: null }))
        .toBeCloseTo(0.34, 10);
      expect(computeEffectiveEdgeProbability(graph, 'edge-variant-a', { whatIfDSL: null }))
        .toBeCloseTo(0.33, 10);
      expect(computeEffectiveEdgeProbability(graph, 'edge-variant-b', { whatIfDSL: null }))
        .toBeCloseTo(0.33, 10);

      // Sum should equal edge probability (1.0)
      const total = 
        computeEffectiveEdgeProbability(graph, 'edge-control', { whatIfDSL: null }) +
        computeEffectiveEdgeProbability(graph, 'edge-variant-a', { whatIfDSL: null }) +
        computeEffectiveEdgeProbability(graph, 'edge-variant-b', { whatIfDSL: null });
      expect(total).toBeCloseTo(1.0, 10);
    });
  });
});









