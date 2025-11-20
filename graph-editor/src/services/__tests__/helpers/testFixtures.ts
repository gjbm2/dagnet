/**
 * Test fixtures for integration tests
 * 
 * Provides helper functions to create test data for graphs, parameters, cases, etc.
 */

import type { ConversionGraph, GraphEdge, GraphNode } from '../../../types';

/**
 * Create a test edge with default values
 */
export const createTestEdge = (overrides: Partial<GraphEdge> = {}): GraphEdge => ({
  uuid: 'test-edge-1',
  from: 'node-a',
  to: 'node-b',
  p: {
    mean: 0.5,
    stdev: 0.05,
    distribution: 'beta'
  },
  ...overrides
});

/**
 * Create a test node with default values
 */
export const createTestNode = (overrides: Partial<GraphNode> = {}): GraphNode => ({
  uuid: 'test-node-1',
  id: 'test-node',
  label: 'Test Node',
  layout: { x: 0, y: 0 },
  ...overrides
});

/**
 * Create a test parameter file
 */
export const createTestParameterFile = (overrides: any = {}) => ({
  id: 'test-param',
  name: 'Test Parameter',
  type: 'probability',
  query: 'from(a).to(b)',
  query_overridden: false,
  values: [
    {
      mean: 0.5,
      stdev: 0.05,
      distribution: 'beta',
      window_from: '2025-01-01T00:00:00Z'
    }
  ],
  metadata: {
    description: 'Test parameter for unit tests',
    description_overridden: false,
    constraints: { discrete: false },
    tags: ['test'],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    author: 'test-suite',
    version: '1.0.0',
    status: 'active',
    aliases: [],
    references: []
  },
  ...overrides
});

/**
 * Create a test case file
 */
export const createTestCaseFile = (overrides: any = {}) => ({
  id: 'case-test-case',
  parameter_type: 'case',
  name: 'Test Case',
  description: 'Test case for unit tests',
  description_overridden: false,
  case: {
    id: 'test-case',
    status: 'active',
    variants: [
      { name: 'control', weight: 0.5, weight_overridden: false },
      { name: 'treatment', weight: 0.5, weight_overridden: false }
    ],
    schedules: []
  },
  metadata: {
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    version: '1.0.0',
    status: 'active'
  },
  ...overrides
});

/**
 * Create a test node file
 */
export const createTestNodeFile = (overrides: any = {}) => ({
  id: 'test-node',
  name: 'Test Node',
  description: 'Test node for unit tests',
  event_id: null,
  tags: ['test'],
  metadata: {
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    version: '1.0.0',
    status: 'active'
  },
  ...overrides
});

/**
 * Create a test graph with default nodes and edges
 */
export const createTestGraph = (overrides: Partial<ConversionGraph> = {}): ConversionGraph => ({
  nodes: [
    createTestNode({ uuid: 'node-a', id: 'node-a', label: 'Node A' }),
    createTestNode({ uuid: 'node-b', id: 'node-b', label: 'Node B' })
  ],
  edges: [
    createTestEdge()
  ],
  policies: {
    default_outcome: 'success',
    overflow_policy: 'normalize'
  },
  metadata: {
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    version: '1.0.0',
    author: 'test-suite',
    description: 'Test graph for unit tests'
  },
  ...overrides
});

/**
 * Create multiple test edges at once
 */
export const createTestEdges = (count: number, baseName: string = 'edge'): GraphEdge[] => {
  return Array.from({ length: count }, (_, i) => 
    createTestEdge({
      uuid: `${baseName}-${i + 1}`,
      from: `node-${i}`,
      to: `node-${i + 1}`
    })
  );
};

/**
 * Create multiple test nodes at once
 */
export const createTestNodes = (count: number, baseName: string = 'node'): GraphNode[] => {
  return Array.from({ length: count }, (_, i) => 
    createTestNode({
      uuid: `${baseName}-${i + 1}`,
      id: `${baseName}-${i + 1}`,
      label: `Node ${i + 1}`,
      layout: { x: i * 200, y: 0 }
    })
  );
};

/**
 * Create a parameter file with multiple historical values
 */
export const createParameterFileWithHistory = (
  id: string,
  values: Array<{ mean: number; window_from: string; [key: string]: any }>
) => {
  return createTestParameterFile({
    id,
    values: values.map(v => ({
      stdev: 0.05,
      distribution: 'beta',
      ...v
    }))
  });
};

/**
 * Create a case file with schedules history
 */
export const createCaseFileWithSchedules = (
  id: string,
  schedules: Array<{ variants: any[]; window_from: string; source?: string }>
) => {
  return createTestCaseFile({
    id,
    case: {
      id,
      status: 'active',
      variants: schedules[0]?.variants || [],
      schedules: schedules.map(s => ({
        window_from: s.window_from,
        variants: s.variants,
        source: s.source || 'manual'
      }))
    }
  });
};


