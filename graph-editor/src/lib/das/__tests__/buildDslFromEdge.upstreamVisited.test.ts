/**
 * Unit tests for buildDslFromEdge upstream visited node detection
 * 
 * Tests the super-funnel approach for handling visited() nodes that are
 * upstream of the from() node in the query.
 * 
 * Example: from(viewed-dashboard).to(recommendation).visited(gave-bds-in-onboarding)
 * Where gave-bds-in-onboarding is UPSTREAM of viewed-dashboard in the graph topology.
 * 
 * The adapter should build a super-funnel: visited_upstream → from → to
 * And extract n/k for the from → to hop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDslFromEdge } from '../buildDslFromEdge';

describe('buildDslFromEdge - Upstream Visited Node Detection', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Sample graph topology for testing:
  // A (entry) → B → C → D (absorbing)
  //                  ↓
  //                  E (absorbing)
  const createTestGraph = () => ({
    nodes: [
      { id: 'node-a', uuid: 'uuid-a', label: 'Node A', event_id: 'event_a', entry: { is_start: true } },
      { id: 'node-b', uuid: 'uuid-b', label: 'Node B', event_id: 'event_b' },
      { id: 'node-c', uuid: 'uuid-c', label: 'Node C', event_id: 'event_c' },
      { id: 'node-d', uuid: 'uuid-d', label: 'Node D', event_id: 'event_d', absorbing: true },
      { id: 'node-e', uuid: 'uuid-e', label: 'Node E', event_id: 'event_e', absorbing: true },
    ],
    edges: [
      { id: 'a-to-b', uuid: 'edge-ab', from: 'uuid-a', to: 'uuid-b' },
      { id: 'b-to-c', uuid: 'edge-bc', from: 'uuid-b', to: 'uuid-c' },
      { id: 'c-to-d', uuid: 'edge-cd', from: 'uuid-c', to: 'uuid-d' },
      { id: 'c-to-e', uuid: 'edge-ce', from: 'uuid-c', to: 'uuid-e' },
    ]
  });

  describe('visited node position detection', () => {
    
    it('should detect visited node BETWEEN from and to (standard case)', async () => {
      const graph = createTestGraph();
      
      // Edge: A → D with visited(C) - C is between A and D
      const edge = {
        id: 'test-edge',
        from: 'uuid-a',
        to: 'uuid-d',
        p: { mean: 0.5 },
        query: 'from(node-a).to(node-d).visited(node-c)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      // C is between A and D, so should be in visited (not visited_upstream)
      expect(result.visited).toBeDefined();
      expect(result.visited).toContain('event_c');
      expect(result.visited_upstream).toBeUndefined();
    });

    it('should detect visited node UPSTREAM of from (super-funnel case)', async () => {
      const graph = createTestGraph();
      
      // Edge: C → D with visited(A) - A is upstream of C
      const edge = {
        id: 'test-edge',
        from: 'uuid-c',
        to: 'uuid-d',
        p: { mean: 0.5 },
        query: 'from(node-c).to(node-d).visited(node-a)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      // A is upstream of C, so should be in visited_upstream
      expect(result.visited_upstream).toBeDefined();
      expect(result.visited_upstream).toContain('event_a');
      expect(result.visited).toBeUndefined();
    });

    it('should detect visited node UPSTREAM of from (B is upstream of C)', async () => {
      const graph = createTestGraph();
      
      // Edge: C → D with visited(B) - B is directly upstream of C
      const edge = {
        id: 'test-edge',
        from: 'uuid-c',
        to: 'uuid-d',
        p: { mean: 0.5 },
        query: 'from(node-c).to(node-d).visited(node-b)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      // B is upstream of C
      expect(result.visited_upstream).toBeDefined();
      expect(result.visited_upstream).toContain('event_b');
      expect(result.visited).toBeUndefined();
    });

    it('should handle mix of upstream and between visited nodes', async () => {
      const graph = createTestGraph();
      
      // Edge: B → D with visited(A) and visited(C)
      // A is upstream of B, C is between B and D
      const edge = {
        id: 'test-edge',
        from: 'uuid-b',
        to: 'uuid-d',
        p: { mean: 0.5 },
        query: 'from(node-b).to(node-d).visited(node-a).visited(node-c)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      // A should be upstream, C should be between
      expect(result.visited_upstream).toBeDefined();
      expect(result.visited_upstream).toContain('event_a');
      
      expect(result.visited).toBeDefined();
      expect(result.visited).toContain('event_c');
    });

    it('should work with node IDs (not UUIDs) in query', async () => {
      const graph = createTestGraph();
      
      // Query uses node IDs
      const edge = {
        id: 'test-edge',
        from: 'node-c',
        to: 'node-d',
        p: { mean: 0.5 },
        query: 'from(node-c).to(node-d).visited(node-a)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      expect(result.visited_upstream).toBeDefined();
      expect(result.visited_upstream).toContain('event_a');
    });
  });

  describe('edge cases', () => {
    
    it('should handle visited node that is not reachable from from (neither upstream nor between)', async () => {
      // Create a graph with a disconnected node
      const graph = {
        nodes: [
          { id: 'node-a', uuid: 'uuid-a', label: 'Node A', event_id: 'event_a' },
          { id: 'node-b', uuid: 'uuid-b', label: 'Node B', event_id: 'event_b' },
          { id: 'node-x', uuid: 'uuid-x', label: 'Node X', event_id: 'event_x' }, // Disconnected
        ],
        edges: [
          { id: 'a-to-b', uuid: 'edge-ab', from: 'uuid-a', to: 'uuid-b' },
          // No edges to/from node-x
        ]
      };
      
      // X is not upstream of A, and not between A and B
      // It should go into visited (not visited_upstream) as the default
      const edge = {
        id: 'test-edge',
        from: 'uuid-a',
        to: 'uuid-b',
        p: { mean: 0.5 },
        query: 'from(node-a).to(node-b).visited(node-x)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      // X is not upstream, so it goes in regular visited
      expect(result.visited).toBeDefined();
      expect(result.visited).toContain('event_x');
      expect(result.visited_upstream).toBeUndefined();
    });

    it('should handle no visited nodes', async () => {
      const graph = createTestGraph();
      
      const edge = {
        id: 'test-edge',
        from: 'uuid-a',
        to: 'uuid-b',
        p: { mean: 0.5 },
        query: 'from(node-a).to(node-b)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      expect(result.visited).toBeUndefined();
      expect(result.visited_upstream).toBeUndefined();
      expect(result.from).toBe('event_a');
      expect(result.to).toBe('event_b');
    });
  });

  describe('real-world scenario: conditional probability with upstream visited', () => {
    
    it('should handle conversion funnel with upstream conditioning', async () => {
      // Real-world scenario from the user's graph:
      // gave-bds-in-onboarding → ... → viewed-dashboard → recommendation
      // Query: from(viewed-dashboard).to(recommendation).visited(gave-bds-in-onboarding)
      
      const graph = {
        nodes: [
          { id: 'gave-bds-in-onboarding', uuid: 'uuid-bds', label: 'Gave BDS', event_id: 'gave-bds' },
          { id: 'viewed-dashboard', uuid: 'uuid-dash', label: 'Viewed Dashboard', event_id: 'viewed-dashboard' },
          { id: 'recommendation', uuid: 'uuid-rec', label: 'Recommendation', event_id: 'recommendation-offered' },
        ],
        edges: [
          { id: 'bds-to-dash', uuid: 'edge-1', from: 'uuid-bds', to: 'uuid-dash' },
          { id: 'dash-to-rec', uuid: 'edge-2', from: 'uuid-dash', to: 'uuid-rec' },
        ]
      };
      
      // Query: from dashboard to recommendation, given user visited bds (upstream)
      const edge = {
        id: 'conditional-edge',
        from: 'uuid-dash',
        to: 'uuid-rec',
        p: { mean: 0.5 },
        query: 'from(viewed-dashboard).to(recommendation).visited(gave-bds-in-onboarding)'
      };
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude');
      
      // gave-bds-in-onboarding is upstream of viewed-dashboard
      expect(result.visited_upstream).toBeDefined();
      expect(result.visited_upstream).toContain('gave-bds');
      expect(result.visited_upstream).toHaveLength(1);
      
      // No between visited nodes
      expect(result.visited).toBeUndefined();
      
      // From/to should be correct
      expect(result.from).toBe('viewed-dashboard');
      expect(result.to).toBe('recommendation-offered');
    });
  });
});

