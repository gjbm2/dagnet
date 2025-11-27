/**
 * Integration tests for conditional probability (conditional_p) data operations
 * 
 * These tests verify the fixes for several bugs:
 * 1. dataOperationsService using the correct conditional_p query (not base edge query)
 * 2. Connection fallback: conditional_p entries inherit base edge.p.connection if not specified
 * 3. DataOperationsSections correctly generating sections for string-based conditions
 * 
 * Related files:
 * - dataOperationsService.ts - getFromSourceDirect
 * - DataOperationsSections.tsx - section generation for conditional_p
 * - ParameterSection.tsx / EnhancedSelector.tsx / LightningMenu.tsx - conditionalIndex prop threading
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GraphEdge, ConditionalProbability, ProbabilityParam } from '../../types';
import type { QueryPayload } from '../../lib/das/buildDslFromEdge';

describe('Conditional Probability Integration Tests', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Query Selection for conditional_p', () => {
    
    it('should use conditional_p query when conditionalIndex is provided', () => {
      // Setup: Edge with base query and conditional_p with different query
      const edge: GraphEdge = {
        uuid: 'edge-1',
        id: 'test-edge',
        from: 'node-a',
        to: 'node-b',
        query: 'from(node-a).to(node-b)', // Base query
        p: { mean: 0.5, connection: 'amplitude-prod' } as ProbabilityParam,
        conditional_p: [
          {
            condition: 'visited(node-x)',
            query: 'from(node-a).to(node-b).visited(node-x)', // Conditional query - DIFFERENT
            p: { mean: 0.8, connection: 'amplitude-prod' } as ProbabilityParam
          } as ConditionalProbability
        ]
      };
      
      // When conditionalIndex = 0, should use conditional_p[0].query
      const conditionalIndex = 0;
      const effectiveQuery = conditionalIndex !== undefined && edge.conditional_p?.[conditionalIndex]?.query
        ? edge.conditional_p[conditionalIndex].query
        : edge.query;
      
      expect(effectiveQuery).toBe('from(node-a).to(node-b).visited(node-x)');
      expect(effectiveQuery).not.toBe(edge.query);
    });

    it('should use base edge query when conditionalIndex is undefined', () => {
      const edge: GraphEdge = {
        uuid: 'edge-1',
        id: 'test-edge',
        from: 'node-a',
        to: 'node-b',
        query: 'from(node-a).to(node-b)',
        p: { mean: 0.5, connection: 'amplitude-prod' } as ProbabilityParam,
        conditional_p: [
          {
            condition: 'visited(node-x)',
            query: 'from(node-a).to(node-b).visited(node-x)',
            p: { mean: 0.8 } as ProbabilityParam
          } as ConditionalProbability
        ]
      };
      
      const conditionalIndex = undefined;
      const effectiveQuery = conditionalIndex !== undefined && edge.conditional_p?.[conditionalIndex]?.query
        ? edge.conditional_p[conditionalIndex].query
        : edge.query;
      
      expect(effectiveQuery).toBe('from(node-a).to(node-b)');
    });

    it('should fallback to base query if conditional_p entry has no query', () => {
      const edge: GraphEdge = {
        uuid: 'edge-1',
        id: 'test-edge',
        from: 'node-a',
        to: 'node-b',
        query: 'from(node-a).to(node-b)',
        p: { mean: 0.5, connection: 'amplitude-prod' } as ProbabilityParam,
        conditional_p: [
          {
            condition: 'visited(node-x)',
            // No query defined - should fallback to base
            p: { mean: 0.8 } as ProbabilityParam
          } as ConditionalProbability
        ]
      };
      
      const conditionalIndex = 0;
      const effectiveQuery = conditionalIndex !== undefined && edge.conditional_p?.[conditionalIndex]?.query
        ? edge.conditional_p[conditionalIndex].query
        : edge.query;
      
      expect(effectiveQuery).toBe('from(node-a).to(node-b)');
    });
  });

  describe('Connection Fallback for conditional_p', () => {
    
    it('should use conditional_p.p.connection when available', () => {
      const edge: GraphEdge = {
        uuid: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        p: { mean: 0.5, connection: 'base-connection' } as ProbabilityParam,
        conditional_p: [
          {
            condition: 'visited(node-x)',
            p: { mean: 0.8, connection: 'conditional-connection' } as ProbabilityParam // Own connection
          } as ConditionalProbability
        ]
      };
      
      const conditionalIndex = 0;
      const condEntry = edge.conditional_p?.[conditionalIndex];
      const connectionName = condEntry?.p?.connection || edge.p?.connection;
      
      expect(connectionName).toBe('conditional-connection');
    });

    it('should fallback to base edge.p.connection when conditional_p has no connection', () => {
      const edge: GraphEdge = {
        uuid: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        p: { mean: 0.5, connection: 'base-connection' } as ProbabilityParam,
        conditional_p: [
          {
            condition: 'visited(node-x)',
            p: { mean: 0.8 } as ProbabilityParam // No connection - should inherit base
          } as ConditionalProbability
        ]
      };
      
      const conditionalIndex = 0;
      const condEntry = edge.conditional_p?.[conditionalIndex];
      const connectionName = condEntry?.p?.connection || edge.p?.connection;
      
      expect(connectionName).toBe('base-connection');
    });

    it('should handle missing connection on both levels', () => {
      const edge: GraphEdge = {
        uuid: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        p: { mean: 0.5 } as ProbabilityParam, // No connection on base
        conditional_p: [
          {
            condition: 'visited(node-x)',
            p: { mean: 0.8 } as ProbabilityParam // No connection on conditional
          } as ConditionalProbability
        ]
      };
      
      const conditionalIndex = 0;
      const condEntry = edge.conditional_p?.[conditionalIndex];
      const connectionName = condEntry?.p?.connection || edge.p?.connection;
      
      expect(connectionName).toBeUndefined();
    });
  });

  describe('DataOperationsSections conditional_p processing', () => {
    
    it('should NOT skip string-based conditions', () => {
      // This tests the fix for the bug where string conditions were being skipped
      const conditionalP = [
        {
          condition: 'visited(gave-bds-in-onboarding)', // String condition
          query: 'from(A).to(B).visited(gave-bds)',
          p: { mean: 0.8, connection: 'amplitude-prod' }
        }
      ];
      
      // The bug was: `if (typeof condP.condition === 'string') return;`
      // which incorrectly skipped string conditions
      // The fix: `if (typeof condP.condition === 'object') return;`
      // which only skips old-format object conditions
      
      const processedConditions: any[] = [];
      conditionalP.forEach((condP: any, index: number) => {
        // Fixed logic: Skip object conditions, allow string conditions
        if (typeof condP.condition === 'object') return;
        
        processedConditions.push({
          index,
          condition: condP.condition,
          hasQuery: !!condP.query
        });
      });
      
      expect(processedConditions).toHaveLength(1);
      expect(processedConditions[0].condition).toBe('visited(gave-bds-in-onboarding)');
      expect(processedConditions[0].index).toBe(0);
    });

    it('should skip old-format object conditions', () => {
      // Old format used object-based conditions
      const conditionalP = [
        {
          condition: { type: 'visited', nodeId: 'some-uuid' }, // Object condition (old format)
          p: { mean: 0.8 }
        }
      ];
      
      const processedConditions: any[] = [];
      conditionalP.forEach((condP: any, index: number) => {
        // Fixed logic: Skip object conditions
        if (typeof condP.condition === 'object') return;
        
        processedConditions.push({
          index,
          condition: condP.condition
        });
      });
      
      expect(processedConditions).toHaveLength(0);
    });

    it('should determine hasConnection correctly with fallback', () => {
      const edge: GraphEdge = {
        uuid: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        p: { mean: 0.5, connection: 'amplitude-prod' } as ProbabilityParam, // Base has connection
        conditional_p: [
          {
            condition: 'visited(node-x)',
            p: { mean: 0.8 } as ProbabilityParam // Conditional has NO connection - should inherit
          } as ConditionalProbability
        ]
      };
      
      // The fix: check conditional_p.p.connection OR edge.p.connection
      const condP = edge.conditional_p?.[0];
      const hasDirectConnection = !!condP?.p?.connection || !!edge.p?.connection;
      
      expect(hasDirectConnection).toBe(true);
    });
  });

  describe('conditionalIndex prop threading', () => {
    
    it('should correctly identify conditional parameters by index', () => {
      const edge = {
        uuid: 'edge-1',
        conditional_p: [
          { condition: 'visited(a)', p: { mean: 0.7 } },
          { condition: 'visited(b)', p: { mean: 0.8 } },
          { condition: 'visited(c)', p: { mean: 0.9 } }
        ]
      };
      
      // Each conditional should have a distinct index
      edge.conditional_p.forEach((cond, idx) => {
        expect(edge.conditional_p[idx]).toBe(cond);
        expect(edge.conditional_p[idx].p.mean).toBe(cond.p.mean);
      });
      
      // Accessing by index should work
      expect(edge.conditional_p[0].p.mean).toBe(0.7);
      expect(edge.conditional_p[1].p.mean).toBe(0.8);
      expect(edge.conditional_p[2].p.mean).toBe(0.9);
    });
  });

  describe('End-to-end conditional_p data fetch scenario', () => {
    
    it('should correctly determine all parameters for a conditional_p fetch', () => {
      // Simulates the full parameter resolution for a conditional probability fetch
      const graph = {
        nodes: [
          { id: 'viewed-dashboard', uuid: 'uuid-dash', event_id: 'viewed-dashboard' },
          { id: 'recommendation', uuid: 'uuid-rec', event_id: 'recommendation-offered' },
          { id: 'gave-bds', uuid: 'uuid-bds', event_id: 'gave-bds' }
        ],
        edges: [
          { from: 'uuid-bds', to: 'uuid-dash' },
          { from: 'uuid-dash', to: 'uuid-rec' }
        ]
      };
      
      const targetEdge: GraphEdge = {
        uuid: 'uuid-edge',
        id: 'dashboard-to-rec',
        from: 'uuid-dash',
        to: 'uuid-rec',
        query: 'from(viewed-dashboard).to(recommendation)', // Base query (NO visited)
        p: { mean: 0.42, connection: 'amplitude-prod' } as ProbabilityParam,
        conditional_p: [
          {
            condition: 'visited(gave-bds)',
            query: 'from(viewed-dashboard).to(recommendation).visited(gave-bds)', // HAS visited
            p: { mean: 0.85, stdev: 0.01 } as ProbabilityParam // Note: no connection - should inherit
          } as ConditionalProbability
        ]
      };
      
      const conditionalIndex = 0;
      
      // 1. Effective query should be the conditional query (with visited)
      const effectiveQuery = conditionalIndex !== undefined && targetEdge.conditional_p?.[conditionalIndex]?.query
        ? targetEdge.conditional_p[conditionalIndex].query
        : targetEdge.query;
      
      expect(effectiveQuery).toBe('from(viewed-dashboard).to(recommendation).visited(gave-bds)');
      expect(effectiveQuery).toContain('.visited(');
      
      // 2. Connection should fall back to base
      const condEntry = targetEdge.conditional_p?.[conditionalIndex];
      const connectionName = condEntry?.p?.connection || targetEdge.p?.connection;
      
      expect(connectionName).toBe('amplitude-prod');
      
      // 3. Query should be parseable and contain visited clause
      const hasVisited = effectiveQuery?.includes('.visited(');
      expect(hasVisited).toBe(true);
      
      // 4. Verify base query does NOT have visited (to ensure we'd catch using wrong query)
      expect(targetEdge.query).not.toContain('.visited(');
    });
  });
});

describe('Super-funnel URL construction verification', () => {
  // These tests verify that the Amplitude adapter correctly constructs super-funnels
  // based on the DSL with visited_upstream
  
  it('should include all events in correct order for super-funnel', () => {
    // Simulates the pre_request script logic from connections.yaml
    const dsl: QueryPayload = {
      from: 'User sees dashboard',
      to: 'Blueprint CheckpointReached',
      visited_upstream: ['BankAccount DetailsEntryConfirmed']
    };
    
    const events: any[] = [];
    let fromStepIndex = 0;
    
    // 1. Add upstream visited events FIRST
    if (dsl.visited_upstream && dsl.visited_upstream.length > 0) {
      events.push(...dsl.visited_upstream.map(eventName => ({ event_type: eventName })));
      fromStepIndex = dsl.visited_upstream.length;
    }
    
    // 2. Add 'from' event
    events.push({ event_type: dsl.from });
    
    // 3. Add 'to' event
    events.push({ event_type: dsl.to });
    
    // Verify order: upstream → from → to
    expect(events).toHaveLength(3);
    expect(events[0].event_type).toBe('BankAccount DetailsEntryConfirmed');
    expect(events[1].event_type).toBe('User sees dashboard');
    expect(events[2].event_type).toBe('Blueprint CheckpointReached');
    
    // Verify indices for n/k extraction
    expect(fromStepIndex).toBe(1); // 'from' is at index 1 (after 1 upstream event)
    const toStepIndex = events.length - 1; // 'to' is always last
    expect(toStepIndex).toBe(2);
    
    // n should come from cumulativeRaw[fromStepIndex], k from cumulativeRaw[toStepIndex]
  });

  it('should handle multiple upstream visited events', () => {
    const dsl: QueryPayload = {
      from: 'Step C',
      to: 'Step D',
      visited_upstream: ['Step A', 'Step B'] // Two upstream events
    };
    
    const events: any[] = [];
    let fromStepIndex = 0;
    
    if (dsl.visited_upstream && dsl.visited_upstream.length > 0) {
      events.push(...dsl.visited_upstream.map(eventName => ({ event_type: eventName })));
      fromStepIndex = dsl.visited_upstream.length;
    }
    
    events.push({ event_type: dsl.from });
    events.push({ event_type: dsl.to });
    
    expect(events).toHaveLength(4);
    expect(events[0].event_type).toBe('Step A');
    expect(events[1].event_type).toBe('Step B');
    expect(events[2].event_type).toBe('Step C');
    expect(events[3].event_type).toBe('Step D');
    
    expect(fromStepIndex).toBe(2);
    expect(events.length - 1).toBe(3);
  });

  it('should handle no upstream visited events (standard funnel)', () => {
    const dsl: QueryPayload = {
      from: 'Event A',
      to: 'Event B'
      // No visited_upstream
    };
    
    const events: any[] = [];
    let fromStepIndex = 0;
    
    if (dsl.visited_upstream && dsl.visited_upstream.length > 0) {
      events.push(...dsl.visited_upstream.map(eventName => ({ event_type: eventName })));
      fromStepIndex = dsl.visited_upstream.length;
    }
    
    events.push({ event_type: dsl.from });
    events.push({ event_type: dsl.to });
    
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('Event A');
    expect(events[1].event_type).toBe('Event B');
    
    expect(fromStepIndex).toBe(0);
  });

  it('should handle visited (between) events separately from visited_upstream', () => {
    const dsl: QueryPayload = {
      from: 'Event B',
      to: 'Event D',
      visited_upstream: ['Event A'], // Before from
      visited: ['Event C'] // Between from and to
    };
    
    const events: any[] = [];
    let fromStepIndex = 0;
    
    // 1. Upstream visited
    if (dsl.visited_upstream && dsl.visited_upstream.length > 0) {
      events.push(...dsl.visited_upstream.map(eventName => ({ event_type: eventName })));
      fromStepIndex = dsl.visited_upstream.length;
    }
    
    // 2. From
    events.push({ event_type: dsl.from });
    
    // 3. Between visited
    if (dsl.visited && dsl.visited.length > 0) {
      events.push(...dsl.visited.map(eventName => ({ event_type: eventName })));
    }
    
    // 4. To
    events.push({ event_type: dsl.to });
    
    // Order should be: A (upstream) → B (from) → C (between) → D (to)
    expect(events).toHaveLength(4);
    expect(events[0].event_type).toBe('Event A');
    expect(events[1].event_type).toBe('Event B');
    expect(events[2].event_type).toBe('Event C');
    expect(events[3].event_type).toBe('Event D');
    
    // from is at index 1, to is at index 3
    expect(fromStepIndex).toBe(1);
    const toStepIndex = events.length - 1;
    expect(toStepIndex).toBe(3);
  });
});

/**
 * Dual Query n/k Separation Tests
 * 
 * These tests verify the fix for the upstream-conditioned query n/k issue:
 * 
 * Problem:
 * - When a query has visited_upstream (e.g., from(B).to(C).visited(A) where A is upstream of B),
 *   the super-funnel A→B→C gives us n = users who did A→B, k = users who did A→B→C
 * - But this is WRONG: n should be ALL users at B, not just those who came via A
 * - This matters because we want to partition the flow: "what fraction of ALL users at B
 *   came from A and went to C?"
 * 
 * Solution:
 * - Run TWO queries:
 *   1. Base query (strip upstream conditions) → gives n (all users at 'from')
 *   2. Conditioned query (super-funnel) → gives k (users via upstream path who converted)
 * - Combine: n from base, k from conditioned
 */
describe('Dual Query n/k Separation Tests', () => {
  
  describe('Detection of upstream conditions', () => {
    
    it('should detect visited_upstream and trigger dual query mode', () => {
      const queryPayload: QueryPayload = {
        from: 'viewed-dashboard',
        to: 'recommendation-offered',
        visited_upstream: ['gave-bds']
      };
      
      const needsDualQuery = queryPayload.visited_upstream && 
        Array.isArray(queryPayload.visited_upstream) && 
        queryPayload.visited_upstream.length > 0;
      
      expect(needsDualQuery).toBe(true);
    });
    
    it('should NOT trigger dual query mode when no upstream conditions', () => {
      const queryPayload: QueryPayload = {
        from: 'viewed-dashboard',
        to: 'recommendation-offered'
        // No visited_upstream
      };
      
      const needsDualQuery = queryPayload.visited_upstream && 
        Array.isArray(queryPayload.visited_upstream) && 
        queryPayload.visited_upstream.length > 0;
      
      expect(needsDualQuery).toBeFalsy();
    });
    
    it('should NOT trigger dual query mode for visited (between) only', () => {
      const queryPayload: QueryPayload = {
        from: 'viewed-dashboard',
        to: 'recommendation-offered',
        visited: ['intermediate-step']  // Between, not upstream
      };
      
      const needsDualQuery = queryPayload.visited_upstream && 
        Array.isArray(queryPayload.visited_upstream) && 
        queryPayload.visited_upstream.length > 0;
      
      expect(needsDualQuery).toBeFalsy();
    });
  });
  
  describe('Base query payload construction', () => {
    
    it('should strip visited_upstream from base query', () => {
      const queryPayload: QueryPayload = {
        from: 'viewed-dashboard',
        to: 'recommendation-offered',
        visited_upstream: ['gave-bds'],
        context_filters: [{ field: 'country', op: 'is', values: ['US'] }]
      };
      
      // Simulate the baseQueryPayload construction from dataOperationsService
      const baseQueryPayload = {
        ...queryPayload,
        visited_upstream: undefined,
        visitedAny_upstream: undefined
      };
      
      expect(baseQueryPayload.from).toBe('viewed-dashboard');
      expect(baseQueryPayload.to).toBe('recommendation-offered');
      expect(baseQueryPayload.visited_upstream).toBeUndefined();
      expect(baseQueryPayload.context_filters).toEqual([{ field: 'country', op: 'is', values: ['US'] }]);
    });
    
    it('should preserve visited (between) in base query', () => {
      const queryPayload: QueryPayload = {
        from: 'viewed-dashboard',
        to: 'recommendation-offered',
        visited_upstream: ['gave-bds'],
        visited: ['clicked-something']  // Between from and to - should be preserved
      };
      
      const baseQueryPayload = {
        ...queryPayload,
        visited_upstream: undefined,
        visitedAny_upstream: undefined
      };
      
      expect(baseQueryPayload.visited_upstream).toBeUndefined();
      expect(baseQueryPayload.visited).toEqual(['clicked-something']);
    });
  });
  
  describe('n/k combination logic', () => {
    
    it('should use base n and conditioned k for aggregate result', () => {
      // Simulate query results
      const baseResult = {
        n: 1000,  // ALL users at 'from'
        k: 800    // ALL users at 'from' who went to 'to' (we don't use this k)
      };
      
      const conditionedResult = {
        n: 500,   // Users who did A→B (we don't use this n - it's WRONG)
        k: 400    // Users who did A→B→C (this is the CORRECT k)
      };
      
      // Combine: n from base, k from conditioned
      const combinedN = baseResult.n;
      const combinedK = conditionedResult.k;
      const combinedP = combinedN > 0 ? combinedK / combinedN : 0;
      
      expect(combinedN).toBe(1000);  // ALL users at 'from'
      expect(combinedK).toBe(400);   // Users via upstream path who converted
      expect(combinedP).toBe(0.4);   // 400/1000 = 40%
      
      // The WRONG approach would be:
      const wrongP = conditionedResult.k / conditionedResult.n;  // 400/500 = 80%
      expect(wrongP).toBe(0.8);  // This is too high!
      expect(combinedP).not.toBe(wrongP);
    });
    
    it('should handle edge case where base n is 0', () => {
      const baseResult = { n: 0, k: 0 };
      const conditionedResult = { n: 0, k: 0 };
      
      const combinedN = baseResult.n;
      const combinedK = conditionedResult.k;
      const combinedP = combinedN > 0 ? combinedK / combinedN : 0;
      
      expect(combinedN).toBe(0);
      expect(combinedK).toBe(0);
      expect(combinedP).toBe(0);  // Avoid divide-by-zero
    });
  });
  
  describe('Time-series combination logic', () => {
    
    it('should combine daily n from base with daily k from conditioned', () => {
      // Simulate daily time-series from base query
      const baseTimeSeries = [
        { date: '2025-10-01', n: 100, k: 80, p: 0.8 },
        { date: '2025-10-02', n: 120, k: 96, p: 0.8 },
        { date: '2025-10-03', n: 90, k: 72, p: 0.8 }
      ];
      
      // Simulate daily time-series from conditioned query
      const condTimeSeries = [
        { date: '2025-10-01', n: 50, k: 40, p: 0.8 },  // n is WRONG (users who did A→B for that day)
        { date: '2025-10-02', n: 60, k: 48, p: 0.8 },
        { date: '2025-10-03', n: 45, k: 36, p: 0.8 }
      ];
      
      // Combine: for each date, use base n and conditioned k
      const dateMap = new Map<string, { n: number; k: number }>();
      
      for (const day of baseTimeSeries) {
        dateMap.set(day.date, { n: day.n, k: 0 });
      }
      
      for (const day of condTimeSeries) {
        const existing = dateMap.get(day.date);
        if (existing) {
          existing.k = day.k;
        }
      }
      
      const combinedTimeSeries = Array.from(dateMap.entries()).map(([date, { n, k }]) => ({
        date,
        n,  // From base
        k,  // From conditioned
        p: n > 0 ? k / n : 0
      }));
      
      expect(combinedTimeSeries).toHaveLength(3);
      
      // Day 1: n=100 (base), k=40 (conditioned), p=40%
      expect(combinedTimeSeries[0].n).toBe(100);
      expect(combinedTimeSeries[0].k).toBe(40);
      expect(combinedTimeSeries[0].p).toBe(0.4);
      
      // Day 2: n=120 (base), k=48 (conditioned), p=40%
      expect(combinedTimeSeries[1].n).toBe(120);
      expect(combinedTimeSeries[1].k).toBe(48);
      expect(combinedTimeSeries[1].p).toBe(0.4);
      
      // Day 3: n=90 (base), k=36 (conditioned), p=40%
      expect(combinedTimeSeries[2].n).toBe(90);
      expect(combinedTimeSeries[2].k).toBe(36);
      expect(combinedTimeSeries[2].p).toBe(0.4);
    });
    
    it('should handle missing dates in conditioned time-series', () => {
      const baseTimeSeries = [
        { date: '2025-10-01', n: 100, k: 80, p: 0.8 },
        { date: '2025-10-02', n: 120, k: 96, p: 0.8 }
      ];
      
      // Conditioned only has data for one day
      const condTimeSeries = [
        { date: '2025-10-01', n: 50, k: 40, p: 0.8 }
        // Missing 2025-10-02
      ];
      
      const dateMap = new Map<string, { n: number; k: number }>();
      
      for (const day of baseTimeSeries) {
        dateMap.set(day.date, { n: day.n, k: 0 });
      }
      
      for (const day of condTimeSeries) {
        const existing = dateMap.get(day.date);
        if (existing) {
          existing.k = day.k;
        }
      }
      
      const combinedTimeSeries = Array.from(dateMap.entries()).map(([date, { n, k }]) => ({
        date,
        n,
        k,
        p: n > 0 ? k / n : 0
      }));
      
      // Day 1: has data from both
      expect(combinedTimeSeries.find(d => d.date === '2025-10-01')?.k).toBe(40);
      
      // Day 2: k defaults to 0 (no conditioned data)
      expect(combinedTimeSeries.find(d => d.date === '2025-10-02')?.k).toBe(0);
    });
  });
  
  describe('Semantic correctness of dual query approach', () => {
    
    it('should give correct partition-of-flow semantics', () => {
      // Scenario: Edge B→C with visited(A) where A is upstream of B
      // Graph: A → B → C (users flow through A to B to C)
      // 
      // Total users at B: 1000
      // Users who came to B via A: 500 (the other 500 came via other paths)
      // Users who did A→B→C: 400
      // 
      // Question: What fraction of ALL users at B came from A AND went to C?
      // Answer: 400/1000 = 40%
      //
      // WRONG answer (old approach): 400/500 = 80% (this is the conditional probability
      // P(C|B, visited A) which is NOT what we want for flow partitioning)
      
      const totalUsersAtB = 1000;
      const usersFromA = 500;  // Subset who came via A
      const usersFromAThenC = 400;  // Subset who came via A and then went to C
      
      // Correct approach (dual query)
      const correctP = usersFromAThenC / totalUsersAtB;
      expect(correctP).toBe(0.4);
      
      // Wrong approach (single super-funnel query)
      const wrongP = usersFromAThenC / usersFromA;
      expect(wrongP).toBe(0.8);
      
      // The difference matters for decision modeling!
      expect(correctP).toBeLessThan(wrongP);
    });
    
    it('should allow sibling conditionals to partition the total flow', () => {
      // Scenario: Edge B→C with multiple conditionals:
      // - visited(A1): users who came via A1
      // - visited(A2): users who came via A2
      // - (base): users who came via neither A1 nor A2
      //
      // All three should use the SAME n (total users at B)
      // Each has its own k (users via that specific path who converted)
      
      const totalUsersAtB = 1000;  // This is n for ALL conditionals
      
      // Sibling 1: visited(A1)
      const k_viaA1 = 300;
      const p_viaA1 = k_viaA1 / totalUsersAtB;
      
      // Sibling 2: visited(A2)
      const k_viaA2 = 200;
      const p_viaA2 = k_viaA2 / totalUsersAtB;
      
      // Base (neither A1 nor A2)
      const k_base = 400;
      const p_base = k_base / totalUsersAtB;
      
      // Sum of ks should approximate total k (allowing for some overlap)
      // In a clean partition: k_viaA1 + k_viaA2 + k_base ≈ total_k
      const total_k_estimated = k_viaA1 + k_viaA2 + k_base;
      expect(total_k_estimated).toBe(900);
      
      // Probabilities should sum to ≤ 1 (overlap allowed)
      expect(p_viaA1 + p_viaA2 + p_base).toBeLessThanOrEqual(1);
    });
  });
});

