/**
 * Test Graph Builder
 * 
 * Utility for creating realistic test graphs with minimal boilerplate.
 * Used across all integration tests.
 */

import type { Graph } from '../../src/types';

export interface NodeConfig {
  id?: string;
  uuid?: string;
  name: string;
  event_id?: string;
  type?: 'regular' | 'case' | 'terminal';
  x?: number;
  y?: number;
}

export interface EdgeConfig {
  id?: string;
  uuid?: string;
  from: string;
  to: string;
  query?: string;
  p?: {
    mean?: number;
    stdev?: number;
    distribution?: 'normal' | 'beta' | 'uniform';
    id?: string;
    connection?: string;
    mean_overridden?: boolean;
    evidence?: {
      n?: number;
      k?: number;
      window_from?: string;
      window_to?: string;
      retrieved_at?: string;
      source?: string;
    };
  };
  cost_gbp?: any;
  labour_cost?: any;
  conditional_p?: Array<{
    condition: string;
    mean: number;
    stdev?: number;
  }>;
}

export interface TopologyConfig {
  exclude?: string[];
  visited?: string[];
  visitedAny?: string[];
}

export interface TestGraphConfig {
  nodes?: NodeConfig[];
  edges?: EdgeConfig[];
  topology?: TopologyConfig;
  metadata?: Record<string, any>;
}

/**
 * Create a test graph with sensible defaults
 */
export function createTestGraph(config: TestGraphConfig = {}): Graph {
  const {
    nodes = [],
    edges = [],
    metadata = {}
  } = config;

  // Ensure all nodes have UUIDs
  const processedNodes = nodes.map((node, idx) => ({
    uuid: node.uuid || `node-${node.id || idx}`,
    id: node.id || `node-${idx}`,
    name: node.name,
    event_id: node.event_id,
    type: node.type || 'regular',
    x: node.x ?? idx * 200,
    y: node.y ?? 100,
  }));

  // Ensure all edges have UUIDs and references
  const processedEdges = edges.map((edge, idx) => {
    const uuid = edge.uuid || `${edge.from}-to-${edge.to}`;
    const id = edge.id || `edge-${idx}`;

    return {
      uuid,
      id,
      from: edge.from,
      to: edge.to,
      query: edge.query || `from(${edge.from}).to(${edge.to})`,
      p: edge.p ? {
        mean: edge.p.mean ?? 0.5,
        stdev: edge.p.stdev ?? 0,
        distribution: edge.p.distribution ?? 'normal',
        id: edge.p.id || `param-${id}`,
        connection: edge.p.connection || 'amplitude-prod',
        mean_overridden: edge.p.mean_overridden ?? false,
        evidence: edge.p.evidence || {}
      } : undefined,
      cost_gbp: edge.cost_gbp,
      labour_cost: edge.labour_cost,
      conditional_p: edge.conditional_p,
    };
  });

  return {
    nodes: processedNodes,
    edges: processedEdges,
    policies: {
      rebalance_on_update: true
    },
    metadata: {
      version: '1.0',
      created_at: new Date().toISOString(),
      ...metadata
    }
  };
}

/**
 * Create a simple linear flow: A → B → C
 */
export function createLinearGraph(): Graph {
  return createTestGraph({
    nodes: [
      { id: 'a', name: 'Node A', event_id: 'event_a' },
      { id: 'b', name: 'Node B', event_id: 'event_b' },
      { id: 'c', name: 'Node C', event_id: 'event_c' }
    ],
    edges: [
      { from: 'a', to: 'b', p: { mean: 0.6, stdev: 0.05 } },
      { from: 'b', to: 'c', p: { mean: 0.4, stdev: 0.03 } }
    ]
  });
}

/**
 * Create a branching flow: A → B → C
 *                           A → D → C
 */
export function createBranchingGraph(): Graph {
  return createTestGraph({
    nodes: [
      { id: 'a', name: 'Start', event_id: 'event_a' },
      { id: 'b', name: 'Path 1', event_id: 'event_b' },
      { id: 'd', name: 'Path 2', event_id: 'event_d' },
      { id: 'c', name: 'End', event_id: 'event_c' }
    ],
    edges: [
      { from: 'a', to: 'b', p: { mean: 0.6 } },
      { from: 'a', to: 'd', p: { mean: 0.4 } },
      { from: 'b', to: 'c', p: { mean: 0.8 } },
      { from: 'd', to: 'c', p: { mean: 0.7 } }
    ]
  });
}

/**
 * Create a graph with composite query (minus/plus)
 */
export function createCompositeQueryGraph(): Graph {
  return createTestGraph({
    nodes: [
      { id: 'saw-WA-details-page', name: 'Saw WA Details', event_id: 'event_wa_details' },
      { id: 'viewed-coffee-screen', name: 'Viewed Coffee', event_id: 'event_coffee' },
      { id: 'straight-to-dashboard', name: 'Dashboard', event_id: 'event_dashboard' }
    ],
    edges: [
      {
        from: 'saw-WA-details-page',
        to: 'straight-to-dashboard',
        query: 'from(saw-WA-details-page).to(straight-to-dashboard).minus(viewed-coffee-screen)',
        p: {
          mean: 0.5,
          stdev: 0.05,
          id: 'wa-to-dashboard',
          connection: 'amplitude-prod'
        }
      }
    ]
  });
}

/**
 * Create a graph with mixed providers (pessimistic policy test)
 */
export function createMixedProviderGraph(): Graph {
  return createTestGraph({
    nodes: [
      { id: 'a', name: 'Node A', event_id: 'event_a' },
      { id: 'b', name: 'Node B', event_id: 'event_b' }
    ],
    edges: [
      {
        from: 'a',
        to: 'b',
        query: 'from(a).to(b).exclude(c)',
        p: {
          mean: 0.5,
          id: 'test-param',
          connection: 'amplitude-prod' // No native exclude
        },
        cost_gbp: {
          mean: 100,
          id: 'test-cost',
          connection: 'postgres-analytics' // Has native exclude
        }
      }
    ]
  });
}

/**
 * Clone a graph deeply (for comparison tests)
 */
export function cloneGraph(graph: Graph): Graph {
  return JSON.parse(JSON.stringify(graph));
}

/**
 * Compare two graphs, ignoring timestamps
 */
export function graphsEqual(a: Graph, b: Graph, ignoreTimestamps = true): boolean {
  const cleanGraph = (g: Graph) => {
    const cleaned = cloneGraph(g);
    if (ignoreTimestamps && cleaned.metadata) {
      delete cleaned.metadata.created_at;
      delete cleaned.metadata.updated_at;
    }
    return cleaned;
  };

  return JSON.stringify(cleanGraph(a)) === JSON.stringify(cleanGraph(b));
}

