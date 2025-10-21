import { describe, it, expect } from 'vitest';
import {
  generateConditionalReference,
  parseConditionalReference,
  getEdgeConditionalReferences,
  getAllConditionalReferences,
  findConditionalProbabilityByReference,
  validateSlugUniqueness
} from '../conditionalReferences';
import type { Graph, GraphEdge } from '../types';

describe('conditionalReferences', () => {
  describe('generateConditionalReference', () => {
    it('should generate base probability reference', () => {
      const ref = generateConditionalReference('gives-bd-to-stops-switch', [], 'mean');
      expect(ref).toBe('e.gives-bd-to-stops-switch.p.mean');
    });

    it('should generate single-node conditional reference', () => {
      const ref = generateConditionalReference('gives-bd-to-stops-switch', ['coffee_promotion'], 'mean');
      expect(ref).toBe('e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean');
    });

    it('should generate multi-node conditional reference with sorted nodes', () => {
      const ref = generateConditionalReference('gives-bd-to-stops-switch', ['email_promo', 'coffee_promotion'], 'mean');
      expect(ref).toBe('e.gives-bd-to-stops-switch.visited(coffee_promotion,email_promo).p.mean');
    });

    it('should generate stdev reference', () => {
      const ref = generateConditionalReference('gives-bd-to-stops-switch', ['coffee_promotion'], 'stdev');
      expect(ref).toBe('e.gives-bd-to-stops-switch.visited(coffee_promotion).p.stdev');
    });
  });

  describe('parseConditionalReference', () => {
    it('should parse base probability reference', () => {
      const parsed = parseConditionalReference('e.gives-bd-to-stops-switch.p.mean');
      expect(parsed).toEqual({
        edgeSlug: 'gives-bd-to-stops-switch',
        nodeSlugs: [],
        param: 'mean',
        isConditional: false
      });
    });

    it('should parse single-node conditional reference', () => {
      const parsed = parseConditionalReference('e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean');
      expect(parsed).toEqual({
        edgeSlug: 'gives-bd-to-stops-switch',
        nodeSlugs: ['coffee_promotion'],
        param: 'mean',
        isConditional: true
      });
    });

    it('should parse multi-node conditional reference', () => {
      const parsed = parseConditionalReference('e.gives-bd-to-stops-switch.visited(coffee_promotion,email_promo).p.stdev');
      expect(parsed).toEqual({
        edgeSlug: 'gives-bd-to-stops-switch',
        nodeSlugs: ['coffee_promotion', 'email_promo'],
        param: 'stdev',
        isConditional: true
      });
    });

    it('should return null for invalid reference', () => {
      expect(parseConditionalReference('invalid')).toBeNull();
      expect(parseConditionalReference('e.slug')).toBeNull();
      expect(parseConditionalReference('e.slug.p')).toBeNull();
    });
  });

  describe('getEdgeConditionalReferences', () => {
    it('should extract all references from an edge', () => {
      const graph: Graph = {
        metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
        nodes: [
          { id: 'node1', slug: 'coffee_promotion', label: 'Coffee Promotion' },
          { id: 'node2', slug: 'email_promo', label: 'Email Promo' }
        ],
        edges: [
          {
            id: 'edge1',
            slug: 'gives-bd-to-stops-switch',
            from: 'node1',
            to: 'node2',
            p: { mean: 0.5, stdev: 0.05 },
            conditional_p: [
              {
                condition: { visited: ['node1'] },
                p: { mean: 0.8, stdev: 0.03 }
              },
              {
                condition: { visited: ['node1', 'node2'] },
                p: { mean: 0.9 }
              }
            ]
          }
        ]
      };

      const refs = getEdgeConditionalReferences(graph.edges[0], graph);
      
      expect(refs).toHaveLength(5);
      expect(refs.map(r => r.reference)).toContain('e.gives-bd-to-stops-switch.p.mean');
      expect(refs.map(r => r.reference)).toContain('e.gives-bd-to-stops-switch.p.stdev');
      expect(refs.map(r => r.reference)).toContain('e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean');
      expect(refs.map(r => r.reference)).toContain('e.gives-bd-to-stops-switch.visited(coffee_promotion).p.stdev');
      expect(refs.map(r => r.reference)).toContain('e.gives-bd-to-stops-switch.visited(coffee_promotion,email_promo).p.mean');
    });
  });

  describe('findConditionalProbabilityByReference', () => {
    const graph: Graph = {
      metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
      nodes: [
        { id: 'node1', slug: 'coffee_promotion', label: 'Coffee Promotion' },
        { id: 'node2', slug: 'email_promo', label: 'Email Promo' }
      ],
      edges: [
        {
          id: 'edge1',
          slug: 'gives-bd-to-stops-switch',
          from: 'node1',
          to: 'node2',
          p: { mean: 0.5, stdev: 0.05 },
          conditional_p: [
            {
              condition: { visited: ['node1'] },
              p: { mean: 0.8, stdev: 0.03 }
            }
          ]
        }
      ]
    };

    it('should find base probability', () => {
      const value = findConditionalProbabilityByReference('e.gives-bd-to-stops-switch.p.mean', graph);
      expect(value).toBe(0.5);
    });

    it('should find conditional probability', () => {
      const value = findConditionalProbabilityByReference('e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean', graph);
      expect(value).toBe(0.8);
    });

    it('should return undefined for non-existent reference', () => {
      const value = findConditionalProbabilityByReference('e.nonexistent.p.mean', graph);
      expect(value).toBeUndefined();
    });
  });

  describe('validateSlugUniqueness', () => {
    it('should validate a graph with unique slugs', () => {
      const graph: Graph = {
        metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
        nodes: [
          { id: 'node1', slug: 'node_1', label: 'Node 1' },
          { id: 'node2', slug: 'node_2', label: 'Node 2' }
        ],
        edges: [
          { id: 'edge1', slug: 'edge_1', from: 'node1', to: 'node2', p: { mean: 0.5 } }
        ]
      };

      const result = validateSlugUniqueness(graph);
      expect(result.isValid).toBe(true);
      expect(result.duplicateNodeSlugs).toHaveLength(0);
      expect(result.duplicateEdgeSlugs).toHaveLength(0);
    });

    it('should detect duplicate node slugs', () => {
      const graph: Graph = {
        metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
        nodes: [
          { id: 'node1', slug: 'duplicate', label: 'Node 1' },
          { id: 'node2', slug: 'duplicate', label: 'Node 2' }
        ],
        edges: []
      };

      const result = validateSlugUniqueness(graph);
      expect(result.isValid).toBe(false);
      expect(result.duplicateNodeSlugs).toContain('duplicate');
    });

    it('should detect nodes without slugs', () => {
      const graph: Graph = {
        metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
        nodes: [
          { id: 'node1', label: 'Node 1' } as any
        ],
        edges: []
      };

      const result = validateSlugUniqueness(graph);
      expect(result.isValid).toBe(false);
      expect(result.nodesWithoutSlugs).toContain('node1');
    });
  });
});

