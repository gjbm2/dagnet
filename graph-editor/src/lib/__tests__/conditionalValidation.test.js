// Tests for conditional probability validation
import { describe, it, expect } from 'vitest';
import { validateConditionalProbabilities, getUpstreamNodes, getEffectiveProbability } from '../conditionalValidation';
describe('Conditional Probability Validation', () => {
    it('should validate base case probability sums', () => {
        const graph = {
            nodes: [
                { id: 'node1', slug: 'node1' },
                { id: 'node2', slug: 'node2' },
                { id: 'node3', slug: 'node3' },
            ],
            edges: [
                { id: 'e1', from: 'node1', to: 'node2', p: { mean: 0.5 } },
                { id: 'e2', from: 'node1', to: 'node3', p: { mean: 0.5 } },
            ],
            policies: { default_outcome: 'node3' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const result = validateConditionalProbabilities(graph);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });
    it('should detect invalid base case probability sums', () => {
        const graph = {
            nodes: [
                { id: 'node1', slug: 'node1' },
                { id: 'node2', slug: 'node2' },
                { id: 'node3', slug: 'node3' },
            ],
            edges: [
                { id: 'e1', from: 'node1', to: 'node2', p: { mean: 0.6 } },
                { id: 'e2', from: 'node1', to: 'node3', p: { mean: 0.3 } },
            ],
            policies: { default_outcome: 'node3' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const result = validateConditionalProbabilities(graph);
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].type).toBe('probability_sum');
        expect(result.errors[0].sum).toBeCloseTo(0.9, 2);
    });
    it('should validate conditional probability sums', () => {
        const graph = {
            nodes: [
                { id: 'promo', slug: 'promo' },
                { id: 'cart', slug: 'cart' },
                { id: 'checkout', slug: 'checkout' },
                { id: 'abandon', slug: 'abandon' },
            ],
            edges: [
                { id: 'e1', from: 'promo', to: 'cart', p: { mean: 1.0 } },
                {
                    id: 'e2',
                    from: 'cart',
                    to: 'checkout',
                    p: { mean: 0.5 },
                    conditional_p: [
                        {
                            condition: { visited: ['promo'] },
                            p: { mean: 0.7 },
                        },
                    ],
                },
                {
                    id: 'e3',
                    from: 'cart',
                    to: 'abandon',
                    p: { mean: 0.5 },
                    conditional_p: [
                        {
                            condition: { visited: ['promo'] },
                            p: { mean: 0.3 },
                        },
                    ],
                },
            ],
            policies: { default_outcome: 'abandon' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const result = validateConditionalProbabilities(graph);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });
    it('should detect missing condition nodes', () => {
        const graph = {
            nodes: [
                { id: 'cart', slug: 'cart' },
                { id: 'checkout', slug: 'checkout' },
            ],
            edges: [
                {
                    id: 'e1',
                    from: 'cart',
                    to: 'checkout',
                    p: { mean: 1.0 },
                    conditional_p: [
                        {
                            condition: { visited: ['nonexistent'] },
                            p: { mean: 0.7 },
                        },
                    ],
                },
            ],
            policies: { default_outcome: 'checkout' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const result = validateConditionalProbabilities(graph);
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].type).toBe('missing_node');
    });
    it('should detect non-upstream condition references', () => {
        const graph = {
            nodes: [
                { id: 'cart', slug: 'cart' },
                { id: 'checkout', slug: 'checkout' },
            ],
            edges: [
                {
                    id: 'e1',
                    from: 'cart',
                    to: 'checkout',
                    p: { mean: 1.0 },
                    conditional_p: [
                        {
                            condition: { visited: ['checkout'] }, // Checkout is downstream, not upstream
                            p: { mean: 0.7 },
                        },
                    ],
                },
            ],
            policies: { default_outcome: 'checkout' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const result = validateConditionalProbabilities(graph);
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].type).toBe('invalid_reference');
    });
    it('should get upstream nodes correctly', () => {
        const graph = {
            nodes: [
                { id: 'node1', slug: 'node1' },
                { id: 'node2', slug: 'node2' },
                { id: 'node3', slug: 'node3' },
                { id: 'node4', slug: 'node4' },
            ],
            edges: [
                { id: 'e1', from: 'node1', to: 'node2', p: { mean: 1.0 } },
                { id: 'e2', from: 'node2', to: 'node3', p: { mean: 1.0 } },
                { id: 'e3', from: 'node3', to: 'node4', p: { mean: 1.0 } },
            ],
            policies: { default_outcome: 'node4' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const upstream = getUpstreamNodes('node3', graph);
        expect(upstream).toHaveLength(2);
        expect(upstream.map(n => n.id).sort()).toEqual(['node1', 'node2']);
    });
    it('should calculate effective probability correctly', () => {
        const nodes = [{ id: 'promo', slug: 'promo' }];
        const edge = {
            id: 'e1',
            from: 'cart',
            to: 'checkout',
            p: { mean: 0.5 },
            conditional_p: [
                {
                    condition: { visited: ['promo'] },
                    p: { mean: 0.7 },
                },
            ],
        };
        // Without visiting promo
        const probWithout = getEffectiveProbability(edge, new Set(), nodes);
        expect(probWithout).toBe(0.5);
        // After visiting promo
        const probWith = getEffectiveProbability(edge, new Set(['promo']), nodes);
        expect(probWith).toBe(0.7);
    });
    it('should issue warning for incomplete conditions', () => {
        const graph = {
            nodes: [
                { id: 'promo', slug: 'promo' },
                { id: 'cart', slug: 'cart' },
                { id: 'checkout', slug: 'checkout' },
                { id: 'abandon', slug: 'abandon' },
            ],
            edges: [
                { id: 'e1', from: 'promo', to: 'cart', p: { mean: 1.0 } },
                {
                    id: 'e2',
                    from: 'cart',
                    to: 'checkout',
                    p: { mean: 0.5 },
                    conditional_p: [
                        {
                            condition: { visited: ['promo'] },
                            p: { mean: 0.7 },
                        },
                    ],
                },
                {
                    id: 'e3',
                    from: 'cart',
                    to: 'abandon',
                    p: { mean: 0.5 },
                    // No conditional_p - inconsistent with sibling
                },
            ],
            policies: { default_outcome: 'abandon' },
            metadata: { version: '1.0.0', created_at: new Date().toISOString() },
        };
        const result = validateConditionalProbabilities(graph);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].type).toBe('incomplete_conditions');
    });
});
