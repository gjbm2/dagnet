import { describe, it, expect } from 'vitest';
import { calculateProbabilities } from '../runner';
describe('runner', () => {
    describe('basic probability calculation', () => {
        it('should calculate simple linear path', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'A', slug: 'a', label: 'A', entry: { is_start: true } },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' }
                ],
                edges: [
                    { id: 'e1', slug: 'a-b', from: 'A', to: 'B', p: { mean: 0.8 } },
                    { id: 'e2', slug: 'b-c', from: 'B', to: 'C', p: { mean: 0.5 } }
                ]
            };
            const result = calculateProbabilities(graph);
            expect(result.nodeProbabilities.get('A')).toBe(1.0);
            expect(result.nodeProbabilities.get('B')).toBe(0.8);
            expect(result.nodeProbabilities.get('C')).toBe(0.4); // 0.8 * 0.5
        });
        it('should handle branching paths', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'A', slug: 'a', label: 'A', entry: { is_start: true } },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' }
                ],
                edges: [
                    { id: 'e1', slug: 'a-b', from: 'A', to: 'B', p: { mean: 0.6 } },
                    { id: 'e2', slug: 'a-c', from: 'A', to: 'C', p: { mean: 0.4 } }
                ]
            };
            const result = calculateProbabilities(graph);
            expect(result.nodeProbabilities.get('A')).toBe(1.0);
            expect(result.nodeProbabilities.get('B')).toBe(0.6);
            expect(result.nodeProbabilities.get('C')).toBe(0.4);
        });
        it('should handle converging paths', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'A', slug: 'a', label: 'A', entry: { is_start: true } },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' },
                    { id: 'D', slug: 'd', label: 'D' }
                ],
                edges: [
                    { id: 'e1', slug: 'a-b', from: 'A', to: 'B', p: { mean: 0.6 } },
                    { id: 'e2', slug: 'a-c', from: 'A', to: 'C', p: { mean: 0.4 } },
                    { id: 'e3', slug: 'b-d', from: 'B', to: 'D', p: { mean: 1.0 } },
                    { id: 'e4', slug: 'c-d', from: 'C', to: 'D', p: { mean: 1.0 } }
                ]
            };
            const result = calculateProbabilities(graph);
            expect(result.nodeProbabilities.get('D')).toBe(1.0); // 0.6 + 0.4
        });
    });
    describe('conditional probabilities', () => {
        it('should apply conditional probability when node is visited', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'Start', slug: 'start', label: 'Start', entry: { is_start: true } },
                    { id: 'X', slug: 'x', label: 'X' },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' }
                ],
                edges: [
                    { id: 'e1', slug: 'start-x', from: 'Start', to: 'X', p: { mean: 1.0 } },
                    { id: 'e2', slug: 'x-b', from: 'X', to: 'B', p: { mean: 1.0 } },
                    {
                        id: 'e3',
                        slug: 'b-c',
                        from: 'B',
                        to: 'C',
                        p: { mean: 0.5 },
                        conditional_p: [
                            {
                                condition: { visited: ['X'] },
                                p: { mean: 0.8 }
                            }
                        ]
                    }
                ]
            };
            const result = calculateProbabilities(graph);
            // Path goes through X, so conditional should apply
            expect(result.trackedNodes.has('X')).toBe(true);
            expect(result.nodeProbabilities.get('C')).toBe(0.8); // Uses conditional, not base 0.5
        });
        it('should use base probability when condition not met', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'Start', slug: 'start', label: 'Start', entry: { is_start: true } },
                    { id: 'X', slug: 'x', label: 'X' },
                    { id: 'Y', slug: 'y', label: 'Y' },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' }
                ],
                edges: [
                    { id: 'e1', slug: 'start-y', from: 'Start', to: 'Y', p: { mean: 1.0 } },
                    { id: 'e2', slug: 'y-b', from: 'Y', to: 'B', p: { mean: 1.0 } },
                    {
                        id: 'e3',
                        slug: 'b-c',
                        from: 'B',
                        to: 'C',
                        p: { mean: 0.5 },
                        conditional_p: [
                            {
                                condition: { visited: ['X'] }, // X not in path!
                                p: { mean: 0.8 }
                            }
                        ]
                    }
                ]
            };
            const result = calculateProbabilities(graph);
            // Path doesn't go through X, so use base probability
            expect(result.nodeProbabilities.get('C')).toBe(0.5); // Base probability
        });
        it('should handle multiple paths with different conditions', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'Start', slug: 'start', label: 'Start', entry: { is_start: true } },
                    { id: 'X', slug: 'x', label: 'X' },
                    { id: 'Y', slug: 'y', label: 'Y' },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' }
                ],
                edges: [
                    { id: 'e1', slug: 'start-x', from: 'Start', to: 'X', p: { mean: 0.5 } },
                    { id: 'e2', slug: 'start-y', from: 'Start', to: 'Y', p: { mean: 0.5 } },
                    { id: 'e3', slug: 'x-b', from: 'X', to: 'B', p: { mean: 1.0 } },
                    { id: 'e4', slug: 'y-b', from: 'Y', to: 'B', p: { mean: 1.0 } },
                    {
                        id: 'e5',
                        slug: 'b-c',
                        from: 'B',
                        to: 'C',
                        p: { mean: 0.5 },
                        conditional_p: [
                            {
                                condition: { visited: ['X'] },
                                p: { mean: 0.8 }
                            }
                        ]
                    }
                ]
            };
            const result = calculateProbabilities(graph);
            // Two paths to C:
            // Path 1: Start -> X -> B -> C with p = 0.5 * 1.0 * 0.8 = 0.4 (conditional)
            // Path 2: Start -> Y -> B -> C with p = 0.5 * 1.0 * 0.5 = 0.25 (base)
            // Total: 0.4 + 0.25 = 0.65
            expect(result.nodeProbabilities.get('C')).toBeCloseTo(0.65, 10);
        });
    });
    describe('case node handling', () => {
        it('should handle case edges with variant weights', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'Start', slug: 'start', label: 'Start', entry: { is_start: true } },
                    {
                        id: 'Case',
                        slug: 'case',
                        label: 'Case',
                        type: 'case',
                        case: {
                            id: 'test-case',
                            variants: [
                                { name: 'control', weight: 0.7 },
                                { name: 'treatment', weight: 0.3 }
                            ]
                        }
                    },
                    { id: 'A', slug: 'a', label: 'A' },
                    { id: 'B', slug: 'b', label: 'B' }
                ],
                edges: [
                    { id: 'e1', slug: 'start-case', from: 'Start', to: 'Case', p: { mean: 1.0 } },
                    {
                        id: 'e2',
                        slug: 'case-a',
                        from: 'Case',
                        to: 'A',
                        p: { mean: 1.0 },
                        case_id: 'test-case',
                        case_variant: 'control'
                    },
                    {
                        id: 'e3',
                        slug: 'case-b',
                        from: 'Case',
                        to: 'B',
                        p: { mean: 1.0 },
                        case_id: 'test-case',
                        case_variant: 'treatment'
                    }
                ]
            };
            const result = calculateProbabilities(graph);
            expect(result.nodeProbabilities.get('A')).toBe(0.7); // control variant
            expect(result.nodeProbabilities.get('B')).toBe(0.3); // treatment variant
        });
        it('should respect case what-if overrides', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'Start', slug: 'start', label: 'Start', entry: { is_start: true } },
                    {
                        id: 'Case',
                        slug: 'case',
                        label: 'Case',
                        type: 'case',
                        case: {
                            id: 'test-case',
                            variants: [
                                { name: 'control', weight: 0.7 },
                                { name: 'treatment', weight: 0.3 }
                            ]
                        }
                    },
                    { id: 'A', slug: 'a', label: 'A' },
                    { id: 'B', slug: 'b', label: 'B' }
                ],
                edges: [
                    { id: 'e1', slug: 'start-case', from: 'Start', to: 'Case', p: { mean: 1.0 } },
                    {
                        id: 'e2',
                        slug: 'case-a',
                        from: 'Case',
                        to: 'A',
                        p: { mean: 1.0 },
                        case_id: 'test-case',
                        case_variant: 'control'
                    },
                    {
                        id: 'e3',
                        slug: 'case-b',
                        from: 'Case',
                        to: 'B',
                        p: { mean: 1.0 },
                        case_id: 'test-case',
                        case_variant: 'treatment'
                    }
                ]
            };
            // What-if: treatment at 100%
            const result = calculateProbabilities(graph, {
                caseOverrides: new Map([['test-case', 'treatment']])
            });
            expect(result.nodeProbabilities.get('A')).toBe(0); // control at 0%
            expect(result.nodeProbabilities.get('B')).toBe(1.0); // treatment at 100%
        });
    });
    describe('conditional what-if overrides', () => {
        it('should respect conditional probability what-if overrides', () => {
            const graph = {
                metadata: { version: '1.0.0', created_at: '2025-01-01', updated_at: '2025-01-01' },
                nodes: [
                    { id: 'Start', slug: 'start', label: 'Start', entry: { is_start: true } },
                    { id: 'X', slug: 'x', label: 'X' },
                    { id: 'Y', slug: 'y', label: 'Y' },
                    { id: 'B', slug: 'b', label: 'B' },
                    { id: 'C', slug: 'c', label: 'C' }
                ],
                edges: [
                    { id: 'e1', slug: 'start-y', from: 'Start', to: 'Y', p: { mean: 1.0 } },
                    { id: 'e2', slug: 'y-b', from: 'Y', to: 'B', p: { mean: 1.0 } },
                    {
                        id: 'e3',
                        slug: 'b-c',
                        from: 'B',
                        to: 'C',
                        p: { mean: 0.5 },
                        conditional_p: [
                            {
                                condition: { visited: ['X'] },
                                p: { mean: 0.8 }
                            }
                        ]
                    }
                ]
            };
            // What-if: force conditional to apply even though X not visited
            const result = calculateProbabilities(graph, {
                conditionalOverrides: new Map([['e3', new Set(['X'])]])
            });
            expect(result.nodeProbabilities.get('C')).toBe(0.8); // Uses conditional due to override
        });
    });
});
