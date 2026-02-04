/**
 * Signature Matching E2E Tests
 * 
 * REAL PRODUCTION CODE TEST - Only mocks:
 * 1. BrowserHttpExecutor (Amplitude API HTTP calls)
 * 2. react-hot-toast (UI notifications)
 * 3. sessionLogService (logging)
 * 4. contextRegistry (context file reads)
 * 
 * Uses REAL:
 * - computeQuerySignature (generates structured signatures)
 * - calculateIncrementalFetch (determines needsFetch)
 * - signatureMatchingService (canCacheSatisfyQuery, parseSignature)
 * - dimensionalReductionService (aggregation)
 * 
 * Tests the core bug: uncontexted query should reuse contexted MECE cache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock HTTP executor before imports
vi.mock('../../lib/das/BrowserHttpExecutor', () => ({
  BrowserHttpExecutor: class {
    async execute() {
      return {
        status: 200,
        data: {
          data: [{
            formattedXValues: ['2025-10-01', '2025-10-02', '2025-10-03'],
            stepByStepSeries: [[300], [150]],
            series: [[300], [150]],
            dayByDaySeries: [{
              formattedXValues: ['2025-10-01', '2025-10-02', '2025-10-03'],
              series: [[100, 50], [100, 50], [100, 50]]
            }]
          }]
        },
        headers: {}
      };
    }
  }
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn()
  }
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op-id'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    getOperationLog: vi.fn(() => []),
    getDiagnosticLoggingEnabled: vi.fn(() => false),
  }
}));

// Mock contextRegistry to provide predictable context definitions
vi.mock('../contextRegistry', () => {
  const mockContextDefs: Record<string, any> = {
    channel: {
      id: 'channel',
      name: 'Marketing Channel',
      type: 'enum',
      otherPolicy: 'undefined',
      values: [
        { id: 'google', label: 'Google' },
        { id: 'facebook', label: 'Facebook' },
        { id: 'direct', label: 'Direct' },
      ],
    },
    device: {
      id: 'device',
      name: 'Device Type',
      type: 'enum',
      otherPolicy: 'undefined',
      values: [
        { id: 'mobile', label: 'Mobile' },
        { id: 'desktop', label: 'Desktop' },
      ],
    },
  };

  return {
    contextRegistry: {
      getContext: vi.fn(async (id: string) => mockContextDefs[id]),
      getValuesForContext: vi.fn(async (id: string) => mockContextDefs[id]?.values || []),
      detectMECEPartitionSync: vi.fn(() => ({
        isMECE: true,
        isComplete: true,
        canAggregate: true,
        missingValues: [],
        otherPolicy: 'undefined',
      })),
    },
  };
});

// Import AFTER mocks
import { computeQuerySignature } from '../dataOperationsService';
import { calculateIncrementalFetch } from '../windowAggregationService';
import { canCacheSatisfyQuery, parseSignature, serialiseSignature } from '../signatureMatchingService';
import { tryDimensionalReduction } from '../dimensionalReductionService';
import { isSignatureCheckingEnabled } from '../signaturePolicyService';
import { contextRegistry } from '../contextRegistry';
import type { ParameterValue } from '../../types/parameterData';
import type { Graph, NodeData, EdgeData } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// TEST FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a realistic test graph with nodes and edges
 */
function createTestGraph(): Graph {
  const nodes: NodeData[] = [
    {
      uuid: 'node-1',
      id: 'test-start',
      label: 'Test Start Event',
      event_id: 'evt-start',
      data: {
        provider_event_names: { amplitude: 'Start Event' },
      }
    } as unknown as NodeData,
    {
      uuid: 'node-2',
      id: 'test-end',
      label: 'Test End Event',
      event_id: 'evt-end',
      data: {
        provider_event_names: { amplitude: 'End Event' },
      }
    } as unknown as NodeData,
  ];

  const edges: EdgeData[] = [
    {
      uuid: 'edge-1',
      id: 'test-edge',
      from: 'node-1',
      to: 'node-2',
      source: 'node-1',
      target: 'node-2',
      query: 'from(test-start).to(test-end)',
      p: {
        id: 'test-param',
        connection: 'amplitude-test',
        mean: 0.5
      }
    } as EdgeData,
  ];

  return {
    nodes,
    edges,
    currentQueryDSL: 'window(1-Oct-25:3-Oct-25)',
    metadata: { name: 'test-graph' }
  } as Graph;
}

/**
 * Mock query payload for signature computation
 */
function createQueryPayload(contextKeys: string[] = []) {
  return {
    e: { e: 'Start Event', e2: 'End Event' },
    s: { start: '20251001', end: '20251003' },
    original_query: 'from(evt-start).to(evt-end)',
    context_keys: contextKeys,
  };
}

/**
 * Create cached parameter values with signature
 */
function createCachedValues(
  sliceDSL: string,
  signature: string,
  dates: string[] = ['1-Oct-25', '2-Oct-25', '3-Oct-25']
): ParameterValue[] {
  return [{
    sliceDSL,
    query_signature: signature,
    dates,
    n_daily: [100, 100, 100],
    k_daily: [50, 50, 50],
    n: 300,
    k: 150,
    mean: 0.5,
    window_from: '2025-10-01T00:00:00.000Z',
    window_to: '2025-10-03T23:59:59.999Z',
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Signature Matching E2E (Real Production Code)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SIGNATURE GENERATION
  // ─────────────────────────────────────────────────────────────────────────────

  describe('computeQuerySignature (REAL function)', () => {
    it('produces structured signature with coreHash and contextDefHashes', async () => {
      const graph = createTestGraph();
      const payload = createQueryPayload(['channel']);
      
      const sigStr = await computeQuerySignature(
        payload,
        'amplitude-test',
        graph,
        graph.edges[0],
        ['channel']
      );
      
      // Should be a serialised JSON string
      expect(sigStr).toMatch(/^\{.*\}$/);
      
      // Parse it back
      const sig = parseSignature(sigStr);
      
      // Should have a coreHash
      expect(sig.coreHash).toBeTruthy();
      expect(sig.coreHash.length).toBeGreaterThan(0);
      
      // Should have contextDefHashes for channel
      expect(sig.contextDefHashes).toBeDefined();
      expect(sig.contextDefHashes.channel).toBeTruthy();
      // The hash is computed from the mock context definition
      expect(sig.contextDefHashes.channel.length).toBeGreaterThan(10);
    });

    it('generates different coreHash for different connections', async () => {
      const graph = createTestGraph();
      const payload = createQueryPayload();
      
      const sig1Str = await computeQuerySignature(payload, 'connection-a', graph, graph.edges[0], []);
      const sig2Str = await computeQuerySignature(payload, 'connection-b', graph, graph.edges[0], []);
      
      const sig1 = parseSignature(sig1Str);
      const sig2 = parseSignature(sig2Str);
      
      expect(sig1.coreHash).not.toBe(sig2.coreHash);
    });

    it('generates empty contextDefHashes for uncontexted query', async () => {
      const graph = createTestGraph();
      const payload = createQueryPayload(); // No context
      
      const sigStr = await computeQuerySignature(payload, 'amplitude-test', graph, graph.edges[0], []);
      const sig = parseSignature(sigStr);
      
      expect(sig.contextDefHashes).toEqual({});
    });

    it('generates same coreHash for same semantics with different context keys', async () => {
      const graph = createTestGraph();
      const payload1 = createQueryPayload(['channel']);
      const payload2 = createQueryPayload([]);
      
      const sig1Str = await computeQuerySignature(payload1, 'amplitude-test', graph, graph.edges[0], ['channel']);
      const sig2Str = await computeQuerySignature(payload2, 'amplitude-test', graph, graph.edges[0], []);
      
      const sig1 = parseSignature(sig1Str);
      const sig2 = parseSignature(sig2Str);
      
      // Core semantics are the same (connection, events, window)
      expect(sig1.coreHash).toBe(sig2.coreHash);
      // But contextDefHashes differ
      expect(sig1.contextDefHashes.channel).toBeDefined();
      expect(sig2.contextDefHashes.channel).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SIGNATURE MATCHING
  // ─────────────────────────────────────────────────────────────────────────────

  describe('canCacheSatisfyQuery with REAL signatures', () => {
    it('CRITICAL: uncontexted query matches contexted cache (same core)', async () => {
      const graph = createTestGraph();
      
      // Simulate: Retrieve All writes contexted data
      const cacheStr = await computeQuerySignature(
        createQueryPayload(['channel']),
        'amplitude-test',
        graph,
        graph.edges[0],
        ['channel']
      );
      
      // Later: User queries uncontexted
      const queryStr = await computeQuerySignature(
        createQueryPayload([]),
        'amplitude-test',
        graph,
        graph.edges[0],
        []
      );
      
      // THE BUG FIX: Uncontexted query SHOULD use contexted cache
      expect(canCacheSatisfyQuery(cacheStr, queryStr)).toBe(true);
    });

    it('CRITICAL: different connections do NOT match', async () => {
      const graph = createTestGraph();
      
      const cacheStr = await computeQuerySignature(
        createQueryPayload(),
        'connection-prod',
        graph,
        graph.edges[0],
        []
      );
      
      const queryStr = await computeQuerySignature(
        createQueryPayload(),
        'connection-staging',
        graph,
        graph.edges[0],
        []
      );
      
      expect(canCacheSatisfyQuery(cacheStr, queryStr)).toBe(false);
    });

    it('single-dimension query matches multi-dimensional cache', async () => {
      const graph = createTestGraph();
      
      const cacheStr = await computeQuerySignature(
        createQueryPayload(['channel', 'device']),
        'amplitude-test',
        graph,
        graph.edges[0],
        ['channel', 'device']
      );
      
      const queryStr = await computeQuerySignature(
        createQueryPayload(['channel']),
        'amplitude-test',
        graph,
        graph.edges[0],
        ['channel']
      );
      
      // Cache has superset of context keys - should match
      expect(canCacheSatisfyQuery(cacheStr, queryStr)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // FETCH PLANNING (calculateIncrementalFetch)
  // ─────────────────────────────────────────────────────────────────────────────

  (isSignatureCheckingEnabled() ? describe : describe.skip)(
    'calculateIncrementalFetch with REAL signatures',
    () => {
      it('CRITICAL: needsFetch=false when signature matches (exact slice)', async () => {
        const graph = createTestGraph();
        
        // Generate a signature
        const sigStr = await computeQuerySignature(
          createQueryPayload(['channel']),
          'amplitude-test',
          graph,
          graph.edges[0],
          ['channel']
        );
        
        // Create cached values with that signature
        const values = createCachedValues('context(channel:google)', sigStr);
        
        // Query the same slice with same signature (pass string, not object)
        const result = calculateIncrementalFetch(
          { values },
          { start: '1-Oct-25', end: '3-Oct-25' },
          sigStr,  // Same signature as a STRING
          false,
          'context(channel:google).window(1-Oct-25:3-Oct-25)'
        );
        
        expect(result.needsFetch).toBe(false);
        expect(result.daysAvailable).toBe(3);
        expect(result.daysToFetch).toBe(0);
      });

      it('CRITICAL: needsFetch=true when coreHash differs', async () => {
        const graph = createTestGraph();
        
        // Cache with one connection
        const cacheStr = await computeQuerySignature(
          createQueryPayload(),
          'connection-old',
          graph,
          graph.edges[0],
          []
        );
        
        // Query with different connection
        const queryStr = await computeQuerySignature(
          createQueryPayload(),
          'connection-new',
          graph,
          graph.edges[0],
          []
        );
        
        const values = createCachedValues('', cacheStr);
        
        const result = calculateIncrementalFetch(
          { values },
          { start: '1-Oct-25', end: '3-Oct-25' },
          queryStr,  // Pass as STRING
          false,
          'window(1-Oct-25:3-Oct-25)'
        );
        
        // Different connection = different core = refetch
        expect(result.needsFetch).toBe(true);
        expect(result.daysAvailable).toBe(0);
      });

      it('CRITICAL: needsFetch=false when superset signature matches via dimensional reduction', async () => {
        const graph = createTestGraph();
        
        // Cache has channel+device
        const cacheStr = await computeQuerySignature(
          createQueryPayload(['channel', 'device']),
          'amplitude-test',
          graph,
          graph.edges[0],
          ['channel', 'device']
        );
        
        // Query only needs channel
        const queryStr = await computeQuerySignature(
          createQueryPayload(['channel']),
          'amplitude-test',
          graph,
          graph.edges[0],
          ['channel']
        );
        
        // Create cache with multi-dimensional signature, same sliceDSL
        const values = createCachedValues(
          'context(channel:google)',
          cacheStr
        );
        
        // Query with single-dimension signature (pass as STRING)
        const result = calculateIncrementalFetch(
          { values },
          { start: '1-Oct-25', end: '3-Oct-25' },
          queryStr,  // Has only channel - pass as STRING
          false,
          'context(channel:google).window(1-Oct-25:3-Oct-25)'
        );
        
        // Superset matching should work
        expect(result.needsFetch).toBe(false);
      });
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // DIMENSIONAL REDUCTION (uncontexted over contexted MECE)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('tryDimensionalReduction with REAL signatures', () => {
    it('CRITICAL: aggregates contexted MECE for uncontexted query', async () => {
      const graph = createTestGraph();
      
      // Generate signature for contexted data
      const sigStr = await computeQuerySignature(
        createQueryPayload(['channel']),
        'amplitude-test',
        graph,
        graph.edges[0],
        ['channel']
      );
      
      // Create MECE cached slices (google, facebook, direct)
      const values: ParameterValue[] = [
        {
          sliceDSL: 'context(channel:google)',
          query_signature: sigStr,
          dates: ['1-Oct-25', '2-Oct-25', '3-Oct-25'],
          n_daily: [100, 100, 100],
          k_daily: [50, 50, 50],
          n: 300, k: 150, mean: 0.5,
        },
        {
          sliceDSL: 'context(channel:facebook)',
          query_signature: sigStr,
          dates: ['1-Oct-25', '2-Oct-25', '3-Oct-25'],
          n_daily: [200, 200, 200],
          k_daily: [100, 100, 100],
          n: 600, k: 300, mean: 0.5,
        },
        {
          sliceDSL: 'context(channel:direct)',
          query_signature: sigStr,
          dates: ['1-Oct-25', '2-Oct-25', '3-Oct-25'],
          n_daily: [50, 50, 50],
          k_daily: [25, 25, 25],
          n: 150, k: 75, mean: 0.5,
        },
      ];
      
      // Uncontexted query DSL
      const result = tryDimensionalReduction(values, 'window(1-Oct-25:3-Oct-25)');
      
      expect(result.kind).toBe('reduced');
      expect(result.aggregatedValues).toHaveLength(1);
      
      // Should sum all 3 slices
      // n_daily: 100+200+50 = 350 per day
      expect(result.aggregatedValues![0].n_daily).toEqual([350, 350, 350]);
      // k_daily: 50+100+25 = 175 per day
      expect(result.aggregatedValues![0].k_daily).toEqual([175, 175, 175]);
      expect(result.aggregatedValues![0].n).toBe(1050);
      expect(result.aggregatedValues![0].k).toBe(525);
    });

    it('rejects aggregation when not MECE', async () => {
      vi.mocked(contextRegistry.detectMECEPartitionSync).mockReturnValue({
        isMECE: false,
        isComplete: false,
        canAggregate: false,
        missingValues: ['organic'],
        otherPolicy: 'undefined',
      });
      
      const values: ParameterValue[] = [
        {
          sliceDSL: 'context(channel:google)',
          dates: ['1-Oct-25'],
          n_daily: [100],
          k_daily: [50],
          n: 100, k: 50, mean: 0.5,
        },
      ];
      
      const result = tryDimensionalReduction(values, 'window(1-Oct-25:1-Oct-25)');
      
      expect(result.kind).toBe('not_reducible');
      expect(result.reason).toContain('dimension_not_mece');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEGACY SIGNATURE HANDLING
  // ─────────────────────────────────────────────────────────────────────────────

  describe('legacy signature compatibility', () => {
    it('legacy hex signatures parse to empty structure', () => {
      const legacyHex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const parsed = parseSignature(legacyHex);
      
      expect(parsed.coreHash).toBe('');
      expect(parsed.contextDefHashes).toEqual({});
    });

    it('legacy cache does NOT match new structured query', async () => {
      const graph = createTestGraph();
      
      const queryStr = await computeQuerySignature(
        createQueryPayload(),
        'amplitude-test',
        graph,
        graph.edges[0],
        []
      );
      
      // Legacy hex signature in cache
      const legacyHex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      
      expect(canCacheSatisfyQuery(legacyHex, queryStr)).toBe(false);
    });

    it('cache with no query_signature is accepted (backward compat)', () => {
      const values: ParameterValue[] = [
        {
          sliceDSL: '',
          // No query_signature field at all
          dates: ['1-Oct-25', '2-Oct-25', '3-Oct-25'],
          n_daily: [100, 100, 100],
          k_daily: [50, 50, 50],
          n: 300, k: 150, mean: 0.5,
        } as any,
      ];
      
      // Should not crash, should accept the data
      const result = calculateIncrementalFetch(
        { values },
        { start: '1-Oct-25', end: '3-Oct-25' },
        { coreHash: 'new-hash', contextDefHashes: {} },
        false,
        'window(1-Oct-25:3-Oct-25)'
      );
      
      // Legacy values without signature are accepted
      expect(result.needsFetch).toBe(false);
    });
  });
});
