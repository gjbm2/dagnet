/**
 * Integration tests for exclude compilation flow
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPRECATED: 4-Dec-25
 * 
 * These tests cover the exclude → minus/plus compilation flow which was required
 * when Amplitude didn't support native excludes.
 * 
 * As of 4-Dec-25, Amplitude supports native exclude via segment filters.
 * This compilation flow will NOT be triggered for Amplitude queries because:
 * - connections.yaml: supports_native_exclude: true
 * - Adapter converts excludes to segment filters directly
 * 
 * Tests remain valid to ensure compilation works for non-Amplitude providers.
 * Target deletion: After 2 weeks of production validation.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests the end-to-end flow of:
 * 1. User writes query with excludes() terms
 * 2. System detects excludes and compiles to minus/plus form
 * 3. Composite query executor runs sub-queries
 * 4. Each sub-query's visited nodes are categorized as upstream/between
 * 5. Results are combined with inclusion-exclusion coefficients
 * 
 * Test cases based on the user's real-world scenario:
 * - Diamond graph: A → B, A → C, B → D, C → D
 * - Query: from(A).to(D).excludes(C) where C is between A and D
 * - Query: from(B).to(D).excludes(A) where A is upstream of B
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNodeUpstream } from '../buildDslFromEdge';

describe('Exclude Compilation - isNodeUpstream for composite queries', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Diamond graph topology:
  //       A (entry)
  //      / \
  //     B   C
  //      \ /
  //       D (absorbing)
  const createDiamondGraph = () => ({
    nodes: [
      { id: 'node-a', uuid: 'uuid-a', label: 'Node A', event_id: 'event_a', entry: { is_start: true } },
      { id: 'node-b', uuid: 'uuid-b', label: 'Node B', event_id: 'event_b' },
      { id: 'node-c', uuid: 'uuid-c', label: 'Node C', event_id: 'event_c' },
      { id: 'node-d', uuid: 'uuid-d', label: 'Node D', event_id: 'event_d', absorbing: true },
    ],
    edges: [
      { id: 'a-to-b', uuid: 'edge-ab', from: 'uuid-a', to: 'uuid-b' },
      { id: 'a-to-c', uuid: 'edge-ac', from: 'uuid-a', to: 'uuid-c' },
      { id: 'b-to-d', uuid: 'edge-bd', from: 'uuid-b', to: 'uuid-d' },
      { id: 'c-to-d', uuid: 'edge-cd', from: 'uuid-c', to: 'uuid-d' },
    ]
  });

  // Linear graph: A → B → C → D
  const createLinearGraph = () => ({
    nodes: [
      { id: 'node-a', uuid: 'uuid-a', label: 'Node A', event_id: 'event_a', entry: { is_start: true } },
      { id: 'node-b', uuid: 'uuid-b', label: 'Node B', event_id: 'event_b' },
      { id: 'node-c', uuid: 'uuid-c', label: 'Node C', event_id: 'event_c' },
      { id: 'node-d', uuid: 'uuid-d', label: 'Node D', event_id: 'event_d', absorbing: true },
    ],
    edges: [
      { id: 'a-to-b', uuid: 'edge-ab', from: 'uuid-a', to: 'uuid-b' },
      { id: 'b-to-c', uuid: 'edge-bc', from: 'uuid-b', to: 'uuid-c' },
      { id: 'c-to-d', uuid: 'edge-cd', from: 'uuid-c', to: 'uuid-d' },
    ]
  });

  describe('upstream detection for exclude compilation', () => {
    
    it('should correctly identify node as BETWEEN (not upstream) in diamond graph', () => {
      const graph = createDiamondGraph();
      
      // Query: from(A).to(D).excludes(C)
      // C is NOT upstream of A (it's a sibling path)
      // When compiled to minus(C), the visited(C) should be "between", not upstream
      
      const cIsUpstreamOfA = isNodeUpstream('node-c', 'node-a', graph);
      expect(cIsUpstreamOfA).toBe(false);
      
      // Similarly B is not upstream of A
      const bIsUpstreamOfA = isNodeUpstream('node-b', 'node-a', graph);
      expect(bIsUpstreamOfA).toBe(false);
    });

    it('should correctly identify node as UPSTREAM in linear graph', () => {
      const graph = createLinearGraph();
      
      // Query: from(C).to(D).excludes(A)
      // A IS upstream of C (A → B → C)
      // When compiled to minus(A), the visited(A) should be "upstream"
      
      const aIsUpstreamOfC = isNodeUpstream('node-a', 'node-c', graph);
      expect(aIsUpstreamOfC).toBe(true);
      
      // B is also upstream of C
      const bIsUpstreamOfC = isNodeUpstream('node-b', 'node-c', graph);
      expect(bIsUpstreamOfC).toBe(true);
    });

    it('should correctly identify node as BETWEEN in linear graph', () => {
      const graph = createLinearGraph();
      
      // Query: from(A).to(D).excludes(B)
      // B is NOT upstream of A (it's downstream)
      // When compiled to minus(B), the visited(B) should be "between"
      
      const bIsUpstreamOfA = isNodeUpstream('node-b', 'node-a', graph);
      expect(bIsUpstreamOfA).toBe(false);
      
      // C is also not upstream of A
      const cIsUpstreamOfA = isNodeUpstream('node-c', 'node-a', graph);
      expect(cIsUpstreamOfA).toBe(false);
    });
  });

  describe('real-world scenario: sibling edges from common node', () => {
    
    // User's actual scenario:
    // viewed-dashboard has three outgoing edges to different recommendation types
    // gave-bds-in-onboarding is upstream of viewed-dashboard
    const createRealWorldGraph = () => ({
      nodes: [
        { id: 'gave-bds-in-onboarding', uuid: 'uuid-bds', label: 'Gave BDS', event_id: 'gave-bds' },
        { id: 'viewed-dashboard', uuid: 'uuid-dash', label: 'Viewed Dashboard', event_id: 'viewed-dashboard' },
        { id: 'rec-with-bdos', uuid: 'uuid-rec1', label: 'Rec with BDOs', event_id: 'recommendation-with-bdos' },
        { id: 'rec-calling-for-bds', uuid: 'uuid-rec2', label: 'Rec calling for BDs', event_id: 'recommendation-calling-for-bds' },
        { id: 'not-sent-rec', uuid: 'uuid-rec3', label: 'Not Sent Rec', event_id: 'not-sent-recommendation' },
      ],
      edges: [
        { id: 'bds-to-dash', uuid: 'edge-1', from: 'uuid-bds', to: 'uuid-dash' },
        { id: 'dash-to-rec1', uuid: 'edge-2', from: 'uuid-dash', to: 'uuid-rec1' },
        { id: 'dash-to-rec2', uuid: 'edge-3', from: 'uuid-dash', to: 'uuid-rec2' },
        { id: 'dash-to-rec3', uuid: 'edge-4', from: 'uuid-dash', to: 'uuid-rec3' },
      ]
    });

    it('should detect gave-bds as UPSTREAM of viewed-dashboard', () => {
      const graph = createRealWorldGraph();
      
      const bdsUpstreamOfDash = isNodeUpstream('gave-bds-in-onboarding', 'viewed-dashboard', graph);
      expect(bdsUpstreamOfDash).toBe(true);
    });

    it('should detect recommendation nodes as NOT upstream of viewed-dashboard', () => {
      const graph = createRealWorldGraph();
      
      // Recommendation nodes are downstream, not upstream
      const rec1UpstreamOfDash = isNodeUpstream('rec-with-bdos', 'viewed-dashboard', graph);
      expect(rec1UpstreamOfDash).toBe(false);
      
      const rec2UpstreamOfDash = isNodeUpstream('rec-calling-for-bds', 'viewed-dashboard', graph);
      expect(rec2UpstreamOfDash).toBe(false);
      
      const rec3UpstreamOfDash = isNodeUpstream('not-sent-rec', 'viewed-dashboard', graph);
      expect(rec3UpstreamOfDash).toBe(false);
    });

    it('should correctly categorize for query: excludes(gave-bds).visited(rec1)', () => {
      const graph = createRealWorldGraph();
      
      // Query: from(viewed-dashboard).to(rec2).excludes(gave-bds).visited(rec1)
      // gave-bds is UPSTREAM of viewed-dashboard → visited_upstream
      // rec1 is NOT upstream of viewed-dashboard → visited (between)
      
      const bdsUpstreamOfDash = isNodeUpstream('gave-bds-in-onboarding', 'viewed-dashboard', graph);
      expect(bdsUpstreamOfDash).toBe(true);
      
      const rec1UpstreamOfDash = isNodeUpstream('rec-with-bdos', 'viewed-dashboard', graph);
      expect(rec1UpstreamOfDash).toBe(false);
    });
  });

  describe('exclude compilation: minus/plus term structure', () => {
    
    it('should produce correct minus term for single exclude (between)', () => {
      const graph = createDiamondGraph();
      
      // Query: from(A).to(D).excludes(C)
      // Expected compilation: from(A).to(D).minus(C)
      // In minus term, visited(C) should be categorized as "between" since C is not upstream of A
      
      // The minus sub-query will have visited=[C]
      // isNodeUpstream(C, A) should be false
      const cIsUpstreamOfA = isNodeUpstream('node-c', 'node-a', graph);
      expect(cIsUpstreamOfA).toBe(false);
      
      // So in the minus sub-query: visited=[event_c], visited_upstream=[]
    });

    it('should produce correct minus term for single exclude (upstream)', () => {
      const graph = createLinearGraph();
      
      // Query: from(C).to(D).excludes(A)
      // Expected compilation: from(C).to(D).minus(A)
      // In minus term, visited(A) should be categorized as "upstream" since A is upstream of C
      
      const aIsUpstreamOfC = isNodeUpstream('node-a', 'node-c', graph);
      expect(aIsUpstreamOfC).toBe(true);
      
      // So in the minus sub-query: visited=[], visited_upstream=[event_a]
    });

    it('should produce correct plus term for multiple excludes (inclusion-exclusion)', () => {
      const graph = createDiamondGraph();
      
      // Query: from(A).to(D).excludes(B,C)
      // Expected compilation: from(A).to(D).minus(B).minus(C).plus(B,C)
      // 
      // Base term: no visited
      // Minus(B): visited=[B], not upstream
      // Minus(C): visited=[C], not upstream
      // Plus(B,C): visited=[B,C], neither is upstream
      
      const bIsUpstreamOfA = isNodeUpstream('node-b', 'node-a', graph);
      const cIsUpstreamOfA = isNodeUpstream('node-c', 'node-a', graph);
      
      expect(bIsUpstreamOfA).toBe(false);
      expect(cIsUpstreamOfA).toBe(false);
      
      // All minus/plus sub-queries should have visited_upstream=[]
    });
  });
});

describe('Exclude Compilation - Integration with compositeQueryParser', () => {
  
  // These tests verify that the composite query parser correctly parses
  // compiled exclude queries into the right structure for execution
  
  it('should parse minus term with single exclude', async () => {
    const { parseCompositeQuery, getExecutionTerms } = await import('../compositeQueryParser');
    
    // Compiled query from: from(A).to(D).excludes(C)
    const queryString = 'from(node-a).to(node-d).minus(node-c)';
    
    const parsed = parseCompositeQuery(queryString);
    
    expect(parsed.base.from).toBe('node-a');
    expect(parsed.base.to).toBe('node-d');
    expect(parsed.minusTerms).toHaveLength(1);
    expect(parsed.minusTerms[0]).toEqual(['node-c']);
    expect(parsed.plusTerms).toHaveLength(0);
  });

  it('should parse multiple minus terms', async () => {
    const { parseCompositeQuery, getExecutionTerms } = await import('../compositeQueryParser');
    
    // Compiled query from: from(A).to(D).excludes(B,C)
    const queryString = 'from(node-a).to(node-d).minus(node-b).minus(node-c).plus(node-b,node-c)';
    
    const parsed = parseCompositeQuery(queryString);
    
    expect(parsed.base.from).toBe('node-a');
    expect(parsed.base.to).toBe('node-d');
    expect(parsed.minusTerms).toHaveLength(2);
    expect(parsed.plusTerms).toHaveLength(1);
    expect(parsed.plusTerms[0]).toEqual(['node-b', 'node-c']);
  });

  it('should generate correct execution terms with coefficients', async () => {
    const { parseCompositeQuery, getExecutionTerms } = await import('../compositeQueryParser');
    
    const queryString = 'from(node-a).to(node-d).minus(node-c)';
    const parsed = parseCompositeQuery(queryString);
    const terms = getExecutionTerms(parsed);
    
    expect(terms).toHaveLength(2);
    
    // Base term: coefficient +1
    expect(terms[0].coefficient).toBe(1);
    expect(terms[0].funnel.from).toBe('node-a');
    expect(terms[0].funnel.to).toBe('node-d');
    expect(terms[0].funnel.visited).toBeUndefined();
    
    // Minus term: coefficient -1, visited includes the excluded node
    expect(terms[1].coefficient).toBe(-1);
    expect(terms[1].funnel.visited).toContain('node-c');
  });
});

